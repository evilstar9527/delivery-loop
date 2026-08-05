-- GitHub commit-comment approvals are observed with a repository-scoped
-- contents:read App token and stored through identity_bound_approvals. Keep
-- legacy low-risk approvals compatible while requiring live mapped roles for
-- every new identity-bound repo_write approval.

DROP VIEW trusted_effect_approvals;

CREATE VIEW trusted_effect_approvals AS
SELECT approvals.*
FROM approvals
WHERE approvals.effect NOT IN ('merge', 'production_deploy')
  AND NOT EXISTS (
    SELECT 1 FROM feishu_card_action_approval_bindings
    WHERE feishu_card_action_approval_bindings.approval_id = approvals.approval_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM identity_bound_approvals
    WHERE identity_bound_approvals.approval_id = approvals.approval_id
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
JOIN identity_mappings
  ON identity_mappings.principal = bindings.approver_principal
WHERE approvals.effect = 'repo_write'
  AND json_valid(identity_mappings.roles)
  AND json_type(identity_mappings.roles) = 'array'
  AND EXISTS (
    SELECT 1 FROM json_each(identity_mappings.roles) WHERE value = 'human'
  )
  AND EXISTS (
    SELECT 1 FROM json_each(identity_mappings.roles)
    WHERE value = 'approve:repo_write'
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
