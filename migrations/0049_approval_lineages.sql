-- One immutable answer joining an authenticated Feishu/GitHub decision event
-- to the exact control-plane approval snapshot it created. Raw provider
-- payloads, request bodies, tokens, nonces, and display names have no columns.

CREATE TABLE IF NOT EXISTS approval_lineages (
  lineage_id                 TEXT PRIMARY KEY,
  approval_id                TEXT NOT NULL UNIQUE
    REFERENCES approvals(approval_id) ON DELETE CASCADE,
  source_id                  TEXT
    REFERENCES approval_source_events(source_id) ON DELETE CASCADE,
  card_action_receipt_id     TEXT
    REFERENCES feishu_card_action_receipts(action_receipt_id) ON DELETE CASCADE,
  provider                   TEXT NOT NULL CHECK (provider IN ('github', 'feishu')),
  tenant_key                 TEXT NOT NULL,
  external_event_id          TEXT NOT NULL,
  external_event_digest      TEXT NOT NULL CHECK (length(external_event_digest) = 71),
  approver_principal         TEXT NOT NULL,
  roles_digest               TEXT NOT NULL CHECK (length(roles_digest) = 71),
  run_id                     TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  task_id                    TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  task_revision              TEXT NOT NULL,
  plan_id                    TEXT NOT NULL REFERENCES execution_plans(plan_id) ON DELETE CASCADE,
  plan_version               INTEGER NOT NULL CHECK (plan_version > 0),
  plan_digest                TEXT NOT NULL CHECK (length(plan_digest) = 71),
  base_sha                   TEXT NOT NULL CHECK (length(base_sha) = 40),
  effect                     TEXT NOT NULL CHECK (
    effect IN ('repo_write', 'test_deploy', 'merge', 'production_deploy')
  ),
  decision                   TEXT NOT NULL CHECK (decision IN ('approve', 'reject')),
  separation_verified       INTEGER CHECK (separation_verified IS NULL OR separation_verified IN (0, 1)),
  source_occurred_at         TEXT NOT NULL,
  decision_recorded_at       TEXT NOT NULL,
  expires_at                 TEXT NOT NULL,
  created_at                 TEXT NOT NULL,
  UNIQUE (provider, tenant_key, external_event_id),
  CHECK (source_id IS NOT NULL OR card_action_receipt_id IS NOT NULL),
  CHECK (provider = 'feishu' OR card_action_receipt_id IS NULL)
);

CREATE INDEX IF NOT EXISTS idx_approval_lineages_run
  ON approval_lineages(run_id, decision_recorded_at, approval_id);

-- Backfill identity-bound Feishu/GitHub approvals. A Feishu card receipt is
-- attached only when its exact event/snapshot/action also matches.
INSERT OR IGNORE INTO approval_lineages (
  lineage_id, approval_id, source_id, card_action_receipt_id, provider,
  tenant_key, external_event_id, external_event_digest, approver_principal,
  roles_digest, run_id, task_id, task_revision, plan_id, plan_version,
  plan_digest, base_sha, effect, decision, separation_verified,
  source_occurred_at, decision_recorded_at, expires_at, created_at
)
SELECT 'approval_lineage_' || approvals.approval_id,
       approvals.approval_id, bindings.source_id, receipts.action_receipt_id,
       sources.provider, sources.tenant_key, sources.external_event_id,
       sources.event_digest, bindings.approver_principal, bindings.roles_digest,
       approvals.run_id, runs.task_id, approvals.task_revision,
       approvals.plan_id, approvals.plan_version, approvals.plan_digest,
       approvals.base_sha, approvals.effect, approvals.decision,
       bindings.separation_verified, sources.occurred_at, approvals.created_at,
       approvals.expires_at, approvals.created_at
FROM approvals
JOIN identity_bound_approvals AS bindings
  ON bindings.approval_id = approvals.approval_id
JOIN approval_source_events AS sources ON sources.source_id = bindings.source_id
JOIN runs ON runs.run_id = approvals.run_id
LEFT JOIN feishu_card_action_receipts AS receipts
  ON sources.provider = 'feishu'
 AND receipts.tenant_key = sources.tenant_key
 AND receipts.event_id = sources.external_event_id
 AND receipts.principal = bindings.approver_principal
 AND receipts.roles_digest = bindings.roles_digest
 AND receipts.run_id = approvals.run_id
 AND receipts.task_id = runs.task_id
 AND receipts.plan_id = approvals.plan_id
 AND receipts.plan_version = approvals.plan_version
 AND receipts.plan_digest = approvals.plan_digest
 AND receipts.base_sha = approvals.base_sha
 AND receipts.effect = approvals.effect
 AND receipts.command = approvals.decision;

-- Backfill low-risk Feishu card approvals, whose authenticated source is the
-- card-action receipt plus its metadata-only webhook delivery.
INSERT OR IGNORE INTO approval_lineages (
  lineage_id, approval_id, source_id, card_action_receipt_id, provider,
  tenant_key, external_event_id, external_event_digest, approver_principal,
  roles_digest, run_id, task_id, task_revision, plan_id, plan_version,
  plan_digest, base_sha, effect, decision, separation_verified,
  source_occurred_at, decision_recorded_at, expires_at, created_at
)
SELECT 'approval_lineage_' || approvals.approval_id,
       approvals.approval_id, NULL, receipts.action_receipt_id, 'feishu',
       receipts.tenant_key, receipts.event_id, deliveries.event_digest,
       bindings.approver_principal, bindings.roles_digest, approvals.run_id,
       runs.task_id, approvals.task_revision, approvals.plan_id,
       approvals.plan_version, approvals.plan_digest, approvals.base_sha,
       approvals.effect, approvals.decision, NULL, receipts.event_created_at,
       approvals.created_at, approvals.expires_at, approvals.created_at
FROM approvals
JOIN feishu_card_action_approval_bindings AS bindings
  ON bindings.approval_id = approvals.approval_id
JOIN feishu_card_action_receipts AS receipts
  ON receipts.action_receipt_id = bindings.action_receipt_id
JOIN feishu_webhook_deliveries AS deliveries
  ON deliveries.delivery_id = receipts.delivery_id
JOIN runs ON runs.run_id = approvals.run_id;

CREATE TRIGGER IF NOT EXISTS trg_approval_lineage_shape
BEFORE INSERT ON approval_lineages
WHEN NOT EXISTS (
  SELECT 1
  FROM approvals
  JOIN runs ON runs.run_id = approvals.run_id
  WHERE approvals.approval_id = NEW.approval_id
    AND approvals.run_id = NEW.run_id
    AND runs.task_id = NEW.task_id
    AND approvals.task_revision = NEW.task_revision
    AND approvals.plan_id = NEW.plan_id
    AND approvals.plan_version = NEW.plan_version
    AND approvals.plan_digest = NEW.plan_digest
    AND approvals.base_sha = NEW.base_sha
    AND approvals.effect = NEW.effect
    AND approvals.decision = NEW.decision
    AND approvals.expires_at = NEW.expires_at
    AND approvals.created_at = NEW.decision_recorded_at
) OR (
  NEW.source_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM identity_bound_approvals AS bindings
    JOIN approval_source_events AS sources ON sources.source_id = bindings.source_id
    WHERE bindings.approval_id = NEW.approval_id
      AND bindings.source_id = NEW.source_id
      AND bindings.approver_principal = NEW.approver_principal
      AND bindings.roles_digest = NEW.roles_digest
      AND bindings.separation_verified = NEW.separation_verified
      AND sources.provider = NEW.provider
      AND sources.tenant_key = NEW.tenant_key
      AND sources.external_event_id = NEW.external_event_id
      AND sources.event_digest = NEW.external_event_digest
      AND sources.occurred_at = NEW.source_occurred_at
  )
) OR (
  NEW.source_id IS NULL AND NOT EXISTS (
    SELECT 1
    FROM feishu_card_action_approval_bindings AS bindings
    WHERE bindings.approval_id = NEW.approval_id
      AND bindings.action_receipt_id = NEW.card_action_receipt_id
      AND bindings.approver_principal = NEW.approver_principal
      AND bindings.roles_digest = NEW.roles_digest
  )
) OR (
  NEW.card_action_receipt_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM feishu_card_action_receipts AS receipts
    JOIN feishu_webhook_deliveries AS deliveries
      ON deliveries.delivery_id = receipts.delivery_id
    WHERE receipts.action_receipt_id = NEW.card_action_receipt_id
      AND receipts.tenant_key = NEW.tenant_key
      AND receipts.event_id = NEW.external_event_id
      AND deliveries.event_digest = NEW.external_event_digest
      AND receipts.principal = NEW.approver_principal
      AND receipts.roles_digest = NEW.roles_digest
      AND receipts.run_id = NEW.run_id
      AND receipts.task_id = NEW.task_id
      AND receipts.plan_id = NEW.plan_id
      AND receipts.plan_version = NEW.plan_version
      AND receipts.plan_digest = NEW.plan_digest
      AND receipts.base_sha = NEW.base_sha
      AND receipts.effect = NEW.effect
      AND receipts.command = NEW.decision
  )
)
BEGIN SELECT RAISE(ABORT, 'approval_lineage_binding_is_invalid'); END;

CREATE TRIGGER IF NOT EXISTS trg_approval_lineage_immutable
BEFORE UPDATE ON approval_lineages
BEGIN SELECT RAISE(ABORT, 'approval_lineage_is_immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_identity_approval_cannot_overlap_card_binding
BEFORE INSERT ON identity_bound_approvals
WHEN EXISTS (
  SELECT 1 FROM feishu_card_action_approval_bindings
  WHERE feishu_card_action_approval_bindings.approval_id = NEW.approval_id
)
BEGIN SELECT RAISE(ABORT, 'approval_identity_binding_is_ambiguous'); END;

CREATE TRIGGER IF NOT EXISTS trg_card_approval_cannot_overlap_identity_binding
BEFORE INSERT ON feishu_card_action_approval_bindings
WHEN EXISTS (
  SELECT 1 FROM identity_bound_approvals
  WHERE identity_bound_approvals.approval_id = NEW.approval_id
)
BEGIN SELECT RAISE(ABORT, 'approval_identity_binding_is_ambiguous'); END;
