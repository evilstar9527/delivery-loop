-- Preserve the safe identity binding snapshot for rejected high-risk decisions.
-- Raw provider payloads and role bodies remain outside D1; only principal/channel
-- identifiers and canonical role digest are retained for audit verification.
ALTER TABLE approval_identity_rejections ADD COLUMN approver_channel TEXT;
ALTER TABLE approval_identity_rejections ADD COLUMN approver_channel_user_id TEXT;
ALTER TABLE approval_identity_rejections ADD COLUMN author_channel TEXT;
ALTER TABLE approval_identity_rejections ADD COLUMN author_login TEXT;
ALTER TABLE approval_identity_rejections ADD COLUMN roles_digest TEXT;
ALTER TABLE approval_identity_rejections ADD COLUMN separation_verified INTEGER NOT NULL DEFAULT 0
  CHECK (separation_verified IN (0, 1));
