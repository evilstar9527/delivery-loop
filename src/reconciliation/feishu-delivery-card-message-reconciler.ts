import { canonicalSha256 } from '../domain/digest.js';
import {
  renderFeishuDeliveryCard,
} from '../domain/feishu-delivery-card.js';
import type { FeishuDeliveryCardMessageFact } from '../outbox/feishu-delivery-card.js';
import {
  feishuDeliveryCardPresentationFromRow,
  type StoredFeishuDeliveryCardPresentationRow,
} from '../storage/feishu-delivery-card-presentation.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const MESSAGE_ID_PATTERN = /^om_[A-Za-z0-9_-]{1,196}$/;

export interface FeishuDeliveryCardMessageFactClient {
  getCardMessage(messageId: string): Promise<FeishuDeliveryCardMessageFact | null>;
}

export interface FeishuDeliveryCardMessageReconcilerConfig {
  appId: string;
  tenantKey: string;
  chatId: string;
}

interface CandidateRow extends StoredFeishuDeliveryCardPresentationRow {
  revision: number;
  digest: string;
  chat_id: string;
  tenant_key: string;
  active_message_id: string;
  outbox_id: string;
}

interface ObservationRow {
  fact_digest: string;
  processing_state: 'received' | 'applied' | 'ignored';
}

export type FeishuDeliveryCardMessageDisposition =
  | 'applied'
  | 'duplicate'
  | 'ignored'
  | 'pending'
  | 'not_found';

export interface FeishuDeliveryCardMessageBatchResult {
  runId: string;
  disposition: Exclude<FeishuDeliveryCardMessageDisposition, 'not_found'> | 'unavailable';
}

/** Repairs a lost PATCH response only after GET returns the exact intended card. */
export class FeishuDeliveryCardMessageReconciler {
  constructor(
    private readonly db: D1Database,
    private readonly client: FeishuDeliveryCardMessageFactClient,
    private readonly config: FeishuDeliveryCardMessageReconcilerConfig,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (
      !ID_PATTERN.test(config.appId) || !ID_PATTERN.test(config.tenantKey) ||
      !ID_PATTERN.test(config.chatId)
    ) {
      throw new Error('Feishu delivery card message reconciliation config is invalid');
    }
  }

  async reconcileCard(runId: string): Promise<FeishuDeliveryCardMessageDisposition> {
    if (!ID_PATTERN.test(runId)) return 'not_found';
    const candidate = await this.candidate(runId);
    if (candidate === null) return 'not_found';
    const fact = await this.client.getCardMessage(candidate.active_message_id);
    if (fact === null) return 'pending';
    const factDigest = await canonicalSha256(fact);
    const identity = await canonicalSha256({
      source: 'feishu_api',
      presentationId: candidate.presentation_id,
      factDigest,
    });
    const observationId =
      `feishu_card_api_${identity.slice('sha256:'.length, 'sha256:'.length + 48)}`;
    const existing = await this.observation(observationId);
    if (existing !== null) {
      if (existing.fact_digest !== factDigest) throw new Error('Feishu observation conflict');
      if (existing.processing_state !== 'received') return 'duplicate';
    } else {
      await this.db.prepare(
        `INSERT INTO feishu_delivery_card_observations (
           observation_id, source_kind, fact_digest, run_id, card_id,
           message_id, processing_state, external_updated_at, observed_at
         ) VALUES (?, 'api', ?, ?, ?, ?, 'received', ?, ?)
         ON CONFLICT DO NOTHING`,
      ).bind(
        observationId,
        factDigest,
        candidate.run_id,
        candidate.card_id,
        fact.messageId,
        fact.updatedAt,
        this.now().toISOString(),
      ).run();
      const persisted = await this.observation(observationId);
      if (persisted === null || persisted.fact_digest !== factDigest) {
        throw new Error('Feishu observation conflict');
      }
      if (persisted.processing_state !== 'received') return 'duplicate';
    }
    if (
      !MESSAGE_ID_PATTERN.test(fact.messageId) ||
      fact.messageId !== candidate.active_message_id ||
      fact.chatId !== candidate.chat_id || fact.chatId !== this.config.chatId ||
      fact.appId !== this.config.appId ||
      fact.tenantKey !== candidate.tenant_key || fact.tenantKey !== this.config.tenantKey ||
      fact.msgType !== 'interactive' || fact.deleted
    ) {
      await this.finalize(observationId, 'ignored', 'binding_mismatch', null);
      return 'ignored';
    }
    const expectedCardDigest = await canonicalSha256(
      renderFeishuDeliveryCard(this.presentation(candidate)),
    );
    if (fact.cardDigest !== expectedCardDigest) {
      await this.finalize(observationId, 'ignored', 'content_mismatch', null);
      return 'ignored';
    }
    const current = await this.candidate(runId);
    if (current === null || current.presentation_id !== candidate.presentation_id) {
      await this.finalize(observationId, 'ignored', 'presentation_stale', null);
      return 'ignored';
    }
    const observedAt = this.now().toISOString();
    await this.db.batch([
      this.db.prepare(
        `INSERT OR IGNORE INTO feishu_delivery_card_deliveries (
           delivery_id, presentation_id, outbox_id, disposition,
           message_id, error_code, delivered_at
         ) VALUES (?, ?, ?, 'updated', ?, NULL, ?)`,
      ).bind(
        `feishu_delivery_${candidate.presentation_id}`,
        candidate.presentation_id,
        candidate.outbox_id,
        candidate.active_message_id,
        fact.updatedAt,
      ),
      this.db.prepare(
        `UPDATE feishu_delivery_cards
         SET delivered_presentation_id = ?, delivered_revision = ?,
             delivered_digest = ?, updated_at = ?
         WHERE card_id = ? AND latest_presentation_id = ?
           AND active_message_id = ? AND delivered_revision < ?`,
      ).bind(
        candidate.presentation_id,
        candidate.revision,
        candidate.digest,
        observedAt,
        candidate.card_id,
        candidate.presentation_id,
        candidate.active_message_id,
        candidate.revision,
      ),
      this.db.prepare(
        `UPDATE outbox
         SET delivery_state = 'settled', lease_token = NULL, lease_expires_at = NULL,
             last_error_code = NULL, updated_at = ?
         WHERE outbox_id = ? AND run_id = ?
           AND kind = 'feishu_delivery_card_upsert'
           AND destination = 'feishu_cards'
           AND payload_ref = 'd1://feishu-delivery-card-presentations/' || ?
           AND delivery_state IN ('pending', 'delivering')`,
      ).bind(observedAt, candidate.outbox_id, candidate.run_id, candidate.presentation_id),
    ]);
    const applied = await this.db.prepare(
      `SELECT cards.delivered_presentation_id, outbox.delivery_state
       FROM feishu_delivery_cards AS cards
       JOIN outbox ON outbox.outbox_id = ?
       WHERE cards.card_id = ?`,
    ).bind(candidate.outbox_id, candidate.card_id).first<{
      delivered_presentation_id: string | null;
      delivery_state: string;
    }>();
    if (
      applied?.delivered_presentation_id !== candidate.presentation_id ||
      applied.delivery_state !== 'settled'
    ) throw new Error('Feishu delivery card reconciliation conflict');
    await this.finalize(observationId, 'applied', null, candidate.presentation_id);
    return 'applied';
  }

  async reconcileBatch(limit = 25): Promise<FeishuDeliveryCardMessageBatchResult[]> {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 100) {
      throw new Error('Feishu delivery card message reconciliation limit is invalid');
    }
    const candidates = await this.db.prepare(
      `SELECT cards.run_id
       FROM feishu_delivery_cards AS cards
       JOIN feishu_delivery_card_presentations AS presentations
         ON presentations.presentation_id = cards.latest_presentation_id
       JOIN outbox
         ON outbox.payload_ref =
           'd1://feishu-delivery-card-presentations/' || presentations.presentation_id
       LEFT JOIN feishu_delivery_card_deliveries AS deliveries
         ON deliveries.presentation_id = presentations.presentation_id
       WHERE cards.active_message_id IS NOT NULL
         AND cards.delivered_presentation_id IS NOT presentations.presentation_id
         AND deliveries.delivery_id IS NULL
         AND outbox.delivery_state IN ('pending', 'delivering')
       ORDER BY outbox.updated_at, cards.run_id LIMIT ?`,
    ).bind(limit).all<{ run_id: string }>();
    const results: FeishuDeliveryCardMessageBatchResult[] = [];
    for (const candidate of candidates.results) {
      try {
        const disposition = await this.reconcileCard(candidate.run_id);
        if (disposition !== 'not_found') {
          results.push({ runId: candidate.run_id, disposition });
        }
      } catch {
        results.push({ runId: candidate.run_id, disposition: 'unavailable' });
      }
    }
    return results;
  }

  private async candidate(runId: string): Promise<CandidateRow | null> {
    return await this.db.prepare(
      `SELECT cards.card_id, cards.run_id, cards.tenant_key, cards.chat_id,
              cards.active_message_id,
              presentations.presentation_id, presentations.run_version,
              presentations.revision, presentations.digest,
              presentations.schema_version, presentations.presentation_json,
              presentations.refresh_request_id,
              presentations.pr_status, presentations.pr_url,
              presentations.merge_status, presentations.merge_url,
              presentations.test_deploy_status, presentations.test_deploy_url,
              presentations.production_deploy_status,
              presentations.production_deploy_url,
              outbox.outbox_id
       FROM feishu_delivery_cards AS cards
       JOIN feishu_delivery_card_presentations AS presentations
         ON presentations.presentation_id = cards.latest_presentation_id
       JOIN outbox
         ON outbox.payload_ref =
           'd1://feishu-delivery-card-presentations/' || presentations.presentation_id
       LEFT JOIN feishu_delivery_card_deliveries AS deliveries
         ON deliveries.presentation_id = presentations.presentation_id
       WHERE cards.run_id = ? AND cards.active_message_id IS NOT NULL
         AND cards.delivered_presentation_id IS NOT presentations.presentation_id
         AND deliveries.delivery_id IS NULL
         AND outbox.delivery_state IN ('pending', 'delivering')`,
    ).bind(runId).first<CandidateRow>();
  }

  private presentation(row: CandidateRow) {
    return feishuDeliveryCardPresentationFromRow(row);
  }

  private async observation(observationId: string): Promise<ObservationRow | null> {
    return await this.db.prepare(
      `SELECT fact_digest, processing_state
       FROM feishu_delivery_card_observations WHERE observation_id = ?`,
    ).bind(observationId).first<ObservationRow>();
  }

  private async finalize(
    observationId: string,
    state: 'applied' | 'ignored',
    reason: 'binding_mismatch' | 'content_mismatch' | 'presentation_stale' | null,
    presentationId: string | null,
  ): Promise<void> {
    await this.db.prepare(
      `UPDATE feishu_delivery_card_observations
       SET processing_state = ?, ignore_reason = ?, presentation_id = ?, processed_at = ?
       WHERE observation_id = ? AND processing_state = 'received'`,
    ).bind(state, reason, presentationId, this.now().toISOString(), observationId).run();
  }
}
