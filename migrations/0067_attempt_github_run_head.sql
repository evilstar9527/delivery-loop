-- Bind runner OIDC and workflow-run observations to the immutable GitHub run
-- head independently from the repository snapshot checked out by the Agent.

ALTER TABLE attempts ADD COLUMN github_head_sha TEXT
  CHECK (github_head_sha IS NULL OR length(github_head_sha) = 40);
