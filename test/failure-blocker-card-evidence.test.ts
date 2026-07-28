import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FailureBlockerCardEvidenceManifestV1Schema,
  type FailureBlockerCardEvidenceManifestV1,
} from '../src/domain/failure-blocker-card-evidence.js';
import { canonicalSha256 } from '../src/domain/digest.js';
import {
  FailureBlockerCardEvidenceVerificationError,
  verifyFailureBlockerCardEvidence,
} from '../src/pilot/failure-blocker-card-evidence-verifier.js';

const CREATED_AT = '2026-07-26T12:00:00.000Z';
const UPDATED_AT = '2026-07-26T12:01:00.000Z';

const BASE_MANIFEST: FailureBlockerCardEvidenceManifestV1 = {
  schemaVersion: '1',
  evidenceId: 'failure-blocker-card-evidence-1',
  recordedAt: '2026-07-26T12:05:00.000Z',
  taskId: 'task-failure-blocker-card-1',
  runId: 'run-failure-blocker-card-1',
  repository: 'example/delivery-pilot',
  blocker: {
    blockerId: 'blocker-failure-card-1',
    reason: 'repeated_fingerprint',
    fingerprintDigest: `sha256:${'1'.repeat(64)}`,
    attemptCount: 2,
    consecutiveFingerprintCount: 2,
    attempts: [
      {
        attemptId: 'attempt-failure-card-1',
        ordinal: 1,
        pathCodes: ['repository_inspection'],
      },
      {
        attemptId: 'attempt-failure-card-2',
        ordinal: 2,
        pathCodes: ['targeted_test'],
      },
    ],
    neededHumanInput: 'provide_reproduction',
    createdAt: '2026-07-26T11:55:00.000Z',
  },
  card: {
    presentationId: 'feishu-presentation-failure-card-1',
    revision: 3,
    presentationDigest: `sha256:${'2'.repeat(64)}`,
    renderedCardDigest: `sha256:${'3'.repeat(64)}`,
    outboxId: 'outbox-failure-card-1',
    messageId: 'om_failure_blocker_card_1',
    appId: 'cli_delivery_loop',
    tenantKey: 'tenant_delivery_loop',
    chatId: 'oc_delivery_loop_pilot',
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
  },
};

function blockerText(): string {
  return '**Blocker**\n原因：repeated_fingerprint · 尝试：2 · ' +
    'Inspected the trusted repository snapshot · Ran trusted targeted verification · ' +
    'Provide a minimal reproduction with expected and actual behavior.';
}

function card(content = blockerText()): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: { title: { tag: 'plain_text', content: 'Delivery Loop · blocked' } },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: '**当前状态**\n阻塞 (blocked)' } },
      { tag: 'div', text: { tag: 'lark_md', content } },
    ],
  };
}

async function fixture(): Promise<FailureBlockerCardEvidenceManifestV1> {
  return {
    ...BASE_MANIFEST,
    card: {
      ...BASE_MANIFEST.card,
      renderedCardDigest: await canonicalSha256(card()),
    },
  };
}

function taskView(
  manifest: FailureBlockerCardEvidenceManifestV1,
  options: { rawError?: string; reason?: string } = {},
): Record<string, unknown> {
  return {
    task: {
      id: manifest.taskId,
      target: { repository: manifest.repository },
    },
    run: {
      id: manifest.runId,
      state: 'blocked',
      version: 7,
      blocker: {
        id: manifest.blocker.blockerId,
        reason: options.reason ?? manifest.blocker.reason,
        fingerprintDigest: manifest.blocker.fingerprintDigest,
        attemptCount: manifest.blocker.attemptCount,
        consecutiveFingerprintCount: manifest.blocker.consecutiveFingerprintCount,
        attemptedPaths: [
          {
            attemptId: manifest.blocker.attempts[0]!.attemptId,
            ordinal: 1,
            failureClass: 'verification_error',
            failureCode: 'verification_nonzero_exit',
            failureSite: 'targeted_verification',
            occurredAt: '2026-07-26T11:50:00.000Z',
            paths: [{
              code: 'repository_inspection',
              label: 'Inspected the trusted repository snapshot',
            }],
          },
          {
            attemptId: manifest.blocker.attempts[1]!.attemptId,
            ordinal: 2,
            failureClass: 'verification_error',
            failureCode: 'verification_nonzero_exit',
            failureSite: 'targeted_verification',
            occurredAt: '2026-07-26T11:54:00.000Z',
            paths: [{
              code: 'targeted_test',
              label: 'Ran trusted targeted verification',
            }],
          },
        ],
        neededHumanInput: {
          code: manifest.blocker.neededHumanInput,
          prompt: 'Provide a minimal reproduction with expected and actual behavior.',
        },
        createdAt: manifest.blocker.createdAt,
        ...(options.rawError === undefined ? {} : { rawError: options.rawError }),
      },
    },
  };
}

function operationsView(
  manifest: FailureBlockerCardEvidenceManifestV1,
  deliveryState: 'pending' | 'settled' = 'settled',
): Record<string, unknown> {
  return {
    schemaVersion: '1',
    card: {
      runId: manifest.runId,
      cardId: 'feishu-card-failure-blocker-1',
      latest: {
        presentationId: manifest.card.presentationId,
        revision: manifest.card.revision,
        digest: manifest.card.presentationDigest,
        renderedDigest: manifest.card.renderedCardDigest,
        outboxId: manifest.card.outboxId,
        deliveryState,
        attemptCount: 1,
        lastErrorCode: null,
      },
      delivered: {
        presentationId: manifest.card.presentationId,
        revision: manifest.card.revision,
        digest: manifest.card.presentationDigest,
        messageId: manifest.card.messageId,
      },
    },
  };
}

function feishuMessage(
  manifest: FailureBlockerCardEvidenceManifestV1,
  options: { content?: string; chatId?: string } = {},
): Record<string, unknown> {
  const rendered = card(options.content ?? blockerText());
  return {
    code: 0,
    msg: 'success',
    data: {
      items: [{
        message_id: manifest.card.messageId,
        msg_type: 'interactive',
        chat_id: options.chatId ?? manifest.card.chatId,
        deleted: false,
        create_time: String(Date.parse(manifest.card.createdAt)),
        update_time: String(Date.parse(manifest.card.updatedAt)),
        sender: {
          sender_type: 'app',
          id: manifest.card.appId,
          tenant_key: manifest.card.tenantKey,
        },
        body: { content: JSON.stringify(rendered) },
      }],
    },
  };
}

interface FakeOptions {
  rawError?: string;
  reason?: string;
  deliveryState?: 'pending' | 'settled';
  blockerContent?: string;
  chatId?: string;
  rawUpstreamFailure?: string;
  oversizedTaskResponse?: boolean;
}

function fakeFetch(
  manifest: FailureBlockerCardEvidenceManifestV1,
  options: FakeOptions = {},
): typeof fetch {
  return (async (input: URL | RequestInfo) => {
    const url = new URL(String(input));
    if (url.origin === 'https://control.example') {
      if (options.oversizedTaskResponse === true && url.pathname.startsWith('/v1/tasks/')) {
        return new Response(JSON.stringify({ padding: 'x'.repeat(1024 * 1024 + 1) }));
      }
      if (url.pathname.startsWith('/v1/tasks/')) {
        return Response.json(taskView(manifest, {
          ...(options.rawError === undefined ? {} : { rawError: options.rawError }),
          ...(options.reason === undefined ? {} : { reason: options.reason }),
        }));
      }
      return Response.json(operationsView(
        manifest,
        options.deliveryState ?? 'settled',
      ));
    }
    if (options.rawUpstreamFailure !== undefined) {
      return Response.json({ msg: options.rawUpstreamFailure }, { status: 503 });
    }
    return Response.json(feishuMessage(manifest, {
      ...(options.blockerContent === undefined ? {} : { content: options.blockerContent }),
      ...(options.chatId === undefined ? {} : { chatId: options.chatId }),
    }));
  }) as typeof fetch;
}

function verify(
  manifest: FailureBlockerCardEvidenceManifestV1,
  fetcher: typeof fetch,
) {
  return verifyFailureBlockerCardEvidence(manifest, {
    controlPlaneOrigin: 'https://control.example',
    operationsToken: 'CANARY_OPERATIONS_TOKEN',
    queryToken: 'CANARY_QUERY_TOKEN',
    feishuAccessToken: 'CANARY_FEISHU_TOKEN',
    feishuApiOrigin: 'https://open.feishu.test',
    fetch: fetcher,
  });
}

describe('failure blocker Feishu-card live evidence', () => {
  it('keeps a strict cross-field manifest and valid repository example', async () => {
    const manifest = await fixture();
    expect(FailureBlockerCardEvidenceManifestV1Schema.safeParse(manifest).success).toBe(true);
    const example = JSON.parse(readFileSync(
      new URL('../schemas/failure-blocker-card-evidence-v1.example.json', import.meta.url),
      'utf8',
    )) as unknown;
    expect(FailureBlockerCardEvidenceManifestV1Schema.safeParse(example).success).toBe(true);
    expect(FailureBlockerCardEvidenceManifestV1Schema.safeParse({
      ...manifest,
      blocker: { ...manifest.blocker, attemptCount: 1 },
    }).success).toBe(false);
    expect(FailureBlockerCardEvidenceManifestV1Schema.safeParse({
      ...manifest,
      blocker: { ...manifest.blocker, attempts: [manifest.blocker.attempts[0]] },
    }).success).toBe(false);
    expect(FailureBlockerCardEvidenceManifestV1Schema.safeParse({
      ...manifest,
      rawRunnerError: 'untrusted failure text',
    }).success).toBe(false);
  });

  it('cross-checks the safe blocker, settled presentation, and live Feishu card', async () => {
    const manifest = await fixture();
    const summary = await verify(manifest, fakeFetch(manifest));
    expect(summary).toEqual({
      schemaVersion: '1',
      evidenceId: manifest.evidenceId,
      repository: manifest.repository,
      runId: manifest.runId,
      blocker: 'verified',
      reason: 'repeated_fingerprint',
      attemptCount: 2,
      attemptedPathCount: 2,
      presentationId: manifest.card.presentationId,
      messageId: manifest.card.messageId,
    });
    expect(JSON.stringify(summary)).not.toContain('CANARY_');
  });

  it('rejects raw error fields or a changed control-plane blocker snapshot', async () => {
    const manifest = await fixture();
    await expect(verify(manifest, fakeFetch(manifest, {
      rawError: 'CANARY_RAW_RUNNER_ERROR',
    }))).rejects.toMatchObject({ code: 'control_plane_response_invalid' });
    await expect(verify(manifest, fakeFetch(manifest, {
      reason: 'attempt_limit',
    }))).rejects.toMatchObject({ code: 'blocker_snapshot_mismatch' });
  });

  it('rejects an unsettled delivery, wrong message binding, or changed Blocker content', async () => {
    const manifest = await fixture();
    await expect(verify(manifest, fakeFetch(manifest, {
      deliveryState: 'pending',
    }))).rejects.toMatchObject({ code: 'card_delivery_mismatch' });
    await expect(verify(manifest, fakeFetch(manifest, {
      chatId: 'oc_wrong_chat',
    }))).rejects.toMatchObject({ code: 'message_binding_mismatch' });
    await expect(verify(manifest, fakeFetch(manifest, {
      blockerContent: '**Blocker**\nraw runner error',
    }))).rejects.toMatchObject({ code: 'card_digest_mismatch' });
    const forgedContent = '**Blocker**\nraw runner error';
    const forgedManifest = {
      ...manifest,
      card: {
        ...manifest.card,
        renderedCardDigest: await canonicalSha256(card(forgedContent)),
      },
    };
    await expect(verify(forgedManifest, fakeFetch(forgedManifest, {
      blockerContent: forgedContent,
    }))).rejects.toMatchObject({ code: 'blocker_content_mismatch' });
  });

  it('never propagates upstream response text or credentials', async () => {
    const manifest = await fixture();
    const rawCanary = 'CANARY_RAW_FEISHU_RESPONSE';
    let failure: unknown;
    try {
      await verify(manifest, fakeFetch(manifest, { rawUpstreamFailure: rawCanary }));
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(FailureBlockerCardEvidenceVerificationError);
    expect(String(failure)).not.toContain(rawCanary);
    expect(String(failure)).not.toContain('CANARY_OPERATIONS_TOKEN');
    expect(String(failure)).not.toContain('CANARY_QUERY_TOKEN');
    expect(String(failure)).not.toContain('CANARY_FEISHU_TOKEN');
    await expect(verify(manifest, fakeFetch(manifest, {
      oversizedTaskResponse: true,
    }))).rejects.toMatchObject({ code: 'control_plane_response_invalid' });
  });

  it('defaults the named E2E command to prerequisite exit 2 before live reads', () => {
    const environment = { ...process.env };
    delete environment.DELIVERY_LOOP_FAILURE_BLOCKER_CARD_E2E;
    environment.FAILURE_BLOCKER_CARD_OPERATIONS_TOKEN = 'CANARY_OPERATIONS_TOKEN';
    environment.FAILURE_BLOCKER_CARD_QUERY_TOKEN = 'CANARY_QUERY_TOKEN';
    environment.FAILURE_BLOCKER_CARD_FEISHU_TOKEN = 'CANARY_FEISHU_TOKEN';
    const result = spawnSync(
      'pnpm',
      ['exec', 'tsx', 'scripts/verify-failure-blocker-card-evidence.ts'],
      {
        cwd: resolve('.'),
        env: environment,
        encoding: 'utf8',
        timeout: 30_000,
      },
    );
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('failure-blocker-card-e2e: opt-in missing');
    expect(result.stderr).not.toContain('CANARY_');
    const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts['e2e:failure-blocker-card'])
      .toBe('tsx scripts/verify-failure-blocker-card-evidence.ts');
  });
});
