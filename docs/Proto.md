# Proto

> 本文定义 delivery-loop 的规范性接口。字段新增优先保持向后兼容；破坏性变化必须提升 `schemaVersion`。示例中的 token 均为引用，不是可传输 Secret。

## §0. 通用约定

### 0.1 标识与时间

- `task_id`、`run_id`、`attempt_id` 由控制面生成，推荐 UUIDv7。
- 外部平台 ID 作为字符串保存，不转成 JavaScript number。
- 时间为带时区的 RFC 3339；入库统一 UTC，展示按用户时区。
- 每个写请求带 `Idempotency-Key`；回调还必须带单调递增 `sequence`。

### 0.2 摘要与敏感字段

- `*_digest` 使用 `sha256:<hex>`，对 canonical JSON 计算。
- Secret、OIDC JWT、tool-bridge SK、GitHub App private key 不得进入任务信封、dispatch payload、checkpoint、evidence 或 audit payload。
- 需要关联 Secret 时只保存 broker 内部 `secret_ref`。

### 0.3 错误形状

```ts
type DeliveryError = {
  code:
    | 'invalid_argument'
    | 'unauthenticated'
    | 'permission_denied'
    | 'not_found'
    | 'conflict'
    | 'stale_revision'
    | 'policy_denied'
    | 'rate_limited'
    | 'unavailable'
    | 'internal';
  message: string;
  retryable: boolean;
  correlationId: string;
  details?: Record<string, unknown>;
};
```

服务端不在 `message/details` 中回显 Secret、签名原文或完整外部 payload。

## §1. TaskEnvelope v1

源码契约在 `src/domain/task.ts`。规范形状：

```ts
type TaskEnvelopeV1 = {
  schemaVersion: '1';
  eventId: string;
  occurredAt: string;
  source: {
    system: 'feishu' | 'meego' | 'github' | 'monitor' | 'manual';
    tenantKey: string;
    taskKey: string;
    revision: string;
    url?: string;
  };
  actor: {
    type: 'user' | 'bot' | 'system';
    id: string;
    displayName?: string;
  };
  target: {
    owner: string;
    repo: string;
    baseBranch: string;
    environment: 'none' | 'test' | 'production';
  };
  intent: {
    kind: 'requirement' | 'bug';
    title: string;
    description: string;
    acceptanceCriteria: string[];
    priority: 'p0' | 'p1' | 'p2' | 'p3';
  };
  policy: {
    allowRepositoryWrite: boolean;
    allowTestDeploy: boolean;
    allowProductionDeploy: boolean;
    requireHumanApproval: boolean;
  };
};
```

不变量：

1. `acceptanceCriteria` 至少一条；缺失时只能分诊，不能进入写代码 attempt。
2. 去重键为 `source.system + tenantKey + taskKey + revision`。
3. revision 变化创建新的规范化快照；已执行 attempt 不被静默重写。
4. 三个 allow 字段是上限，不代表动作已经获得即时批准。

## §2. Run 与 Attempt

Run 状态以 `src/domain/run.ts` 为可执行真源。Attempt 形状：

```ts
type Attempt = {
  id: string;
  runId: string;
  ordinal: number;
  mode: 'triage' | 'implement' | 'review_fix' | 'deploy';
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'lost';
  repository: string;
  workflowRef: string;
  githubRunId?: string;
  baseSha: string;
  headBranch?: string;
  headSha?: string;
  leaseExpiresAt?: string;
  heartbeatAt?: string;
};
```

- 状态迁移必须 compare-and-set 当前 version；客户端不能提交任意 from/to。
- `failed` run 可在批准后重试；`succeeded` 与 `cancelled` 不可恢复。
- attempt 完成不等于 run 完成；PR、合并和部署结果由 webhook 再确认。

## §3. 控制面 API

### 3.1 外部事件入口

| 方法与路径 | 调用者 | 义务 |
|---|---|---|
| `POST /v1/webhooks/feishu` | 飞书 | challenge、签名/加密校验、event ID 去重、快速入队 |
| `POST /v1/webhooks/github` | GitHub App | `X-Hub-Signature-256`、delivery ID 去重、只接收白名单事件 |
| `POST /v1/webhooks/monitor/:adapter` | 监控系统 | adapter 专属签名、指纹去重、默认只创建候选任务 |
| `POST /v1/tasks` | 人工/内部服务 | 校验 TaskEnvelope、权限和 revision 幂等 |

Webhook 成功接收返回 `202 { accepted: true, eventId }`。`202` 只表示持久化/入队，不表示已创建 PR 或任务成功。

### 3.2 查询与人工动作

| 方法与路径 | 说明 |
|---|---|
| `GET /v1/tasks/:taskId` | 返回规范化任务、当前 run 和安全的证据摘要 |
| `POST /v1/tasks/:taskId/approve` | 批准指定 revision、effect 和过期时间 |
| `POST /v1/runs/:runId/cancel` | 请求取消 active attempt 并撤销租约/token |
| `POST /v1/runs/:runId/retry` | 从最新有效 checkpoint 创建新 attempt |
| `POST /v1/runs/:runId/context` | 追加用户补充材料并生成新 revision |

批准请求必须包含：

```ts
type Approval = {
  revision: string;
  effects: Array<'repo_write' | 'test_deploy' | 'merge' | 'production_deploy'>;
  decision: 'approve' | 'reject';
  reason?: string;
  expiresAt: string;
};
```

过期、revision 不一致或审批人不在策略集合时返回 `policy_denied`。

### 3.3 Runner 入口

| 方法与路径 | 说明 |
|---|---|
| `POST /v1/attempts/:id/exchange` | 用 GitHub OIDC JWT 换 attempt token 和最小权限 context grant |
| `POST /v1/attempts/:id/heartbeat` | 延长租约，幂等 |
| `POST /v1/attempts/:id/events` | 追加结构化 step/tool/state event |
| `PUT /v1/attempts/:id/checkpoint` | 以 sequence compare-and-set 最新 checkpoint |
| `POST /v1/attempts/:id/evidence` | 追加验证证据 |
| `POST /v1/attempts/:id/complete` | 声明本 attempt 结果；控制面仍核对外部事实 |

`exchange` 必须验证 OIDC 的 issuer、audience、repository、workflow ref、SHA、run ID 和 attempt 绑定关系。返回的 token 生命周期不超过 attempt lease，且支持单独撤销。

## §4. GitHub dispatch 契约

目标 reusable workflow 只接收非敏感引用：

```json
{
  "schema_version": "1",
  "run_id": "run_...",
  "attempt_id": "att_...",
  "task_digest": "sha256:...",
  "control_plane_url": "https://delivery.example.com",
  "mode": "implement"
}
```

Runner 从控制面读取完整任务。dispatch 不包含飞书正文、tool-bridge SK、GitHub token、数据库 DSN 或云凭证。

Workflow 必须配置：

- 最小 `permissions`；默认 `contents: read`，需要推分支的 job 才临时获得 GitHub App token。
- `id-token: write` 仅用于 broker/OIDC 交换。
- 固定 `timeout-minutes` 和 `concurrency`。
- PR 使用目标仓库允许的 GitHub App 身份创建，避免 `GITHUB_TOKEN` 导致后续工作流不触发的语义差异。

## §5. ContextGrant

```ts
type ContextGrant = {
  runId: string;
  attemptId: string;
  toolBridgeBaseUrl: string;
  toolBridgeToken: string; // 只在 exchange 响应中出现一次
  expiresAt: string;
  scopes: Array<{
    path: string;
    actions: Array<'read' | 'call' | 'write'>;
    effect: 'read' | 'write' | 'destructive';
  }>;
};
```

- 分诊 attempt 默认只有 repo/log/trace/K8s 只读 scope；数据库默认只允许受限查询工具，不给原始 DSN。
- repo write 使用 GitHub App token，不通过 tool-bridge 绕过 GitHub 审计。
- 生产 K8s/数据库 write 不属于 MVP grant。
- 控制面保存 grant 的 scope 与 digest，不保存返回给 Runner 的明文 token。

## §6. Agent Adapter

```ts
interface AgentAdapter {
  start(input: AgentStartInput): Promise<AgentSession>;
  resume(input: AgentResumeInput): Promise<AgentSession>;
  interrupt(session: AgentSession, reason: string): Promise<void>;
  exportCheckpoint(session: AgentSession): Promise<AgentCheckpoint>;
}
```

`AgentCheckpoint v1`：

```ts
type AgentCheckpoint = {
  schemaVersion: '1';
  sequence: number;
  provider: string;
  providerSessionRef?: string;
  headBranch?: string;
  headSha?: string;
  completedAcceptanceCriteria: string[];
  evidenceRefs: string[];
  summary: string;
  nextStep: string;
  blockingReason?: string;
  workingTreeDigest?: string;
};
```

Checkpoint 不保存模型隐藏推理、Secret、完整数据库结果或未经脱敏的日志。恢复以 Git commit 为工作区真源；未提交的 diff 只能作为加密 artifact 的辅助恢复材料，并必须带 digest。

## §7. Evidence

```ts
type Evidence = {
  kind: 'test' | 'lint' | 'build' | 'commit' | 'pull_request' | 'check' | 'deployment' | 'approval';
  status: 'passed' | 'failed' | 'skipped';
  command?: string;
  exitCode?: number;
  sha?: string;
  url?: string;
  artifactDigest?: string;
  summary: string;
  observedAt: string;
};
```

规则：

- `passed` 测试必须有命令和退出码 0；只上传日志不能证明通过。
- `skipped` 必须说明原因，且不能满足 required DoD。
- PR 创建、check 成功、merge、deployment 成功分别由 GitHub webhook 核对。
- Agent 自报的 URL/状态在外部核对前标记 `unverified`（存储层字段）。

## §8. 飞书交互契约

卡片动作固定为 `approve_effects`、`reject`、`cancel_run`、`retry_run`、`add_context`、`take_over`。payload 只带 task/run/revision/action 和一次性 nonce；服务端根据飞书 open_id 重新解析组织身份和策略。

卡片至少展示：当前状态、任务 revision、目标 repo/base SHA、本 attempt 目标、最近 checkpoint、PR/check/deployment 链接、blocker、已批准 effect 与过期时间。

