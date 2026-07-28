import type { Bindings } from '../env.js';
import { configuredSecrets } from '../security/runtime-secrets.js';
import { FeishuDeliveryCardReconciler } from '../reconciliation/feishu-delivery-card-reconciler.js';
import { FeishuDeliveryCardMessageReconciler } from '../reconciliation/feishu-delivery-card-message-reconciler.js';
import {
  FeishuDeliveryCardApiClient,
  FeishuDeliveryCardOutboxProcessor,
  memoryTokenCache,
} from './feishu-delivery-card.js';

// Watt's intended isolate-level cache lifetime; cold starts safely reacquire.
const tokenCache = memoryTokenCache();

/** Builds the D1-only projector even while Feishu network credentials are being repaired. */
export function feishuDeliveryCardReconcilerFromEnv(
  env: Bindings,
): FeishuDeliveryCardReconciler | null {
  const target = [env.FEISHU_DELIVERY_TENANT_KEY, env.FEISHU_DELIVERY_CHAT_ID];
  if (target.every((value) => value === undefined)) return null;
  if (target.some((value) => value === undefined)) {
    throw new Error('Feishu delivery card target configuration is incomplete');
  }
  return new FeishuDeliveryCardReconciler(env.DB_CONTROL, {
    tenantKey: env.FEISHU_DELIVERY_TENANT_KEY!,
    chatId: env.FEISHU_DELIVERY_CHAT_ID!,
  }, { secrets: configuredSecrets(env) });
}

export interface FeishuDeliveryCardRuntime {
  client: FeishuDeliveryCardApiClient;
  processor: FeishuDeliveryCardOutboxProcessor;
  reconciler: FeishuDeliveryCardReconciler;
  messageReconciler: FeishuDeliveryCardMessageReconciler;
}

export function feishuDeliveryCardRuntimeFromEnv(
  env: Bindings,
): FeishuDeliveryCardRuntime | null {
  const required = [
    env.FEISHU_APP_ID,
    env.FEISHU_APP_SECRET,
    env.FEISHU_DELIVERY_TENANT_KEY,
    env.FEISHU_DELIVERY_CHAT_ID,
  ];
  if (required.every((value) => value === undefined)) return null;
  if (required.some((value) => value === undefined)) {
    throw new Error('Feishu delivery card configuration is incomplete');
  }
  const client = new FeishuDeliveryCardApiClient({
    appId: env.FEISHU_APP_ID!,
    appSecret: env.FEISHU_APP_SECRET!,
    ...(env.FEISHU_API_BASE_URL === undefined
      ? {}
      : { baseUrl: env.FEISHU_API_BASE_URL }),
    cache: tokenCache,
  });
  const reconciler = feishuDeliveryCardReconcilerFromEnv(env);
  if (reconciler === null) throw new Error('Feishu delivery card target is unavailable');
  return {
    client,
    processor: new FeishuDeliveryCardOutboxProcessor(env.DB_CONTROL, client),
    reconciler,
    messageReconciler: new FeishuDeliveryCardMessageReconciler(
      env.DB_CONTROL,
      client,
      {
        appId: env.FEISHU_APP_ID!,
        tenantKey: env.FEISHU_DELIVERY_TENANT_KEY!,
        chatId: env.FEISHU_DELIVERY_CHAT_ID!,
      },
    ),
  };
}

export async function reconcileFeishuDeliveryCardsFromEnv(
  env: Bindings,
): Promise<unknown[]> {
  const runtime = feishuDeliveryCardRuntimeFromEnv(env);
  if (runtime === null) return [];
  const [projected, observed] = await Promise.all([
    runtime.reconciler.reconcileBatch(25),
    runtime.messageReconciler.reconcileBatch(25),
  ]);
  return [...projected, ...observed];
}
