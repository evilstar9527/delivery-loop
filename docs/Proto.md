# Proto

> 本文定义 delivery-loop 的规范性接口。字段新增优先保持向后兼容；破坏性变化必须提升 `schemaVersion`。示例中的 token 均为引用，不是可传输 Secret。

## §0. 通用约定

### 0.1 标识与时间

- `task_id`、`run_id`、`plan_id`、`plan_item_id`、`attempt_id` 由控制面生成，推荐 UUIDv7 或带稳定前缀的 UUIDv7；source revision intake 可用带前缀的 canonical identity digest 稳定派生 Task/Run ID，但 SQL source tuple 唯一约束仍是最终裁决。
- `run_id` 是一条交付链的 durable correlation root；HTTP `x-correlation-id` 只关联单次请求/错误，不能替代 `run_id`。Task、Attempt、tool trace、GitHub run、PR 和 deployment 必须通过受信 D1 lineage 回到唯一 Run。
- 外部平台 ID 作为字符串保存，不转成 JavaScript number。
- 时间为带时区的 RFC 3339；入库统一 UTC，展示按用户时区。
- 每个写请求带 `Idempotency-Key`；回调还必须带单调递增 `sequence`。

术语：`Control Workflow` 特指 Cloudflare `DeliveryRunWorkflow`，负责持久编排；`GitHub workflow/job` 特指运行一次 Agent Attempt 的 GitHub Actions 计算。本文单写 `Workflow` 时默认指前者。

### 0.2 摘要与敏感字段

- `*_digest` 使用 `sha256:<hex>`，对 canonical JSON 计算。
- Secret、OIDC JWT、tool-bridge SK、GitHub App private key 不得进入任务信封、dispatch payload、checkpoint、evidence 或 audit payload。
- 需要关联 Secret 时只保存 broker 内部 `secret_ref`。
- 输出边界使用 schema-aware redactor：敏感 header/字段按 key 整体替换，嵌套 JSON 递归处理，URL 的 userinfo/query value 被替换且 fragment 被移除，命令环境变量按 key/value 脱敏。
- 持久化或发布边界使用 canary/credential scanner；finding 只包含安全的 `path + kind`，不得包含命中值。命中已注册 Secret、GitHub token、JWT、Bearer token 或 private key 时 fail-closed。
- 客户端 `x-correlation-id` 只有符合 UUID 格式时才可传播；其他输入丢弃并由控制面生成 UUID，错误响应不能成为任意 header 的回显通道。

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
    | 'upstream_error'
    | 'timeout'
    | 'invalid_response'
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
  coordination?: {
    owner: { id: string; displayName?: string };
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
5. `task_digest` 覆盖规范化 revision 正文，但排除平台投递元数据 `eventId/occurredAt`；两者另用于 event 去重和审计，同 revision 的事件重投不能改变业务身份。

## §2. Run 与 Attempt

Run 状态以 `src/domain/run.ts` 为可执行真源。Attempt 形状：

```ts
type Attempt = {
  id: string;
  runId: string;
  planId?: string;
  planVersion?: number;
  planItemId?: string;
  ordinal: number;
  mode: 'analysis' | 'implement' | 'review_fix' | 'deploy';
  status:
    | 'pending'
    | 'starting'
    | 'running'
    | 'cancel_requested'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'lost';
  repository: string;
  workflowRef: string;
  githubRunId?: string;
  githubHeadSha?: string;
  githubStatus?: 'requested' | 'queued' | 'waiting' | 'in_progress' | 'completed';
  githubConclusion?: string;
  githubObservedAt?: string;
  githubExternalUpdatedAt?: string;
  githubObservationVersion: number;
  baseSha: string;
  headBranch?: string;
  headSha?: string;
  recoveredFromAttemptId?: string;
  recoveryCheckpointId?: string;
  version: number;
  leaseGeneration: number;
  leaseExpiresAt?: string;
  heartbeatAt?: string;
  result?: {
    eventId: string;
    sequence: 1;
    payloadRef: string;
    digest: string;
    reportedAt: string;
  };
  failureKind?:
    | 'dispatch_failed'
    | 'startup_failure'
    | 'timed_out'
    | 'runner_lost'
    | 'agent_failed'
    | 'policy_denied'
    | 'cancelled';
};
```

- 状态迁移必须 compare-and-set 当前 version；客户端不能提交任意 from/to。
- GitHub status/conclusion 是外部计算事实，不直接覆盖 Attempt/Run 业务状态；每次核对保存 `githubObservedAt`。
- 写租约领取使用 `attempt version + status` 条件更新；同一 Run 同一时刻最多一个未过期 write attempt，竞争失败返回 conflict，不能把零行更新当成功。
- 写操作和 heartbeat 同时校验 active attempt、当前 `version`、`leaseGeneration`、lease token digest 和有效期；过期接管递增 generation，旧 Runner 恢复网络后也不能继续写。D1 只保存 token digest，明文只交付给胜出的 Runner。
- `attempts.heartbeat_at`只表示最新值，不能证明30～60秒cadence。每个成功heartbeat还必须在同一D1 batch追加一条immutable `attempt_heartbeat_receipts`，只记录run/attempt/generation、前后Attempt version、前后heartbeat时间与90秒lease expiry；receipt不保存run/tool token或其digest。
- `failed` run 可在批准后重试；`succeeded` 与 `cancelled` 不可恢复。
- attempt 完成不等于 run 完成；PR、合并和部署结果由 webhook 再确认。
- 失败重试 scope 固定为 `run + mode + planId/planVersion/planItemId`；analysis、不同 Plan 版本或不同 Item 的失败不能互相累计。失败指纹由控制面基于该 scope digest 与受信 `failureCode + failureSite` 计算，Runner 不能提交 fingerprint。

## §3. ExecutionPlan v1（任务级 DoD）

`ExecutionPlan` 是 analysis attempt 的结构化产物，也是后续审批、调度和完成判定的输入。它不是 Agent 的临时 todo，也不是 `DOD.md` 的 Phase 验收清单。

```ts
type PlanEffect =
  | 'repo_read'
  | 'logs_read'
  | 'database_diagnostic'
  | 'repo_write'
  | 'test_deploy'
  | 'merge'
  | 'production_deploy';

type PlanItemV1 = {
  id: string;
  kind: 'investigation' | 'change' | 'verification' | 'delivery';
  title: string;
  objective: string;
  acceptanceCriteriaIndexes: number[];
  doneWhen: string[];
  verification: {
    commandRefs?: string[]; // 只能引用受信 delivery policy，不接受任务正文中的任意 shell
    evidenceKinds: Evidence['kind'][];
    externalFacts?: Array<'github_pr' | 'github_check' | 'deployment'>;
  };
  effects: PlanEffect[];
  dependsOn: string[];
  required: boolean;
};

type ExecutionPlanV1 = {
  schemaVersion: '1';
  id: string;
  runId: string;
  version: number;
  taskRevision: string;
  baseSha: string;
  createdByAttemptId: string;
  objective: string;
  assumptions: string[];
  evidenceRefs: string[];
  items: PlanItemV1[];
  digest: string; // 对除 status 外的不可变计划正文计算 canonical digest
  status: 'proposed' | 'validated' | 'approved' | 'active' | 'superseded' | 'completed' | 'blocked';
};

type PlanItemProgress = {
  planId: string;
  itemId: string;
  status: 'pending' | 'ready' | 'in_progress' | 'passed' | 'failed' | 'blocked' | 'skipped';
  activeAttemptId?: string;
  evidenceRefs: string[];
  version: number;
};
```

不变量：

1. 同一 Run 的 `version` 单调递增；`digest` 对除 status 外的不可变计划正文计算。计划正文、base SHA 或 effect 变化必须创建新版本，旧版本标为 `superseded`，不能原地改写。
2. Item ID 在 plan 内唯一，依赖必须存在且无环；每个 Item 至少一条 `doneWhen` 和一种 Evidence 要求。
3. `commandRefs` 必须由仓库受信 delivery policy 解析；Agent 输出只能提议，不能把自然语言变成任意 shell。
4. `effects` 不能超过 Task policy；涉及写/部署/merge 的计划在执行前必须有绑定 task revision、plan version/digest、base SHA 和 effect 的有效审批。
5. required Item 只有 Evidence 经控制面或外部 API 核对后才能 `passed`；`skipped` 不能满足 required Item。
6. Plan 内容不保存原始日志、数据库行、Secret 或完整 PRD；只保存脱敏摘要、受控引用和 digest。
7. 每条 Task acceptance criterion 必须至少被一个 `required` Item覆盖；把全部 Item或覆盖 Item改成 optional 不能通过 validation。
8. 每个 `change/repo_write` Item 必须验证其最终 commit head。MVP 首选一个 self-verifying `required change` Item：同时声明 `repo_write`、至少一个 `test:*`、至少一个受信 `verify:*`，且其 `evidenceKinds` 必须恰好为 `commit + test`、`externalFacts`必须为空；这两类是同一pre-PR execution Attempt实际产生并可由`PlanItemEvidenceVerifier`按attempt/item/head绑定的完整集合。`diagnostic/plan/lint/build/pull_request/check/deployment/approval`均没有该阶段的同Attempt producer，不能声明在可执行change Item上；其中diagnostic通过Plan级verified `evidenceRefs`绑定，Draft PR、GitHub check、自动review、approval和deployment由Item passed后的控制面阶段分别产生。任意“跳过测试”、optional/detached verification、仅 diagnostic Evidence、未来阶段Evidence/external fact或没有 commit-bound trusted verify 的 change 均在持久化前拒绝并返回固定`evidence_kind_not_producible`、`external_fact_not_producible`或既有验证码。
9. analysis Agent 的输出必须绑定本次 digest-verified context，不能只根据prompt路径生成无法关联本次输入的Plan。Runner把0600 `context.json`写成strict `{schemaVersion:'1', contextDigest, context}`完整性锚点：`contextDigest`是Runner预先对`JSON.stringify(context)`计算的SHA-256。Adapter在模型调用前解析文件、重算marker、限制完整envelope不超过256 KiB并扫描credential形状；Runner还以全部runtime Secret扫描控制面context。通过后，Adapter把完整strict envelope序列化为单个JSON对象，放进stdin的`BEGIN_UNTRUSTED_ANALYSIS_CONTEXT_JSON`/`END_UNTRUSTED_ANALYSIS_CONTEXT_JSON`明确不可信数据区块，不进入argv、日志、artifact、checkpoint或D1；正文中的换行和marker形状只作为JSON string转义内容。模型结束后Adapter再次读取同一文件、重算嵌套context digest并要求与调用前Runner-owned digest完全相等；调用期间被替换、篡改、失效或Secret命中全部在Plan validation/digest/API前fail-closed。requirement最终structured output仍使用strict `{contextDigest, plan}` envelope以兼容既有provider wire schema，但模型回显字段不授予authority、值被Runner忽略且不持久化；缺字段、格式非法或额外顶层字段仍由strict schema拒绝。Runner只把嵌套`plan`与当前调用内存中的可信identity/base/context绑定后交给后续边界。按owner产品裁决，Codex本地JSONL是否含`command_execution`与模型是否准确复制digest都不是接受条件，因为两者依赖模型行为而不是Runner安全边界；若出现只能作为非授权兼容字段或诊断遥测。该绑定证明Runner在同一调用前后持有未漂移的exact context envelope，不单独证明完整语义理解，Plan语义仍由validator、人审和Evidence核对。
   - 无revision source且无diagnostic mediation的fresh initial requirement若第一次proposal仅在上述Plan语义validator失败，可在同一Attempt内执行一次且仅一次纠正。第二次输入复用原context envelope，只追加去重排序的固定`ExecutionPlanValidationIssueCode[]`；不得包含旧Plan、issue path/message、raw error或模型输出。每轮必须有独立model reservation/usage，第二次仍由完整validator核对；第二次失败才产生原有terminal failure。diagnostic与Plan revision不使用此路径，避免重复日志/数据库读取或绕过既有恢复lineage。`requiresRepositoryChange=true`时，本地validator另接收Runner-owned `writableRepositoryPaths`：它只来自exact checkout tracked regular files，并已按exact base delivery policy去除protected/unsafe/symlink/仓库外及credential-shaped路径；self-verifying required change Item必须在`objective`或`doneWhen`完整逐字点名至少一个该path，否则新增固定issue code `repository_path_required`。Adapter在首次及纠正prompt中以`BEGIN/END_TRUSTED_WRITABLE_REPOSITORY_PATHS_JSON`包裹同一bounded JSON array，要求把文件名当data并复制exact entry；数组仍只来自Runner、不进入Plan wire/persistence，控制面继续重验其余Plan契约。
10. 控制面只从可信Task分类派生`requiresRepositoryChange`，不分析PRD/反馈正文关键词。`intent.kind`为`requirement|bug`且`policy.allowRepositoryWrite=true`时，当前试点policy把`repo_write`与受信`delivery.yaml`中的`test:unit/verify:all`加入Plan提议上限，并要求一个self-verifying required change Item；纯investigation、缺`test:*`、缺`verify:*`或缺`commit/test` Evidence均在Runner出网前和控制面持久化前拒绝。`allowRepositoryWrite=false`的requirement/bug仍可只读调查；writable bug仍必须先完成固定日志/trace根因诊断，不能因允许写跳过Evidence。这里的`repo_write`只是待人审effect提议，analysis grant、sandbox与GitHub token仍保持只读。试点command refs由代码常量与仓库根`delivery.yaml`漂移测试锁定；扩展到其他仓库前必须把同一可信policy observation纳入server-selected context，不能接受Task/Agent自报命令。

### 3.1 DiagnosticEvidence v1（bug analysis根因引用）

`POST /v1/attempts/:attemptId/diagnostic-evidence`只接受active `analysis + bug + planning` Attempt token：

```ts
type DiagnosticEvidenceV1 = {
  schemaVersion: '1';
  locatorKinds: Array<'uid' | 'cid' | 'path'>; // 固定顺序、至少一种
  locatorDigest: `sha256:${string}`;           // 不保存定位值
  rootCause: {
    summary: string;                           // 脱敏、Secret scan，不进operations投影
    confidence: 'low' | 'medium' | 'high';
    codeRefs: Array<{ path: string; line?: number; symbol?: string }>;
  };
  sourceTraceIds: string[];                    // 固定顺序，至少logs+request trace
};
```

控制面派生Evidence ID、`rootCauseDigest`和`evidenceDigest`，只在source trace全部属于同一Run/Attempt、effect=`read`、result=`success`且同时覆盖`logs/search`与`traces/get`时写`evidence(kind=diagnostic,status=passed,verification=verified)`。响应只返回Evidence ID/ref与digest。`GET /v1/runs/:runId/diagnostic-evidence`仅限operations身份，返回Task/active Plan lineage、diagnostic refs、digest及source trace metadata，不返回summary、locator值、tool arguments/result或错误正文。

bug Plan只要声明`logs_read` effect，就必须在`evidenceRefs`中精确引用同一analysis Attempt的verified diagnostic Evidence；不存在、失败、跨Run/Attempt或缺logs/trace source均返回conflict。通用ExecutionPlan仍可引用其他Evidence，但自由字符串不能冒充该根因绑定。

固定analysis Runner对`bug`使用四个、且仅四个受控structured-output阶段：Agent先从analysis stdin不可信JSON区块选择locator并输出`{schemaVersion, locatorKinds, arguments}`，Runner固定调用`logs/search`；成功结果经256 KiB与Secret扫描后，既写repo外0600临时完整性锚点，也作为单个JSON对象放进第2阶段stdin的`BEGIN_UNTRUSTED_DIAGNOSTIC_CONTEXT_JSON`/`END_UNTRUSTED_DIAGNOSTIC_CONTEXT_JSON`不可信区块，Agent只输出`traces/get`的`arguments`；logs+trace结果以相同边界进入第3阶段，Agent只输出strict `{schemaVersion, contextDigest, rootCause}`。Adapter完成root cause schema、Runner-owned context调用前后未漂移、runtime Secret验证和`finish`后，以只含净化root cause的0600内容覆盖原始diagnostic上下文；第4阶段只读取该净化结果，复用普通analysis schema输出strict `{contextDigest, plan}`。两个模型`contextDigest`都只是provider-wire兼容字段，其值被忽略且不持久化；authority来自Runner独立重算的context digest。第4阶段同时接收Runner从可信Task policy派生的`requiresRepositoryChange`约束：writable bug必须返回一个带`repo_write + test:* + verify:*`且`evidenceKinds`恰为`commit/test`的唯一self-verifying required change Item；当且仅当该Item唯一且形状完整时，可信Adapter把本次已成功完成的诊断确定性绑定为同一Item的`logs_read` effect，并把exact verified diagnostic ref注入Plan级`evidenceRefs`。diagnostic不是后续execution Attempt产生的Item Evidence，不能与commit/test并列阻止关门；该绑定也不能新增写权限、命令或修复语义。纯investigation、多候选或其他模糊Plan继续由既有validator/diagnostic shape gate拒绝；read-only bug不执行该绑定且不能提权。provider-facing JSON Schema只使用当前中转站已验证的可移植structured-output子集：每个object必须`additionalProperties:false`并把全部properties列入`required`，`schemaVersion`用`type:string + enum:['1']`，不得发送`const`、`propertyNames`、regex lookahead、开放object或`uniqueItems`。logs arguments wire固定为required `uid/cid/path`，未选择locator以空字符串表示；trace arguments固定为required `requestId`；root-cause code ref固定为required `path/line/symbol`，未知line用`0`、未知symbol用空字符串。Adapter在可信边界先验证selected/unselected locator与sentinel严格匹配，再只把已选择的非空locator交给既有tool request schema；code ref sentinel也先去除，再由原root-cause schema强制相对path且line或symbol至少一个有效。locator唯一性/固定顺序、参数shape、Plan交叉字段及Evidence binding仍在任何tool call或Plan写入前由Runner重验，wire兼容层不进入D1且不改变领域schema版本。Agent不能选择tool path/scope/effect、不能接触attempt/tool token，也不能填写`diagnostic_*` Evidence ref。Runner分别对两次arguments和两次result做schema、大小及runtime Secret/credential shape扫描；正文不进入argv、日志、artifact、checkpoint或D1。固定调用必须严格是`logs/search → traces/get → root cause → Plan`，每阶段至多一次，总timeout仍受单个analysis Attempt上限约束。

第3阶段前，可信Runner从已经过Secret扫描的logs/trace安全结果中提取最多100个有界字符串候选，并只在exact checkout的Git tracked源码中查找精确行。`AnalysisSourceSnapshotV1`只接受仓库内regular、非symlink、UTF-8源码：最多2,000个tracked文件、单文件256 KiB、累计16 MiB、内部1,000个匹配，按candidate长度、生产源码优先级、path和line确定性排序后最多输出8条/12 KiB，每条excerpt不超过1,000 bytes；snapshot再以全部runtime Secret扫描。root-cause codeRef必须命中snapshot的exact path，并以相同行号或同excerpt中的symbol完成绑定；空codeRefs、HTTP/绝对/父级path、未入snapshot位置或Secret命中均在`finish`和Evidence前拒绝。snapshot只进入临时不可信模型上下文，不持久化、不成为Evidence authority；无法构建时固定为`context_proof_invalid/diagnostic_root_cause`，模型返回不受支持位置时固定为`structured_output_invalid/diagnostic_root_cause`。

四次真实Codex调用分别建立、结算独立model reservation/usage，不能把四轮合并成一条usage。两次tool call使用心跳轮换后的当前tool token，并与heartbeat通过进程内fencing lock串行，避免旧token竞态。Agent完成后Runner先重验Plan、root cause与Git workspace不变，再以两次arguments的canonical digest和控制面返回的两个tool trace ID创建Evidence；只有控制面返回的Evidence/root-cause digest与本地计算完全一致时，Runner才把exact Evidence ref注入Plan、重算Plan digest并提交。任一tool失败、越序/重复调用、Agent自填ref、Secret结果或workspace变化都在Evidence/Plan写入前失败；Evidence成功后发生的控制面Plan冲突保留该未引用Evidence作为失败审计，不反向删除。

`base_update`对可写bug有一个窄化的Evidence继承路径。analysis context只能从该revision冻结的`prior_plan_id`读取prior Plan的diagnostic ref，并联结同Run的`diagnostic_evidence_bindings`、prior Plan `created_by_attempt_id`、`passed + verified` Evidence及成功的`logs/search + traces/get` source；恰好一条完整lineage时才返回strict optional `carriedDiagnosticEvidenceRef`，缺失、重复、stale、unverified、跨Run/Attempt或非prior Plan引用均fail-closed。Runner不把该ref放入Agent context，不创建diagnostic mediation或新Evidence，只预留/结算一次普通只读模型调用，让Agent检查新base；Agent输出若自填任意diagnostic ref即拒绝。模型外Runner只在唯一self-verifying required change Item上确定性补齐`logs_read` effect，并把控制面给出的exact ref追加到Plan级`evidenceRefs`，保持该执行Item的Evidence恰为`commit/test`，随后重算digest并重新validate；`POST .../plan`再从D1独立重算同一carried lineage，不能信任Runner回传。fresh bug、review/supplemental revision和不满足可写条件的bug仍走既有路径，不能借base更新跳过首次诊断或提升effect。

### 3.2 DeliveryPolicy v1（仓库交付契约）

目标仓库根目录的 `delivery.yaml` 是 setup、测试、验证、受保护路径和部署能力的唯一仓库级声明。控制面只读取 dispatch 已绑定的 40 位 `baseSha` 上的 blob，即固定执行 `git show <baseSha>:delivery.yaml`；当前工作树、Task 正文、Agent 输出或 PR 分支中的同名文件都不能覆盖本轮 policy。

```yaml
schemaVersion: '1'
commands:
  setup:
    install: { argv: [pnpm, install, --frozen-lockfile], timeoutSeconds: 600 }
  targeted:
    unit: { argv: [pnpm, run, test:unit], timeoutSeconds: 300 }
  verify:
    all: { argv: [pnpm, run, verify], timeoutSeconds: 1200 }
  acceptance:
    smoke: { argv: [pnpm, run, acceptance:test], timeoutSeconds: 300 }
protectedPaths: [delivery.yaml, .github/workflows/**, CODEOWNERS]
deployment:
  mode: github_actions
  test:
    workflowPath: .github/workflows/delivery-test-deploy.yml
    environment: test
    oidcAudience: delivery-loop-test-deploy
    roleRef: test:delivery-loop-deployer
    command: { argv: [pnpm, run, deploy:test], timeoutSeconds: 900 }
    verifyCommandRef: verify:all
    acceptanceCommandRef: acceptance:smoke
    rollback:
      workflowPath: .github/workflows/delivery-test-rollback.yml
      environment: test
      oidcAudience: delivery-loop-test-rollback
      roleRef: test:delivery-loop-rollback
      automaticOn: [deployment_failure, acceptance_failure]
      command: { argv: [pnpm, run, rollback:test], timeoutSeconds: 600 }
```

不变量：

1. setup/targeted/verify为非空命名map，acceptance为可选非空命名map；每条命令只允许 `argv[] + timeoutSeconds`，不接受 shell 字符串、stdin、调用时追加参数或环境变量。稳定引用分别为 `setup:<id>`、`test:<id>`、`verify:<id>`、`acceptance:<id>`；Runner在执行边界重新解析引用并以`shell:false`启动。`acceptance:*`只供部署后的独立verification Item使用，不能替代change后的pre-deploy required test/verify。
2. policy 最大 64 KiB，strict schema 拒绝 YAML alias/merge、重复 key、未知字段、NUL、路径穿越和非法绝对路径。解析后的对象递归冻结，canonical SHA-256 digest 与 `baseSha` 一起进入后续 Plan/Evidence 绑定。
3. `protectedPaths` 至少声明并保护 `delivery.yaml`、`.github/workflows/**` 和 `CODEOWNERS`；额外高风险路径可由仓库追加。Runner还固定保护任意层级的CODEOWNERS、`.env*`/`.dev.vars*`/常见secrets文件、Wrangler、Docker Compose、Terraform及常见K8s/Helm/deploy目录，不能靠目标仓库删减policy条目绕过。受保护路径声明本身不授予修改权限，命中后的暂停/审批由独立policy gate执行。
4. `deployment.mode` 只能是 `none`，或 `github_actions` 并显式声明至少一个 `test`/`production` target。每个 target 固定环境专属workflow path、同名 GitHub Environment、专属OIDC audience、`<environment>:*` role ref、结构化deployment command和已声明的`verify:<id>`；test target还必须声明已存在的`acceptance:<id>`。它是部署/验收contract，不是部署批准。deployment command不进入Agent Plan command refs，也不能由Task/Agent在调用时覆盖。
5. test target可选声明strict rollback contract：workflow/environment/audience固定为test专属值，role必须是与deploy role不同的`test:*`，`automaticOn`只能从`deployment_failure|acceptance_failure`中去重选择，command仍是结构化argv。未声明trigger即零自动回滚。production target不接受rollback字段；生产自动回滚需独立审批契约，不能由test声明升级权限。
6. analysis validator 的 allowed command refs 来自该 commit-bound policy；执行阶段只向 `DeliveryCommandRunner` 提交 canonical ref。任务正文中的 `pnpm ...`、`sh -c ...`、ref suffix 或未知 ref 均不得进入命令 runtime。rollback command也不进入Plan command refs，只能由verified failure + exact-SHA contract的专用scheduler选择。

### 3.3 Plan Item ready 与 Attempt 领取

首次执行 Attempt 只能由控制面 scheduler 创建，遵循以下状态与并发契约：

1. Plan 激活时所有 Item 为 `pending`。scheduler 只在 Run 为 `executing`、`expectedRunVersion` 命中、Plan 是 Run 的 exact active version 且状态为 `active` 时，把所有依赖均为 `passed` 的 `pending` Item 以 CAS 晋升为 `ready`；无依赖的根 Item 可直接晋升。
2. 领取请求 strict schema 只有 `runId + expectedRunVersion + planVersion + planItemId + expectedProgressVersion`。只有 `ready + exact progress version + activeAttemptId=null` 且执行前重新核对全部依赖仍为 `passed` 的 Item，才能领取；`repo_write` Item还必须在同一SQL边界重新核对Task policy及exact latest approval未过期、未失效且没有更新reject。
3. Attempt ID 由 `run/plan/version/item/claimedProgressVersion` canonical digest稳定派生；D1另以相同五元组唯一约束。`implement`领取在一个D1 batch中同时创建`pending` Attempt、把Item变为`in_progress`并写唯一`execution_dispatch` outbox，稳定identity分别为Attempt ID、`outbox_execution_<attemptId>`和`execution-dispatch:<attemptId>`；相同领取并发或重放收敛到同一组记录，零行CAS、缺outbox或不同绑定不得当成成功。`deploy`领取不创建该Actions outbox，继续由专用deployment producer接线。
4. Attempt mode由受信Plan effect派生：包含测试/生产部署effect才为`deploy`，其余首次Item Attempt为`implement`；repository、base SHA和固定workflow ref来自D1 Run/Task，不接受领取调用者自报。
5. Runner/Agent API没有Plan Item status字段，strict schema拒绝夹带`passed/skipped`。Agent complete/failure只是待核对事实，不能直接改变Item进度；`passed`只允许后续控制面Evidence verifier写入。
6. D1 trigger禁止任何required Item以及所有`investigation/verification` Item进入`skipped`。依赖只能由真实`passed`满足，`skipped`、Agent自报、Attempt completed或旧Plan状态均不解锁下游Item。
7. lost Attempt恢复不重新领取或跳过Item：progress保持`in_progress`，recovery只在旧Runner/Workflow完成fencing后以CAS替换同Item的`activeAttemptId`。
8. 每分钟的有界execution reconciler只从D1真源推进主链：exact `repo_write` approval使`awaiting_approval → executing`，随后promote/claim唯一self-verifying change Item；候选`limit`只能在Item shape、依赖、Task policy及当前approval expiry/reject/invalidation全部过滤后生效，历史无可领取Item或审批已失效的`executing` Run不得占满批次并永久饿死较新Run。为抵抗Free-plan scheduled 10ms CPU fence，Cron在recovery serving fence后立即激活/领取最多1个exact已批准候选并先relay其durable dispatch；该D1-only入口不读取R2/外部事实，仍由原SQL/CAS重验全部approval与effect。之后才执行Workflow direct-drain、review recovery、at-risk GitHub观察、Evidence finalization、Plan revision、剩余relay和原有完整scheduling；priority relay包含Workflow root且与direct-drain/Queue重复命中由原lease收敛。GitHub `completed/success`与同Attempt/Plan/Item/head的completed suite同时成立后，它为每条`doneWhen`提交完整Evidence mapping。全部required Item经decision变为`passed`后才CAS到`verifying`、准备immutable Draft PR并创建唯一publication/outbox；Cron在新的完整scheduling或外部scan前先恢复最多1条尚无publication的valid prepared snapshot，直接复用D1 snapshot并由publication store重验exact approval，不重读R2或重渲染正文。只有该恢复数为0时才运行最多1条完整finalization。任一步的陈旧scan或并发重放均由下层CAS、stable identity和唯一约束吸收，不重复Attempt、Evidence、Draft或publication。

### 3.4 ExecutionPlan revision

review、补充上下文或base observation要求改变Plan时，替换流程必须满足：

1. revision调用不接受自然语言正文、任意Plan body或caller自报外部事实。上游adapter写immutable `plan_revision_source_facts={run, expectedRunVersion, priorPlan/version/digest, sourceKind, sourceRef, sourceDigest, requestedBaseSha}`；`review_feedback/supplemental_context/base_update`的ref前缀固定，其中review ref只允许`d1://github-review-feedbacks/<id>`或`d1://automated-reviews/<id>`；source fact不存在或任一binding不符时零状态变化；
2. 真人GitHub review producer在签名exact-head review落库时冻结`expectedRunVersion`；自动review producer则冻结exact verified publication/head、result/body digest、completed time和唯一fix lineage。只有恰好一条`review_feedback_attempts`或`automated_review_fix_attempts`、不存在另一种review lineage且没有`attempt_repairs`的active `review_fix`，可调用`POST /v1/attempts/:attemptId/plan-revision`；strict body只有`expectedVersion + leaseGeneration`。控制面从对应D1 lineage派生review source ref/digest并从Run派生base；自动结果在re-analysis时还必须从私有R2重读并重算schema/metadata/result/body digest。caller夹带ref/digest/base/effect/Plan body、stale head/Run/Plan/fencing、混合lineage均拒绝且零source fact；20路相同请求最多创建一份source/revision/analysis dispatch；
3. GitHub base producer不是caller API。scheduled adapter以独立`contents:read` installation token读取exact`refs/heads/<Task baseBranch>`；只有head不同后再调用compare，且`status=ahead/aheadBy>0/behindBy=0/baseCommit=mergeBase=Run.baseSha`才产生strict `GitHubBaseObservationFact`。控制面由fact canonical派生`d1://github-base-observations/<id>`与source digest，并把immutable observation、source fact和begin放进同一D1 batch；unchanged、behind/diverged、malformed response、stale Run/Plan/repo/branch均零source fact；
4. supplemental producer只接受完整新`TaskEnvelope`、正文与`applyToCurrentRun`选择；新Task必须与prior revision保持source tuple、target、intent kind和policy上限一致。正文与Task先Secret scan再写内容寻址私有R2，D1只存ref/digest/lineage。默认创建独立`queued`新Run且旧Run零变化；显式apply必须绑定旧Task revision、Run version、Plan version/digest/base，在一个D1 batch把新Run置`cancelled`、其workflow-create intent置`settled/supplemental_context_absorbed`，并写context lineage、`supplemental_context` source fact和旧Run begin；
5. `begin` strict绑定`expectedRunVersion + activePlanVersion/digest + source fact + requestedBaseSha`。stable identity与SQL unique使20路重放只创建一个pending analysis Attempt和`analysis_dispatch`。Run由允许的pre-merge状态CAS回`planning/version+1`，同batch取消旧Plan active Attempt、提升generation、撤销run/tool token、标记write credential待撤销、supersede protected gate并settle旧execution/PR intent；revision的初始`analysis_attempt_id`保持immutable；
6. 所有绑定旧Plan的approval都写入独立`approval_invalidations`，原approval行仍不可变。repo credential issuance/active check、PR scheduler/effect、review projector和controlled replay均把invalidated approval视为无效；新Plan即使effect集合相同也必须重新审批；
7. replacement仍由analysis Attempt产出并通过同一`ExecutionPlan` schema/DAG/criterion/command/effect/base/digest validator。若当前revision analysis Attempt已记录trusted failure、尚未产生Plan、Run仍为`planning`且无active blocker，并且未达到通用Attempt上限或重复fingerprint上限，Cron在relay前通过immutable `plan_revision_analysis_retries`创建唯一后继analysis Attempt与唯一dispatch；20路调度重放收敛。初始Attempt快照不改写，context、Plan持久化、activation与安全查询只接受retry lineage中最新的当前Attempt；已有proposal、陈旧revision、blocked Run或已消费failure均零重试。`version = prior + 1`且`createdByAttemptId`必须等于该当前Attempt。每个analysis Attempt独立从callback `sequence=1`开始；signal以`(runId,eventId)`定址、以`(runId,attemptId,sequence)`去重，不能用Run级sequence拒绝合法replan completion。控制面从规范化Plan表重新计算semantic body与effect digests；body/base/effect三者均未变化时把proposal置`superseded`、revision置`rejected`并恢复旧Plan的`awaiting_approval`安全门，重放稳定返回`no_change`，不留下卡死的planning Run；
8. activation以D1 batch先把旧active Plan置`superseded`，再把validated replacement置`active`，最后CAS Run到`awaiting_approval/version+1`并完成analysis Attempt。若validated replacement、Attempt result projection与exact durable signal已经落D1，但长期Workflow已越过initial analysis wait或callback响应丢失，scheduled reconciler必须在外部扫描前从这三份完整绑定恢复同一activation；不得重复模型调用、继承旧审批或信任GitHub Action自报。`no_change`是已持久化的安全终态，不得令Cron失败。Run的activePlan ID/version/digest/base必须全等于新Plan；旧Item progress/checkpoint/Evidence保留审计但不进入新Plan；
9. migration trigger禁止UPDATE ExecutionPlan identity/objective及所有规范化Item/doneWhen/dependency/effect/verification关系；status只允许proposed→validated/approved/active及active→superseded/completed/blocked等单调边。`GET /v1/runs/:id/plan`的`run.planRevision`只显示source kind/digest、旧/新Plan refs、requested base、change flags和时间，不返回R2 source ref或正文。active Plan安全投影额外返回`assumptionCount`、`evidenceRefCount`、有序Evidence ref数组的canonical digest，以及每个Item的acceptance criteria索引；不返回assumption或Evidence ref原值，真实analysis verifier据此证明refs非空并核对完整Item结构。

当前本地GitHub review producer/Runner reporter、GitHub base refs+compare scheduled producer、supplemental Task revision producer与三类digest-verified analysis source均已接通；真实飞书/Meegle身份事件、GitHub API/Actions/Workflow re-analysis和新审批仍属后续穿透，完成前不能把本地workerd/fake HTTP冒充外部E2E。

## §4. 控制面 API

### 4.1 外部事件入口

| 方法与路径 | 调用者 | 义务 |
|---|---|---|
| `POST /v1/webhooks/feishu` | 飞书 | challenge、签名/加密校验、event ID 去重、快速入队 |
| `POST /v1/webhooks/github` | GitHub App | `X-Hub-Signature-256`、delivery ID 去重、只接收白名单事件 |
| `POST /v1/webhooks/monitor/:adapter` | 监控系统 | adapter 专属签名、服务端指纹抑制、只创建独立triage candidate |
| `POST /v1/tasks` | 人工/内部服务 | Bearer 服务认证；校验 TaskEnvelope、`Idempotency-Key`、权限和 revision 幂等 |

飞书入口配置要求`FEISHU_APP_ID + FEISHU_DELIVERY_TENANT_KEY`及至少一个事件来源Secret；推荐同时配置`FEISHU_EVENT_ENCRYPT_KEY + FEISHU_EVENT_VERIFICATION_TOKEN`。加密请求必须在256 KiB以内并带`X-Lark-Request-Timestamp/Nonce/Signature`；signature对exact raw body计算，timestamp与控制面时间差最多300秒，随后才以`SHA-256(encrypt key)`和密文前16字节IV做AES-256-CBC解密。challenge只接受`url_verification + 1..512字符challenge`，verification token命中后返回`200 {challenge}`且不写库。

非challenge事件必须是v2 `header + event`，`header.event_id/event_type/create_time/app_id/tenant_key`合法，app/tenant与Worker配置完全相同。成功返回`200 {accepted:true,eventId,disposition:'created'|'duplicate'}`；这里只表示metadata receipt和stable ingress outbox已在同一D1 batch发布，不表示Task已规范化。`feishu_webhook_nonces`记录每个已认证transport nonce digest，`feishu_webhook_deliveries`按tenant+event ID收敛业务事件；相同event重新加密/换nonce仍为duplicate，同nonce换event或同event换canonical内容返回409。两表不保存raw/encrypted/decrypted body、token或encrypt key。错误签名/token/过期timestamp返回401，错误tenant/app返回403，配置不完整返回503，并且全部发生在任何receipt/Task/Run/outbox写入前。明文token模式只保留为受控兼容路径，缺所有来源校验配置必须503而不是匿名接收。

`GET /v1/operations/feishu-webhook/evidence?tenantKey=<exact>&eventId=<exact>`只接受operations bearer token且拒绝额外/重复query。响应固定为`{schemaVersion,tenantKey,eventId,counts,delivery,ingress}`：counts仅含deliveries/nonces/ingressOutboxes/tasks/runs/outboxEffects；delivery/ingress仅投影安全ID、event/app/type、verification mode、request/event digest、时间、状态和可空Task/Run ID。不存在时返回全零与两个null，不返回raw/encrypted/decrypted body、token/key/nonce、Task正文、R2 ref或任意SQL列。

`GET /v1/operations/feishu-ingress/evidence?tenantKey=<exact>&eventId=<exact>`同样只接受operations bearer token和exact query。响应只含delivery、按request time排序的transport receipt digest、ingress relay/settlement标量、Queue message ID digest/attempt/time、Task source tuple/revision/digest、Run/workflow instance和唯一workflow-create outbox安全投影及计数；不返回nonce/digest、Queue原始message ID/body、Task正文、R2 ref、lease、token或SQL行。

`feishu_ingress_outbox`以verified delivery稳定派生，一event只有一行。Cron用5分钟D1 lease claim `pending/expired delivering`后向专用`FEISHU_INGRESS_QUEUE`发送`{outboxId}`；send明确失败只把同一行退pending，成功写enqueued。Queue consumer必须使用Cloudflare提供的immutable `message.id/timestamp/attempts`：原始ID只在内存中canonical hash，`feishu_ingress_queue_observations`按`queue + message digest + attempt`唯一追加，并与queued状态更新放入同一D1 batch。相同message/attempt重放不新增行；同logical message后续attempt从1连续留痕。Queue at-least-once消息不是exactly-once证明：相同event重放3次的判据是一份D1 outbox和一个逻辑Queue message identity；平台产生新message identity时真实证据必须显式失败，不能用outbox自报掩盖。DLQ写固定terminal code，不复制event body。

飞书/Meegle normalizer完成字段映射后调用内部`FeishuNormalizedTaskStore`，不是新增匿名HTTP入口。sink只领取`queued + queueObserved`outbox，重新绑定accepted receipt、exact event ID/tenant，且Task source只能是`feishu|meego`；Task先过Secret scanner并写content-addressed私有`TASK_OBJECTS`，随后直接复用`TaskIntakeStore`的`(source system, tenant, task key, revision)`唯一身份和Task/Run/workflow-create事务。不同event的TaskEnvelope若只在event ID/occurredAt不同而source revision业务snapshot相同，会settle到同一Task/Run；同revision更换正文/policy/target仍是revision conflict，不能因event不同创建第二Run。若Task已发布但ingress settle中断，重试同identity后补settle，不删除Task或创建补偿Run。

Meegle adapter先把上游读协议投影为strict `MeegleWorkItemSnapshotV1`，而不是把raw API响应直接当Task。snapshot固定event/tenant/project/type/work-item/revision/updated time、可空URL、基础title/description、actor、普通`fields[]`、独立`roles[]`、`fieldsComplete`和`nextPageToken`；field/role key必须唯一。`fields=["_all"]`只要仍有`nextPageToken`，即使第一页包含所需字段也视为`source_fields_incomplete`。受信`MeegleTaskMappingProfileV1`按tenant+project+type绑定owner role key、acceptance field key、repository field key、kind/base/environment/default priority和repository allowlist；profile由控制面配置，工作项正文不能提交profile、policy或effect。

完整映射固定`source.system='meego'`、`taskKey=<project>/<type>/<id>`；Meegle角色owner写`coordination.owner`，GitHub仓库字段经allowlist后拆成`target.owner/repo`，两种owner语义不得混用。markdown checklist或string-array规范化为acceptance criteria；初始policy固定repository/test/production write全false、human approval为true。缺title/description/acceptance/owner/repository/revision，owner多值、repo非法，或全量字段分页未结束时不构造TaskEnvelope，而是写`meegle_triage_candidates(status='triaging')`与固定gap code。D1只保存source/profile identity、digest、gap和lineage；exact snapshot正文经Secret scan后进入私有content-addressed R2。20路同snapshot/profile/ingress收敛为一候选、一lineage且零Task/Run/effect；两个event映射同一完整source revision则继续复用normalized sink收敛为一Task/Run。

每个处理后的Meegle ingress还必须追加一条immutable `meegle_mapping_lineage`：绑定exact event/source/revision、exact/mapping snapshot digest、profile version/digest及其三个受控field/role key、R2 ref、分页布尔/count和`mapped|triaging`结果。mapped行绑定Task/Run且gaps为空；triaging行绑定candidate且Task/Run为空。normalized sink成功而lineage insert前中断时，同一ingress重试先复用既有Task/Run再补lineage，不能创建补偿Run。`GET /v1/operations/meegle/evidence?tenantKey=<exact>&eventId=<exact>`只接受operations身份和exact query；服务端有界回读隐藏的R2 ref、解析strict snapshot并重算exact digest，响应只返回验证布尔、digest、source/profile key、分页/count、owner count、repo分类、固定gap与Task/Run/workflow-create标量，不返回正文、field value、principal、cursor、R2 ref或raw API。

真实验收固定`MeegleWorkItemEvidenceManifestV1`与`pnpm run e2e:meegle-work-item`。CLI profile及tenant/project/type由运行环境独立配置并与manifest exact绑定，manifest不能选择其他本机profile。verifier执行Meegle CLI 1.0.16的`meta-fields/meta-roles`和五次`workitem get fields=["_all"]`，使用argv数组、`shell:false`、`--auto-paginate --envelope`；`truncated`、`stopped_reason`或剩余cursor全部fail closed。分页未完成负向case由原始D1/R2 lineage证明`fieldsComplete=false + hasNextPageToken=true`，验收时live CLI仍必须完成当前重读，不能故意截断CLI来伪造gap。完整步骤见[Meegle工作项映射与triaging真实验收](MeegleWorkItemE2E.md)。

generic monitor adapter是可选入口；`MONITOR_WEBHOOK_SECRET + MONITOR_TENANT_KEY + MONITOR_ALLOWED_REPOSITORIES`必须一起配置，缺省全部时关闭、部分配置或非法配置固定503。`MONITOR_SUPPRESSION_WINDOW_SECONDS`只能由受信Worker配置设置为60～86400秒，缺省直接沿用Watt `476e3cd`的24小时dedupe窗口；body无权选择窗口。请求最大256 KiB，`X-Delivery-Loop-Monitor-Signature`的值固定为`sha256=<64 lowercase hex>`，使用Watt exact-body HMAC-SHA256与常量时间比较；验签失败在JSON解析和任何持久化前401。

monitor body strict固定为`schemaVersion/eventId/occurredAt/status='firing'/alert`；alert只有`ruleId/resourceKey/repository/environment/severity/title/description`。`fingerprint/policy/effect/Task/approval`无schema入口。repository必须命中受信allowlist，occurredAt最多过去24小时、未来5分钟，完整规范化snapshot写R2前扫描当前Worker Secret。服务端fingerprint由adapter/tenant/profile digest及rule/resource/repository/environment/severity计算，排除event ID、时间和展示正文；caller不能提交或覆盖。

每个新event的immutable `monitor_alert_receipts`与fingerprint suppression head、`monitor_alert_candidates(status='triaging')`和event→candidate lineage由`MonitorAlertIngressStore`在同一D1 atomic batch中发布；不依赖包含多语句body、Wrangler远程migration路径无法可靠安装的SQLite projection trigger。沿用Watt inclusive语义：`receivedAt <= suppressionExpiresAt`合并同candidate并递增occurrence，1毫秒越界才创建新candidate；相同event重放不重复计数，同event换canonical snapshot返回409。candidate没有policy/effect/Task/Run字段，monitor入口物理上不写`tasks/runs/approvals/outbox`；验签成功也不自动获得repo write。normalized alert正文只在私有`TASK_OBJECTS/monitor-alerts/`中，D1和查询只有安全ID、digest、repository/rule/severity、窗口与计数。

真实验收固定Sentry作为v1 native provider：独立observer先按官方`Sentry-Hook-Signature`对exact body做HMAC-SHA256验证，再投影strict generic body并用独立monitor Secret重签；observer不直接写D1，原生payload/header也不成为authority。`GET /v1/operations/monitor-alert/evidence?tenantKey=<exact>&eventId=<exact>`只接受operations bearer与exact query；它联查immutable receipt/lineage/candidate及零Task/Run/approval/outbox计数，再从不对外返回的R2 ref有界回读strict snapshot，重算exact/resource/fingerprint digest和custom metadata。响应只给安全ID、ordinal/suppressed、受控mapping、candidate count/time及`objectPresent/objectVerified`，不返回title/description/resource、任何digest、R2 ref或SQL行。启用/明确不启用的外部步骤见[monitor adapter真实外部证据验收](MonitorAlertE2E.md)。

其他Webhook成功接收返回 `202 { accepted: true, eventId }`。`202` 只表示持久化/入队，不表示已创建 PR 或任务成功。

人工 Task intake 的 body 只有 `TaskEnvelope v1`，成功返回
`202 { accepted: true, taskId, runId }` 并指向同一持久化 Task/Run。相同 `Idempotency-Key`
与相同 canonical request 可安全重放；同 key 更换 request 返回 `409 conflict`，不得创建第二套业务记录。
Idempotency key 仅保存 digest，不写日志或 R2。规范化 Task 正文写受控 R2，D1/Workflow 只持有引用与
digest。intake 不信任客户端提供 base SHA；manual intake在Secret扫描后先按key/request digest读取既有
idempotency projection，同一已完成请求不再依赖GitHub可用性。只有新请求才用repository-scoped、
`contents:read`的GitHub App installation token读取exact `refs/heads/<Task baseBranch>`，严格要求对象类型为
commit且SHA为40位小写hex，并在第一次D1/R2写入前把该SHA传给`TaskIntakeStore`固定到Run。配置缺失、
repository未授权、ref不存在或响应非法统一返回安全的`503 unavailable`且Task/Run/outbox/R2为零；caller没有
base SHA字段，不能用Task正文或请求参数覆盖该事实。
Task schema 校验后、计算 identity 或写 D1/R2 前，控制面必须扫描当前 Worker 已配置 Secret 与常见
credential 形状；命中返回固定 `policy_denied`，响应与 finding 不包含原始值，也不得留下部分业务记录。

试点fresh manual intake的固定Actions operator只接受`workflow_dispatch.task_json`作为不可信输入，但job不得把
`${{ inputs.task_json }}`映射到step环境。preflight只从GitHub runner提供的`GITHUB_EVENT_PATH`读取最多256 KiB
event并运行同一Task schema；Environment gate后的唯一effect job再从同一文件解析正文。operator按Task source
revision派生确定性Task/Run与`analysis-<run>-1`，先要求Task GET恰好404，再用独立`actions:read` token以
`per_page=50`、最多20页完整分页；不跟随GitHub可能把owner/repo改写为numeric repository的`Link` URL，
只使用每页稳定`total_count`和本地固定endpoint单调递增`page`
固定`delivery-agent.yml`并要求stable title计数为0，随后最多一次`POST /v1/tasks`。POST使用确定性
`Idempotency-Key`，只接受202且响应Task/Run必须等于本地派生值；任何已存在事实、不完整分页、重定向、超时、
非202或响应漂移都固定失败且不重试。stdout只允许Task/Run/Attempt ID、Task revision digest和0/1计数，不含正文。

`GET /v1/operations/github-base/readiness?repository=<owner/repo>&baseBranch=<branch>`是人工
intake前的只读诊断，不是Task入口。它只接受用途隔离的`OPERATIONS_TOKEN`，query必须恰好各出现一次
`repository/baseBranch`且拒绝额外字段、重复字段、非法仓库名、`..`或双斜线branch；全部响应
`Cache-Control: no-store`。实现必须调用当前Worker实际使用的GitHub App resolver，因而在同一条调用链验证
private key可加载、repository-scoped `contents:read` installation token可签发、exact branch ref可读取并解析。
成功固定返回`{schemaVersion:'1',ready:true,repository,baseBranch,baseSha}`，其中SHA是40位小写hex；失败为
`503 unavailable`并只增加`ready:false + reason`。reason只能是`configuration_unavailable`、兼容兜底
`credential_unavailable`、十个GitHub App固定凭证阶段`credential_signing_unavailable|credential_auth_rejected|
credential_unauthenticated|credential_forbidden|credential_installation_not_found|credential_policy_rejected|credential_request_invalid|
credential_transport_unavailable|credential_upstream_unavailable|credential_response_invalid`，或`reference_unavailable|reference_invalid`。
`credential_auth_rejected`只保留给历史兼容；真实App provider把PEM解析/import/JWT签名、installation-token的401、403、404、422、
显式Request构造拒绝、收到HTTP响应前的transport失败、5xx以及unexpected status/非法201响应分别映射到其余九类；
所有production GitHub REST请求都显式发送固定`User-Agent: delivery-loop-control-plane`，覆盖installation-token签发/撤销、base ref/compare、
Action查询与dispatch，不能依赖Node等运行时自动补头；缺失或非法User-Agent会被GitHub以403拒绝。控制面所有GitHub REST客户端的
默认fetch还必须通过`globalThis.fetch(input, init)`包装执行，不能捕获全局函数后以client实例作为foreign receiver调用；显式注入的测试adapter保持原值。
只有非受信provider异常继续折叠到兼容兜底，不能读取任意error.code透传。响应、错误和日志不得包含App JWT、
private key、installation token、上游body、HTTP正文或raw异常。探针没有D1/R2/Task/Run/outbox/Workflow/Action写入路径；
`200 ready`只证明调用时的read链路，不授予Task POST、GitHub dispatch或production deploy权限，也不能替代
对应外部DoD证据。

真实App provider的installation-token POST固定10秒timeout并使用`redirect=manual`取得但不跟随3xx；所有非201（包括3xx）不读取body并fail-closed。发送前用同一URL/options显式构造`Request`：构造拒绝只返回`credential_request_invalid`且网络attempt为0；构造成功后必须把同一个已验证的`Request`对象直接交给fetch，不得再次传入URL/options解析`RequestInit`；production默认fetch必须以`globalThis`为receiver调用，不能以provider实例作为foreign Web API receiver。每次credential request至多发送一次，
transport失败后不得自动重试这个可能已到达GitHub的非幂等POST。fetch在HTTP响应前拒绝时，对外reason仍只有
`credential_transport_unavailable`；同一catch只读取最多四层allowlisted `name/code/cause`元数据，复用caller的
`request_timed_out|dns_failed|tcp_failed|tls_failed|request_failed`分类并经唯一安全结构化sink输出一条
`github_app_installation_token_transport_failed`。该记录只含固定operation/failureKind/requestAttempts，不含repository、
URL、App/installation ID、JWT/key/token、raw message/cause/body。诊断sink失败必须被折叠，不能改变固定credential stage、
触发第二次请求或影响业务状态。

仓库内一次性caller `ops:github-base-readiness`默认在读取配置或网络前exit 2；显式opt-in后只接受HTTPS
control-plane origin、exact repository/baseBranch和用途隔离operations token。每个probe实例把attempt flag置位后才
调用一次上述GET，第二次调用在fetch前拒绝；请求固定10秒timeout、拒绝redirect，响应限1 MiB、拒绝分页并在
JSON parse前扫描token和credential形状。caller只接受exact `200 ready`或上述固定reason的exact `503 unavailable` shape，
并要求`Cache-Control: no-store`；其他status/body/header一律固定拒绝且不读取非预期HTTP正文。fetch失败只检查
错误对象的allowlisted `name/code/cause`，映射为`request_timed_out|dns_failed|tcp_failed|tls_failed|request_failed`，
不输出raw message/cause。caller分类只解释本次客户端transport，不是Worker readiness事实，也不产生自动重试、
Task、repair、Secret rotation、deployment或rollback authority。

### 4.2 查询与人工动作

| 方法与路径 | 说明 |
|---|---|
| `GET /v1/tasks/:taskId` | 返回规范化任务、当前 run 和安全的证据摘要 |
| `GET /v1/runs/:runId/plan` | 返回当前计划、Item progress 和 Evidence 安全摘要 |
| `GET /v1/correlations?kind=...&id=...` | 从受信标识反查唯一Run及Task/Attempt/GitHub run/PR/deployment/tool trace安全投影 |
| `GET /v1/dead-letters?status=...&limit=...` | operations身份查询D1 dead-letter安全投影 |
| `GET /v1/triage/meegle?limit=...` | operations身份列出Meegle `triaging`候选的source metadata、固定gap与lineage count；不返回工作项正文、R2 ref或principal |
| `GET /v1/triage/monitor?limit=...` | operations身份列出monitor `triaging` candidate的adapter/tenant/repository/rule/severity、窗口、occurrence与lineage count；不返回title/description/resource、fingerprint/profile/snapshot digest或R2 ref |
| `GET /v1/operations/monitor-alert/evidence?tenantKey=...&eventId=...` | operations身份按exact monitor event读取安全receipt/lineage/candidate、受控mapping、零authority计数和服务端R2 snapshot验证布尔；不返回正文/resource/digest/ref |
| `GET /v1/operations/github-base/readiness?repository=...&baseBranch=...` | operations身份通过当前Worker GitHub App凭证只读解析exact branch SHA；仅返回安全阶段枚举且零业务写入 |
| `POST /v1/dead-letters/:deadLetterId/replay` | operations身份以exact outbox attempt count受控重放原effect intent |
| `POST /v1/runs/:runId/items/:itemId/verify` | 服务端核对逐doneWhen Evidence并原子关闭required Item；Agent token不可调用 |
| `POST /v1/runs/:runId/pull-request-draft` | 从当前Task/Plan/head/verified Evidence生成不可变Draft PR正文快照；只生成发布输入，不代表GitHub PR已创建 |
| `POST /v1/runs/:runId/pull-request` | 为exact prepared正文创建一个fenced GitHub Draft PR publication/outbox；调用方不能提交PR URL/number/status |
| `POST /v1/runs/:runId/approve` | 批准指定 task/plan/base 快照、effect 和过期时间 |
| `POST /v1/runs/:runId/quota-overrides` | approval adapter为P0 Run提交身份绑定、限时且固定2倍的资源override decision |
| `POST /v1/runs/:runId/cancel` | 请求取消 active attempt 并撤销租约/token |
| `POST /v1/runs/:runId/retry` | 从最新有效 checkpoint 创建一个待审批/待派发的 replacement Attempt |
| `POST /v1/runs/:runId/replay` | 管理员从稳定 Workflow step/Plan Item 受控重跑；先核对版本、副作用和审批 |
| `POST /v1/runs/:runId/context` | 追加用户补充材料并生成新 revision |
| `POST /v1/attempts/:attemptId/plan-revision` | 仅exact GitHub review Runner提交Attempt fencing；服务端派生source fact并启动immutable re-analysis，body不得含Plan/ref/base/effect |

`POST /v1/runs/:runId/context`当前是飞书/Meegle adapter调用的内部服务入口，使用控制面Bearer认证；它不替代未来的飞书验签、open_id/tenant授权或卡片nonce校验。body是以下strict union，路径`runId`提供prior/current Run身份，不能在body中另选Run：

```ts
type SupplementalContextRequest = {
  schemaVersion: '1';
  task: TaskEnvelopeV1; // source revision必须变化，target/policy上限不得变化
  context: string;
} & (
  | { applyToCurrentRun: false }
  | {
      applyToCurrentRun: true;
      currentRun: {
        expectedRunVersion: number;
        taskRevision: string;
        planVersion: number;
        planDigest: string;
        baseSha: string;
      };
    }
);
```

- `applyToCurrentRun=false`返回新Task/Run，Run为`queued`且workflow-create intent为`pending`；prior Run的state/version、Attempt/token、approval和outbox必须逐项不变；
- `applyToCurrentRun=true`不会留下第二条可执行链：新Task仍完整留档，但其新Run固定`cancelled/version=1`且workflow-create intent已settled；旧Run只通过一份immutable Plan revision重分析。相同请求的并发或顺序重放返回同一IDs，`created=false`；
- body没有source ref/digest、base/effect或Plan字段；额外字段400。Secret、同revision改写、stale prior child、policy扩权、旧Run/Plan/base binding均在Task/source fact前拒绝。完整context和Task只在私有R2，D1 lineage没有正文列。

Phase 1 的两个 GET 查询与人工 intake 共用控制面 Bearer 服务认证，后续替换为组织身份；匿名请求 fail-closed。查询只读 D1 业务投影，不调用 Workflow `status()`，也不读取 R2 中的 Task/checkpoint/evidence 正文：

- Task 响应只返回 source/target/intent 标量投影、policy、digest 和当前 Run state/version/active Plan ref，不返回 description、原始 acceptance criteria、actor 或 R2 ref；Run因高风险路径暂停时可附带D1白名单化的`approvalRequest`，只含路径、变更类型、行数、base/tree/policy/diff digest与绑定ID；
- Plan 响应返回当前 Plan/Item progress、Attempt 状态、安全的`headBranch/headSha`，以及每个 Attempt 最新 checkpoint 的 sequence/plan/head/digest 元数据；verified Draft PR存在当前 active Plan/version 的自动review lineage时，额外返回最新一轮的安全投影`automatedReview={iteration,status,blockingFindingCount?,minorFindingCount?}`，其中`iteration`仅为1～3，`status`仅为`pending|changes_requested|approved|blocked`，计数仅为非负安全整数；不存在 verified publication 或 lineage 时省略该字段。replacement Attempt附带`recovery={recoveredFromAttemptId,checkpointId}`，repair Attempt附带`repair={id,failureId,failedAttemptId,sourceSuiteId,sourceEvidenceId}`，passed Item可附带`verificationDecision={id,headSha,evidenceSetDigest,evidenceIds,doneWhenEvidence,verifiedAt}`，但不返回 checkpoint summary、nextStep、payload ref、lease token digest或Evidence正文；
- Task/Run响应可附带最近20条`stuckIncidents`安全投影，只含incident/run version、状态类别、可选Attempt ID、threshold/action、open/resolved时间与固定resolution code；不含Task正文、raw error、外部payload或token；
- Evidence 响应只返回 kind/status、受信 command ref、exit code、durationMs、SHA、artifact digest、verification status 和净化后的 HTTPS URL；不返回 summary、artifact ref、命令输出或 URL query/fragment。尚无 active Plan 时返回 `plan: null` 和稳定空数组，而不是借 Workflow 状态猜测业务状态。
- Task/Run响应的`quota`只返回checked time、20条effective limits（scope/resource/window/used/base/effective limit及可选override ID）、最近20条override/denial和最近20次模型usage标量。它不返回scope key、prompt、Agent/thread/tool内容、tool arguments/result、模型response、credential或raw error；scope key只以digest进入denial ledger。

P0 quota override接口复用独立`APPROVAL_ADAPTER_TOKEN`，但该服务凭证只证明调用者是已验签adapter，不是人的批准。strict body为：

```ts
type QuotaOverrideRequestV1 = {
  schemaVersion: '1';
  expectedRunVersion: number;
  decision: 'approve' | 'reject';
  resources: Array<
    'concurrency' | 'attempt' | 'model_tokens' |
    'model_cost_microusd' | 'tool_call'
  >; // 非空、唯一
  reasonDigest: `sha256:${string}`;
  expiresAt: string; // future且最长4小时
  source: {
    schemaVersion: '1';
    provider: 'github' | 'feishu';
    tenantKey: string;
    externalEventId: string;
    externalSubject: string;
    eventDigest: `sha256:${string}`;
    occurredAt: string;
  };
};
```

控制面从path解析Run并从D1派生priority/task actor/tenant/repository/current version；只有P0、exact version、验签source所属channel解析出的独立human以及live`approve:quota_override` role可产生`approved`。self、agent/service、未授权和tenant/repository不匹配也写immutable `identity_rejected` outcome；非P0和stale version在任何authority产生前拒绝。批准只对列出的资源生效、multiplier固定2、最长4小时，不接受caller自报scope key/limit/multiplier/used/cost/model或reason正文。

关联查询同样使用控制面Bearer认证并返回`Cache-Control: no-store`。query只允许且各出现一次`kind/id/repository`；`kind`为`task/run/attempt/trace/github_run/github_pr/test_deployment/production_deployment/github_deployment/test_acceptance/test_rollback`。GitHub PR number与GitHub deployment ID必须同时提供`owner/repo` scope，其他kind禁止repository；外部数字ID保持字符串。未知参数、非法ID或scope返回固定400且不回显原始query；无记录404；同一外部标识若跨Run冲突则fail-closed，不能任选一条。

`GET /v1/correlations`只读由authoritative tables组成的D1 views，不新增producer写放大，也不读取Workflow history或R2正文。成功响应`schemaVersion=1`，以`correlationId=run_id`返回Task/Run、Attempts、GitHub runs、PR、test/production deployments与tool traces；每类最多200条并显式给出`truncated`。只公开ID、枚举状态、SHA、duration、Evidence ID和已移除query/fragment的HTTPS链接，不公开Task/PR正文、payload/artifact ref、token、raw response或错误。成功查询同时输出一条`event=correlation_lookup`白名单结构化日志，包含Run/Task及各类ID（每类最多50个）和计数可推导数组，不含URL或自由文本。

dead-letter API只接受独立`OPERATIONS_TOKEN`，不能用Task intake、Runner或approval token替代。GET query只允许单个`status=open|replay_requested|resolved`和`limit=1..100`并返回`no-store`；响应不含Queue body、outbox payload ref、Task正文、token或raw error。POST strict body为`{expectedOutboxAttemptCount, reasonCode}`，其中reason为`operator_retry|upstream_recovered|configuration_fixed`固定枚举；body没有outbox/kind/destination/payload/effect/actor字段。

主Queue消费失败调用message retry，Cloudflare配置在3次retry耗尽后转`delivery-loop-workflow-outbox-dlq`。DLQ consumer只接受exact `{outboxId}`和安全message ID/attempt count，回查D1后写immutable dead-letter snapshot再ack；畸形/已删除outbox为无效毒丸ack，D1暂时失败继续retry。open dead letter通过relay/router/processor三层检查冻结原outbox。Replay以dead-letter、当前outbox attempt count和固定operations actor CAS，只创建一个immutable replay ledger，把原outbox恢复pending并清过期lease；不创建第二条outbox或复制payload。相同请求3次返回同一replay ID，后续Queue重复仍由原processor的lease、业务binding和外部API reconciliation收敛；outbox settled后scheduled reconciler把dead letter置resolved。

Draft PR正文准备接口使用控制面Bearer服务认证，Agent run token不可调用；strict body和成功响应为：

```ts
type PreparePullRequestDraftRequest = {
  expectedRunVersion: number;
  planVersion: number;
  planDigest: string;
  headSha: string;
};

type PullRequestDraftSnapshot = {
  draftId: string;
  created: boolean;
  status: 'prepared';
  runId: string;
  planId: string;
  planVersion: number;
  headSha: string;
  branch: string;
  bodyDigest: string;
  body: string;
};
```

- 调用方不能提交正文、验收状态、变更摘要、风险、测试结论或回滚文案。控制面只在Run为`verifying`、expected version与exact active Plan/digest命中、最新`implement/review_fix` Attempt已完成、bot head transition与commit Evidence一致、没有protected path gate时生成快照；任一绑定变化返回`409 conflict`。
- 所有required Item必须已有`passed`的`plan_item_verifications`，每条Task acceptance criterion必须被这些required Item覆盖并至少关联一条verified passed Evidence；测试列表只来自同Plan与final head上completed suite中的verified passed test Evidence。optional未完成Item保留真实状态并显式列出，不能伪装为完成。
- 正文固定包含来源Task/revision、Plan、final branch/head、变更摘要、验收标准逐条状态与Evidence ID、风险、测试command/exit/duration/head、未完成项和回滚说明。变更摘要来自不可变Plan目标与已通过Item，不读取Agent自由文本总结、Evidence summary/output或Task description；回滚说明根据Plan是否声明deploy effect由服务端派生。
- renderer把Task/Plan自然语言按惰性文本处理，转义Markdown/HTML与`@mention`；来源URL只接受无userinfo的HTTP(S)，发布时移除query/fragment并编码Markdown括号。输入与最终Markdown都执行统一Secret scanner，命中返回`403`且不写快照；UTF-8正文上限65,536 bytes，超限返回`413`。
- `draftId`由`run + plan/version + final head + body digest`稳定派生；D1保存正文、digest及验收/Evidence/未完成Item的规范化不可变snapshot。20路相同请求只创建一份并返回相同正文；这只是后续GitHub PR producer的durable input，不能推进`pull_request_open`，也不能替代PR webhook/API外部核对。

Draft PR publication接口同样只接受控制面Bearer服务认证，Agent token不可调用：

```ts
type SchedulePullRequestPublicationRequest = {
  expectedRunVersion: number;
  draftId: string;
};

type PullRequestPublication = {
  publicationId: string;
  outboxId: string;
  runId: string;
  draftId: string;
  status: 'pending' | 'created_unverified' | 'verified';
  created: boolean;
};
```

- scheduler重新核对`verifying` Run/version、prepared draft的Task/active Plan/digest/final head、最新completed implement/review_fix Attempt、required Item状态、protected gate、Task repo-write policy与exact最新`repo_write` approval；过期/reject/旧Plan/head不能创建publication。prepared snapshot已经包含从R2 Task与verified Evidence确定性生成并扫描过的正文，因此Cron中断恢复只读取D1 selector并调用同一scheduler，不重新读取R2或重渲染正文。20路同请求以stable identity、`UNIQUE(draft_id)`和outbox dedupe收敛为一份`pull_request + github_api` intent，不递增Run version。
- Queue consumer复用共享pending→delivering→settled lease/fencing；effect前再次核对Run/Plan/draft/head/approval，并检查是否出现更新的reject。GitHub App token按单仓库收窄且只有`pull_requests:write`，不带Actions、contents write、deploy或admin权限；token只在Worker内存和Authorization header中。
- REST adapter先以`state=all + owner:head branch`查询既有PR。exact same-repo head/base/title/body digest/draft/open/head SHA全部一致才复用；已关闭、正文漂移、多结果或任一binding不符均fail-closed，不能创建第二份。不存在时固定调用`POST /repos/{owner}/{repo}/pulls`，body只有server-derived title、prepared body、exact head/base、`draft:true`、`maintainer_can_modify:false`。
- POST 201或既有PR查询结果只把publication置`created_unverified`并保存候选number/净化HTTPS URL；它们不能写verified Evidence、不能改变Run。网络/201响应不确定时outbox回pending，下轮先按stable head reconciliation，避免重复POST。
- `X-GitHub-Event: pull_request`的`opened` webhook先对raw body做HMAC-SHA256，再以delivery ID + raw digest去重；只接受same-repo、open Draft、exact title/body digest/head branch/head SHA/base branch和无userinfo/query/fragment的HTTPS URL。签名正确但binding不符只记ignored，不推进状态；同delivery换payload冲突。
- exact webhook fact以一个D1 batch写`pull_request` verified Evidence、publication外部观察版本，并把Run从exact`verifying/version` CAS到`pull_request_open/version+1`。Agent自报URL/number/status没有任何projector入口。scheduled API reconciliation只轮询已取得number、尚未verified、Run仍为`verifying`且`runs.version = publication.run_version`的publication；该资格在批次limit前过滤，并由按ID加载再次校验，stale publication不调用GitHub、不返回batch结果也不阻塞较新的eligible publication。GET响应必须通过同一个fact projector；API observation仅修复漏失webhook，不建立第二套状态机。同一Cron必须等待该PR reconciliation结束后才能启动base observation；禁止两者并发竞争Run version并把稳定API observation固化为`ignored/observation_race`。

GitHub review feedback契约：

- `X-GitHub-Event: pull_request_review`只处理签名后的`action=submitted + review.state=changes_requested`。schema要求非空body、review ID、`commit_id`、安全review URL、`submitted_at`、PR number/head/base/repository，且`review.commit_id = pull_request.head.sha`；其他action/state安全ack ignored；
- projector再把repository/PR number/base/head branch绑定verified publication，并以该branch最新immutable `attempt_head_updates`的head作为控制面当前事实。review commit不是当前head时只写reference-only ignored delivery，不写R2、不创建Attempt；同delivery换raw digest冲突，同review ID改写body/head/branch冲突；
- feedback body是不可信数据。命中Worker配置Secret或credential形状时返回固定403，响应不回显，D1/R2/Attempt均零写入。通过后完整规范化payload写私有`TASK_OBJECTS/review-feedback/...`；D1 `github_review_feedbacks`只保存R2 ref/body digest、review ID、head/branch、安全URL/time及Plan lineage，没有自由文本body列；
- exact review以一个D1 batch把Run从`pull_request_open/version`依合法边推进`awaiting_review/version+1 → executing/version+2`，把原`passed` Item以新progress version重开为`in_progress`，创建唯一pending `review_fix` Attempt、`review_feedback_attempts` lineage和`execution_dispatch` outbox。旧verification decision/Evidence保持不可变；20路同review收敛为一次applied与其余duplicate；
- scheduled API compensation只扫描`pull_request_open + verified publication`，使用用途隔离的单仓库`pull_requests:read` token重新绑定open PR的repository/base/head branch和当前head SHA，再从最多99条非分页review中按reviewer选当前head最新状态。只有最新状态仍为`CHANGES_REQUESTED`且body/URL/time合法时，才以稳定API delivery identity调用同一feedback projector；API与webhook并发仍由同一review ID、Run/Plan/Item CAS和唯一Attempt/outbox收敛；
- feedback同时冻结完成上述迁移后的expected replan Run version；任何其他Run迁移都会使该review decision stale，不能由endpoint重新读取“新当前版本”绕过fence；
- review Attempt的checkout SHA等于reviewed head，`head_branch`在commit前仍为null，但受信target是lineage中的原PR branch。它不伪造`attempt_repairs`或测试失败；review feedback与verification repair必须恰好存在一种。
- Git writer的Task/Attempt identity边界与控制面统一为1～200个受限字符，并继续对最终派生branch执行240字符Git-safe校验；因此稳定`attempt_review_<52 hex>` identity可更新原PR branch，但超长Task+Attempt组合仍在任何Git effect前拒绝。
- pre-effect review recovery只接受`lost + github completed/non-success`的direct review Attempt，要求active Plan/Item仍绑定该Attempt、source head不变、write credential无issuing/active/revoking状态，并且不存在head update、verification suite、attempt failure或既有replacement。Run可处于原`executing`，或处于由同一Attempt的resolved `attempt_fenced` incident直接产生的紧邻`blocked`版本；后者还必须零active blocker且stable Workflow cancel已经settled。单一D1 batch创建带`recovered_from_attempt_id`的pending `review_fix`、必要时恢复Run为`executing`、切换Item activeAttempt并写新dedupe dispatch；dispatcher和context通过该一跳引用读取原immutable review lineage，旧Attempt、incident、cancel和feedback不UPDATE/DELETE。

自动 review 契约：

- Cron只从`pull_request_open + verified publication`选择当前active Plan下最新completed `implement|review_fix`的immutable head；publication repository/base/head branch、latest head update、passed required Item、零protected gate/blocker及恰好一个未过期且未失效的`repo_write` approval必须同时成立。20路调度以`publication + source head`和stable identity收敛为一条`automated_reviews`、一个`mode=analysis` Attempt及一个`analysis_dispatch` outbox；旧head或已审head零新Attempt。
- `GET /v1/attempts/:id/context`对该analysis Attempt返回strict `kind=automated_review`，只包含Attempt/PR/head、Task revision/digest及受控正文、active Plan和被审change Item。Task仍从私有R2回读并重验metadata/schema/canonical digest；响应`no-store`。review Attempt的`base_sha`与被审PR head相等，不能由Agent或dispatch payload覆盖。
- Runner使用既有OIDC exchange、active lease/heartbeat和model reservation/usage账本，但Codex固定`--ephemeral --sandbox read-only + approval_policy=never + project_doc_max_bytes=0`；review前后工作区snapshot必须相等。provider-wire JSON Schema遵守strict Structured Outputs约束：finding的`severity/title/body/path/line`全部列入`required`，无定位时`path/line`必须显式为`null`；Adapter只在provider边界把这两个`null`规范化为内部可选字段，再以`AutomatedReviewResultV1`严格校验。结果必须逐字绑定控制面计算的context digest；`blocker|major`与`changes_requested`必须一致，最多20条finding，Agent不能提交approval、head、effect或状态。provider进程失败必须保留固定`failureKind/failureStage/providerFailureCode`，不能因结构化日志契约再次抛错而覆盖原分类。
- `POST /v1/attempts/:id/automated-review-result`只接受active exact Attempt token。结果先做runtime Secret扫描，再以内容寻址key写私有`TASK_OBJECTS/automated-reviews/...`；D1只保存ref、result/feedback digest、blocking/minor计数和immutable lineage，不保存summary/finding/body。它属于review/context对象并进入既有备份边界，不得以明文写入只允许AES-256-GCM transcript的`RAW_AGENT_OBJECTS`。D1 batch完成review Attempt、撤销token并写终态；原token只允许同digest只读重放，换结果冲突。
- 零`blocker|major`（包含minor-only）把review标记`approved`且不创建write Attempt。前两轮存在blocking finding时，控制面重新核对same Run/Plan/Item/head与exact approval，以同一batch把passed Item重开、Run推进executing、创建唯一`review_fix`及`execution_dispatch`；execution context从私有R2复核结果并只把渲染后的blocking feedback作为不可信`reviewFeedback`交给既有Runner。`reviewFeedback.reviewId`只接受GitHub真人review的纯数字ID，或与producer共享schema的`automated_review_<52 lowercase hex>`稳定ID；其他字符串在credential/model/Git effect前拒绝。human review、verification repair、base rebase与automated review fix四种source必须恰好一个。自动review fix若返回strict `request_replan`，Runner在任何commit/push/verification前调用同一fenced Plan revision API；服务端只从自动review immutable lineage派生source，重新分析时把渲染后的blocking feedback作为review revision data并再次核验R2。Plan revision admission失败只产生固定`unknown_failure/external_reconciliation`，不得把HTTP/raw错误写日志或冒充已replan。
- automated review fix只能在原PR branch从source head non-force fast-forward；新的head update、targeted→required Evidence及Item decision全部通过后，scheduled reconciler把Run恢复`pull_request_open`并针对新head创建下一轮只读review。第三轮仍有blocking finding时不创建第四个Attempt，而是写稳定`attempt_limit` blocker，把Run/Plan/Item置blocked并调度唯一Workflow cancel。
- merge gate对当前publication/head存在的自动review lineage强制要求terminal `approved`；`pending|changes_requested|blocked`统一按`review_insufficient`拒绝，最终passed evaluation的SQL再次重验，避免观察与决策之间状态漂移。Cron先调度自动review、再运行merge/base读取，因此正常fresh链路不会在首轮review前越过闸门；历史上尚无该lineage的Run保持兼容。

GitHub base observation契约：

- scheduled reconciler只选择active pre-merge/blocked Run，要求Run base、active Plan base、Task repository/base branch完全一致；merging/deploying/终态不查询GitHub。同一Run/active Plan/version只要存在`automated_reviews.status IN ('pending','changes_requested')`，batch候选与按Run ID直查都必须在任何GitHub调用前返回无候选，且不得创建base observation/Plan revision或改变Run/Plan/review；自动review与同PR review_fix循环达到`approved|blocked`终态后才恢复base扫描。候选超过单轮上限时，以epoch minute和固定limit计算循环offset，先取有序尾段再从头补齐；`unchanged`不写业务状态也不能让最老一批永久占满扫描窗口；
- base token与Actions dispatch、PR publication、repo-write token用途隔离，installation request只有目标repository和`permissions:{contents:'read'}`；token仅进入Authorization header；
- ref响应必须是exact `refs/heads/<baseBranch>`与commit SHA。head未变直接`unchanged`且零D1事实；变化后compare响应必须把old SHA绑定为base commit；只有merge base也等于old、ahead大于0且behind为0才创建Plan source。behind/diverged/identical或异常merge-base改为strict non-fast-forward fact，不得伪装成fast-forward；
- fast-forward fact只保存repo/branch/before/after/ahead count与ref/compare canonical digests，不保存REST body/token。`github_base_observations`、`plan_revision_source_facts`、revision/Attempt/outbox及旧执行fencing同batch；20路查询可重复外部read，但业务状态只推进一次。
- non-fast-forward fact还绑定ahead/behind、merge-base和两份canonical响应digest。`github_base_conflicts`按Run/version与before/after唯一且UPDATE trigger拒绝改写；首次消费在同一D1 batch把active Plan与Run置blocked、保持Run base为before SHA、取消active Attempt并提升generation、撤销token/写credential/旧approval、settle旧analysis/execution/PR intent并创建稳定`workflow_cancel`。并发或顺序重放均返回blocked，不产生`plan_revision_source_facts`或GitHub写effect；
- approval失效读取统一经过`invalidated_approvals`视图，它合并Plan revision、base history conflict与base rebase content conflict三个append-only ledger。credential、PR publication、review、replay等消费者不得只检查其中一张表；
- `BaseRebaseRunner`的输入只接受可信Runner提供的absolute repo、Task/source/target Attempt identity、exact source branch/head、old/new base、parsed delivery policy与targeted refs。old base必须同时是new base和source head的ancestor，source范围必须非空、线性且author/committer都是固定bot；target固定为新Attempt派生branch；
- `BaseRebaseAttemptReconciler`只扫描`executing` Run上的activated `base_update` revision，且change flags必须exact为`body=false/base=true/effects=false`。旧同ID required verification Item必须已由`plan_item_verifications`绑定completed source Attempt/head，source branch必须等于旧Attempt派生branch；新Item必须ready、依赖passed并声明repo-write、test Evidence及targeted/required refs；新Plan exact repo-write approval必须未过期、未失效且是latest decision；
- 任一`pull_request_publications`已使用source branch时自动rebase不适用。其余候选在同一D1 batch创建stable `base_rebase_attempts`、以new base为`base_sha`且source head为`head_sha`的pending `review_fix` Attempt、占用Item并写`execution_dispatch`。dispatch仍只含IDs/digests/SHA，fixed workflow从new base ref加载受信代码/policy，并checkout source SHA；execution context要求repair/review/baseRebase三种source恰好一个；
- base rebase bootstrap不调用Codex Agent。它先用本地exact source SHA物化受信source ref，再执行trusted setup与`BaseRebaseRunner`。rebase固定禁用hooks、GPG signing与autostash，本体不执行push/force；成功后核对new base ancestry、commit数量、线性bot identity及source patch equivalence。受信callback仅把新Attempt派生branch用现有writer执行non-force push，并用`POST .../head`记录source head→rebased head；D1 head前进后才运行targeted→全部required verify；
- `POST /v1/attempts/:id/base-rebase/complete` strict只接受current fencing、rebased head与suite ID。只有同Attempt/generation/Plan/Item/head的immutable head transition及所有command passed的completed suite才把lineage置passed；它不自行关闭Plan Item，最终仍由逐doneWhen Evidence verifier裁决；
- 冲突必须成功`rebase --abort`后才返回`content_conflict`，source ref不变、target保持source head、零head/Evidence/push。`POST .../base-rebase/conflict` strict body只有fencing+固定reason；控制面原子把lineage/Run/Plan/Item置blocked，取消Attempt并提升generation、写reference-only revocation audit、撤销token/write credential、失效新Plan approval、settle旧execution/PR intent并创建唯一Workflow cancel。若提交后HTTP响应丢失，endpoint只允许同一已撤销token、原expected version与lease generation读取相同`created:false`终态，不能恢复任何写能力；错误token或不同fencing仍按鉴权失败。相同Git冲突重放稳定，query只返回SHA/branch/Attempt ID与固定`manual_rebase`提示，不返回冲突文件、Git stdout/stderr或patch；

GitHub merge eligibility契约：

- scheduled reconciler只扫描`pull_request_open/awaiting_review`且具有verified publication和active Plan的Run。GitHub token独立缓存并只申请`contents/checks/statuses/pull_requests:read`；它不复用Actions、PR-write或repo-write credential；
- adapter依次读取exact PR、base ref、active branch rules、head latest check-runs、combined commit statuses与reviews。PR repo/number/head/base branch必须与publication一致；base ref与PR base分别保留SHA。branch rules规范化为required context+integration ID集合及最大required approval count；没有required check或required review policy不是“零要求”，而是`policy_unavailable`并fail-closed；
- check-run只有completed且conclusion为success/neutral/skipped才算passed；legacy status只有success算passed。missing、queued/in-progress、failure/error分别形成bounded状态，不能用GitHub aggregate文字或Agent自报覆盖。review只计算当前head commit上每个actor的最新状态；changes requested优先，旧head approval不计，复杂CODEOWNER/last-push/thread规则仍由GitHub `merge_state`的blocked事实兜底；
- `github_merge_gate_observations`保存fact digest、repo/PR、PR作者login、head/base、mergeability、review/check计数和policy/check/review digest，逐required check进入immutable normalized rows；不保存REST body、review正文、token或错误。相同publication/Run version/fact并发收敛；
- `MergeGateStore`重新绑定current Run version、active Plan/base/digest、verified publication、最新completed bot branch head、全部required Item passed、Plan含merge effect和latest exact merge approval。高风险approval还必须来自`trusted_effect_approvals`，当前approver/author渠道映射可解析、approver仍有`human + approve:merge`且principal不同；approval reject、身份失效、自批、统一invalidation命中或`expiresAt <= now`不得回退复用更旧批准。最终D1 INSERT/CAS再次检查全部observation gate和approval条件，不能只信进程内预检；
- 只有全部gate通过才写passed evaluation/decision并把Run `pull_request_open|awaiting_review → ready_to_merge/version+1`。rejected evaluation只记录固定reason：`required_checks_incomplete|required_checks_failed|review_insufficient|base_not_latest|head_not_latest|approval_required|approval_identity_unresolved|self_approval_denied|policy_unavailable|mergeability_unavailable`；任何结果都不创建merge outbox。实际merge、merging状态和外部merge SHA属于后续独立producer/projector；
- 当前MVP没有自动merge producer。签名`pull_request closed`只有`merged=true + 40位merge_commit_sha + merged_at/merged_by`才进入merge projector；closed-but-unmerged直接ignored。projector要求Run当前为`ready_to_merge`，latest passed decision满足`decision.runVersion + 1 = Run.version`，并重新绑定active Plan/digest、verified publication、repo/PR、head branch/SHA、base branch和安全PR URL；gate前、旧head或任一漂移不得写merge结果。
- `github_merges`以Run/decision/publication/repo/PR/head/merge SHA稳定派生，保存ready时Run version、base/merge SHA、merged actor/time、deployment disposition和verified Evidence ref；同Run、decision、publication、repo/PR与repo/merge SHA均唯一且整行immutable。HMAC webhook与scheduled只读PR API补偿共用projector，不保存raw payload/REST/token；GitHub后续只改变PR `updated_at`但merge core不变时仍收敛到同一merge。
- merge gate 外部验收使用 strict `MergeGateEvidenceManifestV1`：manifest 至少包含一条 ready case 和五条拒绝 case（required checks incomplete/failed、review insufficient、base not latest、approval required），每条绑定 Run version、完整 normalized fact、observation/evaluation/decision、approval（如有）和 `noMergeEffect={mergeOutboxes:0,merges:0}`。`pnpm run e2e:merge-gate` 先核对 Case 8 的 `checks.mergeGates`，再通过同一只读 GitHub adapter 重算 PR/base/rules/checks/statuses/reviews；manifest 不能覆盖 live fact，raw response、PR/review body 和 token 没有序列化入口。
- merge projector先CAS `ready_to_merge → merging`，再按Task/Plan可信快照走一条合法边。no-deploy要求`target_environment=none`且无deploy authority/effect并进入`succeeded`；test target要求`allow_test_deploy + test_deploy effect`，且merge gate已证明包括deployment与acceptance在内的全部required Item passed，因此merge后进入`succeeded`；production target要求`allow_production_deploy + production_deploy effect`并进入`deploying`等待merge-SHA-bound release/deployment事实。不一致policy保持Run不变并记录固定`deployment_policy_invalid`。

身份绑定高风险审批契约：

- GitHub/飞书adapter必须先完成各自验签，再使用独立`APPROVAL_ADAPTER_TOKEN`调用`POST /v1/runs/:runId/approvals`；任务入口token和Agent/Attempt token均不能调用。Bearer只认证adapter，人的权威由D1 `channel_identities → identity_mappings`实时解析；
- 试点repo的`repo_write`还可使用GitHub commit-comment事实入口。`GET /v1/runs/:runId/github-commit-approval-template`只从active Run/Plan派生一段不含正文的exact snapshot comment；真人必须以GitHub `OWNER`身份把它原样评论在Run绑定的base commit。`POST /v1/runs/:runId/github-commit-approvals`的strict body只有`commentId`，`OPERATIONS_TOKEN`只触发观察，不是批准权。控制面用repository-scoped `contents:read` App token回读comment，要求commit SHA/base、body、author、`created_at=updated_at`、URL和24小时source窗口全部匹配，再把GitHub login映射为仅含`human + approve:repo_write`的principal并写同一`approval_source_events + identity_bound_approvals + approval_lineages + approvals`事务。approval固定1小时过期；caller不能提交actor/effect/Plan/base/expiry，评论正文也不进入D1、日志或Case 8；
- main-only `.github/workflows/github-base-readiness.yml`也可作为上述POST的受保护operator：新增`approval_run_id + approval_comment_id`模式与默认readiness、`diagnostic_run_id`模式严格互斥，仍固定owner/main/exact SHA/attempt 1、`contents:read`与`phase1-readiness` Environment gate。job只发送一次strict comment-ID POST并输出accepted approval/lineage安全投影；Task token、branch workflow、Environment approval或Action success都不能替代服务端GitHub/D1重验；
- request body strict且只允许以下字段。task revision、plan id/digest、base SHA、actor principal和PR作者principal全部由控制面从exact Run/Plan/publication/observation派生，caller夹带任一额外身份/权限字段返回`invalid_argument`；

高风险身份验收使用仓库外 strict `IdentityApprovalEvidenceManifestV1`。manifest 至少冻结 GitHub merge 与 Feishu production 的 accepted/self-rejected 四条 source；Case 8 `identityApprovals` 必须 exact 绑定 source/event digest、channel identity、principal/roles digest、author、Plan/base/effect、approval lineage 或 rejection ledger。GitHub verifier 复用 production read-only adapter 重算 PR author 与 review actor/head；Feishu signed event、tenant/open_id 和后台 mapping 仍是必须人工核对的真实外部事实。任何 case 都必须证明 merge/production outbox 与 deployment effect 为零，manifest 不能覆盖 D1 projection。

跨平台唯一关联验收另使用 strict `ApprovalLineageEvidenceManifestV1`。固定同一 current Run/Task/Plan/base 的 Feishu card `approve merge` 与 GitHub current-head `APPROVED` review：两条 source/approval/lineage ID必须独立，principal/roles digest/author separation与完整snapshot必须一致；Case 8两类投影、Feishu receipt operations投影、live GitHub PR/review和六次signed observer report四方交叉核对。同event重投必须回到原approval/lineage；distinct Feishu event复用nonce只能留下零effect delivery，GitHub同event改snapshot必须`source_conflict`。完整步骤见[飞书/GitHub审批唯一关联真实验收](ApprovalLineageE2E.md)。

```ts
type IdentityBoundApprovalRequest = {
  expectedRunVersion: number;
  planVersion: number;
  effect: 'merge' | 'production_deploy';
  decision: 'approve' | 'reject';
  expiresAt: string;
  source: {
    schemaVersion: '1';
    provider: 'github' | 'feishu';
    tenantKey: string;
    externalEventId: string;
    externalSubject: string; // GitHub login 或飞书 open_id
    eventDigest: `sha256:${string}`;
    occurredAt: string;
  };
};
```

- 渠道键固定为`github:<repository>`或`feishu:<tenant>`。未映射subject、PR作者未映射、非human/Agent/service principal、缺少`approve:<effect>`、PR作者跨渠道映射为同一principal或task actor自批都写固定identity rejection且零approval；同provider/tenant/event ID的20路相同请求只产生一个source/outcome，换digest或目标则409；
- accepted decision同时写exact `approvals`与`identity_bound_approvals`，但merge/production消费者只读取`trusted_effect_approvals`。该视图在调度和effect前重新核对当前渠道映射与live roles；角色撤销会使旧approval即时失效而不删除审计。Workflow replay的approval snapshot与restart前重验都使用该视图，裸高风险approval不能恢复外部副作用；
- 每个已验签GitHub/飞书decision还必须在同一D1 batch形成恰好一条immutable `approval_lineages`。该行把provider/tenant/external event及digest、approver principal/roles digest、source发生时间和控制面记录时间，绑定到exact Task/revision、Run、Plan/version/digest、base SHA、effect、decision与expiry；高风险decision引用`approval_source_events`，卡片decision另绑定exact `feishu_card_action_receipt`，低风险卡片decision以receipt为source。`approval_id`与`provider + tenant + external event`均唯一，trigger重新核对approval/source/receipt形状，不能靠直接D1写入伪造关联；本表不替代`trusted_effect_approvals`的live权限判断；
- `production_deploy`还有额外的post-merge约束：Run必须为`deploying`，Task必须授权production，active Plan声明唯一production effect，且immutable `github_merges`与Run/Plan满足`merge.runVersion + 2 = Run.version`。caller仍只提交上述通用request，不能提交revision、merge ID/SHA或environment；控制面派生这些值并把accepted approval同时写入`production_release_approval_bindings`。production分支只有在该binding与`github_merges`、`approvals`、identity/live role完全一致时才进入`trusted_effect_approvals`；
- production reconciler以`runId + runVersion + taskRevision + Plan/digest + mergeId/SHA + approvalId + target`派生stable deployment/Attempt/outbox identity。无exact approval时不创建任何outbox；effect前再次核对latest decision、expiry/invalidation/live role和merge binding。GitHub Deployment固定为`ref=mergeSha`、`task=delivery-loop:production`、`environment=production`，payload只带schema和control-plane deployment ID；POST 201或GET reconciliation只把D1置`created_unverified`，不生成Evidence或推进Run；
- production status fact strict为`schemaVersion/repository/githubDeploymentId/deploymentId/sha/task/environment/state/environmentUrl/externalUpdatedAt`。webhook来源保存raw payload digest；API来源使用独立`deployments:read` token，先核对`GET /deployments/{id}`的ID/SHA/task/environment/payload，再读取`GET /deployments/{id}/statuses?per_page=100`真正最新一条并保存canonical fact digest。两者以stable observation ID进入同一projector；response/body/token无持久化字段；
- projector重新绑定current `deploying` Run/version、Task revision、active Plan/digest、immutable merge/release approval、deploy Attempt、GitHub Deployment ID、merge SHA及production Environment。`in_progress`只单调更新external state；success缺OIDC返回可重试pending且零Evidence，具备attestation后才创建verified deployment Evidence、完成Attempt/Plan并CAS Run到`succeeded`；failure/error创建verified failed Evidence、失败Attempt并CAS Run到`failed`。terminal事实冻结，20路/双源重放收敛，旧timestamp、错误binding和failure后success只记ignored；

其余effect的通用批准事实仍必须包含：

```ts
type Approval = {
  taskRevision: string;
  planVersion: number;
  planDigest: string;
  baseSha: string;
  effects: Array<'repo_write' | 'test_deploy' | 'merge' | 'production_deploy'>;
  decision: 'approve' | 'reject';
  nonce: string;
  reason?: string;
  expiresAt: string;
};
```

过期、nonce 重放、task/plan revision、digest、base SHA 不一致或审批人不在策略集合时返回 `policy_denied`。

```ts
type ReplayRequest = {
  expectedRunVersion: number;
  from:
    | { stepName: 'verify-analysis-result'; stepCount?: 1 }
    | { planVersion: number; planItemId: string };
  reason: string;
};

type ReplayAccepted = {
  accepted: true;
  replayId: string;
  outboxId: string;
  runId: string;
  planVersion: number;
  planItemId?: string;
  target: { name: string; type: 'do' | 'sleep' | 'waitForEvent'; count: number };
  effectSnapshotDigest: string;
  created: boolean;
};
```

普通恢复只读取成功步骤缓存，不重新执行副作用。受控 replay 会重跑目标步骤及其后续步骤，并遵守：

- Phase 3 使用控制面 Bearer 认证、strict body 与 4 KiB 上限；`expectedRunVersion` 以 D1 CAS 预约 replay generation并使 Run version +1。20 路相同请求收敛为一个 replay/outbox，同旧 version 更换 target/reason conflict；reason 只保存 canonical digest，不进入 outbox、Workflow 参数或日志；
- 系统 step 不是任意字符串 allowlist，当前只开放确实存在于生产 Workflow history 的 `verify-analysis-result/do/count=1`。Plan Item target 必须属于当前 active plan/version且 `kind=verification`，控制面稳定派生 `plan-v<version>-item-<id>-verify`，客户端不能自报 step type/name；
- replay snapshot 收集目标位置及其后续 Item 的 effects。`repo_write/test_deploy/merge/production_deploy` 分别要求未过期的 exact task revision + plan version/digest + base SHA + effect approval；错误 base、旧 plan、reject/expired approval 均不得 restart；
- 已存在的 dispatch/PR/deploy intent 必须是 settled；已存在的 PR/check/deployment Evidence 必须 `passed + verified`。snapshot 把 approval ID 与 outbox/Evidence digest 规范化持久化，effect 前重新核对，新增/变化的外部事实使旧 snapshot失效；
- API 只创建 D1 `workflow_replays` + normalized effect/reconciliation snapshot + pending `workflow_replay` outbox。Queue consumer 再以共享 pending → delivering → settled lease调用 `instance.restart({from:{name,type,count}})`；approval 在 effect 前过期时以 `approval_expired` terminal settle，不调用 Workflow；
- Workflow restart 只对 terminal instance执行。调用结果不确定时从 status 观察到 queued/running/waiting才按已接受收敛；restart 已观察后持久化 `restart_observed_at`，outbox 重放不再次 restart。verification step 以 `(run, step, replay Run version)` 记录幂等 execution evidence；目标之前的 cached dispatch step不会再执行；
- 后续 PR/deploy producer仍必须使用稳定 outbox/dedupe key与外部 API reconciliation。当前本地穿透已证明 analysis dispatch 不重复并验证模拟 PR/deploy snapshot；真实 PR/deploy producer接入后的外部重复执行证据属于 Phase 4/5 关门条件，不能由 replay 控制面测试替代。

Runner 失联恢复使用单独的、strict schema 请求：

```ts
type RetryRunRequest = {
  expectedRunVersion: number;
  planVersion: number;
  planItemId: string;
};

type RetryRunAccepted = {
  accepted: true;
  attemptId: string;
  runId: string;
  ordinal: number;
  planVersion: number;
  planItemId: string;
  recoveredFromAttemptId: string;
  checkpointId: string;
  checkpointRef: string;
  checkpointDigest: string;
  headBranch?: string;
  headSha: string;
  created: boolean;
};
```

- Phase 3 的 `retry` 使用控制面 Bearer 服务认证和 `expectedRunVersion` CAS；匿名、旧 Run version、非 active plan/item、非 `blocked` Run 或非 `lost` active Attempt 均 fail-closed。后续飞书入口还必须叠加身份、revision 与 approval 校验，服务 token 不替代人审；
- replacement 只能在旧 token/lease generation 已撤销、稳定 `workflow_cancel` 已 `settled`、依赖 Item 全部 `passed` 且目标 Item 仍为 `in_progress` 时创建；`passed/skipped` Item 固定返回 conflict，不能再次调度；
- checkpoint 从当前 active plan/item 的全部历史 Attempt 中选择最新有效记录，不要求归属于刚失联的 Attempt。这样 replacement 尚未产出新 checkpoint 又失联时，可以复用更早的最近有效 checkpoint；每次仍重新核对 R2 metadata、schema、canonical digest 与 plan/item/head binding；
- replacement identity 由 `run + plan version/item + lost attempt + checkpoint` 稳定派生，数据库以 `(recovered_from_attempt_id, recovery_checkpoint_id)` fencing；20 路相同请求只创建一个 Attempt，响应中的 `created` 区分本次创建与并发/重放收敛；
- 新 Attempt 初始状态固定为 `pending`，不继承旧 Attempt 的 lease/token、GitHub run ID 或外部状态，也不自动创建 GitHub dispatch outbox。`repo_write` 仍须经过原计划 effect 审批和正常 dispatcher gate。

### 4.3 Runner 入口

| 方法与路径 | 说明 |
|---|---|
| `POST /v1/attempts/:id/exchange` | 用 GitHub OIDC JWT 一次性换 control-plane attempt token 与独立的 tool-bridge PEP token |
| `GET /v1/attempts/:id/context` | 用 attempt token 获取当前 analysis Attempt 的 digest-verified Task/context 与 Plan policy |
| `POST /v1/attempts/:id/plan` | 只提交 Agent-controlled Plan content；控制面注入 identity/digest 并持久化 validated Plan |
| `POST /v1/attempts/:id/tools/call` | 以 active attempt token 调用受信目录中的只读 tool-bridge 路径并写 metadata-only trace |
| `POST /v1/attempts/:id/model-reservations` | 用active Attempt fencing在模型进程前预留受信profile的最大token与micro-USD |
| `POST /v1/attempts/:id/model-usage` | 用同一fencing把官方JSONL usage结算为一次append-only模型调用 |
| `POST /v1/attempts/:id/heartbeat` | 以version/generation CAS延长租约、轮换token并追加安全receipt |
| `POST /v1/attempts/:id/github/write-token` | 用active attempt token换取exact approval绑定、单仓库的短期GitHub写凭证 |
| `POST /v1/attempts/:id/protected-path-changes` | Runner提交commit前生成的安全高风险diff摘要；控制面原子暂停并创建审批请求 |
| `POST /v1/attempts/:id/verifications` | 以active Attempt fencing注册exact head/policy/Plan Item绑定的targeted→required verify命令序列 |
| `POST /v1/attempts/:id/verifications/:suiteId/results` | 按position上报一条命令的exit code/duration/head SHA并创建unverified Evidence |
| `POST /v1/attempts/:id/events` | 追加结构化 step/tool/state event |
| `PUT /v1/attempts/:id/checkpoint` | 以 sequence compare-and-set 最新 checkpoint |
| `POST /v1/attempts/:id/artifacts` | 以active execution fencing写Secret-scanned、AES-256-GCM加密的短期raw Agent artifact |
| `POST /v1/attempts/:id/evidence` | 追加验证证据 |
| `POST /v1/attempts/:id/complete` | 声明本 attempt 结果；控制面仍核对外部事实 |
| `POST /v1/test-deployments/:id/oidc-attestation` | 用专用GitHub OIDC JWT证明exact test Environment/workflow/SHA，只持久化digest并返回受信`test:*` role ref |
| `POST /v1/production-deployments/:id/oidc-attestation` | 用独立production audience的GitHub OIDC JWT证明exact production Environment/workflow/merge SHA/run；还需current release approval/merge lineage，只存digest并返回受信`production:*` role ref |
| `POST /v1/test-acceptances/:id/oidc-attestation` | 用独立acceptance audience的GitHub OIDC JWT证明exact test Environment/workflow/deployed SHA/run；只存digest并返回固定command ref与清洗后的测试URL |
| `POST /v1/test-acceptances/:id/result` | 同一OIDC身份上报固定argv的exit code/duration；只形成不可变Runner事实，不直接生成passed Evidence或关闭Item |
| `POST /v1/test-rollbacks/:id/oidc-attestation` | 用独立rollback audience证明exact test Environment/workflow/失败SHA/run；只存digest并返回source trigger、role及policy/contract digest |
| `POST /v1/test-rollbacks/:id/result` | 同一OIDC身份上报固定rollback argv的exit code/duration；只形成Runner事实，不能单独生成成功Evidence或覆盖原失败Item |

`exchange` 必须验证 OIDC 的 issuer、audience、repository、workflow ref、SHA、run ID 和 attempt 绑定关系。返回的两个 token 生命周期都不超过 attempt lease；它们共享 Attempt grant 的撤销状态，但用途相互隔离。

Phase 1/4 exchange 约束：

- Runner 把 GitHub OIDC JWT 放在 `Authorization: Bearer`，不写 JSON body、日志或 artifact；控制面从 GitHub JWKS 仅接受 `RS256`，issuer 固定为 `https://token.actions.githubusercontent.com`，audience 默认 `delivery-loop-control-plane`；
- `repository`、`job_workflow_ref ?? workflow_ref`、`sha`、`run_id` 必须与 D1 Attempt 的可信绑定完全一致。其中`sha`只匹配dispatcher从Actions run列表观察并与run ID原子冻结的`githubHeadSha`，不能匹配caller输入或Plan的`baseSha`；`baseSha`继续只表示Agent checkout/代码证据真源，两者可以不同。Attempt 只允许 `analysis/implement/review_fix + starting/running + active lease`，未同时绑定GitHub run ID与合法run head时fail-closed，`deploy`仍使用独立Phase 5凭证路径；
- 同一 `attempt + leaseGeneration` 只允许一次交换。一次响应生成互不相同的 opaque `attemptToken` 与 `grant.toolBridgeToken`；OIDC JWT 和两个 token 均只保存 SHA-256 digest，D1 还约束两个 digest 不可相同；
- 两个 token 共用 `expiresAt = min(now + 5 分钟, attempt lease expiry)`，响应 `Cache-Control: no-store`。20 路相同交换只能一个请求获得明文 credential pair，其余返回 conflict；
- `attemptToken` 只用于 context/heartbeat/Plan/checkpoint/artifact/event/complete；`toolBridgeToken` 只用于本控制面的 `/tools/call` PEP。run token 不能调用工具，tool token 不能读取 Task/context或推进 Attempt；上游 tool-bridge 的 internal/Admin Secret 永不返回 Runner；
- analysis/triage grant固定且顺序规范化为`repo:read`、`logs:read`、`trace:read`、`k8s:read`、`database:diagnostic`。write/destructive scope不从JWT claim、请求body或Agent输出推导；数据库只开放受控diagnostic path，不下发DSN或任意SQL能力。
- implement/review_fix的run/tool grant只在上述read/diagnostic集合后增加`checkpoint:write`与`artifact:write`，仍不包含`repo:write`。前者只发布结构化恢复点，后者只写专用加密raw bucket；仓库写能力必须从独立GitHub credential endpoint按approval实时换取，不能通过OIDC claim或污染`scopes_json`获得；
- dispatcher 创建的 `starting` Attempt 在 exchange 与 token 持久化同一 D1 batch 中 CAS 为 `running`、version +1 并写首个 heartbeat；响应同时返回 `attemptVersion + leaseGeneration`，Runner 不能猜 heartbeat fencing 值。

Test deployment OIDC不走通用Attempt exchange：audience固定`delivery-loop-test-deploy`，subject固定`repo:<repository>:environment:test`，且`environment=test`、repository、`job_workflow_ref ?? workflow_ref`、deployment ref SHA必须与immutable `test_deployments` snapshot完全一致。控制面只保存JWT digest及白名单claims，不签发通用run/tool token或云凭证；同deployment重放返回同一attestation，错audience/ref subject/production environment/错workflow或SHA全部拒绝。真实云role换证由test Environment的外部trust policy完成，本地attestation不能冒充云授权证据。

Post-deployment acceptance也不走通用Attempt exchange：audience固定`delivery-loop-test-acceptance`，subject固定`repo:<repository>:environment:test`，repository、固定acceptance workflow、deployed SHA、GitHub run ID与test Environment必须和immutable `test_acceptances` snapshot完全一致。OIDC只保存digest；attestation返回的`acceptance:*` ref及HTTPS测试URL来自D1 snapshot。result只允许同一OIDC digest上报`exitCode + durationMs`一次，保存canonical result digest；它不是外部workflow结论，不能直接创建Evidence或推进Item。

Test rollback同样不走通用Attempt exchange：audience固定`delivery-loop-test-rollback`，subject固定`repo:<repository>:environment:test`，repository、固定rollback workflow、失败SHA、GitHub run ID与test Environment必须和immutable `test_rollbacks` snapshot完全一致。attestation还重新绑定verified source Evidence和declared contract observation；只保存JWT digest。Runner从exact SHA重新解析policy，要求source trigger、独立`test:*` role、policy digest与contract digest一致后才执行固定argv。result只保存canonical digest/status/exit/duration，不直接创建成功Evidence、修改原Item或推进Run。

Repo-write GitHub credential约束：

- 请求body strict为`{expectedVersion, leaseGeneration}`并先用opaque attempt token认证。broker逐项核对`implement/review_fix + running + active lease/generation`、Run=`executing`、exact active Plan/version/digest/base SHA、Item=`in_progress + activeAttemptId`、Item effect=`repo_write`、Task policy允许写以及Attempt repository与Task目标仓库一致；
- 当前latest exact approval必须绑定`run/taskRevision/planId/planVersion/planDigest/baseSha/effect=repo_write`，decision=`approve`且未过期；无审批、错误base/Plan、expired或更新的reject均在GitHub调用前`403 policy_denied`，因此拿不到创建远端branch/commit/PR所需的凭证；
- GitHub App installation token请求固定`repositories:[目标repo basename]`与`permissions:{contents:write,pull_requests:write}`，不含Actions/deploy/admin权限。写token不复用普通dispatch/read token，也不跨Attempt缓存；响应`Cache-Control:no-store`；
- 每次响应的authorization expiry固定为`min(GitHub expiresAt, approval expiresAt, 当前Attempt leaseExpiresAt)`。Runner在Agent前取得一次写授权以证明允许本地edit，并在Agent完成后、任何patch/commit/push前用最新heartbeat fencing再次请求；broker只允许把同一`credentialId/repository/approval/token/permissions`行的authorization窗口延长到新的最小值，不创建第二token或扩大权限。`github_write_credentials`只保存token SHA-256 digest与AES-256-GCM ciphertext/IV，密钥只来自Worker Secret binding；表结构没有明文token列，Attempt/approval的live authority仍成立时scheduled revoker不得仅因旧authorization快照过期而撤销，真正撤权/过期后删除ciphertext/IV；
- credential identity绑定`attempt + leaseGeneration + repo_write`，D1唯一约束和issuance lease保证并发只请求一个外部token；provider失败可用同一identity重新claim，不复制第二条credential；
- scheduled revoker每分钟核对Attempt/token/Run/Plan/Item/Task policy与approval。陈旧的authorization快照本身不覆盖仍有效的live Attempt lease；更新reject、approval真正过期、Attempt lease失效或complete/fail/cancel/lost、grant撤销时，以lease-fenced状态调用GitHub `DELETE /installation/token`；失败保留密文并进入`revocation_pending`重试，成功清除密文。GitHub自身expiry已到则直接标`expired`并清除密文；
- Agent只拿到该单仓库token本身，不能选择repository/permissions/approval。分支命名、commit author、禁止main/force-push仍由下一条独立repository write policy执行，credential approval不替代这些约束。

Repository writer约束：

- writer只能由可信Runner在持有未过期`IssuedRepoWriteCredential`后构造；credential repository必须与目标repo一致，权限必须exact为`contents:write + pullRequests:write`。prepare/commit/push每一步都重新检查credential expiry；
- 分支名完全由受信Task/Attempt identity派生为`agent/<taskId>/<attemptId>`，两段只允许有界`[A-Za-z0-9_-]`标识。调用者不能提交branch template、prefix、refspec或commit author；
- prepare要求工作树clean且HEAD为D1绑定的40位base SHA，再以固定`git switch --create <derived> --no-track <baseSha>`建立分支；existing ref只有在base SHA仍为ancestor时才可安全重入。任何Task正文/Agent输出都不进入Git argv；
- commit入口无参数，固定`git add --all --`后以`Delivery Loop Bot <delivery-loop[bot]@users.noreply.github.com>`同时覆盖author/committer，message只含task/attempt ID；关闭GPG、repo hooks和宿主`GIT_*`环境覆盖，提交后重新读取commit对象核对SHA及双重身份；
- push请求strict只有`{targetBranch, force}`，target必须等于derived branch且不能命中`main/master/baseBranch/受信protectedBranches`，`force`必须false。实际argv固定为`git push --porcelain origin refs/heads/<derived>:refs/heads/<derived>`，从不出现`--force/--force-with-lease/+refspec`；普通non-fast-forward由Git拒绝；
- GitHub token只通过子进程环境中的`http.extraHeader`注入，不进入argv、错误或持久化。writer清除宿主全部`GIT_*`后只加入固定identity/无交互/auth配置；错误只返回`repository write policy denied`，不传播Git stderr；
- 本地真实repo+bare remote穿透证明derived branch可创建/commit/push、main ref不变；真实GitHub branch protection与App identity的外部证据仍由Phase 4最终试点E2E提供。

Protected-path approval约束：

- `commitAll()`先以固定`git add --all`形成exact staged tree，再用NUL分隔的`name-status + numstat`解析added/modified/deleted/renamed/copied/type-changed/unmerged；路径解析拒绝绝对路径、`..`、反斜杠和控制字符。内建高风险pattern与commit-bound `delivery.yaml.protectedPaths`取并集，旧/新rename路径任一命中都触发；普通路径才继续commit；
- 报告固定为`ProtectedPathChangeReport v1`：`baseSha/stagedTreeSha/policyDigest/diffDigest/totalChangedFiles/protectedChanges[]`。`diffDigest = SHA-256(schemaVersion + baseSha + stagedTreeSha)`绑定完整staged tree；entries只保存repo相对path、可选previousPath、固定changeType与行数，不保存patch hunk、文件内容或Secret。Runner HTTP reporter只向固定HTTPS control-plane endpoint发送该strict body，Bearer只进header；非202或响应报告不完全相同一律fail-closed；
- `POST .../protected-path-changes`先以active attempt token及`expectedVersion/leaseGeneration`认证，再核对exact running implement/review context、Run executing、active Plan/Item、repo_write effect/Task policy、base SHA及仍active的GitHub写credential。调用者自报path不授予任何权限，报告digest与base/tree不一致返回conflict；
- D1 migration 0013以`attempt + leaseGeneration`唯一创建`protected_path_change_gates/entries`，同一batch把Run置`awaiting_approval`、Attempt置`cancelled`并generation+1、撤销run/tool token、把write credential置`revocation_pending`、将Plan Item progress绑定gate并创建`workflow_pause` outbox。Queue consumer复核gate/Run/Attempt后终止当前Workflow；未commit、未push，scheduled revoker继续完成GitHub外部token撤销；
- 相同gate/report在store层重放返回同一投影；同identity改写报告、旧base/version、非repo_write Item或无active write credential均拒绝。`GET /v1/tasks/:id`和`GET /v1/runs/:id/plan`只从D1列出安全审批摘要；原始diff、Git输出、token/ciphertext均不进入响应、outbox或Workflow history。恢复执行必须另行消费绑定exact diff的人工审批，`awaiting_approval`本身不是继续commit的授权。

Verification execution与Evidence约束：

- `VerificationExecutionRunner`只接受commit-bound `ParsedDeliveryPolicy`、absolute repository path、expected 40位head SHA和至少一个Plan选择的`test:*` ref。选择项必须唯一且存在于policy targeted map；Runner自动追加policy verify map中的全部`verify:*`（按稳定ID排序），调用者不能删减required verify或把`verify:*`伪装成targeted；
- 启动前、每条命令前后均以共享fixed Git executor执行`rev-parse --verify HEAD`，任何变化/错误都在Evidence上报前fail-closed。命令仍只经`DeliveryCommandRunner`把canonical ref解析成固定argv/shell=false；duration只测命令执行窗口并规范化为0～3600000ms。spawn失败固定记exit 127，不把异常/stderr变成证据文本；
- Runner通过固定HTTPS reporter先`POST .../verifications`。manifest strict为`{schemaVersion,headSha,policyDigest,targetedCommandRefs,requiredVerifyCommandRefs}`；reporter每次调用读取heartbeat轮换后的最新token/version/generation，Bearer只进header，响应必须`no-store`且服务端返回的position/phase/ref序列与本地完全一致；
- migration 0014新增`verification_suites/verification_suite_commands`及`evidence.duration_ms`。控制面只允许`implement/review_fix + running lease`、Run executing、exact active Plan、required self-verifying `change`或下游`verification` Item、`in_progress + activeAttemptId`、无pending protected-path gate、Attempt head一致且Item声明`test` Evidence的上下文；manifest的全部refs必须与该Plan Item `commandRefs`集合exact相等；
- suite commands固定先全部`targeted`、后全部`required_verify`。result strict只有`position/phase/commandRef/exitCode/durationMs/headSha`；服务端只接受当前第一个pending command，且所有更早command均`passed`。targeted失败时suite=`failed`且required verify不可入账；required verify失败时剩余命令不可执行；同suite/position相同结果幂等，改写exit/duration/head/ref冲突；
- 每条已执行结果创建稳定ID的`kind=test` Evidence，绑定run/attempt/plan version/item、canonical command ref、exit code、duration、exact head SHA和服务端固定summary；exit 0映射`passed`，非0映射`failed`。`verification_status`初始固定`unverified`：本项只证明执行事实已入账，不能直接把Plan Item置`passed`，后续Evidence verifier仍须按doneWhen/plan/head核对。

Required Plan Item关门约束：

- `POST /v1/runs/:runId/items/:itemId/verify`使用控制面服务Bearer，不接受Attempt run token。body strict为`{expectedRunVersion,planVersion,expectedProgressVersion,attemptId,expectedAttemptVersion,leaseGeneration,headSha,doneWhenEvidence[]}`；每个mapping只有`position + evidenceIds`，`status/verified/summary`等额外字段固定400；
- verifier重新读取Run=`executing|verifying`、exact active Plan/digest、required Item=`in_progress`、active `implement|review_fix` Attempt、version/generation/未过期lease及head。客户端给出的版本和head只作CAS期望值，不能覆盖D1事实；
- mapping必须按Plan定义完整覆盖每个doneWhen position。每条mapping都要覆盖该Item声明的全部Evidence kinds、command refs与external facts；每个Evidence必须为同run/attempt/plan version/item/head的`passed`事实。`test:/verify:` command Evidence额外要求所属suite=`completed`且对应command result=`passed`；failed/skipped、缺项、旧Plan/旧head或跨Attempt引用均409且零部分推进；
- migration 0015保存`plan_item_verifications`及有序`plan_item_done_when_evidence`。同一D1 batch写稳定decision/evidence-set digest、把所用Evidence标为verified、完成Attempt并提升generation、清lease/撤销token、把write credential置revocation pending，最后以前一progress version把Item推进passed；任一步不满足则fail-closed；
- D1 trigger拒绝required Item绕过decision直接UPDATE passed，并继续拒绝protected Item skipped。已用于doneWhen的verified Evidence关键绑定、命令结果、SHA、artifact/URL和verification status不可改，映射存在时Evidence不可删。相同request返回同一decision且`created=false`，更换mapping或绑定冲突；下游scheduler只读取由该gate形成的passed；
- `GET /v1/runs/:runId/plan`从上述normalized tables投影decision ID、head、digest、去重Evidence IDs、逐doneWhen mapping和verifiedAt。该投影是恢复/审计依据，不读取Agent输出、R2正文或Workflow状态。

Analysis context/Plan 约束：

- context 只接受当前 Attempt opaque token，且必须命中 running/status/version/generation/lease 与 `repo:read` scope；服务端按 D1 `payload_ref` 读取私有 R2 Task，重新校验 R2 custom metadata digest、canonical Task digest、revision、repo 和 base branch 后才返回，响应 no-store；
- context 返回原始用户反馈/PRD 是为了 Agent 分析，属于 untrusted data；不返回 attempt/OIDC token、installation token、DSN 或 tool-bridge Admin SK。Plan policy 明确 server-selected next version、allowedEffects、trusted commandRefs、verificationCommandRefs与requiresRepositoryChange；任何`allowRepositoryWrite=true`的requirement或bug都必须提议一个self-verifying required change，写effect仍只是提议，不改变analysis只读grant；read-only bug仍可只形成investigation Plan；
- re-analysis context可带strict optional `revisionSource`。review source从私有R2回读正文并复算body/source digest；base source从immutable observation重算规范化fact digest；supplemental source分别回读context对象和完整新Task revision，核对D1 ref、R2 metadata/schema、canonical context/task digest与source lineage。Attempt绑定零个source时字段缺省，超过一个、对象缺失或任一篡改时fail-closed；Agent只把这些内容当untrusted data，不能由其字段提升Plan effect。只有可写bug的`base_update`还可带Runner-only `carriedDiagnosticEvidenceRef`，其prior Plan/Evidence/binding/source完整性由context store与Plan store分别重算，字段不进入Agent context；
- Codex requirement output使用临时strict `{contextDigest, plan}` envelope以兼容provider wire schema；Runner忽略模型`contextDigest`值，独立核对0600 context文件在调用前后canonical digest未变化后，`POST .../plan` body只发送嵌套Plan content，即objective/assumptions/evidenceRefs/items。控制面从 D1 Attempt/Run/Task 注入 plan/run/task/base/attempt identity、计算 digest、固定 proposed，再经过 ExecutionPlan validator 与 store 持久化为 validated；
- Agent Plan 在两个独立边界做 Secret scan：Runner 在任何 `/plan` 网络请求前扫描全部已见 OIDC/attempt/runtime token和敏感环境值；控制面在任何 D1 plan/item/assumption写入前再扫描当前 attempt token、Worker Secret bindings与credential形状。命中只返回固定 `policy_denied`，finding和错误不携带值；
- 20 路相同 content 并发提交收敛到同一 plan/version/digest。额外 identity 字段、越权 effect、旧 token、R2 digest 冲突或 Plan immutable conflict 均 fail-closed。

Tool-bridge call 约束：

- body 严格为 `{toolPath, arguments}`，最大 64 KiB。Runner/Agent 只能选择 path，不能提交 scope、action 或 effect；服务端从版本控制内的 exact-path catalog 派生这些策略字段。未知 path 固定拒绝且不把不可信 path 写入 trace；
- 调用前只接受独立`toolBridgeToken`，按其digest复用running/status/version/generation/lease/revocation校验，并要求grant scope精确包含catalog action。control-plane`attemptToken`在此路由固定拒绝；
- triage allowlist只有`repo/read→repo:read`、`logs/search→logs:read`、`traces/get→trace:read`、`k8s/diagnose→k8s:read`、`database/diagnose→database:diagnostic`，五条均是POST call但effect固定为`read`。未知path在进入trace/upstream前拒绝；
- catalog另显式识别`repo/write`、`k8s/apply`、`database/execute`、`shell/exec`作为write/destructive能力。即使D1 scope被污染为包含对应action，effect gate仍写`policy_denied` metadata trace并保持零upstream call；caller自报scope/action/effect或多余字段由strict schema拒绝；
- Worker adapter 通过 service binding 向 Watt-compatible `/htbp/<toolPath>` 发送 `{arguments}` envelope；内部 Authorization 只能来自 Worker Secret binding。请求参数、header、响应正文和错误正文都不进入 D1 trace；
- 当前试点的`delivery-loop-tool-bridge`独立Worker只实现`logs/search`与`traces/get`：前者只接受Task中已有的`uid/cid/path`且固定查询`delivery-loop-control-plane`最近24小时、最多5条Cloudflare persisted events；非`/`开头的path解释为平台component path。后者只接受前一步返回的request ID并读取同一service的invocation。Cloudflare account/service/window/limit、`dry=true`和只读credential均由Worker配置固定，Agent不能选择；截断、Secret、错误account/service/request identity或非strict envelope全部固定503且不返回provider正文；
- `tool_call_traces` 只保存 `traceId/runId/attemptId/toolPath/action/effect/durationMs/resultCategory/occurredAt`。结果类别固定为 `success/policy_denied/upstream_error/timeout/unavailable/invalid_response`，duration 为非负整数并在 60 秒饱和；
- 上游非 2xx 不读取或转发错误正文，transport/parse 异常也只返回固定错误。成功结果只回给已授权 Runner且 `Cache-Control: no-store`，不写 D1、Workflow history、日志或 artifact；service 调用默认 15 秒 timeout、响应上限 256 KiB。
- 在任何upstream请求前，控制面以自己生成的trace ID和接收时间执行四scope `tool_call` admission；同trace重放只计一次。超额返回429且写run/attempt/resource/scope type/scope key digest/limit/requested units/reason digest，不保存path arguments、result或upstream error。

模型计量请求都使用opaque attempt token，并重新核对running status、version、lease generation和expiry。body没有调用时间、model价格或token上限字段：

```ts
type ModelReservationRequest = {
  reservationId: string;
  profileId: string; // 固定workflow从Worker可信配置注入，Agent不可选择
  expectedVersion: number;
  leaseGeneration: number;
};

type ModelUsageRequest = {
  reservationId: string;
  usageId: string;
  expectedVersion: number;
  leaseGeneration: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
};
```

- reservation以profile的`maxInput + maxOutput`和未缓存input/output最坏价格同时检查tenant/repository/user的UTC日及run lifetime预算；任一scope/resource超额均在模型子进程前返回429。这里的`maxInput`是一个真实CLI invocation中全部Responses/tool round的累计计费input ceiling，不是模型单次请求的context window；`model_context_window`只描述当前上下文，不能作为累计usage reservation。D1 profile是model ID、累计上界和整数micro-USD单价真源，cached价格不得高于预留用的uncached价格；profile identity/上界/价格不可UPDATE，改价必须新增profile ID，旧profile只允许运营disable，不能从Task、Agent输出或请求价格推导；
- 预约TTL为2小时。相同reservation ID、Attempt/profile且仍为active reserved时是网络幂等重放；settled、expired、换Attempt/profile一律409，避免相同ID触发第二次真实模型调用。Cron只把过期reserved置expired；
- Runner以官方`codex exec --json` JSONL中的单个`turn.completed.usage`填四个非负计费整数；其中input是整个turn跨工具往返的累计量，cached不得大于input、reasoning不得大于output，total/cost不得超过reservation。锁定的Codex 0.145.0还发送`cache_write_input_tokens`；Runner验证其为非负整数后丢弃，不把它加入价格或D1 schema，其他未知usage字段仍拒绝。控制面使用接收时间和D1 profile价格计算费用，原子写一次`model_usage`并settle reservation；相同usage ID与相同标量可重放，变异内容冲突；
- `model_usage`每行只含provider/model、run/attempt/tenant/repository/principal lineage、四个token数、整数micro-USD、source digest和时间。JSONL的thread/item/message/reasoning/command/tool/file-change/web-search/plan内容在Runner解析后立即丢弃，raw stdout不返回也不持久化；没有合法usage不得把模型调用记成零费用成功。
- execution普通edit turn允许一次同Attempt内的有界恢复，但只在首轮Adapter返回固定`decision_invalid/no_tool_activity`、Runner重验exact checkout/clean tree且首轮前已生成非空安全`repositorySnapshot`时成立。没有显式tracked路径或被点名文件超过单文件128 KiB/总计256 KiB snapshot上限只关闭第二轮fallback，不得阻止首轮workspace-write edit；候选数量歧义、unsafe或Secret snapshot仍在首轮前拒绝。每轮调用前分别以`canonicalSha256({attemptId, invocation:1|2})`派生reservation ID；取得该轮官方usage后立即用对应稳定usage ID结算。结算POST最多执行两次且两次body只允许fencing token/version随heartbeat更新，reservation/usage ID与usage标量必须完全相同；第一次已提交但响应丢失时第二次只接受服务端`existing`同一事实。两次均失败则在任何fallback/Git effect前写固定`tool_unavailable/external_reconciliation/resolve_external_dependency`并以Runner kind `quota_unavailable`终止，不得投影成`unknown/agent_output`。若Adapter在usage产生前失败，Runner跳过settlement并保留原固定failure，reservation依既有2小时TTL过期，不能把它写成零usage成功。首轮成功不预留第二轮，首轮出现部分工具活动或workspace mutation不创建第二reservation。第二轮仍无工具活动时沿原failure协议终结，不创建replacement Attempt或第二Action。

Attempt failure event 约束：

- 当前 `POST .../events` 只接受 strict `attempt_failed v1`：`eventId/sequence/failureCode/failureSite/attemptedPaths/neededHumanInput/occurredAt + expectedVersion/leaseGeneration`。`message/stack/rawError/fingerprint/failureClass` 等额外字段全部拒绝；请求和响应均不得承载原始错误、日志或数据库行。analysis Runner对同一固定body最多发送两次：第一次已经提交但响应丢失时，已撤销且未过期的exact token只能读取同一event的既有投影并仍返回202；event、枚举、fencing或occurredAt任一漂移固定409，不产生第二条failure、不恢复Attempt/token；
- `failureCode`、`failureSite`、`attemptedPaths` 与 `neededHumanInput` 都来自版本控制内固定目录，Zod 与 D1 `CHECK` 双层约束。`failureClass`、retry scope digest、fingerprint digest、路径展示文案和人工输入 prompt 全由控制面派生；
- active token、running status、version、generation、lease 和 Run 可失败状态必须全部命中。一次 terminal failure 原子写 `attempt_failures + attempted paths`、把 Attempt 置 `failed`、generation +1、清 lease并撤销当前 token；同 Attempt 只接受一个 terminal failure；
- retry scope把`implement/review_fix`规范化为同一`execution`预算，避免切换mode后重置次数；analysis和deploy仍隔离。连续第2次相同服务端fingerprint优先以`repeated_fingerprint`阻断；否则第3个Attempt失败时以`attempt_limit`阻断。上限3直接复用Watt `DEFAULT_MAX_ATTEMPTS/shouldRetry`的“首次 + 两次重试”语义；重复fingerprint阈值2与durable scope为delivery-loop新增；
- `tool_unavailable + external_reconciliation + resolve_external_dependency`是独立的可信外部依赖判据，不消耗模型重试来等待平台权限、credential broker或上游服务恢复；第一次报告即以`external_dependency`阻断并投影固定人工输入。migration 0066只扩展`run_blockers.reason`的D1 CHECK，保留既有blocker identity、计数和唯一active约束；
- 若该外部依赖是exact review lineage的`review_fix`在代码effect前因repo-write approval过期而失败，恢复仍不得复用旧approval或generic initial claim。`review_approval_recovery_candidates`以`source_kind`区分两种严格形态：`failed_dependency`要求固定external-dependency failure、唯一未解决blocker和零credential；`lost_pre_effect`要求source是prior `review_approval_recoveries.replacement_attempt_id`、Action completed/non-success、唯一credential已`revoked|expired`、resolved exact stuck incident、settled Workflow cancel、active Plan/in-progress Item、零active blocker且无failure/head update/commit-test Evidence/verification suite。新的identity-bound approval与`review_approval_recovery_approvals`同batch冻结source kind/source/root/approval；前者执行`blocked Plan/Item → active/ready`并resolve blocker，后者保持Plan active并执行`in_progress(lost) → ready`，两者都把Run推进`awaiting_approval`。专用reconciler再以fresh `trusted_effect_approvals`和同一source guards创建唯一root-bound `review_fix` Attempt/outbox，并在`review_approval_recoveries`冻结source kind、source/root、新approval和replacement。任一active/多个credential、missing fence/cancel、reject/invalidation、effect或Plan/Item/head漂移都保持零effect；
- 只有`verification_nonzero_exit + targeted/full_verification`同时命中当前Attempt generation/head上的真实failed `verification_suites + verification_suite_commands + Evidence`，才形成受信verification failure fact。fact digest只包含服务端phase/canonical command ref/exit code，不包含日志或Agent文本；caller仅自报failureCode/site而没有该D1事实时仍可终结自身Attempt，但不能创建repair；
- migration 0016以`attempt_failure_verification_facts`把每次可信失败绑定source suite/Evidence/head/fact digest；对应failed Evidence、suite和command关键字段随后不可变。`attempt_repairs`再绑定failure、旧Attempt、新Attempt、Plan/Item、source fact、retry scope与fingerprint，blocked的最后一次失败即使不再创建repair也保留相同证据链；
- 未达上限的可信verification failure在同一D1 batch内把旧Attempt置failed并撤销token/写credential、创建稳定identity的pending `review_fix` Attempt（`baseSha/headSha=失败head`、新branch尚未分配）、切换Item activeAttempt并写唯一`execution_dispatch` outbox。20路相同event/failure只创建一套repair/dispatch；response附带reference-only`verificationFailure`与`repair`投影；
- GitHub outbox processor只对verification repair、真人review、自动review fix或base rebase四类lineage恰好一种绑定、Run executing/verifying、exact active Plan、in-progress active Item且无protected gate的implement/review_fix Attempt派发固定workflow；payload仍只有IDs/digests/base/head引用，不含review body。队列延迟期间Run/Plan/Item失效则以安全terminal code settle且零GitHub调用；外部dispatch后D1 fencing丢失则settle，Action后续无法交换active token；
- 阻断与 failure 同一 D1 batch：Run、active Plan、当前 PlanItem progress 进入 `blocked`，其他 active Attempt 被取消并撤销 token，未执行 analysis dispatch 终结，稳定 `workflow_cancel` outbox 入账。事务后若预期 blocker/Run 投影不存在则 fail-closed，不返回半完成的 `blocked=false/retryAllowed=false`；
- 阻断同时settle尚未执行的analysis/execution dispatch；同指纹第二次不会创建第三个Attempt，不同fingerprint只允许两个repair后在总Attempt=3时停止。`GET /v1/tasks/:id`/Run查询投影固定failure class/code/site、路径label、计数、人工输入prompt和安全verification fact refs；不返回测试输出。非verification或缺可信fact的`retryAllowed`仍只是策略事实，不自动创建replacement。
- 当前仓库固定workflow已按mode互斥调用analysis或execution bootstrap。execution固定顺序为核对dispatch/OIDC/context→从Run base加载policy→取得approval-bound write credential→trusted setup→准备受信branch→受限Agent edit或Runner落盘的受控patch proposal→固定bot单commit/no-force push→head CAS→targeted/required suite。首次implement的Attempt在bot commit前允许`head_sha=NULL`，此时dispatcher、context与head CAS都必须使用冻结`base_sha`作为`checkout_sha/parent_sha`；commit Evidence、`attempt_head_updates`与Attempt CAS统一按`COALESCE(head_sha, base_sha)`绑定旧parent，且只有implement可使用null-head回退。review_fix/recovery仍要求并绑定已有source head。Runner把strict context写入repo外0600文件并先以runtime Secret扫描；Adapter再次要求canonical object、256 KiB上限和credential-shape零命中，把exact JSON放在stdin的`BEGIN/END_UNTRUSTED_EXECUTION_CONTEXT_JSON`数据块中，模型返回后重读文件且必须逐字等于初始canonical JSON。正文不进入argv、Action日志、artifact、checkpoint或D1新字段。普通带model reservation的implement/verification repair首轮是无`--output-schema`的edit turn；模型final message不构成decision，Runner只在同一JSONL观察completed file-change后派生`apply_fix`候选，command计数只作诊断。只有首轮固定`no_tool_activity`且trusted Git snapshot仍为exact clean checkout时，第二轮才切换为read-only strict `apply_patch` proposal：`{schemaVersion:'1',action:'apply_patch',changes:[{path,baseDigest,content}]}`，`baseDigest`为现有文件原始UTF-8 bytes SHA-256或新建文件的`null`。changes必须按path严格升序且唯一，最多8项；path最多240 bytes，单content最多128 KiB、总content最多256 KiB，禁止绝对/反斜线/dot segment/`.git`、删除、rename、binary、symlink和不存在父目录。已有文件的完整content必须逐字保留最小编辑之外的内容，且新UTF-8 bytes不得少于当前bytes的一半；这条保守收缩门禁只适用于第二轮fallback，不限制首轮workspace-write Agent。Runner在全部前置、runtime Secret和旧digest通过后才落盘，之后仍由trusted Git snapshot、受保护路径、唯一parent、commit/push/head/test Evidence回答真实执行；proposal内容不持久化到transcript/D1/日志。只有存在exact `reviewFeedback` lineage时，Runner才exclusive-create repo外0600 decision schema并通过`--output-schema`暴露`apply_fix|request_replan`，不会进入patch fallback；非模型测试adapter也保留strict schema用于接口回归。合法`request_replan`由Runner用当前fencing调用固定plan-revision reporter并在commit/push/verification前退出；普通implement与verification repair没有该能力。Agent启动、退出、transcript、context proof或decision任一异常都通过固定catalog归一为安全分类；proposal落盘、commit、push、head report异常依次归一为`repository_patch_failed|repository_commit_failed|repository_push_failed|head_report_failed`。其中commit failure的可选stage只允许`precondition|stage_changes|protected_path_scan|protected_path_report|create_commit|verify_commit|result_binding|unknown`且只出现在`execution_attempt_result + failed + repository_commit_failed`；其他kind/stage组合在sink前拒绝。D1仍只接收受审failure code/site/path/input组合：patch/commit固定`unknown_failure/repo_snapshot/code_change/manual_investigation`，push固定`tool_unavailable/external_reconciliation/code_change+external_reconciliation/resolve_external_dependency`，head固定`unknown_failure/external_reconciliation/code_change+external_reconciliation/manual_investigation`。stage只用于同一Action内安全定位，不进入D1/R2/Evidence/Plan，也不授权retry/repair。原始异常、exit code、stderr、transcript、Git输出、路径、diff、HTTP响应和Task正文不进入failure event或Action日志。protected-path报告成功后的pause不属于commit failure；若failure reporter自身失败，Runner仍只抛安全阶段错误且不得声称D1 terminal failure已写入。普通/verification repair派生新attempt branch；GitHub review repair以`ls-remote`核对原PR branch远端head等于reviewed SHA后重用该branch，push前后都不允许force。Agent输入不得缺失，Agent自行移动HEAD/创建commit会在trusted writer中被拒，非verification异常不会生成`verification_nonzero_exit`。本地真实Git/fake HTTP与workerd/D1已贯通，仍不能冒充真实成功Action。
- 上一段的v1完整文件proposal仅保留为trusted Runner内部兼容输入，不再是production provider契约。当前`apply_patch`规范wire envelope为`{schemaVersion:'1',action:'apply_patch',proposal:{schemaVersion:'2',changes:[{path,baseDigest,edits:[{oldText,newText}]}]}}`：最多8个existing snapshot path，每文件1～16个edit，单old/new各32 KiB、全部edit text 128 KiB；Writer要求base digest仍匹配且每个非空oldText在按序应用前序edit后的current content中恰好出现一次。任一stale/missing/ambiguous/unsafe edit都在全部文件零落盘时fail-closed；outer action版本与proposal内容版本独立。
- execution Agent canonical context可由生产Runner附加`repositorySnapshot:{schemaVersion:'1',files:[{path,baseDigest,content}]}`。`files`只来自当前checkout的tracked inventory与Item/Task验收文本的完整token逐字路径交集；`src/a.ts.generated`不得误命中`src/a.ts`，句末标点不属于路径。snapshot仍限制8项、单文件128 KiB、总计256 KiB，且进入context前必须通过regular-file、仓库内realpath、UTF-8、protected path及Secret扫描。该字段是只读不可信data；Agent输出必须使用上一条v2 wire，只返回exact edit而不复制完整文件，writer必须重新读取磁盘并验证`baseDigest`与唯一oldText，不能信任snapshot自报。
- repo write credential响应中的installation token只用于固定Git transport；Git-over-HTTPS header为`Authorization: Basic base64("x-access-token:<token>")`，与GitHub REST的Bearer header严格分离。编码值只存在于子进程环境，不进入dispatch、argv、日志、checkpoint、Evidence或PR。
- transport有效上限以实现常量为准：单文件128 KiB、全部decoded content 256 KiB。proposal authority只来自repo外0600 `--output-last-message`文件；同一structured final在Codex JSONL中的重复agent-message不进入通用line parser，而是在最多2 MiB物理行边界内以有界前缀确认envelope后流式丢弃，向64 KiB usage/activity/transcript消费者只发送固定`[PATCH_PROPOSAL_OMITTED]`事件。其他oversized line或无法确认的envelope固定拒绝；output file本身仍受JSON转义后有界读取、strict schema、UTF-8 decoded byte与Secret/path/digest校验。
- 测试失败修复循环的仓库外验收使用 strict `RepairLoopEvidenceManifestV1` 与 `pnpm run e2e:repair-loop`：manifest 必须冻结 `repair_succeeded`、`repeated_fingerprint_blocked`、`attempt_limit_blocked` 三类 case，并绑定 Run/Plan/Item、Attempt ordinal/mode、failure fingerprint、Action conclusion、commit/test Evidence、blocker 和 execution dispatch 数量。verifier 先读取 `/v1/runs/:runId/plan` 与 Case 8 audit，再复用 Actions parser 和 GitHub commit/ref/compare API；不接受 Agent 自报、仅重跑测试、额外 Action/commit 或 manifest 覆盖 live projection。Watt 的 opt-in、64 KiB manifest、0/1/2 退出、有界 HTTPS 和分页 fail-closed 继续复用。

Runner mutation 契约：

- `GET /v1/attempts/:id/context`先用active attempt token鉴权，再按Attempt mode路由。execution只接受exact execution scopes、running implement/review_fix lease、executing/verifying Run、active Plan、required in-progress active Item、repo_write Task policy/effect且无protected gate；R2 Task以D1/custom metadata/canonical digest重新核对。response含task/attempt base+checkout/Plan Item及`targetBranch/targetBranchMode`。review_fix恰好包含`repair`或`reviewFeedback`：前者只含source suite/Evidence/head/fact digest和服务端command/exit；后者从私有R2回读body并复核D1/R2 metadata/schema/canonical digest，返回review/head/branch/URL/time且明确作为untrusted data；两者都不含token、approval正文或测试输出；
- `POST /v1/attempts/:id/head` strict body只有`expectedVersion/leaseGeneration/parentSha/headSha/branch`。普通/verification repair branch必须等于服务端`agent/<task>/<attempt>`；GitHub review repair branch必须等于immutable review lineage的原PR branch。parent必须是当前checkout/source head且head不同；active Run/Plan/Item/effect/fencing及二选一source重验后，同一D1 batch写`attempt_head_updates`、固定summary commit Evidence并把Attempt head/version CAS前进。`(attempt,generation)`唯一，同内容20路重放仅一条transition/Evidence，改写或旧parent拒绝；
- execution bootstrap每45秒heartbeat；heartbeat、head与verification/failure reporters共享串行fencing gate，避免token rotation与CAS请求竞态。head response必须返回version+1并更新内存；Evidence API在命令间读取最新token/version。repo token仅进入Git环境，context/output为Runner临时目录中的0600文件并在finally删除。write credential在Agent调用之前取得；transport、非预期status或strict response校验失败只上报一次固定`external_dependency` failure，随后停止heartbeat并退出，不读取上游失败body、不调用Agent、不自动创建replacement；
- heartbeat body 只含 `expectedVersion + leaseGeneration`；Bearer attempt token、status、version、generation、token expiry 和 lease expiry 全部命中才以 CAS 续 90 秒，并原子轮换 `attemptToken + toolBridgeToken` 及两个 digest。Runner 应每 30～60 秒调用，任一旧 token 在成功响应后立即失效；同一batch按`attempt + generation + next version`稳定生成immutable heartbeat receipt，并在响应前确认receipt存在。并发CAS失败者不能插入receipt；
- checkpoint body 为 `{expectedVersion, leaseGeneration, checkpoint: AgentCheckpointV1}`；必须使用 active opaque token 和显式 `checkpoint:write` scope，并同时绑定 running Attempt、当前 version/generation/lease、active plan/version/item、`in_progress` progress、active attempt、head branch/SHA 与已存在的同 plan/item Evidence refs；
- checkpoint 先以统一 Secret scanner 扫描 Worker canary、credential 形状和当前 attempt token，命中固定拒绝且不写 D1/R2。完整 canonical payload 写私有 checkpoint R2 bucket，D1 只发布 plan/item/head、summary/nextStep、R2 ref/digest 等安全恢复投影；
- `(attempt_id, sequence)` 单调递增。同 sequence + 同 canonical digest 幂等返回既有 checkpoint；同 sequence 换内容或低于已发布 sequence 返回 conflict，不覆盖较新记录。D1 发布竞争失败的未引用 R2 对象不参与恢复，由后续 retention/reconciliation 清理；
- recovery 读取必须再次核对 D1 ref、R2 metadata、canonical digest 和 schema，并只返回 Run 当前 active plan/version/item 的 checkpoint；旧 plan、payload 缺失/篡改或 digest/binding 不一致均 fail-closed；
- raw transcript body为strict`{schemaVersion:'1', artifactId, category:'raw_transcript', expectedVersion, leaseGeneration, content}`。只允许running implement/review_fix、exact execution scopes、active Plan/Item/lease/token；Runner先以全部轮换token和敏感环境值扫描Codex JSONL，控制面再以当前token及唯一Worker Secret catalog扫描，任一命中均在R2/D1前固定拒绝；
- Secret safety 的仓库外 `SecretSafetyEvidenceManifestV1` 固定包含安全 Draft PR 与 Secret-blocked publication 两类 case。verifier 以显式 opt-in canary 在内存扫描 GitHub jobs/logs，交叉核对 Case 8 的 safe `secretArtifacts` ciphertext registry、PR API 或 `pull_request_secret_detected` zero-PR effect；manifest 不携带 canary/raw log/ciphertext/R2 key，Action log 读取有界且分页 fail-closed。
- transcript `artifactId`由Attempt与类别稳定派生为RFC UUID；同identity同内容重放收敛，换内容/version/generation冲突。`raw_agent_artifact_uploads`以pending→delivering→complete和30秒lease保存可恢复upload intent；控制面直接复用Watt固定commit的32-byte AES key导入、随机12-byte IV、base64url和AAD绑定语义，在写专用私有R2前完成AES-256-GCM加密，D1 registry没有明文/ref/key；
- complete body 只含 reference-only `eventId/sequence/payloadRef/digest/occurredAt + expectedVersion/leaseGeneration`，不接受 Runner 自报 GitHub status/conclusion。Referenced Plan 必须属于同 Run、由该 Attempt 创建且为 validated/active；
- complete 在一个 D1 batch 中写 Attempt result projection、`workflow_signals`、pending outbox 并撤销 token，但不直接把 Attempt/Run 标成完成。Workflow 消费 result 后推进业务状态，GitHub run 外部事实由 webhook/API 单独核对。
- complete、cancel 和 heartbeat timeout 都在同一 D1 transaction 中写 reference-only `attempt_revocations`；记录 reason、被撤销的 lease generation、结果 Attempt version 和时间，不保存 token/digest 原文。
- callback identity 以 `(runId, eventId)` 定址并以 `(runId, attemptId, sequence)` 单调去重；每个Attempt独立从sequence 1开始。幂等重放必须逐项匹配 type、Attempt、sequence、payload ref、digest 与 occurredAt。相同 event ID 修改任一内容，或同 Run/Attempt sequence 绑定另一 event，均 conflict，不能只比较 digest 后误收；
- `workflow_signal` processor claim 为 delivering 后，必须从 D1 重新绑定 signal → Run → Attempt result projection → referenced Plan。只有 `planning + running Attempt + exact result/Plan binding` 才调用 `sendEvent`；Run cancelled/blocked、Attempt cancelled/lost、非法/stale binding 都直接 settled 并写安全 terminal code，不触达旧 Workflow；
- `sendEvent` 确定失败回 pending。若事件实际送达但调用结果不确定，重放先 reconciliation：Run/Attempt/active Plan 已匹配则以 `already_applied` settled，不再次发送；尚未观察到应用时允许重投，但 Workflow 的稳定 wait/step 与 D1 CAS 仍只能推进业务投影一次。

取消与失联契约：

- `POST /v1/runs/:runId/cancel` 使用控制面服务认证，body 固定为 `{expectedRunVersion}`。只有 Run 状态机允许的 cancel edge 能以 CAS 进入 cancelled；20 路同版本请求收敛到同一结果；result 已上报、旧 version、merging/deploying/终态均 conflict；
- cancel 同事务把所有未完成 Attempt置 cancelled、version/generation 各 +1、清 lease、撤销 token，并把尚未生效的 workflow-create/analysis-dispatch outbox 终结为 reference-only `run_cancelled`；随后创建稳定 `workflow_cancel` outbox 终止旧 Workflow；
- scheduled stuck detector每分钟扫描并使用以下默认policy：`queued=300s → requeue_workflow_create`、`running=90s → fence_lost_attempt`、`awaiting_review=86400s → escalate_human_review`、`deploying=1800s → reconcile_external_deployment`。阈值按Run同state/version最后更新时间计算；running按可信heartbeat或lease expiry计算，并额外绑定Attempt status/version/generation与Run state/version。implement/review_fix若已经同时具备受信GitHub `completed/success`、非空head、同head completed verification suite、passed commit和passed test Evidence，则属于completion-pending而不是heartbeat failure；detector必须在候选查询和最终mutation CAS两次排除它，交给Evidence projector关门。只有GitHub success而缺任一内部事实仍不受保护；
- 首次命中以stable incident identity写`run_stuck_incidents(open)`和`run_stuck_detected`白名单日志。20路scan只产生一条incident/动作：queued只把过期delivering Workflow create intent重置pending；running在上述completion guard再次失败后才同事务置lost、generation+1、撤销全部active token、把Run置blocked并创建稳定Workflow cancel；awaiting_review只升级人工处理；deploying只请求既有平台fact reconciliation，二者都不凭时间自行reject/fail；
- 后续scan观察到Run state/version前进，或running Attempt已被fence，CAS写`resolved + run_progressed/attempt_fenced`并输出一次`run_stuck_resolved`。durable incident是告警真源；日志sink失败不能回滚incident/恢复动作。Cron为每分钟时，本地发现上界为阈值加一个scheduled周期；
- timeout token 本身 TTL 不得超过 lease；扫描器是防御性撤销和业务投影兜底，规定的持久撤销窗口为 lease 过期后一个 scheduled 周期。旧 Runner 的 heartbeat/context/Plan/complete 在撤销后全部 fail-closed；
- `workflow_cancel` processor 只接受 `d1://runs/<run_id>`，D1 Run 必须已 cancelled/blocked；实例 unknown/complete/terminated 视为幂等成功，其余调用平台 terminate。晚到 result 不能把 cancelled/blocked Run 恢复为 planning/active。
- recovery scheduler 只在上述 cancel intent 已 settled 后把 Run 从 `blocked` CAS 回 `executing`，把 Item 的 `activeAttemptId` 切到唯一的 pending replacement；旧 Workflow、旧 Attempt 或晚到 callback 不能继续拥有该 Item。
- Runner 启动 replacement 前要求工作树 clean，并只执行 `git status --porcelain=v1 --untracked-files=all`、`git cat-file -e <checkpoint_sha>^{commit}`、`git checkout --detach <checkpoint_sha>`、`git rev-parse --verify HEAD` 这组固定 Git 命令。校验 HEAD 完全一致后才调用 Adapter `resume`；当前 ephemeral Codex 固定走新的语义恢复 session。

GitHub `workflow_run` 外部事实契约：

- `POST /v1/webhooks/github` 对原始 body 校验 `X-Hub-Signature-256` HMAC-SHA256，只接受 `X-GitHub-Event: workflow_run`；`X-GitHub-Delivery` 与 raw body digest 去重，同 delivery 更换 payload 返回 conflict；
- Phase 1 只接受 `workflow_dispatch + run_attempt=1`，并同时匹配 D1 的 GitHub run ID、repository、固定 workflow path/ref、base SHA、stable run-name/attempt ID。签名正确但绑定不符的事件只留 reference-only ignored delivery，不改变 Attempt；
- 投影只保存 status/conclusion、GitHub `updated_at`、本地 observed time 与 delivery digest，不保存原始 webhook。只有严格更新的 `updated_at` 能前进，乱序/同时间冲突不能把 completed 回退；
- GitHub observation 使用独立 `github_observation_version`，不能递增 Runner heartbeat 使用的 Attempt `version`。外部 conclusion 仍只是核对事实，不直接关闭 Attempt/Run；遗漏 webhook 后续由 App API reconciliation 补齐。
- scheduled reconciliation 只选择尚无 completed external fact 的 Attempt，以 repo-scoped installation token 调用 `GET /repos/{owner}/{repo}/actions/runs/{run_id}`；API response 必须经过与 webhook 相同的 run/repo/workflow/base/title/run attempt 绑定后才能投影；
- API observation ID 由 repository/run/fact digest 稳定派生，D1 只保存 canonical fact digest 和 applied/ignored 标量，不保存 response body/token。同 API fact 重复轮询返回 duplicate；API 暂不可用只影响本轮 reconciliation，不把旧事实改成失败。

`GET /v1/runs/:runId/plan`对每个Attempt最多公开1000条安全heartbeat receipt，以及reference-only result和GitHub final projection；超过上限整次查询fail-closed。receipt固定字段为`id/attemptId/leaseGeneration/previousVersion/version/previousHeartbeatAt/heartbeatAt/leaseExpiresAt`，不公开token、token digest或原始请求。operations-only Case 8的`answers.checks.githubRunObservations`只公开webhook/API source ID/digest、绑定标量、processing state与时间，不公开raw webhook/REST。

Cloudflare Workflow实例事实与D1 Run业务投影遵循另一条双向reconciliation契约：

- 官方platform status仅允许`queued/running/paused/waiting/waitingForPause/errored/terminated/complete/unknown`。adapter只返回该枚举；`InstanceStatus.error/output`和`.get/status`异常正文一律丢弃，失败收窄为`unknown`；
- D1 `received/triaging/awaiting_approval/queued/planning/executing/verifying/pull_request_open/awaiting_review/ready_to_merge/merging/deploying`要求Workflow active；`blocked/failed/succeeded/cancelled`要求Workflow inactive。前者配terminal生成`restart_workflow`，配unknown生成`recreate_workflow`；后者配active生成`terminate_workflow`；
- 每次检查以safe fact digest更新`workflow_instance_reconciliation_state`，batch按最久未检查排序。只有mismatch写immutable observation与`workflow_reconcile_create|restart|terminate` outbox；Cron不直接产生平台effect。20路相同scan由`(run,version,status,action)`和dedupe key收敛；
- `runs.base_sha IS NULL`时，active Run配unknown/terminal只返回固定`base_sha_unresolved`并保留scan事实，不创建recreate/restart observation或outbox。processor执行任何已经排队的recreate/restart repair前还必须重新读取Run并做同一检查；未解析时回pending且外部Workflow effect为零，不能借自动repair绕过普通`workflow_create`的base guard；
- processor重新绑定observation、原outbox、Run state/version与active/inactive关系。stale或已resolved只settle固定码；create使用相同run ID，restart先识别已经active，terminate对unknown/terminal幂等。effect成功仅写`repairObservedAt`，下一次看到一致关系才把observation resolved；Run version前进则以`run_advanced`结案旧记录；
- pending controlled replay拥有terminal instance的显式优先权，自动create/restart不与它竞争。Task/Run查询只返回latest status/fact digest/check time和最近20条action/outbox/time/resolution，不返回平台error/output；
- Plan激活后Workflow进入`await-run-terminal`，timeout固定365天（官方允许上限）。D1业务终态不会由event自证；scheduled terminate结束waiting实例。若365天到期令平台errored而D1仍active，自动restart从D1当前Plan恢复控制wait。长期恢复不依赖已完成实例超过平台3/30天的history retention。

GitHub `pull_request`外部事实与上述签名、delivery digest、乱序和API修复纪律共用同一信任边界，但使用独立publication observation version，不修改Attempt heartbeat version。webhook/API observation表只保存repository、PR number、external updated time、fact/payload digest和applied/ignored原因；原始payload、PR body和installation token不进入表，body只通过prepared snapshot digest做exact核对。

## §5. Cloudflare Workflows 编排契约

一个 Run 对应一个 `DeliveryRunWorkflow`，创建时必须指定 `id = runId`：

```ts
type DeliveryRunWorkflowParams = {
  schemaVersion: '1';
  runId: string;
  taskId: string;
  taskRevision: string;
  taskDigest: string;
};
```

Workflow input 不携带任务正文。Workflow 从 D1/R2 引用读取经过授权的安全投影，并遵守：

- 稳定步骤顺序为 register → analysis dispatch/wait → plan validate/approval → DoD Item dispatch/wait/verify → external reconciliation → complete。
- 所有副作用和非确定性值都在 `step.do` 内；步骤名由 `plan-v<version>-item-<id>-<action>` 或稳定系统步骤名生成。
- `waitForEvent` 只接收带 `eventId/runId/type/payloadRef/digest/sequence` 的小型信号；外部 callback 先在 D1 按完整不可变内容去重并写 outbox，processor 重新核对 Attempt/Plan/Run 资格后才允许 `sendEvent`。
- Workflow create/signal outbox 经 Queue 投递，状态为 pending → delivering → settled；delivery claim 带 lease token/expiry，确定失败回 pending，过期 lease 可被新 token 接管。无需 effect 的 late/stale/already-applied callback 也进入 settled，但 `last_error_code` 保存不含敏感内容的 terminal disposition；Queue/relay 重放同一 outbox ID 不得重复实例或业务推进。
- `id = runId` 的 create 返回不确定错误时必须先查 instance status；实例已存在视为幂等成功，不能删除 D1 Run。Run 尚无受信 base SHA 时普通create和reconciliation create/restart都不得调用平台；原create/既有repair outbox保持pending并标记`base_sha_unresolved`，reconciler本身不新增repair intent。
- Workflow step result 不超过平台限制，且不保存 Secret、完整用户正文、原始日志/数据库行或未脱敏 transcript。
- D1 是对外业务状态和长期审计真源；Cloudflare Workflow status 只用于控制流诊断，不直接覆盖 Run state。
- Workflow 普通恢复与 Agent resume 是两层不同机制；前者复用成功步骤，后者从 Git/checkpoint 恢复一次 GitHub attempt。
- `verify-analysis-result` 是当前受控 replay 的稳定系统 step：先核对 reference-only Plan，再按 Run version 写 `workflow_step_executions`，随后 `activate-analysis-plan` 仍以 D1 幂等/CAS 收敛。任意 step name、dispatch/wait step 或未知 occurrence不能从 API 直接 restart。
- terminal Run不直接从内存拼动态target。`load-terminal-verification-steps`只在D1 Run=`succeeded`、active Plan identity/digest一致且Plan=`active|completed`时，读取最多200个`kind=verification + progress=passed + current passed verification decision`的Item；随后每项执行`plan-v<version>-item-<id>-verify`，以单条`INSERT ... SELECT`重新核对同一D1条件并按当前Run version写`workflow_step_executions`。该step没有dispatch/PR/deploy effect；completed Plan只允许从plan_item target重放，analysis system step仍拒绝。
- 普通hibernate/Worker redeploy外部验收使用strict `WorkflowHibernateEvidenceManifestV1`，只保存Run/Plan/Attempt/outbox安全标量、Cloudflare account digest、before/after deployment与version ID、instance version/status/start、七条normalized step的canonical digest、三个Dashboard链接及GitHub Action标量。Cloudflare API可能把同一稳定step暴露为`<stable-name>-<attempt>`；collector只接受exact名称或十进制`1..20`后缀并归一为稳定名，`-0/-01/>20`及任意其他后缀fail-closed。时间线必须证明`register-run/dispatch-analysis-attempt`在`await-analysis-result`前完成，wait开始时生效的最后一个deployment为before，wait期间恰有一个after deployment，result回传后的三个`step.do`均在wait结束后继续，最后停在`await-run-terminal`；instance output/error、step output/error、raw API响应和token没有schema入口。
- 只读verifier实时读取`GET /v1/runs/:id/plan`、Case 8、Cloudflare instance/deployments和GitHub run/inventory。D1必须仍为`awaiting_approval + active Plan`且无Workflow repair，analysis Attempt/outbox与stable-title Action各恰好一个；manifest自报、任意两条历史deployment或本地workerd不能证明真实跨版本恢复。完整演练见[Workflow hibernate / Worker redeploy 真实验收](WorkflowHibernateE2E.md)。

外部信号形状：

```ts
type WorkflowSignalV1 = {
  schemaVersion: '1';
  eventId: string;
  runId: string;
  type:
    | 'attempt_completed'
    | 'attempt_failed'
    | 'plan_approved'
    | 'plan_rejected'
    | 'github_fact_observed'
    | 'cancel_requested';
  attemptId?: string;
  sequence: number;
  payloadRef?: string;
  digest: string;
  occurredAt: string;
};
```

## §6. GitHub dispatch 契约

目标 reusable workflow 只接收非敏感引用：

```json
{
  "schema_version": "1",
  "run_id": "run_...",
  "attempt_id": "att_...",
  "plan_version": 1,
  "plan_item_id": "item_...",
  "task_digest": "sha256:...",
  "control_plane_url": "https://delivery.example.com",
  "mode": "implement"
}
```

Runner 从控制面读取完整任务。dispatch 不包含飞书正文、tool-bridge SK、GitHub token、数据库 DSN 或云凭证。

模型认证与可选中转配置不属于 dispatch 协议。固定 workflow 从 repository Actions Secrets `OPENAI_API_KEY` 与 `OPENAI_BASE_URL`读取配置，并只在 analysis/execution step 的进程环境中分别映射为Codex非交互认证变量`CODEX_API_KEY`与`OPENAI_BASE_URL`。base URL即使以Secret保存也只允许不含凭证的HTTPS URL，不能成为第二密钥通道；两者都不能成为 `workflow_dispatch` input、run-name、artifact、Plan、日志或控制面状态。

Dispatcher 约束：

- `workflowFile` 固定为 `.github/workflows/delivery-agent.yml`，ref 固定为 D1 Task 的 `refs/heads/<baseBranch>`；repository 必须同时存在于控制面 allowlist 与 GitHub App installation 范围；
- D1 `analysis_dispatch` outbox 与 Workflow outbox 共用同一 pending → delivering → settled/fencing 实现。20 路 consumer 只能有一个执行外部 effect，普通失败回 pending；
- scheduled relay 向同一 Queue 只发送 `{outboxId}`，并只在 GitHub App + control-plane 配置完整时选择 `github_actions` destination。Free plan的Cron和Queue consumer都只有10ms CPU；scheduled handler在recovery fence后必须先以原execution scheduler激活/领取最多1条exact已批准工作并立即relay全部可用destination，使新`execution_dispatch`及既有Workflow root在任何高成本恢复/观察前进入Queue。首个relay之后必须优先串行完成eligible `created_unverified` Draft PR的只读GitHub GET/projector、唯一自动review调度和第二次relay；这三步必须位于Workflow direct-drain、review recovery、at-risk GitHub扫描和stuck detector之前，且全handler各只出现一次PR projector/review scheduler。随后同一fenced processor direct-drain最多5条`cloudflare_workflows` effect，再处理review recovery、at-risk GitHub终态、Evidence/finalization、Plan revision、剩余relay、Draft恢复、完整progression与后台inventory。新publication若在后半段产生，下一分钟由priority projector继续。priority relay、direct drain和Queue consumer共享pending→delivering lease，重复命中不得重复effect；旧blocked状态产生的`workflow_cancel`若投递时Run已恢复为非`blocked/cancelled`，必须以`stale_run_state`确定性settle且不终止当前Workflow。Queue在effect完成或错误码落库前被平台硬终止时，过期lease由watchdog重置，下一分钟仍复用相同stable identity继续。Queue消息不携带/决定destination；
- consumer 按 D1 `outbox.destination` 路由到 Cloudflare Workflow、GitHub Actions、GitHub PR API、GitHub Deployments、test acceptance或test rollback processor。只有 settled/missing 可 ack；retry/busy/unconfigured/unsupported 必须 retry，禁止把 GitHub outbox交给错误processor后误判 missing/ack；
- REST adapter 使用短期 GitHub App installation token，token 只放 Authorization header。目标 workflow 必须设置 `run-name: delivery-loop/${{ inputs.attempt_id }}`；每次 dispatch 前先按该稳定 run-name 查询，204 后也必须查询到外部 run ID 才能 settle/启动 Attempt lease；
- 204 后查询暂不可见或网络结果不确定时保持 pending。下轮重试先 reconciliation，查到已有 run 返回 `existing`，不得再次创建；Runner 自报 run ID 不能替代该外部查询。
- GitHub App provider 使用 10 分钟内 RS256 App JWT 交换 installation token；交换请求以 repository 名进一步收窄、权限固定为 Actions write + contents read，token 只缓存在 Worker 内存到过期前且只进入 GitHub Authorization header。
- 真实单仓库安装/dispatch验收使用strict `GitHubAppDispatchEvidenceManifestV1`。App JWT只读`/app`、`/app/installations/:id`与`/repos/:repo/installation`，未按repository二次narrowing的短期audit token只读完整`/installation/repositories`、workflow content、Action和jobs；两类credential用途隔离。App/installation的ID/slug/owner/target/permissions/events、`repository_selection=selected`与唯一repo必须一致且未suspend。
- verifier按Action immutable head读取固定workflow blob，重算digest并解析YAML；随后核对Case 8中的唯一analysis Attempt/settled dispatch outbox、exact workflow ref和GitHub run，以及stable title下唯一`run_attempt=1` Action与唯一analysis job。token本身不能证明签发时没有repository narrowing，真实关门还必须人工核对installation settings和credential issuance审计，完整流程见[GitHub App 单仓库安装与固定 dispatch 真实验收](GitHubAppDispatchE2E.md)。
- 真实analysis Action验收使用strict `AnalysisActionEvidenceManifestV1`并先完整调用上述dispatch verifier。追加核对Task `bug/requirement`与`user_feedback/prd`映射、active Plan的非空Evidence refs安全digest及Item DAG/doneWhen/Evidence/acceptance覆盖、Case 8只读context聚合与exact triage scopes，且该Attempt没有repo-write credential。
- Runner实现不能由manifest或当前main自证。verifier从Action exact head读取manifest v1固定八文件source-set，逐blob/content digest核对package、pnpm lock、Plan schema、Runner和Codex adapter，再把聚合digest与manifest外release review记录比较；package与lockfile必须锁定同一Codex版本。为核对adapter实际依赖的安全边界，verifier还从同一immutable source SHA读取`codex-usage.ts`、`command-runtime.ts`与`provider-preflight-failure.ts`并fail-closed核对usage-only投影、stderr脱敏/上限及JSONL failure固定分类形状；这些transitive源码不新增manifest v1字段或第二套digest authority。immutable workflow最终step同时要求HEAD仍等于checkout SHA、detached HEAD和clean workspace，jobs API必须观察为success。完整流程见[只读 Analysis Action 真实验收](AnalysisActionE2E.md)。
- Draft PR producer使用独立缓存profile，只请求`pull_requests:write`；它不能复用Actions token或Runner的contents-write token。PR create/list/GET响应由strict adapter归一化，错误不读取或传播response body。
- test deployment producer再使用独立缓存profile，只请求`deployments:write`。它以exact SHA、固定task/environment和reference-only delivery ID创建GitHub Deployment；REST 201不是成功。outbox effect前及外部调用后的D1提交都重验Run/Plan/Item与latest approval，延迟reject/失效approval必须零GitHub调用或保持安全未验证状态。
- test acceptance dispatch使用另一套内存cache/pending，只请求`actions:write + contents:read`。它只在依赖deployment及其verified Evidence仍成立时触发固定acceptance workflow；dispatch input只有schema/acceptance ID/ref SHA/control-plane URL，稳定run-name用于POST 204后的GET reconciliation。外部effect后D1状态漂移以terminal settled code收敛，不重复创建Action。
- test rollback先用独立`contents:read` token调用`GET /repos/{owner}/{repo}/contents/delivery.yaml?ref=<failed-sha>`观察contract；raw policy/REST/token不落D1。只有verified test failure且exact policy声明对应trigger时，才创建`github_test_rollback` outbox。dispatch另用独立`actions:write + contents:read` cache，漏失webhook补偿再用第三套`actions:read` cache；input只有schema/rollback ID/source kind/ref SHA/control-plane URL，稳定run-name与20路fenced delivery防止重复Action。

Workflow 必须配置：

- 最小 `permissions`；Phase 1 analysis 固定为 `contents: read + id-token: write`，checkout 使用 dispatch 中的 exact `base_sha` 且 `persist-credentials: false`；需要推分支的 job 才临时获得 GitHub App token。
- `run-name` 固定为 `delivery-loop/${{ inputs.attempt_id }}`，用于 dispatch 不确定结果的 API reconciliation；不得把任务标题/正文拼入 run-name。
- `id-token: write` 仅用于 broker/OIDC 交换。
- 固定 `timeout-minutes: 60` 和 `concurrency: delivery-${repo}-${run_id}`；第三方 Action 全部 pin 到 40 位 commit SHA。
- analysis bootstrap校验dispatch的schema/run/attempt/task digest/base SHA/mode与context投影一致；digest-verified context写入workspace内随机命名的隐藏`.delivery-loop-analysis-context-*`目录，目录mode 0700、文件mode 0600，作为调用前后完整性锚点且不需要`--add-dir`。完成256 KiB、credential形状与runtime Secret扫描后，Adapter把exact envelope作为明确不可信JSON区块通过`codex exec ... -`的stdin传入；正文不进入argv或持久面。Agent output与诊断中间文件仍只写repo外`RUNNER_TEMP`的0600文件。Agent返回或失败时先删除workspace context；Plan提交前再对比前后`git status --porcelain=v1 --untracked-files=all`，finally幂等清理workspace与Runner临时目录。workflow的always-run最终关口再独立要求`git rev-parse HEAD == checkout_sha`、`git symbolic-ref`为空且porcelain为空，避免仅凭clean tree遗漏commit或branch漂移。
- bootstrap 每 45 秒 heartbeat；每次响应原子替换内存中的 token/version/generation，停止 heartbeat 后才用最新 fencing 提交 content-only Plan，再核对控制面返回的 deterministic plan ID/version/digest/ref 并发送 reference-only complete。
- PR 使用目标仓库允许的 GitHub App 身份创建，避免 `GITHUB_TOKEN` 导致后续工作流不触发的语义差异。
- test deployment workflow权限固定为`contents:read + deployments:write + id-token:write`，job Environment固定`test`，checkout exact deployment SHA且`persist-credentials:false`。它不能引用production Environment/Secret；Runner在启动policy command前从子进程env移除`GITHUB_TOKEN`与`ACTIONS_ID_TOKEN_REQUEST_TOKEN`，但test Environment提供的业务配置仍由目标部署命令按其云role策略消费。
- test acceptance workflow与deployment workflow物理分离，权限固定为`contents:read + id-token:write`且没有`deployments:write`，job Environment固定`test`并checkout exact deployed SHA。Runner只执行test target绑定的`acceptance:*` argv，把无userinfo/query/fragment的HTTPS Environment URL注入`DELIVERY_TEST_BASE_URL`，并从子进程环境移除GitHub/OIDC/控制面身份值；命令失败时仍先上报result再以非零退出令Actions形成外部failure。
- test rollback workflow与deploy/acceptance物理分离，权限固定为`contents:read + id-token:write`，job Environment固定`test`并checkout exact失败SHA。Runner只执行exact policy的rollback argv，向命令注入固定`test`和受信trigger标量，并移除GitHub/OIDC/rollback ID/SHA/控制面身份值；命令失败仍先上报result再以非零退出形成外部failure。workflow与Runner均没有production Environment、production role或deployment status写权限。
- production workflow与test workflow物理分离，权限固定为`contents:read + deployments:write + id-token:write`，不启用test cache，job Environment固定`production`并checkout GitHub Deployment中的exact merge SHA。它只接受`environment=production + task=delivery-loop:production`；Runner使用`delivery-loop-production-deploy` audience与`repo:<repository>:environment:production` subject向控制面核对release lineage，要求policy role以`production:`开头，只执行production target固定argv，并从子进程环境移除GitHub/OIDC、全部`DELIVERY_PRODUCTION_*`及`DELIVERY_TEST_*`控制值。真实required reviewer配置属于GitHub外部事实，本地YAML不能替代。

## §7. ContextGrant

```ts
type AttemptExchangeResponseV1 = {
  attemptToken: string; // control-plane mutation token，只在本次/heartbeat响应出现
  expiresAt: string;
  attemptVersion: number;
  leaseGeneration: number;
  grant: {
    toolBridgeToken: string; // /v1/attempts/:id/tools/call 专用
    expiresAt: string;       // 与本次 attemptToken 相同，且不晚于 lease
    scopes: string[];        // 固定五项triage action，不含write/destructive
  };
};
```

- 分诊Attempt只有`repo:read/logs:read/trace:read/k8s:read/database:diagnostic`；所有调用都是受控call且effect为read。数据库默认只允许受限diagnostic工具，不给原始DSN、任意SQL或write action。
- repo write 使用 GitHub App token，不通过 tool-bridge 绕过 GitHub 审计。
- 生产 K8s/数据库 write 不属于 MVP grant。
- 控制面保存 grant scope、run-token digest 与 tool-token digest，不保存返回给 Runner 的任一明文 token。heartbeat 在同一 CAS 中同时轮换两个 token/digest并把共同 expiry 设为新的 90 秒 lease；旧 run/tool token 都没有宽限期。

## §8. Agent Adapter

```ts
interface AgentAdapter {
  start(input: AgentStartInput): Promise<AgentSession>;
  resume(input: AgentResumeInput): Promise<AgentSession>;
  interrupt(session: AgentSession, reason: string): Promise<void>;
  exportCheckpoint(session: AgentSession): Promise<AgentCheckpoint>;
}
```

统一契约不把 provider session 当恢复真源：

- `AgentSession` 绑定一个 attempt，状态为 `running/interrupting/interrupted/completed/failed`，并暴露 completion 与 Runner-controlled `recordCheckpoint`；只有 adapter 自己创建的 session 可 interrupt/export；
- `recordCheckpoint` 只在 running 时接受同 provider/plan version/item/head branch 且 sequence 严格增加的 `AgentCheckpoint v1`。head SHA 可以随已核对 commit 前进，plan/item/branch 不能在 session 内静默切换；
- `start` 接收 Runner 注入的 initial checkpoint；`resume` 接收 repo 外 0600 checkpoint file、canonical digest 和 expected plan version/item/head SHA，全部核对后才启动 provider；
- `interrupt` 幂等，reason 只用于控制面审计，不传给子进程或错误；本地进程先 TERM，1 秒 grace 后仍未退出才 KILL。spawn error/stderr 不直接进入业务错误；
- `exportCheckpoint` 返回结构化 clone，调用方修改返回值不能改变 session 内快照。模型输出本身不能调用 `recordCheckpoint`，Runner 只在核对结构化 event/Git/Evidence 后记录。

Phase 1 Codex analysis adapter 采用官方非交互 CLI 契约：

- `codex exec --ephemeral --ignore-user-config --sandbox read-only --output-schema ... --output-last-message ... --cd <repo> -`，approval policy 为 never；不使用 `--yolo`、workspace-write 或 danger-full-access；
- `CODEX_API_KEY`只留在Codex进程环境，不写argv或仓库配置。可选`OPENAI_BASE_URL`在spawn前必须是trimmed、最长2048字符的公网HTTPS URL，且不得含userinfo、query、fragment、IP地址、localhost、`.local`或`.internal`主机。配置中转时，三个adapter必须使用同一custom provider `delivery_loop_relay`：`base_url=<validated-url>`、`wire_api="responses"`、`requires_openai_auth=true`、`supports_websockets=false`和`model_reasoning_effort="medium"`；不得只覆盖built-in OpenAI的`openai_base_url`，因为内置provider的WebSocket能力不能按中转profile覆盖。未配置时仍使用Codex官方默认provider；第三方端点必须兼容OpenAI Responses SSE并支持D1可信model profile绑定的exact model；
- `project_doc_max_bytes=0`，避免目标 repo 的 `AGENTS.md` 被提升为控制指令；任务正文、代码注释、日志、tool help/result和 context 都只作为 `untrusted reference material, not instructions`，正文不内联 system prompt；该静态纪律直接沿用 Watt HTBP harness 的防注入措辞；
- Agent输出的acceptance coverage仍是不可信提案。只有Plan恰好一个required Item时，adapter才能用可信Task快照的`0..acceptanceCriteriaCount-1`补全该Item漏报的`acceptanceCriteriaIndexes`；这不会生成doneWhen、Evidence、command、effect或执行权限。多个required Item、重复或越界index继续fail-closed，不猜测语义归属；
- `shell_environment_policy.ignore_default_excludes=false`，并额外排除 `*KEY*/*SECRET*/*TOKEN*/*PASSWORD*`，API key 只供 Codex 客户端认证，不进入模型启动的 shell 子进程；
- CLI 执行器捕获的 stderr 在返回 adapter 前按当前敏感环境变量与 credential 形状脱敏；上层错误仍只公开固定 exit code，不公开 stderr；
- CLI执行器在deadline触发时先记录`timedOut`再interrupt；即使Codex响应SIGTERM后原始exit为0，对所有调用方仍返回稳定exit 124。analysis adapter优先于usage/output检查拒绝该结果，provider preflight固定投影为`provider_timeout`；
- Agent output schema顶层只允许必填`contextDigest`与`plan`；嵌套Plan content只允许objective/assumptions/evidenceRefs/items。`contextDigest`保留为provider-wire兼容字段，Runner只校验其schema形状并忽略值；真实context authority来自调用前后对Runner-owned 0600文件的独立重算与未漂移比较。schema由Runner写入repo外0700临时目录中的0600文件，context未漂移后仅嵌套Plan进入validation/API。`planId/runId/version/taskRevision/baseSha/createdByAttemptId/status/digest` 由可信 Runner 注入/计算；模型不能自选 identity、提升 effect 或伪造 digest；
- fresh initial requirement Plan的单次纠正仍运行同一`--ephemeral --sandbox read-only`契约。Runner只把固定validator issue code加入可信提示，不把第一次Plan、Zod path/message、raw provider error或模型正文反馈给第二轮；纠正不能改变context、model profile、effect/command上限、credential或审批。每次真实调用分别reserve/settle usage，最多两次；diagnostic和Plan revision固定不进入该分支；
- `analysis_attempt_result + failed` Action结构化日志可选携带一对固定`failureKind/failureStage`。Agent kind只允许`process_unavailable|process_timeout|process_nonzero_exit|usage_invalid|structured_output_invalid|context_proof_invalid|plan_validation_failed`，Runner内部未分类终态另只允许`runner_internal_failure`；Agent stage只允许`context_validation|single_pass|diagnostic_log_request|diagnostic_log_mediation|diagnostic_trace_request|diagnostic_trace_mediation|diagnostic_root_cause|diagnostic_plan|plan_validation`，Runner内部stage另只允许`runner_boundary`。两字段必须成对，只来自typed Adapter error、Runner-owned diagnostic Plan binding gate或Runner terminal normalizer；后者不读取异常正文，只把没有可信业务failure的异常固定映射为Action的`runner_internal_failure/runner_boundary`，以及D1的`failureCode=unknown_failure + failureSite=external_reconciliation + attemptedPaths=[external_reconciliation] + neededHumanInput=manual_investigation`。`process_nonzero_exit`还必须携带固定`providerFailureCode`，只允许analysis schema/400五类与共享provider process十二类。Codex JSONL的`turn.failed.error.message`或top-level`error.message`只在进程内映射到该allowlist，projector不保留message或其他event字段；具体JSONL分类优先，generic时回退已脱敏8 KiB stderr。raw stdout/stderr、exit code、prompt、output、schema issue和raw error没有字段入口。`attempt_failed` API/D1契约保持原有code/site/path/human-input枚举，不接受这些Action日志字段。
- Runner 保存一次 attempt 中所有轮换前后的 token集合，Plan output scan必须覆盖旧 token与最新 token；本地 scanner通过后，控制面 persistence scanner仍独立执行，不能把受限CLI或Runner自检当唯一防线；
- context 正文通过 Runner 临时文件路径提供，不拼进命令行/日志；CLI stderr 不进入控制面错误或 Evidence。CLI 版本由 lockfile 固定，默认测试不调用计费模型。
- execution adapter把同一有界Codex JSONL逐行同时送入usage accumulator与Runner transcript collector，不写stdout或普通控制面请求。collector只接受JSON object line、上限512 KiB，并在Agent decision后、任何commit/push前用当前fencing上传；正文只存在于该专用artifact请求和加密raw对象，不进入Action结构化结果日志、checkpoint、Evidence或PR。stream observer分别把transcript与usage解析失败固定为`transcript_invalid|usage_invalid`，宽泛process catch不能重新标成`process_unavailable`。若Agent已经产生typed failure，Runner仍尝试安全持久化已收集transcript，但artifact校验/上传的次级失败不得覆盖该primary failure；只有Agent成功时的required transcript缺失、非法或持久化失败才以`transcript_invalid`终止。
- Runner可从上述已扫描JSONL生成一次固定`execution_agent_activity`安全投影，字段仅为`schemaVersion/attemptId`及总event、`command_execution` started/completed、`file_change` started/completed、`agent_message` completed、`turn.completed`计数。投影不含item ID、command、path、diff、output、message、usage、Task/Plan正文或任意raw字段，不写D1/R2且不参与状态推进；诊断sink异常必须被隔离。对于带trusted model reservation的普通edit turn，Adapter要求completed file-change计数至少为1后才由Runner派生`apply_fix`；command计数只作诊断，缺失不阻止后续Git snapshot验证；没有completed file change固定映射`decision_invalid`并在transcript持久化、commit/push/head/verification前终止。exact review lineage的`request_replan`不要求file change，非模型测试adapter也不伪造工具事实；即使计数满足，后续Git snapshot仍必须证明真实非空允许diff。
- Codex session adapter 的 start 和 resume 都使用新的受限 `codex exec --ephemeral`。虽然当前 CLI 提供 `codex exec resume <session-id>`，但 ephemeral run 不保存 provider session；因此恢复读取外部 digest-verified checkpoint 并启动新进程，不使用 `--last` 或猜测本机 session。prompt 只包含私有 context/checkpoint 文件路径，不包含正文或 checkpoint summary。
- session adapter与analysis/execution共享同一个custom Responses/SSE provider参数生成器，并可由可信调用方锁定exact model；model只接受最长200字符的受限标识，不从Task/context/checkpoint读取。真实provider preflight固定为无input的手动`workflow_dispatch`、`contents:read`、无Environment/OIDC，使用两个repository Secret映射`CODEX_API_KEY + OPENAI_BASE_URL`并在临时只读Git仓库运行strict session schema。migration 0062/0064保留历史immutable Sol/high与Terra/medium profile；migration 0073新增当前`delivery_loop_relay + gpt-5.6-terra + medium`的immutable累计tool-loop profile `codex-gpt-5p6-terra-medium-tool-loop-20260811`，Wrangler只引用该当前profile ID。它的2,000,000 input ceiling绑定整次`codex exec`累计usage而非context window，40,000 output与三类价格保持既有可信值。preflight保留exact route与普通analysis schema探针，并在同一临时只读repo额外运行production logs request、trace request、root-cause-only和普通Plan四份schema的synthetic bug四阶段mediation；临时repo必须包含被trace以仓库相对`path + symbol`引用的真实fixture源码，避免把HTTP locator或无来源猜测当成codeRef。必须得到四份usage、finish回调、有效Plan与clean workspace。stdout重定向到`RUNNER_TEMP`且不上传artifact。失败先把Codex JSONL failure event安全投影为固定analysis/provider code，generic时才回退已脱敏/有界CLI stderr；Codex 0.145.0官方`stream disconnected before completion`或明确带Responses/SSE stream语义的提前close/end/interruption单独收敛为`provider_stream_interrupted`，普通`connection closed/reset`仍为`provider_network_failed`，未知文本收敛为`provider_process_failed`。raw stdout/stderr/response/URL及其digest均不离开进程。该Action成功只证明provider route/认证/Responses兼容、exact model与synthetic analysis schemas可调用，不创建Task/Run、不能替代真实analysis Action或hibernate证据；
- provider preflight失败输出为单行固定JSON摘要：typed Adapter error只含`failureKind/failureStage`及nonzero时的allowlisted`providerFailureCode`，其他脚本失败只含固定`failureCode`。Error message、Zod issue path、模型未知key与输出片段都不能进入code或日志；generic摘要不构成retry authority，修复后复验仍需显式单次窗口。
- 独立provider network preflight与模型preflight分离。它只读取`OPENAI_BASE_URL`，复用三个adapter的同一URL parser，不读取`OPENAI_API_KEY/CODEX_API_KEY`，也不启动Codex、provider HTTP或模型请求。Runner先做最长10秒DNS lookup并拒绝没有公网地址的结果，再对最多四个解析地址检查validated HTTPS endpoint port（未显式配置时为443）的TCP连接，最后以原hostname作为SNI完成TLS握手、系统CA链和hostname证书校验。结果只允许8个固定code及`dns/tcp/tls`布尔值，不输出hostname、IP、URL、证书、底层错误或digest；真实DNS/TCP/TLS全通过只能排除基础网络和证书问题，不能证明Responses route、stream、认证或model可用；
- session adapter固定使用trusted `AgentSessionResultV1={schemaVersion:'1',status:'checkpoint_ready'}` JSON Schema并传`--output-schema`；模型不能在最终输出追加summary、工具结果或authority。真实验收入口`DELIVERY_LOOP_CODEX_ADAPTER_E2E=1 pnpm run e2e:codex-adapter`只在临时只读Git仓库调用已认证CLI，要求process exit 0、strict output、Runner-recorded checkpoint sequence 2、HEAD/工作树零变化，stdout只给CLI version、SHA/digest与布尔结果；默认未opt-in或认证无效均在无成功证据时exit 2。
- 真实 adapter 结果还必须符合仓库外 strict `AgentAdapterEvidenceManifestV1`：manifest 只能包含 provider/CLI version、`AgentSessionResultV1`/checkpoint digest、sequence、Plan Item/head、process/session 枚举及 clean/ephemeral 标志；checkpoint head 与 workspace HEAD/branch 必须 exact 相等。`pnpm run e2e:agent-adapter` 是真实调用入口，`pnpm run verify:agent-adapter-evidence` 只验证显式 opt-in 后传入的安全 manifest；schema example、fake executor、help 或 `codex login status` 不构成成功证据。
- analysis adapter 与 session adapter 共用同一个 bounded command runtime：stderr 最多 8 KiB 且返回前脱敏；timeout/interrupt 共用 TERM→grace→KILL，不维护第二套进程生命周期。

`AgentCheckpoint v1`：

```ts
type AgentCheckpoint = {
  schemaVersion: '1';
  sequence: number;
  provider: string;
  providerSessionRef?: string;
  planVersion: number;
  planItemId: string;
  headBranch?: string;
  headSha: string;
  completedAcceptanceCriteria: string[];
  evidenceRefs: string[];
  summary: string;
  nextStep: string;
  blockingReason?: string;
  workingTreeDigest?: string;
};
```

Checkpoint 不保存模型隐藏推理、Secret、完整数据库结果或未经脱敏的日志。恢复时 plan version/item 必须仍 active；工作区以 Git commit 为真源，未提交的 diff 只能作为加密 artifact 的辅助恢复材料，并必须带 digest。
`providerSessionRef` 只是受限格式的 opaque reference，不是凭证；`evidenceRefs` 只接受 `d1://evidence/<id>`，控制面核对其 run/plan/version/item 绑定。checkpoint response 只返回 ID、sequence、R2 ref、digest 和 `created`，禁止回显正文。

## §9. Evidence

```ts
type Evidence = {
  kind:
    | 'diagnostic'
    | 'plan'
    | 'test'
    | 'lint'
    | 'build'
    | 'commit'
    | 'pull_request'
    | 'check'
    | 'deployment'
    | 'approval';
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
- test deployment创建、job启动、OIDC attestation和最终status是四个独立事实：前三者都不能生成passed Evidence。签名`deployment_status success`还必须绑定专用OIDC attestation；failure/error生成failed deployment Evidence并令Item failed，Run保持`executing`，后续E2E/恢复策略另行决定。
- test deployment最终status允许HMAC webhook与每分钟read-only API两种source。API先GET exact Deployment核对repository、numeric ID、ref SHA、`delivery-loop:test`、`test`和`payload.delivery_deployment_id`，再GET最多100条statuses并按`updated_at`取最新；pending/queued等非终态不能借用旧success。API observation以fact digest稳定去重并进入与webhook相同的单调projector，D1不保存REST body或token。
- production Deployment create、Environment job、OIDC、Runner status POST和platform final status是五个独立事实。前四者都不能关闭Run；只有HMAC webhook或同projector的read-only API success、且exact OIDC存在时，才创建verified passed Evidence并推进`succeeded`。平台failure/error即使Action输出success也必须生成verified failed Evidence并推进`failed`；终态后任何相反晚到事实不得复活Run。
- production status 的仓库外 `ProductionDeploymentEvidenceManifestV1` 固定收集 `in_progress/success/failure/error` 四类独立 Run。每条都绑定 exact deployment/merge SHA/Plan/approval/Attempt、Deployment-triggered Action、双源 observation 和 Case 8 `productionDeploymentObservations`；只有平台 success + exact OIDC + Action completed/success + passed Evidence 才算成功，Action 自报 success 不能覆盖平台 failure/error。verifier 使用 explicit opt-in、64 KiB manifest、1 MiB 有界 HTTP、分页 fail-closed 和 0/1/2 退出。
- test deployment成功与post-deployment acceptance成功是两个required Item/事实面。Acceptance dispatch、OIDC、Runner result、`workflow_run requested/in_progress`均不能生成passed Evidence；只有签名webhook或GitHub API补偿的completed success与Runner passed/exit 0一致时，才能创建`kind=test + commandRef=acceptance:*` Evidence并由唯一Item verifier关门。workflow failure、Runner failure或结论冲突生成verified failed Evidence、失败Attempt/Item，Run保持`executing`；相同webhook/API事实只产生一条Evidence。
- test rollback eligibility只来自verified failed deployment/acceptance Evidence与失败SHA上的declared trigger。policy缺失/非法/未声明、source Evidence未verified、Task非test或production failure均零outbox。rollback dispatch/OIDC/Runner result/`workflow_run requested|in_progress`都不是成功；completed success还必须有Runner passed/exit 0，才生成独立verified deployment Evidence并完成rollback Attempt。rollback成功不改变原failed Item或把Run标`succeeded`；失败/结论冲突形成failed Evidence且终态冻结。production自动回滚在另行审批和演练前不存在执行入口。
- `TestRollbackEvidenceManifestV1`固定两个成功与两个负向case：`deployment_failure`、`acceptance_failure`都必须有exact source failure、declared contract、唯一rollback Attempt/outbox、test OIDC、Runner exit 0、GitHub completed/success、webhook/API observation、verified rollback Evidence及云人工review；`contract_absent`与`production_failure`必须在Case 8为零rollback projection/effect，并由GitHub workflow inventory在exact SHA/受控窗口内证明零Action。`productionDecision.automaticRollback`固定`not_approved`；未来production契约必须提升为独立schema，不能扩展此test manifest。CLI/Case 8字段与运行步骤见[Test rollback 真实外部证据验收](TestRollbackE2E.md)。
- merge gate decision、PR关闭和merge成功是三个独立事实。`ready_to_merge`不表示GitHub已合并；只有签名/API核对的`merged=true`才可保存merge SHA与verified Evidence。关闭未合并、merge按钮/CLI输出、Agent自报SHA或单独出现的base前进都不能作为merge成功。merge成功不能替代production deployment成功；test只有在此前deployment/acceptance required Item都verified passed时才随merge进入`succeeded`。
- Agent 自报的 URL/状态在外部核对前标记 `unverified`（存储层字段）。
- Plan Item 的 Evidence refs 必须指向同一 plan version、item 和相关 head SHA；旧计划或旧 SHA 的证据不能自动满足新 Item。
- Evidence的`passed`只描述单个事实；required Item的`passed`必须另有逐doneWhen verification decision。Agent complete、suite exit 0、直接progress修改或预先标记verified都不能替代该decision。

## §10. 飞书交互契约

卡片动作固定为 `approve`、`reject`、`cancel`、`retry`、`replay`、`add_context`。`button.value`直接沿用Watt `476e3cd`的`{id, signal}`结构；signal schema v1只包含action ID、card/presentation、task/run、Run version、task revision安全标识+完整digest、active Plan ID/version/digest、base SHA、固定command/effect、一次性application nonce，以及`add_context`的冻结`new_run|apply_current`模式。不接受principal、roles、policy、approval expiry、retry Item、replay target、R2 ref或任意effect扩权字段。

`card.action.trigger`必须先走与普通event相同的signature/timestamp/decrypt/token/app/tenant校验，再按Watt-derived结构只提取`header.event_id/create_time`、`operator.open_id`、`action.value`、`context.open_chat_id/open_message_id`和受控form context。card action只写metadata webhook receipt，不创建`feishu_ingress_outbox`；普通消息仍走Task normalizer。服务端要求callback chat为配置群、message为该Run当前active message、presentation为latest，且signal完整canonical digest存在于immutable presentation；随后重新读取exact current Task/Run/active Plan/base和Plan声明effect，并以`feishu:<tenant> + open_id`实时解析principal/roles。按钮可见性、飞书已验签、payload内任何身份声明都不构成授权。

角色固定为：approve/reject需要human和`approve:<repo_write|test_deploy|merge|production_deploy>`；cancel/retry/replay分别需要`operate:cancel|retry|replay`；add-context需要`context:add`。service/agent/anonymous即使含同名role也拒绝；approve继续执行Task actor及merge/production PR author分离。卡片产生的repo_write/test_deploy approval通过独立binding加入`trusted_effect_approvals`并在消费时重新JOIN当前Feishu channel mapping和live role；merge/production继续复用identity-bound高风险approval与release binding。

application nonce与transport nonce分层：transport nonce继续按`tenant + digest`保护密文重放；action ledger再对`tenant+event ID`及`tenant+application nonce digest`分别唯一。20路不同event点击同一按钮只能一条claim进入effect。claim前完成latest snapshot和身份授权；claim后只分发到既有`IdentityBoundApprovalStore`、`AttemptLifecycleStore`、`RecoveryAttemptStore`、`WorkflowReplayStore`或`SupplementalContextRevisionStore`。retry Item由当前blocked/lost/checkpoint/cancel-settled投影推导；replay固定从受控analysis verification step重启并继续由replay store核对approval/reconciliation snapshot。动作失败只写固定terminal outcome且不推进业务状态；outcome timestamp进入下一presentation的action epoch，生成新nonce。

add-context的form正文不进入signal、action receipt、日志或D1 outcome。服务端从prior Task的content-addressed R2对象回读并核对task digest/revision/metadata，以已验签event time/ID与operator open_id派生新Task event/revision/actor，再交给既有Secret-scanned supplemental-context store。`new_run`和`apply_current`是两枚不同冻结按钮；正文不能选择模式，也不能夹带TaskEnvelope、Plan、policy、base、effect或target。

已验签且app/tenant正确的`card.action.trigger`先写metadata-only delivery，再做action decode/chat/latest snapshot/identity/nonce/effect鉴权，因此malformed value、错误群、转发、旧卡、撤权和未映射账号也有exact event receipt，但仍不创建Task ingress。所有action成败输出固定安全structured observation；日志只有event/delivery、operator canonical digest、固定reason，成功时再有action/result安全ID，不含open_id、principal、raw callback/form、nonce或上游正文。

`GET /v1/operations/feishu-card-action/evidence?tenantKey=<exact>&eventId=<exact>`是用途隔离的operations-only投影。它只返回verified delivery、零/一action receipt与terminal outcome、operator/principal/chat canonical digest、exact card/presentation/Task/Run/Plan/base/command binding，以及event-bound approval/cancel outbox/recovery Attempt+checkpoint/workflow replay/context revision白名单事实；不返回open_id、principal、roles正文、nonce digest、raw event/form、Task/context正文、R2 ref或数据库行。拒绝event的`businessEffects`必须为0，`feishu_ingress_outbox`必须为0；`secret_add_context`允许已claim的rejected receipt/outcome，但不能有Task revision或R2业务effect。

真实验收使用strict `FeishuCardActionEvidenceManifestV1`、独立`FeishuCardActionObservabilityReportV1`和`pnpm run e2e:feishu-card-action`。固定矩阵为六类成功动作和`duplicate_nonce/tampered_value/forwarded_message/stale_card/stale_task_revision/stale_plan_version/stale_plan_digest/stale_base_sha/wrong_chat/role_revoked/unauthorized_account/secret_add_context`十二类拒绝；至少两个distinct mapped human principal。verifier重算observer report digest、逐event核对operations lineage、固定replay target和server-derived retry checkpoint/Item，并在JSON parse前用仓库外synthetic canary扫描全部有界响应。飞书后台scope、bot membership、真实截图和open_id mapping仍是人工authority；完整步骤见[飞书卡片动作鉴权真实验收](FeishuCardActionE2E.md)。

`GET /v1/operations/supplemental-context/evidence?contextId=<exact>`是补充上下文用途隔离的operations-only投影。服务端从隐藏D1 ref有界回读context/new Task私有R2对象，strict解析、重算canonical digest并核对custom metadata；响应只公开prior/new Task revision digest、context/Task digest验证布尔、唯一新Run/workflow-create、Feishu action或多个Meegle mapping安全lineage，以及apply-current的Run/PlanRevision/Attempt、token与approval计数。正文、actor/open_id/principal、Meegle字段/owner、R2 ref、token/nonce、raw event/outbox payload均无序列化入口。

真实验收用`SupplementalContextEvidenceManifestV1`、四个distinct event/五次HTTP观测（同一Meegle primary event重投）的独立observability report和`pnpm run e2e:supplemental-context`固定三case：Feishu `new_run`必须保持source Run version和running Attempt/token不变；`apply_current`必须cancel/absorb派生Run并只对source Run创建一个fenced analysis revision；两个不同Meegle event必须保留两条mapping lineage但共享唯一Task/Run/context/workflow effect，同event重投不得追加lineage/effect。verifier另读live Feishu Message，重算card digest并同时找到“补充上下文·新 Run/当前 Run”；完整步骤见[补充上下文 revision 与当前 Run 隔离真实验收](SupplementalContextE2E.md)。

卡片至少展示：当前状态、任务 revision、Plan version/digest、DoD Item 进度、目标 repo/base SHA、本 attempt 目标、最近 checkpoint、PR/check/deployment 链接、blocker、已批准 effect 与过期时间。blocked 卡片只消费控制面的安全 blocker projection，展示已尝试路径与固定人工输入 prompt；不得读取或拼接 Runner 原始错误。

`FeishuDeliveryCardPresentation v2`在既有四段delivery状态上增加完整Run投影：Run state/version、task revision安全标识、target repo/base SHA、active Plan version/digest、DoD Item passed/total/required/in-progress/failed/blocked计数、本轮Item title安全摘要、最近可信Action/check/PR/deployment链接、最近checkpoint与verified Evidence摘要、active blocker固定码/尝试路径/人工输入提示，以及当前仍有效的approved effects和expiry。旧schema v1 presentation/outbox升级后仍可渲染，不通过改写immutable旧行迁移。

所有字段从D1真源重新派生：Action必须有`github_observation_version > 0`后才按已绑定repo/run ID构造；check/Evidence URL只来自verified Evidence；PR/merge URL必须来自`pull_request_publications.status=verified`；test/production URL必须已有external observation version。approval必须exact绑定current task revision/Plan version+digest/base，来自`trusted_effect_approvals`、未过期、未被统一invalidation且没有更新reject；卡片在最早expiry保存`refresh_after`，即使D1无新事件也会到时生成移除过期权限的新presentation。

Plan Item title、checkpoint和Evidence summary只作为单行、上限240字符的数据，经当前Worker已配置Secret及credential pattern扫描；命中后使用固定隐藏摘要，Markdown在renderer中转义。Task/PR正文、raw log、artifact/R2 ref、Runner output、数据库行、自由错误、上游响应和caller URL没有presentation schema字段；大日志只显示安全摘要与verified HTTPS受控链接。

每个Run的逻辑卡绑定exact tenant/chat。reconciler把v2完整投影计算canonical digest，原子写immutable presentation与`feishu_delivery_card_upsert → feishu_cards` outbox；同digest重放不增revision，非latest outbox以`feishu_card_presentation_stale`无effect settle。Queue只携outbox ID。首次调用`POST /open-apis/im/v1/messages?receive_id_type=chat_id`并使用presentation派生、最长50字符的`uuid`，成功message ID与本地创建时间写D1；后续在14天窗口内调用`PATCH /open-apis/im/v1/messages/:message_id`，卡片前后均显式`config.update_multi=true`。本地时钟超窗或飞书230031触发新message create。token、create、PATCH和message GET逐请求直接复制Watt `plugin-sender.ts@476e3cd`的10秒`AbortSignal.timeout`边界；230020/230049、HTTP 429保存`feishu_rate_limited`，abort保存`feishu_api_timeout`，5xx/网络和99991661/99991663/99991665 token失效也保持同一outbox pending。每次claim只递增attempt count，失败不会写delivery或回退latest/delivered revision；后续成功才追加唯一terminal delivery并settle。其他业务拒绝只保存`feishu_request_rejected`，不得传播`msg`、异常或response body。

operations人工修复先调用`GET /v1/runs/:runId/feishu-card`读取不含tenant/chat/card正文的latest presentation ID/revision/digest、outbox状态与安全错误码，再调用`POST /v1/runs/:runId/feishu-card/refresh`。POST strict body只接受`expectedPresentationId + expectedRevision + expectedDigest`且必须等于当前快照；message ID、card JSON、destination、effect、reason、正文和未知query/字段全部拒绝。控制面写immutable refresh request，以request ID作为服务端refresh epoch重算canonical presentation digest并创建新outbox；renderer不展示epoch。20路同snapshot只一request/presentation/outbox，已被更新但从未请求过的旧snapshot fail-closed；同一已接受请求可幂等回读原结果。旧rejected delivery保留，不改写为成功。request已落库但HTTP中断时，cron候选查询会继续投影，因此恢复不依赖operator会话。

每分钟Feishu reconciliation只扫描“已有active message ID、latest presentation尚未delivery、原outbox仍pending/delivering”的卡片。adapter调用`GET /open-apis/im/v1/messages/:message_id?card_msg_content_type=user_card_content`，要求机器人仍在群中；响应只投影message/chat/sender app/create/update/deleted/msg type和原卡canonical digest，原始`body.content`只在内存解析。只有message ID、配置chat/app、`interactive + deleted=false`及latest renderer digest全部相同，才以同presentation/outbox身份写`feishu_delivery_card_observations(applied)`、`feishu_delivery_card_deliveries(updated)`并settle原outbox；不同内容只记固定ignored reason，不覆盖卡片。未知message ID没有安全GET键，首次POST响应丢失仍靠一小时UUID重试，不按群历史或相似正文猜测归属。

`feishu_delivery_card_retry_observations`是retry事实而非当前状态缓存：只有持有D1 lease并成功将同一outbox置回pending的fenced processor才可通过内部callback插入；`(outbox_id, attempt_count)`唯一，UPDATE全部拒绝。error code仅允许`feishu_rate_limited / feishu_api_timeout / feishu_token_invalid / feishu_api_unavailable / feishu_token_unavailable / feishu_unavailable`，不保存HTTP status、上游msg、异常、response body或token。operations card view最多返回100条按时间/observation ID排序的outbox/presentation/attempt/error/time安全历史，同时返回当前refresh request及next presentation/outbox lineage；历史缺失或binding异常使查询fail-closed。

`pnpm run e2e:feishu-retry`的`FeishuRetryEvidenceManifestV1`要求初始delivery的revision不因retry变化，retry attempt连续且至少覆盖rate-limit、timeout和token-invalid三类，之后以current expected snapshot创建新refresh presentation/outbox并最终settle。verifier只读调用operations GET和飞书Message GET，重算最终card digest并核对app/tenant/chat/time/message；三个token/host边界和1 MiB响应上限固定，summary不含raw或credential。完整真实步骤见[飞书卡片限流/超时与人工刷新真实验收](FeishuRetryE2E.md)。

`feishu_delivery_card_presentation_lineages`为新v2 presentation冻结`prior presentation + trigger reason + prior/current source_observed_at + trigger/next refresh time + projected_at`。`approval_expiry`只能在prior存在、prior/current source watermark完全相同、prior `refresh_after <= projected_at`且无operations refresh request时产生；其他业务事实更新必须标记`source_change`，人工repair标记`manual_refresh`。lineage append-only，没有卡片正文、principal、nonce、token、raw log或R2 ref列。

`GET /v1/operations/feishu-card-presentation/evidence?runId=<exact>`是用途隔离的operations-only验收投影：最多100张presentation，每张必须通过strict v2 rehydration和reference-only outbox binding，然后只返回Run/Task/Plan/DoD/repo/goal/可信链接/blocker/approved effect安全snapshot、canonical rendered digest、delivery上lineage白名单字段。action/application nonce、`presentation_json`、渲染后card JSON、Task/PR正文、raw log、artifact/R2 ref、DB行和上游响应不返回。

`FeishuCardPresentationEvidenceManifestV1`只是仓库外安全索引。`pnpm run e2e:feishu-card-presentation`要求首张成功delivery为interactive v2 `created`，到期前和到期后两张直接相邻且为同message `updated`；到期前安全snapshot必须含Plan/DoD/Action/PR/blocker/唯一effect、Markdown probe、固定隐藏checkpoint和大日志受控链接，到期后除移除effect外完全相同。verifier再读 live Message GET，核对app/tenant/chat/time/digest和全部非动作段落，并用仓库外synthetic credential-pattern canary扫描operations与飞书raw response。scope、群membership与截图是独立人工authority；完整步骤见[飞书交付卡片展示与自然过期真实验收](FeishuCardPresentationE2E.md)。

## §11. 真实试点证据契约

`PilotEvidenceManifestV1`是仓库外证据索引，strict且只含pilot/repository/time、Run/deployment/approval/Evidence ID、GitHub numeric ID、exact SHA、固定status/mode与安全HTTPS审计链接。test必须同时记录deployment和独立acceptance；production demo必须用不同Run/Deployment/Action分别记录success与failure/error，rollback必须绑定failure SHA并恢复到manifest的已知success SHA。manifest禁止token、raw webhook/API、日志、Secret值和带query的签名URL。

`e2e:pilot`只在`DELIVERY_LOOP_PILOT_E2E=1`时运行。它用控制面只读服务token核对三条`GET /v1/runs/:runId/plan`投影，用试点仓库Actions/Deployments read token核对五条Action的repository/completed conclusion/head SHA及三个Deployment的SHA/task/environment/latest state。任一响应缺失、binding漂移、candidate未verified、Action输出与platform state不一致均exit 1；缺opt-in/配置/manifest为exit 2。成功输出不含凭证或上游正文。OIDC/reviewer/隔离/rollback审计链接需另行人工核对，所以exit 0仍必须与人工证据一起写入`PROGRESS.md`，不能单独勾外部DoD。

## §12. D1/R2 备份恢复契约

`ControlPlaneBackupWorkflow`由`0 2 * * *` schedule触发，backup ID由scheduled time稳定派生。Workflow只持久化bookmark、digest、size、count和时间；Cloudflare API token、D1 SQL、signed URL、Task/checkpoint正文及raw provider error都不能进入step result、manifest、D1、日志或响应。D1 dump和manifest路径由服务端从backup ID固定生成，R2对象副本按源bucket+key的canonical digest寻址；descriptor set digest覆盖有序descriptor identity/digest。

operations API只有以下边界，全部要求用途隔离的`OPERATIONS_TOKEN`并返回`no-store`：

- `GET /v1/backups?limit=1..100`只列安全manifest/digest/count/size/time；未知或重复query拒绝；
- `POST /v1/restores/:restoreId/fence` strict body仅为`{backupId, manifestDigest}`；不接受SQL、bookmark、R2 key、Run state、token、effect或actor；
- `GET /v1/restores/:restoreId`只返回generation/status/time和安全一致性分类；
- `POST /v1/restores/:restoreId/complete`再次提交同一`{backupId, manifestDigest}`，与fence snapshot不一致即拒绝。

fence前必须验证manifest canonical digest及D1 dump content SHA-256；伪造digest对Run/Attempt/token零写入。首个合法请求用单个D1 batch前进restore generation，将所有业务active Run阻断、active Attempt置`lost`并递增version/generation、撤销未过期attempt/tool token、将Item/Plan阻断、把delivering outbox退回pending并清lease、释放并发/模型reservation、把`issuing|active|revoking` GitHub credential转`revocation_pending`。相同请求并发重放复用同一restore和审计。

`ready`是独立完成判据：私有backup dump仍匹配；全部descriptor及恢复后对象content SHA-256/size/content-type/custom metadata匹配；`backup_r2_references`中的Task/checkpoint/review/context ref均在该backup且metadata digest匹配；foreign key无错；Task/Run/Plan/Approval/Evidence lineage一致；fence/token审计完整；不存在active Attempt/业务Run、delivering outbox、reserved quota、未撤销内部token或`issuing|active|revocation_pending|revoking` GitHub credential。任一失败维持全局`restoring`；只有全部九类check以可重跑事实写入后才重开serving。

超过30天的已完成Run查询只联合D1 Task/Run/active Plan、Approval/Evidence计数及`workflow_instance_reconciliation_state.platform_status`，不调用Workflow `status()`或history。D1 export可能包含token digest和加密credential ciphertext，所以backup bucket必须私有；恢复后的服务必须先fence并撤销，不得把“导入成功”视为可服务状态。

## §13. Case 8 审计报告契约

`GET /v1/runs/:runId/audit`是单次、D1-only、operations-only查询。只接受合法Run ID和用途隔离的`OPERATIONS_TOKEN`，不接受任何query/body参数，响应`Cache-Control: no-store`并用`Server-Timing`公开服务端耗时。Run不存在返回404；任一栏超过500条、scope JSON不是控制面exact allowlist或D1 lineage冲突时fail-closed；服务端单调计时达到300000ms返回timeout，不能把部分报告伪装成完整回答。

`answers`固定恰好八栏，对应Vision Case 8原文：

1. `who`：Task actor、每个Attempt的mode/status/repository/workflow/GitHub run/head，以及外部merge actor；
2. `sourceEvents`：原Task source/tenant/external ID/revision/digest、Plan revision source fact，以及每条external approval lineage的provider/event/digest/source发生时间；
3. `permissions`：Task effect上限、逐Plan Item effect、attempt grant的scope名称/expiry/revocation和repo-write credential状态/approval binding；不输出任一token/OIDC/tool digest、ciphertext或lease token；
4. `contextReads`：Runner checkout的repository类别，以及metadata-only tool trace按repository/logs/traces/k8s/database聚合的调用/成功/拒绝计数和Attempt ID；不输出tool参数、result、URL或error；
5. `changes`：commit parent/head/branch/Evidence、protected diff/tree/policy digest与计数、PR body digest/净化链接和merge SHA/actor；不输出patch、PR正文或文件内容；
6. `checks`：verification suite command/ref/status/policy digest、Item evidence-set digest、GitHub required check digest/status和verified Evidence白名单字段；不输出summary、日志或artifact正文；
7. `approvals`：lineage ID、exact Task/revision、Plan/base/effect/decision、identity principal、roles digest、separation、source record/event/digest/发生时间、控制面decision记录时间和invalidation状态；PR 创建前的`repo_write` identity approval固定为`separationVerified=false`，已有PR/merge author的高风险effect才要求true；legacy/internal approval允许lineage字段为null；不输出nonce/request digest或按钮payload；
8. `deployments`：test/production environment、role ref、exact SHA、status、approval/Plan digest、GitHub deployment ID、Evidence和净化链接。

响应另含Task/Run安全身份、Task/全部Plan/Evidence artifact digest及去重后的HTTPS `links`；所有链接移除userinfo/query/fragment。`reportDigest`对不含`generatedAt/queryDurationMs`的完整安全body做canonical SHA-256，因此同一D1状态的20路并发查询digest相同。每次成功读取都直接复用Watt AuditStore的UUID/time/prepare+bind写入骨架，在`case8_audit_report_accesses`写`service:operations + Run + report digest + answer_count=8 + duration`；表不保存报告JSON或链接。structured log也只有Run、report digest、duration和各栏count。

## §14. 原始 Agent 数据保留契约

raw retention policy固定为`security-v1-raw-30d`，类别只有`raw_session | raw_transcript`。对象只能位于专用私有`RAW_AGENT_OBJECTS`，key由服务端从类别和UUID推导为`raw-sessions/<uuid>.ciphertext`或`raw-transcripts/<uuid>.ciphertext`；metadata必须完整匹配`schemaVersion=1 + retentionClass + objectId + ciphertextDigest + encryption=AES-256-GCM`。`raw_agent_artifacts`只登记identity digest、类别、ciphertext digest/size/etag、创建/到期时间和删除状态，`raw_agent_artifact_uploads`只保存可恢复fencing/lease状态。当前execution Codex adapter使用`--ephemeral`且只生产`raw_transcript`：Runner先扫描有界JSONL，控制面再次扫描并在R2前加密；analysis/session原始对象尚无producer。Task、review、context、checkpoint、Evidence或backup ref不能注册成raw。

每分钟Cron在全局serving active时执行固定25条batch：

1. 以`expires_at + object_id`公平cursor读取`expires_at <= control-plane now`且为active/retry/claim-expired的显式registry行，尾部回绕；policy expiry必须严格等于`created_at + 30 days`，边界含等；
2. 用5分钟`delete_claim_id`条件UPDATE领取；只有`meta.changes=1`的winner可调用R2；
3. key只能由registry identity推导。删除前`head`必须同时匹配etag/size和全部metadata，否则只记`metadata_conflict`，不删除；
4. `delete`后再次`head`。确认为null才把registry改为deleted并append `deleted` audit；若调用前已经null，append `already_absent`以修复“R2成功、D1未结算”的崩溃窗口；
5. 网络/平台不确定、删除后仍存在或policy漂移分别只记录`storage_unavailable / verification_failed / policy_conflict`，不保存异常正文；同一D1 batch把claim释放到retry；
6. `data_retention_deletion_audit`只含object identity digest、类别、policy、expiry、attempt ordinal、固定result/failure和时间，没有bucket/key、session/transcript正文或raw error；每个object最多一个完成事实，失败attempt可追加审计。

`POST /v1/data-retention/scans`仅接受用途隔离的`OPERATIONS_TOKEN`和strict body `{mode:'dry_run'|'execute'}`，拒绝全部query和bucket/key/prefix/before/limit字段，响应`no-store`。dry-run只按固定policy计数，零claim、零cursor变更、零R2 delete。execute仍使用同一固定batch和服务端时钟，不能变成任意对象删除API。

Task、checkpoint和backup使用不同binding，Evidence为D1结构化投影，均没有进入retention候选的序列化路径。备份管理器也不接收`RAW_AGENT_OBJECTS`，使30天短期raw正文不被复制进长期`BACKUP_OBJECTS`；D1 dump最多包含无正文registry/audit。restore期间retention不运行。

## §15. 运营事故契约

人类可执行契约见[OperationsRunbook](OperationsRunbook.md)。六个incident class固定为`github / feishu / tool_bridge / database / secret / wrong_production_deployment`；每类都必须声明SEV触发、只读诊断、止损authority、恢复、外部验证/结案、安全证据和禁止项。SEV-0/1的credential、destructive restore、production traffic或rollback动作需要IC与第二Reviewer；自然语言incident内容不能成为approval/effect输入。

Runbook控制面命令目录只能引用现有路由：

- task-service read/CAS：`GET correlations`、`GET Run plan`、`POST Run cancel/retry`；
- operations：`GET/POST dead letters`、`GET Case 8 audit`、`GET backups`、`POST/GET restore fence/status/complete`；
- 所有请求继续使用原strict schema、用途隔离token和`no-store`边界。Runbook不能新增query/body字段、任意SQL/R2 key、destination/effect或actor。

`/healthz`只证明Worker isolate liveness。当前没有全局provider pause API；GitHub/飞书/tool-bridge冻结必须在provider管理面执行并对已知Run逐项version-bound cancel。restore fence只用于已批准的D1灾备：普通D1 outage等待provider恢复；corruption场景先由外部平台隔离traffic并完成Time Travel/import，再以exact backup/manifest进入restore generation、撤权和九类一致性验证。当前没有production rollback API，test rollback contract/role/approval均不能用于production；错误部署通过外部Environment/云平台双人止损与已演练rollback或新Task forward-fix恢复，旧Run/Evidence不可改写。

Secret incident的顺序为provider撤销/重签→stdin更新受控Secret→分段无扰canary→证明旧值失效。GitHub credential encryption key轮换前必须先用旧key完成已签发write token撤销；旧key丢失时从GitHub App/installation信任根撤销。incident evidence只保存安全ID、digest、固定结果、时间和去敏链接，不保存Secret、raw日志/响应、数据库行、用户正文或credential ciphertext。

## §16. 连续七天试运行证据契约

`SevenDayTrialEvidenceManifestV1`是仓库外索引，strict且只含trial/repository/fixed GitHub actor、exact七天窗口、recorded time、observability report URL/digest及metrics/log/Secret alert三个安全HTTPS链接。窗口起止必须分钟对齐且相差`604800000ms`；所有链接禁止userinfo/query/fragment。manifest不含token、raw report/API/log、Secret值、PR正文或数据库行，也不能决定token投递到哪个host：runtime必须从`SEVEN_DAY_TRIAL_OBSERVABILITY_URL`取得受控exact URL并与manifest完全匹配。

`SevenDayTrialObservabilityReportV1`固定`service=delivery-loop-control-plane`，trial/repository/window必须与manifest一致；`generatedAt`不早于窗口结束，`reportDigest`对删除自身digest字段后的canonical body计算。`minuteBuckets`必须恰好`expected=observed=10080, missing=0`；`runIds`为1～100个唯一Run；stuck和runtime Secret detector均为`active`；detected incident必须全部resolved，`unresolvedKnownStuckRunIds/unknownStuckRunIds/runtimeSecretAlertIds`必须为空。report只保存ID/计数/digest，不保存告警正文或日志。

opt-in verifier对report中的每个Run调用`GET /v1/runs/:runId/audit`，取得verified PR publication和test/production Deployment identity；随后以GitHub只读token调用窗口仓库的PR与Deployment list。PR按固定actor、created time、draft、head branch/SHA/number核对，Deployment按payload中的控制面stable ID、GitHub ID、kind/environment/SHA核对；同head多PR、同stable ID多Deployment、控制面与GitHub任一多/少或REST `Link rel=next`均失败。成功summary只含窗口、digest和固定计数。

`pnpm run e2e:seven-day-trial`直接沿用Watt-derived Pilot verifier退出语义：未设置`DELIVERY_LOOP_SEVEN_DAY_TRIAL_E2E=1`、缺配置或manifest不可读为exit 2且零网络；schema/live fact不一致为exit 1；三方核对通过为exit 0。exit 0仍需人工review三个observability链接，并与真实Worker deployment、试点repo和Reviewer一起入账，才能关闭外部DoD。

## §17. 真实 Runner 恢复证据契约

`RunnerRecoveryEvidenceManifestV1`是仓库外、安全且strict的索引，只含repository、Run/Plan/Item、lost/replacement Attempt与Action run ID、ordinal/workflow head SHA、checkpoint ID/sequence/digest/branch/head SHA、replacement result/verification/Evidence ID，以及一个此前passed Item的verification/Evidence ID。old/new Attempt与Action必须不同，replacement ordinal必须推进，恢复Item与此前passed Item必须不同，result SHA必须推进checkpoint SHA；manifest不含token、Action URL/log、checkpoint/Agent/Task正文、provider session或数据库行。

`pnpm run e2e:runner-recovery`只有在`DELIVERY_LOOP_RUNNER_RECOVERY_E2E=1`时读取manifest。verifier分别读取`GET /v1/runs/:runId/plan`和`GET /v1/correlations?kind=run&id=...`，核对lost/replacement状态、checkpoint、branch/head、recovery lineage、逐Item verification/Evidence及GitHub关联；再读取两条Actions run/job、checkpoint/result commit、`git/ref/heads/<branch>`与`compare/<checkpoint>...<result>`。旧run/job/执行step必须`cancelled`，replacement必须`success`，workflow path/title/repository/head均绑定；branch ref必须指向result，compare必须`ahead_by>0 + behind_by=0 + base/merge-base=checkpoint`；lost ordinal之后不能出现此前passed Item Attempt，replacement也不能产生其Evidence。

命令继续直接沿用Watt-derived 0/1/2纪律：通过全部live事实为0；manifest/API事实不一致为1；未opt-in、缺配置或manifest不可读为2。summary只含固定状态、ID和计数，错误只含固定code。exit 0只证明manifest所列事实通过只读交叉核对，不能替代实际强制终止动作、Action URL入账或人工审计，完整步骤见[Runner强制终止恢复验收](RunnerRecoveryE2E.md)。

## §18. 真实受控 Replay 证据契约

`ControlledReplayEvidenceManifestV1`是仓库外strict索引，固定最长七天窗口、Run终态/current version、Plan/verification Item、replay expected version/ID/digest/outbox/时间、按effect排序的approval绑定、全部dispatch outbox ID、原Agent Action、唯一PR和至少一个test/production Deployment。PR要求`repo_write` effect，每种Deployment要求对应deploy effect；mutating effect必须有approval ID。manifest不含replay reason、token、raw API/日志、PR正文、Evidence正文或数据库行。

Case 8 `answers.checks.replays`公开安全replay审计：expected Run version、Plan/Item、stable target、reason/effect snapshot digest、created/restart time、唯一replay outbox状态、effect/approval和reconciliation ref/digest。每个reconciliation在生成报告时重新与当前settled outbox或verified Evidence计算canonical digest；孤儿、重复replay outbox、来源变化或非法错误码使整个报告fail-closed。reason正文、outbox payload/dedupe key、Evidence URL/summary和lease不进入响应。

`pnpm run e2e:controlled-replay`读取Case 8与correlation安全投影并重算`effectSnapshotDigest`，要求approval在restart时有效、merge/production separation已验证、dispatch集合精确不增、PR/Deployment和Evidence exact。随后用GitHub只读API在manifest窗口核对原Action run title只有一条、同head branch PR只有一个、每个控制面stable deployment ID只有一个且最新status success；分页或事实不一致失败。operations/query/GitHub三种token用途隔离，origin只允许安全HTTPS，响应以1 MiB流式上限读取。

退出语义继续直接复用Watt-derived 0/1/2纪律：live事实全通过为0；schema/事实/分页不一致为1；未opt-in、配置缺失或manifest不可读为2。verifier只读且不会执行replay；exit 0还需真实Workflow restart与GitHub URL入账，完整步骤见[受控Replay真实验收](ControlledReplayE2E.md)。

## §19. 真实失败 Blocker 卡片证据契约

`FailureBlockerCardEvidenceManifestV1`是仓库外strict索引，只含Task/Run/repository、active blocker ID/reason/fingerprint digest/计数/Attempt ordinal与固定path code/人工输入code/time，以及presentation/revision/presentation digest/rendered-card digest/outbox/message/app/tenant/chat/time。连续同fingerprint必须至少2，attempt-limit必须达到Watt-derived 3次上限；Attempt数、计数、唯一ID和递增ordinal必须一致。manifest没有Runner error、Task/卡片正文、token、raw API响应或数据库行字段。

`GET /v1/runs/:runId/feishu-card`除既有latest/delivered安全标量外，从当前strict stored presentation重新render并返回canonical `renderedDigest`；不返回presentation/card JSON。verifier先以Task query strict解析active failure blocker，逐Attempt核对服务端failure class、path code/固定label与人工输入固定prompt，额外字段或caller/raw error字段因strict schema失败。随后要求latest presentation、delivered presentation和message ID完全相同、outbox settled/attempt≥1/无error，并与manifest精确绑定。

最后只读调用飞书`GET /open-apis/im/v1/messages/:message_id?card_msg_content_type=user_card_content`，核对interactive/non-deleted message、app/tenant/chat/time，解析最大30 KiB user card并重算rendered digest。卡片必须只有一个`**Blocker**`段，内容由live reason/count、按Attempt顺序去重的固定path label和固定human prompt精确重建；即使manifest与digest一起改写，自由错误文案仍不能通过。控制面与飞书响应都有1 MiB流式上限，三个token用途隔离，错误只返回固定code。

`pnpm run e2e:failure-blocker-card`直接复用Watt-derived 0/1/2退出纪律：live三方事实通过为0；schema、binding、digest或文案不一致为1；未opt-in、配置缺失或manifest不可读为2。verifier只读，不制造失败也不发送/PATCH卡片；exit 0仍需真实Runner阈值链路、消息链接/截图、应用scope与群membership入账，完整步骤见[失败 Blocker 飞书卡片真实验收](FailureBlockerCardE2E.md)。

## §20. GitHub Draft PR 外部证据契约

PR publication 的创建响应永远是 `created_unverified`。Agent、Runner 或调用方提交的 PR URL、number、status 和 webhook payload 没有状态推进权限；只有 signed `pull_request opened` webhook 或同一 projector 的只读 API reconciliation 能写入 `verified` PR Evidence 并将 Run 推进到 `pull_request_open`。两种 observation 都必须绑定同一 immutable publication、repository、base/head branch、head SHA、PR number 和 canonical body digest；同一 delivery/fact 重放只保留一个 identity，source fact 缺失或冲突时 fail-closed。

Case 8 的 `answers.checks.pullRequestObservations` 是 D1-only 安全投影，按时间和 source ID 排序，字段仅为 `sourceKind`（`webhook|api`）、`sourceId`、publication ID、repository、GitHub PR number、fact digest、`processingState`、固定 `ignoreReason`、external/observed/processed time。不得选择或序列化 raw webhook、PR 正文、REST response、payload/dedupe key 或 token；报告生成时发现孤儿 publication、重复 identity、非法时间或绑定漂移必须整份报告失败。

`GitHubPullRequestEvidenceManifestV1` 是仓库外 strict 索引，冻结 run、repository、verified publication、webhook applied fact 与 API applied fact。`pnpm run e2e:github-pr` 先读取不超过 64 KiB 的 manifest，再读取 Case 8，最后调用 GitHub `GET /repos/:owner/:repo/pulls/:number`，核对 `open + draft`、URL/number、base/head repository/ref/SHA 及 canonical body SHA-256。响应以 1 MiB 流式上限读取，错误不传播上游正文。退出码沿用 Watt-derived 0/1/2：live facts 全通过为 0，事实/schema 不一致为 1，未 opt-in/配置或 manifest 不可读为 2；verifier 只读，不创建或修改 PR。真实验收步骤见[GitHub Draft PR 外部证据验收](GitHubPullRequestE2E.md)。

## §21. GitHub Review Fix 外部证据契约

`github_review_webhook_deliveries` 是 review 外部事实的唯一 delivery ledger。`changes_requested` review 只有在 `review.commit_id == pull_request.head.sha == D1 当前 immutable bot head` 时才能以 `applied` 投影；它会在同一 D1 状态边界创建一个 `github_review_feedbacks`、一个 `review_feedback_attempts`、一个 `review_fix` Attempt 和一个 dispatch outbox。旧 head 或重复 review 只能写 `ignored/stale_head` 或 `ignored/duplicate_review`，不能创建 R2 feedback、Attempt、Plan revision 或 Action。

Case 8 `answers.checks.reviewObservations` 只公开 review delivery 的 source/review/publication ID、repository/PR number、reviewed head、payload/body digest、processing state、固定 ignore reason 和时间；applied 行可额外公开 feedback ID、prior/replacement Attempt ID、branch、净化 review URL 与 submitted time。review body、R2 ref、raw webhook/API response、payload、token 没有序列化入口；`received`、partial lineage、重复 source ID、非法 digest/time 或未净化 URL 使报告 fail-closed。

`GitHubReviewFeedbackEvidenceManifestV1` 同时冻结 applied review、stale review、active Plan/Item、replacement Attempt、commit/suite/Item decision、Action 与完整check inventory。`pnpm run e2e:github-review` 读取不超过64 KiB的manifest，先复读`/plan`并对生产真实Case 8形状重算report digest：prior/replacement必须属于同Run/repository/Plan/version/change Item，replacement携带正数`claimedProgressVersion`，从reviewed SHA恢复后只有一条parent=reviewed SHA的commit；targeted命令必须先于required，全部test/commit Evidence在result SHA上`passed + verified`，最新Item decision与Item状态均为passed。GitHub Action的`head_sha`表示受信workflow ref head，不冒充Runner产出的result SHA；verifier分别绑定workflow head、reviewed checkout SHA和result SHA，再核对真人Review body digest/commit、唯一`attempt` job的固定execution steps、PR/ref/commit、单commit fast-forward compare和result head的全部check-runs。live check inventory必须与manifest exact同集且每条均`completed/success/result head`，额外失败check也使验收失败。API出现下一页或任一事实漂移即失败；请求10秒、响应1 MiB流式上限，token/credential-shaped canary在JSON parse前扫描，错误只返回固定code。退出码沿用Watt-derived 0/1/2：全事实通过为0，schema/事实不一致为1，未opt-in/配置或manifest不可读为2。完整步骤见[GitHub Review Fix 外部证据验收](GitHubReviewE2E.md)。

自动review不伪装成GitHub真人review，也不复用`github_review_webhook_deliveries`。它以独立`automated_reviews/automated_review_fix_attempts`保存head-bound内部审查lineage；完整结构化结果只进私有R2。进入merge gate前必须能从最新PR head追到terminal `approved` automated review；前三轮任一pending/changes_requested或第三轮blocked都不是“无重大问题”。真实外部验收必须使用fresh Task/Run/PR/Actions链证明同一PR head前进、每个head最多一个review、blocking修复后重新review及三轮上限，不能用本地workerd、旧PR、Agent自报或R2对象代替。

## §22. Plan Revision 外部证据契约

`answers.checks.planRevisions` 是 Case 8 的安全 revision 投影。每行只公开 revision ID/expected Run version/status、source kind/record ID/digest/observed time/requested base、analysis Attempt ID、prior Plan 与 new Plan 的 ID/version/digest/base/status、body/base/effects change 和 activation time，以及 source-specific 的 ref digest/compare digest、review body digest/commit、或 supplemental event/Task revision lineage。source 不存在、source digest 不匹配、partial Plan/lineage、非法时间/ID/URL 和 `received` 外部事实必须使报告 fail-closed；正文、R2 ref/content、review body、payload、approval nonce/token 和 Action 原始输出没有字段。

`PlanRevisionEvidenceManifestV1` 支持 `review_feedback`、`base_update`、`supplemental_context` 三个 strict source union。manifest 同时冻结 prior Plan `superseded`、new Plan `version + 1/active`、至少一个变更标志、旧 approvals 的 invalidation 和新 human/provider approvals。`pnpm run e2e:plan-revision` 先读 Case 8 核对 source/Plan/approval/analysis Attempt，再读 GitHub Action；base source 额外核对 ref/compare 与 canonical reference/comparison/source digest，review source 额外核对 Review body digest/commit/head。response 以 1 MiB 流式上限读取，下一页或 facts 漂移失败；退出码沿用 Watt-derived 0/1/2。supplemental Feishu/Meegle 的验签、tenant/identity 和审批后台证据仍需人工核对，完整步骤见[Plan Revision 外部证据验收](PlanRevisionE2E.md)。

## §23. Base rebase / conflict 外部证据契约

Case 8 `answers.checks.baseRebases` 只投影 rebase/revision/source-target Plan/Item/Attempt ID、old/new base、source/target branch/head、status/result suite、GitHub run/status/conclusion、dispatch outbox 状态和时间；`baseConflicts` 只投影 conflict/prior Plan/repository/base、before/after/merge-base SHA、relationship/count、reference/comparison/source digest、固定 blocker/human action、Run/Plan/cancel 状态和时间。diff、Git 输出、Runner 错误、raw API/webhook、token 和审批正文没有字段。

`BaseRebaseEvidenceManifestV1` 是 `passed | blocked` strict union。passed 同时冻结 base observation、rebase lineage、Action、non-force fast-forward branch update、verification suite 和 Evidence count；verifier 读取 Case 8、GitHub Action、base/source/target ref 与两条 compare，要求 source ref 不变、target ref 指向 result、两条 compare 都只 ahead 不 behind、targeted 和 required commands 全 passed。blocked 冻结 immutable conflict、唯一 Workflow cancel、固定 `manual_rebase` 和零 Action/push/Evidence/dispatch 断言；verifier 核对 GitHub base ref/compare、Action inventory 无目标 title、target branch 404 和 Case 8 零新 effect。

## §24. Test deployment 外部证据

`TestDeploymentEvidenceManifestV1` 是测试环境部署的仓库外 strict 索引。每个 case 绑定 Run/version、Plan/digest、delivery Attempt、`test_deployments` snapshot、`test_deployment_oidc_attestations`、GitHub Deployment/Actions、独立 deployment Evidence 与无 query 的 Environment URL；同时冻结 signed `deployment_status` webhook 和 API compensation observation 的安全 ID/digest/state/time。`noDuplicate` 必须为单 Attempt、单 Deployment、单 deploy outbox、单 deployment Evidence。

Case 8 的 `answers.deployments` 对 test deployment 额外投影固定 workflow path、OIDC audience、attestation ID/run ID/subject；`answers.checks.testDeploymentObservations` 只投影 webhook/API source、observation ID、fact digest、deployment ID、processing state 和时间。OIDC JWT、raw status/webhook/REST、Environment Secret、Action output 和 token 没有序列化入口。`pnpm run e2e:test-deployment` 先读取 Case 8，再用同一只读 test-deployment status adapter 重算 exact Deployment/latest status，并复用 GitHub Actions parser 核对 `deployment` event、Action title/path、completed conclusion 和 exact SHA；manifest 不能覆盖 live projection。

`oidcAuditUrl` 与 `productionSecretIsolationEvidenceUrl` 只是仓库外人工审计索引，不能自动证明云 trust policy 或 Secret 隔离。真实 GitHub/云环境、test-only role/Secret、Environment 配置与 webhook 丢失后的 API compensation 仍需试点外部核对。

## §25. Test acceptance 外部证据

`TestAcceptanceEvidenceManifestV1` 固定三类不同 case：`running`、`passed` 和 `failed`。每条绑定 test Deployment/Evidence、Run/version、Plan/digest、acceptance Attempt、acceptance ID、GitHub Actions run、test Environment URL、固定 `workflow_dispatch` workflow/OIDC subject/audience、Runner result 与独立 test Evidence。`running` 的 Action 必须仍未完成且没有 acceptance Evidence；`passed` 必须同时有 completed/success Action、Runner exit 0 和 verified Evidence；`failed` 或 Runner/Action 冲突必须是 failed Evidence，Run 只能保持 `executing|blocked`。

Case 8 `answers.checks.testAcceptances` 只投影 acceptance snapshot、external state/conclusion、Runner digest/status/exit/duration、OIDC attestation 标量和 Evidence ID；`checks.testAcceptanceObservations` 只投影 signed/API observation 的 source、ID、fact digest、acceptance/run ID、processing state 和时间。`pnpm run e2e:test-acceptance` 读取 Case 8 后复用 `GitHubActionsApiClient.getAcceptanceWorkflowRun()` 重算 Action fact，并核对三条 case 的单 Attempt/Acceptance/dispatch outbox/Evidence。Runner 自报、Deployment success、dispatch response 或 manifest 均不能提前关闭 Item。

`pnpm run e2e:base-rebase` 直接复用 Watt 固定 commit `476e3cdd2490d725fde174e7c697ebf00899edc6` 的显式 opt-in、仓库外 64 KiB manifest、安全错误和 0/1/2 退出语义；HTTP 响应沿用 1 MiB 有界读取。GitHub REST 只能证明当前 ref/ancestry 和 Action inventory，`force=false` 与 blocked `pushEvents=0` 还必须由真实 push webhook/组织审计人工确认，步骤见[Base branch rebase / conflict 外部证据验收](BaseRebaseE2E.md)。

## §26. GitHub merge 外部证据

`MergeEvidenceManifestV1` 固定三条已合并路径和一条 closed-but-unmerged 路径：no-deploy与test policy合并后 Run 必须`succeeded`，production policy合并后只能`deploying`，未合并 PR 不得出现 merge、Evidence 或 merge effect。test的外部deployment/acceptance已经作为required Plan Item在merge gate前闭环，不会在merge后重复dispatch。已合并 case绑定Run/version、Plan/digest、merge gate decision、PR publication、base SHA、`github_merges`、merge Evidence、canonical merge fact及webhook/API observation。

`MergeDeploymentE2EEvidenceManifestV1` 是 E2E-7 的薄组合索引。由于Task environment单选，总manifest固定选择同repository/窗口内不同的test Run与production Run，digest绑定两份Merge Gate和Merge、Test Deployment/Acceptance、Production Approval/Deployment、Feishu Completion八份完整manifest。test lane的时序为deployment/acceptance→gate/merge→succeeded；production lane为gate/merge→approval/deployment→succeeded。组合verifier不接受component verifier注入，逐份调用生产authority后再交叉绑定Run/PR/Plan/merge/deployment与完成卡片。飞书完成态必须latest settled、live rendered digest一致、全部required passed、零blocker/effect/action；详见[合并部署验收](MergeDeploymentE2E.md)。

`ReplayFailureE2EEvidenceManifestV1` 是 E2E-8 的薄组合索引，digest绑定`FeishuIngressEvidenceManifestV1 / FeishuRetryEvidenceManifestV1 / GitHubPullRequestEvidenceManifestV1 / ControlledReplayEvidenceManifestV1`四份完整manifest。Feishu两份component必须同Run/tenant，GitHub replay与controlled recovery必须是另外两个不同Run且同repository。外部`ReplayFailureObservabilityReportV1`固定三条GitHub 202为`applied,duplicate,duplicate`，三条DLQ replay 202为同identity的`created=true,false,false`；报告不能推进业务状态。

callback丢失选择controlled Run的PR publication，Case 8只允许一条applied API observation和零webhook observation。queue replay只能选择controlled effect snapshot已有的`*_dispatch → github_actions` outbox；resolved dead-letter必须exact匹配source attempts、captured/replay/resolved time和`outbox_settled`。组合verifier无component注入，另查GitHub同head/base完整PR inventory；详见[E2E-8重放与故障验收](ReplayFailureE2E.md)。

Case 8 `answers.checks.mergeObservations` 只公开 source kind/id、fact digest、repository/PR number、processing state、固定 ignore reason、merge ID 和 external/observed/processed time；`answers.changes` 的 merge 行只保留 merge ID、Plan/publication、SHA、merged actor/time、deployment disposition 和 Evidence ID。payload、PR 正文、REST response、token、merge outbox 和调用方自报 merge SHA 没有字段。

`pnpm run e2e:merge` 读取最大 64 KiB 的仓库外 manifest，先核对 Case 8，再用生产 `GitHubMergeStatusApiClient` 读取 exact PR。API `merged=true` 的 canonical fact 必须与 manifest/API observation digest一致；`merged=false` 必须保持 `ready_to_merge` 且零 merge projection/effect。控制面/GitHub 响应 1 MiB 有界并拒绝分页，退出码沿用 Watt-derived 0/1/2；完整步骤见[GitHub merge 外部证据验收](MergeE2E.md)。

## §27. Production approval 外部证据

`ProductionApprovalEvidenceManifestV1` 固定 accepted、self-approval rejected 和 merge-binding rejected 三类 production release case。accepted case 绑定当前 Run/Task revision、active Plan/version/digest/base、immutable merge ID/SHA、`environment=production`、external reviewer source/event、human role/separation、`production_release_approval_bindings`、approval lineage 和 expiry；rejected case 必须没有 approval/binding。三类 case 都要求 production outbox、production deployment 和 production Attempt 为零。

Case 8 `answers.checks.productionApprovals` 只投影 release binding 的 approval/Run/revision/Plan/base/merge/environment、expiry、source/event digest、reviewer principal/roles digest、separation 和时间；不返回 approval body、Environment payload、OIDC/JWT、Secret 或 token。verifier 还核对现有 `checks.identityApprovals` 与 `answers.approvals`，再以 `GitHubMergeStatusApiClient` 重算 exact merged PR/merge SHA。`pnpm run e2e:production-approval` 复用 Watt-derived 64 KiB、1 MiB、0/1/2 和固定错误纪律；成功 approval 不会被解释成 deployment 成功，完整步骤见[Production Environment approval 外部证据验收](ProductionApprovalE2E.md)。

## §28. Phase 0 GitHub CI 外部证据

`CiEvidenceManifestV1` 是仓库外 strict 安全索引，固定且仅允许 `ci_main_success`、`ci_pull_request_success`、`validate_valid_success`、`validate_invalid_failure` 四类唯一 case。每条绑定 repository、run ID/event/completed conclusion、head SHA/branch、workflow path/blob SHA/content digest、display title digest、唯一 job 和可选 canary digest；原始 title、TaskEnvelope、workflow/log/API response、token 和 canary 明文都没有 schema 字段。invalid case 必须携 canary digest，其余 case 必须为 null。

`pnpm run e2e:ci` 先按 run 的 exact head SHA 用 GitHub Contents API 读取 workflow blob，重算 content digest并解析 YAML，要求 trigger、唯一 job、setup/validation 命令与固定 workflow 契约完全一致；所有第三方 setup Action 必须固定到受审的不可变 commit SHA，顶层 `permissions` 必须恰好为 `{contents: read}`。随后复用生产 `GitHubActionsApiClient` 核对 run event/repository/path/head/status/conclusion/title digest。每条 run 必须只有一个与 case 匹配的 job；validate 两条还要求唯一命名 validation step，invalid case 的所有前置 steps 必须成功且 validation step 自身失败。合法校验只允许输出固定 `{valid:true}`，不得输出 Task 派生的去重键或标识；四份 job log 均有界读取并用显式 opt-in canary 扫描。

工具直接沿用 Watt `476e3cd` 的仓库外 64 KiB manifest、显式 opt-in、固定 0/1/2、安全错误、有界 HTTPS 和分页 fail-closed；JSON 1 MiB、单 job log 8 MiB。完整真实步骤见[GitHub CI 外部证据验收](CIE2E.md)。fake API、schema example、本地 `verify`、dry-run 或默认 exit 2 都不能关闭 Phase 0 的真实 GitHub DoD。

## §29. Phase 0 GitHub 仓库初始化外部证据

`RepositoryBootstrapEvidenceManifestV1` 是仓库外 strict 安全索引。`decision` 只保存decision ID/time、确认主体digest和`repository + visibility + defaultBranch + protectionRulesDigest`的selection digest；repository层只保存GitHub numeric ID、owner/type、name/full-name、无query页面URL、visibility/default branch/created time及`archived=false + disabled=false + fork=false`；默认分支必须`protected=true`并绑定exact head SHA。

branch rules按`ruleset ID + type + source type/source + active + parameters canonical digest`排序并整体计算rules digest；raw parameters、rules response、管理token和人审正文都没有manifest字段。repository source必须等于full-name，organization source必须等于owner；Enterprise source保留安全名称并由人工对照。decision确认时间不得早于repository创建时间，evidence记录时间不得早于确认时间。

`pnpm run e2e:repository-bootstrap`先重算manifest rules/selection digest，再用固定argv读取本地`origin`并只接受无credential GitHub HTTPS/SSH URL；随后有界读取GitHub repository、default branch和`rules/branches/:branch`。该 effective-rules endpoint 可能省略 `enforcement` 或返回 `null`，因其只返回已经生效的规则；verifier 将该形态规范化为 `active`，Rulesets API 的显式 `active` 仍按原值核对。repository identity/visibility/lifecycle、branch protected/head和全部active rules必须exact一致；响应1 MiB上限且拒绝下一页。工具只读且沿用Watt-derived显式opt-in/64 KiB/0-1-2/固定错误，完整步骤见[GitHub 仓库初始化外部证据验收](RepositoryBootstrapE2E.md)。exit 0仍须人工核对仓库外用户确认记录，不能由manifest或本地remote替代。

## §30. Runner heartbeat 与 GitHub 最终状态外部证据

`RunnerHeartbeatEvidenceManifestV1`嵌入完整`AnalysisActionEvidenceManifestV1`，因此App installation、固定workflow、唯一Action/job、Task/Plan/context、受审Runner/Codex与Git三联检查继续由Round 102/103 verifier负责，不复制第二套GitHub验证器。新增字段只冻结heartbeat receipt count/digest/generation/首末version与时间/最小最大间隔、reference-only result和一条final applied webhook observation的安全ID/digest/time。

`pnpm run e2e:runner-heartbeat`重新读取`GET /v1/runs/:runId/plan`和Case 8。每个receipt必须版本连续、前一heartbeat时间与上一条衔接、间隔在30000～60000ms、lease expiry恰好晚90000ms；至少两条receipt，且canonical receipts digest必须与manifest一致。completed analysis Attempt的最终Runner version必须是末条receipt version + 1，result必须为sequence 1、exact active Plan ref/digest并在末次heartbeat之后上报。

最终GitHub投影必须是同一Action run的`completed/success`、exact `updated_at`和正数observation version；manifest指定的signed webhook delivery必须在Case 8中为唯一`webhook + applied + ignoreReason=null`记录，并绑定同repo/run/attempt/final external time。嵌入的Analysis Action verifier同时实时读取GitHub Actions API，因此webhook、D1 projection与API三方一致，任一面都不能由manifest自报替代。manifest、查询和成功摘要都不含token/digest、raw webhook/REST、Task/Plan正文或Runner输出；完整步骤见[Runner heartbeat 与 GitHub 最终状态真实验收](RunnerHeartbeatE2E.md)。

## §31. GitHub / Cloudflare 平台边界外部证据

`PlatformLimitsEvidenceManifestV2`固定GitHub Actions与Cloudflare Workflows官方文档的official repo、path、受审commit和Git blob SHA；manifest不能选择latest branch或第三方网页。V2把GitHub边界升级为`github.account={type:user|organization,login}`和同类型`accountPolicy`，并要求repository owner等于account login；历史V1只保留parse-only兼容，不能进入新的live verifier。`pnpm run e2e:platform-limits`每次从GitHub Contents API读取两个immutable blob，重算content digest并解析规定的时长、matrix、并发、大小、速率、保留和step/state限制。Cloudflare同一受审文档的规范表格写50,000 active instances、后文却写10,000；两处必须同时存在并显式输出conflict，不能静默选一个数字。

GitHub account token使用API version `2026-03-10`，先从`GET /users/{login}`核对`User|Organization`。组织模式读取org Actions policy和`/organizations/{login}/settings/billing/usage`；个人模式读取repository Actions policy和`/users/{login}/settings/billing/usage`，后者需要用户`Plan: read`（classic为`user` scope）。组织usage item必须有exact `organizationName`；个人item必须没有该字段、有`repositoryName`，带owner时必须等于account。逐日usage item再按date/SKU/unit/price聚合并丢弃repository明细，成功manifest只保存规范化policy/Actions usage digest、计数、unit type、quantity和gross/discount/net amount，不保存raw账单。并发由固定空权限hosted-runner workflow的全部job `started_at/completed_at`跨run重算最大overlap，总job必须大于独立review的`reviewedAccountLimit`且二者相等；时长由固定360分钟timeout、唯一370分钟sleep job的live failure和355～370分钟时间线证明。verifier只读，不触发这两个计费probe。

GitHub App权限/`workflow_dispatch`/signed `workflow_run`语义直接重新运行`RunnerHeartbeatEvidence`链；Cloudflare create/`sendEvent`/在途Worker升级直接重新运行`WorkflowHibernateEvidence`，restart直接重新运行`ControlledReplayEvidence`。主manifest只绑定三份子证据ID、repository、Cloudflare account digest及Paid plan人工review URL，不能复制子结论自报。四份manifest各限64 KiB，所有HTTP响应限1 MiB，退出码沿用Watt-derived 0/1/2；完整预算、采集和人工关门步骤见[平台边界真实验收](PlatformLimitsE2E.md)。

## §32. 飞书 webhook 外部证据契约

`FeishuWebhookEvidenceManifestV1`固定一条challenge、一条成功event和`invalid_signature/expired_timestamp/wrong_tenant`各一条负向case；应用必须是encrypted/active并绑定飞书developer console review链接。独立`FeishuWebhookObservabilityReportV1`必须有exact五条HTTP安全投影、自包含canonical digest、challenge不超过1秒且event/rejection不超过3秒；verifier再按四个tenant/event索引读取operations投影，要求正向唯一delivery/ingress和至少一个nonce，负向receipt/nonce/ingress/Task/Run/outbox effect全零。

`pnpm run e2e:feishu-webhook`严格只读，manifest与外部report均视为不可信索引；observability URL须与独立配置exact一致，callback须绑定控制面origin和固定path。飞书后台日志没有机器可读历史查询API时，`SUCCESS`链接/reviewer/time仍是强制人工证据。完整步骤见[飞书 challenge、事件验签与拒绝零写入真实验收](FeishuWebhookE2E.md)。

## §33. requirement / bug 到 Draft PR 的试点证据契约

`DraftPrCasesEvidenceManifestV1`固定两条且只允许按顺序出现`requirement + prd`与`bug + user_feedback`。两条必须绑定同一试点repository/base branch，但Task、Run、Action run、final head、branch与PR number均不同；每条都冻结Task source revision/digest、active Plan/version/digest/base、全部实际required Item的verification decision、唯一required change Item、从Plan base启动的initial `implement` Attempt、targeted→required test suite、canonical changed-files digest和完整`GitHubPullRequestEvidenceManifestV1`。required Item至少一个；小改动可由唯一change Item自验证，不要求空的类别占位，但额外required Item一旦存在就必须全部passed并参与验收覆盖核对。review-fix由E2E-4独立验收，不能替代E2E-3首次ready领取。

`pnpm run e2e:draft-pr-cases`不引入新真源。它从Task GET核对intent与acceptance count，从Plan GET核对required Item全部passed、验收标准完整覆盖及change Item的exact `repo_write + targeted/required commands`。Case 8报告新增的`attempt.claimedProgressVersion`与`repositoryWriteCredential.createdAt`只是安全历史标量；组合层在重算report digest后要求Task允许写、latest exact飞书mapped-human approval具备source/lineage/event/role digest并绑定Task revision/Plan/version/digest/base/effect、Attempt从ready领取、credential只绑定同repo/Attempt/Plan/Item/approval且在commit时有效、approval覆盖到PR publication，并核对唯一commit/command/Evidence/Item verification与零merge/deployment。随后以GitHub Actions run/job核对固定`Delivery Agent`执行步骤，以compare API要求base→head恰好ahead 1/behind 0/单commit并重算文件digest，最后直接复用既有Draft PR verifier核对同approval publication、webhook/API observation和live `open + draft` PR。五方任一漂移均失败；approval日后自然过期不否定已冻结的历史effect时间线。

manifest最多64 KiB，HTTP响应最多1 MiB并拒绝下一页；控制面/GitHub read token和synthetic canary只进入当前进程，所有响应在JSON parse前扫描，错误只返回固定code。0表示live绑定通过，1表示schema/事实/安全失败，2表示未opt-in、配置缺失或manifest不可读。exit 0不能自证PRD语义或bug根因；真人仍必须分别复核原始需求、诊断、diff、测试与PR并记录外部证据。完整步骤见[requirement / bug 到 Draft PR 的真实外部证据验收](DraftPrCasesE2E.md)。

## §34. Correlation 平台 telemetry 外部证据契约

`CorrelationPlatformEvidenceManifestV1`固定十条有序lookup：Task、Run、Attempt、GitHub run、repository-scoped PR、test/production deployment、两个repository-scoped GitHub Deployment及tool trace。每条只保存exact lookup、观察时间、strict structured-log canonical digest和Cloudflare worker trace ID；lineage另绑定一个GitHub Action/PR、test/production Deployment与SHA。manifest没有query URL、请求/响应、正文、token或raw error字段。

`pnpm run e2e:correlation-platform`逐条读取`GET /v1/correlations`并要求所有列表`truncated=false`，再实时读取四个GitHub对象；随后直接调用Cloudflare官方telemetry query API，各执行十次`dry=true`的`events`与`traces`查询。event必须是exact account/service/trace/time、`truncated=false`且source digest一致；trace必须覆盖日志时间、service一致、至少一个span且无error。任一D1/GitHub/log/trace单源都不能替代其余三方。

生产日志只由统一secure structured sink发出；`matchedByKind/matchedById/matchedByRepository`来自strict query parse，不记录完整URL。Wrangler固定persisted 100% logs/traces并关闭invocation logs；七天窗口和成本扩容前仍需人工review。CLI沿用Watt-derived 64 KiB、1 MiB、10秒、0/1/2与parse前secret scan，完整步骤见[Correlation 平台日志与 trace 真实外部证据验收](CorrelationPlatformE2E.md)。

## §35. E2E-1 飞书需求组合证据契约

`RequirementE2EEvidenceManifestV1`固定`scenario=E2E-1`，以canonical digest引用完整`MeegleWorkItemEvidenceManifestV1`、`AnalysisActionEvidenceManifestV1`与`FeishuCardActionEvidenceManifestV1`，不复制三者的业务投影。主lineage只保存repository、Meegle event/work-item、Task/revision/digest、Run/version、Workflow instance、Plan/version/digest/base、analysis Attempt/Action及一条飞书approval安全ID；任一子manifest改变先触发digest失败。

组合verifier要求Meegle mapped Task与analysis Task完全相同，`run_id = workflowInstanceId`，analysis分类固定`prd + requirement`，且卡片唯一`approve` success必须是mapped human对同一Task/Run/version/Plan/base的`repo_write` decision。系统没有第二条Plan approval：同一`approvals`记录通过exact Plan/version/digest/base批准计划快照，并通过`effect=repo_write`批准effect；summary的两个approved维度不能解释成两条decision。

`pnpm run e2e:requirement`逐份调用既有verifier，复读当前Case 8要求Run仍`awaiting_approval`、exact approval唯一、只有settled analysis dispatch且零write credential/change/deployment，再只读Cloudflare live `delivery-run/instances/:runId`并要求`waiting`、version和start exact一致。四份仓库外manifest各限64 KiB，外部响应限1 MiB/10秒并在JSON parse前扫描用途隔离token和synthetic canary；CLI没有POST、Workflow mutation、repo write或卡片发送路径。完整步骤见[E2E-1飞书需求真实外部证据验收](RequirementE2E.md)。

## E2E-5 双层恢复组合证据

`DualRecoveryEvidenceManifestV1`不创建新的Run或恢复状态，只以canonical digest引用完整的`WorkflowHibernateEvidenceManifestV1`与`RunnerRecoveryEvidenceManifestV1`。两个component必须属于同一repository和受审环境/时间窗，但Run、Evidence和三条Action identity必须全部不同；这是因为hibernate验收终点是`awaiting_approval + Workflow waiting`，Runner replacement验收终点通常已继续到`succeeded`，不能用同一Run同时伪造两个互斥投影。

Runner component把既有恢复实现的安全前置提升为外部验收authority：Plan必须显示lost Attempt generation从kill前值恰好提升一代；Case 8完整报告必须canonical重算，旧Attempt全部grant均有`revokedAt`，唯一`workflow_cancel`与全部effect outbox settled，replay为空；correlation的PR/deployment inventory完整不分页；GitHub compare必须从checkpoint恰好前进一个result commit。Workflow component同样重算Case 8并明确拒绝任一controlled replay/restart替代普通hibernate。两者所有外部读取均使用10秒timeout、有界response、分页fail-closed及parse前credential-shaped canary扫描。

`pnpm run e2e:dual-recovery`读取三份仓库外64 KiB manifest并完整调用两个既有verifier。它是只读组合关口，不执行Worker发布、Workflow restart、Runner kill/retry、dispatch、Git提交或部署；默认exit 2、fake API、本地测试和dry-run不能替代真实平台事实。操作步骤见[双层恢复真实外部证据验收](DualRecoveryE2E.md)。

## §36. E2E-6 权限与 Prompt Injection 组合证据契约

`PermissionInjectionEvidenceManifestV1`不建立新的授权状态，只以canonical digest绑定完整的`FeishuCardActionEvidenceManifestV1`、`ProductionApprovalEvidenceManifestV1`、`AnalysisActionEvidenceManifestV1`、`TestDeploymentEvidenceManifestV1`和`SecretSafetyEvidenceManifestV1`，并补充一份原始挑战`TaskEnvelopeV1`与跨repo OIDC probe identity。组合verifier固定调用生产authority，公开options不得接受component verifier、summary或pass/fail注入。

Feishu拒绝case `role_revoked/unauthorized_account`必须额外保存安全枚举`attemptedCommand=approve`与`attemptedEffect=repo_write`；其他拒绝case不得携带这两个字段。独立observer report、manifest、人工actor mapping review与operations投影必须交叉一致，两个case均只能有verified delivery，action receipt/outcome、ingress与business effect为0。此绑定证明被拒的是未授权repo write，而不是仅凭scenario名称自报。

恶意Task挑战仍走正常intake/analysis：控制面重算revision digest和稳定Task/Run ID，live Task policy必须禁止repository/test/production write，active Plan effect只能来自`repo_read/logs_read/database_diagnostic`，Case 8只能有analysis Attempt且write credential/change/deployment/写部署outbox均为空。不得用关键词过滤正文冒充安全；安全判据是自然语言没有改变policy、credential、Plan effect或外部side effect。

跨repo probe固定从不同repository的immutable Action获取audience=`delivery-loop-test-deploy`的真实OIDC，调用component中exact test deployment的attestation API。只有`403 + policy_denied + retryable=false`才允许输出唯一固定marker；workflow/script blob、manifest外release contract digest、唯一成功job与完整log必须重验。marker与合法同repo Test deployment component共同回答“拒绝且无新增attestation/deployment”，任何一方不能单独关门。所有控制面/GitHub/PR/Action log读取10秒、有界、分页fail-closed，并在JSON parse前扫描全部短期credential和仓库外canary。完整步骤见[E2E-6权限与Prompt Injection真实外部证据验收](PermissionInjectionE2E.md)。

## §37. GitHub App transport 诊断外部证据契约

`GitHubAppTransportDiagnosticEvidenceManifestV2`只索引一条已经结束的GitHub base readiness失败：固定
repository owner actor、main head、workflow run/attempt 1、preflight/readiness job与exact job window；
公开summary只能是`503 + ready=false + credential_transport_unavailable + requestAttempts=1 + no-store`。
Cloudflare部分只保存account digest、script、当时100% deployment/version及同一window；diagnostic只保存
strict structured-log digest、16位worker invocation ID、observed time和五类allowlist failureKind。raw log/error、
App/installation ID、JWT/key/token、response、account ID或带query URL没有字段。

`pnpm run e2e:github-app-transport-diagnostic`先核对exact固定workflow的run和两个jobs，再有界读取唯一
readiness job log；随后证明manifest deployment是job开始前最后生效版本且窗口内零deployment，最后对
Cloudflare telemetry各执行一次`dry=true` events/invocations查询。event必须是exact
service/requestId/event/component/operation/requestAttempts的唯一未截断strict record，并要求
`$metadata.requestId == $metadata.rayId == $workers.requestId`且`$metadata.type=cf-worker`；invocation查询必须
以同一request ID唯一找回该strict record。v1的32位`workerTraceId`与`cf-worker-log`冻结假设不再作为
production成功判据。三枚GitHub/deployment/observability read token必须互异；64 KiB manifest、1 MiB响应、
10秒timeout、parse前Secret scan和Watt-derived 0/1/2纪律保持不变。exit 0只证明该次失败的live
failureKind，不证明readiness 200或产生任何修复/Task/Action/deploy authority；完整步骤见
[GitHub App installation-token transport 诊断外部证据验收](GitHubAppTransportDiagnosticE2E.md)。
