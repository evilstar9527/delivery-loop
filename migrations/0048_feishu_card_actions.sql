-- Version-fenced Feishu card-action receipts. The verified webhook body and
-- context text are never stored here; only exact identities, digests, fixed
-- command/effect enums, and terminal outcomes cross the D1 boundary.

CREATE TABLE IF NOT EXISTS feishu_card_action_receipts (
  action_receipt_id       TEXT PRIMARY KEY,
  delivery_id             TEXT NOT NULL UNIQUE
    REFERENCES feishu_webhook_deliveries(delivery_id) ON DELETE CASCADE,
  tenant_key              TEXT NOT NULL,
  app_id                  TEXT NOT NULL,
  event_id                TEXT NOT NULL,
  event_created_at        TEXT NOT NULL,
  operator_open_id        TEXT NOT NULL,
  principal               TEXT NOT NULL,
  roles_digest            TEXT NOT NULL CHECK (length(roles_digest) = 71),
  chat_id                 TEXT NOT NULL,
  message_id              TEXT NOT NULL,
  card_id                 TEXT NOT NULL REFERENCES feishu_delivery_cards(card_id) ON DELETE CASCADE,
  presentation_id         TEXT NOT NULL
    REFERENCES feishu_delivery_card_presentations(presentation_id) ON DELETE CASCADE,
  task_id                 TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  run_id                  TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  run_version             INTEGER NOT NULL CHECK (run_version >= 0),
  task_revision_digest    TEXT NOT NULL CHECK (length(task_revision_digest) = 71),
  plan_id                 TEXT NOT NULL REFERENCES execution_plans(plan_id) ON DELETE CASCADE,
  plan_version            INTEGER NOT NULL CHECK (plan_version > 0),
  plan_digest             TEXT NOT NULL CHECK (length(plan_digest) = 71),
  base_sha                TEXT NOT NULL CHECK (length(base_sha) = 40),
  action_id               TEXT NOT NULL,
  command                 TEXT NOT NULL CHECK (
    command IN ('approve', 'reject', 'cancel', 'retry', 'replay', 'add_context')
  ),
  effect                  TEXT NOT NULL CHECK (
    effect IN (
      'repo_write', 'test_deploy', 'merge', 'production_deploy',
      'cancel_run', 'retry_run', 'replay_run', 'add_context'
    )
  ),
  context_mode            TEXT CHECK (context_mode IS NULL OR context_mode IN ('new_run', 'apply_current')),
  nonce_digest            TEXT NOT NULL CHECK (length(nonce_digest) = 71),
  command_digest          TEXT NOT NULL CHECK (length(command_digest) = 71),
  received_at             TEXT NOT NULL,
  created_at              TEXT NOT NULL,
  UNIQUE (tenant_key, event_id),
  UNIQUE (tenant_key, nonce_digest),
  CHECK (
    (command = 'add_context' AND effect = 'add_context' AND context_mode IS NOT NULL) OR
    (command <> 'add_context' AND context_mode IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS feishu_card_action_outcomes (
  outcome_id              TEXT PRIMARY KEY,
  action_receipt_id       TEXT NOT NULL UNIQUE
    REFERENCES feishu_card_action_receipts(action_receipt_id) ON DELETE CASCADE,
  disposition             TEXT NOT NULL CHECK (disposition IN ('applied', 'rejected')),
  result_kind             TEXT CHECK (
    result_kind IS NULL OR result_kind IN (
      'approval', 'cancellation', 'recovery_attempt', 'workflow_replay', 'task_revision'
    )
  ),
  result_id               TEXT,
  reason_code             TEXT CHECK (
    reason_code IS NULL OR reason_code IN (
      'state_conflict', 'effect_failed', 'context_required', 'secret_detected',
      'identity_unresolved', 'actor_not_human', 'actor_not_authorized',
      'self_approval_denied'
    )
  ),
  completed_at            TEXT NOT NULL,
  created_at              TEXT NOT NULL,
  CHECK (
    (disposition = 'applied' AND result_kind IS NOT NULL AND result_id IS NOT NULL
      AND reason_code IS NULL) OR
    (disposition = 'rejected' AND result_kind IS NULL AND result_id IS NULL
      AND reason_code IS NOT NULL)
  )
);

-- Low-risk approvals created through a card must retain live Feishu identity
-- authority. Historical non-card approvals keep their previous contract.
CREATE TABLE IF NOT EXISTS feishu_card_action_approval_bindings (
  approval_id             TEXT PRIMARY KEY REFERENCES approvals(approval_id) ON DELETE CASCADE,
  action_receipt_id       TEXT NOT NULL UNIQUE
    REFERENCES feishu_card_action_receipts(action_receipt_id) ON DELETE CASCADE,
  approver_principal      TEXT NOT NULL,
  approver_channel        TEXT NOT NULL,
  approver_channel_user_id TEXT NOT NULL,
  roles_digest            TEXT NOT NULL CHECK (length(roles_digest) = 71),
  created_at              TEXT NOT NULL
);

DROP VIEW trusted_effect_approvals;

CREATE VIEW trusted_effect_approvals AS
SELECT approvals.*
FROM approvals
WHERE approvals.effect NOT IN ('merge', 'production_deploy')
  AND NOT EXISTS (
    SELECT 1 FROM feishu_card_action_approval_bindings
    WHERE feishu_card_action_approval_bindings.approval_id = approvals.approval_id
  )
UNION ALL
SELECT approvals.*
FROM approvals
JOIN feishu_card_action_approval_bindings AS card_bindings
  ON card_bindings.approval_id = approvals.approval_id
JOIN channel_identities AS approver_identity
  ON approver_identity.channel = card_bindings.approver_channel
 AND approver_identity.channel_user_id = card_bindings.approver_channel_user_id
 AND approver_identity.principal = card_bindings.approver_principal
JOIN identity_mappings
  ON identity_mappings.principal = card_bindings.approver_principal
WHERE approvals.effect IN ('repo_write', 'test_deploy')
  AND json_valid(identity_mappings.roles)
  AND json_type(identity_mappings.roles) = 'array'
  AND EXISTS (
    SELECT 1 FROM json_each(identity_mappings.roles) WHERE value = 'human'
  )
  AND EXISTS (
    SELECT 1 FROM json_each(identity_mappings.roles)
    WHERE value = 'approve:' || approvals.effect
  )
UNION ALL
SELECT approvals.*
FROM approvals
JOIN identity_bound_approvals AS bindings
  ON bindings.approval_id = approvals.approval_id
JOIN channel_identities AS approver_identity
  ON approver_identity.channel = bindings.approver_channel
 AND approver_identity.channel_user_id = bindings.approver_channel_user_id
 AND approver_identity.principal = bindings.approver_principal
JOIN channel_identities AS author_identity
  ON author_identity.channel = bindings.pull_request_author_channel
 AND author_identity.channel_user_id = bindings.pull_request_author_login
 AND author_identity.principal = bindings.pull_request_author_principal
JOIN identity_mappings
  ON identity_mappings.principal = bindings.approver_principal
WHERE approvals.effect = 'merge'
  AND bindings.separation_verified = 1
  AND bindings.approver_principal <> bindings.pull_request_author_principal
  AND json_valid(identity_mappings.roles)
  AND json_type(identity_mappings.roles) = 'array'
  AND EXISTS (
    SELECT 1 FROM json_each(identity_mappings.roles) WHERE value = 'human'
  )
  AND EXISTS (
    SELECT 1 FROM json_each(identity_mappings.roles)
    WHERE value = 'approve:' || approvals.effect
  )
UNION ALL
SELECT approvals.*
FROM approvals
JOIN identity_bound_approvals AS bindings
  ON bindings.approval_id = approvals.approval_id
JOIN production_release_approval_bindings AS releases
  ON releases.approval_id = approvals.approval_id
JOIN github_merges AS merges
  ON merges.merge_id = releases.merge_id
 AND merges.run_id = releases.run_id
 AND merges.plan_id = releases.plan_id
 AND merges.plan_version = releases.plan_version
 AND merges.plan_digest = releases.plan_digest
 AND merges.merge_sha = releases.merge_sha
JOIN channel_identities AS approver_identity
  ON approver_identity.channel = bindings.approver_channel
 AND approver_identity.channel_user_id = bindings.approver_channel_user_id
 AND approver_identity.principal = bindings.approver_principal
JOIN channel_identities AS author_identity
  ON author_identity.channel = bindings.pull_request_author_channel
 AND author_identity.channel_user_id = bindings.pull_request_author_login
 AND author_identity.principal = bindings.pull_request_author_principal
JOIN identity_mappings
  ON identity_mappings.principal = bindings.approver_principal
WHERE approvals.effect = 'production_deploy'
  AND approvals.run_id = releases.run_id
  AND approvals.task_revision = releases.task_revision
  AND approvals.plan_id = releases.plan_id
  AND approvals.plan_version = releases.plan_version
  AND approvals.plan_digest = releases.plan_digest
  AND releases.environment = 'production'
  AND bindings.separation_verified = 1
  AND bindings.approver_principal <> bindings.pull_request_author_principal
  AND json_valid(identity_mappings.roles)
  AND json_type(identity_mappings.roles) = 'array'
  AND EXISTS (
    SELECT 1 FROM json_each(identity_mappings.roles) WHERE value = 'human'
  )
  AND EXISTS (
    SELECT 1 FROM json_each(identity_mappings.roles)
    WHERE value = 'approve:production_deploy'
  );

CREATE TRIGGER IF NOT EXISTS trg_feishu_card_action_receipt_immutable
BEFORE UPDATE ON feishu_card_action_receipts
BEGIN SELECT RAISE(ABORT, 'feishu_card_action_receipt_is_immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_feishu_card_action_outcome_immutable
BEFORE UPDATE ON feishu_card_action_outcomes
BEGIN SELECT RAISE(ABORT, 'feishu_card_action_outcome_is_immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_feishu_card_action_approval_binding_immutable
BEFORE UPDATE ON feishu_card_action_approval_bindings
BEGIN SELECT RAISE(ABORT, 'feishu_card_action_approval_binding_is_immutable'); END;
