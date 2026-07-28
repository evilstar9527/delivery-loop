-- Preserve whether a rejected identity event attempted an approval or rejection.
-- The source payload remains external; this is only the strict decision scalar.
ALTER TABLE approval_identity_rejections
  ADD COLUMN decision TEXT NOT NULL DEFAULT 'approve'
  CHECK (decision IN ('approve', 'reject'));
