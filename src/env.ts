import type { WorkflowOutboxMessage } from './outbox/workflow-outbox.js';
import type { FeishuIngressQueueMessage } from './outbox/feishu-ingress.js';
import type { DeliveryRunWorkflowParams } from './workflows/delivery-run-workflow.js';
import type { ControlPlaneBackupWorkflowParams } from './workflows/control-plane-backup-workflow.js';

export interface Bindings {
  DB_CONTROL: D1Database;
  TASK_OBJECTS: R2Bucket;
  CHECKPOINT_OBJECTS: R2Bucket;
  BACKUP_OBJECTS: R2Bucket;
  RAW_AGENT_OBJECTS: R2Bucket;
  EXECUTOR_PATCH_OBJECTS: R2Bucket;
  RAW_AGENT_ARTIFACT_ENCRYPTION_KEY?: string;
  FEISHU_INGRESS_QUEUE: Queue<FeishuIngressQueueMessage>;
  TASK_INTAKE_TOKEN?: string;
  OPERATIONS_TOKEN?: string;
  APPROVAL_ADAPTER_TOKEN?: string;
  GITHUB_OIDC_AUDIENCE?: string;
  GITHUB_OIDC_JWKS?: string;
  GITHUB_OIDC_JWKS_URL?: string;
  GITHUB_WEBHOOK_SECRET?: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_INSTALLATION_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  /** `app` (default for legacy App config) or `pat`. */
  GITHUB_AUTH_MODE?: string;
  GITHUB_PAT?: string;
  GITHUB_PAT_EXPIRES_AT?: string;
  GITHUB_ALLOWED_REPOSITORIES?: string;
  GITHUB_AGENT_EXECUTOR_REPOSITORY?: string;
  GITHUB_AGENT_EXECUTOR_REF?: string;
  GITHUB_API_BASE_URL?: string;
  /** Optional Git smart-HTTP origin; defaults to https://github.com. */
  GITHUB_GIT_BASE_URL?: string;
  GITHUB_CREDENTIAL_ENCRYPTION_KEY?: string;
  FEISHU_APP_ID?: string;
  FEISHU_APP_SECRET?: string;
  FEISHU_EVENT_ENCRYPT_KEY?: string;
  FEISHU_EVENT_VERIFICATION_TOKEN?: string;
  FEISHU_API_BASE_URL?: string;
  FEISHU_DELIVERY_TENANT_KEY?: string;
  FEISHU_DELIVERY_CHAT_ID?: string;
  MONITOR_WEBHOOK_SECRET?: string;
  MONITOR_TENANT_KEY?: string;
  MONITOR_ALLOWED_REPOSITORIES?: string;
  MONITOR_SUPPRESSION_WINDOW_SECONDS?: string;
  TEST_DEPLOY_TARGETS_JSON?: string;
  YUNXIAO_TEST_DEPLOY_ORGANIZATION_ID?: string;
  YUNXIAO_TEST_DEPLOY_PIPELINE_ID?: string;
  PRODUCTION_DEPLOY_TARGETS_JSON?: string;
  CONTROL_PLANE_URL?: string;
  CODEX_MODEL_PROFILE_ID?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  D1_DATABASE_ID?: string;
  D1_BACKUP_API_TOKEN?: string;
  TOOL_BRIDGE?: Fetcher;
  TOOL_BRIDGE_INTERNAL_TOKEN?: string;
  /** Preferred private service binding to the independent Agent Executor Worker. */
  AGENT_EXECUTOR?: Fetcher;
  /** Explicit HTTPS fallback origin; mutually exclusive with AGENT_EXECUTOR. */
  AGENT_EXECUTOR_URL?: string;
  AGENT_EXECUTOR_CONTROL_TOKEN?: string;
  /** Shared only with the Executor Worker's outbound proxy, never a container. */
  AGENT_EXECUTOR_CALLBACK_TOKEN?: string;
  /** Control-plane-only Responses relay configuration; never passed to a container. */
  EXECUTOR_MODEL_PROVIDER?: string;
  EXECUTOR_MODEL_BASE_URL?: string;
  EXECUTOR_MODEL_API_KEY?: string;
  /** Control-plane-only key for encrypting per-reservation model grants in D1. */
  EXECUTOR_MODEL_GRANT_ENCRYPTION_KEY?: string;
  WORKFLOW_OUTBOX_QUEUE: Queue<WorkflowOutboxMessage>;
  DELIVERY_RUN: Workflow<DeliveryRunWorkflowParams>;
  CONTROL_PLANE_BACKUP: Workflow<ControlPlaneBackupWorkflowParams>;
}
