# PROGRESS（Loop 进度与证据账本）

> 每轮只追加事实和可重跑证据。Secret、完整飞书正文、数据库行和原始生产日志不得写入本文。

## 当前状态

- **当前 Phase**：按 Phase 顺序回到 Phase 1 的真实平台关门。首个未完成父项是 `DeliveryRunWorkflow` 在真实 Cloudflare hibernate/redeploy 后复用成功步骤，并以唯一 GitHub analysis Action 证明 dispatch 只发生一次。
- **已完成**：Phase 0 的本地契约、真实 `main/pull_request/workflow_dispatch` Actions、个人公开远端、protected `main`、仓库bootstrap及六项通用子证据均已验收；通用父项仍是跨Phase总门槛，保持未勾。Phase 1～7已有大量本地D1/workerd/安全边界及strict外部证据verifier，精确完成状态只以 `DOD.md` 复选框为准，不能由本摘要提前升级。
- **未验证外部能力**：已选Cloudflare账号尚无本项目Worker/Workflow/D1/R2/Queue；GitHub App selected-repository installation、控制面HTTPS部署、真实analysis/heartbeat Action、飞书/Meegle tenant、真实tool-bridge、有效非交互Agent模型调用、测试/生产部署与七天试运行均未完成。
- **下一目标**：取得明确外部写入与预算授权后，按 [`WorkflowHibernateE2E`](docs/WorkflowHibernateE2E.md) 创建最小测试资源并完成Phase 1真实hibernate/redeploy；授权前继续关闭不依赖真实平台写入的通用Phase门槛，不把dry-run或默认exit 2当成功。

## Blockers / 待用户决策

- 已确认目标Cloudflare账号为`b8488957e88658039d2a38fb8f160514`；Round 142只读复核仍无本项目D1/R2/Queues/Workflows/Worker，且尚未明确批准创建资源、部署控制面或使用测试预算；`wrangler.jsonc`的D1 ID仍是占位值。
- GitHub App owner、最小permissions、selected单仓库installation、installation audit token签发审计和Actions预算尚未授权；Round 142当前用户OAuth无法读取installation inventory，仓库也没有`Delivery Agent` run，公开仓库存在不等于App authority存在。
- 本机锁定版Codex曾被provider以`invalid_api_key`拒绝；重新认证属于用户credential authority，仓库代码不能生成、替换或输出该Secret。
- 真实飞书/Meegle tenant与应用owner/scopes、tool-bridge测试BaseURL/broker scope/SK撤销、测试部署Environment/OIDC/云审计及生产lane治理仍待外部决策和配置。
- hosted runner饱和并发与约6小时duration probe、Cloudflare Paid Workflows限制演练和七天试运行都会产生费用/外部影响，必须另行批准预算；默认exit 2与本地fake均不是完成证据。

## 外部前置核对

- GitHub：用户已确认并创建 `evilstar9527/delivery-loop` public，`main`受保护；真实CI、validate-task与repository bootstrap已通过，详见Round 132～134。
- Cloudflare：用户已选择账号；Round 135/138只读确认本项目Worker/Workflow/D1/R2/Queue均不存在，dry-run bundle可构建。账号选择没有被解释成资源写入、部署或费用授权。
- 其余：GitHub App、Actions预算、飞书/Meegle、tool-bridge、Agent认证、部署Environment与合规/数据驻留仍按 [DOD §10](DOD.md#10-外部前置与人工决策) 逐项补齐。

## Round 日志

## Round 1 — 2026-07-24
- 目标：Phase 0 / DOD 初始化与本地可执行契约。
- 前置与权限：仅本地文件系统和 npm registry；未创建远端、未调用飞书/tool-bridge、未运行 Agent。
- 动作：
  - 从 tool-bridge 的初始 DOD 架构提炼 `docs + DOD + LOOP + PROGRESS + llmdoc` 真源分工；
  - 建立 TaskEnvelope v1、稳定 revision 去重键、Run 状态机及正反单测；
  - 建立最小权限 CI、Task contract workflow、ESLint/TypeScript/Vitest 和文档链接校验；
  - pnpm 11 的 `pnpm verify` 与内置命令冲突，统一改为 `pnpm run verify`；按 pnpm 11 配置只允许 esbuild 安装脚本。
- 验证：
  - `pnpm install && pnpm run verify` → exit 0；typecheck/lint 通过，2 个 test files / 7 tests 通过，文档链接通过。
  - 合法 TaskEnvelope 运行 `pnpm validate:task` → exit 0，只输出 `valid + dedupeKey`；缺字段信封 → exit 1。
  - 文档边界核对 → `Architecture §0/§2/§5` 回答控制面和恢复，`Proto §3.3/§5` 回答 Secret 交换，`Security §7` 回答人审 effect。
- 勾选：Phase 0 本地 verify、TaskEnvelope、Run 状态机、文档边界 4 项。
- 决策沉淀：默认架构为持久控制面 + 临时 Action attempt + tool-bridge context grant；MVP 推荐止于 Draft PR，生产部署不默认自动化。
- 遗留：Phase 0 的远端 repo、真实 CI、真实 `validate-task.yml` 仍未完成；等待 GitHub owner/name/visibility。

## Round 2 — 2026-07-25
- 目标：DOD §1 契约一致——把任务级 DoD、持久编排、回放与 Agent 恢复的既定决策同步到规范/DOD；不提前实现或勾选 Phase 1。
- 前置与权限：只读检查 Cloudflare 官方文档与本地 Watt commit `476e3cd`；未部署、未触发 GitHub Action、未调用飞书/tool-bridge、未写 Watt。
- 动作：
  - 默认控制面确定为 Cloudflare Worker + Workflows + D1 + Queues/transactional outbox + R2；Temporal + Postgres 仅作平台/合规替代。
  - 新增 `ExecutionPlan v1`、PlanItem/Progress、计划版本/digest/base SHA/effect 审批绑定、Workflow input/signal/replay 契约；`run_id` 直接作为 Workflow instance id。
  - 将恢复拆为两层：Cloudflare Workflows 恢复控制流并复用成功持久步骤，Git + Agent checkpoint 恢复一次 GitHub attempt；D1 保持对外业务状态和长期审计真源。
  - 将 Phase 1～7/E2E 验收改为先只读分析生成计划，再按 ready DoD Item 执行并以核对 Evidence 关门；补 pending→delivering→settled、lease generation/fencing、R2 保留和受控 replay 负向要求。
  - Watt 可复用结论入 Reference：借鉴 Workflow/Signal/correlation/D1 投影和测试接线，不照搬硬编码模板、JSON steps、简单审批或补偿删除。
- 验证：
  - 一致性 `rg` 断言（ExecutionPlan、run_id、Cloudflare 默认栈、三态投递存在；旧自研编排/未决 Cloudflare 宿主措辞不存在）+ `git diff --check` → exit 0。
  - `pnpm run verify` → exit 0；typecheck、ESLint、2 files / 7 tests、Markdown links 全绿。
  - Watt `pnpm --filter @watt/gateway exec vitest run test/workflow-task.test.ts` → exit 0，1 file / 11 tests；同时观察到 Miniflare 强制超时/实例清理的 uncaught exception 噪声，已转化为本项目“非预期 unhandled error 不得假绿”的外部实测要求。
- 勾选：无新增；本轮刷新 Phase 0 已有“文档 review”证据，并细化后续 Phase 的未完成判据。
- 决策沉淀：`docs/{Vision,Architecture,Proto,Security,Reference}.md`、`DOD.md`、`LOOP.md`、llmdoc MUST/code-map 已同步。
- 遗留：ExecutionPlan/Workflow 仍只有规范、没有可执行 schema/runtime；Phase 0 远端 repo/真实 CI/手工 workflow 仍等待 GitHub owner/name/visibility。

## Round 3 — 2026-07-25
- 目标：Phase 1 / `DeliveryRunWorkflow` 的副作用全部在稳定命名 `step.do`；强制 hibernate/restart 后复用成功步骤，dispatch 只发生一次，D1 Run 投影仍正确。
- 前置与权限：仅本地 workerd/Miniflare/D1；读取 Watt commit `476e3cd` 作为实现参考；未部署 Cloudflare、未触发真实 GitHub Action、未创建远端、未调用飞书/tool-bridge。
- 动作：
  - 直接复用 Watt 的 `WorkflowEntrypoint`、稳定 `step.do`、`waitForEvent`、事件名净化、D1 migration setup、`cloudflare:test` introspection 与 `await using` 隔离模式；业务层改为规范化 Task/Run/ExecutionPlan/PlanItem/Attempt/outbox，不复制 JSON steps、硬编码模板、Agent Durable Object 或补偿删除。
  - 新增 `DeliveryRunWorkflow`：`run_id` 作为实例 ID，input 仅传 ID/digest；稳定 analysis attempt/outbox key；result signal 只传 D1 plan ref/digest，计划正文不进入 Workflow history。
  - 新增首版 D1 migration 与 `RunStore`；Workflow register、attempt+outbox、plan activate/Run projection 写入均位于稳定持久步骤，attempt+outbox 使用 D1 batch 和唯一键幂等。
  - 钉死 Watt 已验证组合：Wrangler 4.107.0、Workers types 4.20260702.1、vitest-pool-workers 0.18.0、Vitest 4.1.9；`pnpm run verify` 现在同时跑 Node 单测与真实 workerd Workflow 测试。
  - 初次定向测试在启动前失败：配置 compatibility date `2026-07-25` 超过当前 workerd 支持的 `2026-07-08`；改为 `2026-07-01` 后通过。该失败没有被当作测试成功。
- 验证：
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/delivery-run-workflow.test.ts` → exit 0；1 file / 1 test。真实 `restart({from: await-analysis-result})` 前后 attempt/outbox 均为 1，Run version 保持 1；引用事件到达后实例 complete，D1 Run 为 `awaiting_approval`、version 2、active Plan ref/digest 正确。
  - `pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-dry-run` → exit 0；Worker bundle 成功并识别 `DELIVERY_RUN` Workflow 与 `DB_CONTROL` D1 binding，未发生部署。
  - `pnpm run verify` → exit 0；typecheck、ESLint、Node 2 files / 7 tests、workerd 1 file / 1 test、Markdown links 全绿；无 unhandled error。
  - `git diff --check` → exit 0。
- 勾选：新增 Phase 1 Workflow DoD 的“本地 workerd restart + 单一 dispatch outbox + D1 投影”子项；完整 DoD 保持未勾。
- 决策沉淀：代码落点采用当前单包 `src/{domain,storage,workflows}`，避免在首个纵向切片提前引入 monorepo；D1 保持业务真源，Workflow event 不承载原始需求或 Plan 正文。
- 遗留：尚无 GitHub App dispatcher/真实 Action 外部事实，也未在真实 Cloudflare 账户做 Worker restart；因此不能宣称实际 Action dispatch exactly-once，下一轮继续选择不依赖外部账号的 Phase 1 DoD。

## Round 4 — 2026-07-25
- 目标：Phase 1 / ExecutionPlan v1 校验覆盖 Item ID/依赖无环、至少一条 doneWhen、Evidence 要求、delivery policy command ref、effect 上限、plan version/digest/base SHA 不变量。
- 前置与权限：仅本地 Node/workerd/D1；无网络、部署、GitHub Action、飞书/tool-bridge 或真实凭证副作用。
- 动作：
  - 先写 10 个 ExecutionPlan 正反契约用例；首次定向运行因 `src/domain/plan.ts` 尚不存在而 exit 1，确认测试未误命中旧实现后再实现。
  - 新增严格 `ExecutionPlan v1`/PlanItem schema、canonical JSON SHA-256 digest、稳定 Item ID、依赖存在/无环、doneWhen/Evidence、验收索引、可信 command ref 与 effect ceiling 校验。
  - validator 将 Agent 输出限制为 `proposed`，并绑定可信 run/task revision/base SHA/expected version；未知字段、Agent 自报 `approved/active`、旧 digest 与越权 effect 均拒绝。
  - 新增 `ExecutionPlanStore`：校验通过后才以 `validated` 状态把 Plan、assumption/evidence refs、Item、doneWhen、依赖、effect、command ref、Evidence 要求和 progress 规范化写入 D1；再次核对持久 Run、analysis Attempt、base SHA 与数据库 next version。
  - Workflow 激活只接受 `validated` Plan；相同 proposal 回调幂等，同 plan/version 更换不可变正文返回 `plan_conflict`。D1 穿透还验证非拓扑数组顺序的合法 DAG 可正确持久化。
- 验证：
  - `pnpm exec vitest run test/plan.test.ts` → exit 0；1 file / 10 tests，覆盖本 DoD 全部正反不变量及 Agent 不可自升状态。
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/delivery-run-workflow.test.ts` → exit 0；1 file / 1 test，规范化 Plan 入库、幂等/不可变冲突、Workflow restart 与 validated→active 穿透通过，无 unhandled error。
  - `pnpm run verify` → exit 0；typecheck、ESLint、Node 3 files / 17 tests、workerd 1 file / 1 test、Markdown links 全绿。
  - `git diff --check` → exit 0。
- 勾选：Phase 1 `ExecutionPlan v1` 校验 DoD 完整勾选。
- 决策沉淀：digest 明确排除 `digest/status`、覆盖其余不可变正文；Agent proposal 校验与 D1 持久化分层，`validated` 只表示控制面校验通过，不代表 effect 已批准。
- 遗留：尚无 analysis callback HTTP 路由和真实 Agent 产出；这属于 Phase 1 intake/Runner/外部 Action 条目，不能用本轮领域与 workerd 测试替代。下一轮继续数据库 migration + transactional intake/outbox 的本地 DoD。

## Round 5 — 2026-07-25
- 目标：Phase 1 / 数据库 migration 可从空库重跑；唯一约束证明同一 Task revision 只能创建一个 Task，outbox 与状态在同事务落库。
- 前置与权限：仅本地 workerd/D1；无外部网络、部署、GitHub Action、飞书/tool-bridge 或真实凭证副作用。
- 动作：
  - 先写 migration、20 路并发 revision、静默正文替换与事务故障注入测试；首次定向运行因 `TaskIntakeStore` 尚不存在而 exit 1，随后实现。
  - 提取共用 canonical SHA-256，实现 Task revision digest 与稳定 Task/Run/workflow-create outbox ID；digest 排除 `eventId/occurredAt`，使平台重投与业务 revision 去重分离，revision 正文仍不可原地改写。
  - 扩充规范化 Task 投影与 policy snapshot；新增 `TaskIntakeStore`，使用单个 D1 batch 原子写 Task、`queued` Run 和 `pending workflow_create` outbox，payload 只含 `d1://runs/<run_id>` 引用。
  - source tuple 建立显式 SQL UNIQUE；测试除 20 路 store 并发外，还用不同 `task_id` 直接复制同 revision，D1 明确拒绝，避免把稳定主键误当作 source revision 唯一证据。
  - 用 SQLite trigger 强制 `workflow_create` outbox INSERT abort；D1 batch 抛错后按 source revision 查询 Task/Run/outbox 均为 0，证明真实回滚而非事后补偿删除。
- 验证：
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/task-intake-store.test.ts` → exit 0；1 file / 4 tests，migration 重入、20 路收敛、revision 更新/冲突与事务回滚全部通过。
  - `pnpm run verify` → exit 0；typecheck、ESLint、Node 3 files / 17 tests、workerd 2 files / 5 tests、Markdown links 全绿，无 unhandled error。
  - `git diff --check` → exit 0。
- 勾选：Phase 1 migration/source revision unique/transactional outbox DoD 完整勾选。
- 决策沉淀：`docs/Proto.md` 明确 event delivery metadata 不进入 revision digest；稳定 hash ID 用于并发收敛，SQL source tuple UNIQUE 仍是业务最终裁决。D1 batch 是 Task/Run/outbox 的唯一提交边界，不实现失败补偿删除。
- 遗留：尚未实现 `POST /v1/tasks` 的 HTTP Idempotency-Key 语义和 workflow-create outbox consumer；分别属于后续两个 Phase 1 DoD，不能用 store 层测试替代。

## Round 6 — 2026-07-25
- 目标：Phase 1 / `POST /v1/tasks` 对合法 TaskEnvelope 返回 202；同 `Idempotency-Key` 并发 20 次仅一条业务记录，响应指向同一 task/run。
- 前置与权限：仅本地 workerd/D1/R2；使用明确的测试 Bearer fixture，不是生产 Secret；未部署、未调用 GitHub/飞书/tool-bridge 或真实外部资源。
- 动作：
  - 先写真实 `SELF.fetch` HTTP 正反测试；首次运行 4/4 失败于 `idempotency_keys` 表不存在，随后实现而非修改测试绕过。
  - 直接复用 Watt 已验证的 Hono 4.12.27 Worker、统一安全错误和 `cloudflare:test` SELF 穿透结构；新增 fail-closed Bearer 服务认证、256 KiB body 上限、TaskEnvelope 规范化和通用 DeliveryError 响应。
  - 新增只存 key digest 的 idempotency reservation；reservation、Task、queued Run 与 workflow-create outbox 位于同一 D1 batch，后三条 INSERT 仅在 reservation request digest 匹配时执行。同 key 换 payload 返回 409 且不创建第二套记录。
  - API 成功接受 D1 事务后，把规范化 TaskEnvelope 写入稳定私有 R2 key；D1/outbox/API 只暴露引用、task/run ID 和 digest。R2 失败返回可重试 503，同 key 重试可补写同一对象，不做补偿删除。
  - Run 的 base SHA 改为 intake 阶段可空：API 不信任客户端自报 SHA；analysis dispatch 前必须由后续受信 GitHub adapter 解析，已有 Workflow test 仍使用固定可信 SHA。
  - 负向测试覆盖未认证、缺 key、非法 Task、正文 canary 不回显；outbox 故障注入同时证明 idempotency reservation/Task/Run/outbox 全部回滚。
- 验证：
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/task-api.test.ts` → exit 0；1 file / 4 tests，20 路 HTTP 并发、完成重放、key/payload 冲突与安全负向路径通过。
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/task-intake-store.test.ts` → exit 0；1 file / 4 tests，含 idempotency reservation 随 outbox 故障原子回滚。
  - `pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-dry-run` → exit 0；Hono Worker bundle 成功并识别 Workflow、D1、R2 bindings，未部署。
  - `pnpm run verify` → exit 0；typecheck、ESLint、Node 3 files / 17 tests、workerd 3 files / 9 tests、Markdown links 全绿，无 unhandled error。
  - `git diff --check` → exit 0。
- 勾选：Phase 1 `POST /v1/tasks` + 20 路 Idempotency-Key DoD 完整勾选。
- 决策沉淀：`docs/Proto.md` 与 `docs/Security.md` 明确服务认证、202/409、key digest、R2 正文边界和 base SHA 信任来源；Idempotency-Key 只约束请求重放，不承担授权。
- 遗留：workflow-create outbox consumer 尚未实现，且 API Run 暂无 base SHA，不能提前启动 analysis Workflow；下一轮实现可重放 Workflow create 投递，并为受信 base SHA resolution 保留明确阻断。

## Round 7 — 2026-07-25
- 目标：Phase 1 / Run create outbox 以 `run_id` 幂等创建 Cloudflare Workflow instance；D1 已落库/Workflow create 或 sendEvent 失败可重放，不无条件删除业务记录、不产生重复实例。
- 前置与权限：仅本地 workerd/Workflows/D1/Queue 模拟；未部署真实 Cloudflare 账户、未调用 GitHub/飞书/tool-bridge，无生产 Secret。
- 动作：
  - 先写 Workflow create/signal outbox 的并发、失败、不确定结果和真实 Workflows 穿透测试；首次运行因模块不存在而 exit 1，随后实现。
  - 直接复用 Watt 的 pending → delivering → settled、投递失败 rollback 模式，并扩展 D1 lease token/expiry/fencing；20 个 consumer 并发 claim 同一 create outbox 时只有一个 attempt，settle 后重放不再触发 effect。
  - 新增 Cloudflare Workflow effect adapter：`id = run_id` create；create 抛出不确定错误后查 instance status，实例已存在则按幂等成功收敛，status unknown 才重试。
  - 新增规范化 `workflow_signals` 与 signal outbox；现有 DeliveryRunWorkflow 测试不再直接 `sendEvent`，而是 signal + outbox 落 D1 后由真实 adapter 投递，成功推进 validated Plan。
  - create/sendEvent 失败均把 outbox 回 pending、保留 Task/Run；过期 delivering lease 可由新 token 接管。API Run 缺受信 base SHA 时不调用 create，记录 `base_sha_unresolved` 等待后续 GitHub resolver。
  - Worker 增加 Queue producer/consumer 与每分钟 reconciliation relay：relay 只投递 outbox ID，Queue consumer 执行 fenced processor，重复 Queue 消息安全。
  - 中间一次定向运行首例通过、后续 4 例因测试 cleanup 先删 Run、未先删 Workflow 创建的 Attempt 而 FK 失败；修正测试依赖清理顺序后全部通过，没有把 harness 失败伪装为业务成功。
- 验证：
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/workflow-outbox.test.ts` → exit 0；1 file / 6 tests，覆盖 20 路 create、失败重放、base SHA 阻断、过期 lease、ambiguous create reconciliation、sendEvent 重放。
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/delivery-run-workflow.test.ts` → exit 0；1 file / 1 test，真实 signal outbox → sendEvent → Workflow complete/D1 projection 穿透通过。
  - `pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-dry-run` → exit 0；bundle 成功并识别 Workflow、Queue、D1、R2 bindings，未部署。
  - `pnpm run verify` → exit 0；typecheck、ESLint、Node 3 files / 17 tests、workerd 4 files / 15 tests、Markdown links全绿，无 unhandled error。
  - `git diff --check` → exit 0。
- 勾选：Phase 1 Workflow create/sendEvent replay DoD 完整勾选。
- 决策沉淀：`docs/Architecture.md`/`docs/Proto.md` 明确 Queue relay、lease/fencing、ambiguous create reconciliation、signal outbox 与 base SHA 阻断；普通失败只回 pending，不做业务补偿删除。
- 遗留：真实 GitHub base SHA resolver、Cloudflare 账户限制实测和真实 Action dispatcher 尚未完成；无 base SHA 的 API Run 会安全保持 pending。下一轮继续本地 CAS/lease generation 并发 DoD。

## Round 8 — 2026-07-25
- 目标：Phase 1 / 状态迁移使用 compare-and-set；两个并发 worker 争抢同 attempt 时只有一个拿到带 lease generation 的写租约。
- 前置与权限：仅本地 workerd/D1；读取 Watt commit `476e3cd` 的 D1 条件写和三态投递实现；未部署、未触发 GitHub Action、未调用飞书/tool-bridge，无真实凭证。
- 动作：
  - 先写 Run 双 worker CAS、20 路同 attempt 租约竞争、过期 generation 接管/旧 heartbeat fencing、同 Run 不同 write attempt 互斥测试；首次定向运行因 `AttemptLeaseStore` 不存在而 exit 1，随后实现。
  - 直接复用 Watt D1 provider 的 `UPDATE ... WHERE version = expected` + `meta.changes === 0 → conflict` CAS 骨架，并复用前轮三态投递中的 token/expiry fencing；Watt 没有 attempt lease-generation 模块，未伪装为整模块复制。
  - `attempts` 增加 version、lease token digest、expiry 与 active write lease 查询索引；领取使用单条条件 UPDATE，同时排除同 Run 其他未过期 write attempt，每次成功领取递增 version 与 generation。
  - heartbeat 同时校验 status、version、generation、token digest 与未过期边界；明文 token 只返回给胜出 worker，D1 仅保存 SHA-256 digest。过期后新 generation 可接管，旧 Runner 即使按当前 version 重试也因 generation/digest 不符被拒。
  - `RunStore.transition` 先调用领域状态机校验边，再以 state + version CAS；Workflow register 固定初始 version，Plan 激活 batch 以读取到的 Run version fencing，避免零行更新误报成功。
- 验证：
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/lease-cas.test.ts` → 首次 exit 1（模块尚不存在）；实现后 exit 0，1 file / 4 tests。
  - `pnpm run typecheck` → exit 0；`pnpm run lint` → exit 0。
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/delivery-run-workflow.test.ts test/workflow/workflow-outbox.test.ts` → exit 0，2 files / 7 tests，既有 restart/outbox 恢复路径无回归。
  - `pnpm run verify` → exit 0；typecheck、ESLint、Node 3 files / 17 tests、workerd 5 files / 19 tests、Markdown links 全绿。
  - `git diff --check` → exit 0。
- 勾选：Phase 1 Run CAS + attempt lease generation DoD 完整勾选。
- 决策沉淀：`docs/Proto.md`、`docs/Architecture.md`、`docs/Security.md` 明确 CAS 成功判据、同 Run 单 active write lease、token 摘要与 generation/expiry fencing；按用户要求不额外更新 llmdoc。
- 遗留：本轮尚未接 Runner HTTP heartbeat/exchange/OIDC；这些仍属于后续 Phase 1/3 条目，不能用 store 测试代替。下一轮选择不依赖外部账号的安全查询 API DoD。

## Round 9 — 2026-07-25
- 目标：Phase 1 / 飞书尚未接入时，`GET /v1/tasks/:id` 与 `GET /v1/runs/:id/plan` 能返回 run/plan item/attempt/checkpoint/evidence 安全摘要，且不依赖 Workflow `status()` 作为业务真源。
- 前置与权限：仅本地 workerd/D1/R2 测试 binding；复用 Watt 的 Hono、统一安全错误和 `SELF.fetch` 穿透结构；未部署、未调用 Workflow status、GitHub、飞书/tool-bridge，无真实凭证。
- 动作：
  - 先写认证、200/404/非法 ID、空 Plan、完整 Plan/Item/Attempt/checkpoint/Evidence 投影与多处 canary 不泄漏测试；首次定向运行 3/3 因 `evidence` 表不存在而 exit 1，随后补 migration 与查询实现。
  - 新增 checkpoint/Evidence D1 规范化投影；R2 继续保存完整 payload，D1 只持恢复/核对/查询需要的结构化字段、digest 和 ref。
  - 新增只依赖 `DB_CONTROL` 的 `TaskQueryStore`：Task 查询不读 R2 正文；Plan 查询返回 Item progress、Attempt 和每个 Attempt 最新 checkpoint；类构造函数没有 Workflow binding，因此不能把 `status()` 当业务真源。
  - GET 路由复用 Phase 1 fail-closed Bearer 服务认证、Hono 错误形状和 ID 白名单。响应主动排除 Task description/acceptance criteria/actor/R2 ref、checkpoint summary/nextStep/payload ref、Evidence summary/artifact ref、lease token digest；HTTPS 外链移除 query/fragment。
  - 首次静态检查中 typecheck 因泛型 `optional<T>` 写索引在 TypeScript 5.9 下被拒而 exit 2；收窄为 `Record<string, unknown>` 后通过，没有把 workerd 行为测试替代类型关口。
- 验证：
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/task-query-api.test.ts` → 首次 exit 1（缺 evidence 表）；实现后 exit 0，1 file / 3 tests。
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/task-api.test.ts test/workflow/task-intake-store.test.ts` → exit 0，2 files / 8 tests，既有 intake/事务路径无回归。
  - `pnpm run typecheck` → 首次 exit 2（TS2862），修正后 exit 0；`pnpm run lint` → exit 0。
  - `pnpm run verify` → exit 0；typecheck、ESLint、Node 3 files / 17 tests、workerd 6 files / 22 tests、Markdown links 全绿。
  - `pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-dry-run` → exit 0；Worker bundle 成功识别 Workflow、Queue、D1、R2 bindings，未部署。
  - `git diff --check` → exit 0。
- 勾选：Phase 1 Task/Plan D1-only 安全查询 DoD 完整勾选。
- 决策沉淀：`docs/Proto.md`、`docs/Architecture.md`、`docs/Security.md` 明确查询认证、白名单响应、R2/Workflow 排除边界；按用户要求不额外更新 llmdoc。
- 遗留：checkpoint/Evidence 本轮只有查询投影和测试数据，Runner 写入、sequence CAS、Evidence 外部核对属于 Phase 3/4，不能提前勾选。下一轮只做 GitHub dispatcher 的本地契约切片，真实安装/dispatch 仍需外部前置。

## Round 10 — 2026-07-25
- 目标：Phase 1 / GitHub OIDC exchange 至少校验 issuer、audience、repository、workflow ref、SHA 和 run ID；伪造/过期/其他 repo token 全部拒绝。
- 前置与权限：本地 workerd/D1 与测试专用 RSA key/JWKS；只读访问 GitHub 官方 OIDC discovery；未触发 Action、未安装 GitHub App、未部署、未调用飞书/tool-bridge，无真实 token/Secret。
- 动作：
  - 先写真实 RS256/JWKS 签验、claims 全绑定、伪造/过期/畸形/跨 repo、lease 过期与一次性重放测试；首次定向运行 3/3 因 `attempt_tokens` 不存在而 exit 1，随后实现。
  - 直接复用 Watt 生产 OAuth 的 `jose createRemoteJWKSet + jwtVerify` 骨架，固定 GitHub issuer/audience/RS256；测试用本地 JWKS 仍执行真实非对称验签，不手写/伪造 JWT decode。
  - `attempts` 增加 repository/trusted workflow ref/GitHub run/status 外部事实字段；Workflow 创建 analysis Attempt 时固定目标 repo + `.github/workflows/delivery-agent.yml@refs/heads/<base>`，不从 Runner 请求自报。
  - exchange 在验签后逐项匹配 D1 repository、`job_workflow_ref ?? workflow_ref`、base SHA、GitHub run ID、analysis mode、starting/running 和 active lease；未绑定 run ID 或任一字段不符均 fail-closed。
  - 新增 `attempt_tokens`：同 attempt + lease generation 一次交换，OIDC/opaque token 均只存 digest，TTL 取 5 分钟与 lease 剩余时间较小值，响应 no-store；Phase 1 grant 固定 `repo:read`。
  - 首次静态检查因 `exactOptionalPropertyTypes` 不接受显式 undefined verifier options 而 exit 2；改为 binding 存在才展开字段后通过。
  - 2026-07-25 实读官方 discovery，确认 issuer/JWKS URI、RS256 及 repository/workflow_ref/job_workflow_ref/sha/run_id claims 与实现一致。
- 验证：
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/github-oidc-exchange.test.ts` → 首次 exit 1（缺 attempt_tokens）；实现后 exit 0，1 file / 3 tests。
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/delivery-run-workflow.test.ts test/workflow/task-query-api.test.ts test/workflow/lease-cas.test.ts` → exit 0，3 files / 8 tests。
  - `pnpm run typecheck` → 首次 exit 2（TS2379），修正后 exit 0；`pnpm run lint` → exit 0。
  - `curl -fsSL --max-time 15 https://token.actions.githubusercontent.com/.well-known/openid-configuration | jq ...` → exit 0；官方元数据匹配实现。
  - `pnpm run verify` → exit 0；typecheck、ESLint、Node 3 files / 17 tests、workerd 7 files / 25 tests、Markdown links 全绿。
  - `pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-dry-run` → exit 0；含 `jose` 的 Worker bundle 成功，bindings 正确，未部署。
  - `git diff --check` → exit 0。
- 勾选：Phase 1 GitHub OIDC exchange DoD 完整勾选；真实 Action 身份将在“一个真实 Action”条目另行证明。
- 决策沉淀：`docs/Proto.md`、`docs/Architecture.md`、`docs/Security.md`、`docs/Reference.md` 明确 GitHub 信任根、D1 绑定、一次性交换和只读 scope；按用户要求不额外更新 llmdoc。
- 遗留：GitHub run ID 必须先由 dispatcher/webhook/reconciliation 可信绑定；本轮未实现该外部链路，也未签 tool-bridge SK。下一轮做 Runner heartbeat/result 本地契约，真实 Action 仍需远端前置。

## Round 11 — 2026-07-25
- 目标：Phase 1 / Runner 每 30～60 秒 heartbeat；正常完成写 attempt result，控制面状态与 GitHub run 外部事实一致（本轮只闭环本地控制面子项，完整条目保留未勾）。
- 前置与权限：仅本地 workerd/D1；复用 Round 8 CAS/generation、Round 10 opaque token 与 Round 7 signal outbox；未触发真实 Action/GitHub API、未部署、未调用飞书/tool-bridge。
- 动作：
  - 先写 20 路 heartbeat 并发、token rotation、旧 token/旧 generation/expiry、reference-only complete、untrusted GitHub conclusion canary 和 signal/outbox 原子投影测试；首次定向运行 3/3 因路由不存在返回 404，随后实现。
  - heartbeat 同时验证 opaque token digest/expiry/revocation、Attempt status/version/generation/lease；D1 batch 以 expected version CAS 更新 heartbeat/90 秒 lease并轮换 token digest，20 路只有一胜者。
  - complete 只接收 Plan ref/digest/event/sequence 与 fencing 字段；Referenced Plan 必须属于同 Run、由当前 Attempt 创建且已 validated/active。
  - Attempt result projection、`workflow_signals`、pending outbox、Attempt version 更新和 token revoke 位于单个 D1 batch；成功后 Attempt 仍为 running，GitHub status/conclusion 保持 null，等待 Workflow 和外部事实核对。
  - strict schema 拒绝 Runner 自报 `githubConclusion`，错误不回显 canary；旧 token 在 heartbeat 成功或 complete 入账后立即失效。
- 验证：
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/runner-api.test.ts` → 首次 exit 1（3/3 路由 404）；实现后 exit 0，1 file / 3 tests。
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/github-oidc-exchange.test.ts test/workflow/workflow-outbox.test.ts test/workflow/delivery-run-workflow.test.ts` → exit 0，3 files / 10 tests。
  - `pnpm run typecheck`、`pnpm run lint` → exit 0。
  - `pnpm run verify` → exit 0；typecheck、ESLint、Node 3 files / 17 tests、workerd 8 files / 28 tests、Markdown links 全绿。
  - `pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-dry-run` → exit 0；Worker bundle 与 Workflow/Queue/D1/R2 bindings 正确，未部署。
  - `git diff --check` → exit 0。
- 勾选：仅新增 Runner heartbeat/result 本地 workerd 子项；完整 DoD 保持未勾，因为没有真实 Action cadence 和 GitHub webhook/API 外部事实。
- 决策沉淀：`docs/Proto.md`、`docs/Architecture.md`、`docs/Security.md` 明确 token rotation、90 秒 lease、result reported 与 GitHub observed 分离；按用户要求不额外更新 llmdoc。
- 遗留：需要真实 GitHub repo/App/workflow 才能跑 30～60 秒 cadence、可信绑定 run ID 并核对 status/conclusion；这与 dispatcher/真实 Agent/平台限制条目共享同一外部 blocker。

## Round 12 — 2026-07-25
- 目标：Phase 1 / GitHub App 只安装到试点仓库；dispatcher 成功触发固定 workflow ref，dispatch payload 经过测试证明无 Secret/任务正文（本轮闭环本地 dispatcher/REST 子项，完整条目保留未勾）。
- 前置与权限：仅本地 workerd/D1 与 fake GitHub REST；读取 Watt commit `476e3cd`，确认无 GitHub dispatcher 整模块；未安装 App、未调用真实 GitHub write API、未触发 Action、未部署。
- 动作：
  - 先写 20 路 dispatcher 竞争、allowlist、固定 workflow ref、payload canary、失败重放/外部 existing reconciliation 测试；首次定向运行因 `github-dispatcher` 模块不存在而 exit 1。
  - 把 Round 7 从 Watt 复用的 pending → delivering → settled、lease token/expiry、settle/rollback 提取为共享 `FencedOutboxProcessor`；Cloudflare Workflow 与 GitHub dispatcher 使用同一实现，不复制第二套租约协议。
  - GitHub processor 只从 D1 Attempt/Run/Task 投影构造 inputs，不读取 R2 Task 正文；repository 必须命中 allowlist，workflow 固定 `.github/workflows/delivery-agent.yml@refs/heads/<baseBranch>`，control-plane URL 必须是无 user/query/fragment 的 HTTPS origin。
  - 20 路 outbox consumer 只调用一次 effect；外部 run ID 经 `ensureDispatch` 返回后才把 Attempt pending→starting、version/generation 递增并创建启动 lease。失败回 pending，不伪造 starting。
  - 新增 GitHub Actions REST adapter：短期 installation token 只进 Authorization header；dispatch 前按 `run-name = delivery-loop/<attempt_id>` 查询；POST 204 后必须查询到 run ID，existing run 直接复用且不 POST，暂不可见则抛错供 outbox 重试。
  - REST adapter 测试首次因 class 尚不存在 2/6 失败，随后实现为 6/6 通过。中间 lint 因测试未使用常量 exit 1，删除后通过。
- 验证：
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/github-dispatcher.test.ts` → 首次 exit 1（模块不存在）；领域实现后 4/4，通过新增 REST 测试前 2/6 红灯，最终 exit 0，1 file / 6 tests。
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/github-dispatcher.test.ts test/workflow/workflow-outbox.test.ts` → exit 0，2 files / 10 tests，共享 fencing 无回归。
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/workflow-outbox.test.ts test/workflow/delivery-run-workflow.test.ts test/workflow/github-oidc-exchange.test.ts test/workflow/runner-api.test.ts` → exit 0，4 files / 13 tests。
  - `pnpm run typecheck` → exit 0；`pnpm run lint` → 中间 exit 1（unused test constant），修正后 exit 0。
  - `pnpm run verify` → exit 0；typecheck、ESLint、Node 3 files / 17 tests、workerd 9 files / 34 tests、Markdown links 全绿。
  - `pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-dry-run` → exit 0；Worker bundle 与 Workflow/Queue/D1/R2 bindings 正确，未部署。
  - `git diff --check` → exit 0。
- 勾选：仅新增 GitHub dispatcher 本地 workerd/REST contract 子项；完整 DoD 保持未勾，因为没有真实 App installation 与 Actions run URL/API。
- 决策沉淀：`docs/Proto.md`、`docs/Architecture.md`、`docs/Security.md` 记录共享 fencing、固定 workflow/run-name、App token 与 reconciliation 边界；按用户要求不额外更新 llmdoc。
- 遗留：production `GitHubInstallationTokenProvider` 仍需 App id/private key 与试点 installation ID；目标 repo 还需 opt-in workflow。下一轮实现固定 workflow/只读 Runner adapter 的本地契约，外部安装证据待用户输入。

## Round 13 — 2026-07-25
- 目标：Phase 1 / 一个真实 Action 只读检出目标 repo，Agent 按用户反馈/PRD 分析代码并按需使用只读桩上下文，输出带 Evidence refs 的合法 ExecutionPlan；不创建分支、不写 repo（本轮闭环 Codex adapter 本地子项，完整条目保留未勾）。
- 前置与权限：只读查询 OpenAI 官方 Codex 文档、本机 `codex-cli 0.145.0 --help`；未调用模型/API、未触发 Action、未部署；新增同版本 lockfile dependency 只用于 Runner 可复现安装。
- 动作：
  - 按 `openai-docs` skill 先运行 Codex manual helper；官方 manual HEAD 返回 403，随后按 skill 回退到 OpenAI Docs MCP，核对 `codex exec` 非交互、ephemeral、read-only sandbox、output schema/last message、stdin prompt 与 shell environment policy。
  - 先写 read-only 命令形状、可信 identity/digest 注入、越权 effect/额外 identity、CLI stderr canary 和 JSON Schema 边界测试；首次定向运行因 adapter 模块不存在而 exit 1。
  - 新增 `AnalysisPlanContentV1` JSON Schema：Agent 只输出 objective/assumptions/evidenceRefs/items；Runner 注入 plan/run/task/base/attempt identity、计算 canonical digest、固定 proposed，再复用现有 ExecutionPlan validator。
  - Codex 命令强制 `--ephemeral --ignore-user-config --sandbox read-only`、approval never、`project_doc_max_bytes=0`；不使用 yolo/workspace-write。context 以临时文件路径引用，不把正文放 argv/prompt；stderr 不进入抛出错误。
  - 保持 shell 默认 KEY/SECRET/TOKEN 排除并追加 PASSWORD；任务、代码、日志与 context 明确为 untrusted data。输出文件必须在 repo workspace 外，防止 adapter 自身修改目标仓库。
  - 本机 CLI help 确认采用参数存在；`@openai/codex@0.145.0` 写入 devDependency/lockfile，未来 hosted runner 不依赖预装工具。本轮未做计费模型调用，不能冒充真实 Agent 证据。
- 验证：
  - `pnpm exec vitest run test/codex-analysis-adapter.test.ts` → 首次 exit 1（模块不存在）；实现后 exit 0，1 file / 4 tests。
  - `pnpm exec vitest run test/plan.test.ts test/codex-analysis-adapter.test.ts` → exit 0，2 files / 14 tests。
  - `pnpm run typecheck`、`pnpm run lint` → exit 0。
  - `codex --version && codex exec --help | rg -- ...` → exit 0；`codex-cli 0.145.0` 且六个采用参数存在。
  - `pnpm run verify` → exit 0；typecheck、ESLint、Node 4 files / 21 tests、workerd 9 files / 34 tests、Markdown links 全绿。
  - `git diff --check` → exit 0。
- 勾选：仅新增真实 Action/Agent 条目的本地 Codex adapter contract 子项；完整 DoD 保持未勾，因为没有真实 GitHub Action、模型调用、只读上下文和 Git 零写入外部证据。
- 决策沉淀：`docs/Proto.md`、`docs/Security.md`、`docs/Reference.md` 记录官方 CLI、read-only/prompt-injection/Secret environment、可信 Plan envelope 边界；`openai-docs` skill 影响了具体 flags 与 shell env policy。按用户要求不额外更新 llmdoc。
- 遗留：Runner 尚缺 attempt-scoped context/Plan proposal HTTP API、OIDC/bootstrap loop 和固定 workflow；下一轮先完成 context + proposal 控制面契约，再接 workflow。真实 Action 仍需远端前置。

## Round 14 — 2026-07-25
- 目标：Phase 1 / 一个真实 Action 只读检出目标 repo并输出合法 ExecutionPlan（本轮闭环 attempt-scoped context/Plan API 与 exchange fencing 子项，完整条目保留未勾）。
- 前置与权限：仅本地 workerd/D1/R2；无模型调用、GitHub Action、外部写入或真实 Secret。
- 动作：
  - 先扩展 OIDC 测试，要求 response 返回 attemptVersion/leaseGeneration 且 starting→running；新增 context/Plan API 的 active/wrong token、R2 Task 原文/digest、20 路 proposal、extra identity/repo_write、R2 tamper 测试。首次运行 context/plan 4/4 404，OIDC 2 项缺字段/迁移失败。
  - 把 `AnalysisPlanContentV1Schema` 从 Node Codex adapter 抽到纯 domain，Worker 与 CLI 共用同一 strict schema，避免 Worker bundle 引入 child_process。
  - OIDC exchange 把 token insert 与 starting→running/version+1/heartbeat CAS 放进同一 D1 batch，响应返回 heartbeat 所需 version/generation；实现时初次漏 SELECT version 导致 2 项 500，补字段后通过。
  - `RunnerAttemptStore.authorize` 统一校验 opaque token digest/expiry/revocation、Attempt running/lease/generation 和 scopes；context/Plan/heartbeat/complete 不另造身份协议。
  - context store 从 D1 ref 读取私有 R2 Task，要求 R2 metadata digest、重新计算 canonical digest、revision/repo/base 全匹配；Runner 无 R2 credential。原始反馈/PRD只在 no-store authenticated response 返回。
  - Plan API 只收 content；deterministic plan ID、server next version/D1 identity/canonical digest/proposed status 后进入现有 validator/store。20 路相同提交以 SQL immutable constraints + retry-read 收敛为一个 validated Plan；repo_write policy deny，额外 identity 400。
- 验证：
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/analysis-attempt-api.test.ts test/workflow/github-oidc-exchange.test.ts` → 首次 exit 1（6 项红灯）；实现中 context 4/4 已绿但 OIDC 2 项因漏取 version 500；修正后与 Runner 回归合计 3 files / 11 tests 全绿。
  - `pnpm exec vitest run test/codex-analysis-adapter.test.ts test/plan.test.ts` → exit 0，2 files / 14 tests。
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/delivery-run-workflow.test.ts test/workflow/github-dispatcher.test.ts` → exit 0，2 files / 7 tests。
  - `pnpm run typecheck`、`pnpm run lint` → exit 0。
  - `pnpm run verify` → exit 0；typecheck、ESLint、Node 4 files / 21 tests、workerd 10 files / 39 tests、Markdown links 全绿。
  - `pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-dry-run` → exit 0；Worker bundle 与 Workflow/Queue/D1/R2 bindings 正确，未部署。
  - `git diff --check` → exit 0。
- 勾选：新增真实 Action/Agent 条目的本地 attempt context/Plan API 子项；完整 DoD 保持未勾，因为 workflow/bootstrap、真实模型和 GitHub run 尚未执行。
- 决策沉淀：`docs/Proto.md`、`docs/Architecture.md`、`docs/Security.md` 明确 exchange transition、attempt auth、R2 digest、content-only Plan 与并发收敛；按用户要求不额外更新 llmdoc。
- 遗留：下一轮实现固定 workflow/bootstrap；bootstrap 必须维护 token rotation/version，context 写 Runner temp，Plan content 提交后再 complete，不在日志打印原文/token。

## Round 15 — 2026-07-25
- 目标：Phase 1 / 一个真实 Action 只读分析并输出合法 ExecutionPlan，以及 Runner 30～60 秒 heartbeat/result（本轮闭环固定 workflow + bootstrap 本地子项，两个完整条目保留未勾）。
- 前置与权限：仅本地 Node fake HTTP/Codex 与既有 workerd D1/R2；未请求 GitHub OIDC、未触发 Action、未调用计费模型、未部署、未使用真实 Secret。
- 动作：
  - 先写 bootstrap 与 YAML 契约测试；首次定向运行 2 suites 因 Runner 模块和 `yaml` 依赖不存在而 exit 1，保留为红灯证据后实现。
  - Watt 全库检索未发现可直接复制的 GitHub OIDC/bootstrap/heartbeat 模块；继续复用此前从 Watt 提取的持久 Workflow/fenced outbox，不虚构 Runner 代码来源。新增 `yaml@2.8.1` 仅用于结构化解析 workflow 测试。
  - 固定 `.github/workflows/delivery-agent.yml`：dispatch 白名单输入、稳定 run-name/concurrency、`contents: read + id-token: write`、exact base SHA、`persist-credentials: false`、60 分钟 timeout，checkout/setup-node/pnpm setup 全部 pin 40 位 SHA。
  - Runner 从 GitHub runtime API 获取固定 audience OIDC，exchange 后核对 context 的 run/attempt/task digest/base/mode；context/output 位于 repo 外 0700 目录和 0600 文件，不把正文/token 写日志或错误。
  - Agent 运行期间每 45 秒 heartbeat，响应原子替换内存 token/version/generation；Agent 返回后停止 loop，复验 ExecutionPlan、比较前后 Git status，只有零变化才提交 content-only Plan。控制面 plan ID/version/digest/ref 与本地 proposal 全匹配后，使用最新 fencing 提交 reference-only complete；finally 清理临时目录。
  - 把 deterministic analysis Plan ID 提取为 Runner/Worker 共享 domain helper，避免客户端与服务端各自复制身份算法。
- 验证：
  - `pnpm exec vitest run test/analysis-runner-bootstrap.test.ts test/delivery-agent-workflow.test.ts` → 首次 exit 1（Runner 模块、yaml 依赖缺失）；实现后 exit 0，2 files / 3 tests。
  - `pnpm run typecheck`、`pnpm run lint` → exit 0。
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/analysis-attempt-api.test.ts test/workflow/github-oidc-exchange.test.ts test/workflow/runner-api.test.ts test/workflow/github-dispatcher.test.ts` → exit 0，4 files / 17 tests。
  - `pnpm exec vitest run test/codex-analysis-adapter.test.ts test/plan.test.ts test/analysis-runner-bootstrap.test.ts test/delivery-agent-workflow.test.ts` → exit 0，4 files / 17 tests。
  - `pnpm run verify` → exit 0；typecheck、ESLint、Node 6 files / 24 tests、workerd 10 files / 39 tests、Markdown links 全绿。
  - `pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round15` → exit 0；Worker bundle 成功识别 Workflow、Queue、D1、R2 bindings，未部署。
  - `git diff --check` → exit 0。
- 勾选：新增真实 Action/Agent 条目的本地固定 workflow/bootstrap 子项，以及 Runner heartbeat/result 的本地 harness 子项；完整条目保持未勾，因为没有真实 GitHub Action、连续 cadence、模型调用和外部 run status/conclusion。
- 决策沉淀：`docs/Proto.md`、`docs/Architecture.md`、`docs/Security.md` 明确固定 workflow、45 秒 fencing loop、临时文件与 Git 零写入关口；按用户要求不额外更新 llmdoc。
- 遗留：需真实试点 repo/App/控制面部署后运行 Action 并由 GitHub API/webhook 核对 run ID/status/conclusion；本地仍可继续实现外部事实 reconciliation 与失败撤销契约。

## Round 16 — 2026-07-25
- 目标：Phase 1 / Runner 正常完成后控制面状态与 GitHub run 外部事实一致（本轮闭环签名 `workflow_run` webhook 本地子项，完整条目保留未勾）。
- 前置与权限：仅只读访问 GitHub 官方 webhook 文档，并使用本地 workerd/D1 与测试 HMAC Secret；未接收真实 GitHub webhook、未调用 App API、未部署、未使用真实 Secret。
- 动作：
  - 先写有效 completed、20 次 delivery replay、错误签名、delivery ID 换 payload、repo/workflow/SHA/title/run ID/run attempt 错绑与乱序回退测试；首次定向运行 4/4 因 `github_webhook_deliveries` 不存在而 exit 1。
  - 新增 migration：GitHub delivery 仅保存 ID、raw body digest、绑定标量、applied/ignored 与时间，不保存原始 payload；Attempt 增加独立 `github_external_updated_at + github_observation_version`，不复用 Runner heartbeat `version`。
  - `POST /v1/webhooks/github` 在解析 JSON 前先验证 raw body `X-Hub-Signature-256` HMAC-SHA256，只允许 `workflow_run`；错误签名、非法 event/schema 和错误响应不回显 body/Secret。
  - 签名通过后继续绑定 D1 的 GitHub run ID、repository、固定 workflow ref/path、base SHA、stable run-name/attempt ID 与 `run_attempt=1`。绑定不符只记 ignored，不污染 Attempt。
  - GitHub `updated_at` 必须严格更新才前进；旧/同时间事件不能回退 completed。external observation CAS 与 Runner fencing 分栏，因此 webhook 观察不会让正在运行的 heartbeat 使用过期 version。
  - 2026-07-25 实读 GitHub 官方 webhook 文档，核对 `X-GitHub-Delivery`、`X-Hub-Signature-256` 和 `workflow_run` 事件名；未把本地 HMAC 测试冒充真实 GitHub delivery。
- 验证：
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/github-workflow-run-webhook.test.ts` → 首次 exit 1（4/4 缺 migration 表）；实现后 exit 0，1 file / 4 tests。
  - `pnpm run typecheck` → 中间 exit 2（WebCrypto `Uint8Array<ArrayBufferLike>` 不满足 `BufferSource`）；改为明确 `ArrayBuffer` 后 exit 0；`pnpm run lint` → exit 0。
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/github-workflow-run-webhook.test.ts test/workflow/github-dispatcher.test.ts test/workflow/github-oidc-exchange.test.ts test/workflow/runner-api.test.ts test/workflow/task-query-api.test.ts` → exit 0，5 files / 20 tests。
  - `curl ... GitHub webhook docs` + `rg X-Hub-Signature-256/X-GitHub-Delivery/workflow_run` → exit 0。
  - `pnpm run verify` → exit 0；typecheck、ESLint、Node 6 files / 24 tests、workerd 11 files / 43 tests、Markdown links 全绿。
  - `pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round16` → exit 0；Worker bundle 与 Workflow/Queue/D1/R2 bindings 正确，未部署。
  - `git diff --check` → exit 0。
- 勾选：新增 Runner heartbeat/result 条目的本地 GitHub `workflow_run` 外部事实子项；完整条目保持未勾，因为没有真实 GitHub Action/webhook、连续 cadence 与 App API reconciliation。
- 决策沉淀：`docs/Proto.md`、`docs/Architecture.md`、`docs/Security.md`、`docs/Reference.md` 明确 raw HMAC、delivery digest、全绑定、乱序 fencing 与 observation/fencing version 分离；按用户要求不额外更新 llmdoc。
- 遗留：下一轮实现 GitHub App API reconciliation，覆盖 webhook 丢失；真实外部 run/status/conclusion 仍需试点 repo/App/部署后核对。

## Round 17 — 2026-07-25
- 目标：Phase 1 / Runner 完成后控制面状态与 GitHub run 外部事实一致（本轮闭环 GitHub App API reconciliation 本地子项，完整条目保留未勾）。
- 前置与权限：只读访问 GitHub 官方 REST 文档；本地 fake GitHub API、测试 RSA App key 与 workerd/D1。未调用真实 GitHub API、未安装 App、未部署、未使用真实 private key/token。
- 动作：
  - 先写 App JWT/installation token、webhook 丢失后 API 修复、同 fact 去重、错绑、旧事实、batch 候选和 REST response strict parse 测试；首次两个 suites 均因 provider/reconciler 模块不存在而 exit 1。
  - 新增 GitHub App provider：RS256 App JWT 生命周期不超过 10 分钟；installation token 请求以 allowlist 中单 repo 名和 `actions:write + contents:read` 再收窄，token 仅内存缓存到刷新窗口，private key/JWT/token/response body 不写 D1/错误。
  - 扩展 Actions REST client，使用短 installation token 读取固定 repository/run ID；严格解析 event/status/conclusion/base SHA/branch/path/title/run attempt/updated time/repository，响应错绑或畸形 fail-closed。
  - 新增 `github_api_observations` migration 和 scheduled reconciler；只选尚无 completed external fact 的 Attempt，API observation ID 由 repo/run/fact digest 稳定派生，重复轮询收敛到一条 reference-only 记录。
  - 把 Round 16 webhook 的 Attempt projection 抽成共享 projector：webhook/API 都执行相同 run/repo/workflow/base/title/run attempt 绑定与 GitHub `updated_at` 乱序 fencing；API 修复不递增 Runner heartbeat version。
  - Worker scheduled 在 App 配置全部缺省时不启用 reconciliation，部分配置则 fail-fast；完整配置时与 workflow outbox relay 并行运行。实读 GitHub `get workflow run` 与 `create installation access token` 官方 REST 文档核对端点和授权模式。
- 验证：
  - `pnpm exec vitest run test/github-app-installation-token.test.ts` → 首次 exit 1（模块不存在）；实现后测试 fixture 曾因把真实 201 响应写成 200 而 1/2 失败，改为 201 后 exit 0，1 file / 2 tests。
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/github-run-reconciler.test.ts` → 首次 exit 1（模块不存在）；实现后 exit 0，1 file / 5 tests。
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/github-run-reconciler.test.ts test/workflow/github-workflow-run-webhook.test.ts test/workflow/github-dispatcher.test.ts` → exit 0，3 files / 15 tests。
  - GitHub docs article API + `rg` 核对 `Get a workflow run`、`Create an installation access token for an app`、`run_id/installation_id` → exit 0。
  - `pnpm run verify` → exit 0；typecheck、ESLint、Node 7 files / 26 tests、workerd 12 files / 48 tests、Markdown links全绿。
  - `pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round17` → exit 0；含 App JWT/API scheduled reconciliation 的 Worker bundle 成功，未部署。
  - `git diff --check` → exit 0。
- 勾选：新增 Runner heartbeat/result 条目的本地 GitHub App API reconciliation 子项；完整条目保持未勾，因为没有真实 installation token、Actions run、webhook/API fact 和连续 heartbeat 外部证据。
- 决策沉淀：`docs/Proto.md`、`docs/Architecture.md`、`docs/Security.md`、`docs/Reference.md` 明确 repo-scoped App token、API observation digest、共享 projector 与 scheduled 修复；按用户要求不额外更新 llmdoc。
- 遗留：GitHub analysis dispatch processor 尚未接入生产 Queue/scheduled 路由；下一轮复用 App provider + fenced processor 补齐接线。真实外部项仍需 owner/repo/App/Cloudflare 配置。

## Round 18 — 2026-07-25
- 目标：Phase 1 / GitHub App dispatcher 固定 workflow ref 与 reference-only payload（本轮闭环生产 Queue/scheduled 接线子项，完整条目保留未勾）。
- 前置与权限：仅本地 workerd/D1、fake destination processors 与既有 App runtime；未调用 GitHub、未发送真实 Queue、未部署、未使用真实 Secret。
- 动作：
  - 先写双 destination relay、D1 destination 路由、App 未配置、unknown destination、Queue ack/retry 和 runtime 完整配置测试；首次 suite 因 `outbox-queue-consumer` 模块不存在而 exit 1。
  - 新增 `OutboxDestinationRouter`：Queue payload 只有 outbox ID，consumer 必须回查 D1 destination，再交给 Cloudflare Workflow 或 GitHub fenced processor；消息不能自选 effect。
  - 新增统一 batch consumer：仅 settled/missing ack；retry/busy/unconfigured/unsupported 或路由异常均 retry，修复旧实现把 GitHub outbox交给 Workflow processor后返回 busy/错误 ack 的接线缺口。
  - scheduled relay 支持 Workflow + GitHub destination，但 Worker 只有在 App allowlist/private key/installation 与 control-plane origin 完整时才入队 GitHub row；未配置环境不制造每分钟重试风暴，已有消息仍保持 pending/retry。
  - 抽出共享 GitHub Actions runtime，scheduled reconciliation 与 Queue dispatcher 使用同一 App provider/client/allowlist 配置；Queue consumer 通过 `githubDispatchProcessorFromEnv` 接到此前已验证的 fixed workflow/fenced processor。
  - Watt 的 pending→delivering→settled 代码继续作为唯一 effect fencing 原语；本轮没有复制第二套 delivery state machine。
- 验证：
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/outbox-routing.test.ts` → 首次 exit 1（router 模块不存在）；实现后 exit 0，1 file / 5 tests。
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/outbox-routing.test.ts test/workflow/workflow-outbox.test.ts test/workflow/github-dispatcher.test.ts` → exit 0，3 files / 17 tests。
  - `pnpm run typecheck`、`pnpm run lint` → exit 0。
  - `pnpm run verify` → exit 0；typecheck、ESLint、Node 7 files / 26 tests、workerd 13 files / 53 tests、Markdown links 全绿。
  - `pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round18` → exit 0；双 destination relay/router 与 GitHub runtime bundle 成功，未部署。
  - `git diff --check` → exit 0。
- 勾选：新增 GitHub App dispatcher 条目的本地 Worker production wiring 子项；完整条目保持未勾，因为没有真实 App installation、Queue delivery 与 Actions run URL/API。
- 决策沉淀：`docs/Proto.md`、`docs/Architecture.md`、`docs/Security.md` 明确 Queue ID 非权限真源、D1 destination 路由、配置感知 relay 与 ack/retry 边界；按用户要求不额外更新 llmdoc。
- 遗留：Phase 1 剩余项主要需要真实 GitHub/Cloudflare 资源；下一轮实现 Runner 取消/超时 token 撤销与 stuck detection 的本地契约，真实外部证据继续等待 owner/repo/App/账户配置。

## Round 19 — 2026-07-25
- 目标：Phase 3 / attempt 完成、取消和 heartbeat 超时后 token 在规定窗口内不可用，并有自动化撤销测试。
- 前置与权限：仅本地 workerd/D1/Workflow fake effect；未取消真实 Action/Workflow、未部署、未使用真实 token。
- 动作：
  - 先写 20 路 cancel、旧 Run version、heartbeat timeout、重复扫描、late heartbeat、revocation audit 与 Workflow terminate outbox 测试；首次 suite 因 `attempt-lifecycle-store` 模块不存在而 exit 1。
  - 新增 `attempt_revocations` migration：只保存 run/attempt、completed/cancelled/heartbeat_timeout reason、被撤销 generation、结果 Attempt version 与时间，不保存 token/digest 原文。
  - Runner complete 原事务在 result/signal/outbox/token revoke 后写 completed revocation evidence，projection 必须同时看到 token revoked 与 revocation ID才返回成功。
  - 新增认证 `POST /v1/runs/:runId/cancel {expectedRunVersion}`：只允许 Run 状态机已有 cancel edge；20 路同版本请求收敛。Run/所有 active Attempt、generation/lease/token、未生效 dispatch 与稳定 workflow-cancel outbox 同事务更新；result 已上报或旧 version fail-closed。
  - 新增每分钟 stuck detector：只扫描 starting/running、lease 已过期且无 result 的 Attempt；以旧 status/version/generation/expiry CAS 置 lost、generation +1、token revoke、Run blocked、revocation evidence 与 workflow-cancel intent。第二次扫描无重复迁移。
  - `workflow_cancel` 复用既有 Watt-derived fenced outbox；payload 只能是 `d1://runs/<run_id>` 且 D1 Run 已 cancelled/blocked，未知/已终态 Workflow 幂等成功，其余 terminate。
  - token TTL 仍须 ≤ lease；scheduled scanner定义 lease 过期后一个分钟周期内的持久撤销/业务投影兜底。测试额外放入一个防御性超长 token，证明 scanner仍立即 revoke，旧 Runner heartbeat 返回 401。
- 验证：
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/attempt-revocation.test.ts` → 首次 exit 1（lifecycle 模块不存在）；实现后 exit 0，1 file / 3 tests。
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/attempt-revocation.test.ts test/workflow/runner-api.test.ts test/workflow/workflow-outbox.test.ts` → exit 0，3 files / 12 tests，complete audit与既有 fencing 无回归。
  - `pnpm run typecheck`、`pnpm run lint` → exit 0。
  - `pnpm run verify` → exit 0；typecheck、ESLint、Node 7 files / 26 tests、workerd 14 files / 56 tests、Markdown links 全绿。
  - `pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round19` → exit 0；cancel API、scheduled detector 与 Workflow terminate bundle 成功，未部署。
  - `git diff --check` → exit 0。
- 勾选：Phase 3 complete/cancel/heartbeat-timeout token 不可用 DoD 完整勾选；本地自动化覆盖三种 reason、CAS、generation fencing、revocation evidence 和 late token 401。
- 决策沉淀：`docs/Proto.md`、`docs/Architecture.md`、`docs/Security.md` 明确一分钟 scanner窗口、状态机 cancel edge、reference-only revocation 与 fenced Workflow terminate；按用户要求不额外更新 llmdoc。
- 遗留：本轮只撤销控制面 token/Workflow；真实 GitHub Action cancel API 与外部 conclusion 核对仍需试点 App。下一轮实现 schema-aware redaction 与 canary Secret扫描 DoD。

## Round 20 — 2026-07-25
- 目标：Phase 3 / 日志、Task、checkpoint、artifact、PR canary Secret 扫描（本轮闭环通用安全原语与现有 Task/CLI/source producer 子项；完整条目保持未勾）。
- 前置与权限：仅本地 Node/workerd/D1/R2 与非生产 canary；未读取或写入真实 Secret，未上传 artifact/PR，未触发 Action、外部 API 或部署。只读检索本地 Watt，未修改 Watt。
- 动作：
  - 先写 header、嵌套 JSON、URL userinfo/query/fragment、命令环境、二进制 artifact 与 finding 安全性测试；首次因 redaction 模块不存在而 exit 1，再实现 `SensitiveDataRedactor + SecretScanner`。registered canary 与 GitHub token/JWT/Bearer/private-key finding 只含安全 `path + kind`，不含命中值。
  - Task schema 校验后、identity/D1/R2 写入前扫描当前 Worker 配置 Secret 与 credential 形状；首次测试仍返回 202，修正后固定 `policy_denied` 且 Task/Run/outbox/R2 均为 0。成功 intake 反扫 response/D1/R2，认证 token 与 idempotency canary 零泄漏。
  - Codex command executor 收集敏感环境 key 的值并在返回 stderr 前脱敏；真实子进程初次回显 canary，修正后只返回 `[REDACTED]`，上层仍不传播 stderr。
  - 新增 production source/workflow/migration/schema 静态 credential scan 并接入 `pnpm run verify`；扫描配置只从环境读取 JSON canary，不把值写进错误。Watt 全库只发现 endpoint/correlation sanitize 与 provider 脱敏投影测试，没有可直接复制的通用 redactor/scanner；沿用已复制的 Hono/error/workerd 测试骨架，没有虚构 Watt 来源。
  - 额外红灯发现错误响应会反射任意字母数字 `x-correlation-id`；canary 测试先失败，再收紧为仅传播 UUID，其余值由控制面重新生成，合法 UUID 仍可跨系统关联。
- 验证：
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/task-api.test.ts` → correlation canary 红灯时 exit 1（响应原样含 header）；修正后 exit 0，1 file / 6 tests。
  - `pnpm exec vitest run test/redaction.test.ts test/codex-analysis-adapter.test.ts` → exit 0，2 files / 11 tests，覆盖 `Headers`/record、递归 JSON/cycle、URL、environment、binary scan 与真实子进程 stderr。
  - `pnpm run typecheck` → 中间因测试 `response.json()` 为 unknown 而 exit 2；显式收窄测试响应后 exit 0。`pnpm run lint` → exit 0。
  - `pnpm run verify:secrets` → exit 0，50 个生产文件无 credential finding。
  - `pnpm run verify` → exit 0；typecheck、ESLint、Node 8 files / 33 tests、workerd 14 files / 58 tests、50 个生产文件 Secret scan、Markdown links全绿。
  - `pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round20` → exit 0；redaction/Task gate 可随 Workflow、Queue、D1、R2 bindings 正常打包，未部署。
  - `git diff --check` → exit 0。
- 勾选：Phase 3 Secret scan 完整 DoD 保持未勾；仅新增本地安全原语与现有 producer 子项。checkpoint/artifact/PR producer 和完整结构化日志尚不存在，不能用合成对象扫描冒充外部零泄漏证据。
- 决策沉淀：`docs/Proto.md`、`docs/Security.md`、`docs/Architecture.md` 明确 redactor/scanner 分工、safe finding、Task pre-persistence gate、stderr 与 correlation ID 边界；按用户要求不额外更新 llmdoc。
- 遗留：下一轮实现 checkpoint schema/sequence CAS/R2 payload + D1 安全投影，并在真实 checkpoint producer 持久化前接入同一 scanner；后续 artifact/PR producer 各自接入后才能完成本 DoD。

## Round 21 — 2026-07-25
- 目标：Phase 3 / 每个 checkpoint 含 sequence、plan version/item、head SHA、已完成验收项、evidence refs、summary、nextStep；乱序/重复 sequence 不覆盖新 checkpoint，旧 plan checkpoint 不恢复到新计划。
- 前置与权限：仅本地 workerd/D1/R2 与非生产 token/canary；未运行模型、未触发 Action/外部 API/部署。只读检索本地 Watt，未修改 Watt。
- 动作：
  - 审计确认原仓库只有 nullable checkpoint 表、D1 查询投影和手工测试行，没有 checkpoint 写 API、R2 payload 校验或恢复读取。Watt 的 checkpoint 是人审 signal/waitForEvent，不是 Agent 语义恢复快照；没有可直接复制的 `AgentCheckpoint/sequence CAS`，继续复用 Watt-derived workerd migration harness、Hono 安全错误、D1 条件写和既有 Runner token fencing。
  - 先写 `PUT /v1/attempts/:id/checkpoint` 的 5 个穿透场景；首次 suite 在导入阶段因 checkpoint store 不存在而 exit 1。实现后扩为 6 项，覆盖完整 v1 字段、R2/D1、恢复回读、20 路并发、乱序/同序冲突、旧 plan、scope、Evidence、Secret 与篡改。
  - 新增 strict `AgentCheckpointV1Schema`：head SHA 必填；provider/session ref/head branch 受限格式；completed criteria/evidence refs 去重；Evidence ref 只接受 `d1://evidence/<id>`；summary/nextStep/数组都有上限；canonical digest 复用共享 SHA-256 原语。
  - 新增 migration：Attempt 增加 head branch/SHA，checkpoint 新写入必须带 plan/version/item/head binding，并建立 plan-item recovery 索引。新增独立私有 `CHECKPOINT_OBJECTS` R2 binding，完整 payload 不进入 Workflow history。
  - checkpoint producer 要求 active opaque token、显式 `checkpoint:write`、Attempt version/generation/lease、Run active plan、active Plan/Item、`in_progress + active_attempt`、head branch/SHA 和同 plan/item Evidence ref 全绑定。当前 token 与 Worker Secret/credential canary 在任何 D1/R2 写入前扫描。
  - R2 对象以 attempt/sequence/canonical digest 定址并写安全 metadata；D1 只发布 recovery/query 投影。同 sequence + 同 digest 幂等，换内容或低 sequence conflict；20 路相同 PUT 收敛为 1 个 D1/R2 checkpoint。
  - recovery loader 只查询当前 active plan/version/item，回读时复验 R2 metadata、严格 schema、canonical digest、sequence/plan/item/head/summary/nextStep；plan 被 supersede 后旧 checkpoint 返回 null，payload 篡改 fail-closed。
- 验证：
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/checkpoint-api.test.ts` → 首次 exit 1（store 模块不存在）；实现后 exit 0，1 file / 6 tests。
  - `pnpm run typecheck` / `pnpm run lint` → 中间分别因 Vitest matcher 多余泛型和 type-only import 规则 exit 2/1；修正测试后均 exit 0。
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/checkpoint-api.test.ts test/workflow/task-query-api.test.ts test/workflow/runner-api.test.ts test/workflow/attempt-revocation.test.ts test/workflow/task-intake-store.test.ts` → exit 0，5 files / 19 tests，migration/query/token revocation无回归。
  - `pnpm run verify:secrets` → exit 0，53 个生产文件无 credential finding。
  - `pnpm run verify` → exit 0；typecheck、ESLint、Node 8 files / 33 tests、workerd 15 files / 64 tests、53 个生产文件 Secret scan、Markdown links全绿。
  - `pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round21` → exit 0；Workflow、Queue、D1、Task R2 与新增 checkpoint R2 bindings 可正常打包，未部署。
  - `git diff --check` → exit 0。
- 勾选：Phase 3 AgentCheckpoint v1/sequence CAS/旧 plan 恢复拒绝 DoD 完整勾选；Secret scan 大项仍保持未勾，但其本地已完成子项扩展到真实 checkpoint D1/R2 producer。
- 决策沉淀：`docs/Proto.md`、`docs/Architecture.md`、`docs/Security.md` 明确 checkpoint request envelope、独立 scope、双存储发布顺序、幂等/CAS、safe query 和恢复回读验证；按用户要求不额外更新 llmdoc。
- 遗留：尚未实现 Adapter resume/interrupt/exportCheckpoint 和 Runner kill→新 attempt→Git checkout/resume 穿透；下一轮先补统一 Adapter 契约，再闭环强制 kill 恢复 DoD。并发 D1 发布失败产生的未引用 deterministic R2 对象不参与恢复，后续 retention/reconciliation 负责清理。

## Round 22 — 2026-07-25
- 目标：Phase 3 / Agent Adapter 的 start/resume/interrupt/exportCheckpoint 契约测试通过；至少接通一个真实非交互 Agent CLI（本轮闭环本地 session/进程契约，完整条目保持未勾）。
- 前置与权限：只读 OpenAI 官方 Docs MCP、本机锁定 `codex-cli 0.145.0 --help`、本地 Node fake process/真实子进程；未调用计费模型、未发送仓库/Task 内容、未触发 Action或部署。只读检索 Watt，未修改 Watt。
- 动作：
  - 按 `openai-docs` skill 先运行 Codex manual helper，官方 manual HEAD 返回 403；按 skill 回退 Docs MCP，核对官方 glossary 中 `codex exec` 非交互与 ephemeral 不保存 session 的定义，以及 App Server 的 `thread/resume + turn/interrupt` 能力。本机锁定版 help 进一步确认 `codex exec resume [SESSION_ID]/--last` 存在。
  - 裁决：现有安全路径固定 `--ephemeral`，所以不能把存在 `exec resume` 误当成 Runner 丢失后可用的 provider session。当前 Codex adapter resume 固定走外部语义 checkpoint fallback，启动新的受限 exec；未来只有 provider session 经安全外部持久化/核对后才允许 native resume。
  - 先写 start/resume/interrupt/exportCheckpoint、session ownership、checkpoint sequence/binding、digest/private file、真实子进程中断测试；首次 suite 因 command runtime 模块不存在而 exit 1，随后实现。
  - 把 analysis adapter 的 spawn/stderr/timeout 提取成共享 bounded command runtime；两种 adapter 共用 8 KiB stderr上限、环境 Secret redaction 与 timeout/interrupt `SIGTERM → 1s grace → SIGKILL`，没有复制第二套进程生命周期。
  - 新增 `CodexSessionAdapter`：start/resume 均使用 `codex exec --ephemeral --ignore-user-config --sandbox read-only + approval never`；context/checkpoint/output 位于 repo 外，输入文件要求 0600。resume 先核对 checkpoint schema/canonical digest/plan version/item/head SHA，prompt 只引用路径、不内联正文或 summary。
  - session 绑定 attempt，状态明确；只有创建它的 adapter 可 interrupt/export。Runner-controlled `recordCheckpoint` 只接受 running、同 provider/plan/item/branch、sequence 严格递增的 checkpoint；export 返回 clone，interrupt reason 不传 provider，重复 interrupt 不重复 signal。
  - Watt 定向检索未发现 `AgentAdapter/exportCheckpoint/resume/interrupt` 可直接复制模块；继续复用此前 Watt-derived 控制面/测试原语，不虚构 Agent adapter 来源。
- 验证：
  - `pnpm exec vitest run test/codex-session-adapter.test.ts` → 首次 exit 1（缺 command runtime）；实现后与 analysis adapter合跑 exit 0，2 files / 9 tests。
  - `pnpm exec vitest run test/codex-session-adapter.test.ts test/codex-analysis-adapter.test.ts test/analysis-runner-bootstrap.test.ts` → exit 0，3 files / 11 tests；真实 Node child 被 adapter runtime 中断退出。
  - `pnpm exec codex --version` + `codex exec/resume --help | rg ...` → exit 0；锁定版 0.145.0，start 安全参数与 resume SESSION_ID/--last/ephemeral 参数均存在；未调用模型。
  - `pnpm run typecheck`、`pnpm run lint` → exit 0。
  - `pnpm run verify` → exit 0；typecheck、ESLint、Node 9 files / 37 tests、workerd 15 files / 64 tests、55 个生产文件 Secret scan、Markdown links全绿。
  - `pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round22` → exit 0；Worker bindings/bundle 无回归，未部署。
  - `git diff --check` → exit 0。
- 勾选：Agent Adapter 完整 DoD 保持未勾；新增本地 Codex session adapter 子项。真实 `codex exec` 模型调用仍需显式 opt-in/真实 Action，help、fake launcher和 Node child不能冒充该外部证据。
- 决策沉淀：`docs/Proto.md`、`docs/Architecture.md`、`docs/Security.md`、`docs/Reference.md` 明确 ephemeral/native resume 边界、语义 fallback、session ownership、interrupt 与 checkpoint 导出；`openai-docs` skill 直接影响了恢复策略。按用户要求不额外更新 llmdoc。
- 遗留：下一轮用 session adapter + checkpoint store 实现 Runner 强制 kill 后的新 attempt 恢复穿透；真实 Codex 调用、认证/预算和 Actions 运行仍等待外部前置或显式 opt-in。

## Round 23 — 2026-07-25
- 目标：Phase 3 / Runner 在一个 DoD Item 执行中强制 kill，新 attempt 能从 Git + checkpoint 继续；供应商原生 resume 不可用时走语义 checkpoint 兜底，已 passed Item 不重复（本轮闭环 D1/R2/Git 本地穿透子项，完整条目保持未勾）。
- 前置与权限：仅本地 workerd/D1/R2、临时 Git repo 和真实长运行 Node 子进程；未触发 GitHub Action、未调用计费模型、未部署、未写 Watt。定向检索 Watt 只发现用于人工确认的 `pendingCheckpoint/setCheckpoint/clearCheckpoint`，没有 Agent kill/replacement/Git semantic-resume 模块可直接复制；继续复用此前从 Watt 迁移的 Hono、D1 CAS、pending→delivering→settled、workerd migration/test harness 和统一错误原语。
- 动作：
  - 先扩展 checkpoint recovery 穿透并新增 Runner Git 恢复测试；workerd 首次因 `recovery-attempt-store` 不存在 exit 1，Node 首次因 `agent-recovery-runner` 不存在 exit 1。连续 replacement 场景首次暴露“checkpoint 必须归属最近 lost Attempt”的错误假设，修正为按 active plan/item 选择全部历史 Attempt 中最新有效 checkpoint。
  - 新增 migration 0006：Attempt 保存 `recovered_from_attempt_id + recovery_checkpoint_id`；唯一 fencing 是 `(lost attempt, exact checkpoint)`，因此 20 路相同 retry 只创建一个 replacement，而 replacement 尚无新 checkpoint 又失联时可用新的 lost Attempt identity 复用旧 checkpoint。
  - 新增 `RecoveryAttemptStore`：要求 Run blocked、active Plan/Item、Item in_progress、lost active Attempt、旧 token 已撤销、`workflow_cancel` 已 settled、依赖全 passed；重新回读并验证 R2 schema/digest/binding，再以 D1 batch/CAS 创建 pending replacement、切换 Item active Attempt并把 Run恢复为 executing。passed/skipped Item 固定拒绝。
  - 新增认证 `POST /v1/runs/:runId/retry`：strict body 为 `expectedRunVersion + planVersion + planItemId`，20 路并发返回同一 reference-only recovery projection。replacement 不继承 token/lease/GitHub run ID，不创建 dispatch outbox，不能借恢复绕过 repo-write effect 审批。
  - 新增 `AgentRecoveryRunner`：读取 0600/限大小 checkpoint，复验 schema/canonical digest/plan/item；只允许 clean worktree 和固定 `git status/cat-file/checkout --detach/rev-parse` 命令，HEAD 核对后才调用 Adapter resume。测试真实 interrupt 旧进程、从错误 HEAD 恢复 checkpoint commit并启动新的 semantic-resume session；checkpoint summary 与 passed Item 不内联 provider prompt。
  - `docs/Proto.md`、`docs/Architecture.md`、`docs/Security.md` 同步 recovery API、旧 Workflow/token fencing、stable replacement identity、跨 Attempt checkpoint 复用、固定 Git 命令与“不自动 write dispatch”安全边界；按用户要求不额外更新 llmdoc。
- 验证：
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/checkpoint-api.test.ts test/workflow/attempt-revocation.test.ts test/workflow/task-query-api.test.ts test/workflow/lease-cas.test.ts` → exit 0，4 files / 17 tests；覆盖 checkpoint→timeout revoke→Workflow cancel settle→20 路 retry、passed Item拒绝、新 lease 与连续 replacement 复用 checkpoint。
  - `pnpm exec vitest run test/recovery-runner.test.ts test/codex-session-adapter.test.ts test/codex-analysis-adapter.test.ts` → exit 0，3 files / 11 tests；真实 Git repo/child interrupt/semantic resume 与既有 adapter 无回归。
  - `pnpm run typecheck`、`pnpm run lint` → exit 0。
  - `pnpm run verify` → exit 0；typecheck、ESLint、Node 10 files / 39 tests、workerd 15 files / 65 tests、58 个生产文件 Secret scan、Markdown links全绿。
  - 首个 dry-run wrapper 因包含 `/tmp` 清理命令被执行器在启动前拒绝，未作为证据；改为新目录后 `pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round23-20260725-1540` → exit 0，Workflow/Queue/D1/双 R2 bindings 与 recovery API bundle 成功，未部署。
  - `git diff --check` → exit 0。
- 勾选：Runner recovery 完整 DoD 保持未勾；新增“本地 D1/R2/Git 穿透”子项。真实试点 repo 中 old Action kill→new Action/Attempt 恢复仍需外部 Actions run、Git SHA 与逐项 Evidence，不能用本地 Node child 冒充。
- 决策沉淀：replacement 初始 pending 是权限边界，不是调度缺口；旧 Workflow termination settle 是恢复前置；checkpoint 选择按当前 active plan/item 的全历史 Attempt，而 fencing按本次 lost Attempt + exact checkpoint。规范已同步；按用户要求不更新 llmdoc。
- 遗留：下一轮只做 Workflow callback pending→delivering→settled 与 late-result fencing。真实 recovery、Codex 模型、GitHub/Cloudflare 外部项继续等待 owner/repo/App/账户配置或显式 opt-in。

## Round 24 — 2026-07-25
- 目标：Phase 3 / Workflow callback 先以 delivery/event ID 去重并进入 outbox，采用 pending→delivering→settled；sendEvent 故障重放后只推进一次，超时/取消后的晚到结果不复活旧 Attempt。
- 前置与权限：仅本地 workerd/D1、真实 Cloudflare Workflow 测试 binding 与 fake effect；未调用外部 GitHub/Cloudflare API、未部署、未使用真实 Secret。只读核对 Watt `AgentCorrelation.peekForDelivery/confirmDelivery/rollbackDelivery` 及 timeout 后 late-result drop 逻辑，直接沿用其“先 claim、成功 confirm、失败 rollback、晚到无副作用 settle”纪律；实现继续复用已有 Watt-derived `FencedOutboxProcessor`，没有复制第二套状态机或修改 Watt。
- 动作：
  - 审计确认 Runner complete 已把 Attempt result、`workflow_signals`、pending outbox 与 token revoke 原子入账，共享 outbox 也已有 lease/fencing；实际缺口是 signal immutable content 校验不完整、processor effect 前不重查 Run/Attempt/Plan，以及 ambiguous send/late result 没有 terminal reconciliation。
  - 先新增 4 个 workerd 穿透场景；首次定向运行 exit 1，4/4 红灯：同 event ID 修改 sequence 被错误当成幂等、ambiguous send replay 没有 `already_applied` 证据、cancel/timeout late result 都以普通成功 settle且缺少无副作用原因。
  - `WorkflowSignalStore` 幂等投影扩为完整比较 event type、Attempt、sequence、payload ref、digest、occurredAt；20 路相同 callback 收敛到一个 signal/outbox，同 event 换任一字段或同 sequence 换 event 均 conflict。
  - 直接扩展共享 `FencedOutboxProcessor` 的成功 outcome：正常 effect 保持 `last_error_code = null`，reconciliation 证明无需 effect 时以受限格式 terminal code settled；确定失败仍 rollback pending，过期 lease仍可接管。
  - `WorkflowOutboxProcessor` 在 delivering lease 内重新 JOIN signal → Run → Attempt result projection → referenced Plan。只有 `planning + running + exact result/Plan binding` 调用 `sendEvent`；cancelled/blocked/lost/stale/invalid 分别 terminal settle且不触达旧 Workflow。
  - 新增真实 ambiguous send 穿透：第一次实际 `sendEvent` 后注入响应错误，outbox 回 pending但 Workflow 已激活 Plan；重放观察 Run/Attempt/active Plan 后以 `already_applied` settle，不发送第二次，Run version 只前进一次。
  - 更强 contract 使两条旧测试 fixture 变红，因为它们过去直接伪造未被 Attempt 接受的 signal；fixture 改为先写可信 result/Plan binding，没有放宽生产校验。规范同步到 `docs/Proto.md`、`docs/Architecture.md`、`docs/Security.md`；按用户要求不更新 llmdoc。
- 验证：
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/workflow-callback.test.ts` → 首次 exit 1，1 file / 4 tests 全红；实现后 exit 0，1 file / 4 tests。
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/workflow-callback.test.ts test/workflow/workflow-outbox.test.ts test/workflow/delivery-run-workflow.test.ts test/workflow/runner-api.test.ts test/workflow/attempt-revocation.test.ts test/workflow/checkpoint-api.test.ts` → exit 0，6 files / 24 tests；既有 Runner complete、outbox restart、cancel/timeout 与 checkpoint 无回归。
  - `pnpm run typecheck`、`pnpm run lint`、`pnpm run verify:docs` → exit 0。
  - `pnpm run verify` → exit 0；typecheck、ESLint、Node 10 files / 39 tests、workerd 16 files / 69 tests、58 个生产文件 Secret scan、Markdown links全绿。
  - `pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round24-20260725-1554` → exit 0；Workflow/Queue/D1/双 R2 bindings 与 callback reconciliation bundle 成功，未部署。
  - `git diff --check` → exit 0。
- 勾选：Phase 3 Workflow callback DoD 完整勾选；证据覆盖完整 identity 去重、显式 pending→delivering→settled、确定失败重放、实际送达后 ambiguous failure reconciliation、cancel/timeout late-result no-effect settle 和单次 D1 业务推进。
- 决策沉淀：`last_error_code` 在 settled outbox 上也可承载安全 terminal disposition（如 `already_applied/run_cancelled/attempt_lost`），用于区分“effect 成功”和“经 reconciliation 无需 effect”；只有 pending/delivering 才代表仍需投递。规范已同步，llmdoc按用户要求不更新。
- 遗留：下一轮只做受控 replay expected version/stable target/effect/approval fencing；真实 GitHub/Cloudflare 外部项仍等待 owner/repo/App/账户配置。

## Round 25 — 2026-07-25
- 目标：Phase 3 / 受控 replay 校验 expected Run version、稳定 step/Plan Item、外部副作用和审批；从 verification step 重跑不会重复 dispatch/PR/deploy（本轮闭环控制面与真实 system verification-step restart 子项，完整条目保持未勾）。
- 前置与权限：仅本地 workerd/D1、真实 Cloudflare Workflow 测试 binding 与 fake Plan Item restart effect；未调用外部 GitHub/Cloudflare API、未创建 PR/部署、未使用真实审批主体或 Secret。Watt 定向检索未发现 Workflow restart/replay 模块可直接复制；继续直接复用 Watt-derived D1 CAS、pending→delivering→settled、stable step与 workerd introspection结构，没有自造第二套 outbox。
- 动作：
  - 先新增 3 个穿透场景；首次定向运行 exit 1，3/3 因 replay/approval/reconciliation tables不存在而红灯。场景覆盖真实 completed Workflow system-step restart、20 路并发、旧 version/任意 step、Plan Item kind、错误 base approval、未 verified PR fact、effect 前 approval expiry及既有 dispatch/PR/deploy计数。
  - 新增 migration 0007：normalized `approvals`、`workflow_replays`、`workflow_replay_effects`、`workflow_replay_reconciliations` 与 `(run,step,run_version)` step execution。replay投影随 Run/Plan级联清理，避免从属行阻断既有 FK 生命周期；approval nonce只存 digest。
  - 新增纯领域 stable target：当前 system allowlist只开放实际存在的 `verify-analysis-result/do/count=1`；active verification Plan Item由服务端派生 `plan-v<version>-item-<id>-verify`，客户端不能自报 type/name或直接选择 dispatch/wait step。
  - 新增认证 `POST /v1/runs/:runId/replay`：strict 4 KiB request、expected Run version CAS、reason仅存 digest；20 路相同请求收敛为一个 replay/outbox，同旧 version换 target/reason conflict，API不直接调用 Workflow。
  - `WorkflowReplayStore` 从 target position起收集全部下游 effects；每个 repo write/test deploy/merge/production deploy分别要求 exact task revision + plan version/digest + base SHA + effect的最新有效 approve。existing dispatch outbox必须 settled；已有 PR/check/deployment Evidence必须 passed + verified；snapshot保存 approval/ref canonical digest并在 effect前重验。
  - `WorkflowOutboxProcessor` 新增 `workflow_replay`，继续使用共享 fenced lease；approval过期/失效或 replay stale以 terminal disposition settled且零 effect，reconciliation变化保持 retry/fail-closed。Cloudflare adapter仅对 terminal instance调用 `restart({from:{name,type,count}})`，ambiguous调用以 status观察收敛，成功后写 `restart_observed_at`。
  - `DeliveryRunWorkflow` 新增稳定 `verify-analysis-result` step：先核对 immutable Plan，再以当前 Run version幂等写 step execution，最后 activation仍由既有 D1幂等/CAS处理。真实 restart后记录 version 3，而 target之前 analysis dispatch/Attempt始终各一条。
  - 中间 typecheck 因 exact optional与对象属性收窄 exit 2；显式 optional/narrowing后通过。初版 workerd 2/3通过、真实 test超时，因为 restart重建目标后历史而不是追加同名 occurrence；改用 D1 replay-version step execution作为真证据后3/3通过。
  - 新 replay FK 首次与其他测试清理并跑时2项失败；根因是从属审计行阻断旧 Run/Plan删除。迁移改为父级删除级联、approval ref置空后，7 files / 29 tests通过；没有关闭 foreign_keys或改测试掩盖。
  - `docs/Proto.md`、`docs/Architecture.md`、`docs/Security.md`、`docs/Reference.md` 同步 API、target、approval/effect snapshot、terminal Workflow precondition与本地平台实证；按用户要求不更新 llmdoc。
- 验证：
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/controlled-replay.test.ts` → 首次 exit 1，1 file / 3 tests（缺 tables）；实现/修正后 exit 0，1 file / 3 tests。
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/controlled-replay.test.ts test/workflow/delivery-run-workflow.test.ts test/workflow/workflow-callback.test.ts test/workflow/workflow-outbox.test.ts test/workflow/attempt-revocation.test.ts test/workflow/checkpoint-api.test.ts test/workflow/outbox-routing.test.ts` → exit 0，7 files / 29 tests。
  - `pnpm run typecheck`、`pnpm run lint` → exit 0。
  - `pnpm run verify` → exit 0；typecheck、ESLint、Node 10 files / 39 tests、workerd 17 files / 72 tests、61 个生产文件 Secret scan、Markdown links全绿。
  - `pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round25-20260725-1627` → exit 0；Workflow/Queue/D1/双 R2 bindings、replay API/store/effect bundle成功，未部署。
  - `git diff --check` → exit 0。
- 勾选：受控 replay完整 DoD保持未勾；新增本地控制面/workerd子项。真实 system verification replay已证明 analysis dispatch不重复；Plan Item路径已证明 approval与模拟 PR/deploy snapshot不被重新创建，但 Phase 4/5真实 PR/deploy producer尚不存在，不能用 fake restart冒充外部不重复证据。
- 决策沉淀：replay是版本化管理意图而非直接平台命令；`restart_observed_at`、step execution、outbox/Evidence是不同证据面。只有真实 producer也使用稳定 idempotency/reconciliation后，才能关闭完整“dispatch/PR/deploy不重复”DoD。规范已同步，llmdoc按用户要求不更新。
- 遗留：下一轮只做 tool-bridge调用 trace本地闭环；真实 replay PR/deploy证据随Phase 4/5 producer回补。

## Round 26 — 2026-07-25
- 目标：Phase 3 / tool-bridge 调用记录包含 run/attempt、工具路径、effect、duration、结果类别；不记录敏感参数明文。
- 前置与权限：仅本地 workerd/D1、fake service binding 与 Watt 源码只读核对；未调用真实 tool-bridge、日志/数据库、GitHub Action、计费模型或部署，未修改 Watt。真实 tool-bridge binding/短期 SK仍由 Phase 3 broker/scope条目和全局 E2E约束。
- 动作：
  - 完整读取 Watt commit `476e3cd` 的 `tools-proxy.ts`、`tool-invoker.ts`、`audit-sink/store.ts`、`tool-action.ts` 与 tool-bridge `types/registry/help`。直接迁移 `ToolEffect`、scope→action映射、Hono PEP→transport分层、`{arguments}` envelope和 D1 metadata store模式；确认 Watt 当前 `tool_calls` metric仍为空且 invoker传播上游 error message，因此没有虚构可复制的 duration/result trace，错误原文传播也明确不复制。
  - 先新增 workerd 测试；首次定向运行 exit 1，3/3 因 `tool_call_traces` table不存在红灯。随后加入 migration 0008、受信 exact-path catalog、attempt-scoped tool API、service-binding client与 trace store。
  - `POST /v1/attempts/:id/tools/call` strict body只接受 `toolPath + arguments`；active token/lease后从服务端 catalog派生 scope/action/effect。当前只允许 read effect，Phase 1仅 `repo:read` 可调用；未知 path、caller自报 effect、旧 token和缺 scope均 fail-closed，已知 scope deny留下 metadata trace且零 upstream call。
  - trace表物理上只有 trace/run/attempt/path/action/effect/duration/category/time九列，没有 arguments/header/response/error容器。结果固定分类为 success/policy_denied/upstream_error/timeout/unavailable/invalid_response；duration非负且60秒饱和。
  - transport复用 Watt-compatible `/htbp/<path>` 与 `{arguments}` envelope，15秒 timeout；成功响应以流式256 KiB上限读取且只向授权 Runner no-store返回。上游非2xx正文完全不读，transport/parser异常与注入 adapter抛错只返回固定类别；嵌套参数canary和错误canary均未进入D1或API错误。
  - `docs/Proto.md`、`docs/Architecture.md`、`docs/Security.md`、`docs/Reference.md` 同步 endpoint、catalog/PEP、service-binding、trace schema、错误类别和 Watt复用/偏离边界；按用户要求不更新 llmdoc。
- 验证：
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/tool-bridge-api.test.ts` → 首次 exit 1，1 file / 3 tests全红（缺 trace table）；实现后 exit 0，1 file / 5 tests，覆盖成功、scope deny、上游错误、timeout、Watt envelope/header与error-body不读取。
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/tool-bridge-api.test.ts test/workflow/analysis-attempt-api.test.ts test/workflow/runner-api.test.ts test/workflow/attempt-revocation.test.ts test/workflow/checkpoint-api.test.ts` → exit 0，5 files / 22 tests；现有 context/Plan/heartbeat/complete/revocation/checkpoint无回归。
  - `pnpm run typecheck`、`pnpm run lint`、`pnpm run verify:secrets`、`pnpm run verify:docs`、`git diff --check` → exit 0；65个生产文件 Secret scan全绿。
  - `pnpm run verify` → exit 0；typecheck、ESLint、Node 10 files / 39 tests、workerd 18 files / 77 tests、65个生产文件 Secret scan、Markdown links全绿。
  - `pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round26-20260725-1652` → exit 0；Workflow/Queue/D1/双R2 bindings与tool API/client/trace bundle成功，未部署。
- 勾选：Phase 3 tool-bridge调用 trace DoD完整勾选；workerd证据覆盖 run/attempt关联、trusted path/action/effect、duration/result分类和参数/上游错误canary零持久化。真实 tool-bridge服务调用不用于冒充本地DoD，其 E2E仍受全局真实tool-bridge与未完成broker/scope条目约束。
- 决策沉淀：当前 control-plane PEP proxy是短期最小闭环；未来 Runner直持短期SK时仍须产生相同 metadata trace。Watt help中的 effect只用于发现/一致性核对，不能覆盖本地catalog或提升权限；上游错误正文不进入安全响应。规范已同步，llmdoc按用户要求不更新。
- 遗留：下一轮只做 prompt injection 对抗用例；真实 tool-bridge binding、logs/trace/K8s/database scope grant与可撤销短期SK随相邻未完成DoD闭环。

## Round 27 — 2026-07-25
- 目标：Phase 3 / prompt injection 对抗用例：任务/日志/代码注释要求输出 Secret、跳过测试、修改 workflow 时，Agent 拒绝或进入审批，不执行越权动作。
- 前置与权限：仅本地 Node fake Agent/CLI executor、workerd/D1和Watt源码只读核对；未调用计费模型、真实tool-bridge/日志/数据库、GitHub Action或部署，未修改Watt。真实Codex调用仍由未完成的Agent Adapter外部子项约束，不用fake冒充。
- 动作：
  - 审计现有边界确认read-only sandbox、approval never、`project_doc_max_bytes=0`、trusted effect/command ceiling、Git snapshot零写入与Plan激活后`awaiting_approval`已存在；发现真实缺口是Agent Plan文本未做Secret scan，模型可把日志/tool/code中的敏感值复制到objective/assumption并写D1。
  - 完整读取Watt `packages/gateway/src/agent/harness/htbp-tools.ts`：直接复用“tool help/result是reference material而非instructions、不内嵌system prompt”的边界和静态措辞，并扩展到Task、日志和代码注释；Watt没有本项目的Plan criterion/verification和双层scanner，未虚构复制。
  - 先写对抗测试。首次Node定向运行exit 1（3 files，3 failed/16 passed）：optional Item跳过验收被接受、prompt缺Watt明确措辞，Runner新fixture的task digest先不匹配；修正fixture使digest与注入Task一致。workerd首次exit 1（1 file，1 failed/4 passed）：包含Worker配置Secret的Plan被201持久化，证明缺口真实。
  - Runner维护本Attempt全部敏感环境值、OIDC token、初始及heartbeat轮换后的attempt token集合；Agent Plan在任何`/plan`请求前用统一scanner检查。命中只抛固定`analysis Agent output contains sensitive material`，不上传Plan、不complete、不回显值，私有临时目录仍finally清理。
  - 控制面Plan persistence再独立扫描credential形状、当前attempt token、Task intake/webhook/GitHub App/tool-bridge Worker Secrets；scanner位于`AnalysisPlanProposalStore`写D1前，命中固定403且execution plan/item/assumption均为0。
  - ExecutionPlan validator新增两条模型外不变量：每条acceptance criterion必须由required Item覆盖；每个change/repo_write必须被下游required verification依赖，且verification引用trusted test/verify/lint/build command分类并要求test/lint/build Evidence。全optional、optional/detached verification、仅diagnostic或用普通allowed command冒充测试均拒绝。
  - 新对抗场景逐项证明：Task注入诱导复制runtime token在Runner出网前拒绝；log注入诱导复制Worker Secret在D1前拒绝；代码注释诱导修改`.github/workflows/**`只能形成repo_write提议，被analysis effect ceiling拒绝，CLI仍read-only且正文不进system prompt；跳过测试的Plan结构被validator拒绝。
  - `docs/Proto.md`、`docs/Architecture.md`、`docs/Security.md`、`docs/Reference.md`同步双层scan、required criterion覆盖、change→trusted verification和Watt复用边界；按用户要求不更新llmdoc。
- 验证：
  - `pnpm exec vitest run test/plan.test.ts test/codex-analysis-adapter.test.ts test/analysis-runner-bootstrap.test.ts` → 修复后exit 0，3 files / 20 tests；覆盖Task/runtime Secret、代码注释/workflow write、prompt正文隔离、skip-test结构和workspace零写入。
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/analysis-attempt-api.test.ts` → 修复后exit 0，1 file / 5 tests；Plan Secret固定403、canary不回显且D1 plans/items/assumptions均0。
  - `pnpm exec vitest run --config vitest.workflow.config.ts` → exit 0，18 files / 78 tests，现有Workflow/D1路径无回归。
  - `pnpm run typecheck`、`pnpm run lint` → exit 0。
  - `pnpm run verify` → exit 0；typecheck、ESLint、Node 10 files / 42 tests、workerd 18 files / 78 tests、65个生产文件Secret scan、Markdown links全绿。
  - `pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round27-20260725-1706` → exit 0；Workflow/Queue/D1/双R2 bindings和双层Plan gate bundle成功，未部署。
  - `git diff --check` → exit 0。
- 勾选：Phase 3 prompt injection对抗DoD完整勾选；证据不是断言模型一定听话，而是模拟模型服从恶意Task/log/code后，Secret、skip-test、repo/workflow write仍在Runner/控制面/validator/sandbox边界被拒，合法Plan也只能进入人审。
- 决策沉淀：prompt injection按不可信数据流处理，不做脆弱关键词检测；静态prompt只降低模型误从概率，真正权限边界是schema、Secret scanner、trusted command/effect、Plan依赖、sandbox、Git snapshot和approval。Watt的reference-not-instruction原语已复用，规范已同步，llmdoc按用户要求不更新。
- 遗留：下一轮只做同失败指纹/attempt上限进入blocked；真实Agent调用、tool-bridge SK/scope和外部recovery/replay仍按各自未完成DoD回补。

## Round 28 — 2026-07-25
- 目标：Phase 3 / 同一失败指纹连续 2 次或总 attempt 达 3 次后进入 `blocked`，卡片显示已尝试路径和所需人工输入（本轮闭环本地 D1/Runner/API/query projection 子项，父项因真实飞书卡片尚未接入保持未勾）。
- 前置与权限：仅本地 Node fake Agent、workerd/D1 与 Watt 源码只读核对；未调用真实飞书、GitHub、tool-bridge、日志/数据库、计费模型或部署，未修改 Watt、未使用真实 Secret。
- 动作：
  - 先新增 20 路重复上报、同 fingerprint 第 2 次、不同 fingerprint 第 3 个 Attempt、token撤销、Workflow cancel、安全 blocker query 和 raw message/stack/fingerprint拒绝测试；首次定向运行 exit 1，3/3 因 `run_blockers` 表不存在红灯，随后实现。
  - 从 Watt commit `476e3cd` 的 `packages/core/src/agent/expect-schema.ts` 直接复制 `DEFAULT_MAX_ATTEMPTS = 3` 和 `shouldRetry`，保持首次 + 两次重试语义。Watt没有跨 Attempt retry scope、failure fingerprint、blocker ledger或卡片投影，这些明确作为 delivery-loop 新增。
  - 新增固定 failure code/site/path/human-input 目录、服务端 retry scope/fingerprint derivation，以及 `attempt_failures`、`attempt_failure_paths`、`run_blockers` migration；Zod strict body 与 D1 CHECK 双层拒绝未知枚举，表中没有 message/stack/raw error 容器。
  - 新增认证 `POST /v1/attempts/:id/events`。active token、running status、version/generation/lease和Run状态全部命中后，一个 D1 batch写 terminal failure、Attempt failed、generation +1、清 lease和token revoke；同 fingerprint 第 2 次优先阻断，否则 scope第3个Attempt阻断。
  - blocker batch同时推进 Run、active Plan、当前 PlanItem为blocked，取消其他active Attempt、撤销token、终结未执行analysis dispatch并创建稳定Workflow cancel outbox；事务后再次核对预期Run/blocker，缺失则fail-closed。未达阈值只返回`retryAllowed`，不伪造自动Workflow retry。
  - analysis Runner对invalid Agent output、Plan Secret复制和workspace mutation只上报固定枚举，failure reporting best-effort且不替代原始安全错误；测试夹具初次漏接fetch `init`导致1项未观察到body并使typecheck exit 2，修正夹具后3/3通过，生产错误仍不回显token。
  - Task/Run查询新增卡片可消费的安全 blocker projection：按Attempt展示固定路径label、计数和固定人工输入prompt，不返回原始错误。补 active implement Plan/Item 两次verification失败穿透，证明Run/Plan/Item一致blocked；真实飞书卡片没有实现，未冒充完成。
  - `docs/Proto.md`、`docs/Architecture.md`、`docs/Security.md`、`docs/Reference.md`同步 strict event、服务端指纹、阈值优先级、token撤销、安全投影、非自动retry与Watt复用边界；按用户要求不更新llmdoc。
- 验证：
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/attempt-failure-policy.test.ts` → 首次exit 1，1 file / 3 tests全红（缺failure/blocker tables）；实现和加固后exit 0，1 file / 4 tests，覆盖analysis与active execution PlanItem、20路重放、两类阈值、token/outbox和D1枚举防线。
  - `pnpm exec vitest run test/analysis-runner-bootstrap.test.ts` → 修正新增fixture后exit 0，1 file / 3 tests；workspace mutation与Secret复制都只发送固定failure metadata，Plan不提交、临时目录清理。
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/task-query-api.test.ts test/workflow/runner-api.test.ts test/workflow/attempt-revocation.test.ts test/workflow/checkpoint-api.test.ts test/workflow/workflow-callback.test.ts` → exit 0，5 files / 20 tests。
  - `pnpm run typecheck`、`pnpm run lint`、`pnpm run verify:docs`、`git diff --check` → exit 0。
  - `pnpm run verify` → exit 0；typecheck、ESLint、Node 10 files / 42 tests、workerd 19 files / 82 tests、68个生产文件Secret scan、Markdown links全绿。
  - `pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round28-20260725-1736` → exit 0；Workflow/Queue/D1/双R2 bindings与failure API/store/query bundle成功，未部署。
- 勾选：父DoD保持未勾；新增本地D1/Runner/API/query projection子项并勾选。真实飞书tenant卡片尚无外部事实，不能用JSON query测试替代。
- 决策沉淀：失败是受信枚举投影，不是Agent自由文本；fingerprint由控制面按retry scope派生；同fingerprint阈值优先于总attempt阈值；`retryAllowed`只表达策略允许，不是调度证据。规范已同步，llmdoc按用户要求不更新。
- 遗留：真实飞书卡片需消费同一安全projection并展示路径/人工输入后才能关闭父项；下一轮另选一个未完成DoD，不在本轮扩展飞书应用。

## Round 29 — 2026-07-25
- 目标：Phase 3 / exchange成功后只返回TTL不超过Attempt lease的run token/tool-bridge SK；token digest入账，明文不落库。
- 前置与权限：仅本地workerd/D1、Node fake Runner与Watt源码只读核对；未调用真实GitHub、tool-bridge、飞书、计费模型或部署，未修改Watt、未使用真实Secret。
- 动作：
  - 先扩充exchange、heartbeat与tool API测试。首次exchange定向运行exit 1（2 failed / 3 passed），证明响应缺tool credential；首次lifecycle定向运行exit 1（9/9因`tool_token_digest`列不存在红灯），随后实现。
  - 核对Watt commit `476e3cd` 的`packages/toolbridge/vendor/tb/tenant.ts`和`packages/gateway/src/tools/tool-invoker.ts`，沿用其Bearer Secret Key只按SHA-256查找、明文不持久化边界。Watt的`apikey:<hash>→tenant`与`PROXY_SECRET_KEY`是静态KV/internal key，没有run/attempt、TTL、heartbeat rotation或revoke；未把它冒充可直接复制的短期broker，也未复制第二套hex digest。
  - 新增migration 0010：`attempt_tokens.tool_token_digest`只允许SHA-256 digest、与run-token digest不同并建立唯一索引；列名与表结构没有明文token容器。
  - OIDC exchange一次生成互不相同的`attemptToken + grant.toolBridgeToken`，TTL共同取`min(5分钟, lease剩余时间)`；20路相同exchange只有一个响应获得明文credential pair，OIDC与两个token都只存digest，响应no-store。
  - 用途隔离落到实际路由：context/Plan/heartbeat/event/checkpoint/complete只认run token；`/tools/call`只认tool token并复用Attempt status/generation/lease/revocation与scope，run token调用工具、tool token读取context都返回401。上游internal/Admin Secret仍只在Worker service-binding adapter内部使用。
  - heartbeat在同一CAS中同时轮换run/tool两个token digest与90秒lease，两个旧token都立即失效；Runner把初始和轮换后的tool token加入runtime Secret scanner，不写临时context/output。
  - complete、人工cancel与heartbeat timeout继续通过共享`revoked_at`原子撤销credential grant；新增HTTP/store回归证明tool token同步失效，stale cancel不撤销健康的run/tool pair。
  - `docs/Proto.md`、`docs/Architecture.md`、`docs/Security.md`、`docs/Reference.md`同步credential pair、用途隔离、TTL/rotation/revoke、PEP proxy与Watt复用边界；按用户要求不更新llmdoc。
- 验证：
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/github-oidc-exchange.test.ts` → 实现后exit 0，1 file / 5 tests；覆盖真实RS256 OIDC绑定、20路一次性交换、短lease截断、双digest/不同值D1约束、cross-use拒绝和负向claims。
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/runner-api.test.ts test/workflow/tool-bridge-api.test.ts test/workflow/attempt-revocation.test.ts` → exit 0，3 files / 12 tests；覆盖双token heartbeat CAS轮换、run/tool用途隔离、complete/cancel/timeout撤销及Watt-compatible transport。
  - `pnpm exec vitest run test/analysis-runner-bootstrap.test.ts` → exit 0，1 file / 3 tests；Runner采用并扫描credential pair，现有Plan/heartbeat/failure路径无回归。
  - `pnpm run typecheck`、`pnpm run lint`、`pnpm run verify:docs`、`git diff --check` → exit 0。
  - 收尾首次`pnpm run verify`在既有checkpoint 20路幂等用例出现一次波动：预期19个200、实际17个，整轮exit 1；立即将`test/workflow/checkpoint-api.test.ts`独立连续运行3次均exit 0（每次7/7），未修改或放宽断言；随后重新跑全量通过。该非本轮路径的单次波动按事实保留，不作为成功证据。
  - `pnpm run verify` → exit 0；typecheck、ESLint、Node 10 files / 42 tests、workerd 19 files / 84 tests、69个生产文件Secret scan、Markdown links全绿。
  - `pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round29-20260725-1748` → exit 0；Workflow/Queue/D1/双R2 bindings与credential exchange/rotation/PEP bundle成功，未部署。
- 勾选：Phase 3 exchange短期credential DoD完整勾选；本地证据覆盖TTL、一次性交换、双digest、明文零持久化、用途隔离、rotation与三类撤销。未用fake service binding冒充真实tool-bridge E2E，后者仍受全局真实E2E约束。
- 决策沉淀：当前“tool-bridge SK”是Runner访问控制面PEP的独立短期Bearer，PEP再以内存中的Worker internal Secret访问上游；这样能立即实现run/tool用途隔离和撤销，又不向Runner暴露Admin SK。未来Runner直连tool-bridge时必须保持相同digest-only、TTL、generation/revoke与trace契约。规范已同步，llmdoc按用户要求不更新。
- 遗留：下一轮只做分诊Attempt的repo/log/trace/K8s/database-diagnostic read/call scope与write/destructive越界拒绝；真实tool-bridge service binding仍等待外部配置。

## Round 30 — 2026-07-25
- 目标：Phase 3 / 分诊Attempt只获得允许repo/log/trace/K8s/database-diagnostic的read/call scope；越界path、write、destructive均由tool-bridge/策略层拒绝。
- 前置与权限：仅本地workerd/D1、fake tool service binding与Watt源码只读核对；未调用真实tool-bridge、GitHub、日志、数据库、K8s、飞书、计费模型或部署，未修改Watt、未使用真实Secret。
- 动作：
  - 先扩展exchange与PEP矩阵。首次exchange定向运行exit 1（1 failed / 4 passed），证明grant只有`repo:read`；tool测试首次exit 1（2 failed / 6 passed）：五个安全path均已穿透但测试错误依赖同毫秒trace UUID顺序，改为内容不变的order-independent断言；write/destructive path因不在catalog而没有显式effect deny证据，随后实现。
  - 继续直接复用Watt commit`476e3cd`的`tool-action.ts`单一scope→action映射，以及`tools-proxy.ts`认证→PEP→transport分层和deny零upstream结构。Watt没有delivery-loop具体repo/log/trace/K8s/database目录，本轮没有虚构路径代码来源。
  - 把五个安全spec设为catalog单一真源并从中派生canonical grant：`repo/read→repo:read`、`logs/search→logs:read`、`traces/get→trace:read`、`k8s/diagnose→k8s:read`、`database/diagnose→database:diagnostic`；五条POST call的effect均固定为read。
  - exchange只持久化/返回上述五项且Runner要求exact顺序与全集；JWT claim、body或Agent output不能增减grant。数据库路径只表示受信diagnostic工具，不下发DSN或任意SQL能力。
  - catalog新增已知deny capability：`repo/write`、`k8s/apply`、`database/execute`、`shell/exec`。测试主动污染D1 scopes加入全部write/destructive action，PEP仍因effect非read返回403、写metadata-only`policy_denied`且零upstream call，证明不是依赖缺scope或unknown path碰巧拒绝。
  - 未知合法path在进入trace/upstream前403，caller自报effect等额外字段400；known path缺scope留下安全deny trace。参数与上游错误正文继续不持久化，internal/Admin Secret仍不下发Runner。
  - `docs/Proto.md`、`docs/Architecture.md`、`docs/Security.md`、`docs/Reference.md`同步五项grant、call/read语义、已知effect deny和Watt复用边界；按用户要求不更新llmdoc。
- 验证：
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/github-oidc-exchange.test.ts test/workflow/tool-bridge-api.test.ts` → exit 0，2 files / 13 tests；覆盖五项grant、五条成功transport、token/scope/path/schema拒绝、scope污染后的write/destructive双门禁及metadata trace。
  - `pnpm exec vitest run test/analysis-runner-bootstrap.test.ts` → exit 0，1 file / 3 tests；Runner strict解析exact triage grant，既有heartbeat/Plan/failure路径无回归。
  - `pnpm run typecheck`、`pnpm run lint`、`pnpm run verify:docs`、`git diff --check` → exit 0。
  - `pnpm run verify` → exit 0；typecheck、ESLint、Node 10 files / 42 tests、workerd 19 files / 86 tests、69个生产文件Secret scan、Markdown links全绿。
  - `pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round30-20260725-1758` → exit 0；Workflow/Queue/D1/双R2 bindings与triage catalog/grant/PEP bundle成功，未部署。
- 勾选：Phase 3 triage read/call scope DoD完整勾选；本地证据覆盖server-derived五项grant、全部allow path、unknown/caller-policy/scope deny和scope污染下write/destructive effect deny。未用fake binding冒充真实tool-bridge外部E2E。
- 决策沉淀：grant与allow path从同一catalog派生，避免scope清单漂移；scope是必要条件，effect=`read`是独立上限。已知危险capability保留在受信catalog用于可审计显式拒绝，未知不可信path则不进入trace。规范已同步，llmdoc按用户要求不更新。
- 遗留：真实tool-bridge service binding与实际repo/log/trace/K8s/database diagnostic调用仍受全局E2E约束；下一轮转Phase 4受信delivery policy contract，不在本轮开放任何write能力。

## Round 31 — 2026-07-25
- 目标：Phase 4 / 目标仓库以受信`delivery.yaml`声明setup、定向测试、全量验证、受保护路径和部署contract；未知命令不能从任务正文直接执行。
- 前置与权限：仅本地Git临时仓库、Node测试与Watt源码只读核对；未运行policy声明的依赖安装/测试命令，未调用真实GitHub、飞书、tool-bridge、Agent模型或部署，未修改Watt、未使用真实Secret。
- 动作：
  - 先写policy parser/commit loader测试；首次定向运行因模块不存在exit 1。实现后新增command runner测试并再次以模块不存在exit 1，再完成执行边界；中间两项测试期望与strict schema不一致按真实契约修正，没有放宽生产校验。
  - 新增根目录`delivery.yaml v1`：setup/targeted/verify均为命名`argv[] + timeoutSeconds`，保护policy/workflow/CODEOWNERS/wrangler配置，当前仓库明确`deployment.mode=none`。
  - strict parser限制64 KiB并拒绝alias/merge、重复key、未知字段、NUL、绝对/穿越路径、缺失命令组和不完整deployment contract；GitHub Actions deployment target必须引用同一policy中存在的`verify:*`。合法policy计算canonical digest并递归冻结。
  - commit-bound loader只接受40位SHA并固定执行`git show <baseSha>:delivery.yaml`；测试先在工作树把verify改成恶意shell字符串，加载结果仍来自可信commit blob。loader与policy/runner API均从公共入口导出。
  - canonical ref固定为`setup:<id>`、`test:<id>`、`verify:<id>`。`DeliveryCommandRunner`只接收ref，调用者没有argv/stdin/env/后缀参数入口，并复用现有有界`execFile/spawn`、`shell:false` runtime；自然语言命令、suffix、分号和未知ref均在executor前拒绝。
  - 对Watt commit`476e3cd`全库检索delivery policy、protected paths、command refs和无shellresolver均无结果，本轮可直接复制的Watt代码为零；继续复用delivery-loop已有canonical digest、固定Git命令与共享command runtime，不虚构来源。同步`docs/Proto.md`、`docs/Architecture.md`、`docs/Security.md`、`docs/Reference.md`；按用户要求不更新llmdoc。
- 验证：
  - `pnpm exec vitest run test/delivery-policy.test.ts test/plan.test.ts test/codex-analysis-adapter.test.ts` → exit 0，3 files / 22 tests；覆盖可信commit blob、工作树篡改、canonical refs、真实executor入参、schema/deployment负向和ExecutionPlan/Codex回归。
  - `pnpm run typecheck`、`pnpm run lint`、`pnpm run verify:docs`、`git diff --check` → exit 0。
  - `pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round31-20260725-1813` → exit 0；Workflow/Queue/D1/双R2 bindings与现有Worker bundle成功，未部署。
  - `pnpm run verify` → exit 0；typecheck、ESLint、Node 11 files / 47 tests、workerd 19 files / 86 tests、72个生产文件Secret scan、Markdown links全绿。
- 勾选：Phase 4受信delivery policy DoD完整勾选；证据覆盖声明、commit来源、解析约束、部署contract、ref-only执行和任务命令拒绝。未将本地contract冒充真实repo write/PR/deploy E2E。
- 决策沉淀：`delivery.yaml`以可信base commit为策略快照，工作树改写不能改变当前Attempt；Plan只保存canonical ref，执行边界重新解析，policy/deployment声明不替代effect审批。Watt无等价模块时坚持零复制结论，最大化复用限定为有源码证据的直接复制或现有共享原语。
- 遗留：下一轮实现ready/dependency/required Item领取与状态推进gate；受保护路径命中后的暂停审批、Evidence关门和实际部署producer分别由后续Phase 4/5 DoD闭环。

## Round 32 — 2026-07-25
- 目标：Phase 4 / 只有依赖已满足且状态为ready的Plan Item能领取Attempt；Agent不得跳过investigation/verification Item或自行把required Item标为passed。
- 前置与权限：仅本地workerd/D1、Node领域回归与Watt源码只读核对；未签发repo-write token、未创建dispatch/分支/commit/PR，未调用真实GitHub、飞书、tool-bridge、Agent模型或部署，未修改Watt、未使用真实Secret。
- 动作：
  - 先写active Plan三项DAG的晋升、20路claim、伪造ready、旧Run version、caller state注入、skip trigger和Runner self-pass测试；首次定向运行exit 1，suite因`plan-item-attempt-store`模块不存在红灯，随后实现。
  - 新增`PlanItemAttemptStore`：只在`executing + exact Run version + exact active Plan/version/status`上下文晋升Item；仅所有dependency progress均为真实`passed`的pending Item可CAS成为ready，无依赖根Item先行。
  - claim strict schema只含Run/Plan/Item/progress fencing，不接受status/skip/argv/effect。执行前再次核对`ready + exact progress version + activeAttemptId=null + dependencies passed`，repository/base SHA/fixed workflow ref与mode均从D1受信投影派生。
  - claim Attempt ID由run/plan/version/item/progress version canonical digest稳定生成；migration 0011增加`claimed_progress_version`及同五元组唯一索引。D1 batch原子插入pending Attempt并把progress置`in_progress/activeAttemptId`，20路相同请求只有一个created，其余返回同一投影。
  - migration 0011增加insert/update双trigger，required Item及任意investigation/verification Item均不能进入skipped。Runner complete HTTP strict schema拒绝`planItemStatus=passed`并保持progress不变；Agent没有D1 credential，Attempt结论不会自动关闭Item，passed仍保留给后续Evidence verifier。
  - 对Watt commit`476e3cd`全库检索dependency DAG、ready和Attempt claim，仅发现CLI初始化的线性resume skip，没有可直接复制的等价调度器；本轮Watt代码复制量为零，继续复用此前迁移的D1零行CAS纪律、canonical digest与workerd migration/test harness，不虚构来源。
  - 同步`docs/Proto.md`、`docs/Architecture.md`、`docs/Security.md`、`docs/Reference.md`；按用户要求不更新llmdoc。
- 验证：
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/plan-item-attempt-store.test.ts test/workflow/checkpoint-api.test.ts test/workflow/attempt-failure-policy.test.ts test/workflow/lease-cas.test.ts test/workflow/controlled-replay.test.ts` → exit 0，5 files / 24 tests；覆盖6项新claim/Agent/D1负向及恢复、失败、租约、replay回归。
  - `pnpm exec vitest run test/plan.test.ts test/recovery-runner.test.ts` → exit 0，2 files / 13 tests。
  - `pnpm run typecheck`、`pnpm run lint`、`pnpm run verify:docs`、`git diff --check` → exit 0。
  - `pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round32-20260725-1826` → exit 0；Workflow/Queue/D1/双R2 bindings与现有Worker bundle成功，未部署。
  - `pnpm run verify` → exit 0；typecheck、ESLint、Node 11 files / 47 tests、workerd 20 files / 92 tests、74个生产文件Secret scan、Markdown links全绿。
- 勾选：Phase 4 ready/dependency/required Plan Item领取DoD完整勾选；本地证据覆盖拓扑晋升、claim双重核对、20路幂等、strict Agent边界和D1 skip防线。未把pending Attempt冒充repo-write授权或实际Action执行。
- 决策沉淀：ready是控制面从持久DAG派生的可领取状态，不是Agent自报；领取消费exact progress version并建立唯一Attempt身份。Agent只能上报Attempt事实，不能选择Plan Item终态；required和investigation/verification不可skip，passed必须由独立Evidence gate决定。
- 遗留：下一轮实现repo_write effect approval与repo-scoped、TTL/revoke GitHub credential；当前claim不创建dispatch、不签token，也不授予任何仓库写能力。

## Round 33 — 2026-07-25
- 目标：Phase 4 / 未批准`repo_write`时创建分支/commit/PR全部失败；批准后token仅限目标repo且过期可撤销。
- 前置与权限：仅本地workerd/D1、Node fake GitHub REST与GitHub官方REST/OpenAPI只读核对；未请求真实installation token、未创建远端branch/commit/PR、未触发Action或部署，未修改Watt、未使用真实Secret。
- 动作：
  - 先写approval/Task policy拒绝、单仓库签发、AES密文、20路并发、provider失败重领、expiry/cancel/new reject撤销与HTTP穿透测试；首次suite因broker模块不存在exit 1。随后为GitHub provider补write/revoke测试，首次1项因方法不存在红灯；implementation OIDC exchange测试首次返回403红灯，均在实现后转绿。
  - 复用Round 25`approvals`exact snapshot：broker同时核对Task allow、implement/review_fix、active Attempt lease/generation、Run executing、exact active Plan/version/digest/base、in_progress active Item和repo_write effect；latest exact decision必须approve且未过期。错误base、无审批、expired或更新reject在GitHub调用前403，provider零调用。
  - implement/review_fix可通过原GitHub OIDC绑定换run/tool credential，但grant只有triage read/diagnostic加`checkpoint:write`，明确不含`repo:write`。写能力只能通过新增认证`POST /v1/attempts/:id/github/write-token`，body仅version/generation且响应no-store。
  - 扩展同一GitHub App provider而非复制第二套JWT：写profile固定`repositories:[目标repo]`与`contents:write + pull_requests:write`，不含Actions/deploy/admin；write token不缓存、不跨Attempt共享。普通dispatch仍沿用Actions write + contents read缓存profile。
  - migration 0012新增`github_write_credentials`：identity绑定attempt/generation/effect，D1唯一约束与issuance lease使20路最多一个GitHub请求；provider失败可claim同一row重试。明文token不落D1，只存SHA-256 digest和以credential identity作additional data的AES-256-GCM ciphertext/IV，密钥来自Worker Secret。
  - authorization TTL取GitHub expiry、approval expiry和Attempt lease最小值。scheduled revoker每分钟重新核对Attempt/token/Run/Plan/Item/Task policy/approval；expiry、更新reject或Attempt cancel/lost/fail/complete后lease-fenced调用`DELETE /installation/token`，成功或GitHub自身expiry后清密文，失败进入`revocation_pending`重试，revoker crash可接管过期lease。
  - 签发外部调用期间若出现新reject，最终CAS不激活token并立即revoke；revoke暂不可用则先持久化密文供scheduled重试，避免产生无人可撤销的外部token。真实Runner HTTP负向/正向证明未批准拿不到远端branch/commit/PR所需凭证，批准后只得到目标repo profile。
  - 首次最终全量回归暴露既有checkpoint 20路相同sequence竞态：部分请求首次查不到projection，却在随后MAX(sequence)看到赢家提交，错误返回409。修正为判定out-of-order前重新读取exact sequence并核对immutable projection；没有放宽 changed/lower sequence冲突。
  - 官方2022-11-28 REST OpenAPI核对`DELETE /installation/token`语义与204响应；Watt commit`476e3cd`无GitHub installation write/revoke或approval-bound credential模块，本轮直接复制量为零，继续复用本项目GitHub App provider、Watt-derived digest-only/lease/CAS原语。同步四份规范，按用户要求不更新llmdoc。
- 验证：
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/repo-write-credential.test.ts test/workflow/github-oidc-exchange.test.ts test/workflow/attempt-revocation.test.ts test/workflow/attempt-failure-policy.test.ts test/workflow/github-dispatcher.test.ts test/workflow/plan-item-attempt-store.test.ts` → exit 0，6 files / 34 tests；新broker suite 9项覆盖HTTP、approval/policy、并发、密文、竞态、expiry/cancel/reject及revoke重试。
  - `pnpm exec vitest run test/github-app-installation-token.test.ts test/redaction.test.ts test/plan.test.ts` → exit 0，3 files / 20 tests；GitHub provider写profile与官方revoke形状、Secret redaction和Plan回归通过。
  - `curl -fsSL --max-time 30 https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.2022-11-28.yaml | rg -n -A 36 -B 4 '/installation/token'` → exit 0；官方schema确认DELETE、撤销后token invalid与204。
  - `pnpm run typecheck`、`pnpm run lint`、`pnpm run verify:docs`、`git diff --check` → exit 0。
  - `pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round33-20260725-1851` → exit 0；新增broker/revoker与Workflow/Queue/D1/双R2 bindings可正常打包，未部署。
  - 首次最终`pnpm run verify` → exit 1；既有checkpoint并发用例预期19个200、实际12个，未作为成功证据。修复TOCTOU后`for run in 1 2 3 4 5; do pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/checkpoint-api.test.ts || exit 1; done` → 5轮均exit 0，每轮1 file / 7 tests。
  - 最终`pnpm run verify` → exit 0；typecheck、ESLint、Node 11 files / 48 tests、workerd 21 files / 102 tests、77个生产文件Secret scan、Markdown links全绿。
- 勾选：Phase 4 repo_write approval/单仓库token/expiry+revoke DoD完整勾选；本地外部边界证明无审批时provider零调用，批准后权限仅目标repo contents/PR write，过期/取消/reject会撤销。未用fake REST冒充真实GitHub branch/commit/PR E2E，后者仍由Phase 4最终试点条目验证。
- 决策沉淀：run/tool grant永不携带repo_write；写能力是独立、exact approval绑定的短期GitHub capability。为了Worker重启后仍可真实撤销，token以密钥分离的AES-GCM密文短暂持久化，撤销/expiry后清除；仅“控制面拒绝继续使用”不能替代GitHub外部revoke。
- 遗留：下一轮实现受信分支命名、bot commit identity、main/受保护分支和force-push拒绝；本轮未开放任意Git命令或实现PR producer。

## Round 34 — 2026-07-25
- 目标：Phase 4 / 分支命名含task/attempt，commit作者为GitHub App/明确bot；禁止push main和强推受保护分支。
- 前置与权限：仅本地临时Git工作仓库+bare remote、Node测试和Watt源码只读核对；使用非生产测试credential，未访问真实GitHub、未创建真实branch/commit/PR、未触发Action或部署，未修改Watt、未使用真实Secret。
- 动作：
  - 先写真实repo/remote正向与main/base/protected/force/ref-injection/identity负向测试；首次定向运行exit 1，suite因`git-repository-writer`模块不存在红灯。初版实现后正向prepare因Git `show-ref --verify`对缺失嵌套ref返回128而1项失败，改用`--quiet`得到可判定exit 1后转绿；没有放宽push策略。
  - 新增`GitRepositoryWriter`，构造必须持有未过期、目标repo一致、权限exact为contents/pullRequests write的broker credential；prepare/commit/push每步重新核对expiry。repository/task/attempt/base SHA/base branch/protected branch均strict校验。
  - branch固定由受信identity派生为`agent/<taskId>/<attemptId>`，不接受模板、prefix或caller refspec。prepare要求clean tree和HEAD=exact base SHA；existing branch只有base仍为ancestor时可重入，否则fail-closed。
  - commit入口无参数，固定stage all与只含task/attempt的message；author+committer均强制`Delivery Loop Bot <delivery-loop[bot]@users.noreply.github.com>`，提交后从commit对象复验。清除宿主`GIT_*`，关闭hooks/GPG，避免repo/host覆盖身份或执行hook。
  - push strict body只有targetBranch+force；target必须等于derived branch且不能是main/master/base/受信protected列表，force必须false。固定argv只含同名完整refs，永不出现force/force-with-lease/+refspec；Git默认拒绝non-fast-forward。
  - approved GitHub token仅经一次性子进程environment的`http.extraHeader`注入，不进入argv；Git stderr不进入policy错误。真实bare remote验证derived ref SHA=bot commit、main ref保持base SHA。
  - 把recovery原有两套Git调用收敛到writer新增的`executeGitCommand`：统一execFile/shell=false、30秒timeout、64KiB output、no terminal prompt与固定错误，避免复制进程边界。
  - Watt commit`476e3cd`仅发现CLI自身destructive confirmation的`--force`参数，无目标仓库branch/commit/push writer可复制；本轮Watt直接复制量为零。同步四份规范，按用户要求不更新llmdoc。
- 验证：
  - `pnpm exec vitest run test/repository-writer.test.ts test/recovery-runner.test.ts test/github-app-installation-token.test.ts test/delivery-policy.test.ts` → exit 0，4 files / 13 tests；真实Git正向、固定身份/no-force负向、recovery/provider/policy回归通过。
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/repo-write-credential.test.ts test/workflow/plan-item-attempt-store.test.ts test/workflow/checkpoint-api.test.ts` → exit 0，3 files / 22 tests；approval/credential、Plan调度和checkpoint无回归。
  - `pnpm run typecheck`、`pnpm run lint`、`pnpm run verify:docs`、`git diff --check` → exit 0。
  - `pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round34-20260725-1907` → exit 0；Worker/Workflow/Queue/D1/双R2 bindings bundle成功，Node writer未误入Worker runtime，未部署。
  - `pnpm run verify` → exit 0；typecheck、ESLint、Node 12 files / 51 tests、workerd 21 files / 102 tests、78个生产文件Secret scan、Markdown links全绿。
- 勾选：Phase 4 derived branch/bot commit/no-main/no-force DoD完整勾选；真实本地Git remote证明行为，负向请求均在spawn前拒绝。未用bare remote冒充真实GitHub branch protection或App外部身份，真实试点证据保留在Phase 4最终E2E条目。
- 决策沉淀：repository writer不是任意Git代理；branch/refspec/message/identity/force均由Runner固定，Agent只能产生工作树diff。GitHub token走子进程env而非argv，客户端no-force与GitHub branch protection是叠加防线，不能互相替代。
- 遗留：下一轮实现delivery policy protected paths与内建workflow/CODEOWNERS/Secret/deploy路径diff gate，命中后在commit前持久化`awaiting_approval`及安全diff摘要。

## Round 35 — 2026-07-25
- 目标：Phase 4 / Agent修改workflow、CODEOWNERS、Secret/部署配置等高风险路径时自动停在`awaiting_approval`并列出diff。
- 前置与权限：仅本地临时Git仓库+bare remote、workerd/D1与Watt源码/全量Git历史只读核对；使用测试token/ciphertext，未访问真实GitHub、未创建远端commit/PR、未调用飞书/Agent/tool-bridge或部署，未修改Watt、未使用真实Secret。
- 动作：
  - 先写真实Git added/deleted/renamed/untracked、普通文件放行、Secret canary不进入report，以及D1/API/CAS/revoke/query/workflow pause正反测试。首次Node定向运行exit 1（1 failed/1 passed）：`ProtectedPathApprovalRequired`尚不存在且高风险改动完成了commit；首次workerd suite因`protected-path-approval-store`模块不存在exit 1、0 tests，红灯对应真实缺口。
  - 新增`ProtectedPathChangeReport v1`与内建高风险pattern：固定覆盖delivery policy/workflows/任意层CODEOWNERS、`.env*`/`.dev.vars*`/常见secrets文件、Wrangler、Docker Compose、Terraform和常见K8s/Helm/deploy目录，再与可信base commit的`delivery.yaml.protectedPaths`取并集。matcher锚定repo相对路径，拒绝绝对/穿越/反斜杠/控制字符；rename old/new任一命中即拦截。
  - `GitRepositoryWriter.commitAll`在commit前以NUL分隔`name-status + numstat`解析exact staged tree；报告只含base/tree/policy/diff digest、总文件数与path/previousPath/changeType/line counts。diff digest绑定`baseSha + stagedTreeSha`，不保存patch hunk、文件正文或Git stderr；高风险命中调用必配reporter后固定抛`ProtectedPathApprovalRequired`，commit/push均不可达，普通README改动仍以固定bot成功commit。
  - 新增`ControlPlaneProtectedPathApprovalReporter`：endpoint/Attempt/CAS均构造时strict校验，Bearer仅进HTTPS header，body只含version/generation与安全report；只有202且响应canonical report完全相同才视为控制面已接收，网络/非202/内容漂移全部固定错误且writer继续拒绝commit。
  - migration 0013新增`protected_path_change_gates/entries`及Plan Item gate ref。`ProtectedPathApprovalStore`只接受active token已认证后的running repo_write Attempt，逐项核对lease、executing Run/version、exact active Plan/Item/base、Task policy和仍active的单仓库write credential；同`attempt + generation`唯一，report的base/tree/diff不一致或上下文伪造均无状态变化。
  - 接收gate的同一D1 batch把Run置`awaiting_approval`、Attempt置`cancelled`并version/generation+1、清lease/revoke run+tool token、Item progress绑定gate、write credential置`revocation_pending`并创建稳定`workflow_pause` outbox。consumer二次核对gate/Run/Attempt后调用Workflow terminate；Task/Run查询只列安全diff摘要。相同store report重放收敛，取消后的stale pause安全settle，不把失败/跳过伪装成成功。
  - `delivery.yaml`补充本仓库Secret/infra protected patterns；Run状态图开放后续exact diff approval后的`awaiting_approval→executing`恢复边，但本轮只实现暂停/请求，不虚构尚未实现的人审decision producer。同步`docs/Proto.md`、`docs/Architecture.md`、`docs/Security.md`、`docs/Reference.md`；按用户要求不更新llmdoc。
  - 对Watt commit`476e3cd`当前树与全量Git历史检索protected path、CODEOWNERS、Git name-status/numstat、diff gate和awaiting approval，无等价实现可复制，本轮Watt直接复制量为零。最大化复用delivery-loop已有commit-bound policy、fixed Git executor、Attempt CAS/token revoke、repo-write revoker、D1 outbox与query projection，不虚构源码来源。
- 验证：
  - `pnpm exec vitest run test/repository-writer.test.ts test/protected-path-change-gate.test.ts test/protected-path-approval-reporter.test.ts` → exit 0，3 files / 7 tests；覆盖真实Git普通/高风险路径、rename/delete/untracked、policy+内建pattern、safe report、commit/push阻断与HTTPS reporter绑定。
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/protected-path-approval.test.ts` → exit 0，1 file / 3 tests；覆盖store/API exact context、原子awaiting projection、token/credential revoke、safe query、幂等、伪造effect拒绝和真实outbox processor terminate调用。
  - `pnpm run test:unit` → exit 0，14 files / 55 tests；`pnpm run test:workflow` → exit 0，22 files / 105 tests。
  - `pnpm run typecheck`、`pnpm run lint`、`pnpm run verify:docs`、`pnpm run verify:secrets`、`git diff --check` → exit 0；Secret scanner核对82个生产文件。
  - `pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round35-20260725-1930` → exit 0；Worker/Workflow/Queue/D1/双R2 bindings与新增gate/API/outbox/query bundle成功，未部署。
  - `pnpm run verify` → exit 0；typecheck、ESLint、Node 14 files / 55 tests、workerd 22 files / 105 tests、82个生产文件Secret scan、Markdown links全绿。
- 勾选：Phase 4高风险path自动暂停DoD完整勾选；本地真实Git证明commit/push前阻断，workerd/D1证明Run=`awaiting_approval`、Attempt/credential fencing、Workflow terminate与安全diff查询。未把本地fake effect冒充真实GitHub/飞书人审或批准后恢复，后者随Phase 2 approval producer/Phase 4真实试点回补。
- 决策沉淀：“列出diff”采用content-bound digest + path/type/numstat，而不是持久化raw patch；否则Secret配置本身会被复制进D1/卡片。repo_write effect approval只允许普通仓库写，不等于高风险path审批；命中后撤销当前execution capability并以外部状态恢复，符合控制面可回放模型。
- 遗留：下一轮只做定向测试→required verify→Evidence闭环；高风险gate的人审decision与批准后replacement由后续approval/调度项实现，不在本轮扩大权限面。

## Round 36 — 2026-07-25
- 目标：Phase 4 / 先跑与改动相关的定向测试，再跑仓库required verify；命令、exit code、duration、head SHA入Evidence。
- 前置与权限：仅本地Node fake command/Git/HTTP与workerd/D1；未执行`delivery.yaml`声明的真实目标仓库测试命令，未访问真实GitHub/飞书/tool-bridge/Agent或部署，未修改Watt、未使用真实Secret。
- 动作：
  - 先写Runner顺序/targeted失败/required失败/selection/head漂移与D1/API exact manifest/乱序/failure/idempotency/strict body/query测试。首次Node suite因`verification-execution-runner`模块不存在exit 1、0 tests；首次workerd suite因`verification-evidence-store`模块不存在exit 1、0 tests，红灯对应真实执行与持久化缺口。
  - 新增`VerificationSuiteManifest/CommandResult v1`：manifest只含exact head、policy digest、非空唯一`test:*`与`verify:*`列表；result只含position、phase、canonical ref、0～255 exit code、0～3600000ms duration和head SHA，strict schema物理上没有stdout/stderr/summary/status/verified入口。
  - 新增`VerificationExecutionRunner`并直接复用`DeliveryCommandRunner`与共享`executeGitCommand`。调用者只能从commit-bound policy targeted map选择至少一个相关`test:*`；Runner按稳定ID自动追加policy verify map的全部`verify:*`，不能由Plan/Agent删减。启动前及每条命令前后复核`HEAD`，head漂移不生成Evidence；duration只覆盖命令窗口，spawn异常固定exit 127且不传播stderr。
  - 执行顺序固定为selected targeted→全部required verify。任一targeted非0先上报失败Evidence并立即停止，required阶段零执行；任一required非0同样停止剩余required。每次reporter返回的suite状态必须与当前位置/exit推导一致，服务端重排/提前completed也fail-closed。
  - 增加真实临时Git仓库穿透：不注入command executor，直接由共享spawn runtime依次执行policy中的`node` targeted与required verify，前后Git HEAD不变并生成两条duration-bearing report；因此顺序正向不只由fake executor证明。
  - 新增`ControlPlaneVerificationEvidenceReporter`：每次start/record动态读取heartbeat轮换后的最新attempt token/version/generation，Bearer只进固定HTTPS header；响应只接受200/201+`Cache-Control:no-store`，start返回的完整command序列必须与本地manifest逐项相同，错误正文不读取。
  - migration 0014为Evidence增加duration并新增`verification_suites/commands`。`VerificationEvidenceStore`只接受implement/review_fix running lease、executing Run、exact active Plan、required verification Item、in_progress activeAttempt、exact Attempt head、test Evidence声明且无pending protected gate；manifest命令集合必须与Plan Item command refs exact相等，同attempt/generation/head/policy只有一套suite。
  - result只接受当前first pending命令且全部前序passed；targeted-before-required由position+phase双约束。稳定Evidence ID绑定suite/position，D1写run/attempt/plan version/item、kind=test、server-derived passed/failed与固定summary、command/exit/duration/head，初始`verification_status=unverified`。相同结果幂等，改写或跨Attempt猜测ID拒绝；查询新增durationMs但仍不返回summary/命令输出。
  - delivery policy每组command上限补到50以匹配有界suite schema。同步`docs/Proto.md`、`docs/Architecture.md`、`docs/Security.md`、`docs/Reference.md`；按用户要求不更新llmdoc。
  - 对Watt commit`476e3cd`当前树与相关Git历史检索targeted/required verify、command Evidence、duration/head SHA绑定，只发现`scripts/e2e/lib.ts`同步CLI spawn、exitCode/stderr失败对象与人类PASS/SKIP日志；无durable suite/Plan gate可复制，且stderr传播不符合本项目安全边界，因此本轮Watt直接复制量为零。最大化复用delivery-loop现有command/Git/Plan/Attempt/Evidence/query原语，不虚构来源。
- 验证：
  - `pnpm exec vitest run test/verification-execution-runner.test.ts test/verification-evidence-reporter.test.ts test/delivery-policy.test.ts test/repository-writer.test.ts` → exit 0，4 files / 16 tests；覆盖真实子进程targeted→verify、fake两阶段失败停止、selection、HEAD fencing、duration、stderr隔离、轮换token reporter与policy/Git回归。
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/verification-evidence.test.ts test/workflow/plan-item-attempt-store.test.ts test/workflow/checkpoint-api.test.ts` → exit 0，3 files / 17 tests；覆盖suite/Evidence正反、strict HTTP、跨Attempt/idempotency、Plan claim与checkpoint binding回归。
  - `pnpm run test:unit` → exit 0，16 files / 63 tests；`pnpm run test:workflow` → exit 0，23 files / 109 tests。
  - `pnpm run typecheck`、`pnpm run lint`、`pnpm run verify:docs`、`pnpm run verify:secrets`、`git diff --check` → exit 0；Secret scanner核对87个生产文件。
  - `pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round36-20260725-1951` → exit 0；Worker/Workflow/Queue/D1/双R2 bindings及新增verification API/store/query成功bundle，未部署。
  - `pnpm run verify` → exit 0；typecheck、ESLint、Node 16 files / 63 tests、workerd 23 files / 109 tests、87个生产文件Secret scan、Markdown links全绿。
- 勾选：Phase 4 targeted→required verify与Evidence入账DoD完整勾选；Runner顺序和HEAD由Node契约证明，D1/API真实workerd证明command/exit/duration/head安全入账与乱序拒绝。Evidence保持unverified，本轮未冒充下一项doneWhen核对或Item passed。
- 决策沉淀：相关targeted由版本化Plan Item从受信policy map显式选择，required verify由Runner从同一commit-bound policy自动补全；两者在控制面以exact集合重新绑定。exit 0是原始执行事实而不是“验收通过”，所以Evidence先unverified，下一轮独立verifier才能关门。
- 遗留：下一轮只实现required Item doneWhen/plan/head Evidence核对与passed gate；失败修复循环仍由其后的独立DoD处理。

## Round 37 — 2026-07-25
- 目标：Phase 4 / 每个required Plan Item的doneWhen映射到同plan version/item/head SHA的已核对Evidence；required skipped、Agent自报、failed Evidence或旧SHA不能关门。
- 前置与权限：仅本地workerd/D1与源码/测试；未调用真实GitHub、飞书、tool-bridge、Agent或部署，未使用真实Secret，未修改Watt。对Watt commit`476e3cd`当前树和Git历史检索doneWhen、逐criterion Evidence mapping、plan/head-bound verification decision及required Item passed gate，没有等价源码可直接复制，本轮Watt直接复制量为零；最大化复用delivery-loop既有canonical digest、服务Bearer、Plan/Attempt CAS、verification suite/Evidence ledger、token撤销与query projection。
- 动作：
  - 审计生产代码确认此前没有`plan_item_progress.status='passed'`写路径；测试只有`plan-item-attempt-store.test.ts`一处直接UPDATE passed，其他passed均为历史投影fixture。先新增逐doneWhen、failed/旧SHA、direct passed/skipped、Agent token/forged body、query/idempotency测试；首次定向运行因`plan-item-evidence-verifier`模块不存在exit 1、0 tests，红灯对应真实关门缺口。
  - 新增migration 0015：`plan_item_verifications`绑定exact run/plan version/item/Attempt/head/关闭前progress version/evidence-set digest；`plan_item_done_when_evidence`保存有序逐doneWhen映射。D1 trigger拒绝required progress未经过decision/mapping/verified passed Evidence直接UPDATE passed；已映射verified Evidence关键绑定/结果/SHA不可改，mapping存在时不可删。
  - 新增唯一生产关门路径`PlanItemEvidenceVerifier`：重新核对Run executing/verifying、active Plan/digest、required in-progress Item、active implement/review_fix Attempt version/generation/lease/head。每条doneWhen必须映射Evidence并逐条覆盖Item声明的kind、command refs与external facts；Evidence必须同run/attempt/plan version/item/head且passed，`test:/verify:` Evidence还必须来自completed suite中的passed command。
  - verifier以一个D1 batch写稳定decision/mapping和digest、把Evidence置verified、Attempt completed/generation+1、清lease/撤销token、write credential进入revocation pending并以旧progress version推进passed。相同请求重放返回同一decision；缺失/failed/旧SHA/跨Attempt/改写mapping全部fail-closed且无部分推进。
  - 新增服务认证`POST /v1/runs/:runId/items/:itemId/verify`；strict body只有版本/fencing/head与doneWhen→Evidence ID，不接受status/verified自报，Agent run token返回401。`GET /v1/runs/:runId/plan`为passed Item投影decision ID、head、evidence-set digest、去重Evidence IDs、逐doneWhen mapping和verifiedAt，不读取Evidence正文或Workflow状态。
  - 移除旧scheduler测试直接UPDATE passed捷径：先真实claim investigation，设置running lease/head，写同Attempt/head diagnostic Evidence，再调用verifier后断言下游ready。同步`docs/Proto.md`、`docs/Architecture.md`、`docs/Security.md`、`docs/Reference.md`；按用户要求不额外更新llmdoc。
  - 首次最终`pnpm run verify`在既有GitHub App token测试exit 1：provider使用固定12:00 UTC生成JWT，但测试中的`jwtVerify`使用真实时钟，当前已越过12:09 UTC expiry。独立复跑仍1/3失败，确认非并行波动；仅给测试verifier注入同一固定`currentDate`后独立3/3和全量均通过，未修改生产token逻辑或放宽验签。
- 验证：
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/plan-item-evidence-verifier.test.ts test/workflow/plan-item-attempt-store.test.ts test/workflow/verification-evidence.test.ts test/workflow/task-query-api.test.ts` → exit 0，4 files / 17 tests；覆盖逐doneWhen、exact binding、failed/旧SHA/跨Attempt、direct mutation、Agent/forged HTTP、幂等decision、安全query与scheduler解锁。
  - `pnpm exec vitest run test/github-app-installation-token.test.ts` → 固定测试时钟后exit 0，1 file / 3 tests。
  - `pnpm run verify:docs`、`pnpm run verify:secrets`、`git diff --check` → exit 0；Secret scanner核对89个生产文件。
  - 最终`pnpm run verify` → exit 0；typecheck、ESLint、Node 16 files / 63 tests、workerd 24 files / 113 tests、89个生产文件Secret scan、Markdown links全绿。
  - `pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round37-20260725-2016` → exit 0；Workflow/Queue/D1/双R2 bindings与新增verifier/API/query/migration bundle成功，未部署。
- 勾选：Phase 4逐doneWhen Evidence关门DoD完整勾选；证据覆盖D1 trigger、服务认证API、exact plan/Attempt/head、suite provenance、原子passed与安全恢复投影。测试中的service-side diagnostic fixture只证明通用Evidence gate，不冒充尚未执行的真实日志/数据库调查或外部试点。
- 决策沉淀：Evidence passed是单一事实，不等于Item passed；只有版本化逐doneWhen decision才能关闭required Item。Agent只负责产生受限事实，控制面负责把事实核对为状态迁移；decision/mapping/digest进入D1，因此Worker/Workflow重启后无需恢复模型会话即可重放并快速收敛。Watt无等价代码时不做伪复用，继续复用已验证的基础原语。
- 遗留：下一轮只做测试失败的有界修复循环与同失败指纹去重；真实试点repo的GitHub Action、PR及外部Evidence仍由后续Phase 4条目闭环。

## Round 38 — 2026-07-25
- 目标：Phase 4 / 测试失败允许有界修复循环；同失败指纹不重复消耗，达到上限进入`blocked`（本轮闭环本地Evidence-bound控制面/dispatch子项；父项因固定workflow尚无execution Runner保持未勾）。
- 前置与权限：仅本地workerd/D1、fake GitHub dispatch effect与Watt源码只读核对；未调用真实GitHub、Codex模型、飞书、tool-bridge或部署，未使用真实Secret，未修改Watt。完整读取Watt commit`476e3cd`的`packages/gateway/src/agent/harness/llm.ts`与`packages/core/src/agent/expect-schema.ts`；直接可复用量是Round 28已复制的`DEFAULT_MAX_ATTEMPTS=3`、`shouldRetry`及首次+两次重试边界。Watt单进程schema重试没有跨Action Attempt/Evidence/D1/outbox/fencing实现，未虚构复制。
- 动作：
  - 审计确认已有`AttemptFailureStore`只返回`retryAllowed`并计数/blocked，不创建replacement或dispatch；`implement`切`review_fix`还会因mode进入不同retry scope而重置预算。现有GitHub dispatcher只允许analysis，固定workflow也只启动analysis Runner。
  - 先新增真实failed verification suite→repair、20路相同event、同指纹第二次、三个不同指纹、无Evidence自报、stale dispatch和安全query测试。首次定向运行exit 1，1 file / 3 tests全红，响应只有`retryAllowed`而没有repair，证明缺口不是测试夹具。
  - migration 0016新增`attempt_failure_verification_facts`：只有同active Plan/Item/Attempt generation/head的failed suite+command+Evidence才能写入source suite/Evidence/head/fact digest；digest只含phase/canonical command ref/exit code。对应failed Evidence、suite与command关键字段随后由trigger锁定，不能改写失败为成功或删除命令证据。
  - 新增`attempt_repairs`保存failure、failed/repair Attempt、Plan/Item、source fact、retry scope/fingerprint。`implement/review_fix`规范化成共享`execution`scope，避免换mode重置Watt三次预算；verification fingerprint再绑定受信phase/ref/exit fact，因此新head上同一命令同一exit仍识别为连续失败，不把head变化误当新根因。
  - 第一次可信测试失败在同一D1 batch写failure/fact、旧Attempt failed/generation+1、撤销run/tool token、active write credential转revocation pending，创建稳定identity的pending `review_fix` Attempt（base/head为失败head、branch为空、无token/credential）、切换Item activeAttempt并写唯一`execution_dispatch`。20路重放只一条repair/outbox且仅一个response为`created=true`；Agent夹带`retry`字段固定400。
  - 同fingerprint第二个Attempt直接`repeated_fingerprint` blocked，不创建第三个；三个不同trusted command failure只允许两个repair，在第三个Attempt以`attempt_limit` blocked。阻断仍原子推进Run/Plan/Item、撤销token、settle未执行analysis/execution dispatch并创建Workflow cancel intent。
  - GitHub dispatch processor扩展`execution_dispatch`但只接受`attempt_repairs`绑定、Run executing/verifying、exact active Plan、in-progress active Item且无protected gate的implement/review_fix Attempt。延迟消息在Plan/block后`repair_dispatch_stale` settle且GitHub零调用；正常fake effect收到reference-only mode/plan/item/失败head并把Attempt置starting。
  - Task/Run查询为repair Attempt投影repair/failure/source suite/Evidence refs，blocker每个Attempt可附安全verification fact refs/digest，不返回测试输出。cancel/heartbeat-timeout同步settlepending execution dispatch。同步`docs/Proto.md`、`docs/Architecture.md`、`docs/Security.md`、`docs/Reference.md`；按用户要求不额外更新llmdoc。
- 验证：
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/verification-repair-loop.test.ts` → 首次exit 1，3/3因缺repair红灯；实现与加固后exit 0，1 file / 5 tests，覆盖无Evidence自报、20路幂等、fact immutability、same-head dispatch、stale零effect、同指纹和总上限。
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/verification-repair-loop.test.ts test/workflow/attempt-failure-policy.test.ts test/workflow/github-dispatcher.test.ts test/workflow/task-query-api.test.ts test/workflow/attempt-revocation.test.ts` → exit 0，5 files / 21 tests；既有failure/blocker、analysis dispatch、query与撤销路径无回归。
  - `pnpm run verify:docs`、`pnpm run verify:secrets`、`git diff --check` → exit 0；Secret scanner核对90个生产文件。
  - `pnpm run verify` → exit 0；typecheck、ESLint、Node 16 files / 63 tests、workerd 25 files / 118 tests、90个生产文件Secret scan、Markdown links全绿。
  - `pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round38-20260725-2048` → exit 0；Workflow/Queue/D1/双R2 bindings与新增failure fact/repair/dispatch/query bundle成功，未部署。
- 勾选：父DoD保持未勾；新增“本地控制面/workerd穿透”子项并勾选。fake GitHub effect只证明fenced dispatch契约，不能证明Action实际修改代码或重新验证；当前`.github/workflows/delivery-agent.yml`仍只调用analysis Runner，不能冒充修复循环完整完成。
- 决策沉淀：`retryAllowed`不是修复事实；自动repair必须由可信failed Evidence触发。repair是新的最小权限Attempt，不是旧Agent原地续命：继承失败Git head作为起点，但不继承token、write credential或branch，所有effect重新过Plan/approval gate。Watt的进程内for-loop只提供次数边界，durable lineage和外部dispatch必须由控制面持久化。
- 遗留：下一轮继续同一父DoD，只实现固定workflow的execution Runner穿透：从失败head建立新attempt分支，运行受限Agent修复，重新执行targeted→required verify并让真实Runner failure链路消费本轮repair；在此之前不勾父项，也不进入Draft PR DoD。

## Round 39 — 2026-07-25
- 目标：Phase 4 / 测试失败有界修复循环下的本地真实Git execution Runner；从repair checkout head建立新分支，受限Agent编辑后由可信Runner提交/push并重新执行targeted→required verify（父项和固定workflow真实Action子项继续保持未勾）。
- 前置与权限：仅本地真实临时Git仓库/bare remote、Node子进程、fake Agent/reporter与源码测试；未访问真实GitHub、Codex计费模型、Cloudflare、飞书或tool-bridge，未部署，未使用真实Secret。对Watt固定commit`476e3cd`的Agent harness/core/tool-bridge检索并核对；无Codex workspace-write、目标仓库Git writer或head-bound verification Runner可直接复制，本轮Watt直接复制量为零，继续最大化复用本项目已有Watt-derived不可信reference、Attempt上限/outbox/CAS及既有writer/policy/command/Evidence原语。
- 动作：
  - 先修正dispatch identity：`base_sha`继续绑定Run base供OIDC/approval/policy使用，新增`checkout_sha`指向repair失败head；dispatcher所有payload携带二者，固定workflow checkout改用`checkout_sha`。对应workflow/dispatcher/repair测试保持全绿，避免把失败head错误冒充Run base。
  - 先新增`codex-execution-adapter`与`execution-attempt-runner`红灯，首次因模块不存在为2 suites / 0 tests、exit 1。实现非交互`codex exec --ephemeral --sandbox workspace-write + approval-never`，context/output必须是repo外私有常规文件；prompt明确不授予Git、测试、PR、审批或部署authority。
  - 新增可信本地编排：prepare派生branch→Agent edit→固定bot commit→no-force push→head report→exact-head targeted→全部required verify。真实临时repo/bare remote与真实Node verification子进程证明顺序和远端head；只有verification Runner产出的nonzero command Evidence才发送固定结构化failure。
  - 审查发现Agent input可缺失并退化到伪造占位路径，先补负向测试得到1/3失败，再改为required exact workspace/context/output/timeout输入。Agent/Git/head/reporter异常保持原错误，不调用verification failure reporter，避免错误消耗repair预算。
  - prompt不是Git权限边界：`GitRepositoryWriter.commitAll`在Agent后重新核对当前branch及HEAD仍为repair checkout head，bot commit后再核对唯一parent；Agent自行创建commit/移动HEAD即使还有未提交改动也在push前拒绝。同步DOD与Architecture/Proto/Security/Reference；按用户要求不额外更新llmdoc。
- 验证：
  - `pnpm exec vitest run test/codex-execution-adapter.test.ts test/execution-attempt-runner.test.ts test/repository-writer.test.ts` → 加固前exit 1，1/3 Runner用例证明缺失Agent input未拒绝；实现后exit 0，3 files / 9 tests，覆盖私有文件、真实Git分支/bot commit/no-force push、targeted→required、可信失败分类及Agent自建commit拒绝。
  - `pnpm run typecheck`、`pnpm run lint`、`git diff --check` → exit 0。
  - `pnpm run verify` → exit 0；typecheck、ESLint、Node 18 files / 69 tests、workerd 25 files / 118 tests、92个生产文件Secret scan、Markdown links全绿。
  - `pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round39-20260725` → exit 0；Workflow/Queue/D1/双R2 bindings与当前Worker bundle成功，未部署。
- 勾选：新增并勾选Phase 4“本地真实Git execution Runner”子项。父DoD与“固定GitHub workflow接入真实execution Runner”保持未勾：当前workflow仍只调用analysis脚本，尚无execution context/head CAS/heartbeat/credential bootstrap、生产HTTP reporters和真实Action连续失败→blocked外部证据。
- 决策沉淀：`workspace-write`只是文件系统沙箱，不是Git effect授权；Agent prompt只能表达目标，可信Runner必须在Git层验证HEAD lineage并独占commit/push。verification failure预算只消费head-bound command Evidence，Agent进程、Git或transport故障不能伪装成测试失败。Watt没有等价execution路径时直接复制量诚实记零，不为满足“复用”而引入不适配的Worker内LLM harness。
- 遗留：下一轮仍停留在同一父DoD，只实现固定workflow的execution bootstrap与控制面execution context/head CAS/生产reporter穿透；真实GitHub Action和连续失败blocked证据依赖远端/安装权限，完成前父项不勾。

## Round 40 — 2026-07-25
- 目标：Phase 4 / 固定GitHub workflow的本地生产execution bootstrap穿透；补齐execution context、bot head CAS、heartbeat/credential/reporters并让真实Git Runner failure链路提交可被repair store消费的Evidence/event（真实试点Action子项与父DoD保持未勾）。
- 前置与权限：仅本地workerd/D1/R2、fake HTTPS/OIDC/control-plane、真实临时Git仓库/bare remote和真实Node verification子进程；未访问真实GitHub、Codex计费模型、Cloudflare远端、飞书或tool-bridge，未部署、未使用真实Secret。继续核对Watt固定commit`476e3cd`的Agent/workflow/OIDC/Git路径，没有GitHub execution bootstrap、repo credential/head CAS或Evidence reporter可直接复制，本轮Watt直接复制量为零；最大化复用delivery-loop已有Watt-derived CAS/outbox/attempt上限与现成OIDC、heartbeat、credential、writer、protected gate、verification/failure原语。
- 动作：
  - 先写workerd execution context/head API测试；首次exit 1，2/2因`attempt_head_updates`不存在红灯。再写workflow mode路由与`runExecutionAttempt`真实Git bootstrap测试；首次Node运行workflow 1/1失败且bootstrap suite因模块不存在0 tests，证明固定workflow仍只有analysis。
  - migration 0017新增每Attempt generation唯一的`attempt_head_updates`，绑定run/plan/item/parent/head/derived branch与commit Evidence；transition和其关键Evidence字段不可改。`ExecutionHeadStore`在同一D1 batch重新核对running lease、executing/verifying Run、active Plan、in-progress active Item、repo_write effect和无protected gate，写固定summary commit Evidence并把Attempt head/version CAS前进；20路同内容仅一条，branch/parent/head漂移拒绝。
  - `RunnerAuthorization`增加服务端mode；`GET /context`按analysis/implement/review_fix路由。新增`ExecutionAttemptContextStore`，只返回exact execution scopes、Task allow write、D1/R2 canonical digest一致、active required Item及声明的doneWhen/command/evidence/effects；review_fix必须回查immutable repair source suite/Evidence/head/fact及服务端phase/command/exit，原始测试输出不返回。
  - 新增`POST /head` strict API，body没有status/verified/commit message等Agent控制字段。新增动态`ControlPlaneExecutionHeadReporter`与fixed failure reporter；head response必须version+1。verification reporter增加token/version在heartbeat竞态后的安全重取，并支持bootstrap的串行authorization gate。
  - 新增`runExecutionAttempt`与脚本：核对dispatch env/真实checkout HEAD/clean tree、GitHub OIDC和execution exchange、Task digest/base/checkout/repo/plan/item；从Run base SHA读取commit-bound policy，在repo外写0600 context/output并扫描runtime Secret，取得exact approval-bound write token，45秒heartbeat贯穿Agent/Git/verification。共享mutex串行heartbeat rotation、head CAS、Evidence/failure请求；finally清理临时目录。
  - `ExecutionAttemptRunner`在任何effect前核对policy digest并执行全部trusted setup；随后派生branch、受限Agent edit、固定bot单commit/no-force push、head report、targeted→required。真实nonzero command写failed Evidence后才发送固定failure event；Agent/Git/head/transport错误不消耗repair预算。Agent窗口限制5分钟，超过则由外部checkpoint/replacement Attempt恢复，避免当前lease-bound写token失效后继续push。
  - 固定`.github/workflows/delivery-agent.yml`改为单attempt job：完整fetch `checkout_sha`且不保留凭证；先校验analysis必须无plan binding、implement/review_fix必须有plan binding，再互斥调用analysis或execution脚本。默认permissions仍仅`contents:read + id-token:write`，写token只由execution bootstrap运行时broker取得。
  - review_fix workerd穿透增强：真实failed suite→repair dispatch后激活replacement token，再调用生产context API核对source fact与失败head。Node bootstrap分别以真实bot push证明pass Evidence路径和targeted exit 7证明fixed terminal failure body；没有message/stack/测试输出。同步DOD与Architecture/Proto/Security/Reference；按用户要求不额外更新llmdoc。
  - 首次全量unit在既有analysis heartbeat测试exit 1：并行调度下20ms cadence偶发触发第二次heartbeat，而fake只实现一次轮换。将测试cadence改为500ms，仍真实等待并证明一次轮换，同时消除毫秒级时序依赖；独立analysis+execution 2 files / 5 tests及最终全量均通过，未修改生产analysis heartbeat。
- 验证：
  - `pnpm exec vitest run test/execution-runner-bootstrap.test.ts` → exit 0，1 file / 2 tests；覆盖真实Git pass与真实targeted failure、OIDC/context/credential、heartbeat、bot push、head version、ordered Evidence、fixed terminal event和临时文件清理。
  - `pnpm exec vitest run test/execution-runner-bootstrap.test.ts test/delivery-agent-workflow.test.ts test/codex-execution-adapter.test.ts test/execution-attempt-runner.test.ts test/verification-evidence-reporter.test.ts test/protected-path-approval-reporter.test.ts test/repository-writer.test.ts` → exit 0，7 files / 16 tests。
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/execution-attempt-api.test.ts test/workflow/verification-repair-loop.test.ts` → exit 0，2 files / 7 tests；覆盖20路head CAS、strict/forged/stale拒绝、commit Evidence、真实repair context/source fact和既有bounded loop。
  - `pnpm run typecheck`、`pnpm run lint`、`git diff --check` → exit 0。
  - 最终`pnpm run verify` → exit 0；typecheck、ESLint、Node 19 files / 71 tests、workerd 26 files / 120 tests、98个生产文件Secret scan、Markdown links全绿。
  - `pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round40-20260725` → exit 0；Workflow/Queue/D1/双R2 bindings与新增API/store成功bundle，未部署；migration 0017的从空库应用由workerd测试证实。
- 勾选：在“固定GitHub workflow接入真实execution Runner”下新增并勾选“本地固定workflow/生产bootstrap穿透”子项；其父项和“真实试点GitHub Action”保持未勾。本地fake HTTPS与bare Git只证明生产代码接线和D1契约，不能证明GitHub-hosted Runner、真实Codex认证、App token或连续Actions failure→blocked。
- 决策沉淀：`base_sha`继续绑定Run/OIDC/approval/policy，`checkout_sha`是repair工作区起点；bot head必须通过独立CAS把Attempt从parent推进到新commit，不能由Agent或dispatch自报覆盖。heartbeat和所有mutation共享串行fencing，避免轮换token与head/Evidence请求互相使旧。Watt没有等价执行面时不硬搬Worker内AI SDK harness，复用可证明相同语义的基础原语。
- 遗留：真实试点Action证据仍需用户确认GitHub owner/repo/visibility并安装App/配置环境后执行；等待外部前置期间，下一轮可继续Phase 4不依赖远端的Draft PR正文生成与Secret scanner本地穿透，父repair DoD继续保持未勾。

## Round 41 — 2026-07-25
- 目标：Phase 4 / Draft PR正文包含来源任务/revision、验收标准逐条状态、变更摘要、风险、测试证据、未完成项和回滚说明；本轮只冻结可发布正文，不创建GitHub PR或推进`pull_request_open`。
- 前置与权限：仅本地Node/workerd/D1/R2与源码测试；未访问真实GitHub、Cloudflare远端、Codex计费模型、飞书或tool-bridge，未部署、未使用真实Secret。对Watt固定commit`476e3cd`检索PR创建/body/acceptance/rollback与GitHub pull request producer，只发现CI的`pull_request`触发器，没有等价正文renderer、Evidence eligibility、durable snapshot或外部reconciliation可直接复制，本轮Watt直接复制量为零；最大化复用Watt-derived D1幂等/Secret边界与本项目已有Task digest、Plan decision、head/Evidence ledger。
- 动作：
  - 先写确定性renderer测试；首次`pnpm exec vitest run test/pull-request-draft.test.ts test/redaction.test.ts`因模块不存在exit 1、0 tests。再写真实workerd API/store测试；首次3/3因draft tables不存在exit 1，证明此前没有可恢复正文producer而不是fixture缺字段。
  - 新增`pull-request-draft`领域renderer：固定七个必需章节，来源Task/revision与净化URL、Plan/branch/final head、已完成Item、逐验收标准状态/Evidence、服务端派生风险、test command/exit/duration/head、optional未完成项和按deploy effect派生的回滚说明。Task/Plan自然语言转义Markdown/HTML/`@mention`；source URL含userinfo时不发布，否则移除query/fragment并编码括号。输入和最终Markdown双重Secret scan，UTF-8正文上限65,536 bytes。
  - migration 0018新增`pull_request_drafts`及criteria/test Evidence/unfinished Item三张规范化子表；snapshot只允许`prepared`，主表与子表禁止UPDATE，stable identity绑定run/plan/version/final head/body digest。
  - 新增`PullRequestDraftStore`唯一生产路径：只接受`expectedRunVersion + planVersion/digest + headSha`，调用方不能提交body/status/summary/risk。生成前重新核对`verifying` Run、exact active Plan/base、D1/R2 Task canonical digest、最新completed implement/review_fix Attempt、derived branch、immutable head transition/commit Evidence、required Item全部经`plan_item_verifications`关门、无protected gate，以及final head completed suite的verified passed test Evidence；optional未完成Item显式列出。
  - 新增服务认证`POST /v1/runs/:runId/pull-request-draft`，strict 4KiB请求、`no-store`响应；Agent token和caller-authored正文拒绝，stale Plan/head/Item返回409，Secret命中403，超限413。20路相同请求只有一个`created=true`，全部返回同一draft/body digest/body并复核持久化子快照。
  - 同步`docs/Proto.md`、`docs/Architecture.md`、`docs/Security.md`、`docs/Reference.md`；明确`prepared` snapshot只是后续GitHub producer的durable input，不能冒充PR外部事实；按用户要求不额外更新llmdoc。
- 验证：
  - `pnpm exec vitest run test/pull-request-draft.test.ts test/redaction.test.ts` → exit 0，2 files / 8 tests；覆盖章节/确定性/安全文本、URL净化、UTF-8大小与Secret拒绝。
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/pull-request-draft.test.ts test/workflow/plan-item-evidence-verifier.test.ts test/workflow/execution-attempt-api.test.ts` → exit 0，3 files / 9 tests；覆盖20路幂等、D1/R2/head/Plan/Evidence gate、immutable snapshot、Agent/forged/stale/incomplete拒绝和损坏Task canary最终扫描。
  - `pnpm run test:unit` → exit 0，20 files / 73 tests；`pnpm run test:workflow` → exit 0，27 files / 123 tests；`pnpm run typecheck`、`pnpm run lint`、`git diff --check` → exit 0。
  - 最终`pnpm run verify` → exit 0；typecheck、ESLint、Node 20 files / 73 tests、workerd 27 files / 123 tests、101个生产文件Secret scan、Markdown links全绿。
  - `pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round41-20260725` → exit 0；Workflow/Queue/D1/双R2 bindings与新增API/store/migration成功bundle，未部署。
- 勾选：Phase 4 Draft PR正文DoD完整勾选；本地真实workerd证明正文从durable verified facts确定生成、持久化和重放收敛。下一条“PR创建由GitHub webhook外部核对”保持未勾，本轮没有PR URL/number/webhook/API外部Evidence，也没有把D1正文snapshot冒充GitHub PR。
- 决策沉淀：PR正文不是Agent交付文本，而是控制面基于DOD/Evidence的发布投影；先冻结body digest再调用外部平台，才能让Workflow/Queue重放快速恢复且避免不同正文创建重复PR。Task description和Evidence summary/output不进入正文；只有Task验收标准在安全转义与Secret scan后按逐项Evidence状态发布。
- 遗留：下一轮进入“PR创建由GitHub webhook外部核对”的本地producer/outbox/webhook contract；真实GitHub创建与外部核对仍依赖用户确认owner/repo/visibility、App安装与目标仓库配置，取得真实PR事实前不得勾选。

## Round 42 — 2026-07-25
- 目标：Phase 4 / PR创建由GitHub webhook外部核对，Agent自报PR URL不能直接推进状态（本轮闭环本地生产producer、signed webhook与API repair契约；父项因无真实GitHub PR事实保持未勾）。
- 前置与权限：仅本地Node/workerd/D1、fake GitHub REST和测试HMAC；只读核对GitHub官方REST/webhook文档与Watt固定commit`476e3cd`，未访问真实GitHub API、Cloudflare远端、Codex计费模型、飞书或tool-bridge，未部署、未使用真实Secret。Watt再次全库检索`/pulls`、createPullRequest、Octokit与PR webhook，仍只有CI`pull_request`触发器，没有PR producer/publication projector可直接复制，本轮Watt直接复制量为零；最大化复用Watt-derived fenced outbox/D1条件写及本项目现有App token、HMAC delivery和API observation原语。
- 动作：
  - 先写GitHub PR REST adapter测试；首次因`github-pull-request`模块不存在exit 1、0 tests。再写workerd scheduler/outbox/webhook/API reconciliation测试；首次同样因模块不存在exit 1、0 tests，红灯证明此前prepared正文没有任何GitHub effect或外部状态入口。
  - 实读GitHub官方Create a pull request契约，确认`POST /repos/{owner}/{repo}/pulls`的title/head/base/body/draft/maintainer_can_modify与201/403/422；实读`pull_request` webhook action集合、`opened`与App Pull requests读权限。producer固定same-repo、`draft:true`、`maintainer_can_modify:false`，其他action当前安全ack ignored。
  - migration 0019新增`pull_request_publications`、`github_pull_request_webhook_deliveries`、`github_pull_request_api_observations`：publication snapshot列不可变、状态只能pending→created_unverified→verified，draft/head唯一；webhook/API只保存digest、repo/number、external time和安全disposition，不保存raw body/REST response/token。
  - 新增service-only strict`POST /v1/runs/:runId/pull-request`：body只有`expectedRunVersion + draftId`，Agent token与夹带URL/number/status拒绝。scheduler重新核对verifying Run、prepared draft、active Plan/digest/final head、最新Attempt、required Item、protected gate、Task policy和exact最新repo_write approval；20路请求只产生一个stable publication和`pull_request + github_api` outbox，不推进Run。
  - 新增PR-only GitHub App token profile，repository-narrowed且权限只有`pull_requests:write`，与Actions read token、Runner contents-write token隔离并独立缓存。REST adapter先以`state=all + owner:head`查既有PR；exact open Draft/base/head SHA/title/body digest才复用，冲突/closed/多结果fail-closed；POST和查询错误不传播response body/token。
  - `GitHubPullRequestOutboxProcessor`直接复用共享pending→delivering→settled lease/fencing；20路consumer只一次effect，effect前重新核对Run/Plan/draft/head/approval及更新reject。GitHub create/list响应只写candidate number/净化URL和`created_unverified`，网络不确定回pending并在重试前按head reconciliation，不写Evidence或Run状态。
  - 扩展`POST /v1/webhooks/github`：raw body先HMAC，再按event路由。`pull_request opened`必须exact same-repo、open Draft、base/head branch、head SHA、server title、prepared body digest与安全HTTPS URL；delivery ID+raw digest去重，同ID换payload冲突，binding mismatch ignored。唯一projector在D1 batch写fixed-summary verified PR Evidence、publication observation version并CAS Run verifying→pull_request_open；Agent自报没有调用路径。
  - 新增scheduled `GitHubPullRequestReconciler`，只轮询已有candidate number但未verified的publication，GET结果复用同一projector，用于修复missed webhook。Queue/relay新增独立`github_api`destination，未配置App时保持retry；Wrangler production runtime已接线。
  - 首次全量workerd在既有`plan-item-evidence-verifier` HTTP用例1/4失败：fixture lease固定到当日14:10 UTC，真实时钟已越界导致409。独立复跑仍失败，确认是历史时间炸弹；只把测试lease延到2099后独立4/4与全量全绿，未修改生产verifier或放宽过期检查。
  - 同步`docs/Proto.md`、`docs/Architecture.md`、`docs/Security.md`、`docs/Reference.md`；按用户要求不额外更新llmdoc。
- 验证：
  - `pnpm exec vitest run test/github-pull-request-api.test.ts test/github-app-installation-token.test.ts` → exit 0，2 files / 6 tests；覆盖PR-only token权限/缓存、exact list/create/GET、same-head复用、冲突body与安全错误。
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/github-pull-request.test.ts test/workflow/outbox-routing.test.ts test/workflow/github-workflow-run-webhook.test.ts test/workflow/github-run-reconciler.test.ts` → exit 0，4 files / 17 tests；覆盖20路scheduler/effect幂等、approval双检、Agent/forged拒绝、create不推进、签名exact webhook、delivery重放、binding mismatch、API repair、三destination Queue routing及既有workflow facts回归。
  - `pnpm run test:unit` → exit 0，21 files / 76 tests；`pnpm run test:workflow` → 修正历史test lease后exit 0，28 files / 126 tests。
  - 最终`pnpm run verify` → exit 0；typecheck、ESLint、Node 21 files / 76 tests、workerd 28 files / 126 tests、107个生产文件Secret scan、Markdown links全绿；`git diff --check` → exit 0。
  - `pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round42-20260725` → exit 0；Workflow/Queue/D1/双R2 bindings与新增scheduler/outbox/webhook/reconciler/migration成功bundle，未部署。
- 勾选：父DoD保持未勾；新增并勾选“本地控制面/workerd/REST契约”子项。fake GitHub REST与测试HMAC证明生产代码的权限、幂等和外部事实门槛，但没有真实PR URL/number或GitHub delivery，不能冒充真实App创建/webhook核对。
- 决策沉淀：PR effect与PR fact必须分层。REST 201只证明某次调用返回候选，不能成为业务真源；publication/outbox负责可恢复effect，signed webhook/API projector负责外部事实，D1 Run只消费后者。PR token进一步从Runner write token拆分为`pull_requests:write`单用途，缓存不等于授权，effect前仍需审批双检。
- 遗留：真实GitHub父项继续等待owner/repo/visibility、App安装、webhook与目标仓库配置；在不伪造外部证据的前提下，下一轮可继续Phase 4的Review comment/head-SHA-bound`review_fix`本地契约。

## Round 43 — 2026-07-25
- 目标：Phase 4 / Review comment绑定PR head SHA并创建`review_fix` attempt；已过时评论不误改新代码（本轮闭环本地signed webhook、D1/R2/dispatch/context/head CAS与同PR分支真实Git契约；真实GitHub review父项保持未勾）。
- 前置与权限：仅本地workerd/D1/R2、测试HMAC和真实临时Git/bare remote；未访问真实GitHub API、Cloudflare远端、Codex计费模型、飞书或tool-bridge，未部署、未使用真实Secret。按用户要求对Watt固定commit`476e3cd`全库检索`pull_request_review`、`changes_requested`、review comment/attempt与PR branch update，没有等价producer、ledger或writer可直接复制，本轮Watt直接复制量为零；最大化复用Watt-derived HMAC/delivery digest、D1 conditional write、stable identity和fenced outbox，以及本项目现有Task/R2 digest、approval、execution context/head CAS与fixed Git executor。
- 动作：
  - 先运行已新增workerd契约；首次exit 1，2/2都因`review_feedback_attempts`表不存在红灯。再新增真实Git writer测试；首次exit 1，2/2分别证明writer错误创建当前Attempt branch且不核对远端PR head。
  - migration 0020新增`github_review_webhook_deliveries`、`github_review_feedbacks`、`review_feedback_attempts`；D1没有自由文本body列，feedback/lineage snapshot不可UPDATE，同review/Attempt唯一。签名`pull_request_review submitted/changes_requested`严格核对review commit=payload PR head、same-repo/base/branch/verified publication及该branch最新immutable bot head。
  - feedback body在任何D1/R2写入前扫描全部Worker配置Secret与credential形状；通过后只写私有`TASK_OBJECTS/review-feedback/...`，D1保存ref/digest/安全URL/time与Plan lineage。stale head只记ignored delivery且零R2/Attempt；同delivery换payload或同review ID改写content/head/branch返回409，20路相同review收敛为一份feedback/Attempt/outbox。
  - exact review在一个D1 batch按合法edge推进`pull_request_open v9 → awaiting_review v10 → executing v11`，把原`passed v3` Item重开为`in_progress v4`，保留旧verification decision/Evidence不可变，并创建从reviewed SHA checkout的pending`review_fix` Attempt。dispatcher允许`attempt_repairs`与`review_feedback_attempts`两种互斥source，仍在GitHub effect前重验active Run/Plan/Item/gate，dispatch不含review正文。
  - execution context为review source新增`reviewFeedback`和受信`targetBranch/targetBranchMode`；从R2回读时复验metadata/schema/feedback ID/body canonical digest/head/branch/URL/time，篡改固定拒绝。verification repair继续只返回`repair`，两种source不能并存；ExecutionHeadStore按source接受派生branch或原PR branch，并维持每generation唯一commit Evidence/head transition。
  - `GitRepositoryWriter`新增`existing_fast_forward`模式：只允许同task namespace的既有PR branch，clean/exact checkout后用token仅进Git环境的`ls-remote`核对远端head等于reviewed SHA，再从该SHA建立本地branch；bot single commit后固定same-ref non-force push。远端在prepare前或push前推进都拒绝，main不变且不创建当前Attempt branch。
  - 同步DOD与Architecture/Proto/Security/Reference；真实review/Actions/PR URL和外部bot SHA不存在，因此只勾本地子项，真实试点子项与父项保持未勾；按用户要求不额外更新llmdoc。
- 验证：
  - 红灯`pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/github-review-feedback.test.ts` → exit 1，1 file / 2 failed；缺三张review表。
  - 红灯`pnpm exec vitest run test/review-fix-repository-writer.test.ts` → exit 1，1 file / 2 failed；错误派生新branch且stale remote未拒绝。
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/github-review-feedback.test.ts` → exit 0，1 file / 3 tests；覆盖20路收敛、Run/Item version、dispatch、D1/R2回读与篡改、same-delivery/review mutation、stale head和Secret零持久化。
  - `pnpm exec vitest run test/review-fix-repository-writer.test.ts test/repository-writer.test.ts test/execution-runner-bootstrap.test.ts` → exit 0，3 files / 8 tests；覆盖同PR branch fast-forward、main/current-Attempt branch隔离、远端两阶段竞态和既有verification repair bootstrap回归。
  - `pnpm run typecheck`、`pnpm run lint`、`git diff --check` → exit 0。
  - 最终`pnpm run verify` → exit 0；typecheck、ESLint、Node 22 files / 78 tests、workerd 29 files / 129 tests、109个生产文件Secret scan、Markdown links全绿。
  - `pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round43-20260725` → exit 0；Workflow/Queue/D1/双R2 bindings与新增webhook/store/migration成功bundle，未部署。
- 勾选：Phase 4 Review comment DoD下新增并勾选“本地控制面/workerd/真实Git契约”子项；父项及“真实试点GitHub外部事实”保持未勾，本地HMAC/bare Git不冒充真人review、GitHub delivery、Actions run或外部PR branch事实。
- 决策沉淀：review feedback不是verification failure，两种repair source必须互斥；评论自然语言只是不可信R2数据，不能重置测试失败预算或进入dispatch。review commit/head是第一道fence，Git remote-head核对+non-force push是第二道fence；旧head评论在模型和Git effect之前即被控制面丢弃。同一PR的review fix必须fast-forward原branch，才能让GitHub review/checks继续围绕同一PR恢复，而不是产生不可关联的新Attempt branch。
- 遗留：完整父DoD仍需用户确认GitHub owner/repo/visibility、安装App并配置webhook/目标workflow后，由真人在试点Draft PR提交Changes requested；需记录review/PR/Actions URL、delivery ID、新bot SHA与required checks，并实证stale review零Action。下一轮可继续同Phase的不依赖远端项“review改变Plan正文/base/effect时创建新Plan版本”，不得提前勾真实外部项。

## Round 44 — 2026-07-25
- 目标：Phase 4 / review或补充上下文需要改变计划正文、base SHA、effect时创建新Plan版本并使旧审批过期，不原地改写active Plan（本轮闭环本地D1/Store核心；真实review/飞书/Meegle/base source producer与Workflow E2E保持未勾）。
- 前置与权限：仅本地Node/workerd/D1与fake immutable source fact；未访问真实GitHub、Cloudflare远端、Codex计费模型、飞书、Meegle或tool-bridge，未部署、未使用真实Secret。按用户要求核对Watt固定commit`476e3cd`，全库检索`supersede/replan/plan revision/approval invalidation/plan version`与checkpoint approval组合无匹配实现，本轮Watt直接复制量为零；最大化复用Watt-derived D1 conditional update/stable identity/outbox，以及本项目ExecutionPlan validator、Attempt fencing、token/credential revoke和query projection。
- 动作：
  - 先新增`plan-revision` workerd契约；首次因`plan-revision-store`模块不存在exit 1、0 tests，证明规范虽声明Plan版本不可变，运行代码没有revision ledger/approval invalidation/替换路径。
  - migration 0021新增`plan_revision_source_facts`、`plan_revisions`、`approval_invalidations`。source fact绑定run/旧Plan/version/digest、kind/ref/digest/requested base且不可UPDATE；caller格式正确的ref/digest没有source fact仍零状态变化。revision稳定identity绑定expected Run/旧Plan/source/base，approval原行不改，invalidation另表append-only。
  - `PlanRevisionStore.begin`仅消费exact source fact；20路并发只创建一个pending analysis Attempt与`analysis_dispatch`，Run从允许的pre-merge状态CAS回`planning/version+1`并固定新base；同batch取消旧Plan active Attempt、generation+1、撤销token、write credential置revocation pending、protected gate superseded、旧execution/PR outbox settled、旧Plan全部approval invalidated。
  - replacement仍走现有ExecutionPlan schema/DAG/criterion/command/effect/base/digest validator，并必须是strict next version且createdBy绑定revision analysis Attempt。activation从规范化Plan/Item关系重算semantic body/effect digest；body/base/effect至少一项变化才按顺序将旧active Plan置superseded、新validated Plan置active、Run切到`awaiting_approval/version+1`并完成analysis Attempt。
  - 无变化的proposal不制造v2：new Plan置superseded、revision置rejected、Run恢复旧active Plan的`awaiting_approval`安全门，旧approval仍保持invalidated所以必须重审；重复activation稳定返回`no_change`，不留下planning卡死状态。
  - migration trigger禁止UPDATE ExecutionPlan identity/objective和normalized Item/criterion/doneWhen/dependency/effect/command/Evidence/external-fact关系，并限制Plan status单调迁移。Run状态机新增所有active pre-merge/blocked状态到planning的显式replan edge，merging/deploying/终态仍拒绝。
  - repo-write credential issuance/active check、PR scheduler/effect、review feedback projector与controlled replay全部新增`approval_invalidations`排除；`GET /v1/runs/:id/plan`新增reference-only revision摘要，只公开source kind/digest、旧/新Plan refs/base/change flags/time，不公开R2 source ref/正文。
  - 同步DOD与Architecture/Proto/Security/Reference；只勾本地核心子项，父项与真实source producer/Workflow E2E保持未勾；按用户要求不额外更新llmdoc。
- 验证：
  - 红灯`pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/plan-revision.test.ts` → exit 1，1 failed suite / 0 tests；缺`plan-revision-store`生产模块。
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/plan-revision.test.ts` → exit 0，1 file / 4 tests；覆盖20路begin、source fact拒绝、旧Attempt/token/outbox/approval fencing、body/base/effect v2原子激活、query恢复投影、no-op拒绝/恢复和Plan normalized-table immutable trigger。
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/plan-revision.test.ts test/workflow/repo-write-credential.test.ts test/workflow/controlled-replay.test.ts test/workflow/github-pull-request.test.ts test/workflow/github-review-feedback.test.ts` → exit 0，5 files / 20 tests；覆盖所有现有approval消费者回归。
  - `pnpm run typecheck`、`pnpm run lint`、`git diff --check` → exit 0。
  - 最终`pnpm run verify` → exit 0；typecheck、ESLint、Node 22 files / 79 tests、workerd 30 files / 133 tests、111个生产文件Secret scan、Markdown links全绿。
  - `pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round44-20260725` → exit 0；Workflow/Queue/D1/双R2 bindings与新增store/migration/query成功bundle，未部署。
- 勾选：Phase 4 Plan revision DoD下新增并勾选“本地D1/Store核心契约”子项；父项及“真实source producer与编排”保持未勾。手工seed的source fact只证明下游不可变替换/fencing，不能冒充签名review、飞书/Meegle context revision、GitHub base observation或真实re-analysis Action。
- 决策沉淀：Plan revision不是对active Plan做patch，而是“source fact→fence旧执行/审批→analysis strict next version→semantic diff→atomic active pointer swap”。approval精确绑定本已阻止跨Plan复用，但独立invalidation ledger让“为什么提前失效”可审计，并避免旧Plan被恢复时未来expiry重新生效。Plan digest含version/identity，不能用digest不同证明业务内容变化；必须从normalized tables重算排除identity/base的semantic digest，并单独比较base/effects。
- 遗留：下一轮仍在同一父DoD补source producer/生产编排，优先把Round43 verified GitHub review feedback原子投影为`review_feedback` source fact并由受控decision启动re-analysis；飞书/Meegle补充上下文需要先落实Task新revision契约，base change需要GitHub branch observation。三类外部事实未接通前父项不勾；之后再进入base branch冲突/rebase DoD。

## Round 45 — 2026-07-25
- 目标：Phase 4 / review或补充上下文改变Plan时创建新版本并使旧审批过期——本轮闭环签名GitHub review的本地source producer与Runner受控decision编排；飞书/Meegle、base observation和真实Actions/Workflow外部证据保持未完成。
- 前置与权限：仅本地Node/workerd/D1/R2、测试HMAC、fake HTTP与临时Git remote；未访问真实GitHub、Cloudflare远端、Codex计费模型、飞书、Meegle或tool-bridge，未部署、未使用真实Secret。按用户要求核对Watt固定commit`476e3cd`，全库检索`replan/plan revision/review feedback/changes requested/source fact`，唯一近似代码是`watt-task-workflow.ts`的稳定`request-plan-confirmation`步骤；该路径只等待人类确认已有Plan，不含签名review lineage、immutable source fact、Attempt/token/approval fencing或Plan replacement，直接复制会混淆安全语义，因此本轮Watt直接复制量为零；继续最大化复用其稳定Workflow步骤、D1持久状态、strict schema和conditional-write模式。
- 动作：
  - 先在既有review workerd套件新增strict endpoint契约；首次运行exit 1，5 tests中新增2条均因`POST /v1/attempts/:id/plan-revision`不存在而返回404，旧3条仍通过，证明此前verified review feedback没有生产re-analysis入口。
  - migration 0020在签名review producer落库时冻结`expected_run_version = review投影完成后的Run version`；migration 0021让source fact同时绑定该版本。聚焦测试第一次实现后发现手工推进Run仍被错误接受（预期409、实际202），据此改为消费冻结版本，而不是把请求时“当前Run version”重新当作可信事实。
  - 新增Attempt-authenticated strict endpoint，body只有`expectedVersion + leaseGeneration`。只有恰好一条`review_feedback_attempts`、零`attempt_repairs`、active running `review_fix`、exact Plan/Item/publication/head/branch/lease及冻结Run version全部命中才可进入；caller夹带Plan/ref/digest/base/effect由strict schema在source fact前拒绝。
  - source ref固定为`d1://github-review-feedbacks/<feedbackId>`，source digest只由D1 feedback ID/review ID/body digest/head/branch/URL/time canonical派生，requested base只取Run。source insert作为PlanRevisionStore begin同一D1 batch的首条statement，随后原子创建唯一analysis Attempt/outbox、Run CAS回planning、取消旧review Attempt、generation+1、撤销token并settle旧execution intent；20路并发允许已进入鉴权的请求收敛，撤销后新请求固定401。
  - 新增Codex execution strict decision schema，仅接受无额外字段的`apply_fix/request_replan` JSON final message。后者只在context含exact GitHub review feedback时开放；普通implement与verification repair固定拒绝。`ExecutionAttemptRunner`收到replan后调用固定`ControlPlanePlanRevisionReporter`，reporter只提交当前Attempt fencing，并在bot commit、push、head Evidence和verification之前返回`replanning`；旧write credential由revision batch进入撤销流程。
  - 同步DOD与Architecture/Proto/Security/Reference；只勾本地GitHub review producer/Runner子项，父项和飞书/Meegle/base/真实Actions外部子项保持未勾；按用户要求不更新llmdoc。
- 验证：
  - 红灯`pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/github-review-feedback.test.ts` → exit 1，1 file / 5 tests中2 failed；新路由不存在均返回404，旧review测试3 passed。
  - 红灯`pnpm exec vitest run test/codex-execution-adapter.test.ts test/execution-attempt-runner.test.ts` → exit 1，2 files / 3 failed；adapter仍返回void且Runner错误进入commit，证明没有结构化decision/replan短路。
  - `pnpm exec vitest run test/codex-execution-adapter.test.ts test/execution-attempt-runner.test.ts test/execution-plan-revision-reporter.test.ts test/execution-runner-bootstrap.test.ts` → exit 0，4 files / 11 tests；覆盖strict output、review-only capability、commit/push/verification短路和reporter exact payload/response。
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/github-review-feedback.test.ts test/workflow/plan-revision.test.ts` → exit 0，2 files / 9 tests；覆盖20路收敛、server-derived fact、旧token撤销、strict payload、stale fencing/head/Run、无review lineage拒绝与Round44核心回归。
  - 最终`pnpm run verify` → exit 0；typecheck、ESLint、Node 23 files / 83 tests、workerd 30 files / 135 tests、111个生产文件Secret scan、Markdown links全绿；`git diff --check` → exit 0。
  - `pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round45-20260725-2352` → exit 0；Workflow/Queue/D1/双R2 bindings、新route/store/migration成功bundle，未部署。此前包含临时目录删除的命令被安全策略在进程创建前拒绝，未执行且未删除文件，随后使用全新outdir完成验证。
- 勾选：Phase 4 Plan revision DoD下新增并勾选“本地GitHub review source producer与Runner编排”子项；父项及“其余真实source与外部编排”保持未勾。本地HMAC/fake HTTP/workerd不能冒充真人review、GitHub Action、新Plan审批、飞书/Meegle revision或base observation。
- 决策沉淀：`request_replan`是能力，不是模型自由文本。模型只能给二选一decision，控制面仍从签名外部事实派生全部source字段；review事件必须冻结未来合法消费的Run version，否则“服务端派生”仍可能在竞争中错误采信新状态。source fact和begin必须同batch，才能保证stale请求既不启动revision也不留下孤儿事实。
- 遗留：同一父DoD仍需飞书/Meegle supplemental context的新Task revision producer、GitHub base observation producer，以及真实试点Action中review decision→analysis Action→strict next Plan→新审批的外部Evidence；之后才可勾父项并进入base branch冲突/rebase DoD。

## Round 46 — 2026-07-25
- 目标：Phase 4 / Plan revision其余真实source与外部编排中的GitHub base observation producer——本轮闭环本地scheduled GitHub refs+compare外部事实到immutable source fact/re-analysis；飞书/Meegle和真实GitHub外部证据保持未完成。
- 前置与权限：仅本地Node/workerd/D1、fake GitHub REST与测试installation token；只读访问GitHub官方refs/compare文档，未调用真实GitHub组织API、Cloudflare远端、Codex计费模型、飞书、Meegle或tool-bridge，未部署、未使用真实Secret。按用户要求核对Watt固定commit`476e3cd`，全库检索Git refs、compare commits、branch head、fast-forward、Contents-read token和base reconciliation，没有GitHub repository adapter或base-update producer可复制，本轮Watt直接复制量为零；最大化复用Watt-derived stable identity/D1 conditional write/scheduled持久状态模式及本项目现有App JWT/allowlist、API reconciliation、PlanRevision batch。
- 动作：
  - 先新增Node API/token与workerd producer契约。首次Node运行exit 1：base API模块不存在、专用token方法不存在，既有4条token测试仍通过；首次workerd运行因reconciler模块不存在而0 tests/failed suite，证明此前没有base observation路径。
  - 实读GitHub官方Get a reference与Compare two commits契约，确认两者对GitHub App都只需Contents read，compare提供ahead/behind/diverged与merge base。新增独立缓存的`getBaseObservationToken`，installation request严格只有单仓库和`permissions:{contents:'read'}`，不复用Actions write、PR write或repo-write token。
  - 新增`GitHubBaseApiClient`：先GET exact`git/ref/heads/<Task baseBranch>`并绑定commit SHA；未变化不做第二次查询。变化后GET`compare/<old>...<new>`，只有`status=ahead + ahead_by>0 + behind_by=0 + base_commit=merge_base=old`生成strict fact；behind/diverged/identical不触发replan，ref/compare malformed、超限、非200与transport错误固定失败且不传播token/response body。
  - migration 0022新增immutable `github_base_observations`，只保存run/expected version/旧Plan、repo/branch、before/after、ahead count和ref/compare/source canonical digests，不保存raw REST或token；同Run version、同before/after均唯一，UPDATE trigger固定拒绝。
  - `PlanRevisionStore.beginFromBaseObservation`从strict parsed fact派生stable observation ID、`d1://github-base-observations/<id>`和source digest；把observation insert、source fact insert与既有begin/fencing statements放入同一D1 batch。20路外部read可重复，但只创建一个revision/analysis Attempt/outbox并把Run base CAS到新head；旧Attempt/token、approval和pending execution/PR intent复用Round44逻辑同时失效。
  - 新增scheduled `GitHubBaseObservationReconciler`与production runtime，Worker每轮只扫描active pre-merge/blocked、Run base=active Plan base的候选。unchanged零D1事实；non-fast-forward暂返回固定disposition留给下一条冲突DoD；Run/Plan在两次GitHub read期间变化时observation/source均零写入。
  - 同步DOD与Architecture/Proto/Security/Reference；新增并勾选本地GitHub base observation子项，父项、飞书/Meegle、真实GitHub refs/compare/Actions/新审批证据保持未勾；按用户要求不更新llmdoc。
- 验证：
  - 红灯`pnpm exec vitest run test/github-base-api.test.ts test/github-app-installation-token.test.ts` → exit 1；2 files failed，base API suite 0 tests/模块缺失，token新增1 failed/既有4 passed。
  - 红灯`pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/github-base-observation.test.ts` → exit 1；1 failed suite / 0 tests，reconciler生产模块不存在。
  - `pnpm exec vitest run test/github-base-api.test.ts test/github-app-installation-token.test.ts` → exit 0，2 files / 8 tests；覆盖exact URLs/headers、ref+compare fast-forward、unchanged单请求、diverged、mismatched response安全错误和contents-read-only token/cache。
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/github-base-observation.test.ts test/workflow/plan-revision.test.ts` → exit 0，2 files / 6 tests；覆盖20路收敛、observation/source/Run base、旧Attempt/token/approval fencing、immutable trigger、scheduled batch、unchanged/non-fast-forward/stale/ineligible拒绝及Round44回归。
  - 最终`pnpm run verify` → exit 0；typecheck、ESLint、Node 24 files / 87 tests、workerd 31 files / 137 tests、114个生产文件Secret scan、Markdown links全绿；`git diff --check` → exit 0。
  - `pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round46-20260725-0010` → exit 0；Workflow/Queue/D1/双R2 bindings、新scheduled runtime/reconciler/store/migration成功bundle，未部署。
- 勾选：Phase 4 Plan revision DoD下新增并勾选“本地GitHub base observation producer”子项；父项及“其余真实source与外部编排”继续未勾。官方文档核对和fake REST证明本地契约，不冒充真实installation token、GitHub branch/compare事实、analysis Action、新Plan或新审批。
- 决策沉淀：base head SHA本身不能证明安全更新；必须把exact ref与commit relationship作为两条独立外部事实，只有旧base是merge base的纯ahead才可自动换base。外部read允许at-least-once，业务变更仍依靠observation/source/begin同一D1 batch与stable identity收敛。权限上base observation是独立`contents:read`能力，不能因为现有Actions token“也能读”就扩大复用范围。
- 遗留：下一轮继续该父DoD的飞书/Meegle supplemental context新Task revision producer；真实试点仍需App installation、真实refs/compare结果、analysis Actions run、strict next Plan及新审批外部证据。non-fast-forward已安全零source，但尚未实现下一DoD要求的可重放rebase或blocked人工路径。

## Round 47 — 2026-07-26
- 目标：Phase 2补充上下文revision与Phase 4 Plan revision source——本轮闭环本地Worker/D1/R2的supplemental Task revision producer、默认/显式apply-current语义，以及review/base/supplemental三类re-analysis source真实回读；真实飞书/Meegle身份事件与GitHub Actions/Workflow外部证据保持未完成。
- 前置与权限：仅本地Node/workerd/D1/R2和本地Watt只读源码；未访问真实GitHub、Cloudflare远端、Codex计费模型、飞书、Meegle、数据库、日志或tool-bridge，未部署、未使用真实Secret。按用户要求固定核对Watt commit`476e3cd`：全库没有supplemental/add-context/apply-current/immutable Task→Plan revision或absorbed Run等价实现，`applyPatch`因原地覆盖语义明确不复制；直接复制其`ObjectContextProvider`的R2 `head + onlyIf:{etagDoesNotMatch:'*'}`并发创建模式，并适配为内容寻址immutable JSON对象，其他能力继续复用Watt-derived stable identity、D1 conditional write和outbox纪律。
- 动作：
  - 先新增`supplemental-context-revision` workerd契约；首次运行exit 1、0 tests，失败原因为生产模块不存在，证明此前只有规范条目和手工seed的supplemental source，没有可调用producer。
  - migration 0023新增immutable `supplemental_context_revisions`，只保存event digest、prior/new Task与new Run、R2 context ref/digest、apply-current及旧Run/Plan/base绑定；正文无D1列，prior Task单一next child、new Task/Run/context唯一，UPDATE trigger拒绝改写。
  - 新增strict内部`POST /v1/runs/:runId/context`与`SupplementalContextRevisionStore`。完整新Task和context先统一Secret scan，再分别写内容寻址私有R2并用Watt conditional create-if-absent收窄并发竞态；Task source tuple/target/environment/intent kind/policy必须与prior一致，Task schema及所有嵌套对象改为strict，caller夹带Plan/ref/base/effect或借revision扩大production/repo权限均拒绝。
  - 默认`applyToCurrentRun=false`只创建一份新Task revision、queued Run和pending workflow-create intent；旧Run state/version、active Attempt、lease/token、approval与outbox逐项零变化。相同revision/context的20路及顺序重放返回同一IDs；同revision改写、从旧prior分叉第二child、Secret和policy变化均无第二条业务lineage。
  - 显式apply必须绑定路径旧Run、旧Task revision、expected Run version、active Plan version/digest和base。新Task仍留作immutable revision，但其新Run在创建时即`cancelled/version=1`且workflow-create intent固定settled为`supplemental_context_absorbed`；context lineage、source fact、absorbed状态与`PlanRevisionStore.begin`同一D1 batch，旧Run只生成一个re-analysis Attempt/outbox，同时复用既有fencing撤销旧Attempt/token/approval/effect intent，避免新旧两条Run重复执行。
  - `AnalysisAttemptContextStore`新增strict optional `revisionSource`。review feedback从私有R2回读正文并复算body/source digest；base update从immutable observation重建规范化fact；supplemental分别回读context对象与完整新Task revision，复核D1 ref、R2 metadata/schema、canonical context/task digest及lineage。普通首次analysis可无source；已绑定revision的source缺失、双source或R2篡改fail-closed。Node Runner schema接受并把该untrusted source写入repo外0600 context文件，不由source字段提升effect。
  - 同步DOD与Architecture/Proto/Security/Reference；只勾本地supplemental producer、默认/显式revision语义和统一source回读子项，Phase 2/4父项及真实飞书/Meegle/GitHub外部子项保持未勾。按用户要求不更新llmdoc。
- 验证：
  - 红灯`pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/supplemental-context-revision.test.ts` → exit 1，1 failed suite / 0 tests；缺`src/storage/supplemental-context-revision-store`。
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/supplemental-context-revision.test.ts test/workflow/github-review-feedback.test.ts test/workflow/github-base-observation.test.ts test/workflow/plan-revision.test.ts test/workflow/task-intake-store.test.ts test/workflow/analysis-attempt-api.test.ts`与`pnpm exec vitest run test/analysis-runner-bootstrap.test.ts` → exit 0；workerd 6 files / 24 tests、Node 1 file / 3 tests，覆盖20路/顺序重放、默认零打断、显式吸收/fencing、strict API、三类source回读及R2篡改拒绝。
  - 最终`pnpm run verify` → exit 0；typecheck、ESLint、Node 24 files / 87 tests、workerd 32 files / 141 tests、118个生产文件Secret scan、Markdown links全绿。
  - `pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round47-20260726-0052` → exit 0；Workflow/Queue/D1/双R2 bindings、新route/store/migration/source schema成功bundle，未部署；`git diff --check` → exit 0。
- 勾选：Phase 2补充上下文DoD下新增并勾选本地Worker/D1/R2子项；Phase 4 Plan revision下新增并勾选本地supplemental producer与统一re-analysis context子项。内部Bearer API、本地R2/workerd和fake source不能冒充飞书验签/open_id授权、真实Meegle revision、GitHub Action、Cloudflare Workflow或新审批外部证据，因此两个父项继续未勾。
- 决策沉淀：Task ID继续表示具体source revision；默认add-context因此必须产生独立Run。显式apply-current若也保留queued新Run会形成双执行链，所以新Run只作可审计absorbed终态，实际执行仍由旧Run的immutable Plan revision接管。R2与D1无法共享事务，安全顺序是Secret scan→内容寻址conditional R2 write→D1原子lineage/source/begin；失败时保留无引用对象供reconciliation，不能删除可能已被并发相同请求引用的对象。Plan revision Agent必须看到digest-verified source和新Task snapshot，否则“已调度re-analysis”不等于真正消费了触发事实。
- 遗留：真实飞书/Meegle adapter仍需challenge/验签、open_id+tenant+revision/nonce鉴权和卡片选择，将外部event映射到内部context入口并保存真实event/card证据；真实试点GitHub/Cloudflare还需运行review/base/context→analysis Action→strict next Plan→新审批链路。下一轮可选择同Phase的飞书事件入口，或进入base non-fast-forward的可重放rebase/blocked DoD，不能提前勾父项。

## Round 48 — 2026-07-26
- 目标：Phase 4 / base branch前进的安全重放与冲突处理——本轮闭环本地真实Git rebase+强制重验，以及GitHub non-fast-forward fact到D1 durable blocker的核心契约；固定GitHub workflow自动调用与真实Actions/PR外部证据保持未完成。
- 前置与权限：仅本地真实临时Git、Node子进程、workerd/D1和fake GitHub compare fact；未访问真实GitHub组织、Cloudflare远端、Codex计费模型、飞书、Meegle、日志、数据库或tool-bridge，未部署、未使用真实Secret。按用户要求固定核对Watt commit`476e3cd`并检索rebase/merge conflict/non-fast-forward/branch ancestry；没有Git rebase Runner、base conflict blocker或approval invalidation union可直接复制，llmdoc中的worktree建议不是生产代码，本轮Watt直接复制量为零；最大化复用本项目fixed Git executor、Attempt派生branch、bot identity、verification Runner与Watt-derived stable identity/D1 conditional batch/outbox模式。
- 动作：
  - 先写真实临时Git rebase契约。首次`pnpm exec vitest run test/base-rebase-runner.test.ts`因`src/runner/base-rebase-runner`不存在而exit 1/failed suite，证明此前没有安全重放实现。随后单独执行workerd红灯，non-fast-forward 20路结果仍返回旧`non_fast_forward`而非`blocked`，新增case exit 1。
  - 新增`BaseRebaseRunner`：输入必须绑定absolute repo、Task/source/target Attempt派生branch、old/new/source SHA、parsed policy和targeted refs；clean tree、source ref/head exact、old base同时为new base与source head祖先、source非空线性且author/committer为固定bot全部成立才允许继续。rebase固定禁hooks/GPG/autostash，不含push/force；target是新Attempt branch，source ref始终不改。
  - rebase成功后重新核对new-base ancestry、commit数、线性bot identity和source patch equivalence，并强制执行targeted→全部required verify；已完成target branch重放仍重新产Evidence。内容冲突只有`rebase --abort`成功、工作树clean且source/target回到原source head后才返回fixed `content_conflict`，零Evidence；相同冲突顺序重放保持稳定。
  - GitHub base API的non-fast-forward结果升级为strict fact，增加repo/branch、ahead/behind、merge-base、ref/compare canonical digests。migration 0024新增immutable `github_base_conflicts`与base-conflict approval invalidation ledger；`GitHubBaseConflictStore`以Run/version和old Plan绑定的stable identity，在一个D1 batch保持旧base不变并把Run/Plan blocked、取消active Attempt/generation+1、撤销token/写credential、supersede高风险gate、settle旧analysis/execution/PR intent并创建唯一Workflow cancel。20路并发与后续重放均返回blocked，不写Plan source fact。
  - 新增`invalidated_approvals` union view并把credential、PR、review、replay等所有approval消费者切到统一视图，防止base conflict后的旧repo_write approval因尚未过期而复活。Task/Run查询优先投影白名单化base blocker，只含repo/branch/before/after/relationship/count/merge-base和固定`manual_rebase`提示，不含REST body、token、Git stderr或冲突文件内容。
  - 同步DOD与Architecture/Proto/Security/Reference；只勾本地Git/D1/workerd核心子项，父项及固定workflow/真实Action子项保持未勾；按用户要求不更新llmdoc。
- 验证：
  - 红灯`pnpm exec vitest run test/base-rebase-runner.test.ts` → exit 1，模块不存在；红灯`pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/github-base-observation.test.ts` → exit 1，新增non-fast-forward blocker case失败。
  - `pnpm exec vitest run test/base-rebase-runner.test.ts test/github-base-api.test.ts` → exit 0，2 files / 5 tests；覆盖真实无冲突rebase、source不变、新base ancestry、无push/force、成功重放重验、冲突abort/零Evidence及冲突重放。
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/github-base-observation.test.ts` → exit 0，1 file / 3 tests；覆盖20路immutable conflict、Run/Plan/Attempt/token/approval/outbox/workflow cancel、零source fact、查询投影与trigger。
  - 最终`pnpm run verify` → exit 0；typecheck、ESLint、Node 25 files / 89 tests、workerd 32 files / 142 tests、121个生产文件Secret scan、Markdown links全绿。
  - `pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round48-20260726-0110` → exit 0；Workflow/Queue/D1/双R2 bindings与新增migration/store/reconciler/query成功bundle，未部署；`git diff --check` → exit 0。
- 勾选：Phase 4 base conflict DoD新增并勾选“本地Git/D1/workerd核心契约”子项；父项与真实workflow子项保持未勾。本地直接调用生产Runner、fake compare和workerd只能证明安全原语与控制面收敛，不能冒充真实GitHub-hosted Runner自动找到未发布branch、更新PR或产生Actions Evidence。
- 决策沉淀：必须区分两类冲突：GitHub compare证明base history不是纯fast-forward时，控制面立即blocked且不能创建replan source；base history安全但bot source patch与新base内容冲突时，Git Runner必须abort并请求人工。自动rebase永远产生新的Attempt branch且不push/force，成功也不能继承旧测试结果；approval统一失效视图是权限边界，不只是审计便利。
- 遗留：下一轮若继续该父项，应把fixed GitHub workflow/控制面与`BaseRebaseRunner`接通：从D1 verified publication/attempt head选择真实未发布source，创建并授权replacement Attempt，在Action中运行rebase和新suite并上报head/Evidence；已发布PR branch或内容冲突不得force-push，需人工选择新branch/PR或放弃。没有这些外部事实前不勾父项。

## Round 49 — 2026-07-26
- 目标：Phase 4 / base branch安全重放的本地固定workflow与控制面生产接线；把Round 48的可信Git原语接到可恢复的scheduled Attempt、GitHub dispatch、OIDC execution bootstrap和terminal callback，真实GitHub-hosted Actions外部事实继续保持未完成。
- 前置与权限：仅本地Node/workerd/D1/R2、fake GitHub/control-plane HTTP、真实临时Git仓库与bare remote；未访问真实GitHub组织、Cloudflare远端、Codex计费模型、飞书、Meegle、日志、数据库或tool-bridge，未部署、未使用真实Secret。按用户要求核对Watt固定commit`476e3cd`并检索base-only Plan revision、verified branch replay、rebase Attempt lineage、GitHub workflow dispatch与content-conflict callback，没有可直接复制的生产实现，本轮Watt直接复制量为零；最大化复用delivery-loop已有Watt-derived scheduled reconciliation、stable identity、D1 conditional batch/outbox/三态dispatch，以及现成review-fix OIDC/bootstrap、repo-write broker、fixed no-force writer、head CAS、verification/failure reporter和Attempt revocation ledger。
- 动作：
  - 先写`base-rebase-attempt` workerd契约；首次`pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/base-rebase-attempt.test.ts`因`src/reconciliation/base-rebase-attempt-reconciler`不存在而exit 1，证明此前只有独立Git runner，没有自动选择source、创建replacement Attempt或dispatch的生产路径。
  - migration 0025新增immutable `base_rebase_attempts`与`base_rebase_approval_invalidations`，并把统一`invalidated_approvals`视图扩为Plan revision、base history conflict、base rebase content conflict三个ledger。lineage只允许`scheduled→passed/blocked`，冻结old/new Plan/Item、source/rebase Attempt、old/new/source/result SHA、source/target branch、suite和blocker。
  - 新增scheduled `BaseRebaseAttemptReconciler`与D1 store。候选必须是已activated的`base_update` revision且semantic body/effects未变；旧同ID required verification Item由passed `plan_item_verifications`和completed source Attempt/head关门，source branch必须是其Attempt派生branch；新Item ready、依赖passed、声明repo-write/test/targeted/required refs，且新Plan/base已有latest fresh approval。任何`pull_request_publications`使用过source branch时零Attempt/outbox/effect。stable identity和条件batch让20路调度只创建一份lineage、pending `review_fix` Attempt、Item占用与`execution_dispatch`。
  - execution dispatch/context/head路径新增第三种`baseRebase` source，并在dispatcher、context store与Runner bootstrap三层都要求verification repair、review feedback、base rebase恰好一个。fixed workflow继续从new base ref加载受信代码/policy，但checkout exact旧verified source head；本地物化source ref后只运行trusted setup与`BaseRebaseRunner`，不调用Codex Agent。
  - `BaseRebaseRunner`保持no-push职责；成功callback复用现有writer把新Attempt派生branch non-force push，核对返回head/branch后先写source→rebased head CAS，再执行targeted→全部required verify。`complete`只在同Attempt/generation/Plan/Item的head transition与completed all-passed suite都存在时写passed lineage；Plan Item仍由逐doneWhen Evidence verifier最终关门。
  - 内容冲突必须先abort并核对source/target/clean tree，随后strict endpoint以Attempt/Run/Plan/Item/version/generation/lease共同fence，在一个D1 batch把lineage/Run/Plan/Item置blocked、取消Attempt并提升generation、写reference-only revocation audit、撤销token/write credential、新Plan approval和旧effect intent，并创建唯一Workflow cancel。审查发现终态已提交但HTTP响应丢失时，普通鉴权会因token已撤销而破坏幂等重放；据此新增只读恢复校验，仅同一已撤销token、原expected version/generation且仍在原expiry内可取回`created:false`的同一blocked投影，错误token仍401且不能恢复任何写权限。
  - 查询新增reference-only base rebase lineage/blocker投影；同步DOD、Architecture、Proto、Security、Reference。只勾本地固定workflow/生产接线子项，父项与真实GitHub外部事实保持未勾；按用户要求未更新llmdoc。
- 验证：
  - 红灯`pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/base-rebase-attempt.test.ts` → exit 1，production reconciler模块不存在。
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/base-rebase-attempt.test.ts` → exit 0，1 file / 4 tests；覆盖20路收敛、fixed workflow dispatch、strict context、已发布branch拒绝、content conflict原子block/撤权/revocation audit、原token终态重放、错误token拒绝及head+suite completion。
  - `pnpm exec vitest run test/execution-runner-bootstrap.test.ts test/base-rebase-runner.test.ts` → exit 0，2 files / 6 tests；覆盖真实临时Git无冲突rebase、不调用Agent、新branch non-force push、head CAS后targeted→required、complete report，以及真实内容冲突abort、无push/head/Evidence和conflict report。
  - 首次全量回归捕获新query断言的嵌套asymmetric matcher不稳定，workerd 33 files中1 failed/145 passed；改为按持久化CAS赢家Attempt ID定位后再断言projection，并补齐null类型收窄，聚焦测试恢复4/4。
  - 最终`pnpm run typecheck`、`pnpm run lint`、`pnpm run verify`、`git diff --check`均exit 0；Node 25 files / 91 tests、workerd 33 files / 146 tests、124个生产文件Secret scan和Markdown links全绿。
  - `pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round49-20260726-final` → exit 0；Workflow/Queue/D1/双R2 bindings与新增migration/store/reconciler/routes成功bundle，未部署。
- 勾选：Phase 4 base conflict DoD下“本地固定workflow/生产接线”子项已勾；父项与“真实试点GitHub外部事实”保持未勾。本地bare Git、fake HTTP/workerd和dry-run不能冒充真实App installation、GitHub-hosted Action、远端branch push或Actions Evidence。
- 决策沉淀：自动rebase不是旧Attempt续跑，而是base-only revision重新批准后的新Attempt；new base负责代码/policy/approval身份，old verified head只负责提供受信patch来源。Git effect必须按non-force push→head CAS→新suite排序，旧Evidence不可继承。终态回放也不能靠重新开放已撤销token：只能为exact已提交事实提供最小只读projection。
- 遗留：真实试点仍需用户确认owner/repo/visibility，安装GitHub App并配置目标workflow/Cloudflare bindings；之后由真实未发布bot branch触发Action，记录旧/新base、source/derived SHA、App push与新suite Evidence，并分别演练内容冲突和已发布PR branch零force-push。没有这些外部事实前父项不得勾选。

## Round 50 — 2026-07-26
- 目标：Phase 5 / required checks未完成或失败、review不足、base非最新、approval过期时拒绝merge——本轮闭环本地只读GitHub merge eligibility producer、D1 gate decision与`ready_to_merge` CAS；真实GitHub负向场景和实际merge effect保持未完成。
- 前置与权限：仅本地Node/workerd/D1、fake GitHub REST与测试installation token；未访问真实GitHub组织、Cloudflare远端、Codex计费模型、飞书、Meegle、日志、数据库或tool-bridge，未部署、未使用真实Secret。按用户要求核对Watt固定commit`476e3cd`并全库检索required checks、branch protection/rules、review decision、ready-to-merge与GitHub merge gate，没有可直接复制的生产实现，本轮Watt直接复制量为零；最大化复用delivery-loop已有Watt-derived scheduled reconciliation、stable identity、D1 conditional batch/reference-only projection，以及现有GitHub App单仓库token/provider、PR publication、base observation、approval/invalidation和TaskQuery原语。
- 动作：
  - 先写Node API/token与workerd gate契约。首次`pnpm exec vitest run test/github-merge-gate-api.test.ts test/github-app-installation-token.test.ts`因production reconciler模块不存在而exit 1，新增suite 0 tests、既有token 5 passed；首次workerd运行同样因模块不存在exit 1/0 tests，证明此前只有Run状态名和规范，没有可执行merge eligibility路径。
  - migration 0026新增immutable `github_merge_gate_observations`、normalized `github_merge_gate_required_checks`、`merge_gate_evaluations`和`merge_gate_decisions`。observation只保存repo/PR/head/base、mergeability/review/check counts、逐required check状态及policy/check/review canonical digest，不保存REST body、review正文或token；evaluation冻结Run/Plan/publication/approval与passed或固定rejection reason；decision只证明资格，不产生merge outbox。
  - 新增用途隔离、缓存的merge observation installation token，请求严格只有`checks/contents/pull_requests/statuses:read`。`GitHubMergeGateApiClient`依次读取exact PR、base ref、active branch rules、head latest check-runs、combined statuses与reviews；response/status/schema/大小、repo/branch/SHA、分页完整性全部fail-closed，错误不传播token或response body。
  - branch rules规范化为`context + integrationId`集合及最大required approval count；没有required checks或required review policy固定`policy_unavailable`。check-run只有completed且success/neutral/skipped算passed，legacy status只有success算passed；missing、queued/in-progress、failure/error保持独立状态。review只计算当前head commit上每个actor的最新状态，旧head approval不计，changes requested优先；GitHub merge state继续兜底CODEOWNER/last-push/thread等复合规则。
  - `MergeGateStore`重新绑定current Run version、active Plan/version/digest/base、verified publication与PR Evidence、同branch最新completed bot head、全部required Item passed和Plan merge effect。latest exact merge approval按createdAt/ID选择；reject、统一invalidation ledger命中或`expiresAt <= now`均`approval_required`，不得回退更旧approve。
  - 通过路径在最终D1 INSERT/CAS再次核对全部GitHub observation gate、最新bot head、Item、Plan effect与approval，不只依赖进程内预检；20路外部read只形成一个passed evaluation/decision并把Run `pull_request_open|awaiting_review → ready_to_merge/version+1`。资格判断刻意零merge outbox/零GitHub写，避免在自动合并策略尚未拍板时越权。
  - 负向路径持久化immutable rejected evaluation与固定reason，Run/version不变、零decision/effect。覆盖required check missing/pending/failed、review required/changes requested、base/head漂移、Draft、conflict/unknown mergeability、required policy缺失、merge effect未声明、approval过期/latest reject/invalidated。Task/Run查询只返回SHA、PR number、counts/digests、merge/review状态和固定reason。
  - production Worker scheduled周期接入merge gate reconciler；与base reconciler并发时最终Run version/Plan/base CAS决定唯一赢家。同步DOD、Architecture、Proto、Security、Reference；只勾本地子项，父项与真实GitHub外部事实保持未勾，按用户要求未更新llmdoc。
- 验证：
  - 红灯`pnpm exec vitest run test/github-merge-gate-api.test.ts test/github-app-installation-token.test.ts` → exit 1；merge suite缺production模块/0 tests，既有token 5 passed。
  - 红灯`pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/github-merge-gate.test.ts` → exit 1；production module不存在/0 tests。
  - `pnpm exec vitest run test/github-merge-gate-api.test.ts test/github-app-installation-token.test.ts` → exit 0，2 files / 9 tests；覆盖六类exact只读REST绑定、passing/pending/base-moved facts、malformed/Secret-safe错误与独立最小token/cache。
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/github-merge-gate.test.ts` → exit 0，1 file / 15 tests；覆盖20路决策收敛、ready-to-merge CAS、安全query、四类DoD拒绝及Draft/conflict/unknown/policy/head/effect、latest reject/invalidation不回退和零merge outbox。
  - 相邻回归`pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/github-merge-gate.test.ts test/workflow/github-pull-request.test.ts test/workflow/github-review-feedback.test.ts test/workflow/github-base-observation.test.ts` → exit 0；4 files / 18 tests（在扩充负向case前执行），PR publication/review/base observation未回退。
  - 最终`pnpm run typecheck`、`pnpm run lint`、`pnpm run verify`、`git diff --check`均exit 0；Node 26 files / 95 tests、workerd 34 files / 161 tests、129个生产文件Secret scan和Markdown links全绿。
  - `pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round50-20260726-final` → exit 0；Workflow/Queue/D1/双R2 bindings与新增migration/domain/store/reconciler/runtime成功bundle，未部署。
- 勾选：Phase 5首条DoD下新增并勾选“本地控制面/workerd契约”子项；父项与“真实试点GitHub外部事实”保持未勾。本地fake REST、workerd和dry-run不能冒充真实branch rules、required checks、review/base事实或GitHub没有收到merge请求的外部证据。
- 决策沉淀：`ready_to_merge`只表示外部事实与内部审批在一个版本快照上满足，不表示merge API已调用，更不表示PR已合并。eligibility、merge producer、merge webhook/projector必须是三个独立幂等证据面。GitHub aggregate merge state只能兜底复杂规则，不能替代逐required context与head-bound review解析；approval消费者必须选择latest exact decision并排除统一invalidation ledger，不能因新拒绝失效而复活旧批准。
- 遗留：真实试点需要GitHub App安装和试点repo后，以真实branch rules/required checks/review/base ref形成decision，并分别制造pending/failed check、review不足、base前进与approval过期，记录API/Actions/控制面证据证明零merge请求。下一轮可继续Phase 5第二条本地身份隔离DoD：PR作者/Agent不得批准自己的merge/production effect；实际merge producer仍需自动合并策略拍板后单独实现。

## Round 51 — 2026-07-26
- 目标：Phase 5 / Agent与PR作者不能批准自己的merge/production effect，审批主体由GitHub/飞书身份映射核对——本轮闭环Watt身份实现的直接迁移、独立approval adapter入口、merge gate及受控replay的live身份重验；真实GitHub/飞书验签和外部effect证据保持未完成。
- 前置与权限：仅本地workerd/D1、fake GitHub observation与测试adapter credential；未访问真实GitHub组织、Cloudflare远端、Codex计费模型、飞书、Meegle、日志、数据库或tool-bridge，未部署、未使用真实Secret。按用户要求固定读取Watt commit`476e3cd`，直接迁移`packages/gateway/migrations/0001_auth_core.sql`的`identity_mappings`、`packages/gateway/migrations/0002_channel_identities.sql`及索引，以及`packages/gateway/src/authz/identity-mapper.ts`的anonymous/resolve/resolvePrincipal/bindChannelIdentity/bind结构；保留“channel subject→principal、roles实时解析、未映射anonymous”语义，并在本项目增加输入/roles shape验证。
- 动作：
  - 先写身份隔离workerd契约；首次运行因`src/storage/identity-bound-approval-store`不存在而exit 1/0 tests，证明此前merge approval只有caller提供的`actor_id`字符串，没有可执行的GitHub/飞书identity binding。随后把Round 50 legacy fixture切到可信视图时passing case变红，证明裸高风险approval已不能推进merge。
  - migration 0027直接复制Watt双表后新增immutable `approval_source_events`、`identity_bound_approvals`和`approval_identity_rejections`，merge observation补PR作者login。source只保存provider/tenant/event/subject、外部event digest和控制面完整request digest；同event不能换Run/version/effect/decision/expiry重用。accepted/rejected一对一且UPDATE trigger拒绝改写。
  - `IdentityMapper`以`github:<repository> + login`和`feishu:<tenant> + open_id`隔离渠道并把两者映射到统一principal；未映射为`user:anonymous`。决策时实时读取roles并要求`human + approve:merge|approve:production_deploy`，`agent:*`、`service:*`、缺role、PR作者未映射、跨provider同principal自批和task actor自批均固定拒绝且零approval。
  - 新增独立`APPROVAL_ADAPTER_TOKEN`和strict `POST /v1/runs/:runId/approvals`。任务入口token与Agent token不能调用；body不含actor、author、task revision、Plan ID/digest、base或roles，控制面从exact Run/active Plan/verified publication/latest PR observation派生。相同source event 20路只创建一个source/binding，完全相同HTTP重放200，换decision返回409；响应/日志不含token或原payload。
  - `trusted_effect_approvals`对低风险approval保持兼容，但merge/production必须JOIN identity binding、approver/author当前channel mapping和approver live roles，并要求principal分离。`MergeGateStore`预检和最终SQL只允许可信高风险approval；role撤销后固定`approval_identity_unresolved`，不会继承旧role快照。
  - `WorkflowReplayStore`的调度approval snapshot与restart副作用前重验都切到可信视图。聚焦测试先因legacy merge/production approval得到403而2 cases红灯，再把fixture升级为完整source/channel/principal/binding证据；新增永久断言证明裸高风险approval继续403，可信绑定才可调度，expiry仍在effect前终态阻断。
  - 同步DOD、Architecture、Proto、Security与Reference；明确逐文件Watt直接复制边界。只勾本地子项，父项与真实GitHub/飞书身份事实保持未勾；按用户要求未更新llmdoc。
- 验证：
  - 红灯`pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/github-merge-gate.test.ts` → exit 1/0 tests（production identity store缺失，承接本轮开始前证据）；切换可信视图后旧passing fixture为0个`ready_to_merge`，确认legacy approval失效。
  - 红灯`pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/controlled-replay.test.ts` → exit 1，1 file / 2 failed；裸merge/production approval使原202/409路径都变成403。
  - 聚焦`pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/github-merge-gate.test.ts test/workflow/identity-mapper.test.ts test/workflow/controlled-replay.test.ts` → exit 0；3 files / 28 tests，覆盖独立adapter auth/strict body、完整request重放冲突、20路收敛、GitHub/飞书渠道隔离、live role撤销、Agent/缺role/未映射、merge与production跨provider自批、legacy replay拒绝及effect前expiry重验。
  - `pnpm exec vitest run test/github-merge-gate-api.test.ts` → exit 0，1 file / 3 tests；PR作者login来自GitHub PR响应而非caller request。
  - 最终`pnpm run verify` → exit 0；typecheck、ESLint、Node 26 files / 95 tests、workerd 35 files / 171 tests、133个生产文件Secret scan和Markdown links全绿。
  - `pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round51-20260726-final`与`git diff --check` → exit 0；Workflow/Queue/D1/双R2 bindings及新增migration/identity/store/API成功bundle，未部署。
- 勾选：Phase 5第二条DoD下新增并勾选“本地Watt复用/控制面/workerd契约”子项；父项与“真实GitHub/飞书身份事实”保持未勾。本地fake PR author、手工D1 mapping、测试Bearer和workerd不能冒充真实GitHub webhook/App login、飞书验签/open_id、真人审批或外部零merge/deploy事实。
- 决策沉淀：adapter认证、外部subject、内部principal、live role、PR author和effect approval是六个独立证据层；Bearer服务凭证不能替代人的身份，创建时roles digest也不能替代effect时live lookup。高风险authority必须是可信视图而非裸表行；回放尤其要在调度与副作用前都重验，否则历史snapshot会成为角色撤销后的权限恢复漏洞。Watt双表和mapper可直接复用，delivery-loop只在其上增加exact Plan/effect/source与职责分离。
- 遗留：真实子项需要配置GitHub App/webhook与飞书adapter验签，建立受管login/open_id→principal映射，由真人reviewer、PR作者和Agent分别提交merge/production decision，记录GitHub/飞书event/delivery、D1 source/binding/rejection和外部零effect证据。实际merge producer仍须等待自动合并策略拍板；下一轮可继续Phase 5“测试部署使用独立OIDC角色/environment”本地契约。

## Round 52 — 2026-07-26
- 目标：Phase 5 / 测试部署使用独立OIDC角色与Environment，部署结果和URL形成独立Evidence——本轮闭环本地D1/outbox、GitHub Deployments adapter、固定test workflow/Runner、专用OIDC attestation和签名deployment status projector；真实GitHub Environment、云role/Secret隔离与真实URL保持未完成。
- 前置与权限：仅本地Node/workerd/D1、fake GitHub/OIDC/HTTP和临时Git仓库；未访问真实GitHub组织、Cloudflare远端、云账户、Codex计费模型、飞书、Meegle、日志、数据库或tool-bridge，未部署、未使用真实Secret。按用户要求固定核对Watt commit`476e3cd`并检索OIDC、Environment、deploy、deployment、role与GitHub workflow，没有可直接复制的GitHub Environment部署、云OIDC role、Deployments API effect或status projector，本轮Watt直接复制量为零；最大化复用此前迁入的stable identity、D1 conditional batch、fenced outbox和reference-only payload模式，以及本项目现有GitHub App/HMAC/OIDC/Evidence原语。
- 动作：
  - 先新增固定workflow与GitHub Deployments API红灯。首次Node聚焦运行exit 1：`.github/workflows/delivery-test-deploy.yml`与`src/outbox/github-test-deployment.ts`均不存在；workerd命令因前序`&&`失败未执行，未把占位store测试冒充红灯证据。随后初次typecheck还捕获test fetch mock的`exactOptionalPropertyTypes`错误并修正。
  - `delivery.yaml` strict schema的deployment target新增环境专属固定workflow、OIDC audience、`test:*|production:*` role ref和结构化deployment command；deployment command不进入Agent Plan refs。migration 0028新增immutable `test_deployments` snapshot、digest-only OIDC attestation与HMAC delivery ledger，状态严格区分`scheduled/created_unverified/in_progress/succeeded/failed`。
  - scheduled `TestDeploymentReconciler/Store`只接受required delivery Item，要求exact active Run/Plan/progress、依赖passed、Task允许test、test环境、唯一test-deploy写effect、零Plan command ref、deployment Evidence/external fact、至少一条doneWhen、latest completed bot head已有passed Item verification及latest exact approval。20路调用以stable identity+D1 batch只创建一个deploy Attempt、Item占用、deployment snapshot与`github_deployments` outbox。
  - GitHub App新增独立cache/pending和严格`deployments:write` token。Deployments adapter只发送exact SHA、固定`delivery-loop:test`/`test`及reference-only deployment ID，先GET reconciliation再POST；REST 201只写`created_unverified`。outbox processor在GitHub I/O前重新核对Run/Plan/Item/Attempt与latest approval，延迟reject零外部调用；外部effect后再次以条件SQL提交，创建结果不生成Evidence。
  - 固定`.github/workflows/delivery-test-deploy.yml`只响应`environment=test + task=delivery-loop:test`，权限为`contents:read + deployments:write + id-token:write`，使用test Environment、exact deployment SHA、`persist-credentials:false`及immutable Actions。Runner从该SHA读取strict policy，请求专用audience并向控制面attest exact repository/workflow/SHA/run/environment subject，核对返回的`test:*` role ref后执行固定argv；命令子进程环境移除GitHub token、OIDC request token和deployment控制ID。
  - `POST /v1/test-deployments/:id/oidc-attestation`使用GitHub JWKS/RS256和专用audience，只保存JWT digest与白名单claims，通用Agent audience、ref subject、production Environment及错误workflow均拒绝。HMAC `deployment_status` projector再绑定repo、GitHub/delivery-loop deployment ID、SHA、task和test Environment，按external updated_at单调推进并移除URL query/fragment；只有已有attestation的success生成passed deployment Evidence并通过唯一Item verifier关闭deploy Attempt/Item，failure生成verified failed Evidence且Run保持executing。Task query只公开安全deployment ID/status/environment/SHA/role/GitHub ID/URL/Evidence ref，不公开JWT digest或raw payload。
  - outbox relay/router和Worker scheduled/Queue接入独立`github_deployments` destination；新增runtime配置`TEST_DEPLOY_TARGETS_JSON`并要求目标仓库同时在GitHub App allowlist。同步DOD、Architecture、Proto、Security与Reference；只勾本地子项，父项与真实GitHub/云外部事实保持未勾；按用户要求未更新llmdoc。
- 验证：
  - 红灯`pnpm exec vitest run test/test-deployment-workflow.test.ts test/github-test-deployment-api.test.ts` → exit 1；缺固定workflow和production Deployments adapter。workerd红灯当时未因shell短路执行，已如实记录。
  - 聚焦Node `pnpm exec vitest run test/test-deployment-runner.test.ts test/test-deployment-workflow.test.ts test/github-test-deployment-api.test.ts test/github-app-installation-token.test.ts test/delivery-policy.test.ts` → exit 0，5 files / 15 tests；覆盖固定workflow、专用token/API、commit-bound command、OIDC/control token隔离与status上报。
  - 聚焦workerd `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/test-deployment.test.ts test/workflow/outbox-routing.test.ts test/workflow/task-query-api.test.ts` → exit 0，3 files / 15 tests；覆盖20路调度/outbox、latest reject零effect、专用OIDC负向绑定、未attest success零Evidence、20路status重放、failure不成功、HMAC/raw canary、URL清洗、安全query及四destination路由。
  - 最终`pnpm run verify` → exit 0；typecheck、ESLint、Node 29 files / 99 tests、workerd 36 files / 178 tests、145个生产文件Secret scan和Markdown links全绿。
  - `pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round52-20260726-final` → exit 0；Workflow/Queue/D1/双R2 bindings及新增migration/API/runtime/runner成功bundle，未部署。
- 勾选：Phase 5测试部署DoD下新增并勾选“本地控制面/workerd/固定workflow契约”子项；父项与“真实GitHub/云外部事实”保持未勾。本地fake JWT/HMAC/REST、workerd和dry-run不能冒充真实GitHub Environment、云OIDC换证、test-only Secret、Actions run或deployment URL。
- 决策沉淀：创建Deployment、进入job、OIDC环境身份证明与最终平台status是四个独立事实，只有最后一个在前三个binding成立后才能成为Evidence。test deployment必须拥有自己的workflow、Environment、audience、role、App token和outbox destination，不能借通用Agent/PR/repo-write路径“顺便部署”。部署command来自exact commit policy但仍不能看到GitHub/OIDC控制token；真实云role trust与生产Secret不可达性必须由外部系统证明，控制面本地attestation不能代替。
- 遗留：真实试点需用户提供目标owner/repo并安装GitHub App，配置`test` Environment、`TEST_DEPLOY_TARGETS_JSON`、webhook和云端`test:*` OIDC trust/最小权限role，放入一个仅test可见与一个仅production可见的canary Secret做隔离验证；记录GitHub Deployment/Actions/Environment URL、OIDC换证审计、D1 Evidence及webhook丢失后的API补偿。下一轮可继续Phase 5“E2E失败返回executing/blocked”，把部署后验收建成独立verification Item，不能用本轮deployment command或status冒充E2E。

## Round 53 — 2026-07-26
- 目标：Phase 5 / E2E/验收失败返回`executing`或`blocked`，不会因为deployment job启动就标成功——本轮闭环本地独立post-deployment acceptance Item、固定workflow/Runner、D1/outbox、专用OIDC、Runner result与签名/API-reconciled `workflow_run`双事实契约；真实GitHub Actions与测试URL外部事实保持未完成。
- 前置与权限：仅本地Node/workerd/D1、测试HMAC/JWKS、fake GitHub API/OIDC/HTTP和临时Git仓库；未访问真实GitHub组织、Cloudflare远端、云账户、Codex计费模型、飞书、Meegle、日志、数据库或tool-bridge，未部署、未使用真实Secret。按用户要求固定核对Watt commit`476e3cd`并检索E2E、acceptance、smoke、waitFor、deployment后验证、workflow result与可回放事实断言；Watt只有通用E2E CLI/`waitFor`和协议事实断言，没有可直接复制的post-deployment producer、GitHub Environment OIDC Runner、D1 lineage或签名workflow projector，本轮直接复制代码为零；最大化复用此前从Watt迁入的stable identity、D1 conditional batch、fenced outbox和reference-only payload模式，以及本项目现有GitHub App/HMAC/OIDC/Plan Item Evidence verifier。
- 动作：
  - 先新增固定workflow与workerd契约；首次`pnpm exec vitest run test/test-acceptance-workflow.test.ts`因`.github/workflows/delivery-test-acceptance.yml`不存在而exit 1，首次`pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/test-acceptance.test.ts`因`src/storage/test-acceptance-store.js`不存在而exit 1/0 tests，随后实现而非放宽断言。
  - `delivery.yaml` strict policy新增可选`acceptance`命令组，test deployment target必须引用已声明`acceptance:*`；它不进入change后的pre-deploy required verification集合。migration 0029新增immutable `test_acceptances`、digest-only OIDC attestation和webhook/API统一observation ledger；状态区分`scheduled/dispatched/running/passed/failed`，Runner result、GitHub run与lineage snapshot均有不可改写约束。
  - `TestAcceptanceReconciler/Store`只调度required verification Item：依赖全部passed，且至少一条直接依赖是succeeded test deployment并具有verified passed deployment Evidence和无query/fragment的HTTPS URL；Item只能有唯一`repo_read`、唯一`acceptance:*`、仅`test` Evidence、零external fact和至少一条doneWhen。20路调用以stable identity+D1 batch只创建一个deploy-mode Acceptance Attempt、Item占用、snapshot与第五类`github_acceptance` outbox。
  - GitHub App增加独立acceptance cache/pending，权限严格为`actions:write + contents:read`；dispatcher固定`.github/workflows/delivery-test-acceptance.yml`与`delivery-loop/acceptance/<id>`，reference-only inputs及POST 204→GET reconciliation。outbox effect前重新核对active Run/Plan/Item/Attempt和已verified deployment；dispatch后只推进`dispatched/starting`和lease，不能生成Evidence。
  - 固定acceptance workflow在test Environment以exact deployed SHA运行，权限只有`contents:read + id-token:write`且无deployment/write权限。Runner请求专用audience=`delivery-loop-test-acceptance`，控制面绑定test Environment subject、repo/workflow/SHA/run并只存JWT digest；从exact SHA policy核对`acceptanceCommandRef`后执行固定argv，仅注入清洗后的`DELIVERY_TEST_BASE_URL`并移除GitHub/OIDC/acceptance/control-plane控制值。失败命令也先上报exit/duration，再让Action以非零退出形成外部事实。
  - Runner result只保存immutable digest/status/exit/duration，不生成Evidence。HMAC `workflow_run`与scheduled GitHub API补偿共用projector，重新绑定repo/run/workflow/title/branch/SHA/run-attempt并按`updated_at`单调推进；requested/in-progress零Evidence。completed success缺Runner result保持received可重试，只有Runner passed/exit 0一致时创建唯一`test + acceptance:*` Evidence并由Plan Item verifier关门；workflow failure、Runner failure或结论冲突均生成verified failed Evidence、失败Attempt/Item且Run保持`executing`。
  - 通用GitHub run reconciler显式排除acceptance Attempt，Worker接入acceptance HTTP、scheduled scheduler/API reconciliation、第五destination relay与Queue router。Task/Run查询只公开acceptance/deployment/Attempt/ref/command/GitHub run/Evidence/timestamp白名单投影，不公开OIDC/result digest或raw payload。同步DOD与Architecture/Proto/Security/Reference；只勾本地子项，真实GitHub/E2E子项与父项保持未勾；按用户要求未更新llmdoc。
- 验证：
  - 红灯`pnpm exec vitest run test/test-acceptance-workflow.test.ts` → exit 1；固定acceptance workflow缺失。
  - 红灯`pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/test-acceptance.test.ts` → exit 1/0 tests；production acceptance store缺失。
  - 聚焦Node `pnpm exec vitest run test/test-acceptance-runner.test.ts test/test-acceptance-workflow.test.ts test/delivery-policy.test.ts test/github-app-installation-token.test.ts` → exit 0，4 files / 16 tests；覆盖固定workflow、commit-bound argv、专用audience、控制值隔离、失败上报、policy binding和独立token cache。
  - 聚焦workerd `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/test-acceptance.test.ts test/workflow/outbox-routing.test.ts test/workflow/test-deployment.test.ts test/workflow/github-run-reconciler.test.ts test/workflow/github-workflow-run-webhook.test.ts` → exit 0，5 files / 29 tests（随后新增success等待Runner result与通用Agent projector隔离负向断言并由最终全量回归覆盖）；覆盖20路scheduler/outbox、deployment/Runner不提前成功、专用OIDC负向、signed/API success/failure/冲突、raw canary、安全query、五destination路由及通用reconciler隔离。
  - 最终`pnpm run verify` → exit 0；typecheck、ESLint、Node 31 files / 103 tests、workerd 37 files / 188 tests、157个生产文件Secret scan和Markdown links全绿。
  - `pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round53-20260726-final` → exit 0；Workflow/Queue/D1/双R2 bindings及新增migration/API/runtime/runner/projector成功bundle，未部署。
- 勾选：Phase 5 E2E/验收失败DoD下新增并勾选“本地控制面/workerd/固定workflow契约”子项；父项与“真实试点GitHub/E2E外部事实”保持未勾。本地fake JWT/HMAC/REST、workerd和dry-run不能冒充真实Actions run、test Environment、测试URL或外部Run状态。
- 决策沉淀：test deployment与post-deployment acceptance必须是两个独立required Item；deployment status、acceptance dispatch、OIDC identity、Runner result和GitHub workflow conclusion是五个不同事实，前四个都不能单独宣告成功。Runner result解决“执行了哪条固定命令/exit/duration”，签名/API workflow fact解决“平台最终如何结束”；两者只有在exact lineage上一致时才能生成passed Evidence，冲突一律fail-closed。真实E2E失败预算进入`blocked`属于后续外部/失败策略验证，本轮只证明失败绝不进入`succeeded`且Run安全保持`executing`。
- 遗留：真实试点需用户提供owner/repo并安装GitHub App，配置`test` Environment、`TEST_DEPLOY_TARGETS_JSON`、`CONTROL_PLANE_URL`、webhook与可访问的测试URL，在目标repo exact deployed SHA声明`acceptance:*`命令；分别记录deployment success但acceptance仍running、acceptance failure、success和webhook漏失/API补偿的Actions URL、测试URL、D1 Evidence/Run投影，证明失败为`executing`或按失败预算进入`blocked`且没有提前`succeeded`。

## Round 54 — 2026-07-26
- 目标：Phase 5 / 合并成功由GitHub webhook核对merge SHA；只在“无需部署”策略下可直接`succeeded`——本轮闭环本地签名merge fact、API补偿、immutable merge ledger/Evidence与no-deploy状态裁决；真实GitHub merge外部事实保持未完成。
- 前置与权限：仅本地Node/workerd/D1、测试HMAC和fake GitHub read-only REST；未访问真实GitHub组织、Cloudflare远端、云账户、Codex计费模型、飞书、Meegle、日志、数据库或tool-bridge，未调用merge API、未部署、未使用真实Secret。仓库尚未拍板自动合并，按第一性原理不把“核对外部merge事实”扩权成控制面自动merge。按用户要求固定核对Watt commit`476e3cd`并全库检索merge pull request、`merged_at`、`merge_commit_sha`、`pull_request closed`、merge method/squash/rebase；没有GitHub merge producer、签名projector、API reconciliation或merge SHA ledger可直接复制，唯一rebase命中仍为worktree文档建议，因此本轮直接复制代码为零；最大化复用此前从Watt迁入的stable identity、D1 conditional batch、external fact digest/收敛纪律，以及本项目已有HMAC webhook、merge-observation只读token、ready decision、verified publication与TaskQuery原语。
- 动作：
  - 先在既有merge gate suite增加production projector契约；首次`pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/github-merge-gate.test.ts`因`src/storage/github-merge-status-store.js`不存在而exit 1/0 tests，证明此前只有eligibility/ready decision，没有任何merge SHA事实路径。
  - migration 0030新增immutable `github_merges`与webhook/API统一`github_merge_observations`。merge ledger冻结ready时Run version、decision/publication/Plan、repo/PR、head/base/merge SHA、merged actor/time、deployment disposition和verified Evidence；同Run/decision/publication/repo+PR/repo+merge SHA唯一，raw payload/REST/token无列可落。
  - 新增strict `GitHubPullRequestMergeFact`与`GitHubMergeStatusStore`。HMAC `pull_request closed`仅在`merged=true`、merge SHA/actor/time合法时进入projector；closed-but-unmerged直接ignored。projector重新绑定Run=`ready_to_merge`、`decision.runVersion + 1`、active Plan/digest、verified publication、repo/PR/URL、head branch/SHA和base branch；gate前、旧head、错误binding与不一致deployment policy均零merge结果。
  - stable merge identity让20路同observation只生成一条merge/Evidence。webhook与API即使后续PR `updated_at`变化，只要merge core相同仍收敛；不同merge SHA/core固定conflict。merge Evidence保存canonical fact digest与安全PR URL，不使用Agent/CLI自报。
  - Run以两个CAS合法边推进`ready_to_merge → merging → succeeded|deploying`。直接`succeeded`必须同时满足Task `target_environment=none`、test/production deploy均未授权、active Plan无`test_deploy|production_deploy`；test target必须有allow+test deploy effect、production target必须有allow+production deploy effect，并且两者只到`deploying`。merge成功不复用此前test deployment/acceptance去伪造post-merge部署成功。
  - 新增`GitHubMergeStatusApiClient/Reconciler`，复用已有只读merge-observation token和`GET /pulls/{number}`，不申请merge写权限；只对exact ready candidate补偿漏失webhook，未合并PR保持pending，响应错误不泄漏token/body。Worker scheduled接入补偿；Task/Run查询新增安全merge投影，不公开fact/payload digest或raw数据。
  - 同步DOD与Architecture/Proto/Security/Reference；只勾本地子项，真实GitHub子项与父项保持未勾；按用户要求未更新llmdoc。
- 验证：
  - 红灯`pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/github-merge-gate.test.ts` → exit 1/0 tests；production merge status store缺失。
  - 聚焦Node `pnpm exec vitest run test/github-merge-status-api.test.ts test/github-merge-gate-api.test.ts test/github-app-installation-token.test.ts` → exit 0，3 files / 14 tests；覆盖只读token/GET、exact merged fact、unmerged pending、身份漂移和错误零泄漏。
  - 聚焦workerd `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/github-merge-gate.test.ts test/workflow/github-pull-request.test.ts test/workflow/github-review-feedback.test.ts test/workflow/github-base-observation.test.ts test/workflow/test-deployment.test.ts test/workflow/test-acceptance.test.ts` → exit 0，6 files / 59 tests；覆盖gate前拒绝、20路收敛、signed webhook/raw canary、API补偿/重放、closed-unmerged、旧head、no-deploy succeeded、deploy policy只到deploying、安全query及相邻PR/review/base/deploy/acceptance回归。
  - 最终`pnpm run verify` → exit 0；typecheck、ESLint、Node 32 files / 106 tests、workerd 37 files / 196 tests、162个生产文件Secret scan和Markdown links全绿。
  - `pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round54-20260726-final` → exit 0；Workflow/Queue/D1/双R2 bindings及新增migration/domain/store/reconciler/runtime/webhook成功bundle，未部署。
- 勾选：Phase 5 merge success DoD下新增并勾选“本地控制面/workerd契约”子项；父项与“真实试点GitHub外部事实”保持未勾。本地fake HMAC/REST、workerd和dry-run不能冒充真人merge、GitHub delivery、受保护分支或真实merge SHA。
- 决策沉淀：merge eligibility、merge mutation和merge external fact是三个独立平面。本轮只实现第三个平面并坚持“没有自动merge产品决策就没有merge写权限”；`ready_to_merge`不是已合并，GitHub `closed`也不是已合并，只有exact `merged=true + merge SHA`可入账。merge成功与deployment成功仍分层：no-deploy是Task allow flags与active Plan deploy effects共同证明的否定事实，任何deployment intent都必须进入`deploying`等待新的平台事实。
- 遗留：真实试点需用户提供owner/repo并安装GitHub App/webhook，在受保护PR已有真实ready decision后由真人merge；记录signed delivery、PR URL、merge SHA、D1 merge/Evidence/Run投影，并演练closed-unmerged、旧head、webhook漏失/API补偿。分别用真实`target_environment=none`与声明test/production deploy的计划证明前者最终`succeeded`、后者只到`deploying`。自动merge若未来拍板，必须另开DoD实现独立write token、effect前gate重验和幂等merge producer，不能反向把本轮只读projector当作merge权限。

## Round 55 — 2026-07-26
- 目标：Phase 5 / 生产部署必须经过GitHub Environment reviewer或等价外部审批；批准绑定revision + merge SHA + environment——本轮闭环本地post-merge identity-bound approval、production release lineage、scheduler/outbox/GitHub Deployment producer、固定production workflow/OIDC Runner和安全查询契约；真实GitHub Environment reviewer与云端production effect保持未完成。
- 前置与权限：仅本地Node/workerd/D1、测试JWK、fake GitHub REST/OIDC/HTTP和临时Git仓库；未访问真实GitHub组织、Cloudflare远端、云账户、飞书、Meegle、日志、数据库、tool-bridge或Codex计费模型，未部署、未使用真实Secret。按用户要求固定核对Watt commit`476e3cd`并检索GitHub Environment reviewer、production deployment、merge SHA approval binding、Deployments API、OIDC role与release ledger；最接近的是`watt-task-workflow.ts`的`confirm-release + waitForEvent + signal`，可复用其“持久checkpoint等待外部decision且错误signal不能恢复”的流程语义，但没有GitHub Environment身份、revision/merge binding、D1 approval lineage或deployment producer，直接复制会削弱安全契约，因此本轮Watt直接复制代码为零；继续最大化复用Round 51已直接迁移的Watt identity mapper以及本项目已有stable identity、D1 conditional batch、fenced outbox、GitHub Deployment/OIDC/policy Runner模式。
- 动作：
  - 先新增固定workflow与workerd生产scheduler契约；首次`pnpm exec vitest run test/production-deployment-workflow.test.ts`因`.github/workflows/delivery-production-deploy.yml`不存在而exit 1，首次`pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/production-deployment.test.ts`因`src/storage/production-deployment-store.js`不存在而exit 1/0 tests，证明此前没有production release执行路径。
  - migration 0031新增immutable `production_release_approval_bindings`、`production_deployments`与digest-only OIDC attestation。production approval现在只接受Run=`deploying`、Task production policy、active Plan effect与exact `github_merges`，并要求external decision时间不早于merge；revision、merge ID/SHA、environment全部由服务端派生，strict body拒绝caller夹带。
  - 重建`trusted_effect_approvals`：merge继续使用Watt-derived live identity/role/separation；production还必须exact join release binding与immutable merge。裸approval、无merge、旧Run/Plan、self approval、role撤销、reject/过期/invalidation均不能成为production authority。既有controlled replay fixture原来在`target_environment=test`却伪造`production_deploy` effect/outbox，本轮将该无效组合收窄为repo-write/test-deploy/merge，避免测试依靠非法policy通过。
  - `ProductionDeploymentStore/Reconciler`只扫描merge disposition=production且required Item均已passed的Run。latest exact approval后，20路调度以stable identity只创建一份post-merge deploy Attempt、immutable snapshot与`github_production_deployments` outbox；没有审批时零outbox。Queue effect前再次核对Run/Plan/revision/merge/approval/live role，然后才调用GitHub。
  - GitHub producer使用独立于test的deployment-only token cache，固定创建`ref=merge SHA + task=delivery-loop:production + environment=production`且payload只含schema/deployment ID；POST/GET reconciliation只推进`created_unverified`和Attempt running，不生成Evidence、不把Run移出`deploying`。Worker scheduled/relay/Queue router接入第六类destination，配置使用strict `PRODUCTION_DEPLOY_TARGETS_JSON`。
  - 固定`.github/workflows/delivery-production-deploy.yml`绑定GitHub `production` Environment、exact deployment/merge SHA与`contents:read + deployments:write + id-token:write`，不启用test cache。Runner使用独立production audience/subject/`production:*` role，在控制面核对release lineage后只执行merge SHA policy固定argv；GitHub/OIDC及全部production/test控制值从命令环境移除，控制面只保存OIDC digest。Task/Run查询只公开approval principal/ID、revision、merge ID/SHA、environment、状态/URL等白名单，不公开JWT digest/raw payload。
  - 同步DOD与Architecture/Proto/Security/Reference；只勾本地子项，父项与真实GitHub/云外部子项保持未勾；按用户要求未更新llmdoc。
- 验证：
  - 红灯`pnpm exec vitest run test/production-deployment-workflow.test.ts` → exit 1；固定production workflow缺失。
  - 红灯`pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/production-deployment.test.ts` → exit 1/0 tests；production deployment store缺失。
  - 聚焦Node `pnpm exec vitest run test/production-deployment-workflow.test.ts test/production-deployment-runner.test.ts test/github-production-deployment-api.test.ts test/github-app-installation-token.test.ts` → exit 0，4 files / 13 tests；覆盖fixed Environment、exact merge checkout、policy argv、production OIDC、控制值隔离、reference-only API与独立token cache。
  - 聚焦workerd `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/production-deployment.test.ts test/workflow/github-merge-gate.test.ts test/workflow/outbox-routing.test.ts` → exit 0，3 files / 45 tests；覆盖revision/merge/environment binding、无审批零effect、无merge及merge前decision拒绝、自批拒绝、20路scheduler/outbox、live role effect重验、OIDC负向、安全query、merge gate与六destination路由。
  - 首次全量`pnpm run verify` → exit 1；2条controlled replay测试因历史fixture把test target与production effect混用，在新trusted view下正确返回403。fixture收窄到其真实test policy后，`pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/controlled-replay.test.ts` → exit 0，1 file / 3 tests。
  - 最终`pnpm run verify` → exit 0；typecheck、ESLint、Node 35 files / 111 tests、workerd 38 files / 205 tests、173个生产文件Secret scan和Markdown links全绿。
  - `pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round55-20260726-final` → exit 0；Workflow/Queue/D1/双R2 bindings及新增migration/domain/store/reconciler/outbox/runtime/API/OIDC/Runner成功bundle，未部署。
  - `git diff --check` → exit 0。
- 勾选：Phase 5 production approval DoD下新增并勾选“本地控制面/workerd/固定workflow契约”子项；父项与“真实GitHub/云外部事实”保持未勾。本地YAML、fake JWT/REST、workerd和dry-run不能证明GitHub `production` Environment已配置required reviewers，也不能冒充真人approval、Actions job或云OIDC审计。
- 决策沉淀：production release发生在merge之后，因此不能伪装成合并前required Plan Item；ExecutionPlan只预声明`production_deploy` effect，merge后由独立release approval/deployment ledger承接。控制面等价外部审批与GitHub Environment reviewer是两层闸门：前者决定是否创建GitHub Deployment，后者由真实GitHub配置决定job能否启动；任何一层都不等于deployment成功。approval、Deployment create、Environment review/job start、OIDC identity和最终platform status必须分别留账；本轮只关闭前三者的本地契约，最终成功/失败projector属于下一DoD。
- 遗留：真实试点需用户提供owner/repo并安装GitHub App，配置`production` Environment required reviewers、`PRODUCTION_DEPLOY_TARGETS_JSON`、`CONTROL_PLANE_URL`与云端production OIDC role/trust；由真人在真实merge SHA上分别批准、拒绝、让审批过期和撤销role，记录Environment review、GitHub Deployment/Actions URL、OIDC审计和D1 lineage，并证明未批准/旧SHA均零job/云effect。下一轮继续Phase 5“deployment成功/失败从平台API/webhook核对”，不能使用Runner status POST响应或Action末尾输出冒充最终事实。

## Round 56 — 2026-07-26
- 目标：Phase 5 / deployment成功/失败从平台API/webhook核对；Action末尾echo `success`不能替代——本轮闭环本地production deployment HMAC webhook、read-only API补偿、统一observation/projector、verified Evidence与Run终态CAS；真实GitHub/云外部事实保持未完成。
- 前置与权限：仅本地Node/workerd/D1、测试HMAC/JWK、fake GitHub REST/OIDC/HTTP和临时Git仓库；未调用真实GitHub写API、未访问Cloudflare远端、云账户、飞书、Meegle、日志、数据库、tool-bridge或Codex计费模型，未部署、未使用真实Secret。按用户要求固定核对Watt commit`476e3cd`并检索`deployment_status`、GitHub Deployment/status API、platform result projector与external fact reconciliation；Watt仍只有`confirm-release`后由Workflow代码直接`complete-release`的硬编码结果，没有签名平台事实、REST补偿、merge-bound production Evidence或终态CAS可直接复制，因此本轮Watt直接复制代码为零；最大化复用本项目Round 52的HMAC deployment projector形态、既有GitHub App provider，以及Round 53/54的双源observation/reconciliation模式。
- 动作：
  - 先在production suite引入status projector契约；首次`pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/production-deployment.test.ts`因`src/storage/github-production-deployment-status-store.js`不存在而exit 1/0 tests，证明此前只有Deployment create/OIDC/Runner status reporter，没有可消费平台终态的生产模块。
  - migration 0032为`production_deployments`增加external state/updated time/observation version，并新增webhook/API统一`production_deployment_status_observations`；observation identity不可改写，只保存source、fact/payload digest、repo、GitHub/control-plane deployment IDs、external/observed/processed time与固定applied/ignored reason，没有raw payload/REST/token列。
  - 新增strict production status fact与`GitHubProductionDeploymentStatusStore`。projector重新绑定repo、GitHub/control-plane deployment ID、merge SHA、task/environment、current deploying Run/version、Task revision、active Plan/digest、immutable merge/release approval与running deploy Attempt；GitHub `updated_at`单调推进，错误binding/旧事实只记ignored。
  - `in_progress`只更新外部投影；Deployment create、Environment job、OIDC和Runner status POST均零Evidence/零Run终态。success必须另有exact production OIDC，才在一个D1 batch创建唯一verified passed deployment Evidence、完成deploy Attempt、把Plan置completed并CAS `deploying→succeeded`。failure/error无需伪装为成功attestation，创建verified failed Evidence、失败Attempt并CAS `deploying→failed`；terminal冻结，failure后晚到success不能复活Run。
  - HMAC webhook按`delivery-loop:production + production`与reference-only payload路由到production projector；URL去除query/fragment。新增只含`deployments:read`且与production create write-token分离的token cache；API adapter先GET exact Deployment核对ID/SHA/task/environment/deployment ID，再GET statuses并只取真正latest一条，latest pending不会错误采用更旧success。scheduled reconciler使用相同projector补偿漏失webhook，Worker cron接线。
  - 20路webhook/API重放与两源并发收敛为两条source observation、一条Evidence和一次Run终态；success缺OIDC保持received可重试，错误SHA、乱序、raw canary、failure及安全query均有测试。Task/Run投影新增externalState/externalUpdatedAt白名单，不公开OIDC/fact digest/raw数据。
  - 2026-07-26实读GitHub官方webhook/REST文档，确认`deployment_status` webhook和Get Deployment/List deployment statuses的Deployments read权限，以及status的`updated_at/deployment_url/environment_url`字段；同步DOD、Architecture、Proto、Security与Reference，只勾本地子项，父项/真实外部子项保持未勾；按用户要求未更新llmdoc。
- 验证：
  - 红灯`pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/production-deployment.test.ts` → exit 1/0 tests；production status store缺失。
  - 聚焦Node `pnpm exec vitest run test/github-production-deployment-status-api.test.ts test/github-production-deployment-api.test.ts test/production-deployment-runner.test.ts test/github-app-installation-token.test.ts` → exit 0，4 files / 17 tests；覆盖exact Deployment→latest status双GET、latest pending不复用旧success、身份漂移、错误零泄漏、read/write token cache隔离及Runner回归。
  - 聚焦workerd `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/production-deployment.test.ts test/workflow/test-deployment.test.ts test/workflow/github-merge-gate.test.ts test/workflow/outbox-routing.test.ts` → exit 0，4 files / 59 tests；随后新增webhook/API双源并发断言由最终全量覆盖。覆盖create/in-progress/OIDC/final分层、success/failure、20路双源、缺OIDC retry、乱序/错误binding、raw canary、安全query、test deployment/merge/router相邻回归。
  - 最终`pnpm run verify` → exit 0；typecheck、ESLint、Node 36 files / 116 tests、workerd 38 files / 213 tests、178个生产文件Secret scan和Markdown links全绿。
  - `pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round56-20260726-final` → exit 0；Workflow/Queue/D1/双R2 bindings及新增migration/domain/store/reconciler/runtime/webhook成功bundle，未部署。
  - `git diff --check` → exit 0。
- 勾选：Phase 5 platform deployment status DoD下新增并勾选“本地控制面/workerd契约”子项；父项与“真实GitHub/云外部事实”保持未勾。本地fake HMAC/REST/JWT、workerd和dry-run不能冒充真实GitHub status、Actions输出、Environment URL或云端部署结果。
- 决策沉淀：Runner向GitHub POST status只是触发平台事实的候选写，HTTP 201和Action输出都不是控制面成功证据；控制面只消费GitHub HMAC webhook或read-only API回读。生产终态必须同时满足exact post-merge lineage和平台state，success再叠加OIDC；failure不能因缺OIDC被隐藏。API补偿必须核对Deployment本体后读取真正latest status，不能从历史列表挑一个有利的success。终态冻结优先于“最终可能恢复”的乐观推断，失败后的重试必须走后续显式恢复/新Attempt，而不是让晚到success复活旧Run。
- 遗留：真实试点需在受保护production Environment分别产生in-progress/success/failure/error，记录签名delivery、Get Deployment/List statuses摘要、Actions/Environment URL、D1 observation/Evidence/Run；主动漏失webhook后验证scheduled API补偿，并制造Action末尾输出success但平台status failure，证明Run最终failed。下一轮继续Phase 5 rollback contract，production自动回滚仍必须另行审批，不能因为本轮能识别failure就自动获得回滚权限。

## Round 57 — 2026-07-26
- 目标：Phase 5 / 仓库提供明确rollback contract时测试环境自动回滚可执行；生产自动回滚策略另行审批并有演练证据——本轮闭环本地exact-SHA test rollback contract observation、verified failure触发、独立ledger/outbox/OIDC Runner、HMAC/API双事实终态和安全查询；真实test云回滚与production决策/审批/演练保持未完成。
- 前置与权限：仅本地Node/workerd/D1、测试HMAC/JWK、fake GitHub REST/OIDC/HTTP与临时Git仓库；只读访问GitHub官方文档，未调用真实GitHub写API、未访问Cloudflare远端、云账户、飞书、Meegle、日志、数据库、tool-bridge或Codex计费模型，未部署、未使用真实Secret。按用户要求固定核对Watt commit`476e3cd`并全树/历史检索rollback/revert/compensation/deployment/workflow；Watt的`rollbackDelivery`是correlation消息投递失败后回pending，compensating delete是局部写失败补偿，不是GitHub/云环境rollback contract。Watt没有失败SHA policy读取、deployment/acceptance Evidence lineage、rollback workflow/OIDC或平台终态projector，因此可直接复制的业务代码为零；强行复制会混淆消息重试与环境回滚。本轮最大化复用此前从Watt迁入的pending→delivering→settled fencing/stable identity，以及本项目test acceptance store/outbox/OIDC Runner/双事实projector结构。
- 动作：
  - 先新增固定workflow与durable store红灯；首次`pnpm exec vitest run test/test-rollback-workflow.test.ts`得到1 failed/ENOENT，证明rollback workflow不存在；首次`pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/test-rollback.test.ts`得到failed suite/0 tests，原因是`src/storage/test-rollback-store.js`不存在，证明此前没有环境rollback执行路径。
  - 扩展strict `DeliveryPolicy v1`：test target可选声明固定`.github/workflows/delivery-test-rollback.yml`、`environment=test`、`delivery-loop-test-rollback` audience、与deploy role分离的`test:*` role、去重`automaticOn=deployment_failure|acceptance_failure`和结构化argv。rollback command不进入Agent Plan refs；production target strict拒绝rollback字段。
  - migration 0033新增immutable `test_rollback_contract_observations`、`test_rollbacks`、OIDC attestation与webhook/API observation。scheduler只选择签名平台事实已生成的verified failed test deployment/acceptance Evidence；用独立`contents:read` App token读取exact失败SHA的`delivery.yaml`。policy缺失/非法/未声明trigger保存负向observation，source未verified、Task非test或production failure零记录/零outbox。
  - declared contract与source Evidence、原deployment/approval、Run/Plan/失败Attempt/SHA、policy/contract digest同一D1 batch冻结，20路调度创建唯一rollback Attempt和`github_test_rollback` outbox。dispatch使用独立`actions:write + contents:read` cache；Queue只携outbox ID并回查D1 destination，effect前重新核对contract/source/Run/Plan；稳定run-name与POST后GET reconciliation避免重复Action。
  - 固定rollback workflow绑定GitHub `test` Environment、exact失败SHA及`contents:read + id-token:write`，没有deployment/production权限。Runner使用独立audience/subject/role，重新加载exact policy并核对source trigger、policy digest、contract digest后才执行固定argv；命令环境移除GitHub/OIDC/rollback ID/SHA/control-plane身份值，OIDC/result只存digest与白名单标量。
  - Runner result和GitHub `workflow_run`继续分层：requested/in-progress、OIDC或Runner pass均零Evidence；HMAC webhook为主，独立`actions:read` token的API补偿为辅，两者共用exact repo/run/workflow/title/branch/SHA/run-attempt projector。completed success还需Runner passed/exit 0才写独立verified rollback Evidence并完成Attempt；failure/冲突写failed Evidence且终态冻结。rollback成功不修改原failed Item或把Run标`succeeded`。TaskQuery只公开source引用、digests、role、GitHub run和终态，不公开raw policy/payload/token/result digest。
  - 20路policy/scheduler/outbox/projector、deployment与acceptance两类source、contract缺失/非法/未声明、unverified source、production隔离、OIDC负向、Runner/GitHub双事实、webhook/API并发、raw canary和安全query均有测试。同步DOD、Architecture、Proto、Security与Reference；父项及真实test/production外部子项保持未勾，按用户要求未更新llmdoc。
  - 2026-07-26实读GitHub官方文档，确认exact ref的Contents API需要Contents read，workflow dispatch需要Actions write，Get workflow run需要Actions read；实现分别使用三套缓存而非复用高权限token。
- 验证：
  - 红灯`pnpm exec vitest run test/test-rollback-workflow.test.ts` → Vitest 1 failed，固定workflow ENOENT。
  - 红灯`pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/test-rollback.test.ts` → failed suite / 0 tests，rollback store模块缺失。
  - 聚焦Node `pnpm exec vitest run test/delivery-policy.test.ts test/test-rollback-workflow.test.ts test/test-rollback-runner.test.ts test/github-test-rollback-api.test.ts test/github-app-installation-token.test.ts` → exit 0，5 files / 23 tests；覆盖strict policy/production拒绝、workflow permissions、exact argv/env隔离、Contents/Actions adapter与三token cache。
  - 聚焦workerd `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/test-rollback.test.ts test/workflow/outbox-routing.test.ts` → exit 0，2 files / 14 tests；覆盖两类verified source、负向contract、production零effect、20路scheduler/outbox、OIDC、双事实成功/失败/冻结、HMAC/API收敛、raw canary、安全query和第七destination路由。
  - 最终`pnpm run verify` → exit 0；typecheck、ESLint、Node 39 files / 124 tests、workerd 39 files / 222 tests、191个生产文件Secret scan和Markdown links全绿。
  - `pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round57-20260726-final` → exit 0；Workflow/Queue/D1/双R2 bindings及新增migration/domain/store/reconciler/runtime/webhook/OIDC/Runner成功bundle，未部署。
  - `git diff --check` → exit 0。
- 勾选：Phase 5 rollback DoD下新增并勾选“本地控制面/workerd/固定workflow契约”子项；父项与“真实GitHub/云外部事实与production决策”保持未勾。本地YAML、fake REST/JWT/HMAC、workerd和dry-run不能冒充真实test Environment、云回滚结果、production审批或演练。
- 决策沉淀：rollback是失败后的独立外部副作用，不是failure projector内的顺手命令，也不是把原Item改回passed。自动授权来自“原test deploy已获批并发生 + verified外部failure + 失败SHA明确contract”三者交集；contract discovery必须先于Actions write，负向观察同样持久化。test与production的环境、schema、OIDC、role、outbox和审批边界物理分离；production failure本身不授予任何自动补偿权限。
- 遗留：真实试点需在目标仓库失败SHA声明安全、幂等rollback command，配置test Environment与云端`test:*` rollback role，分别制造deployment/acceptance failure并记录Contents policy SHA、Actions URL、OIDC/cloud审计、外部环境结果和D1 Evidence；另实测未声明contract与production failure零自动job。production是否自动回滚仍需产品/安全决策；若启用，必须另建revision/merge/failure-bound真人或Environment审批、production专属role/outbox/workflow并完成成功/失败/重复/乱序/人工恢复演练。

## Round 58 — 2026-07-26
- 目标：Phase 5 / 飞书卡片分开展示PR、merge、test deploy、production deploy四种状态与链接——本轮闭环本地安全投影、immutable presentation/delivery ledger、create/PATCH/14天重建、Watt-derived token/UUID与第八类outbox；真实飞书tenant消息事实保持未完成。
- 前置与权限：仅本地Node/workerd/D1、fake Feishu REST与只读官方文档；未调用飞书发送/更新接口，未访问真实tenant/chat、Cloudflare远端、GitHub写API、云账户、日志、数据库、tool-bridge或Codex计费模型，未部署、未使用真实Secret。按用户要求固定核对Watt commit`476e3cd`，完整读取`plugin-feishu` encode/send与gateway consumer相关代码；使用`lark-openapi-explorer`只读核实飞书消息模块，没有执行写命令。
- 动作：
  - 首次`pnpm exec vitest run test/feishu-delivery-card.test.ts`因`src/domain/feishu-delivery-card.js`不存在而failed suite/0 tests，证明项目此前没有delivery card renderer；随后REST adapter红灯同样因`src/outbox/feishu-delivery-card.js`不存在失败。
  - 直接迁移Watt interactive card `wide_screen_mode`编码骨架、`memoryTokenCache`、7200秒token/60秒安全边际、99991661/99991663/99991665失效码及create `uuid`语义；按飞书共享卡更新要求补`update_multi=true`。Watt会把上游`msg`/异常正文拼入error，本轮明确不复制，所有错误收窄为固定码。
  - migration 0034新增每Run唯一`feishu_delivery_cards`、immutable四段`feishu_delivery_card_presentations`和terminal delivery ledger。presentation只存PR/Merge/Test Deploy/Production Deploy枚举与可选净化HTTPS链接，不存在Task/PR正文、Runner输出、raw response或token列。
  - scheduled reconciler只查询D1 verified fact projection：PR/merge链接要求verified publication，deployment链接要求external observation version前进；create candidate与未核对URL只显示状态。canonical digest/revision/outbox同批写入，20路扫描只生成一份presentation/outbox；source变化生成新revision，旧outbox在effect前以固定stale码settle且零外部调用。
  - `FeishuDeliveryCardApiClient`首次POST interactive消息并使用最长50字符稳定UUID，成功message ID/time持久化；14天窗口内PATCH同一message，窗口超时或230031重建新卡。230020/230049、HTTP 429/5xx、网络与token失效保持pending重试；其他业务拒绝以`feishu_request_rejected`terminal settle，raw Feishu正文不传播。
  - Worker cron、relay和Queue router接入`feishu_cards`第八类destination；`FEISHU_APP_ID/APP_SECRET/DELIVERY_TENANT_KEY/DELIVERY_CHAT_ID`全缺时关闭，部分配置fail-closed，可选API base只接受HTTPS origin。同步DOD、Architecture、Proto、Security与Reference，只勾本地子项，父项/真实tenant子项保持未勾；按用户要求未更新llmdoc。
  - 实读飞书官方发送、更新卡片与tenant token文档，确认create路径/interactive content/1小时UUID、同群5 QPS/30 KB，PATCH exact message ID、前后`update_multi=true`、单卡5 QPS/14天窗口，以及发送与更新权限边界。
- 验证：
  - 红灯`pnpm exec vitest run test/feishu-delivery-card.test.ts` → exit 1，renderer模块不存在；REST adapter扩展后再次exit 1，outbox模块不存在。
  - 聚焦Node `pnpm exec vitest run test/feishu-delivery-card.test.ts` → exit 0，1 file / 6 tests；覆盖四段独立渲染、URL安全边界、verified投影、token cache/UUID、POST/PATCH、token失效、限流、过期和raw错误零传播。
  - 聚焦workerd `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/feishu-delivery-card.test.ts` → exit 0，1 file / 2 tests；覆盖20路收敛、旧revision零effect、create→PATCH、任务标题canary隔离、delivery ledger及14天重建。
  - 全量`pnpm run verify` → exit 0；typecheck、ESLint、Node 40 files / 130 tests、workerd 40 files / 224 tests、196个生产文件Secret scan和Markdown links全绿。文档修改后另行重跑workerd 40/224、Secret scan 196 files和docs links，均exit 0。
  - `pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round58-20260726-final` → exit 0；Workflow/Queue/D1/双R2 bindings及migration/domain/reconciler/outbox/runtime成功bundle，未部署。
  - `git diff --check` → exit 0。
- 勾选：Phase 5 Feishu delivery card DoD下新增并勾选“本地控制面/workerd契约”子项；父项与“真实飞书tenant外部事实”保持未勾。本地fake REST、workerd与dry-run不能证明机器人已发布、权限已授权、真实群已发卡或同message更新成功。
- 决策沉淀：飞书卡片是D1外部事实的安全展示面，不是新的状态真源；一个overall Run状态不能代替PR/merge/test/production四段。卡片恢复依靠immutable presentation + outbox + message ledger，不依赖Worker内存；token缓存可以丢，message identity不能丢。飞书只保证UUID一小时create去重且PATCH最多14天，因此本地必须持久化message ID/time并明确重建路径，不能假设一张物理消息永久可更新。
- 遗留：真实试点需创建/发布自建应用、启用机器人并配置发送/更新权限，把机器人加入目标群并注入tenant/chat/Secret；按真实Run依次推进四类fact，记录首次消息和同message ID更新截图/URL。还需实测5 QPS/超时/token刷新、230031/14天重建、业务拒绝与人工刷新恢复，并审计D1/outbox无token/raw响应后才能勾父项。下一轮继续Phase 5“真实试点仓库跑通测试环境部署；production隔离demo演练”，不得用本地飞书fake替代真实tenant证据。

## Round 59 — 2026-07-26
- 目标：Phase 5 / 真实试点仓库跑通测试环境部署；生产至少在隔离demo环境演练审批、成功、失败和回滚——本轮闭环不依赖外部资源的显式opt-in evidence manifest/live verifier；真实GitHub/Cloudflare/云试点保持未完成。
- 前置与权限：只读检查本地Git配置、policy、现有脚本与Watt固定commit`476e3cd`；`git remote -v`为空，当前branch为`main`，`delivery.yaml`为`deployment.mode: none`。未创建远端、未安装GitHub App、未部署Cloudflare、未触发Action/Deployment、未访问云账户/飞书/tool-bridge/日志/数据库或计费模型，未使用真实token。真实试点的owner/repo/visibility/branch protection、Actions预算、控制面origin、GitHub App、test/production Environment及云OIDC role均未提供或授权。
- 动作：
  - 先新增`PilotEvidenceManifestV1`与live verifier测试；第一次`pnpm exec vitest run test/pilot-evidence.test.ts`在修正测试自身语法后因`src/domain/pilot-evidence.js`不存在而failed suite/0 tests，证明此前没有外部试点证据契约或一键opt-in入口。
  - 直接复用Watt`scripts/e2e/lib.ts@476e3cd`的显式消耗门控与退出分层：0=通过、1=事实/断言失败、2=env/token/种子等前置缺失。Watt CLI/HTBP断言与delivery-loop GitHub Deployment/Environment/D1 Evidence不等价，因此未复制其业务步骤。
  - 新增strict `PilotEvidenceManifestV1`：test必须同时含deployment+独立acceptance；production demo必须以三个不同Run/Deployment/Action记录success、failure/error和rollback，rollback绑定failure SHA并恢复到已知success SHA。ID/SHA/HTTPS链接白名单、禁止userinfo/query/fragment、跨场景identity唯一均由runtime schema强制；示例manifest明确不是证据。
  - 新增只读live verifier：使用控制面短期token交叉核对三条`GET /v1/runs/:runId/plan`投影中的status/environment/SHA/GitHub ID/approval/Evidence/URL；使用试点仓库Actions/Deployments read token核对五条Action的repo/completed conclusion/head SHA及三个Deployment的SHA/task/environment/latest state。任一candidate未verified或GitHub/D1漂移固定码失败，raw HTTP正文、manifest和token不输出。
  - 新增`pnpm run e2e:pilot`。默认未设置`DELIVERY_LOOP_PILOT_E2E=1`立即exit 2且零网络；opt-in但manifest/origin/token不完整同样exit 2；schema/live事实失败exit 1；成功仅输出pilot/repo、3/5/3核对计数与固定状态。OIDC、required reviewer、demo隔离和rollback结果因无统一API，只留无query审计URL并要求人工review，不能由exit 0单独关门。
  - 新增[Phase 5真实试点验收](docs/PilotE2E.md)，写明资源owner前置、test与隔离production demo演练顺序、仓库外manifest、Secret注入、退出码和证据边界；同步DOD、Architecture、Proto、Security与Reference。只勾本地证据关口，父项/真实外部子项保持未勾；按用户要求未更新llmdoc。
- 验证：
  - 红灯`pnpm exec vitest run test/pilot-evidence.test.ts` → exit 1，failed suite / 0 tests，pilot evidence domain模块不存在。
  - `pnpm exec vitest run test/pilot-evidence.test.ts` → exit 0，1 file / 4 tests；覆盖示例/strict schema、success/failure/rollback完整性、3条控制面+5条Action+3个Deployment live交叉核对、token零输出、raw响应零传播和platform status不一致fail-closed。
  - `pnpm run e2e:pilot`（无opt-in）→ exit 2，固定`opt-in missing`且零网络；`DELIVERY_LOOP_PILOT_E2E=1 pnpm run e2e:pilot`（无真实配置）→ exit 2，固定`required pilot configuration is incomplete`且零网络。exit 2是前置缺失，不是skip或通过。
  - `pnpm run verify` → exit 0；typecheck、ESLint、Node 41 files / 134 tests、workerd 40 files / 224 tests、200个生产文件Secret scan和Markdown links全绿。
  - `pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round59-20260726-final` → exit 0；Workflow/Queue/D1/双R2 bindings及新增schema/export成功bundle，未部署、未触发外部试点。
  - `git diff --check` → exit 0；同次`git remote -v`仍无输出，证明真实远端前置未变化。
- 勾选：Phase 5最终试点DoD下新增并勾选“本地显式opt-in证据关口”子项；父项与“真实GitHub/Cloudflare/云外部事实”保持未勾。schema、fake fetch、示例manifest和exit 2都不能冒充真实Action/Deployment/Environment/OIDC/rollback。
- 决策沉淀：一份人工填写manifest只能作为外部证据索引，不能作为事实真源；可统一API的GitHub Actions/Deployment与D1投影必须在线交叉核对，不可统一API的OIDC/reviewer/隔离/恢复链接必须人工review。production success、failure和rollback不能复用一个可变Run或Deployment，终态冻结要求独立identity；当前production自动rollback未获授权，demo恢复必须如实标记manual或另行受审contract。
- 遗留：要完成真实子项，用户至少需要确认GitHub owner/repo/visibility/默认分支保护与Actions预算，并授权创建/使用远端；提供已部署控制面origin、试点App installation、`test`与受保护`production` Environment、隔离demo云账户/namespace及test/production OIDC role/audit。完成真实deployment+acceptance、production success/failure和rollback后，把仓库外manifest路径与短期只读token注入受控环境运行`pnpm run e2e:pilot`；exit 0加人工审计review及PROGRESS外部URL才可勾父项。当前尚可继续Phase 6不依赖这些资源的本地可靠性契约，但不得把它们用于回填Phase 5外部事实。

## Round 60 — 2026-07-26
- 目标：Phase 6 / Task、Run、Attempt、GitHub run、PR、deployment的correlation ID可在日志和trace中联查——本轮闭环本地D1/workerd安全反查与structured log子项，真实平台日志/trace事实保持未完成。
- 前置与权限：仅本地Node/workerd/D1与既有fake GitHub producer；未访问或写入真实GitHub、Cloudflare远端、飞书、Meegle、日志平台、数据库或tool-bridge，未部署、未使用真实Secret。按用户要求固定核对Watt commit`476e3cd`，完整读取core/gateway correlation和EventStore实现；直接保留其allowlisted filter、未知key拒绝、D1参数绑定、200条上限与trace定向查询纪律。Watt的Agent等待/超时/定向回送状态机不是跨交付链关联根，未复制为错误业务模型。
- 动作：
  - 先写Task/Run/Attempt/GitHub run/tool trace五种入口、认证/strict scope、PR/test/production producer、URL净化与structured log canary测试。首次定向运行因`src/observability/correlation-log.js`不存在而failed suite/exit 1，证明原项目只有分散foreign key，没有统一反查/日志契约。
  - `run_id`固定为durable correlation root；HTTP `x-correlation-id`继续只关联单请求。新增`GET /v1/correlations?kind=...&id=...&repository=...`，支持task/run/attempt/trace/github_run/github_pr/test_deployment/production_deployment/github_deployment/test_acceptance/test_rollback。PR与GitHub deployment数字ID必须带repository，其余kind禁止scope；未知/重复参数、非法ID固定400且不回显，多Run命中fail-closed。
  - 首版用trigger维护materialized links，聚焦回归暴露D1把trigger附加写计入producer `meta.changes`，20路test deployment scheduler因此全部误判`created=false`。删除trigger/materialized表，改为直接读取authoritative ledger的views，避免写放大、漂移和第二状态真源。
  - 初次read-only view仍因workerd SQLite复合SELECT项数上限报`too many terms in compound SELECT`；拆为每个最多4路UNION的identity/trace-pr/deployments/workflow-runs/deployment-runs五个view。拆分后聚焦测试再以`no such column: correlation_id`红灯发现独立view首SELECT没有显式别名；补齐稳定view schema后全绿。
  - 查询返回Task/Run、Attempts、GitHub runs、PR、test/production deployments和tool traces白名单安全投影，每类最多200条并给出truncated；HTTPS链接移除query/fragment。成功查询发一条`correlation_lookup`结构化日志，各ID类最多50个且无自由文本、query、URL、正文、R2/artifact ref、token、payload或raw error。同步DOD、Architecture、Proto、Security与Reference，按用户要求未更新llmdoc。
- 验证：
  - 红灯`pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/correlation-query.test.ts` → exit 1，correlation log模块不存在；中间producer回归因trigger `meta.changes`漂移exit 1；read-only view又分别以compound SELECT超限和缺`correlation_id`别名exit 1，均按真实失败保留。
  - 聚焦`pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/correlation-query.test.ts test/workflow/github-pull-request.test.ts test/workflow/test-deployment.test.ts test/workflow/production-deployment.test.ts` → exit 0，4 files / 30 tests；覆盖基础ID、真实PR/test/production ledger、repository scope、严格API、URL/raw canary零日志及既有20路producer语义无回归。
  - `pnpm run typecheck`、`pnpm run lint` → exit 0。
  - `pnpm run verify` → exit 0；typecheck、ESLint、Node 41 files / 134 tests、workerd 41 files / 227 tests、204个生产文件Secret scan和Markdown links全绿。
  - `pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round60-20260726-final` → exit 0；Workflow/Queue/D1/双R2 bindings及新增migration/query/log/API成功bundle，未部署。
  - `git diff --check` → exit 0。
- 勾选：Phase 6 correlation DoD下新增并勾选“本地D1/workerd/结构化日志契约”子项；父项与“真实平台日志/trace事实”保持未勾。本地console/workerd、fake GitHub IDs和D1行不能证明部署后日志索引、真实Actions/PR/deployment或tool-bridge trace可联查。
- 决策沉淀：长期关联身份必须来自业务lineage而不是可由客户端影响的HTTP header；外部数字ID必须用repository消歧。correlation index若靠trigger复制事实会同时污染D1写结果语义并产生漂移风险，只读view更符合控制面真源边界；但workerd SQLite的compound SELECT限制要求把view按语义拆小。Watt可直接复用的是查询/trace纪律，不是等待方correlation状态机。
- 遗留：真实闭环需要先完成远端/控制面/试点部署，然后在日志平台配置结构化字段索引和保留；用同一真实Run的Task、Attempt、Actions run、PR、test/production deployment与tool trace ID逐项反查并保存平台链接/截图、响应和Secret扫描证据。父项关闭前还应注入一次跨repository相同PR/deployment数字ID，证明scope不会串Run。

## Round 61 — 2026-07-26
- 目标：Phase 6 / stuck detector对queued/running/awaiting_review/deploying分别有阈值和动作；故障注入能在阈值内告警/恢复。
- 前置与权限：仅本地workerd/D1、fake时间与既有outbox/reconciliation原语；未访问GitHub、Cloudflare远端、飞书、日志平台、数据库或tool-bridge，未触发Action/消息/部署、未使用真实Secret。按用户要求固定核对Watt commit`476e3cd`的`watt-task-workflow.ts` checkpoint timeout及其平台force-timeout测试；直接沿用“稳定timeout、超时必须落安全终态且不能无限waiting”的纪律。Watt没有多状态watchdog、heartbeat lease fencing、durable incident或deployment projector，业务代码直接复制量为零；其人审超时直接failed不符合本项目策略，未复制。
- 动作：
  - 先写四状态exact阈值、阈值前零告警、20路并发、queued outbox rearm、running token/lease/Workflow fencing、safe query/log canary及状态恢复自动结案测试。首次`pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/run-stuck-detector.test.ts`因`src/reconciliation/run-stuck-detector.js`不存在而failed suite/0 tests，证明此前仅有running lease timeout，无另外三类状态或durable alert。
  - migration 0036新增`run_stuck_incidents`及open/run/stuck-scan索引。incident只保存Run/state/version、可选Attempt、阈值、固定action/status/resolution和时间；无Task/PR正文、URL、payload/ref、token、外部响应或raw错误。stable ID绑定non-running Run version或running Attempt lease generation，20路scan只插入一次。
  - 默认policy固定为queued 300秒、running 90秒、awaiting_review 86400秒、deploying 1800秒；范围严格限制60～604800秒。Run类以同state/version的`updated_at`为无进展anchor；running同时使用heartbeat或lease expiry，并在effect前重验Attempt status/version/generation与Run state/version，修复原scanner只看Attempt、并发loser也可能返回lost的薄弱点。
  - queued action只把过期delivering `workflow_create`恢复pending并清lease，随后复用既有Watt-derived relay/fenced processor；running在同一D1 batch写incident、Attempt lost/generation+1、token revoke、Run blocked、旧dispatch settle与唯一Workflow cancel。awaiting_review只升级人工处理，deploying只要求既有签名webhook/API reconciliation；二者不因时间自行reject/fail。
  - scheduled执行顺序改为先watchdog，再在同一Cron周期并行relay、GitHub/PR/deployment/飞书reconciliation和credential revoke，确保queued rearm本周期可投递、deploy alert本周期重查平台事实。后续scan观察Run state/version前进或Attempt fenced后以CAS自动resolved并输出一次安全`run_stuck_resolved`；日志sink失败不回滚durable incident/动作。
  - `GET /v1/tasks/:id`与`GET /v1/runs/:id/plan`最多投影最近20条incident安全字段。同步DOD、Architecture、Proto、Security与Reference；按用户要求未更新llmdoc。
- 验证：
  - 红灯`pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/run-stuck-detector.test.ts` → exit 1，failed suite / 0 tests，watchdog模块不存在。
  - 聚焦`pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/run-stuck-detector.test.ts test/workflow/workflow-callback.test.ts test/workflow/task-query-api.test.ts test/workflow/outbox-routing.test.ts test/workflow/test-deployment.test.ts test/workflow/production-deployment.test.ts` → exit 0，6 files / 39 tests；覆盖四阈值、20路收敛、rearm/fence/resolve、晚到callback、查询、router与test/production相邻回归。
  - 首次`pnpm run typecheck` → exit 2，严格类型指出D1 batch首结果可能`undefined`；增加显式完整性校验后`pnpm run typecheck`与`pnpm run lint`均exit 0。
  - `pnpm run verify` → exit 0；typecheck、ESLint、Node 41 files / 134 tests、workerd 42 files / 230 tests、206个生产文件Secret scan和Markdown links全绿。
  - `pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round61-20260726-final` → exit 0；每分钟Cron、Workflow/Queue/D1/双R2 bindings及新增migration/watchdog/query成功bundle，未部署。
  - `git diff --check` → exit 0。
- 勾选：Phase 6 stuck detector DoD完整勾选；可重跑workerd故障注入已经覆盖原文要求的四状态阈值、动作、告警和恢复。真实日志保留/告警通知渠道及连续试运行仍由Phase 6 correlation、runbook和7天DoD独立验收，不能用本轮console替代。
- 决策沉淀：human wait与deployment慢不是失败事实，watchdog只能告警/升级/重查，不能根据墙钟伪造reject或failed；running lease失联则必须先撤权和终止旧控制流再允许replacement。durable incident是告警真源，structured log只是可丢投影；检测与relay/reconciliation必须在同一scheduled链中有先后关系，不能并发启动后假设本周期一定看到rearm。
- 遗留：下一轮处理Phase 6 outbox/queue dead-letter可重放；需要先定义terminal失败与重试耗尽边界、DLQ持久身份、管理员replay授权，以及对dispatch/PR/merge/deployment三次重放的外部effect去重证明。

## Round 62 — 2026-07-26
- 目标：Phase 6 / outbox/queue dead-letter可重放，重放3次不产生重复dispatch、PR、merge或部署。
- 前置与权限：仅本地Node/workerd/D1、fake Queue与fake external effect；只读访问Cloudflare官方DLQ文档，未创建远端Queue、未调用GitHub/飞书/Cloudflare写API、未触发Action/PR/deployment/merge、未部署、未使用真实Secret。按用户要求固定核对Watt commit`476e3cd`的Queue consumer/wrangler/provision：直接迁移`max_retries=3 + dead_letter_queue`及“畸形毒丸ack、暂时失败retry”分流，队列名按本项目调整。Watt明确DLQ不配consumer且没有capture/replay工具，因此其余业务代码不能直接复制。
- 动作：
  - 先写DLQ capture、poison ack、三层冻结、独立operations认证、strict replay、相同请求3次、dispatch/PR/deployment Queue各重投3次、merge零记录、settled自动结案与raw canary测试。首次`pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/outbox-dead-letter.test.ts`因`src/outbox/outbox-dead-letter.js`不存在而failed suite/0 tests，证明此前普通失败永久回pending、Queue无retry limit/DLQ/replay。
  - migration 0037新增immutable `outbox_dead_letters`与`outbox_dead_letter_replays`。dead letter保存原outbox/run、受限Queue message ID/attempts、kind/destination/attempt count、固定last error与open/replay_requested/resolved时间；没有message body、payload ref内容、Task/PR正文、token或外部响应。每outbox最多一个open、每dead letter最多一个replay，身份/终态trigger禁止改写。
  - Wrangler主consumer配置3次retry后转`delivery-loop-workflow-outbox-dlq`；同Worker独立消费DLQ，只有exact`{outboxId}`会回查D1并在ack前capture。畸形/已不存在outbox为不可恢复毒丸ack，D1失败retry；DLQ consumer自身100次失败后转不消费的quarantine queue，避免未配置下被永久删除。
  - open dead letter通过`NOT EXISTS open`在Cron relay、FencedOutboxProcessor claim/drain和D1 router三层冻结；已在途消息路由为`dead_lettered`后安全ack，不能绕过router直接effect，也不会由Cron无限制造新主队列消息。
  - 新增`GET /v1/dead-letters`与`POST /v1/dead-letters/:id/replay`，仅独立`OPERATIONS_TOKEN`可用；Task intake/approval/Runner token无权。GET只返回ID/枚举/计数/固定错误/时间且no-store；POST strict只有expected outbox attempt count与三个固定reason，调用方不能提交outbox/kind/destination/payload/effect/actor。固定actor为`service:operations`。
  - replay只把exact open dead letter置`replay_requested`、写唯一immutable replay并把原outbox恢复pending/清过期lease；不复制outbox或payload。下个relay仍进入原destination processor，重新核对Run/Plan/approval并先走外部reconciliation。三次相同API请求返回一个replay ID；三条重复Queue消息只有第一条取得D1 lease/effect，其余读取settled。outbox settled后scheduled reconciler把相关dead letter置resolved。
  - Worker按`batch.queue`严格区分primary与DLQ；未知Queue整批ack且不路由。新增Node配置测试锁定Queue/DLQ/quarantine参数，workerd测试覆盖generic destinations并同时回归真实GitHub dispatcher、PR与test/production deployment processors。同步DOD、Architecture、Proto、Security与Reference；按用户要求未更新llmdoc。
  - 2026-07-26实读Cloudflare官方文档，确认达到consumer retry limit后消息进入DLQ、未配置DLQ会永久删除、DLQ可像普通Queue独立消费；实现与平台语义一致。
- 验证：
  - 红灯`pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/outbox-dead-letter.test.ts` → exit 1，failed suite / 0 tests，DLQ模块不存在。实现后首次suite另因测试自身对已await值错误使用`.resolves`而1/3失败；修正测试表达式后3/3通过，未把测试代码错误归为产品缺陷。
  - `pnpm exec vitest run test/outbox-dead-letter-config.test.ts` → exit 0，1 file / 1 test；锁定主Queue 3次、DLQ consumer 100次/60秒及quarantine配置。
  - 聚焦workerd `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/outbox-dead-letter.test.ts test/workflow/outbox-routing.test.ts test/workflow/workflow-outbox.test.ts test/workflow/github-dispatcher.test.ts test/workflow/github-pull-request.test.ts test/workflow/test-deployment.test.ts test/workflow/production-deployment.test.ts` → exit 0，7 files / 47 tests；覆盖DLQ全链及相邻真实producer fencing/reconciliation。
  - 首次`pnpm run typecheck`因同一毒丸/合法混合batch的测试泛型被首项收窄而exit 2；显式建模body为unknown后typecheck通过。随后lint因遗留未使用type import exit 1，删除后`pnpm run typecheck`与`pnpm run lint`均exit 0。
  - `curl -fsSL --max-time 20 https://developers.cloudflare.com/queues/configuration/dead-letter-queues/ ...` → exit 0；官方页面说明与实现的retry limit/DLQ消费边界一致。
  - `pnpm run verify` → exit 0；typecheck、ESLint、Node 42 files / 135 tests、workerd 43 files / 233 tests、209个生产文件Secret scan和Markdown links全绿。
  - `pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round62-20260726-final` → exit 0；双Queue consumer、Cron、Workflow/D1/双R2 bindings及新增migration/store/API成功bundle，未部署。
  - `git diff --check` → exit 0。
- 勾选：Phase 6 outbox/queue dead-letter DoD完整勾选；可重跑配置和workerd故障注入已证明3次replay/Queue重投不重复dispatch、PR或deployment，merge既无outbox/effect入口也无新增ledger。真实远端Queue创建与平台消息事实仍属于最终部署/试运行外部证据，不能用dry-run冒充。
- 决策沉淀：DLQ不是第二套业务队列或payload仓库，只是冻结原outbox的durable运营状态；重放必须恢复原identity并重新经过全部authorization/reconciliation，不能让管理员选择effect。只配置平台DLQ但不消费会得到“可见但不可恢复”的堆积；反之消费后未先持久化就ack会永久丢失，因此D1 capture必须先于ack。DLQ consumer本身也需要quarantine，避免数据库长故障最终删除证据。
- 遗留：下一轮处理Phase 6“reconciliation定期从GitHub/飞书核对外部事实，修复回调丢失但外部已成功”；需要审计现有各自reconciler覆盖矩阵，并补统一调度/结果ledger和飞书漏回调恢复缺口。

## Round 63 — 2026-07-26
- 目标：Phase 6 / reconciliation定期从GitHub/飞书核对外部事实，修复“回调丢失但外部已成功”的状态。
- 前置与权限：仅本地Node/workerd/D1、fake GitHub/Feishu REST与官方文档只读访问；未调用真实GitHub/飞书写API，未访问真实repository/tenant/chat、Cloudflare远端、云账户、日志、数据库、tool-bridge或计费模型，未部署、未使用真实Secret。按用户要求固定核对Watt commit`476e3cd`，全库检索Deployments status、external reconciliation和飞书message GET/mget；Watt只有发送adapter及Workflow checkpoint/wait，没有可直接复制的等价业务实现，本轮Watt业务代码直接复制量为零。继续复用此前直接迁入的`memoryTokenCache`、token失效码、create UUID和fenced outbox；GitHub test adapter逐结构复用本项目production status adapter。
- 动作：
  - 先审计每分钟scheduled矩阵：既有GitHub Actions run、PR、merge gate/status、base、production deployment、acceptance/rollback均有API补偿；缺口是test deployment只有signed webhook projector、飞书只有D1→card producer而没有message外部事实回读。先写REST解析、20路missed-callback收敛、lost PATCH response、Cron接线、read/write token隔离和raw canary测试。
  - 红灯Node `pnpm exec vitest run test/github-test-deployment-status-api.test.ts test/feishu-delivery-card.test.ts` → exit 1，GitHub reconciler模块不存在且`getCardMessage`不存在；workerd `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/test-deployment.test.ts test/workflow/feishu-delivery-card.test.ts` → exit 1，两个新增reconciler模块均不存在，证明此前test deployment webhook丢失与飞书PATCH结果丢失没有恢复入口。
  - migration 0038新增`github_test_deployment_status_observations`与`feishu_delivery_card_observations`。两者只保存source、canonical fact/card digest、外部identity/time、applied/ignored和固定reason，不保存GitHub REST body、飞书卡片正文/`msg`、token或网络错误；identity字段trigger不可改写。
  - 新增`GitHubTestDeploymentStatusApiClient/Reconciler`：使用独立于`deployments:write` effect cache的`deployments:read` token，先GET exact Deployment核对repository、numeric ID、ref SHA、`delivery-loop:test`、`test`与reference-only control-plane deployment ID，再GET最多100条status并按`updated_at`选真正最新一条。pending/queued不会借旧success推进；API与webhook共用`GitHubTestDeploymentStatusStore`单调projector、OIDC门槛、Evidence verifier和终态CAS。
  - 扩展`FeishuDeliveryCardApiClient.getCardMessage`，调用官方`GET /open-apis/im/v1/messages/:message_id?card_msg_content_type=user_card_content`。raw body只在内存解析，输出被收窄为message/chat/sender app/tenant/create/update/deleted/msg type与card digest。`FeishuDeliveryCardMessageReconciler`只扫描已有active message ID且latest presentation未delivery的原outbox；exact tenant/chat/app/message、interactive、未删除和latest renderer digest全部相同才写immutable observation/delivery并settle原outbox。20路重放只形成一条applied observation，错误binding/content不覆盖状态。
  - 首次POST若外部成功但响应在message ID落D1前丢失，message GET没有安全发现键；本轮明确只依赖飞书最长1小时稳定UUID重试，不通过群历史或相似正文猜测认领消息。已知message ID的PATCH响应丢失则由每分钟GET可靠收敛。该边界同步写入DOD/Architecture/Proto/Security/Reference。
  - `reconcileTestDeploymentsFromEnv`与`reconcileFeishuDeliveryCardsFromEnv`分别并行运行原调度/projector和新增外部事实reconciler，现有Worker每分钟Cron无需第二套调度器。配置测试同时锁定`* * * * *`、Worker调用点及两个runtime `reconcileBatch(25)`接线。
  - 按`lark-openapi-explorer`流程先运行`lark-cli im --help`和`+messages-mget --help/--dry-run`确认CLI已有只读能力，再从官方`llms.txt → llms-messaging.txt → message/get.md`逐层实读完整规范；没有调用真实tenant API。官方要求机器人在群内，应用身份群消息需`im:message`或`im:message:readonly`并附加`im:message.group_msg`，限流1000次/分钟且50 QPS。
- 验证：
  - 聚焦Node `pnpm exec vitest run test/external-fact-reconciliation-config.test.ts test/github-app-installation-token.test.ts test/github-test-deployment-status-api.test.ts test/feishu-delivery-card.test.ts` → exit 0，4 files / 22 tests；覆盖Cron接线、read/write token cache隔离、GitHub exact/latest解析、飞书digest-only GET和raw错误脱敏。
  - 聚焦workerd `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/test-deployment.test.ts test/workflow/feishu-delivery-card.test.ts test/workflow/outbox-routing.test.ts` → exit 0，3 files / 16 tests；覆盖missed deployment webhook、lost PATCH response、20路D1收敛及runtime相邻回归。tenant exact binding补强后再次运行两个核心suite → exit 0，2 files / 11 tests。
  - 首次`pnpm run typecheck`因测试fake的`deleted:false`被推断为boolean而exit 2，收窄字面量后通过；首次lint因新增但未使用的message ID pattern exit 1，将其接入外部fact校验后`pnpm run typecheck`与`pnpm run lint`均exit 0。
  - `curl -fsSL https://open.feishu.cn/document/server-docs/im-v1/message/get.md | rg ...` → exit 0；核实GET路径、权限、50 QPS/1000次每分钟和`user_card_content`原卡返回语义。
  - `pnpm run verify` → exit 0；typecheck、ESLint、Node 44 files / 140 tests、workerd 43 files / 235 tests、212个生产文件Secret scan和Markdown links全绿。
  - `pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round63-20260726-final` → exit 0；每分钟Cron、Workflow/Queue/D1/双R2 bindings及migration 0038/新增adapter成功bundle，未部署。
  - `git diff --check` → exit 0。
- 勾选：Phase 6 GitHub/飞书定期external-fact reconciliation DoD完整勾选；本地故障注入已证明test deployment webhook丢失后API success推进同一Evidence路径，以及飞书已知message PATCH结果丢失后GET exact card收敛原outbox。真实GitHub repo/Feishu tenant事实仍由Phase 5外部试点子项独立验收，未用fake或dry-run冒充。
- 决策沉淀：reconciliation不是第二套状态机或effect producer；它只把外部已存在且完成exact binding的事实送回原projector/原outbox。GitHub effect/read token必须隔离；飞书正文可以在内存做digest比较，但不能落D1。没有稳定外部identity时宁可继续幂等重试或人工处理，也不能模糊搜索后认领“看起来像”的资源。
- 遗留：下一轮处理Phase 6“reconciliation同时核对active Cloudflare Workflow与D1 Run投影”；需要定义Workflow complete/terminated/unknown与D1 active/terminal的双向不一致矩阵、只读平台adapter、durable observation及允许的审计修复动作。

## Round 64 — 2026-07-26
- 目标：Phase 6 / reconciliation同时核对active Cloudflare Workflow与D1 Run投影；Workflow已完成/终止、D1仍active或反向不一致时可审计修复。
- 前置与权限：仅本地Node/workerd/D1、fake Workflow binding与Cloudflare官方文档只读访问；未调用Cloudflare远端Workflow API，未创建/重启/终止真实实例，未访问GitHub、飞书、云账户、日志、数据库、tool-bridge或计费模型，未部署、未使用真实Secret。按用户要求固定核对Watt commit`476e3cd`，完整读取`task-store.ts`、`task-manager.ts`、`watt-task-workflow.ts`及对应测试；复用`taskId=instanceId`、D1业务真源、terminal terminate幂等、stable waitForEvent与test dispose纪律。Watt没有双向status矩阵、durable mismatch/fair cursor或fenced repair，业务代码直接复制量为零，未虚构复用。
- 动作：
  - 先从DOD原文推导状态矩阵，并用官方Markdown与锁定`@cloudflare/workers-types@4.20260702.1`双重核实platform枚举。D1除blocked/failed/succeeded/cancelled外都要求control Workflow active；platform queued/running/paused/waiting/waitingForPause视为active，complete/errored/terminated为terminal，unknown为实例不可确认。
  - 先写status adapter脱敏、三向不一致、20路scan/processor、stale Run fencing、recreate/restart/terminate effect、controlled replay让路、公平cursor、Cron接线和Task安全查询测试。红灯Node `pnpm exec vitest run test/cloudflare-workflow-status-client.test.ts test/external-fact-reconciliation-config.test.ts` → exit 1，reconciler模块与Cron调用不存在；workerd `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/workflow-instance-reconciler.test.ts` → exit 1，missing module / 0 tests。
  - migration 0039新增`workflow_instance_reconciliation_state`与immutable `workflow_instance_reconciliation_observations`。latest state只保存Run version/state、官方platform enum、fact digest/check time；observation只保存固定action/open/resolved、repair outbox和时间。没有Workflow output、error name/message、stack、异常正文、token或平台response；batch按最久未检查排序，25条limit不会永久饿死后续Run。
  - `CloudflareWorkflowStatusClient`只投影官方status，`.get/status`异常统一收窄为unknown。`WorkflowInstanceReconciler`每分钟执行：D1 active+platform terminal写`workflow_reconcile_restart`，D1 active+unknown写同ID `workflow_reconcile_create`，D1 inactive+platform active写`workflow_reconcile_terminate`。关系一致时结案open observation；Run version前进以`run_advanced`结案旧记录；pending controlled replay时自动create/restart不抢terminal instance。
  - 三类repair都进入现有`cloudflare_workflows` FencedOutboxProcessor。processor从reference-only observation重新绑定原outbox、Run state/version与active/inactive关系，stale/resolved安全settle且零effect。create复用run ID，restart先把已active视为existing，terminate把unknown/terminal视为已收敛；外部effect后D1写失败仍可安全重放。20路scan和Queue消费只产生一条observation/outbox/effect。
  - 审计发现原`DeliveryRunWorkflow`在Plan激活后立即complete；直接上线reconciler会把正常active Run误判为restart。先修改真实Workflow测试，首次聚焦suite按预期exit 1并显示platform `complete`。实现改为Plan激活后进入固定`await-run-terminal`、最长365天的durable wait；waiting不占active concurrency。D1已inactive时Workflow直接正常结束；active Run重建/重启时`register-run`接受exact persisted binding，有active Plan则跳过analysis并恢复control wait。终态event仍需从D1重新确认，不能自报业务成功。
  - Worker scheduled顺序改为watchdog→Workflow status reconciliation→relay与其余外部reconciliation，使本轮新repair outbox可被同一Cron relay。Task与Run Plan查询增加latest Workflow status/fact digest/check time及最近20条mismatch/action/outbox/repair/resolution；不返回engine error/output。同步DOD、Architecture、Proto、Security、Reference；按用户要求未更新llmdoc。
  - 实读Cloudflare官方Workers API、events/parameters与limits：`get(id)`不存在会抛错，`status()`给出九态；waitForEvent timeout允许1秒～365天，waiting不计active concurrency；完成实例history Free仅3天、Paid 30天。因此长期审计以D1 ledger为准，不能依赖平台terminal history永久存在。
- 验证：
  - 长期wait红灯`pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/delivery-run-workflow.test.ts` → exit 1，Plan激活后实际platform status为`complete`而非active；实现后同命令exit 0，1 file / 1 test。
  - 聚焦Node `pnpm exec vitest run test/cloudflare-workflow-status-client.test.ts test/external-fact-reconciliation-config.test.ts` → exit 0，2 files / 4 tests；覆盖status/error/output脱敏、terminal-only restart/active retry和Cron接线。
  - 聚焦workerd `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/workflow-instance-reconciler.test.ts test/workflow/task-query-api.test.ts test/workflow/delivery-run-workflow.test.ts test/workflow/workflow-callback.test.ts test/workflow/controlled-replay.test.ts test/workflow/workflow-outbox.test.ts` → exit 0，6 files / 22 tests；覆盖三向矩阵、20路effect收敛、公平cursor、controlled replay、长期wait、callback/replay/outbox相邻回归。显式terminate清理waiting测试实例时workerd打印预期`User called terminate`终止信息，suite无未解释失败。
  - `pnpm run typecheck`与`pnpm run lint` → exit 0。
  - 官方文档`curl .../workers-api/index.md|events-and-parameters/index.md|limits/index.md | rg ...` → exit 0；核实status九态、get/create identity、365天timeout、waiting concurrency与3/30天retention。
  - 首次`pnpm run verify` → exit 1：Node 45 files / 143 tests全绿，workerd 43 files全绿，仅未修改的`execution-attempt-api`第44个文件20路HTTP状态断言一次波动；立即单独`pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/execution-attempt-api.test.ts --reporter=verbose` → exit 0，2/2。未修改产品代码或放宽断言，第二次完整verify通过。
  - 最终`pnpm run verify` → exit 0；typecheck、ESLint、Node 45 files / 143 tests、workerd 44 files / 241 tests、214个生产文件Secret scan和Markdown links全绿。
  - `pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round64-20260726-final` → exit 0；每分钟Cron、Workflow/Queue/D1/双R2 bindings及migration 0039/新增reconciler成功bundle，未部署。
  - `git diff --check` → exit 0。
- 勾选：Phase 6 Cloudflare Workflow↔D1双向reconciliation DoD完整勾选；可重跑故障矩阵证明complete/errored/terminated/unknown与反向active不一致都有durable、fenced、可查询的修复路径。本地binding/fake status不能证明真实Cloudflare账户状态和长时间运行，远端证据继续由部署/连续试运行DoD独立验收。
- 决策沉淀：Workflow status只能决定控制流修复，不能覆盖D1业务状态。长期会话通过waiting保持active，但业务终态仍只来自D1的审批/Evidence/platform projector；reconciliation create/restart/terminate不重放Agent隐藏状态、token、lease、approval或GitHub/飞书/deployment effect。平台history最多30天，因此审计长期真源必须是D1 observation而非Workflow dashboard。
- 遗留：下一轮处理Phase 6“每tenant/repo/user/run有并发、attempt、token、模型费用和tool调用限额；P0 override仍需审计”；需要先盘点已有Attempt/retry/token/tool trace/usage原语，定义多维原子reserve/release与P0人工override边界。

## Round 65 — 2026-07-26
- 目标：Phase 6 / 每tenant/repo/user/run有并发、attempt、token、模型费用和tool调用限额；P0 override仍需审计。
- 前置与权限：仅本地Node/workerd/D1/fake GitHub effect、锁定Codex JSONL契约与OpenAI官方文档只读核对；未调用真实Codex计费模型，未访问真实GitHub/飞书/Cloudflare远端、云账户、日志、数据库或tool-bridge，未部署、未使用真实Secret。按用户要求固定读取Watt`/Users/jishihe/tokenrollal/Watt@476e3cdd2490d725fde174e7c697ebf00899edc6`的usage migration/store、Agent/LLM/Anthropic caller及usage/observability测试；直接迁移“一次真实模型调用一行usage”的schema/store结构、input/output token+可选费用append-only记账和重试/多步调用不遗漏usage的测试纪律。Watt没有四scope quota、reservation或P0 override，未虚构复用。
- 动作：
  - migration 0040新增tenant/repository/user/run四scope与`concurrency/attempt/model_tokens/model_cost_microusd/tool_call`五资源。exact policy优先wildcard；tenant/repository/user非并发按UTC日，run按生命周期，并发即时，共20条有限默认policy。`quota_run_scopes/effective_policies`是统一D1投影；Attempt `BEFORE INSERT` trigger覆盖全部现有及未来producer，stable attempt ID重放不重复计数。
  - 并发使用stable Attempt reservation，analysis/execution dispatch、test deployment、acceptance、rollback及production deployment都在真实GitHub effect前原子reserve。release后的同Attempt retry重新通过所有scope并re-arm；terminal/TTL由Cron reconcile。审计发现外部timeout可能已成功，五个producer改为ambiguous结果不提前release，直到stable reconciliation、Attempt终态或TTL，避免短暂低估真实Action。
  - tool endpoint在upstream调用前使用控制面生成trace ID和接收时间admit；超额写metadata-only denial。模型在Codex进程前按D1 model profile最大input/output与最坏uncached价格同时预留token和micro-USD，完成后按cached/uncached/output实际用量结算。profile identity/model/上界/价格immutable且cached价格不得高于uncached；改价新增profile ID，旧profile只可disable，不能在调用中途重定价。
  - `codex exec --json` stdout改为逐行stream且不保留；只投影官方单个`turn.completed.usage`的input/cached input/output/reasoning output四个整数，thread/item/message/reasoning/command/tool/file/web/plan事件立即丢弃。analysis/execution Runner预留后才调用Codex，合法usage入账后才继续；raw JSONL、Agent output、prompt和tool内容不进D1/log/artifact。
  - 模型API body移除Runner自报`occurredAt`，UTC窗口、reservation TTL、override expiry和usage at统一使用控制面接收时间；usage idempotency digest只绑定稳定reservation/usage/Attempt和四个计数。active reservation允许网络重试，settled/expired相同ID固定409，防止二次真实调用；没有合法usage不能记成零费用成功。
  - P0 priority本身不扩容。新增独立quota override source/outcome：只有approval adapter的验签GitHub/飞书source经channel映射为非Task requester的`human + approve:quota_override`，且exact Run version、资源集合、reason digest、future expiry≤4小时命中，才固定提升指定资源2倍。self、agent/service、缺role、未映射、跨tenant/repository、non-P0和stale version均identity rejection入账或fail-closed；source/outcome immutable。
  - Task/Run安全查询增加20条effective limit、最近20条override/denial/per-call usage；不返回scope key、prompt/model response、tool参数/result、credential或raw error。Attempt trigger用`RAISE(ABORT)`拒绝，SQLite会回滚同事务，因此该类拒绝只有固定`quota_attempt_exceeded`，未伪称写入`quota_denials`；并发/model/tool denial才有durable ledger。
  - GitHub workflow与dispatch增加可信`model_profile_id`，Worker运行配置需提供`CODEX_MODEL_PROFILE_ID`；Agent只能使用reservation响应返回的model，价格/上界不从Task或Agent自报。Worker scheduled接入quota reconciliation。同步DOD、Architecture、Proto、Security、Reference；按用户要求未更新llmdoc。
- 验证：
  - 初始红灯`pnpm exec vitest run test/codex-usage.test.ts` → exit 1，module不存在；`pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/quota-control.test.ts` → exit 1，quota domain不存在。固定workflow新增profile input后`pnpm exec vitest run test/delivery-agent-workflow.test.ts`首次按预期失败，更新可信input契约后通过。
  - 补强红灯quota suite → exit 1，12项中3项失败：released reservation未re-arm、settled model reservation仍可返回existing、API接受Runner旧时间；实现后12/12通过。GitHub ambiguous response占位测试首次exit 1并显示`effect_failed`已释放，修改五个producer后`github-dispatcher`6/6通过。immutable/worst-case profile测试首次exit 1，migration约束后quota suite最终1 file / 13 tests通过。
  - 跨scope用例实际证明tenant concurrency、repository tool call、user model token、tenant/repository model cost跨Run累计；Attempt资源循环覆盖四scope，20条policy覆盖完整4×5矩阵。20路并发只admit一个slot，P0 positive及self/service/unauthorized/wrong-tenant/stale negative、API fencing、安全query和raw canary均通过。
  - Node聚焦`codex-usage/codex-analysis-adapter/codex-execution-adapter/analysis-runner-bootstrap/execution-runner-bootstrap` → exit 0，5 files / 19 tests；workerd配额及相邻Task/GitHub deployment/acceptance/rollback/tool suites → exit 0，8 files / 73 tests；`typecheck`与最终`lint`均exit 0。
  - 首次完整`pnpm run verify` → exit 1：Node 46 files / 146 tests全绿；workerd仅旧安全断言把新增合法枚举`model_tokens`误判为credential。断言收窄到真实敏感字段`attemptToken/toolBridgeToken/tokenDigest/oidcToken/stack/raw error`后聚焦17/17通过，未移除Secret检查。后续两次完整verify均只在Round 64已记录的`execution-attempt-api`20路状态断言波动；单独verbose 2/2、完整workflow 45 files / 254 tests通过，保持200/201原判据并把失败输出改为具体unexpected status数组，未修改产品语义或放宽状态码。
  - 最终`pnpm run verify` → exit 0；typecheck、ESLint、Node 46 files / 146 tests、workerd 45 files / 254 tests、219个生产文件Secret scan和Markdown links全绿。Workflow测试清理waiting实例时仍打印预期`User called terminate`，无失败suite。
  - 首次`pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round65-20260726-final`完成2235.92 KiB/gzip 368.83 KiB bundle并打印`--dry-run: exiting now`，但父进程未退出，人工终止exit 130，不能算成功证据。`CI=1 WRANGLER_SEND_METRICS=false pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round65-20260726-final-retry` → exit 0；Workflow/Queue/D1/双R2 bindings、migration 0040及新增quota/usage代码成功bundle，未部署。
  - `git diff --check` → exit 0。
- 勾选：Phase 6多维成本/速率限制DoD完整勾选；可重跑D1/HTTP/Runner/GitHub effect测试证明四scope五资源、调用前原子admission、结算、恢复、P0人工override和安全查询。模型费用来自测试profile/fake JSONL，不能冒充真实Codex账单或Cloudflare/GitHub平台并发事实；本项验收的是控制面强制契约，不扩张其他真实试点DoD。
- 决策沉淀：D1是quota policy/reservation/usage/override真源，GitHub Actions concurrency与供应商账单是外部核对层；先按最大值reserve再按真实usage settle，失败时宁可短时保守占用也不能在外部effect不确定时低估。P0只能有限、限时、独立人审，不能变成priority隐式无限预算。Watt usage结构可直接复用，多维限额和身份override必须由delivery-loop新增；Codex事件契约来自官方文档，模型价格必须由版本化运维profile配置而不是代码猜测。
- 遗留：下一轮只处理Phase 6“D1/R2备份恢复演练后，Task/Run/Plan/Approval/Evidence/Audit一致，active token全部强制撤销后再恢复；Cloudflare已完成Workflow超过30天仍可审计”。需要先定义备份manifest/digest、一致性快照边界、restore generation/token全撤销和长期Workflow-independent audit校验；不能用本地文件复制冒充真实远端备份演练。

## Round 66 — 2026-07-26
- 目标：Phase 6 / D1/R2备份恢复后Task/Run/Plan/Approval/Evidence/Audit一致，active token及外部write credential撤销后才恢复服务；已完成Workflow超过30天仍可审计。
- 前置与权限：仅本地Node/workerd/D1/三个Miniflare R2 bucket、fake Cloudflare export响应和fake GitHub credential provider；未访问真实Cloudflare/GitHub/飞书/数据库/日志/tool-bridge，未部署、未执行远端D1 Time Travel/import/export、未使用真实Secret。固定检索Watt`/Users/jishihe/tokenrollal/Watt@476e3cdd2490d725fde174e7c697ebf00899edc6`的D1/R2/Workflow/audit实现；没有D1 export、R2 backup/versioning、restore fence或token-safe一致恢复模块可直接复制，业务代码直接复制量为零。最大化复用既有Watt-derived稳定Workflow step、D1条件batch、immutable audit/fenced outbox纪律及项目现成`RepoWriteCredentialRevoker`，未虚构来源。
- 动作：
  - 先写D1官方export adapter、双R2备份/篡改、20路restore/token撤销/31天审计测试。三条初始红灯分别因`d1-export-client`、`backup-recovery`、`backup-restore-store`不存在而exit 1，证明此前没有对应生产路径。
  - 实读Cloudflare官方D1 Time Travel、import/export和Workflow backup示例：production自动开启Time Travel；Free 7天、Paid 30天；restore为取消在途请求的destructive in-place；超过30天需D1 export到R2。实现官方`output_format=polling → at_bookmark → current_bookmark → signed_url`，signed URL只活在单个step callback内，下载请求不携带Cloudflare API Authorization。
  - 新增第三个私有`BACKUP_OBJECTS`及scheduled`ControlPlaneBackupWorkflow`。D1 SQL dump流式写入；`TASK_OBJECTS/CHECKPOINT_OBJECTS`逐对象复制并保存content SHA-256、size、etag、content-type和有序custom metadata descriptor；descriptor set和manifest均canonical digest。workerd没有Node类型声明中的`DigestStream`，未退化为全量内存buffer，改为依赖零、可增量的SHA-256并用标准空串和跨chunk向量核对。
  - migration 0041新增immutable `backup_snapshots`、全局`control_plane_recovery_state`、`restore_drills/run_fences/token_revocations/consistency_checks`及D1→R2引用view。Task/checkpoint/review/context producer均先发布immutable R2再提交D1 ref，所以export后复制R2是安全superset；不假设R2自动versioning。
  - restore strict输入只有restore/backup ID与manifest digest。manifest/dump验证前零fence；合法首请求用一个D1 batch前进generation一次，将active Attempt置lost且generation+1，撤销未过期attempt/tool token，阻断Run/Plan/Item，清delivering outbox和quota lease，把GitHub credential转`revocation_pending`并留下immutable audit。20路相同请求一份状态迁移；旧Attempt token HTTP返回401。
  - 全局serving fence接入Worker：restoring期间普通HTTP 503、Queue只retry、Cron仅允许运行既有GitHub credential revoker；health和operations备份/恢复接口保持可用。revoker解密并撤销测试中的exact GitHub token后，complete才检查D1 dump、descriptor、恢复对象content/metadata、全部D1 R2 ref、FK和Task/Run/Plan/Approval/Evidence/Audit/token九类判据；缺对象或pending credential保持restoring。
  - `GET /v1/backups`、`POST /v1/restores/:id/fence|complete`、`GET /v1/restores/:id`只接受`OPERATIONS_TOKEN`，unknown query/body key拒绝，不接受SQL/R2 key/token/state/effect。31天old Run审计只联合D1 Task/Run/active Plan、Approval/Evidence计数与`workflow_instance_reconciliation_state`，不调用Workflow history。
  - 同步DOD、Architecture、Proto、Security、Reference；记录D1 7/30天、官方polling、R2无versioning假设、R2-before-D1 ref、先撤权后ready和>30天D1审计边界。按用户要求未更新llmdoc。
- 验证：
  - 红灯`pnpm exec vitest run test/d1-backup-export.test.ts`、`pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/backup-r2.test.ts`、`... backup-restore.test.ts`分别exit 1，均为目标模块不存在；首次`pnpm run typecheck`另以`crypto.DigestStream`类型不存在exit 2。改成全局声明后类型通过但workerd实际`DigestStream is not defined`，据此实现增量SHA-256而非掩盖运行时差异。
  - 聚焦Node `test/d1-backup-export.test.ts + test/incremental-sha256.test.ts` → exit 0，2 files / 3 tests；覆盖官方API/header/body、signed URL隔离/下载、raw error收窄、unfinished/insecure URL及标准流式digest。
  - 聚焦workerd `backup-api + backup-r2 + backup-restore` → exit 0，3 files / 5 tests；覆盖三bucket复制/删除后恢复/篡改、strict operations API/503 fence、20路generation、旧token 401、exact GitHub token撤销、九类检查、缺对象/pending credential和31天D1-only audit。
  - `pnpm run verify` → exit 0；typecheck、ESLint、Node 48 files / 149 tests、workerd 48 files / 259 tests、227个生产文件Secret scan和Markdown links全绿。waiting Workflow清理仍打印已有预期`User called terminate`信息，无失败suite。
  - 首次准备dry-run时包含删除旧`/tmp`目录的命令被工具删除策略拒绝，未发生删除；改用新空目录后`CI=1 WRANGLER_SEND_METRICS=false pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round66-20260726-final-v2` → exit 0，两个Workflow、Queue、D1及Task/Checkpoint/Backup三R2 binding成功bundle，未部署。
  - `git diff --check` → exit 0。
- 勾选：Phase 6 D1/R2备份恢复DoD完整勾选。可重跑本地workerd演练证明manifest/content fencing、token/credential撤销、业务隔离、一致性和长期审计契约；dry-run只证明可打包，不能冒充真实Cloudflare远端Time Travel/SQL import、实际bucket retention或灾备RTO证据。
- 决策沉淀：D1 export/import成功不等于控制面可服务；恢复后的token digest/加密credential ciphertext必须视为潜在active authority，先全局隔离和撤权，再检查业务lineage/R2/FK，最后ready。Workflow history是短期控制流诊断面，超过30天审计必须直接来自D1 ledger。backup manifest不含正文/Secret/signed URL，R2完整性由应用descriptor证明而不是猜测平台versioning。Watt没有等价模块时，最大化复用应落在已验证的Workflow/条件写/outbox/revoker原语，不能复制不匹配代码或倒称新增能力为Watt所有。
- 遗留：下一轮只处理Phase 6“审计查询能在5分钟内回答Case 8，结果含digest/链接且不暴露Secret”。先定位Case 8问题集和现有Task/Run/correlation投影，定义一键查询/导出与时间预算；不得把本轮`auditLongTermRun`窄查询冒充Case 8完整审计报告。真实Cloudflare远端restore仍可在获授权试点/连续运行阶段补充，但不回写成当前本地证据。

## Round 67 — 2026-07-26
- 目标：Phase 6 / 审计查询能在5分钟内回答Case 8“谁基于哪个事件、以什么权限、读取了哪些类别上下文、改了什么、哪些检查通过、谁批准、部署到哪里”，结果含digest/链接且不暴露Secret。
- 前置与权限：仅本地workerd/D1、20路HTTP并发和安全canary；未访问真实Cloudflare/GitHub/飞书/日志/数据库/tool-bridge，未读取R2正文、未部署、未使用真实Secret。固定读取Watt`/Users/jishihe/tokenrollal/Watt@476e3cdd2490d725fde174e7c697ebf00899edc6`的`migrations-audit/0001_audit_records.sql`、`src/audit/audit-store.ts`、platform audit route、CLI audit list和E2E-4 allow/deny断言；直接适配每次真实读取UUID/time/principal/digest入账、D1 prepare+bind、strict limit和“查询本身也审计”的实现骨架。Watt generic CallContext JSON不能表达本项目Plan/Evidence/commit/deployment lineage，未复制为错误报告模型。
- 动作：
  - 从Vision Case 8原文拆成八个不可省略的answer key：`who/sourceEvents/permissions/contextReads/changes/checks/approvals/deployments`。确认已有`GET /v1/correlations`只能定位Run及安全外部ID，Round 66 `auditLongTermRun`只有Task/Plan digest与审批/Evidence计数，两者都不足以回答Case 8。
  - 先写完整Run fixture、operations授权/未知参数、八栏字段、digest/净化链接、Secret负向、20路稳定digest/access ledger、缺Run、非法scope和五分钟server budget测试。首次聚焦执行因`case8-audit-report-store`不存在而failed suite/0 tests，证明此前无一键报告。
  - migration 0042新增immutable`case8_audit_report_accesses`，每次成功查询只保存Run、固定`service:operations`、report digest、answer count=8、duration和时间；不复制报告JSON、链接、正文或credential。把backup/dead-letter重复的operations Bearer常量时间比较收敛到共享helper，现有授权语义不变。
  - 新增D1-only`Case8AuditReportStore`，最大化复用现有Watt-derived `CorrelationQueryStore`的Run/GitHub/trace关联，再并行读取Task/Plan revision/effect、Attempt grant/write credential状态、tool trace、head/protected diff/PR/merge、verification/Evidence/GitHub checks、identity approval与test/production deployment authoritative ledger。每栏最多500，超限拒绝而非截断成伪完整答案。
  - permissions只返回scope名称/expiry/revocation、Plan effect和credential状态/binding，不选择任何token/OIDC/tool digest或ciphertext。历史合法scope子集按控制面顺序允许；插入`repo:write`等非attempt allowlist值会让整份报告projection conflict。context只把Runner checkout和trusted tool path聚合为repository/logs/traces/k8s/database类别与计数，不输出参数/result/error。
  - changes只给commit parent/head/branch/Evidence、protected diff/tree/policy digest/计数、PR body digest/链接及merge SHA/actor，不给patch/正文；checks只给command ref/status/policy/evidence-set/fact digest及Evidence白名单，不给summary/log/artifact正文；approval不输出nonce/request digest或按钮payload；deployment给environment/role/SHA/status/Plan digest/approval/Evidence/净化链接。
  - `reportDigest`覆盖完整安全body但排除generatedAt、duration和access row，因此同一D1业务状态20路读取一致；response带`Server-Timing`且服务端单调计时达到300000ms固定timeout。structured log只有Run、report digest、duration和各栏count。API只接受`OPERATIONS_TOKEN + Run ID`，全部query key拒绝并`no-store`。
  - 初次实现后的真实SQL聚焦测试暴露`invalidated_approvals`只投影`approval_id`、没有`invalidated_at`；未吞掉异常，改为安全boolean并保留具体红灯。同步Architecture、Proto、Security、Reference与DOD；按用户要求未更新llmdoc。
- 验证：
  - 红灯`pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/case8-audit-report.test.ts` → exit 1，failed suite / 0 tests，目标store模块不存在。
  - 首次实现后同命令 → exit 1，2/2失败；HTTP为500且直调明确`no such column: invalidated.invalidated_at`。核对view真实schema并改用`approval_id IS NOT NULL`后，同命令 → exit 0，1 file / 2 tests。
  - 聚焦相邻回归`case8-audit-report + correlation-query + outbox-dead-letter + backup-api + task-query-api` → exit 0，5 files / 12 tests；typecheck与ESLint均exit 0。
  - Case 8测试实际执行20路operations GET，八栏完整、report digest唯一、20条immutable access、净化source/check/deployment链接、服务端duration<300000ms；Task title/Plan objective/doneWhen/Evidence summary及URL query中的同一Secret canary、三种token/OIDC/tool digest和nonce字样均不在report/log。非法`repo:write` grant、未知query、无权限、缺Run与模拟300001ms均拒绝且无成功access。
  - `pnpm run verify` → exit 0；typecheck、ESLint、Node 48 files / 149 tests、workerd 49 files / 261 tests、232个生产文件Secret scan和Markdown links全绿。waiting Workflow清理仍打印已有预期`User called terminate`信息，无失败suite。
  - `CI=1 WRANGLER_SEND_METRICS=false pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round67-20260726-final` → exit 0；两个Workflow、Queue、D1、三R2 binding及新增audit migration/store/API成功bundle，未部署。
  - `git diff --check` → exit 0。
- 勾选：Phase 6 Case 8审计查询DoD完整勾选。可重跑本地D1/workerd证明一键八栏答案、稳定digest、链接净化、五分钟预算、读取审计及Secret物理排除；本地fake URL和elapsed不冒充真实平台日志索引、外部GitHub/飞书/云审计事实，后者继续由correlation真实平台子项和最终E2E验收。
- 决策沉淀：Case 8不是“把所有日志导出”，而是从各事实真源生成最小、可核对、可digest的权限与交付证明。报告不能复制Task/Evidence正文，也不能只给计数；必须给actor/event/scope/effect/commit/check/approval/environment的exact lineage。报告digest与访问审计分离，才能让并发读稳定同时证明谁读过。Watt的通用审计store适合直接复用访问入账骨架，但业务报告必须join delivery-loop规范化ledger；复制CallContext JSON会产生第二真源且丢失交付语义。
- 遗留：下一轮只处理Phase 6“数据保留任务按Security约定清除原始session、保留结构化证据并记录删除审计”。先盘点当前实际存在的R2正文/session/transcript producer与保留要求，定义dry-run/批次/cursor、引用保护和immutable deletion ledger；不能删除Task/checkpoint/Evidence结构化投影或用测试bucket清空冒充生产retention。

## Round 68 — 2026-07-26
- 目标：Phase 6 / 数据保留任务按Security约定删除到期raw Agent session/transcript，保留Task/checkpoint/Evidence/backup结构化事实，并留下无正文删除审计。
- 前置与权限：仅本地Node/workerd/D1/四个Miniflare R2 bucket与Wrangler dry-run；未访问真实Cloudflare/GitHub/飞书/数据库/日志/tool-bridge，未部署、未删除用户文件或远端对象、未使用真实Secret。权威盘点确认当前Codex adapter固定`--ephemeral`且不导出raw session/transcript，现有R2 producer只有Task/review/context、checkpoint和backup；因此本轮没有把这些对象假装成raw，也没有用测试bucket全清空冒充production retention。
- Watt复用：固定读取`/Users/jishihe/tokenrollal/Watt@476e3cdd2490d725fde174e7c697ebf00899edc6`的`packages/core/src/context/ttl.ts`及测试、`packages/gateway/src/context/context-registry.ts`和`context/providers/object.ts`。`src/retention/ttl.ts`与inclusive-boundary用例直接复制纯函数/测试结构，只适配raw 30天policy；D1领取沿用Watt条件UPDATE后`meta.changes=1`判winner和`prepare+bind`骨架。Watt的`purgeNamespace`会按prefix批量删除，无法证明本项目引用保护，故未直接复制；只把其cursor思想适配成D1显式registry与服务端exact-key推导，来源边界未虚构。
- 动作：
  - 先写dry-run/execute、Task/checkpoint/backup/Evidence保护、20路并发、metadata/存储不确定、cursor公平、strict operations API测试。首次`pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/data-retention.test.ts`按预期exit 1，failed suite / 0 tests，错误为`data-retention-store`模块不存在。
  - migration 0043新增`raw_agent_artifacts`、公平`data_retention_cursor`、scan ledger与append-only deletion audit。raw类别只有session/transcript，policy固定`security-v1-raw-30d`；registry identity/metadata不可改，deleted终态不可改，每对象只有一个completed audit。audit物理上没有object key/body/raw error列。
  - 新增专用私有`RAW_AGENT_OBJECTS`第四R2 binding，key只由category+UUID生成。未来producer必须写AES-256-GCM ciphertext metadata并显式登记；当前Codex ephemeral没有producer。`R2BackupManager`仍只接Task/checkpoint两源和专用backup目标，raw bucket明确不进入长期backup。
  - 每分钟Cron在restore serving active时固定执行25条。`expires_at + object_id`cursor尾部回绕；每对象先以5分钟D1 claim领取，20路只有一个winner可调用R2。删除前核对etag/size及schema/category/object/digest/encryption metadata，删除后再head；确认null才以D1 batch写deleted audit和终态。R2已删而D1未结算时下一轮写`already_absent`且零二次delete；ambiguous storage、metadata/policy或verification failure只写固定码并释放retry，不保存异常正文。
  - 新增`POST /v1/data-retention/scans`，只接受`OPERATIONS_TOKEN + strict {mode:dry_run|execute}`；拒绝query、bucket/key/prefix/before/limit。dry-run只计数，零claim、零cursor、零delete；execute也不能改变服务端fixed batch/time/key边界。
  - 同步Architecture、Proto、Security、Reference和DOD；记录当前无raw producer、四bucket隔离、30天policy、claim/cursor/crash recovery、audit物理字段和Watt直接复制/不复制边界。按用户要求未更新llmdoc。
- 验证：
  - 红灯`pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/data-retention.test.ts` → exit 1，目标store模块不存在；实现中首次4/4失败暴露null cursor判断，修正后新增崩溃恢复与immutable audit用例。
  - 聚焦workerd `data-retention + backup-r2 + backup-restore + backup-api` → exit 0，4 files / 10 tests；覆盖dry-run、两类到期raw、未到期raw、三结构化bucket、D1 Evidence、20路单effect、永久metadata冲突不饿死后续对象、ambiguous retry、already-absent crash recovery、strict API及备份隔离。
  - 聚焦Node `data-retention-ttl + data-retention-config` → exit 0，2 files / 5 tests；直接复用的Watt TTL在30天前/边界/边界后及undefined语义全通过，并静态证明一分钟Cron、第四bucket和backup排除接线。
  - `pnpm run verify` → exit 0；typecheck、ESLint、Node 50 files / 154 tests、workerd 50 files / 266 tests、236个生产文件Secret scan与Markdown links全绿。Workflow清理仍输出已有预期`User called terminate`信息，无失败suite。
  - `CI=1 WRANGLER_SEND_METRICS=false pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round68-20260726-final` → exit 0；bundle 2338.52 KiB / gzip 389.81 KiB，两个Workflow、Queue、D1与Task/Checkpoint/Backup/Raw-Agent四R2 binding均成功识别，未部署。
  - `git diff --check` → exit 0。
- 勾选：Phase 6数据保留DoD完整勾选。可重跑本地workerd证明显式registry raw对象的30天删除、引用保护、并发fencing、失败恢复、strict operations边界和删除审计；Wrangler dry-run只证明可打包，不冒充真实Cloudflare Cron/R2删除或组织数据保留合规证据。
- 决策沉淀：raw retention不是“按prefix扫R2再猜什么能删”，而是独立bucket、显式policy registry、exact-key推导和删除后验证；结构化D1 Evidence与恢复checkpoint必须从删除候选模型上物理排除。当前没有raw producer时应保留零对象，而不是为了展示清理能力主动持久化Codex JSONL。Watt的纯TTL/CAS原语可直接复制，其namespace purge语义不能跨业务边界照搬。
- 遗留：下一轮只处理Phase 6“运营runbook覆盖GitHub、飞书、tool-bridge、数据库、Secret泄漏和错误生产部署”。先盘点现有恢复/撤权/reconciliation/rollback入口与实际operations API，runbook必须给出触发判据、只读诊断、授权动作、回滚与证据，不得把未实现的生产操作写成可执行事实。

## Round 69 — 2026-07-26
- 目标：Phase 6 / 运营runbook覆盖GitHub故障、飞书故障、tool-bridge故障、数据库故障、Secret泄漏和错误生产部署。
- 前置与权限：仅本地源码/规范/Watt事故复盘读取、Node测试和Wrangler dry-run；未访问或修改真实Cloudflare/GitHub/飞书/tool-bridge/数据库/日志/部署环境，未发送消息、轮换Secret、取消Run、重放DLQ、恢复D1或执行production rollback。固定盘点当前所有HTTP operations/read/recovery路由及scheduled reconciliation/revoker/rollback边界，不能把文档愿望当成已实现authority。
- Watt复用：对`/Users/jishihe/tokenrollal/Watt@476e3cdd2490d725fde174e7c697ebf00899edc6`全树检索runbook/incident/outage/Secret leak/disaster/production rollback，未发现通用runbook或GitHub/D1/production处置实现，可复制业务代码为零。直接复用其真实`2026-07-04-feishu-plugintoken-outage`复盘中的“先查数据真源、health→credential/challenge→无扰假事件→D1分段定位”和“重签依赖凭据→stdin secret put→立即探测，不等待自然流量、不运行覆盖完整配置setup”纪律；没有复制Watt域名、token、CLI产品模型或线上配置。
- 动作：
  - 先写`test/operations-runbook.test.ts`，固定`IR-GITHUB/FEISHU/TOOL-BRIDGE/DATABASE/SECRET/WRONG-PRODUCTION-DEPLOYMENT`六类及触发与分级、只读诊断、止损与授权、恢复、验证与结案、证据、禁止项七阶段。首次`pnpm exec vitest run test/operations-runbook.test.ts`按预期exit 1，failed suite / 0 tests，明确`docs/OperationsRunbook.md`不存在。
  - 新增`docs/OperationsRunbook.md`：统一IC/Operator/Reviewer/Evidence Keeper、SEV-0/1/2、双人复核、token隐藏stdin、证据最小化和外部事实结案纪律；提供health、Plan/Case 8/correlation、DLQ list/replay、version-bound cancel、backup/restore的可复制命令，numeric/reason/Secret name均本地allowlist校验。
  - GitHub故障按outage/401-403/duplicate effect分流，先correlation+D1+GitHub read fact，再等待Cron或逐条exact DLQ replay；飞书区分入站、presentation、未知POST和已知PATCH响应丢失，禁止模糊认领message；tool-bridge区分policy denial与upstream/config，永不因outage扩read为write/Admin；D1区分短时outage与corruption，只有外部traffic isolation+Time Travel/import后才进入manifest-bound fence/撤权/九类complete。
  - Secret泄漏按operations/task/approval/GitHub/Feishu/tool/D1 backup/model authority分类，固定provider先撤销、stdin更新、分段canary、旧值失效证明；GitHub encryption key必须在旧key驱动revoker撤销write token后才轮换。错误production部署固定SEV-0、外部Environment/云平台双人止损与已演练rollback或新Task forward-fix；当前没有production rollback API，test rollback/restore fence/cancel均不能冒充云回滚。
  - 机器契约逐项核对runbook中11个HTTP method/path在对应Hono源码真实存在，六类每节长度与七阶段完整，无TODO；提取全部shell block执行`bash -n`，所有curl必须`--fail-with-body`且Bearer只引用隐藏环境变量；静态禁止硬编码token、`wrangler d1 execute`、R2 object delete和D1状态改写。新增`pnpm run verify:runbook`直接入口，完整verify也会通过Node suite覆盖。
  - 同步Architecture、Proto、Security、Reference和DOD，明确runbook不创建第二状态机、healthz/D1/provider事实边界、external-only pause/import/production rollback authority及Watt直接复用范围。按用户要求未更新llmdoc。
- 验证：
  - 红灯`pnpm exec vitest run test/operations-runbook.test.ts` → exit 1，failed suite / 0 tests，ENOENT `docs/OperationsRunbook.md`。
  - `pnpm run verify:runbook` → exit 0，1 file / 5 tests；覆盖六类×七阶段、SEV/结案、11个真实route method/path、unsupported boundary、stdin/argv/SQL/R2安全和全部shell Bash语法。
  - 聚焦后`pnpm run typecheck`、`pnpm run lint`、`pnpm run verify:docs`均exit 0。
  - `pnpm run verify` → exit 0；typecheck、ESLint、Node 51 files / 159 tests、workerd 50 files / 266 tests、236个生产文件Secret scan和Markdown links全绿。Workflow清理仍输出已有预期`User called terminate`信息，无失败suite。
  - `CI=1 WRANGLER_SEND_METRICS=false pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round69-20260726-final` → exit 0；bundle 2338.52 KiB / gzip 389.81 KiB，两个Workflow、Queue、D1和四R2 binding全部成功识别，未部署。
  - `git diff --check` → exit 0。
- 勾选：Phase 6运营runbook DoD完整勾选。可重跑机器契约证明六类事故的完整处置结构、命令与当前源码一致、安全边界和缺失能力没有被文档掩盖；本地测试/dry-run只证明runbook与构建契约，不冒充真实Secret轮换、D1恢复、provider outage或production rollback演练。
- 决策沉淀：runbook的价值不是列出更多高权限命令，而是让Operator知道何时只能读、谁有止损authority、哪个外部事实才能结案以及当前系统做不到什么。当前无global provider pause/production rollback API时，正确做法是显式外部平台人工处置和独立能力DoD，不能误用restore fence、test rollback、伪造webhook或D1手写修复。Watt真实事故证明轮换若不立即分段验证会形成静默断链，因此依赖凭据轮换必须把旧值失效和无扰canary作为同一次动作的完成判据。
- 遗留：下一轮审计Phase 6“连续7天试运行”所需真实部署、试点Run、日志/指标与Secret告警前置；若外部环境仍未配置，按LOOP记录精确blocker并选择可在本地继续推进的下一项，不能用测试循环或历史单测冒充7天运行。

## Round 70 — 2026-07-26
- 目标：Phase 6 / 为“连续7天试运行无未知stuck、无重复PR/部署、无Secret告警；指标报告入账”建立可重跑的本地证据关口，并如实确认真实七天外部前置；父DoD在真实窗口完成前保持未勾。
- 前置与权限：仅本地源码、Watt固定commit、Node fake HTTP测试、规范与Wrangler dry-run；未访问或修改真实Cloudflare/GitHub/日志/metrics/告警平台，未部署、未触发Action/PR/Deployment、未读取真实数据库或Secret。`git remote -v`为空，`wrangler.jsonc`的D1 ID仍为全零占位值；没有真实Worker deployment、试点repository inventory或七天观测窗口。
- Watt复用：完整读取`/Users/jishihe/tokenrollal/Watt@476e3cdd2490d725fde174e7c697ebf00899edc6`的`packages/cli/src/metrics.ts`及测试、`packages/gateway/src/metrics/metrics.ts`和observability测试。七天命令直接沿用Round 59已从Watt E2E迁入的0=pass/1=fact failure/2=prerequisite missing、显式opt-in、live read-only核对和固定错误输出纪律，没有复制第二套CLI协议。Watt可直接复用的业务模块为零：其`7d`只是默认range，invalid range会回落7天，gateway只返回窗内聚合单点且部分metric允许空series，不能证明10080分钟连续coverage、runtime Secret detector、unknown stuck或外部重复PR/Deployment；强行复制会弱化本项完成判据。
- 动作：
  - 先写`test/seven-day-trial-evidence.test.ts`，覆盖exact七天、安全链接/report digest、三方成功核对、重复PR/Deployment、metrics缺口、unknown/unresolved stuck、Secret alert、GitHub分页和raw canary；首次`pnpm exec vitest run test/seven-day-trial-evidence.test.ts`按预期exit 1，failed suite / 0 tests，错误为缺`seven-day-trial-evidence`模块。
  - 新增strict `SevenDayTrialEvidenceManifestV1`与`SevenDayTrialObservabilityReportV1`、两个schema示例和canonical digest。窗口必须分钟对齐且恰好604800000ms；report固定10080个minute bucket、两个detector active、至少一个Run、known incident全部resolved且unknown/unresolved/Secret alert为空。manifest URL不能自行决定token投递目标，受控`SEVEN_DAY_TRIAL_OBSERVABILITY_URL`必须与其精确相等。
  - 新增只读verifier与`pnpm run e2e:seven-day-trial`：先读取digest-bound observability report，再对每个Run读取Case 8报告，最后列出固定App actor在窗口内的GitHub PR和带control-plane stable ID的Deployment。控制面与GitHub inventory逐项相等；同head多个PR、同stable ID多个Deployment、任一多/少或`Link rel=next`均fail-closed。summary与错误只含固定字段/code，不传播token、manifest或raw response。
  - 新增[连续七天试运行验收](docs/SevenDayTrial.md)，同步Architecture、Proto、Security、Reference和DOD，明确三个独立事实源、最小权限、最终人工review及当前外部阻塞；按用户要求未更新llmdoc。
  - 首次全量verify时，已有`test-acceptance`夹具的固定`03:00Z`已经越过30分钟Attempt lease，OIDC API按生产逻辑正确返回403，导致2个测试失败。只把测试基准改为进程启动时的分钟边界，未修改生产租约或鉴权；聚焦10/10和最终全量回归随后通过，没有把首次失败伪装为绿。
- 验证：
  - 红灯`pnpm exec vitest run test/seven-day-trial-evidence.test.ts` → exit 1，目标domain模块不存在；实现后exit 0，1 file / 5 tests。
  - `pnpm run e2e:seven-day-trial` → exit 2，明确缺`DELIVERY_LOOP_SEVEN_DAY_TRIAL_E2E=1`；设置opt-in但只提供受控report URL后仍exit 2并报告配置不完整。两条路径均在fetch/manifest读取前结束，零网络，未把缺前置记为事实失败或成功。
  - 聚焦`test/workflow/test-acceptance.test.ts`在修正过期测试时钟后exit 0，1 file / 10 tests；`pnpm run typecheck`、`pnpm run lint`、`pnpm run verify:docs`均exit 0。
  - `pnpm run verify` → 首次exit 1并明确2条过期lease夹具失败；修正后exit 0，typecheck、ESLint、Node 52 files / 164 tests、workerd 50 files / 266 tests、241个生产文件Secret scan和Markdown links全绿。Workflow清理仍输出已有预期`User called terminate`信息，无失败suite。
  - `CI=1 WRANGLER_SEND_METRICS=false pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round70-20260726-final` → exit 0；bundle 2338.52 KiB / gzip 389.81 KiB，两个Workflow、Queue、D1和四R2 binding成功识别，未部署。
  - `git diff --check` → exit 0。
- 勾选：只勾Phase 6“连续7天试运行”的本地显式opt-in证据关口；父项与“真实部署连续七天外部事实”保持未勾。本地5个fake用例、示例manifest、10080计数和Wrangler dry-run都没有冒充真实七日运行。
- 决策沉淀：连续运行证明不能来自控制面单方自报，也不能把“查询range=7d”当成持续覆盖。最小可信闭环是外部observability coverage/report digest、控制面逐Run Case 8 lineage和GitHub完整effect inventory三方相等，再由人review永久查询链接。Watt的E2E退出纪律可以直接复用，其聚合metrics语义不能越界复制为本项目可靠性证据。
- Blocker：这是本项第1轮外部阻塞。开始真实窗口至少需要用户/资源owner确认GitHub owner/repo/visibility/branch protection/Actions预算，配置远端与最小GitHub App，提供真实Cloudflare Paid账户及D1/R2/Queue/Workflow部署、日志/metrics保留和runtime Secret detector。窗口开始后还必须等待完整七个自然日；在这些外部状态变化前不能勾父项，也不会盲重试或访问未经授权的真实平台。

## Round 71 — 2026-07-26
- 目标：Phase 2 / 为“真实飞书应用challenge和一条真实事件验签通过；错误签名、过期timestamp、错误tenant被拒且无业务记录”建立本地Worker/D1加密回调契约；真实tenant完成前父DoD保持未勾。
- 前置与权限：仅本地Node/Web Crypto、workerd/D1测试binding、Watt固定commit和Wrangler dry-run；未访问飞书开放平台、未创建/发布应用、未配置真实回调域名、未发送消息或事件，未使用真实app/tenant/token/encrypt key。测试只使用仓库测试配置中的合成值，raw测试消息不进入生产源码/PROGRESS。
- Watt复用：完整读取`/Users/jishihe/tokenrollal/Watt@476e3cdd2490d725fde174e7c697ebf00899edc6`的`packages/plugin-feishu/src/adapter/crypto.ts`、`verify.ts`、`worker.ts`及crypto/verify/worker测试。`src/feishu/webhook-crypto.ts`直接复制constant-time compare、`sha256(timestamp+nonce+encryptKey+exact body)`、base64前16字节IV与`SHA-256(encryptKey)` AES-256-CBC解密；Node `node:crypto`独立oracle测试结构也直接迁移。verifier继续复用Watt的加密/明文分流、解密后JSON和challenge提取结构。Watt没有timestamp freshness、tenant/app绑定，加密后不重验verification token，且无encrypt key时允许未配置token的匿名明文；这些不满足本项目DoD，因此未照搬弱边界。
- 动作：
  - 先新增`test/feishu-webhook-crypto.test.ts`与`test/workflow/feishu-webhook.test.ts`，固定signature/AES oracle、认证challenge、exact tenant event、错误签名、301秒旧timestamp、错误tenant/app/token、同event新nonce收敛、同nonce换event拒绝及receipt/Task/Run/outbox零写入判据。首次两条聚焦命令均按预期exit 1，failed suite / 0 tests，明确缺`src/feishu/webhook-crypto`模块。
  - 新增`POST /v1/webhooks/feishu`。请求先限256 KiB并保留exact body；加密模式要求三个`X-Lark-*`header、10位秒timestamp与控制面相差最多300秒、64位hex signature，随后AES解密并对顶层/header verification token做常量时间比较。缺app/tenant或两类来源Secret都未正确配置时503，不能退化为匿名入口。
  - challenge只在验签/解密/token通过后返回`{challenge}`，不写D1。event只接受有界v2 header/event，`app_id + tenant_key`必须精确等于`FEISHU_APP_ID + FEISHU_DELIVERY_TENANT_KEY`；错误来源在digest/store之前固定401/403，响应不传播Zod、解密或上游错误。
  - migration 0044新增immutable `feishu_webhook_nonces`与`feishu_webhook_deliveries`。每个已认证加密request把nonce只按SHA-256 digest入账；event按tenant+event ID唯一。D1 batch先claim exact nonce，再以该nonce事实guard receipt插入；相同event重新加密/新nonce仍只一份receipt且每个nonce留痕，同nonce更换event/request固定409。两表没有raw/encrypted/decrypted body、token、encrypt key或自由错误列，且本轮不创建Task/Run/outbox。
  - 接入Worker与Bindings，同步Architecture、Proto、Security、Reference和DOD；记录Watt直接复制和安全加固边界。按用户要求未更新llmdoc。
- 验证：
  - 红灯`pnpm exec vitest run test/feishu-webhook-crypto.test.ts`与`pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/feishu-webhook.test.ts` → 均exit 1，目标crypto模块不存在；实现后分别exit 0，1 file / 4 tests和1 file / 4 tests。
  - 聚焦Node oracle证明签名与独立`node:crypto`一致、AES密文跨实现可解且错误key拒绝、constant-time/token配置边界；聚焦workerd证明challenge零写、valid event metadata-only、exact/redelivered请求收敛、五类错误零业务写与nonce replay 409。
  - `pnpm run typecheck`、`pnpm run lint` → 实现中首次分别因narrowing/test Request类型与empty interface失败；只收窄类型/测试transport后最终均exit 0，没有弱化生产校验。
  - `pnpm run verify` → exit 0；typecheck、ESLint、Node 53 files / 168 tests、workerd 51 files / 270 tests、246个生产文件Secret scan和Markdown links全绿。Workflow清理仍输出已有预期`User called terminate`信息，无失败suite。
  - `CI=1 WRANGLER_SEND_METRICS=false pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round71-20260726-final` → exit 0；bundle 2356.88 KiB / gzip 393.80 KiB，两个Workflow、Queue、D1和四R2 binding成功识别，未部署。
  - `git diff --check` → exit 0。
- 勾选：只勾Phase 2飞书challenge/验签DoD的本地Worker/D1子项；父项和真实tenant外部事实保持未勾。Node oracle、workerd fake密文和dry-run都没有冒充真实应用订阅成功。
- 决策沉淀：飞书签名是纯SHA-256拼接而非GitHub式HMAC，raw body不能重序列化。Watt成熟crypto应直接复制，但其宽松兼容模式不能带入高权限交付控制面；来源认证必须是signature/timestamp/decryption/token/app/tenant的服务端组合。transport nonce与业务event ID是两层不同去重键，拆表后才能同时允许平台安全重投并拒绝nonce换事件。
- 遗留：下一轮只处理Phase 2“同一飞书event重放3次只入队一次；不同event指向同task revision仍只创建一个Run”的本地切片。应直接消费本轮verified receipt，先定义无正文R2/ref或规范化输入边界、事务outbox与Task revision唯一约束；不得再次解密、信任caller自报tenant/event/digest，真实飞书重推仍另需tenant外部证据。

## Round 72 — 2026-07-26
- 目标：Phase 2 / 同一飞书event重放3次只产生一个逻辑ingress outbox；不同event经归一化后指向同一Task source revision时仍只有一个Task、Run和workflow-create intent。
- 前置与权限：仅本地workerd/D1/R2、fake Queue adapter、Wrangler dry-run与Watt固定commit；未访问飞书/Meegle或真实Cloudflare Queue，未部署、未发送真实事件、未创建Task到外部Workflow。Queue测试body只有stable outbox ID，Task使用合成反馈且无真实Secret。
- Watt复用：完整读取`/Users/jishihe/tokenrollal/Watt@476e3cdd2490d725fde174e7c697ebf00899edc6`的`packages/gateway/src/event/event-store.ts`、`event-bus.ts`和`integration-event-flow.test.ts`。直接复用“dedupeKey命中原event ID后不再留痕/不再Queue send”、可注入Queue sender及同event重放断言结构；Task层直接复用本项目已有`TaskIntakeStore`的source revision稳定ID/digest与Task+Run+workflow-create同事务。Watt保存完整event envelope并用`put→queue.send失败→best-effort delete`补偿，会把正文放D1且补偿失败可能丢投递，因此未复制该存储/effect顺序；delivery-loop继续采用Watt-derived持久outbox/fencing。
- 动作：
  - 先新增`test/workflow/feishu-ingress-idempotency.test.ts`，固定三次event重放、20路relay、一次Queue send/consumer观察、确定send失败回pending、两个event同revision、event/tenant/Secret负向与R2/Task/Run/workflow intent计数。首次聚焦按预期exit 1，failed suite / 0 tests，明确缺`src/outbox/feishu-ingress`。
  - migration 0045新增`feishu_ingress_outbox`：verified delivery/event/tenant/digest immutable，每event一行；状态为pending→delivering→enqueued→queued→settled，另有dead-letter终态。5分钟lease、attempt count、Queue observation与Task/Run/ref/digest绑定均受D1 CHECK/terminal trigger保护。
  - `FeishuWebhookStore`把receipt和stable ingress outbox放入同一D1 batch；相同event即使换timestamp/nonce/re-encrypt也补齐/复用同一outbox。nonce冲突无法通过exact nonce guard创建receipt/outbox；API响应仍不公开outbox authority。
  - 新增专用`FEISHU_INGRESS_QUEUE`。scheduled relay用D1条件claim使20路只有一个send；确定失败只退同一outbox pending，send成功标enqueued。consumer只携/回查outbox ID并幂等写queue-observed，重复Queue delivery不产生业务effect；专用DLQ把未settled行写metadata-only dead-letter终态。Wrangler producer/consumer/DLQ与Worker scheduled/queue分支均接线。
  - 新增内部`FeishuNormalizedTaskStore`，只领取`queued + queueObserved + accepted receipt`，要求Task source为`feishu|meego`、event ID与tenant精确绑定，Secret scan通过后先写content-addressed私有R2，再直接调用`TaskIntakeStore`。Task revision digest排除event ID/occurredAt但覆盖source/actor/target/intent/policy，因此不同event同业务revision收敛；settle中断可重放补账，错误event/tenant/Secret在R2/Task前拒绝。
  - 同步Architecture、Proto、Security、Reference和DOD，明确“只入队一次”是stable D1逻辑outbox/effect identity，不虚构Cloudflare Queue物理exactly-once。按用户要求未更新llmdoc。
- 验证：
  - 红灯`pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/feishu-ingress-idempotency.test.ts` → exit 1，目标ingress模块不存在。
  - 首次实现运行1/3通过、2条失败：测试直接把pending改queued却未写enqueued time，D1 CHECK正确拒绝；改为所有用例真实走relay+consumer后通过，没有放宽schema。最终ingress聚焦exit 0，1 file / 4 tests。
  - `feishu-webhook + feishu-ingress + task-intake-store`聚焦 → exit 0，3 files / 12 tests；覆盖来源验证→唯一outbox→Queue观察→双event同revision单Run，以及Queue失败重试和Secret/binding负向。
  - `pnpm run typecheck`、`pnpm run lint` → 首次分别因测试batch可空类型和env inline import style失败；改为安全索引与普通type import后最终exit 0。
  - `pnpm run verify`的typecheck、ESLint、Node 53 files / 168 tests、workerd 52 files / 274 tests、249个生产文件Secret scan均通过；`pnpm run verify:docs`单独确认exit 0。Workflow清理仍输出已有预期`User called terminate`信息，无失败suite。
  - `CI=1 WRANGLER_SEND_METRICS=false pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round72-20260726-final` → exit 0；bundle 2364.08 KiB / gzip 394.86 KiB，两个Workflow、原outbox Queue、新`FEISHU_INGRESS_QUEUE`、D1和四R2 binding成功识别，未部署。
  - `git diff --check` → exit 0。
- 勾选：新增并勾Phase 2 event/revision幂等的本地D1/R2/Queue子项；父项与真实飞书tenant/Cloudflare Queue外部事实保持未勾。fake Queue send count和直接normalized sink没有冒充真实平台重投或实际Meegle映射。
- 决策沉淀：平台event ID与业务Task revision是两层独立幂等：前者阻止同delivery重复入队，后者允许不同event安全指向同一Run。Cloudflare Queue是at-least-once，不能把“物理只投递一次”作为可保证语义；D1 outbox、consumer observation和Task/Run稳定identity共同提供effect exactly-once。Watt的dedupe行为值得复制，put后失败delete的补偿模型不适合持久控制面。
- 遗留：下一轮只处理Phase 2“Meegle工作项映射TaskEnvelope；缺字段进入triaging并列出缺口”。应实现真实adapter端口去读取receipt/outbox对应的受信外部work-item snapshot，复用本轮normalized sink；需要定义owner/repo/revision/acceptance的缺失投影，不能把缺字段的任务伪造成可执行Task或由Queue body提供映射内容。

## Round 73 — 2026-07-26
- 目标：Phase 2 / Meegle工作项标题、描述、验收标准、owner、目标repo、revision映射为TaskEnvelope；缺字段进入`triaging`并列出缺口——本轮闭环本地strict snapshot/profile、映射、metadata-only triage ledger、Round 72 sink穿透与安全查询；真实Meegle tenant/API证据保持未完成。
- 前置与权限：仅本地Node/workerd/D1/R2、fake Queue与Wrangler dry-run；未调用真实Meegle/飞书API，未读取业务工作项、日志或数据库，未部署、未发送外部事件、未触发Workflow/GitHub Action。按`meegle` skill完整读取工作项和API示例规范，确认field/role metadata必须先解析、role不是普通field、`fields=["_all"]`仍需按`next_page_token`翻完；没有project key/work-item ID，因此没有无目标地查询真实tenant。
- Watt复用：固定检索`/Users/jishihe/tokenrollal/Watt@476e3cdd2490d725fde174e7c697ebf00899edc6`的Meegle/Meego/work-item/TaskEnvelope/triaging实现，Meegle-specific adapter可直接复制代码为零。最大化复用已直接从Watt迁入本项目的`applyD1Migrations`测试入口、content-addressed R2 conditional-write和stable identity模式，并直接复用Round 72 `FeishuNormalizedTaskStore`与`TaskIntakeStore`，没有另造Task/Run/outbox协议；只新增Watt不存在的Meegle snapshot/profile与triage语义。
- 动作：
  - 先新增`test/meegle-work-item-mapper.test.ts`与`test/workflow/meegle-work-item-ingress.test.ts`；首次聚焦分别因domain/store模块不存在而failed suite / 0 tests，证明此前没有Meegle映射或triage持久路径。
  - 新增strict `MeegleWorkItemSnapshotV1`：event/tenant/project/type/item/revision/URL、基础title/description、actor、普通field、独立role、全量分页状态；field/role key不得重复。新增受信`MeegleTaskMappingProfileV1`绑定owner role、acceptance/repository field、kind/base/environment/priority与repository allowlist，工作项不能夹带profile/policy/effect。
  - 完整story/issue把source固定为`meego`、task key固定为project/type/item；markdown checklist或string-array映射acceptance，Meegle角色owner映射到新增可选`TaskEnvelope.coordination.owner`，GitHub仓库owner/repo仍来自allowlist repository field，两种owner语义不混用。初始policy固定三类write/deploy均false且必须human approval。
  - migration 0046新增immutable `meegle_triage_candidates/lineage`。未完成全字段分页、缺title/description/acceptance/owner/repo/revision、owner多值或repo非法时不生成TaskEnvelope；D1只保存source/profile identity、digest、固定gap与event lineage，exact snapshot经Secret scan进入私有content-addressed R2。20路同输入收敛为一候选/lineage且Task/Run/outbox为零。
  - `MeegleWorkItemIngressStore`只领取Round 72已queue-observed且accepted的exact event/tenant，重新绑定profile tenant/project/type后才映射；完整snapshot直接调用既有normalized sink。两个不同event映射同一业务revision时只有一个Task/Run/workflow-create intent、两份settled ingress；错误event/profile/Secret在R2/D1/Task前拒绝。
  - 五维自审发现完整mapping首次settle后，上层若只接受queued会让同一normalizer顺序重放提前失败；修正为queued/settled均继续交给Round 72 sink核对，新增断言证明settled exact replay返回duplicate且不新增effect。Meegle URL同时改为可空，因为它不是执行契约必填项，不能凭无关字段阻止完整Task。
  - 新增operations认证`GET /v1/triage/meegle?limit=`，仅返回source metadata、固定gap、profile version、lineage count和时间，不返回description/field value/owner principal/R2 ref/digest。同步Architecture/Proto/Security/Reference与DOD，只勾本地子项；按用户要求未更新llmdoc。
- 验证：
  - 红灯`pnpm exec vitest run test/meegle-work-item-mapper.test.ts` → exit 1，failed suite / 0 tests，缺`src/domain/meegle-work-item`；红灯workerd ingress suite同样exit 1，缺store。
  - 聚焦Node `pnpm exec vitest run test/meegle-work-item-mapper.test.ts test/task.test.ts` → exit 0，2 files / 6 tests；覆盖story/issue、role/field隔离、checklist/array、确定性gaps、owner歧义、repo allowlist、strict schema与profile binding。
  - 聚焦workerd `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/meegle-work-item-ingress.test.ts test/workflow/feishu-ingress-idempotency.test.ts test/workflow/task-intake-store.test.ts` → exit 0，3 files / 11 tests；覆盖双event同revision单Run、20路triage、零effect、安全查询、Secret/binding负向及相邻sink/intake回归。
  - `pnpm run typecheck`、`pnpm run lint` → 实现中lint首次因digest投影unused destructuring exit 1，改为显式业务投影后最终exit 0；没有放宽规则。
  - 前两次`pnpm run verify`分别在既有`github-review-feedback`20路duplicate计数和`execution-attempt-api`20路CAS出现一次非确定性缺响应/409而exit 1；对应单文件立即复验分别5/5与2/2通过，未修改与本轮无关断言。第三次全量exit 0；五维自审补顺序回放/可空URL后再次最终`pnpm run verify` → exit 0，typecheck、ESLint、Node 54 files / 172 tests、workerd 53 files / 277 tests、253个生产文件Secret scan和Markdown links全绿。workerd仍输出已有预期Workflow terminate清理信息，无失败suite。
  - `CI=1 WRANGLER_SEND_METRICS=false pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round73-20260726-final-v2` → exit 0；bundle 2372.31 KiB / gzip 396.70 KiB，双Workflow、原outbox Queue、Feishu ingress Queue、D1与四R2 binding成功识别，未部署。
  - `git diff --check` → exit 0。
- 勾选：Phase 2 Meegle映射DoD下新增并勾选“本地Node/workerd/D1/R2契约”子项；父项与真实Meegle外部事实保持未勾。合成snapshot、fake Queue、workerd和dry-run不能证明真实field/role key、API全量分页或tenant权限。
- 决策沉淀：可执行Task必须是完整契约，缺字段不能用sentinel填充后启动Run。Meegle owner是协作负责人，不是GitHub repository owner，因此新增`coordination.owner`而不污染`target.owner`。mapping profile是受控策略输入，工作项只是数据；repo allowlist与只读初始policy阻止PRD/反馈正文扩大权限。triage candidate与Run是不同状态模型：前者可以没有Task/Run，避免为了复用Run的`triaging`枚举而伪造Task。
- 遗留：真实测试需用户提供Meegle测试tenant/project、story/issue type与工作项；adapter先用meta-fields/meta-roles确认验收字段、owner role、repo字段，再把`_all`分页读取到无next token。分别以完整、缺字段、owner多值、repo越allowlist和中断分页工作项记录API/D1/R2安全摘要；真实API adapter/credential配置和事件触发仍未接线，不能用本轮strict snapshot端口冒充外部完成。下一轮按Phase 2顺序处理飞书卡片展示DoD，不扩展本轮Meegle scope。

## Round 74 — 2026-07-26
- 目标：Phase 2 / 卡片展示状态、task revision、plan version/digest、DoD Item进度、目标repo、本轮目标、Action/PR链接、blocker和批准effects；大日志只显示摘要/受控链接——本轮闭环本地card v2 schema/renderer、D1完整投影、approval到期无事件刷新、v1兼容与既有outbox/create/PATCH/回读穿透；真实飞书tenant消息事实保持未完成。
- 前置与权限：仅本地Node/workerd/D1、fake Feishu effects、既有fake REST、Wrangler dry-run与Watt固定commit；未调用真实飞书IM API、未取得tenant token、未发送/更新/读取真实消息，未访问业务群、GitHub远端、日志、数据库或tool-bridge，未部署。按`lark-im` skill及其required `lark-shared`规则核对interactive消息、bot identity、tenant/chat membership/scope和raw card event边界；本轮无需认证，未运行`lark-cli`写命令。
- Watt复用：不创建第二套sender。继续直接复用Round 58已从`/Users/jishihe/tokenrollal/Watt@476e3cdd2490d725fde174e7c697ebf00899edc6`迁入的interactive `wide_screen_mode/lark_md`骨架、isolate token cache、7200秒/60秒边际、token-invalid集合、stable UUID，以及项目现成fenced outbox、message ID/PATCH/14天重建/GET digest补偿。Watt generic message没有Task/Plan/DoD/GitHub fact/blocker/approval expiry模型，本轮新增仅限这些delivery-loop语义；没有把新增能力倒称为Watt代码。
- 动作：
  - 先新增`test/feishu-run-status-card.test.ts`与workerd完整projection用例。Node首次2/2红灯：renderer仍只有4段且v2 schema不存在；workerd首次1/4红灯：D1明确缺`schema_version`列，证明此前Round 58只实现四类delivery状态卡。
  - `FeishuDeliveryCardPresentationV2` strict schema新增Run state/version、task revision、repo/base、active Plan version/digest、DoD七项计数、本轮goal、可信Action/check/PR/deploy链接、checkpoint/Evidence摘要、blocker与approved effects/expiry；unknown rawLog/effect、unsafe URL和矛盾进度直接拒绝。renderer保留Watt-derived classic interactive格式，所有摘要在固定“不可信数据/摘要”标签下Markdown转义。
  - migration 0047为卡状态增加`refresh_after`，为immutable presentation增加`schema_version + presentation_json`。D1 trigger把v2 JSON与card/presentation/run/version exact绑定；旧v1行保持NULL JSON并由共享rehydration边界继续渲染，未UPDATE或删除在途presentation/outbox。
  - scheduled projector只从D1 Task/Run/active Plan/Item progress、可信Attempt observation、verified Evidence、active blocker与exact trusted approvals读取。Action只由safe repo+numeric observed run ID构造；check/Evidence/PR/deploy继续要求各自verified fact。Plan Item title、checkpoint/Evidence summary先截断输入、NFKC单行化、移除control/zero-width/bidi字符并扫描当前Worker配置Secret/credential；命中使用固定隐藏摘要。Task/PR正文、raw log、artifact/R2 ref、Runner error、数据库行和caller URL没有schema/query入口。
  - approved effects必须exact绑定current task revision/Plan version+digest/base，来自trusted view、未过期、未进入统一invalidation且没有更新reject；identity/role/channel mapping变化也触发重投影。最早有效expiry持久化为`refresh_after`，到时即使D1没有其他写入也生成新revision并移除过期effect；测试证明过期前仅repo_write、过期后空数组。
  - 完整v2继续通过Round 58同一presentation→outbox→create/PATCH/message ledger发布，20路同snapshot只一presentation/outbox，旧revisioneffect前settle；14天重建、lost PATCH GET digest补偿和outbox router均回归。同步Proto/Architecture/Security/Reference与DOD，只勾本地子项；按用户要求未更新llmdoc。
- 验证：
  - 红灯`pnpm exec vitest run test/feishu-run-status-card.test.ts` → exit 1，2/2 failed，旧renderer只有4段且v2 schema未定义；红灯`pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/feishu-delivery-card.test.ts` → exit 1，新增用例因`schema_version`列不存在失败，其余既有3条通过。
  - 聚焦Node `pnpm exec vitest run test/feishu-run-status-card.test.ts test/feishu-delivery-card.test.ts` → exit 0，2 files / 10 tests；覆盖完整字段、Markdown/URL/progress/effect strict负向、rawLog无入口、Watt-derived POST/PATCH/token/限流，以及v1 row兼容/非法v1 JSON拒绝。
  - 聚焦workerd `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/feishu-delivery-card.test.ts test/workflow/outbox-routing.test.ts` → exit 0，2 files / 9 tests；覆盖D1全投影、Secret隐藏、Action/check安全链接、blocker paths、approval过期无事件刷新、20路收敛、stale零effect、create→PATCH、14天重建、lost response GET补偿与第八destination路由。
  - 实现中首次workerd运行4/4因Zod refined schema不允许runtime `.omit()`失败；改为TypeScript core构造且在持久化前完整v2 schema parse后4/4通过，没有跳过runtime校验。随后旧断言仍期望4段而1/4失败，更新为v2固定14段后通过。
  - `pnpm run typecheck`、`pnpm run lint`、`pnpm run verify:docs`、`git diff --check` → 最终均exit 0；lint中control-range regex被拒后改为显式code-point过滤，没有关闭规则。
  - 最终`pnpm run verify` → exit 0；typecheck、ESLint、Node 55 files / 175 tests、workerd 53 files / 278 tests、255个生产文件Secret scan和Markdown links全绿。workerd仍输出已有预期Workflow terminate清理信息，无失败suite。
  - `CI=1 WRANGLER_SEND_METRICS=false pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round74-20260726-final` → exit 0；bundle 2399.85 KiB / gzip 402.77 KiB，双Workflow、原outbox Queue、Feishu ingress Queue、D1与四R2 binding成功识别，未部署。
- 勾选：Phase 2完整卡片DoD下新增并勾选“本地Node/workerd/D1/outbox契约”子项；父项与真实飞书tenant外部事实保持未勾。fake effects/REST、workerd和dry-run不能证明bot scope、群membership、真实interactive消息或同message PATCH成功。
- 决策沉淀：卡片是安全只读投影，不是新状态真源或授权面。显示approved effect必须反映当前authority而不是历史approval行，所以expiry、invalidation、reject和live identity role都参与projection。外部自然语言可以被展示但必须固定标成不可信数据、限长、去控制字符、Secret scan并转义；raw日志永远只给verified summary/link。schema升级不能遗弃旧outbox，v1 rehydration与v2 latest并存直到旧投递自然收敛。
- 遗留：真实验收需发布自建应用并以bot identity加入测试群，最小开通send/update及回读所需scope；用真实Run首次POST v2并在同message ID PATCH，逐项截图/核对全部字段。让approval自然过期且无其他状态写入，观察卡片自动移除effect；再用大日志、Markdown和Secret canary证明消息/D1/outbox零泄漏。需记录message ID/链接、scope/群membership、presentation/delivery安全摘要；当前没有tenant/chat授权，不能把本地卡片JSON冒充外部完成。下一轮按Phase 2顺序处理approve/reject/cancel/retry/replay/add-context服务端身份/revision/nonce鉴权DoD。

## Round 75 — 2026-07-26
- 目标：Phase 2 / `approve/reject/cancel/retry/replay/add-context`服务端按open_id、tenant、Task/Run revision、Plan version/digest、base SHA、effect和一次性nonce重新鉴权；伪造按钮、重复nonce与旧snapshot全部拒绝。本轮只闭环本地Worker/D1/R2契约，真实tenant点击证据保持未完成。
- 前置与权限：仅读取本地delivery-loop与Watt固定commit`476e3cd`，使用本地Node/workerd、加密Feishu fixture、D1/R2 binding、Secret scan和Wrangler dry-run。未调用真实飞书API、未发送/更新/读取真实卡片、未查询业务日志/数据库、未触发GitHub Action、未部署、未提交。按用户要求不更新llmdoc；未保存raw webhook、form正文、token、Secret值或数据库行。
- Watt直接复用：完整读取并迁移`packages/plugin-feishu/src/adapter/decode.ts`的`card.action.trigger`字段提取形状——`header.event_id/create_time`、`operator.open_id`、`action.value`、`context.open_chat_id`；完整复用`encode.ts`的button `value={id,signal}`结构。delivery-loop只补`open_message_id`/受控form context、strict snapshot command与双nonce/权限语义。Watt generic signal、raw Event传播和checkpoint业务模型没有复制，避免把未绑定signal误作控制面authority。
- 动作：
  - 新增strict `FeishuCardActionCommand`和Watt-derived decoder。presentation v2可选actions由projector生成；signal冻结card/presentation/task/run/version、task revision安全显示+完整digest、active Plan ID/version/digest/base、command/effect、context mode和application nonce，不存在principal/roles/policy/expiry/R2 ref/caller target字段。Plan effect集合、完整task revision digest及上次action outcome epoch参与presentation identity；失败动作会生成新presentation/nonce。
  - renderer直接用Watt button mapping输出`id + signal`，add-context增加单个受控input与`new_run/apply_current`两枚冻结按钮。最新卡片最多13枚业务按钮，application nonce由presentation/action稳定派生；服务端不把确定性nonce当Secret，而是以latest presentation membership + D1 binding + operator identity + one-time ledger共同授权。
  - migration 0048新增immutable `feishu_card_action_receipts/outcomes/approval_bindings`。`tenant+event`和`tenant+application nonce digest`各唯一；receipt只存open_id/principal、安全ID、versions/digests与固定command/effect，outcome只有固定result/reason。重新定义`trusted_effect_approvals`：历史非card低风险approval保持兼容，card产生的repo_write/test_deploy必须每次重新JOINcurrent Feishu channel mapping、live human和`approve:<effect>`；merge/production原identity/release分离分支不变。
  - webhook在完成signature/timestamp/decrypt/token/app/tenant后专门分流`card.action.trigger`。action只创建metadata webhook receipt，不创建`feishu_ingress_outbox`；exact配置chat、active message、latest immutable presentation、current Task/Run/Plan/base/effect全部重读后，才以`feishu:<tenant> + operator.open_id`实时解析identity。anonymous/service/agent、缺human/role、Task self-approval及既有PR author分离全部fail closed。
  - `approve/reject`要求`approve:<effect>`；`cancel/retry/replay/add-context`分别要求`operate:cancel|retry|replay`和`context:add`。授权后不另写状态机：高风险approval复用`IdentityBoundApprovalStore`，低风险approval写标准approval+live identity binding；其余直接复用`AttemptLifecycleStore`、`RecoveryAttemptStore`、`WorkflowReplayStore`和`SupplementalContextRevisionStore`。retry Item从blocked+lost+checkpoint+cancel-settled投影推导，replay固定由服务端选择analysis verification restart；payload不能自选target。
  - add-context只从form取正文；先回读prior Task content-addressed R2并核对task digest/revision/custom metadata，用已验签event ID/time和operator open_id派生新revision/actor，再进入Round 47既有Secret-scanned immutable R2/D1 producer。正文不进入signal/action receipt/outcome/log，且不能改变new-run/apply-current模式、Task target或policy。
  - Node测试覆盖Watt字段映射、id/signal编码、strict拒绝principal/policy/target与raw零传播。workerd测试以完整加密webhook穿透六类成功路径；20路不同event同application nonce只有一个approve effect，另覆盖reject、cancel、server-derived retry/replay、R2-derived add-context、错误tenant/app/chat/message/open_id、service/agent/缺role、伪造effect/nonce、旧Run/task/Plan/base、无approval replay失败的terminal outcome/零业务部分状态和失败后新nonce。
  - card scheduled projector增加card action outcome epoch与card low-risk identity/channel authority时间；action失败或live role变更可生成新presentation。相关回归发现两个既有HTTP OIDC测试的固定`NOW`窗口已落在当前真实时钟之前，分别把production deployment与test rollback fixture移到同日稍后时间；产品过期/lease判断未放宽。
- 验证：
  - `pnpm exec vitest run test/feishu-card-action.test.ts` → exit 0，1 file / 3 tests；Watt-derived decode/encode、strict authority字段和raw边界通过。初次运行曾因测试期望把同一毫秒时间戳写成错误ISO而1/3失败，修正oracle后通过；这不是产品逻辑红灯，未伪装成先实现后测试的行为证据。
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/feishu-card-action.test.ts` → exit 0，1 file / 9 tests；六类动作、20路nonce收敛、全部snapshot/identity负向、失败outcome与无Task ingress通过。
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/feishu-card-action.test.ts test/workflow/feishu-delivery-card.test.ts test/workflow/controlled-replay.test.ts test/workflow/github-merge-gate.test.ts test/workflow/production-deployment.test.ts` → exit 0，5 files / 64 tests；low/high approval view、卡片、replay、merge与production回归通过。workerd输出既有Workflow terminate清理信息，无失败suite。
  - 首次`pnpm run verify` → exit 1：Node 56 files / 178 tests全绿，workerd 53/54 files已绿但既有test rollback HTTP fixture因真实时钟超过固定lease窗口出现1/287失败；未改产品策略，前移同日fixture后单文件9/9通过。
  - 最终`pnpm run verify` → exit 0；typecheck、ESLint、Node 56 files / 178 tests、workerd 54 files / 287 tests、258个生产文件Secret scan和Markdown links全绿。workerd仍只有既有预期Workflow terminate清理输出。
  - 初次dry-run命令因包含环境禁止的`rm -rf /tmp/...`在创建进程前被拒绝，未执行删除或构建；改用新outdir后`CI=1 WRANGLER_SEND_METRICS=false pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round75-20260726-final-v2` → exit 0，bundle 2437.84 KiB / gzip 409.98 KiB，双Workflow、两Queue、D1与四R2 binding识别成功，未部署。
  - `git diff --check` → exit 0。
- 勾选：Phase 2该DoD下新增并勾选“本地Node/workerd/D1/R2契约”子项；父项与真实飞书tenant外部事实保持未勾。本地fixture不能证明真实卡片callback字段、scope/群membership、open_id目录映射、转发/旧卡平台行为或真人职责分离。
- 决策沉淀：卡片signal是可验证的冻结intent，不是capability token；确定性nonce也不单独承担认证。安全性来自飞书transport验证、exact tenant/chat/message/latest presentation、current Task/Run/Plan/base/effect、实时human role与one-time application ledger的合取。transport nonce与application nonce必须分表分语义。动作内核继续由既有store拥有，card adapter只做可信字段提取、authorization与dispatch。失败claim不能重用，但action outcome进入下一presentation epoch以恢复可操作性。
- 遗留：真实测试tenant需发布包含六类按钮/input的latest卡片，用授权/未授权/撤权账号完成点击；受控重复、篡改`value`、旧卡、转发和错误群，记录安全event/message/presentation/receipt/outcome ID及HTTP结果。还需证明真实form callback字段、scope、bot membership、旧卡platform行为、六类effect仅一次及D1/R2/日志零raw/Secret；当前没有外部tenant/chat授权，不能代替。下一轮按Phase 2顺序处理“飞书审批事件、GitHub审批和控制面approval唯一关联记录”DoD；补充上下文外部子项仍依赖同一真实tenant证据。

## Round 76 — 2026-07-26
- 目标：Phase 2 / 飞书审批事件、GitHub审批和控制面approval形成唯一关联记录，回答谁在何时批准了哪个Task/Plan/base快照的什么effect。本轮闭环本地D1/workerd/Case 8契约；真实飞书/GitHub审批外部事实保持未完成。
- 前置与权限：仅读取本地delivery-loop与Watt固定commit`476e3cd`，使用本地workerd/D1测试、规范检查、Secret scan和Wrangler dry-run；未访问或修改真实Cloudflare/GitHub/飞书、日志、数据库或tool-bridge，未发送卡片、触发Action/审批/部署、提交代码或使用真实Secret。未保存raw webhook、按钮正文、nonce明文或数据库行；按用户要求未更新llmdoc。
- Watt复用：全树检索approval/approver/lineage/source/correlation。Watt只有generic task checkpoint approve/reject、Agent短期correlation waiter、OAuth device approval及generic AuditStore/EventStore，没有Task/revision/Plan/base/effect-bound的external approval lineage，可直接复制的等价业务代码为零。本轮继续直接复用Round 51已迁入的Watt identity mapper，以及Round 67从Watt AuditStore采用的D1`prepare+bind`与append-only审计纪律；没有复制Agent correlation，因为它是短期结果路由，不是长期approval真源。
- 动作：
  - 审计发现高风险merge/production已有`approval_source_events + identity_bound_approvals + approvals`，低风险飞书card只有`feishu_card_action_receipts + approval_bindings + approvals`；原Case 8只从identity source读取外部审批，因此不能对两类decision给出同一关联答案。
  - 先在GitHub merge与飞书card suite增加20路唯一lineage断言。首次聚焦执行2 files failed、2 tests failed / 39 passed，均明确`no such table: approval_lineages`，证明此前没有统一事实表。
  - migration 0049新增`approval_lineages`：每个approval及`provider + tenant + external event`双唯一，冻结source/card receipt、principal/roles、Run/Task/revision、Plan/version/digest、base/effect/decision、source发生时间、control-plane记录时间与expiry。backfill覆盖既有identity-bound和低风险card approval；shape trigger重验exact approval/source/receipt，binding互斥且lineage不可UPDATE；表无raw payload/request/token/nonce/display name字段。
  - `IdentityBoundApprovalStore`把approval、identity binding、可选exact card receipt与lineage放入同一D1 batch，重复source重新核对同一lineage后返回；candidate显式读取真实Task ID，没有用Run ID猜Task。`FeishuCardActionStore`高风险路径传入受信receipt，低风险repo-write/test-deploy在approval/card binding同batch建立lineage，任一预期insert缺失即fail-closed。
  - Case 8 approval查询统一LEFT JOIN lineage；external approval返回lineage/source安全ID、provider/event/digest、who、Task/revision、Plan/base/effect、source发生时间与decision记录时间。legacy/internal approval保持actor fallback并把外部lineage字段明确为null，不伪造来源。测试fixture证明飞书lineage进入`sourceEvents + approvals`且八栏报告仍不含正文/credential。
  - 增加D1负向证据：已形成的GitHub approval lineage尝试改写base SHA，被`approval_lineage_is_immutable` trigger拒绝。同步Proto、Architecture、Security、Reference和DOD；父项拆为已勾本地契约与未勾真实平台事实。
  - 最终全量复跑暴露既有execution head幂等路径的并发窗口：immutable head row已可见而Attempt CAS尚保持原version/parent/空branch时，重复exact请求被误判409。没有放宽任何identity；`ExecutionHeadStore`只对update/head/branch/generation全部相同且Attempt仍为原snapshot的pending projection继续执行原CAS，任一漂移仍fail-closed。该最小恢复修正使已持久化intent可重放收敛。
- 验证：
  - 红灯聚焦`github-merge-gate + feishu-card-action` → exit 1，2 files failed，2 failed / 39 passed，错误均为缺`approval_lineages`表；实现后两文件41 tests全绿。
  - 最终聚焦`case8-audit-report + github-merge-gate + feishu-card-action + production-deployment + controlled-replay` → exit 0，5 files / 63 tests；覆盖GitHub/飞书20路收敛、approve/reject、Case 8 exact lineage、生产审批与replay回归，以及lineage不可改写。
  - `pnpm run typecheck`、`pnpm run lint`、`pnpm run verify:docs`与`git diff --check` → exit 0。
  - 首次完整`pnpm run verify` → exit 0；追加PROGRESS后两次final复跑分别因既有`execution-attempt-api`的20路exact head中1路、9路返回409而exit 1（287/288），单文件复跑2/2通过，确认只在高并发调度窗口触发。上述pending projection修正后，execution-attempt与本轮五文件联合聚焦exit 0，6 files / 65 tests。
  - 最终`pnpm run verify` → exit 0；typecheck、ESLint、Node 56 files / 178 tests、workerd 54 files / 288 tests、259个生产文件Secret scan和Markdown links全绿。workerd只输出既有预期Workflow terminate清理信息，无失败suite；随后`git diff --check` exit 0。
  - `CI=1 WRANGLER_SEND_METRICS=false pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round76-20260726-final-v2` → exit 0，bundle 2446.54 KiB / gzip 411.36 KiB，双Workflow、两Queue、D1与四R2 binding识别成功，未部署。
- 勾选：只勾Phase 2该DoD下“本地D1/workerd/Case 8契约”子项；父项与真实飞书/GitHub外部事实保持未勾。本地fixture、直接D1 fixture和fake GitHub client不能证明平台reviewer、event time、重投行为或真人统一身份。
- 决策沉淀：approval是权限判定事实，approval lineage是外部decision到该事实的审计关联，两者不能混成一个缓存。lineage冻结当时的who/what/when并保持immutable；effect仍必须通过`trusted_effect_approvals`重验live mapping、role、separation、expiry和invalidation。统一denormalized lineage让Case 8无需按飞书低风险、飞书高风险、GitHub分别猜join路径，也使可回放恢复只需沿稳定ID核对，不依赖Workflow history或Agent session。
- 遗留：真实测试需要一条已验签飞书审批事件和一条真实GitHub review/Environment审批，各自核对平台安全event/reviewer/time、D1 source/receipt/approval/lineage ID与Case 8报告；相同event重投必须收敛，换event/snapshot不能串联。当前没有外部tenant/repository授权，不能替代。下一轮只处理Phase 2“监控adapter只创建candidate/triage、不自动获得repo write；相同告警指纹在抑制窗口内合并”。

## Round 77 — 2026-07-26
- 目标：Phase 2 / 监控adapter（若启用）只创建candidate/triage，不自动获得repo write；相同告警指纹在抑制窗口内合并。本轮闭环本地generic HMAC adapter、D1 sliding suppression、私有R2与operations安全查询；真实监控供应商外部事实或明确N/A决策保持未完成。
- 前置与权限：仅读取本地delivery-loop与Watt固定commit`476e3cd`，使用本地Node/workerd/D1/R2、合成签名alert、Secret canary与Wrangler dry-run。未访问或修改真实Cloudflare、Prometheus/Grafana/Sentry、GitHub、飞书、日志、数据库或tool-bridge，未发送真实告警、创建Task/Run、触发Action/Workflow或部署，未使用真实Secret。按用户要求未更新llmdoc。
- Watt直接复用：完整读取`packages/core/src/event/dedupe.ts`及全部边界测试、`eventbus/hmac.ts`与constants。直接复制`DEFAULT_DEDUPE_WINDOW_MS=24h`、`DedupeStore/InMemoryDedupeStore/resolveDedupe`及same/different key、exact edge、过1毫秒和default oracle；保持`now-storedAt <= window`仍命中。monitor HMAC直接复制exact-body HMAC-SHA256、lowercase hex解析与常量时间比较，只把header适配为`X-Delivery-Loop-Monitor-Signature`。Watt内存store不是多isolate权威，没有monitor candidate/allowlist/R2/权限边界，生产并发部分由D1新增。
- 动作：
  - 先新增Node与workerd验收：受信配置fail-closed、strict body、服务端fingerprint、HMAC、Watt窗口边界、20路不同event合并、三次同event重放、同event换内容、错误签名、未知adapter、越repository allowlist、caller authority、Secret、过期source time、operations查询、candidate防篡改及Task/Run/approval/outbox零行。首次Node按预期failed suite / 0 tests，缺`src/domain/dedupe`；workerd同样failed suite / 0 tests，缺monitor ingress store。
  - 新增strict `MonitorAlertWebhookV1`：只有event/time/firing及rule/resource/repository/environment/severity/title/description；`fingerprint/policy/effect/Task/approval`因strict schema无入口。受信profile固定generic adapter、tenant、repository allowlist和60秒～24小时窗口；全部配置缺失表示关闭，部分/非法配置503，body不能选择profile或窗口。
  - HMAC在JSON解析前验证最大256 KiB exact raw body；source time限制过去24小时/未来5分钟。完整规范化snapshot先扫描所有Worker配置Secret，再写`TASK_OBJECTS/monitor-alerts/`私有immutable R2；D1与响应不保存/返回raw body、title、description、resource或Secret finding。
  - 服务端fingerprint覆盖adapter/tenant/profile digest/rule/resource/repository/environment/severity，排除event ID/time/展示正文。migration 0050新增immutable receipt/lineage、current suppression head与triaging candidate；新receipt trigger在同一D1事务原子upsert head、投影candidate、追加lineage。窗口内candidate occurrence+1/lastSeen单调前进，exact edge仍合并，1毫秒后切新candidate；candidate identity不可UPDATE。
  - monitor producer物理不调用Task normalizer/intake，也没有Task/Run/policy/effect/approval/outbox列。operations-only `GET /v1/triage/monitor`只返回adapter/tenant/repository/rule/environment/severity、窗口、计数与时间，拒绝未知query且不返回fingerprint/profile/snapshot/resource/R2 ref或正文。新monitor Secret同时注册到Task/context/Plan/checkpoint/review/card等既有正文producer的scanner列表，避免新增Secret从其他出口泄漏。
  - 初次D1实现后workerd 3/3失败：首个receipt触发器同时写head/candidate/lineage，使SQLite `meta.changes`大于1，代码错误地把非1视为duplicate；改为`changes=0`才是event duplicate，`>0`再按lineage ordinal判created/suppressed，未放宽任何binding。随后3/3通过。
  - 同步Proto、Architecture、Security、Reference和DOD；本地子项已勾，父项保留“真实供应商启用证据”或“owner明确不启用且生产配置全缺”的外部决策证据。
- 验证：
  - 红灯`pnpm exec vitest run test/monitor-alert.test.ts` → exit 1，failed suite / 0 tests，缺Watt-derived dedupe模块；红灯workerd单文件 → exit 1，failed suite / 0 tests，缺monitor ingress store。
  - 最终Node/相邻聚焦`monitor-alert + task + redaction` → exit 0，3 files / 16 tests；最终workerd/相邻聚焦`monitor + Meegle + Feishu ingress/card + supplemental context + task intake` → exit 0，6 files / 27 tests。
  - `pnpm run typecheck`、`pnpm run lint`、`pnpm run verify:docs`与`git diff --check` → exit 0。
  - `pnpm run verify` → exit 0；typecheck、ESLint、Node 57 files / 186 tests、workerd 55 files / 291 tests、266个生产文件Secret scan和Markdown links全绿。workerd只输出既有预期Workflow terminate清理信息，无失败suite。
  - `CI=1 WRANGLER_SEND_METRICS=false pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round77-20260726-final` → exit 0，bundle 2468.16 KiB / gzip 415.35 KiB，双Workflow、两Queue、D1与四R2 binding识别成功，未部署。
- 勾选：只勾Phase 2该DoD下“本地Node/workerd/D1/R2契约”子项；父项与真实监控供应商/生产N/A决策事实保持未勾。generic HMAC fixture不能证明Prometheus/Grafana/Sentry原生签名、重试和字段映射。
- 决策沉淀：monitor event receipt与alert fingerprint是两层identity：event去重防同delivery重复计数，fingerprint suppression把不同occurrence合并为一个人工triage候选。candidate不是低权限Task，而是Task之前的独立事实；只要入口不创建Task/Run/Plan，就不存在“先给只读、以后意外继承write”的隐式authority。Watt纯函数适合作为窗口oracle，D1 trigger才是多Worker可恢复并发真源。
- 遗留：若生产决定启用监控，需先选定一个真实provider并核对原生签名/重试/event identity/字段映射，受控发送同fingerprint三次及过窗一次，记录安全event ID/time、candidate/lineage/count和零Task/Run/effect；若决定不启用，需由owner记录N/A并证明生产四项monitor配置全缺。下一轮只处理Phase 2“飞书API限流/超时触发outbox重试、状态不回退、卡片可人工刷新修复”。

## Round 78 — 2026-07-26
- 目标：Phase 2 / 飞书API限流或超时触发outbox重试，持久状态不回退，terminal或不可修复的最终卡片可由人工安全刷新。本轮闭环本地Node/workerd/D1/operations契约；真实飞书tenant限流、timeout、token refresh与人工恢复事实保持未完成。
- 前置与权限：仅读取本地delivery-loop与Watt固定commit`476e3cd`，使用合成fetch、fake Feishu effects、本地workerd/D1、operations测试identity、Secret scan和Wrangler dry-run。未访问或修改真实Cloudflare/GitHub/飞书、日志、数据库或tool-bridge，未发送卡片、调用真实Feishu API、触发Action/Workflow、部署、提交代码或使用真实Secret；未保存raw response、card body、token或数据库行。按用户要求未更新llmdoc。
- Watt直接复用：完整读取`packages/gateway/src/event/plugin-sender.ts`与`agent-deliverer.ts`以及`packages/plugin-feishu/src/adapter/send.ts`。直接复制`SEND_TIMEOUT_MS = 10_000`和逐request `AbortSignal.timeout`边界，保持429/5xx/timeout/network retryable；继续复用此前已从Watt迁入的token cache/invalid-code/UUID以及fenced outbox“effect成功才settle、失败rollback pending”语义。Watt会传播generic `msg/error`的路径没有复制；Watt也没有D1 card revision/delivery单调账本或人工刷新控制面，这部分由本项目补齐。
- 动作：
  - 先写红灯：挂起fetch必须abort并返回固定`feishu_api_timeout`；rate limit与timeout两次失败后同一outbox仍pending且保存各自安全码；latest/delivered revision、active message与delivery count不回退；20路operations刷新只一request/presentation/outbox。首次Node 1/8失败并在5秒test timeout结束，证明此前没有AbortSignal；workerd 6/6因缺refresh request表失败。
  - `FeishuDeliveryCardApiClient`对token、create、PATCH和message GET均使用生产默认10秒的Watt bound，测试可注入更短正整数；abort/TimeoutError固定分类为`feishu_api_timeout`，不传播异常名。Feishu retryable error在进入共享fenced outbox前转换成固定`OutboxEffectError`，因此D1不再把rate-limit/timeout都压成generic unavailable。
  - migration 0051新增immutable `feishu_delivery_card_refresh_requests`，只冻结card/Run、expected presentation/revision/digest、固定operations principal和时间；presentation增加唯一、服务端生成且不渲染的`refresh_request_id`。D1 trigger重验snapshot与request绑定并拒绝UPDATE/JSON伪造，没有message/card/destination/effect/reason/正文列。
  - 新增operations-only `GET /v1/runs/:runId/feishu-card`，只返回latest/delivered presentation/outbox/message安全状态，不返回tenant/chat/card正文；`POST .../refresh` strict接受GET返回的current presentation/revision/digest。稳定request ID与canonical refresh epoch使20路同snapshot收敛；从未请求过的旧snapshot 409，accepted request可幂等回读。新presentation/outbox保留旧rejected delivery；request落库但HTTP中断时，scheduled candidate会继续完成投影。
  - transient限流/timeout仍只恢复原outbox，不创建refresh；人工refresh限定在terminal business reject或配置/平台修复后必须重建最终卡片。同步Proto、Architecture、Security、Reference、OperationsRunbook和DOD；只勾本地子项，真实tenant子项保持未勾。
- 验证：
  - 红灯`pnpm exec vitest run test/feishu-delivery-card.test.ts` → exit 1，1/8 failed，hung request在5秒test timeout结束；红灯workerd单文件 → exit 1，6/6 failed，固定错误`no such table: feishu_delivery_card_refresh_requests`。
  - 最终聚焦Node `feishu-delivery-card + feishu-run-status-card + operations-runbook` → exit 0，3 files / 16 tests；最终聚焦workerd `feishu-delivery-card + feishu-card-action + outbox-dead-letter + outbox-routing` → exit 0，4 files / 24 tests。覆盖token/API abort、rate-limit/timeout分类、三次同outbox尝试、状态单调、terminal reject刷新、20路收敛、旧snapshot/authority注入拒绝、cron中断恢复与相邻卡片/action/DLQ/route回归。
  - `pnpm run typecheck`、`pnpm run lint`、`pnpm run verify:docs`、operations runbook契约和`git diff --check` → exit 0。
  - `pnpm run verify` → exit 0；typecheck、ESLint、Node 57 files / 187 tests、workerd 55 files / 294 tests、268个生产文件Secret scan和Markdown links全绿。workerd只输出既有预期Workflow terminate清理信息，无失败suite。
  - `CI=1 WRANGLER_SEND_METRICS=false pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round78-20260726-final` → exit 0，bundle 2482.62 KiB / gzip 417.85 KiB，双Workflow、两Queue、D1与四R2 binding识别成功，未部署。
- 勾选：只勾Phase 2该DoD下“本地Node/workerd/D1契约”子项；父项与真实飞书tenant外部事实保持未勾。本地fake fetch/effects和workerd不能证明真实5 QPS/平台错误码、网络timeout、token refresh、消息可见性或群内唯一当前卡。
- 决策沉淀：retry与refresh是两种恢复语义。结果不确定或dependency暂不可用时必须保留同一outbox和幂等键；只有terminal reject/已确认不可修复的presentation才以current snapshot创建新的immutable epoch，旧失败事实不能被改写。人工操作本身也必须先落可回放intent，HTTP会话不是恢复真源；因此cron能从D1继续，而operator永远不需要也不能提交card或message effect。
- 遗留：真实测试tenant需在受控群实测同群/单卡5 QPS触发230020/230049或429、HTTP timeout、token失效刷新与后续成功，记录安全平台时间/ID、同outbox attempt/固定码和latest/delivered单调投影。再制造业务拒绝或不可修复最终卡，使用operations GET/refresh核对新request/presentation/outbox、最终message与群内唯一当前卡，并确认D1/log无token/raw response/card正文。当前没有外部tenant/chat授权，不能替代；下一轮按Phase顺序进入Phase 3首个仍未闭环的本地/外部证据项。

## Round 79 — 2026-07-26
- 目标：Phase 3 / 日志、Task、checkpoint、artifact、PR用canary Secret扫描全绿；redaction覆盖header、嵌套JSON、URL query和命令环境变量。本轮闭环控制面/Runner结构化日志、execution raw transcript真实本地producer、Draft PR effect前最终扫描与统一Worker Secret catalog；真实Action日志、远端R2和PR页面事实保持未完成。
- 前置与权限：仅本地Node/workerd/D1/R2、fake GitHub effect、合成Codex JSONL、Wrangler dry-run与Watt固定commit；未触发真实Action/PR、未调用计费模型、未访问业务日志/数据库/飞书/tool-bridge、未部署、未提交。未保存Secret、raw payload、transcript正文、日志正文或数据库行；按用户要求未更新llmdoc。
- Watt直接复用：完整读取`/Users/jishihe/tokenrollal/Watt@476e3cdd2490d725fde174e7c697ebf00899edc6`的`packages/gateway/src/secrets/secret-store.ts`，直接复制base64url encode/decode、32-byte AES-256 key import、随机12-byte IV、AES-GCM与AAD绑定结构。Watt没有Attempt/Plan/Item fencing、D1 recoverable artifact upload、Runner transcript producer、Worker credential全集catalog、结构化Runner日志或PR effect前重扫；这些delivery-loop语义明确为新增，没有把它们倒称为Watt代码。
- 动作：
  - 审计发现Task/checkpoint/Feishu/monitor/PR等producer各自手写Secret列表，新增credential可能漏扫；PR只在prepared阶段扫描，GitHub effect前不重验当前配置；`RAW_AGENT_OBJECTS`只有retention fixture无producer；控制面存在多处direct console，六个Runner入口输出非统一文本。
  - 先补负向测试。首次Node suite因缺`runtime-secrets`直接failed；首次workerd 4 files / 20 tests有4项红灯：checkpoint错误接受Feishu Secret、Task错误接受operations Secret、PR扫描缺失且调用fake GitHub、artifact API 404。实现后统一由`configuredSecrets`覆盖全部Worker plaintext credential，新增配置不再修改各producer列表。
  - 新增唯一`secureStructuredLogSink`：递归redaction后再次Secret scan，控制面除该文件外direct `console.*`归零；case8/correlation/stuck/dead-letter/Feishu refresh/Worker error均改用固定schema。六个Runner入口只调用`writeRunnerStructuredLog`，event为TypeScript固定集合，输出只有component/level/event/outcome/安全Attempt ID/time的一行JSON，不接受Agent、Task、响应或错误正文。
  - 新增strict artifact request与`artifact:write` execution scope。`RawAgentArtifactStore`按active running implement/review_fix、exact execution scopes、Attempt version/generation/lease/token、active Plan/Item双层fence；Runner先扫描全部轮换token/敏感环境值，控制面再扫描当前token+唯一Worker catalog。plaintext不入D1；Watt-derived AES-256-GCM ciphertext写专用私有`RAW_AGENT_OBJECTS`，D1只登记ciphertext identity/size/etag/30天policy。
  - migration 0052新增`raw_agent_artifact_uploads` pending→delivering→complete与30秒lease。恢复性复核发现若把expectedVersion固化为upload identity，R2成功后响应中断再遇heartbeat会永久冲突；最终只固化lease generation，每次请求仍用当前version鉴权。测试证明旧version拒绝，而同generation在heartbeat version前进后可重放同一stable UUID/content并复用唯一ciphertext对象。
  - `CodexExecutionAdapter`把同一有界JSONL同时送usage accumulator与Runner transcript callback；Runner只接受JSON object line、最多512 KiB，在Agent decision后且commit/push前以当前fencing调用artifact API。集成测试证明transcript正文只出现在专用artifact请求，不进入其他控制面请求或Runner结果日志。
  - Draft PR processor从runtime注入当前完整Secret catalog，在exact publication/approval/body digest重验后、真正GitHub list/create前再次扫描title/body；命中`pull_request_secret_detected`安全settle且fake GitHub effect为零。同步Proto、Architecture、Security、Reference、OperationsRunbook与DOD；父DoD拆为已勾本地producer契约和未勾真实GitHub事实。
- 验证：
  - 首次`pnpm run typecheck` → exit 2，Watt-derived key bytes被TypeScript推断为`Uint8Array<ArrayBufferLike>`而不满足WebCrypto `BufferSource`；将base64url decoder与key变量收紧为真实`ArrayBuffer`后通过，未改变加密实现。
  - 聚焦Node `operations-runbook + structured-log + redaction + codex-execution-adapter + execution-runner-bootstrap` → exit 0，5 files / 23 tests；聚焦workerd `raw-agent-artifact + github-pull-request + checkpoint-api + task-api + repo-write-credential` → exit 0，5 files / 29 tests。
  - 第一次全量`pnpm run verify` → exit 1：Node 58 files / 191 tests全绿，workerd仅`repo-write-credential` 9项因旧手写完整execution scope缺`artifact:write`而正确fail-closed；只把该完整scope fixture改为共享`EXECUTION_TOOL_ACTIONS`，保留故意模拟简化checkpoint scope的负向夹具，单文件9/9通过。
  - 最终`pnpm run verify` → exit 0；typecheck、ESLint、Node 58 files / 192 tests、workerd 56 files / 298 tests、274个生产文件Secret scan与Markdown links全绿。workerd只输出既有预期Workflow terminate清理信息，无失败suite。
  - 初次dry-run组合命令包含临时目录`rm -rf`而在进程创建前被安全策略拒绝，未执行删除或构建；改用新目录后`CI=1 WRANGLER_SEND_METRICS=false pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round79-20260726-final-v2` → exit 0，bundle 2503.92 KiB / gzip 421.94 KiB，双Workflow、两Queue、D1与四R2 binding识别成功，未部署。
  - `pnpm run verify:docs`、operations runbook契约与`git diff --check` → exit 0。
- 勾选：Phase 3该DoD下新增并勾选“本地控制面/Runner/producer契约”子项；父项与真实GitHub外部事实保持未勾。本地fake GitHub/workerd/R2、合成JSONL与dry-run不能证明真实Action log、远端ciphertext registry或PR页面零泄漏。
- 决策沉淀：redactor与scanner职责分离：redactor负责安全输出，scanner负责持久化/发布前fail-closed，日志必须redact后再scan。Secret catalog必须是配置层单一真源，不能让producer各自猜列表。raw transcript是短期加密诊断对象，不是状态真源或恢复checkpoint；Git/checkpoint仍负责恢复。artifact upload identity跨heartbeat稳定但generation不跨Attempt租约；PR prepared快照安全不代表effect时仍安全，因此外部写前必须按当前credential集合再验。
- 遗留：真实验收需先配置远端试点repo、GitHub App/Actions、部署Worker/D1/R2及`RAW_AGENT_ARTIFACT_ENCRYPTION_KEY`。在受控Action注入canary，核对完整Action log、远端raw ciphertext/registry和D1投影零明文；再产生一份安全Draft PR与一份命中canary的blocked publication，核对真实PR页面/API只有前者且无第二GitHub effect。当前无remote且D1 ID为占位值，不能替代；下一轮若仍无外部资源应明确停在该blocker，不追加fake证据冒充完成。

## Round 80 — 2026-07-26
- 目标：Phase 3 / Agent Adapter的start/resume/interrupt/exportCheckpoint契约通过并至少接通一个真实非交互Agent CLI。本轮补齐显式opt-in真实Codex验收入口并尝试真实已配置credential调用；provider拒绝现有key，因此真实调用子项保持未完成。
- 前置与权限：本地Codex CLI、临时只读Git repo、Node测试与Watt固定commit；显式运行真实模型入口但未得到成功采样，未触发GitHub/Cloudflare/飞书/tool-bridge、未读取业务日志/数据库、未写当前仓库、未部署或提交。credential值、provider stderr、模型正文、临时路径和session ID均未写PROGRESS；按用户要求未更新llmdoc。
- Watt复用：直接沿用Watt`476e3cdd2490d725fde174e7c697ebf00899edc6`的`scripts/e2e/lib.ts`显式消耗门控和0/1/2退出纪律：0=真实事实通过、1=断言/运行事实失败、2=opt-in或credential等前置缺失。Watt的通用`runE2e/CliFailure`会输出Watt CLI stderr且绑定其token/base URL，不适合直接复制到Agent credential路径；本项目保留相同分层但只输出固定错误码，避免传播Codex stderr。
- 动作：
  - 先把session adapter测试提升为必须携带`--output-schema`。首次聚焦运行exit 1，1/4 failed，现有argv缺该参数；随后新增strict `AgentSessionResultV1={schemaVersion:'1',status:'checkpoint_ready'}` Zod/JSON Schema，额外字段和自由summary拒绝。
  - `CodexSessionAdapter`构造时固定trusted output schema路径，start/resume都使用相同`--ephemeral --ignore-user-config --sandbox read-only --approval never --output-schema`，启动前核对schema为有界regular file；prompt只要求返回schema对象。既有start/resume/interrupt/export与recovery测试全部改用同一schema，没有新增provider session依赖。
  - 新增`pnpm run e2e:codex-adapter`。默认未设置`DELIVERY_LOOP_CODEX_ADAPTER_E2E=1`时在认证/模型前exit 2；opt-in后只创建临时repo/context/output，固定提交一份无业务内容fixture，使用真实`CodexSessionAdapter.start`，立即记录Runner-controlled checkpoint sequence 2并等待provider。成功必须同时满足exit 0、strict final JSON、checkpoint digest、同HEAD和clean tree；stdout只含CLI version、exit、SHA/digest、sequence与布尔值，finally删除本轮临时目录。
  - `codex login status`显示本机保存了API key，但它不能证明provider接受。首次真实opt-in进程启动后exit 1；一次临时、已由command runtime按敏感环境值脱敏的诊断确认固定失败指纹为`invalid_api_key/401`，随即移除诊断输出。最终实现把该指纹归类为credential前置缺失，只输出`codex_authentication_invalid`并exit 2；没有把进程启动或本地login status冒充成功模型调用。
  - 同步Proto/Security/Reference/DOD：新增并勾显式opt-in验收入口子项，父DoD与“已认证真实调用”子项保持未勾；更新PROGRESS blocker要求用户重新认证，代码不会自行生成或替换credential。
- 验证：
  - 红灯`pnpm exec vitest run test/codex-session-adapter.test.ts` → exit 1，1/4 failed，明确缺`--output-schema`；实现后`codex-session-adapter + recovery-runner + real verifier` → exit 0，3 files / 8 tests。
  - 默认`pnpm run e2e:codex-adapter` → exit 2，固定`opt-in missing`且零认证/模型调用；最终opt-in`DELIVERY_LOOP_CODEX_ADAPTER_E2E=1 pnpm run e2e:codex-adapter` → exit 2，固定`prerequisite missing codex_authentication_invalid`，没有输出credential/provider stderr/model正文。该结果是可信前置失败，不是通过证据。
  - `pnpm run verify` → exit 0；typecheck、ESLint、Node 59 files / 194 tests、workerd 56 files / 298 tests、277个生产文件Secret scan与Markdown links全绿。workerd只输出既有预期Workflow terminate清理信息，无失败suite。
  - `CI=1 WRANGLER_SEND_METRICS=false pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round80-20260726-final` → exit 0，bundle 2503.92 KiB / gzip 421.94 KiB，双Workflow、两Queue、D1与四R2 binding识别成功，未部署。
  - `git diff --check`与文档链接检查 → exit 0。
- 勾选：只新增并勾Agent Adapter下“显式opt-in真实CLI验收入口”本地子项；父项和真实已认证调用保持未勾。真实Codex进程启动、CLI help/login status、invalid credential或fake launcher都不能替代exit 0+strict output+checkpoint+clean Git证据。
- 决策沉淀：credential“已配置”与“当前有效”是两种事实，`login status`不能做认证oracle；唯一成功判据是provider实际采样exit 0。模型最终输出与持久checkpoint也必须分层：JSON Schema证明provider transport结构化，checkpoint只能由Runner单调记录，模型不能直接推进恢复状态。opt-in verifier使用临时只读repo隔离消耗与业务数据，并复用Watt 0/1/2纪律区分事实失败和前置缺失。
- 遗留：需要用户通过Codex CLI重新登录或配置一个有效API key，且不得把key发到聊天、argv、PROGRESS或仓库。完成后只需重跑`DELIVERY_LOOP_CODEX_ADAPTER_E2E=1 pnpm run e2e:codex-adapter`；exit 0安全JSON摘要可支持勾真实调用子项。真实GitHub Action仍由后续独立外部DoD验收。

## Round 81 — 2026-07-26
- 目标：Phase 3 / 在真实试点repo强制终止执行中GitHub Action，新Attempt从外部Git commit + checkpoint恢复且不重复已passed Item。本轮补齐真实外部证据契约、一键只读verifier与安全查询投影；因无remote/部署/有效credential，真实Action演练保持未完成。
- 前置与权限：仅本地Node/workerd/D1/R2 fixture、fake HTTPS response、Watt固定commit、文档检查与Wrangler dry-run；未访问或修改真实GitHub/Cloudflare/飞书/tool-bridge、业务日志或数据库，未触发/取消Action、未调用模型、未部署、未提交。未保存token、raw API/Action log、checkpoint/Agent/Task正文或数据库行；按用户要求未更新llmdoc。
- Watt直接复用：继续固定`/Users/jishihe/tokenrollal/Watt@476e3cdd2490d725fde174e7c697ebf00899edc6`。`verify-runner-recovery-evidence.ts`直接复制项目内Round 59从Watt`scripts/e2e/lib.ts`派生的Pilot命令骨架：显式opt-in、仓库外64 KiB manifest、0/1/2退出分层和固定安全错误；response读取直接复用本项目已迁移/强化过的tool-bridge流式上限实现。Watt没有delivery-loop的Attempt/Plan/Item/checkpoint/GitHub run lineage，可直接复制的业务断言为零，没有虚构来源。
- 动作：
  - 审计`e2e:pilot`确认它只验test/production deployment、acceptance与rollback，不能证明Runner kill/recovery；保留Pilot manifest v1不做破坏性扩展，新增独立`RunnerRecoveryEvidenceManifestV1`。
  - 真实验收需要从D1证明replacement来源，但既有Plan查询未公开Attempt branch/head/recovery lineage。先扩展`checkpoint-api`红灯断言；首次聚焦为1/8 failed，明确缺`headBranch/headSha/recovery`。随后`TaskQueryStore`只增加安全标量投影与SQL列，不读取checkpoint R2正文、lease/token或provider session；与task query联合复验11/11。
  - manifest strict绑定repository、Run/Plan/两个不同Item、lost/replacement Attempt与不同Action、ordinal、workflow SHA、checkpoint ID/sequence/digest/branch/head、result head及verification/Evidence；replacement ordinal必须推进，result SHA不能等于checkpoint SHA，passed Evidence ID唯一，未知字段拒绝。
  - live verifier有界读取并交叉核对`GET /v1/runs/:runId/plan`、correlation查询、两条GitHub Actions run/jobs、两个commit、branch ref与GitHub compare。旧Attempt必须lost且old Action/job/execution step为cancelled；replacement必须completed/success并精确绑定recovery lineage、checkpoint branch/head和result Evidence；branch必须指向result，checkpoint必须是base/merge-base且result只ahead不behind，拒绝两个无关SHA；lost ordinal之后任何此前passed Item Attempt或replacement Evidence均fail-closed。origin只允许安全HTTPS，错误与summary不传播token/raw response。
  - 新增`pnpm run e2e:runner-recovery`、example schema与`docs/RunnerRecoveryE2E.md`。命令默认在任何manifest/network前exit 2；opt-in但配置不完整同样是前置缺失。exit 0只验已发生事实，不会执行kill/retry/dispatch，也不能单独关闭真实DoD。
  - 同步Proto、Architecture、Security、Reference与DOD；只勾“真实外部证据验收契约”本地子项，父项和真实Action子项保持未勾。
- 验证：
  - 红灯`pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/checkpoint-api.test.ts` → exit 1，1/8 failed，缺失安全recovery投影；实现后与`task-query-api`联合 → exit 0，2 files / 11 tests。
  - `pnpm exec vitest run test/runner-recovery-evidence.test.ts` → exit 0，1 file / 7 tests；覆盖example/strict/cross-field、完整Plan/correlation/Action/job/commit/branch/compare穿透、旧Action/新Action/job错误、branch未指向result/diverged history、passed Item重跑、512 KiB流式上限、raw canary/token零传播及默认exit 2。
  - `pnpm run e2e:runner-recovery`（无opt-in）→ exit 2，固定`opt-in missing`；`DELIVERY_LOOP_RUNNER_RECOVERY_E2E=1 pnpm run e2e:runner-recovery`（无真实配置）→ exit 2，固定`required recovery configuration is incomplete`。两条路径均在manifest/network前结束，不是skip或成功。
  - 聚焦后`pnpm run typecheck`、`pnpm run lint`、`pnpm run verify:docs`和`git diff --check`均exit 0。
  - `pnpm run verify` → exit 0；typecheck、ESLint、Node 60 files / 201 tests、workerd 56 files / 298 tests、281个生产文件Secret scan和Markdown links全绿。workerd只有既有预期Workflow terminate清理输出，无失败suite。
  - `CI=1 WRANGLER_SEND_METRICS=false pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round81-20260726-final-v2` → exit 0，bundle 2504.41 KiB / gzip 422.03 KiB，双Workflow、双Queue、D1与四R2 binding识别成功，未部署。
- 勾选：Phase 3 Runner kill recovery下新增并勾“真实外部证据验收契约”子项；父项与“在真实试点repo强制终止Action”保持未勾。fake API、schema-valid example、dry-run和默认exit 2都不能替代两条真实Action/Git commit/live D1证据。
- 决策沉淀：真实恢复与Phase 5 deployment Pilot是不同事实，不能用同一manifest把边界揉在一起。恢复证据必须同时回答control-plane lineage、平台Action结论、Git commit存在和passed Item零重跑；只证明“新Action成功”不足。查询投影是外部可审计契约的一部分，但只能增加恢复所需branch/SHA/ID，不能为验收方便暴露checkpoint正文或credential。verifier保持只读，执行恢复仍走正常权限/审批/dispatcher。
- 遗留：当前`git remote -v`为空，Wrangler D1 ID仍为占位值，Codex credential仍被provider拒绝。需要用户确认/提供试点GitHub repo与App/Actions权限、已部署控制面origin/D1/R2、有效Agent credential及受控Actions预算；随后按`docs/RunnerRecoveryE2E.md`真实取消old Action、完成replacement Action，把仓库外manifest和短期只读token注入受控环境运行`DELIVERY_LOOP_RUNNER_RECOVERY_E2E=1 pnpm run e2e:runner-recovery`。只有exit 0、Actions/commit URL和人工取消时序审计入账后才能勾真实子项。

## Round 82 — 2026-07-26
- 目标：Phase 3 / 受控replay校验expected Run version、稳定verification Plan Item、外部副作用和审批；真实重放不得重复dispatch/PR/deploy。本轮修复真实终态Plan Item step不可达问题，并补Case 8安全证据、仓库外manifest与一键只读verifier；真实Cloudflare/GitHub replay保持未完成。
- 前置与权限：仅本地Node/workerd/D1、fake HTTPS response、Watt固定commit、Wrangler dry-run与文档检查；未访问/修改真实GitHub、Cloudflare账户、飞书、tool-bridge、业务日志或数据库，未触发Action/PR/deployment/restart、未调用模型、未部署或提交。未保存token、raw API/日志、replay reason、PR/Evidence/Task正文或数据库行；按用户要求未更新llmdoc。
- Watt直接复用：继续固定`/Users/jishihe/tokenrollal/Watt@476e3cdd2490d725fde174e7c697ebf00899edc6`。`verify-controlled-replay-evidence.ts`直接复制项目内Round 59/81从Watt`scripts/e2e/lib.ts`派生的显式opt-in、仓库外64 KiB manifest、0/1/2退出和固定安全错误骨架；HTTP读取继续直接复用本项目Watt-derived tool-bridge流式上限实现。Watt没有ExecutionPlan Item、effect approval snapshot、external reconciliation或GitHub stable PR/Deployment identity，对应业务断言为delivery-loop新增，没有虚构为Watt代码。
- 动作：
  - 审计发现D1已保存`workflow_replays/effects/reconciliations`，但Plan/Case 8/correlation都不公开replay expected version、stable target、effect/approval、snapshot或restart事实。先向Case 8测试加入`checks.replays`；首次聚焦exit 1，1/2 failed，报告明确缺整个replay投影。
  - Case 8新增D1-only白名单replay投影：ID/version/Plan/Item/target、reason/effect digest、restart time、唯一replay outbox安全状态、effects/approval和reconciliations。每个outbox/Evidence source在读时按生产同一canonical shape重算digest；孤儿/重复replay outbox、source变化、超500行或非法错误码fail-closed。另公开当前全部dispatch/PR/deploy effect outbox的ID/kind/state/time，供验收证明replay前后intent集合精确不增；不选reason正文、payload/dedupe key、Evidence URL/summary或lease。
  - 审计真实生产SQL发现production success把Plan从`active`置`completed`，而scheduler只接受active；既有fixture错误使用不可达的`succeeded + active Plan`。把fixture改为completed后红灯exit 1，2/3 failed，真实Plan Item replay均409。修复后只新增`succeeded Run + completed Plan + plan_item`边界；completed Plan的analysis system step、failed Run仍409，active Plan既有语义不变。
  - `DeliveryRunWorkflow`在Run终态后以`load-terminal-verification-steps`从D1读取最多200个`verification + passed progress + current passed decision` Item，再执行稳定`plan-v<version>-item-<id>-verify`。每个step用单条`INSERT ... SELECT`重验Run/Plan/status/progress/decision并记录current Run version，零外部effect。真实workerd初次终态写version 8，replay从Item step restart后写version 9，原dispatch/PR outbox数量不变；因此外部演练target真实存在，不再依赖fake restart client。
  - 新增strict`ControlledReplayEvidenceManifestV1`：最长七天窗口、post/expected Run version、Plan/Item、按effect排序approval snapshot、全部dispatch outbox、原Agent Actions、单PR和至少一个Deployment；repo-write/deploy effect为必需且mutating effect必须approval。未知字段、重复identity、错误时间/环境/版本拒绝。
  - live verifier读取Case 8与correlation，重算effect snapshot digest，核对approval在restart时有效、merge/production identity separation、effect outbox/current snapshot集合精确相等、Action/PR/deploy控制面identity无增量；再用GitHub只读API核对七天窗口内每个attempt稳定title只有一个、同head PR只有一个、每个stable deployment ID只有一个且最新status success。分页、额外pending dispatch、过期/非法approval、raw/超1 MiB响应均固定code失败，summary/token零传播。
  - 新增`pnpm run e2e:controlled-replay`、example schema和`docs/ControlledReplayE2E.md`；默认或缺真实配置均在manifest/network前exit 2。同步Architecture/Proto/Security/Reference/DOD；只勾真实外部证据验收契约子项，父项和真实restart仍未勾。
- 验证：
  - 红灯`pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/case8-audit-report.test.ts` → exit 1，1/2 failed，缺`checks.replays`；实现后exit 0，2/2。
  - 红灯`pnpm exec vitest run test/controlled-replay-evidence.test.ts` → exit 1，failed suite / 0 tests，目标domain模块不存在；实现后exit 0，1 file / 6 tests。
  - 红灯`pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/controlled-replay.test.ts`在真实completed Plan fixture下 → exit 1，2/3 failed；修复后与Case 8、基础Workflow联合 → exit 0，3 files / 6 tests。覆盖真实workerd dynamic verification restart、completed/system与failed/Plan Item边界、20路CAS、approval过期、source digest和effect outbox投影。
  - Node verifier覆盖strict/cross-field/example、success、额外control-plane/Action/PR/Deployment/current dispatch、approval过期/非法时间、GitHub分页、raw canary/1 MiB上限/token零传播及默认CLI exit 2。
  - `pnpm run e2e:controlled-replay`（无opt-in）→ exit 2，固定`opt-in missing`；`DELIVERY_LOOP_CONTROLLED_REPLAY_E2E=1 pnpm run e2e:controlled-replay`（无真实配置）→ exit 2，固定`required replay configuration is incomplete`。两条均在manifest/network前结束，不是skip或成功。
  - `pnpm run verify` → exit 0；typecheck、ESLint、Node 61 files / 207 tests、workerd 56 files / 298 tests、285个生产文件Secret scan和Markdown links全绿。workerd只有既有预期Workflow terminate清理输出，无失败suite。
  - `CI=1 WRANGLER_SEND_METRICS=false pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round82-20260726-final` → exit 0，bundle 2517.64 KiB / gzip 424.48 KiB，双Workflow、双Queue、D1与四R2 binding识别成功，未部署。
  - `pnpm run typecheck`、`pnpm run lint`、`pnpm run verify:docs`与`git diff --check`均exit 0。
- 勾选：Phase 3 controlled replay下强化本地workerd子项并新增勾选“真实外部证据验收契约”；父项与Phase 4/5真实PR/deployment replay子项保持未勾。fake GitHub、schema example、local workerd、dry-run与默认exit 2不能替代真实Cloudflare restart和GitHub inventory。
- 决策沉淀：verifier不能补救不可达的生产路径，必须先从终态producer反查真实Plan状态；“测试构造可运行”不等于真实状态机可达。verification replay step必须位于外部effect之后且自身只读D1，才能让Cloudflare replay缓存语义真正阻止重复副作用。snapshot只证明重启前，current effect outbox集合再与snapshot精确相等才能证明重启后没有新增pending intent。completed Plan不是一般active authority，只为succeeded Run的current verification Item提供最窄replay例外。
- 遗留：当前无Git remote，Wrangler D1 ID仍为占位值，Codex credential仍无效，也没有真实成功PR/deployment Run。需要用户提供试点repo/App/Actions、已部署当前Worker/Workflow/D1/R2、有效Agent credential和未过期replay approvals；按`docs/ControlledReplayE2E.md`完成真实Run后从verification Item replay，把仓库外manifest与三种用途隔离只读token注入受控环境运行`DELIVERY_LOOP_CONTROLLED_REPLAY_E2E=1 pnpm run e2e:controlled-replay`。只有exit 0、Cloudflare restart/step证据及Action/PR/Deployment URL入账后才能勾真实子项。

## Round 83 — 2026-07-26
- 目标：Phase 3 / 同一失败指纹连续2次或总Attempt达3次后blocked，真实飞书卡片展示已尝试路径与所需人工输入且不拼接Runner原始错误。本轮只补真实外部证据验收契约和live digest查询；真实tenant演练保持未完成。
- 前置与权限：仅读取本地delivery-loop与Watt固定commit`476e3cd`，使用本地Node/workerd/D1 fake HTTPS response、文档检查与Wrangler dry-run。未访问/修改真实Cloudflare、飞书、GitHub、tool-bridge、业务日志或数据库，未制造真实Runner失败、发送/PATCH/GET真实卡片、部署、提交或使用真实Secret；按用户要求未更新llmdoc，未保存raw Runner/飞书正文、token、数据库行或截图。
- Watt直接复用：`verify-failure-blocker-card-evidence.ts`直接复制项目内Round 59/81/82从Watt`scripts/e2e/lib.ts@476e3cd`迁入的显式opt-in、仓库外64 KiB manifest、0/1/2退出分层和固定安全错误骨架；HTTP继续直接复用既有Watt-derived有界流式reader。Watt generic Feishu sender没有failure fingerprint/retry scope/blocker ledger、strict card presentation或Message GET三方证据断言，对应业务核对为delivery-loop新增，没有虚构为Watt复制。
- 动作：
  - 审计确认Round 28已实现failure budget和Task/Run安全blocker projection，Round 58卡片v2也从同一D1 ledger投影固定path label/human prompt；缺口不是再次实现blocked，而是operations view只有presentation digest，无法把当前strict presentation与真实飞书card正文密码学绑定。
  - 先加Node live verifier和workerd operations断言。首次Node聚焦exit 1、failed suite / 0 tests，明确缺`failure-blocker-card-evidence` domain；首次workerd聚焦exit 1、1/7 failed，明确`latest.renderedDigest`为undefined。随后实现，没有把既有本地功能重复写一遍。
  - 卡片operations view现在从D1 latest immutable row经既有strict rehydrator和renderer重算canonical `renderedDigest`；响应仍只含ID/revision/digest/outbox/delivery安全标量，不返回presentation/card JSON、tenant/chat、正文或token。旧refresh exact三元组语义不变。
  - 新增strict `FailureBlockerCardEvidenceManifestV1`：冻结Task/Run/repository、blocker ID/reason/fingerprint digest、阈值计数、Attempt ID/ordinal/path code、人工输入code/time，以及presentation/rendered digest/outbox/message/app/tenant/chat/time；attempt数、计数、唯一ID、递增ordinal和两类阈值交叉约束，schema没有Runner error、正文、raw响应或credential入口。
  - 只读verifier用用途隔离token读取Task query、card operations view与飞书官方Message GET。Task blocker采用strict白名单schema并重验failure class、固定path label和human prompt；出现raw error/message/stack等额外字段即失败。卡片必须latest=delivered、outbox settled/attempt≥1/无error，真实message必须exact绑定interactive/non-deleted message/app/tenant/chat/time并与rendered digest一致。
  - live卡片只能有一个`Blocker`段，正文由live reason/count、按Attempt顺序去重的固定path label和固定human prompt精确重建；测试额外把manifest与rendered digest一起改成raw error正文，仍以`blocker_content_mismatch`失败，证明manifest不是authority。
  - 新增`pnpm run e2e:failure-blocker-card`、example manifest与`docs/FailureBlockerCardE2E.md`。命令默认或缺真实配置均在manifest/network前exit 2；exit 0只验已发生事实，不制造失败、不发送/PATCH卡片，也不能单独关闭真实tenant DoD。
  - 同步Architecture、Proto、Security、Reference和DOD；只勾“真实外部证据验收契约”，父项与真实tenant外部事实保持未勾。
- 验证：
  - 红灯Node命令`pnpm exec vitest run test/failure-blocker-card-evidence.test.ts` → exit 1，failed suite / 0 tests，缺domain模块；实现后最终与card renderer联合 → exit 0，2 files / 9 tests。
  - 红灯workerd命令`pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/feishu-delivery-card.test.ts` → exit 1，1/7 failed，缺rendered digest；实现后单文件7/7，和failure policy/verification repair联合 → exit 0，3 files / 16 tests。
  - `pnpm run e2e:failure-blocker-card`（无opt-in）→ exit 2，固定`opt-in missing`；设置opt-in但不提供真实配置 → exit 2，固定`required card configuration is incomplete`。两者均在manifest/network前结束，不是skip或成功。
  - `pnpm run verify` → exit 0；typecheck、ESLint、Node 62 files / 213 tests、workerd 56 files / 298 tests、289个生产文件Secret scan和Markdown links全绿。workerd只有既有预期Workflow terminate清理输出，无失败suite。
  - `CI=1 WRANGLER_SEND_METRICS=false pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round83-20260726-final` → exit 0，bundle 2518.31 KiB / gzip 424.60 KiB，双Workflow、双Queue、D1与四R2 binding识别成功，未部署。
  - `pnpm run lint`、`pnpm run verify:docs`与`git diff --check` → exit 0。聚焦后lint曾因新测试未使用常量exit 1，删除该无用常量后通过；产品逻辑未放宽。
- 勾选：Phase 3失败阈值DoD下新增并勾“真实外部证据验收契约”；父项和真实飞书tenant子项保持未勾。fake Message GET、schema-valid example、dry-run或默认exit 2都不能替代真实Runner阈值链路、bot消息与tenant权限事实。
- 决策沉淀：presentation digest证明D1对象，rendered-card digest才绑定实际发送JSON；两者不能混用。manifest只提供预期安全索引，verifier必须回读三个live事实源并从固定目录重建Blocker文案。digest一致仍不足以授权自由文案，因此增加独立语义断言。规范已同步，llmdoc按用户要求不更新。
- 遗留：当前没有已部署Worker、真实飞书测试tenant/app/chat、message GET scope/群membership或有效真实Runner/Action链路；Git remote仍为空，Wrangler D1 ID仍是占位值，Codex credential仍被provider拒绝。需要这些前置后按`docs/FailureBlockerCardE2E.md`分别完成同fingerprint两次与不同fingerprint第三次失败，记录仓库外manifest和短期用途隔离token，运行`DELIVERY_LOOP_FAILURE_BLOCKER_CARD_E2E=1 pnpm run e2e:failure-blocker-card`。只有exit 0、真实message/scope/membership和人工卡片核对入账后才能勾真实子项与父DoD。

## Round 84 — 2026-07-26
- 目标：Phase 2 / 飞书 API 限流/超时触发 outbox 重试，状态不回退，最终卡片可人工刷新修复。本轮补齐 retry history 安全投影、refresh lineage 查询和真实外部证据验收契约；真实飞书 tenant 压测/timeout/token refresh 保持未完成。
- 前置与权限：仅读取本地delivery-loop与Watt固定commit`476e3cd`，使用本地Node/workerd/D1 fake Feishu fetch、文档检查与Wrangler dry-run。未访问/修改真实飞书、Cloudflare、GitHub、tool-bridge、业务日志或数据库，未发送/PATCH真实卡片、触发Action/Workflow、部署、提交或使用真实Secret；未保存raw response、token、卡片正文或数据库行，按用户要求未更新llmdoc。
- Watt直接复用：`FencedOutboxProcessor`继续保留Watt-derived pending→delivering→settled lease语义；retry callback仅在本次D1 lease成功写回pending后触发。`verify-feishu-retry-evidence.ts`直接复用Watt `scripts/e2e/lib.ts@476e3cd`迁入的显式opt-in、仓库外64 KiB manifest、0/1/2退出和固定错误骨架；真实消息读取复用生产`FeishuDeliveryCardApiClient`与同一Watt-derived token cache，不复制第二套Feishu正文解析。Watt没有D1 retry ledger、delivery revision/refresh lineage或三方业务断言，这些是delivery-loop新增。
- 动作：
  - 先写红灯：workerd retry测试因`feishu_delivery_card_retry_observations`表不存在exit 1；Node verifier suite因domain模块不存在failed suite / 0 tests，确认现有`outbox.last_error_code`在最终成功后不足以证明曾发生限流/timeout/token refresh。
  - 新增migration `0053_feishu_card_retry_observations.sql`：只保存outbox/run/presentation、连续attempt、固定Feishu retry error和时间；`(outbox_id, attempt_count)`唯一，FK/CHECK/immutable trigger拒绝换绑定、未知错误和UPDATE，无HTTP status、上游msg、异常、body或token列。
  - 扩展通用fenced outbox retry callback，只有拥有lease且`delivering→pending`更新成功才调用；callback失败不改变重试语义。Feishu processor校验固定payload/kind/error后以canonical stable observation ID `INSERT OR IGNORE`写入，token-invalid被记录为可审计的refresh触发事实。
  - operations card view继续只投影安全标量，新增最多100条按时间/observation ID排序的Run级retry history，以及当前refresh request的expected snapshot、next presentation/digest/outbox/delivery state；旧latest/delivered/rendered digest和refresh POST权限语义不变。查询发现孤儿、非法时间/ID或refresh缺失时fail-closed。
  - 新增strict `FeishuRetryEvidenceManifestV1`与只读verifier：要求同一初始presentation/outbox的attempt连续，至少覆盖rate-limit、timeout、token-invalid三类；初始retry前后revision/message不回退；refresh必须绑定current expected snapshot并产生新presentation/outbox；最终operations settled/delivered和真实Feishu Message GET的app/tenant/chat/time/card digest必须完全匹配。manifest不能覆盖live历史，raw响应/token不进错误或summary。
  - 新增`pnpm run e2e:feishu-retry`、example manifest与`docs/FeishuRetryE2E.md`；默认或配置不完整均在manifest/network前exit 2，不执行retry、refresh、send、PATCH或token refresh。
  - 同步DOD、Proto、Architecture、Security、Reference；只勾本地D1/workerd与外部验收契约子项，真实tenant子项保持未勾。
- 验证：
  - 红灯`pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/feishu-delivery-card.test.ts` → exit 1，1/7 failed，缺retry observation表；实现后exit 0，7/7，覆盖rate-limit/timeout history、immutable trigger、refresh lineage。
  - 红灯`pnpm exec vitest run test/feishu-retry-evidence.test.ts` → exit 1，failed suite / 0 tests，缺domain模块；实现后exit 0，1 file / 5 tests，覆盖strict/example、三方success、历史/refresh/message漂移、raw/token零传播和CLI入口。
  - 聚焦`pnpm exec vitest run test/feishu-retry-evidence.test.ts test/failure-blocker-card-evidence.test.ts` → exit 0，2 files / 11 tests；workerd `feishu-delivery-card + feishu-card-action + outbox-routing + outbox-dead-letter` → exit 0，4 files / 24 tests。
  - `pnpm run e2e:feishu-retry`（无opt-in）→ exit 2，固定`opt-in missing`；设置opt-in但无真实配置 → exit 2，固定`required retry configuration is incomplete`。两条均在manifest/network前结束，不是skip或成功。
  - `pnpm run verify` → exit 0；typecheck、ESLint、Node 63 files / 218 tests、workerd 56 files / 298 tests、294个生产文件Secret scan和Markdown links全绿。workerd只有既有预期Workflow terminate清理输出，无失败suite。
  - `CI=1 WRANGLER_SEND_METRICS=false pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round84-20260726-final` → exit 0，bundle 2523.67 KiB / gzip 425.50 KiB，双Workflow、双Queue、D1与四R2 binding识别成功，未部署。
  - `pnpm run lint`、`pnpm run verify:docs`与`git diff --check` → exit 0。
- 勾选：Phase 2飞书限流/超时DoD下新增并勾“真实外部证据验收契约”；父项与真实飞书tenant事实保持未勾。fake Feishu、schema example、dry-run和默认exit 2不能替代真实5 QPS/230020或230049、网络timeout、token refresh、群内唯一当前卡和人工refresh事实。
- 决策沉淀：`last_error_code`是当前状态，不是历史证据；retry observation必须在lease-owned pending CAS之后写入且允许best-effort失败。retry与refresh仍是两种恢复语义：前者复用原outbox/identity，后者只从current snapshot产生新immutable epoch。真实verifier使用生产消息adapter而不是复制正文解析，避免协议漂移；manifest只做索引，三方live事实才是验收真源。
- 遗留：当前无真实飞书tenant/app/chat、5 QPS或平台错误码权限、HTTP timeout注入能力、message GET scope/群membership，也没有已部署Worker；Git remote为空、Wrangler D1 ID为占位值、Codex credential被provider拒绝。需要用户提供受控tenant和部署前置后，按`docs/FeishuRetryE2E.md`完成限流/timeout/token refresh与业务拒绝→operations refresh，记录仓库外manifest、平台安全ID、D1 retry/refresh摘要和最终Message链接，再运行`DELIVERY_LOOP_FEISHU_RETRY_E2E=1 pnpm run e2e:feishu-retry`。只有exit 0和人工群内唯一卡核对入账后才能勾真实子项与父DoD。

## Round 85 — 2026-07-26
- 目标：Phase 4 / PR 创建必须由 GitHub webhook/API 外部事实核对，Agent 自报 PR URL、number 或 status 不能推进 `pull_request_open`。本轮补齐 Case 8 安全 observation 投影、仓库外 strict manifest、只读 verifier 和真实验收手册；真实 GitHub App/PR/webhook 外部事实保持未完成。
- 前置与权限：只使用本地 delivery-loop、Watt 固定 commit `476e3cdd2490d725fde174e7c697ebf00899edc6`、fake HTTPS response、D1/workerd 测试、文档检查和 Wrangler dry-run。未访问或修改真实 GitHub、Cloudflare、飞书、tool-bridge、日志或业务数据库，未创建/修改真实 PR、未发送 webhook、未部署、未提交代码或使用真实 Secret；未在本记录保存 token、PR 正文、raw webhook/API response、Runner 输出或数据库行，按用户要求未更新 llmdoc。
- Watt 直接复用：`scripts/verify-github-pull-request-evidence.ts`沿用 Watt E2E 的显式 opt-in、仓库外 64 KiB manifest、固定 0/1/2 退出和固定安全错误输出；HTTP 读取复用本项目已有 Watt-derived 1 MiB 流式上限。Watt 没有 publication ledger、GitHub webhook/API observation、Case 8 安全投影或 PR body/head 业务绑定；这些是 delivery-loop 新增，没有复制第二套正文解析，也没有把 Agent URL 当作事实。
- 动作：
  - 先审计现有 publication/outbox、HMAC `pull_request` webhook、GitHub API reconciliation 和 Case 8 查询，确认 Case 8 原来没有安全公开两类 PR observation；先写红灯测试，分别因缺 `src/domain/github-pull-request-evidence.ts` 和 `checks.pullRequestObservations` 失败。
  - 新增 strict `GitHubPullRequestEvidenceManifestV1`，冻结 Run/repository、verified publication、webhook applied fact 与 API applied fact，并做 repository/base-head/time/digest 交叉约束；schema 禁止 raw body、payload、REST response 和 token 字段。
  - 新增只读 verifier：读取 `GET /v1/runs/:runId/audit`，核对 `pull_request` publication 和两条 applied observation；再读取 GitHub `GET /repos/:owner/:repo/pulls/:number`，核对 open/draft、URL/number、base/head repository/ref/SHA 与 canonical body digest。所有响应 1 MiB 有界读取，错误只返回固定 code，不传播 raw response 或 token。
  - Case 8 新增 `answers.checks.pullRequestObservations` 白名单投影，仅包含 source kind/id、publication、repo、PR number、fact digest、processing state、ignore reason 和 external/observed/processed time；不返回 webhook/REST 正文、PR body、payload、dedupe key 或 token。
  - 新增 `pnpm run e2e:github-pr`、schema example 和 [`docs/GitHubPullRequestE2E.md`](docs/GitHubPullRequestE2E.md)，说明真实 Draft PR、signed opened webhook、API reconciliation、manifest、退出码和安全边界。默认或缺配置均在 manifest/network 前 exit 2；exit 0 只证明已发生 live facts，不执行创建/修改 PR。
- 验证：
  - `pnpm run typecheck` → exit 0；`pnpm exec vitest run test/github-pr-evidence.test.ts` → exit 0，1 file / 5 tests，覆盖 strict/example、publication+webhook+API+GitHub success、缺 fact、stale head、body drift、raw/token 不传播和 CLI opt-in。
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/case8-audit-report.test.ts` → exit 0，1 file / 2 tests，覆盖安全 `pullRequestObservations` 投影。
  - `pnpm run e2e:github-pr`（无 opt-in）→ exit 2，固定 `github-pr-e2e: opt-in missing`；设置 opt-in 但缺配置 → exit 2，固定 `github-pr-e2e: required PR configuration is incomplete`。两条路径都在 manifest/network 前结束。
  - `pnpm run verify` → exit 0；typecheck、ESLint、Node 64 files / 223 tests、workerd 56 files / 298 tests、298 个生产文件 Secret scan 和 Markdown links 全绿。workerd 仅输出既有预期 Workflow terminate 清理信息，无失败 suite。
  - `CI=1 WRANGLER_SEND_METRICS=false pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round85-20260726-final` → exit 0，bundle 2525.74 KiB / gzip 425.85 KiB；识别双 Workflow、双 Queue、D1 与四个 R2 binding，未部署。
  - `pnpm run lint`、`pnpm run verify:docs`、`git diff --check` → exit 0。
- 勾选：Phase 4 PR 创建项新增并勾选“真实外部证据验收契约”；真实试点 GitHub App 创建、signed webhook、API 补偿、重放不重复 PR 和父项仍保持未勾。fake GitHub、schema example、dry-run 或默认 exit 2 不能替代真实外部事实。
- 决策沉淀：publication 是控制面待发布输入，`created_unverified` 不是 PR 成功；Case 8 observation 是安全审计索引，GitHub API/webhook 与控制面三方事实才是验收真源。manifest 只能索引预期绑定，不能覆盖 live 状态；PR body digest 必须从 live GitHub response 重算。Watt 的通用 E2E 门禁可以直接复用，PR 业务 identity/reconciliation 必须保留 delivery-loop 自己的 strict schema。
- 遗留：当前 `git remote -v` 为空，Wrangler D1 ID 仍为占位值，没有已部署 Worker/真实 GitHub App、试点 repo 或 PR/webhook/API 外部记录。需要用户提供受控 GitHub 组织/repo、App 安装和部署前置后，按 [`docs/GitHubPullRequestE2E.md`](docs/GitHubPullRequestE2E.md) 完成真实 Draft PR 与 webhook/API 补偿，保存仓库外 manifest、PR/Actions/控制面安全链接并运行 `DELIVERY_LOOP_GITHUB_PR_E2E=1 pnpm run e2e:github-pr`；只有 exit 0 和人工核对入账后才能勾真实子项与父项。

## Round 86 — 2026-07-26
- 目标：Phase 4 / `Review comment 绑定 PR head SHA 并创建 review_fix attempt；已过时评论不误改新代码`。本轮补齐 Case 8 review observation 安全投影、仓库外 applied/stale manifest、GitHub Review/PR/Action/ref/compare/check-runs 只读 verifier；真实真人 review、Action 修复和 required checks 外部事实保持未完成。
- 前置与权限：只使用本地 delivery-loop、Watt 固定 commit `476e3cdd2490d725fde174e7c697ebf00899edc6`、fake HTTPS response、D1/workerd 测试、文档检查和 Wrangler dry-run。未访问或修改真实 GitHub、Cloudflare、飞书、tool-bridge、日志或业务数据库，未提交代码、未创建真实 review/Action/PR、未部署或使用真实 Secret；未保存 review 正文、raw webhook/API response、R2 内容、token、Runner 输出或数据库行，按用户要求未更新 llmdoc。
- Watt 直接复用：`scripts/verify-github-review-feedback-evidence.ts`沿用 Watt E2E 的显式 opt-in、仓库外 64 KiB manifest、固定 0/1/2 退出、安全错误输出；HTTP 读取复用本项目已有 Watt-derived 1 MiB 流式上限。Watt 没有 head-bound review feedback、stale-head projector、review_fix lineage 或 GitHub Review/compare/check 断言；这些是 delivery-loop 新增，没有复制第二套 review 正文解析。
- 动作：
  - 先写红灯：`test/github-review-evidence.test.ts` 初始 failed suite / 0 tests，缺 `src/domain/github-review-feedback-evidence.ts`；Case 8 测试新增 `checks.reviewObservations` 断言后首次 1/2 failed，报告明确缺该投影。
  - 新增 strict `GitHubReviewFeedbackEvidenceManifestV1`，同时冻结一条 `changes_requested` applied review、一条 `stale_head` ignored review 和 replacement Attempt/Action/checks；交叉约束 reviewed/result SHA、prior/review_fix Attempt、branch、时间和唯一 check 名称，禁止 raw review body、payload、REST response、R2 ref 和 token。
  - Case 8 新增 D1-only `reviewObservations` 查询与 fail-closed 校验：只公开 delivery/review/publication ID、repository/PR number、reviewed head、payload/body digest、processing state、固定 reason、时间以及 applied feedback/review_fix lineage 的安全标量；`received`、partial lineage、重复 source、非法 digest/time/URL 不生成部分报告。
  - 新增 verifier 与 `pnpm run e2e:github-review`：先核对 Case 8 publication、applied/stale review 和 prior/replacement Attempt，再读取 GitHub Review API 重算 body digest/commit/head，读取 PR 当前新 head、Action run、branch ref、compare fast-forward 和 result head check-runs；发现 API 下一页或响应超限即 fail-closed。verifier 只读，不创建 review、Action、branch 或修改状态。
  - 新增 [`docs/GitHubReviewE2E.md`](docs/GitHubReviewE2E.md)，同步 DOD、Proto、Architecture、Security、Reference，真实外部子项继续保持未勾。
- 验证：
  - 红灯 `pnpm exec vitest run test/github-review-evidence.test.ts` → exit 1，failed suite / 0 tests；实现后 `pnpm exec vitest run test/github-review-evidence.test.ts` → exit 0，1 file / 5 tests，覆盖 strict/example、applied+stale success、review/body/head drift、Action/ref/compare/check failure、raw/token 零传播和 CLI opt-in。
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/case8-audit-report.test.ts` → exit 0，1 file / 2 tests；`github-review-feedback + case8-audit-report` → exit 0，2 files / 7 tests，既有 20 路 review delivery/CAS/R2/Runner 契约无回归。
  - `pnpm run e2e:github-review`（无 opt-in）→ exit 2，固定 `github-review-e2e: opt-in missing`；设置 opt-in 但缺配置 → exit 2，固定 `github-review-e2e: required review configuration is incomplete`。两条路径均在 manifest/network 前结束。
  - `pnpm run verify` → exit 0；typecheck、ESLint、Node 65 files / 228 tests、workerd 56 files / 298 tests、302 个生产文件 Secret scan 和 Markdown links 全绿。workerd 仅输出既有预期 Workflow terminate 清理信息，无失败 suite。
  - `CI=1 WRANGLER_SEND_METRICS=false pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round86-20260726-final` → exit 0，bundle 2530.39 KiB / gzip 426.51 KiB；识别双 Workflow、双 Queue、D1 与四个 R2 binding，未部署。
  - `pnpm run typecheck`、`pnpm run lint`、`pnpm run verify:docs`、`git diff --check` → exit 0。
- 勾选：Phase 4 review comment 项新增并勾选“真实外部证据验收契约”；真实真人 review、stale review、Action 修复、new SHA、required checks 和父项仍保持未勾。fake GitHub、schema example、dry-run 或默认 exit 2 不能替代真实外部事实。
- 决策沉淀：review applied 与 stale ignored 是两条不同外部事实；只证明 review body 或 Action 成功不足，必须同时证明 stale review 没有 feedback/Attempt/Action，applied review 的 replacement branch 只从 reviewed SHA fast-forward 到新 SHA，并由 GitHub API 核对 Action/ref/compare/check。Case 8 只做安全索引，manifest 不能覆盖 live projection；Watt 只提供 E2E 门禁原语，head-bound review 业务 identity 保持本项目 strict 实现。
- 遗留：当前 `git remote -v` 为空，Wrangler D1 ID 仍为占位值，没有已部署 Worker、真实 GitHub App/试点 repo、真人 review、Action run 或 required checks 外部记录。需要用户提供受控 GitHub 组织/repo、App 安装和部署前置后，按 [`docs/GitHubReviewE2E.md`](docs/GitHubReviewE2E.md) 完成 exact-head review、stale-head review 和新 head checks，保存仓库外 manifest、review/PR/Actions/控制面安全链接并运行 `DELIVERY_LOOP_GITHUB_REVIEW_E2E=1 pnpm run e2e:github-review`；只有 exit 0 和人工核对入账后才能勾真实子项与父项。

## Round 87 — 2026-07-26
- 目标：Phase 4 / `review/补充上下文需要改变计划正文、base SHA 或 effect 时创建新 Plan 版本并使旧审批过期，不原地改写 active plan`。本轮补齐三类 source 的 Case 8 安全 projection、统一仓库外 manifest/verifier 和真实验收手册；真实 GitHub/Feishu/Meegle source 与外部编排保持未完成。
- 前置与权限：只使用本地 delivery-loop、Watt 固定 commit `476e3cdd2490d725fde174e7c697ebf00899edc6`、fake HTTPS response、D1/workerd 测试、文档检查和 Wrangler dry-run。未访问或修改真实 GitHub、Cloudflare、飞书、Meegle、tool-bridge、日志或业务数据库，未创建真实 Plan/revision/approval/Action、未部署、未提交代码或使用真实 Secret；未保存 Task/PRD/context/review 正文、R2 内容、raw API response、token、Runner 输出或数据库行，按用户要求未更新 llmdoc。
- Watt 直接复用：`scripts/verify-plan-revision-evidence.ts`沿用 Watt E2E 的显式 opt-in、仓库外 64 KiB manifest、固定 0/1/2 退出、安全错误输出；HTTP 读取复用本项目已有 Watt-derived 1 MiB 流式上限。Watt 没有 PlanRevision、source lineage、approval invalidation、GitHub ref/Review/compare 或 Feishu/Meegle identity 断言；这些是 delivery-loop 新增。
- 动作：
  - 先审计现有 `PlanRevisionStore`、`github_base_observations`、`github_review_feedbacks`、`supplemental_context_revisions`、`approval_invalidations` 与 Case 8，确认 D1 已有状态机，但 Case 8 没有安全公开 revision/source-specific lineage；先写红灯，Node suite failed suite / 0 tests 缺 domain，Case 8 新增 `checks.planRevisions` 后首次 1/2 failed。
  - 新增 strict `PlanRevisionEvidenceManifestV1`，source union 覆盖 `review_feedback`、`base_update`、`supplemental_context`；冻结 revision/analysis Attempt、prior superseded Plan、new active `version + 1` Plan、body/base/effects change flags、旧 approvals invalidation 和新 human/provider approvals。schema 禁止正文、R2 ref/content、raw payload/response 和 token。
  - Case 8 新增 D1-only `checks.planRevisions` 查询，按 source kind join review/base/context authoritative tables；输出 canonical source digest、base ref/compare digest、review body/commit digest 或 supplemental event/task revision lineage。对 source 缺失、digest drift、partial Plan/lineage、非法 URL/time/ID 和 analyzing/rejected shape 做 fail-closed 校验。
  - 新增只读 verifier 与 `pnpm run e2e:plan-revision`：先核对 Case 8 revision、source、prior/new Plan、旧/新 approval 与 analysis Attempt，再读取 GitHub Action；base source 重新核对 ref/compare 与 canonical digest，review source 重算 Review body digest/commit/head，supplemental source 保留 Feishu/Meegle 验签与 identity 的人工核对边界。verifier 不创建 revision、Plan、approval、Action 或 source fact。
  - 新增 [`docs/PlanRevisionE2E.md`](docs/PlanRevisionE2E.md)，同步 DOD、Proto、Architecture、Security、Reference；真实 source 外部子项继续保持未勾。
- 验证：
  - 红灯 `pnpm exec vitest run test/plan-revision-evidence.test.ts` → exit 1，failed suite / 0 tests，缺 domain 模块；实现后 → exit 0，1 file / 5 tests，覆盖 strict/example、base source success、Plan/approval drift、GitHub ref/Action failure、raw/token 零传播和 CLI opt-in。
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/case8-audit-report.test.ts` → exit 0，1 file / 2 tests；`plan-revision + github-base-observation + supplemental-context-revision + case8-audit-report` → exit 0，4 files / 13 tests，既有 D1 CAS、source digest、R2/context 和 approval invalidation 契约无回归。
  - `pnpm run e2e:plan-revision`（无 opt-in）→ exit 2，固定 `plan-revision-e2e: opt-in missing`；设置 opt-in 但缺配置 → exit 2，固定 `plan-revision-e2e: required revision configuration is incomplete`。两条路径均在 manifest/network 前结束。
  - `pnpm run verify` → exit 0；typecheck、ESLint、Node 66 files / 233 tests、workerd 56 files / 298 tests、306 个生产文件 Secret scan 和 Markdown links 全绿。workerd 仅输出既有预期 Workflow terminate 清理信息，无失败 suite。
  - `CI=1 WRANGLER_SEND_METRICS=false pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round87-20260726-final-v2` → exit 0，bundle 2543.96 KiB / gzip 428.58 KiB；最终 verifier approval-set 收紧后仍识别双 Workflow、双 Queue、D1 与四个 R2 binding，未部署。
  - `pnpm run typecheck`、`pnpm run lint`、`pnpm run verify:docs`、`git diff --check` → exit 0。
- 勾选：Phase 4 Plan revision 项新增并勾选“真实外部证据验收契约”；真实 GitHub review/base、Feishu/Meegle 验签/identity、analysis Action 和新审批外部记录仍保持未勾。fake API、schema example、dry-run 或默认 exit 2 不能替代真实外部事实。
- 决策沉淀：revision source 是 authority，Plan/approval 是其结果；不能先接受 Agent Plan 再补 source。验收必须同时证明旧 Plan/approval 已失效和新 Plan/approval exact 绑定，单独的 Plan digest 或 Action success 都不足。Watt 只提供门禁/读取原语，三类 source 的业务 identity 与外部事实分层保留在 delivery-loop。
- 遗留：当前 `git remote -v` 为空，Wrangler D1 ID 仍为占位值，没有已部署 Worker/真实 GitHub App、Feishu/Meegle tenant、Action/Plan revision/approval 外部记录。需要用户提供受控平台前置后，按 [`docs/PlanRevisionE2E.md`](docs/PlanRevisionE2E.md) 分别完成 review/base/context 三类真实 source、Plan replacement、审批与 Action 证据，并运行 `DELIVERY_LOOP_PLAN_REVISION_E2E=1 pnpm run e2e:plan-revision`；只有 exit 0、平台签名/identity 人工核对和链接入账后才能勾真实子项与父项。

## Round 88 — 2026-07-26
- 目标：Phase 4 / `base branch` 前进导致冲突时不盲目覆盖；安全可重放则 rebase 后重验，否则 `blocked` 请求人工。本轮补齐 Case 8 的 rebase/conflict 安全投影、passed/blocked 双路径仓库外证据 manifest/verifier 和可重跑 CLI；真实 GitHub push webhook/audit、Action、branch 与 compare 外部事实仍保持未完成。
- 前置与权限：仅使用本地 delivery-loop、Watt 固定 commit `476e3cd`、Node fake HTTPS、D1/workerd 测试、文档检查和 Wrangler dry-run。未访问或修改真实 GitHub/Cloudflare/飞书/Meegle/tool-bridge/日志/业务数据库，未创建或推送真实 branch/Action/PR，未部署、未提交代码、未调用模型或使用真实 Secret；不保存 diff、Git 输出、raw API/webhook、token、Task/PRD/Runner 正文或数据库行，按用户要求不更新 llmdoc。
- Watt 直接复用：`scripts/verify-base-rebase-evidence.ts`直接沿用 Watt `476e3cd` 的显式 opt-in、仓库外 64 KiB manifest、固定 0/1/2 退出和安全错误输出；verifier 的 1 MiB 流式响应上限复用本项目此前从 Watt E2E/tool-bridge 迁入的有界读取纪律。Watt 没有 GitHub rebase Runner、base conflict ledger、branch ancestry 或 Case 8 lineage，故没有虚构可复制的业务代码。
- 动作：
  - 审计 `github-base-observation-reconciler`、`github-base-conflict-store`、`base-rebase-attempt-store`、`BaseRebaseRunner`、migrations 0022/0024/0025 和 Case 8，确认控制面已有 D1 状态机但缺少外部 rebase/conflict 证据索引。
  - Case 8 新增 `checks.baseRebases` / `checks.baseConflicts` 白名单投影：只公开 rebase/conflict ID、revision/Plan/Item/Attempt、old/new/base/merge-base SHA、branch/head、status、suite/GitHub run 标量、reference/comparison/source digest、cancel/dispatch outbox 与固定 blocker/human action；对孤儿、非法状态、partial terminal、Run/Plan version 漂移 fail-closed，不返回 diff、Git stderr、raw provider response 或 token。
  - 新增 strict `BaseRebaseEvidenceManifestV1`，以 `outcome=passed|blocked` 区分纯 fast-forward replay 和人工阻断。passed 要求新 base/source/target ref、`oldBase...newBase` 与 `sourceHead...resultHead` compare、Action、targeted→required suite/Evidence、target branch fast-forward 且 `force=false`；blocked 要求 immutable conflict、`manual_rebase`、唯一 cancel、无目标 Action、target branch 404 和零新 execution/evidence side effect。
  - 新增只读 `verify-base-rebase-evidence.ts` / `pnpm run e2e:base-rebase`、schema example 与 [`docs/BaseRebaseE2E.md`](docs/BaseRebaseE2E.md)。manifest 最大 64 KiB、token 只进入对应 Authorization header；GitHub REST 只能证明当前 ref/ancestry/Action inventory，历史 force-push 与 blocked `pushEvents=0` 明确留给真实 push webhook/组织 audit 人工核对。
  - 同步 `DOD.md`、`docs/Proto.md`、`docs/Architecture.md`、`docs/Security.md`、`docs/Reference.md`；只勾选 Phase 4 该项的“真实外部证据验收契约”，父项与真实试点外部事实保持未勾。
- 验证：
  - `pnpm run typecheck` → exit 0；`pnpm run lint` → exit 0。
  - `pnpm exec vitest run test/base-rebase-evidence.test.ts test/base-rebase-runner.test.ts` → exit 0，2 files / 5 tests；覆盖 strict/example、passed fast-forward/no-force、blocked no-Action/no-target、GitHub/action/config drift。
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/case8-audit-report.test.ts test/workflow/base-rebase-attempt.test.ts test/workflow/github-base-observation.test.ts` → exit 0，3 files / 9 tests；Case 8 投影和既有观察/调度/Runner 状态机无回归。
  - `pnpm exec vitest run --config vitest.workflow.config.ts` → exit 0，56 files / 298 tests；workerd 仅输出既有 Workflow terminate 清理信息，无失败 suite。
  - `pnpm run e2e:base-rebase`（无 opt-in）→ exit 2，固定 `base-rebase-e2e: opt-in missing`；设置 opt-in 但缺配置 → exit 2，固定 `base-rebase-e2e: required rebase configuration is incomplete`，均在 manifest/network 前结束。
  - `pnpm run verify:secrets` → exit 0，310 files；`pnpm run verify:docs` → exit 0；`git diff --check` → exit 0。
  - `pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round88-20260726-final-v2` → exit 0，bundle 2554.12 KiB / gzip 430.28 KiB，识别双 Workflow、Queue、D1 与四 R2 binding，未部署。
- 勾选：Phase 4 base-rebase/conflict 项新增并勾选“真实外部证据验收契约”；真实 GitHub Action、branch push/no-force webhook、compare、conflict zero-push audit 和人工 `manual_rebase` 仍保持未勾。fake API、schema example、dry-run 或默认 exit 2 不能替代真实外部事实。
- 决策沉淀：base fast-forward observation、rebase result、GitHub Action/branch ref、verification Evidence 与 conflict blocker 是五类独立事实，不能由 Runner 自报合并成成功。Case 8 只做安全索引；manifest 不能覆盖 live projection。当前仓库没有 push webhook ledger，因此 `force=false` 与零 push 只能作为真实试点的人工外部边界，不能过度声称已完成。
- 遗留：当前 `git remote -v` 为空，Wrangler D1 ID 仍为占位值，没有已部署 Worker/真实 GitHub App/试点 repo、Action/branch push/audit 或有效 Agent credential。需要用户提供受控试点前置后，按 [`docs/BaseRebaseE2E.md`](docs/BaseRebaseE2E.md) 运行一次 passed rebase 和一次 blocked conflict，记录仓库外 manifest、Action/branch/compare/控制面安全链接以及 push audit；只有 verifier exit 0 和人工核对入账后才能勾真实子项与父项。

## Round 89 — 2026-07-26
- 目标：Phase 5 / `required checks` 未完成或失败、review 不足、base 非最新、approval 过期时 merge 全部被拒。本轮补齐 Case 8 merge-gate 安全投影、ready/rejected 双路径外部证据 manifest/verifier 和可重跑 CLI；真实 GitHub branch rules/check/review/base/approval 与零 merge mutation 仍保持未完成。
- 前置与权限：仅使用本地 delivery-loop、Watt 固定 commit `476e3cdd2490d725fde174e7c697ebf00899edc6`、fake HTTPS response、D1/workerd 测试、文档检查与 Wrangler dry-run。未访问或修改真实 GitHub、Cloudflare、飞书、Meegle、tool-bridge、日志或业务数据库，未创建真实 merge/PR/Action、未部署、未提交代码或使用真实 Secret；未保存 raw REST/webhook、PR/review 正文、token、Agent 输出或数据库行，按用户要求未更新 llmdoc。
- Watt 直接复用：`scripts/verify-merge-gate-evidence.ts`沿用 Watt E2E 的显式 opt-in、仓库外 64 KiB manifest、固定安全错误与 0/1/2 退出；verifier 的控制面有界读取和生产 GitHub adapter 的 response 上限/分页 fail-closed 纪律复用现有 Watt-derived 模式。Watt 没有 GitHub merge fact、branch rules/check/review 聚合或 merge gate ledger，因此这些业务绑定保持 delivery-loop 自有实现，没有复制第二套 GitHub parser。
- 动作：
  - 修复并冻结 `MergeGateEvidenceManifestV1`：至少一条 `ready_to_merge` 与五条拒绝 case（`required_checks_incomplete`、`required_checks_failed`、`review_insufficient`、`base_not_latest`、`approval_required`），每条绑定完整 normalized fact、observation/evaluation/decision、approval（如有）和 `noMergeEffect={mergeOutboxes:0,merges:0}`；新增 schema example。
  - 新增只读 `verifyMergeGateEvidence` 与 `pnpm run e2e:merge-gate`。先读 `GET /v1/runs/:runId/audit` 的 `checks.mergeGates`，再调用生产 `GitHubMergeGateApiClient` 读取 PR/base/rules/check-runs/statuses/reviews 并重算 canonical fact；ready/rejected 两类都核对 base/head/review/check/approval 与零 merge changes、zero merge outbox。projection、live fact、merge effect、raw/token drift 均 fail-closed。
  - Case 8 新增完整 D1 rejected merge-gate publication/draft、observation、normalized required check 与 evaluation fixture，证明安全 projection 可被真实查询读取；既有 merge gate workerd 20 路 CAS/zero-effect 状态机保持不变。
  - 强化生产 GitHub merge-gate adapter：拒绝 `Link: rel=next` 分页响应，使用 2 MiB `content-length`/流式读取上限后再解析 JSON；新增对应 API 负向测试。
  - 顺手把既有 rollback workerd fixture 的 `NOW` 改为“当前时间前 5 分钟”，避免真实 wall clock 超过固定 30 分钟 lease 后导致全量回归出现与本轮无关的 403/409；业务契约未改变。
  - 新增 [`docs/MergeGateE2E.md`](docs/MergeGateE2E.md)，同步 `DOD.md`、`docs/Proto.md`、`docs/Architecture.md`、`docs/Security.md`、`docs/Reference.md`；仅勾选 Phase 5 该项的“真实外部证据验收契约”子项，父项与真实试点子项保持未勾。
- 验证：
  - `pnpm exec vitest run test/merge-gate-evidence.test.ts test/github-merge-gate-api.test.ts` → exit 0，2 files / 9 tests；覆盖 strict/example、ready + 五拒绝、Case 8/live fact/effect drift、GitHub 分页/超限、raw/token 零传播和 CLI opt-in。
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/case8-audit-report.test.ts` → exit 0，1 file / 2 tests；完整 merge-gate D1 projection 与原八栏审计无回归。
  - `pnpm run e2e:merge-gate`（无 opt-in）→ exit 2，固定 `merge-gate-e2e: opt-in missing`；设置 opt-in 但缺配置 → exit 2，固定 `merge-gate-e2e: required merge gate configuration is incomplete`。两条路径都在 manifest/network 前结束。
  - `pnpm run verify` → exit 0；typecheck、ESLint、Node 68 files / 242 tests、workerd 56 files / 298 tests、314 个生产文件 Secret scan 和 Markdown links 全绿。workerd 仅输出既有预期 Workflow terminate 清理信息，无失败 suite。
  - `CI=1 WRANGLER_SEND_METRICS=false pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round89-20260726-final-v3` → exit 0，bundle 2563.54 KiB / gzip 432.22 KiB；识别双 Workflow、双 Queue、D1 与四个 R2 binding，未部署。
  - `pnpm run typecheck`、`pnpm run lint`、`pnpm run verify:docs`、`git diff --check` → exit 0。
- 勾选：Phase 5 merge gate 项新增并勾选“真实外部证据验收契约”；真实 branch rules、required checks、review、base advance、approval expiry 和“无 merge 请求”外部事实仍保持未勾。fake GitHub、schema example、Case 8、dry-run 或默认 exit 2 不能替代真实试点证据。
- 决策沉淀：`ready_to_merge` 只是资格 decision，不是 merge effect；rejected evaluation 与 ready decision 都必须证明 zero merge effect。Case 8 是安全索引，manifest 不能覆盖 live projection；所有 live GitHub fact 必须由同一生产 adapter 重算。Watt 只提供 E2E 门禁原语，merge gate 领域事实、D1 ledger 与身份/Plan/approval 绑定仍属于 delivery-loop。
- 遗留：当前 `git remote -v` 为空，Wrangler D1 ID 仍为占位值，没有已部署 Worker/真实 GitHub App、试点 repo 或有效控制面/GitHub 只读凭证。需要用户提供受控试点前置后，按 [`docs/MergeGateE2E.md`](docs/MergeGateE2E.md) 从真实 branch rules/PR checks/reviews/base/approval 生成一条 ready 和五条 rejection manifest，确认 GitHub API/Actions/控制面均无 merge mutation，再以 `DELIVERY_LOOP_MERGE_GATE_E2E=1 pnpm run e2e:merge-gate` exit 0 和人工审计链接入账后才能勾真实子项与父项。

## Round 90 — 2026-07-26
- 目标：Phase 5 / `Agent/PR` 作者不能批准自己的 merge/production effect；审批主体由 GitHub/飞书身份映射核对。本轮补齐 Case 8 identity approval/rejection 安全投影、GitHub/Feishu accepted/self-rejected 四路径仓库外 manifest/verifier 与可重跑 CLI；真实 GitHub signed review、飞书 signed event/tenant/open_id 与外部零 effect 仍保持未完成。
- 前置与权限：仅使用本地 delivery-loop、Watt 固定 commit `476e3cdd2490d725fde174e7c697ebf00899edc6`、fake HTTPS response、D1/workerd 测试、文档检查和 Wrangler dry-run。未访问或修改真实 GitHub、Cloudflare、飞书、Meegle、tool-bridge、日志或业务数据库，未创建真实 approval/merge/deployment、未部署、未提交代码或使用真实 Secret；未保存 raw event/review、PRD/Task 正文、token、Agent 输出或数据库行，按用户要求未更新 llmdoc。
- Watt 直接复用：`scripts/verify-identity-approval-evidence.ts`沿用 Watt E2E 的显式 opt-in、仓库外 64 KiB manifest、固定安全错误与 0/1/2 退出；HTTP 有界读取继续复用 Watt-derived 模式；GitHub reviewer actor/head 读取直接复用本项目生产 `GitHubMergeGateApiClient`，没有复制第二套 PR/review parser。Watt 的 `identity_mappings/channel_identities/IdentityMapper` 已在前轮直接迁移；Feishu provider fact 仍保留 delivery-loop 的 signed adapter 边界。
- 动作：
  - 新增迁移 `0054_identity_rejection_decision.sql` 与 `0055_identity_rejection_binding_snapshot.sql`，拒绝记录冻结 decision、approver/author channel、principal、login、roles digest 和 `separation_verified`；仅安全标量，不保存原始 provider payload。
  - `Case8AuditReportStore` 新增 `checks.identityApprovals`：accepted 行必须有 approval/lineage、人类角色与 separation；rejected 行必须有 rejection ID、固定 identity reason、decision 和 zero binding；孤儿、digest/channel/时间/状态漂移 fail-closed。
  - 新增 strict `IdentityApprovalEvidenceManifestV1`、`verifyIdentityApprovalEvidence` 与 `pnpm run e2e:identity-approval`。manifest 固定 GitHub merge accepted/self-rejected、Feishu production accepted/self-rejected 四类 case；accepted 要求 `human + approve:<effect>`、approver/author 分离和 exact lineage，rejected 要求 self/task-actor reason、无 approval/lineage，四条路径均 zero merge/production effect。
  - GitHub verifier 通过生产只读 adapter 读取 exact PR 与 review actor/head；Feishu source 只核对控制面 metadata，真实签名/tenant/open_id 外部事实明确留给真实试点。新增 schema example 与 [`docs/IdentityApprovalE2E.md`](docs/IdentityApprovalE2E.md)，同步 `DOD.md`、`docs/Proto.md`、`docs/Architecture.md`、`docs/Security.md`、`docs/Reference.md`。
  - 为使 dry-run 在当前环境稳定可重跑，`wrangler.jsonc` 显式设置 `send_metrics=false`；不改变 Worker 业务逻辑或部署资源。
- 验证：
  - `pnpm exec vitest run test/identity-approval-evidence.test.ts` → exit 0，1 file / 4 tests；覆盖 strict/example、GitHub/Feishu accepted/self-rejected、projection/GitHub/effect drift、raw/token 零传播和 CLI opt-in。
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/case8-audit-report.test.ts test/workflow/github-merge-gate.test.ts test/workflow/production-deployment.test.ts test/workflow/identity-mapper.test.ts` → exit 0，4 files / 53 tests；Case 8 identity projection、merge/production identity CAS 与 Watt-derived mapper 无回归。
  - `pnpm run e2e:identity-approval`（无 opt-in）→ exit 2，固定 `identity-approval-e2e: opt-in missing`；设置 opt-in 但缺配置 → exit 2，固定 `identity-approval-e2e: required identity configuration is incomplete`。两条路径均在 manifest/network 前结束。
  - `pnpm run verify` → exit 0；typecheck、ESLint、Node 69 files / 246 tests、workerd 56 files / 298 tests、320 个生产文件 Secret scan 和 Markdown links 全绿。workerd 仅输出既有预期 Workflow terminate 清理信息，无失败 suite。
  - `CI=1 pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round90-20260726-final-v2` → exit 0，bundle 2573.40 KiB / gzip 433.60 KiB；识别双 Workflow、双 Queue、D1 与四个 R2 binding，未部署。
  - `pnpm run typecheck`、`pnpm run lint`、`pnpm run verify:docs`、`pnpm run verify:secrets`、`git diff --check` → exit 0。
- 勾选：Phase 5 identity/self-approval 项新增并勾选“真实外部证据验收契约”；真实 GitHub/飞书签名、login/open_id mapping、真人/PR author/Agent 三方 decision 和外部 zero-effect 仍保持未勾。fake API、schema example、Case 8、dry-run 或默认 exit 2 不能替代真实外部事实。
- 决策沉淀：rejected identity fact 也必须持久化安全 binding snapshot，否则“无 approval 行”无法证明自批曾被拒；roles 正文不入库，只保存 canonical digest。GitHub reviewer API 可补强 actor/head，但不能替代 signed webhook；Feishu identity 必须继续以验签 adapter 与实时 mapping 为真源。Watt 复用范围仍限于 E2E/identity 原语，业务 approval lineage 与 rejection ledger 属于 delivery-loop。
- 遗留：当前 `git remote -v` 为空，Wrangler D1 ID 仍为占位值，没有已部署 Worker、真实 GitHub App/试点 repo、飞书 tenant 或有效只读凭证。需要用户提供受控前置后，按 [`docs/IdentityApprovalE2E.md`](docs/IdentityApprovalE2E.md) 真实产生 GitHub reviewer accepted/self-rejected 与 Feishu production accepted/self-rejected 事件，保存 signed delivery、D1 identity binding、外部 PR/Environment/zero-effect 安全链接，再以 `DELIVERY_LOOP_IDENTITY_APPROVAL_E2E=1 pnpm run e2e:identity-approval` exit 0 和人工审计入账后才能勾真实子项与父项。

## Round 91 — 2026-07-26
- 目标：Phase 5 / 测试部署使用独立 OIDC 角色和 Environment，不能访问生产 Secret；部署结果与 URL 作为独立 Evidence。本轮补齐 Case 8 test deployment/OIDC/双源观察安全投影、测试部署仓库外 evidence manifest/verifier/CLI 与 deployment-triggered Action 只读核对；真实 GitHub/云 OIDC/Environment/Secret 外部事实仍保持未完成。
- 前置与权限：仅使用本地 delivery-loop、Watt 固定 commit `476e3cdd2490d725fde174e7c697ebf00899edc6`、fake HTTPS response、D1/workerd 测试、文档检查和 Wrangler dry-run。未访问或修改真实 GitHub、Cloudflare、飞书、Meegle、tool-bridge、日志或业务数据库，未创建真实 Deployment/Action/Environment、未部署、未提交代码或使用真实 Secret；manifest/日志未保存 raw webhook/REST、OIDC/JWT、Secret、Task/PRD 正文或数据库行，按用户要求不更新 llmdoc。
- Watt 直接复用：`scripts/verify-test-deployment-evidence.ts`沿用 Watt E2E 的显式 opt-in、仓库外 64 KiB manifest、固定安全错误与 0/1/2 退出；verifier 的控制面/HTTP 有界读取和 response 分页 fail-closed 沿用既有 Watt-derived 骨架。测试部署业务不复制第二套 parser：复用现有 `GitHubTestDeploymentStatusApiClient` 的 exact Deployment/latest status adapter，扩展 `GitHubActionsApiClient` 共享 workflow-run parser 支持 `deployment` event，并继续使用独立 `deployments:read` token cache。
- 动作：
  - Case 8 `answers.deployments` 增加 test workflow path、OIDC audience、attestation ID/GitHub run ID/subject；新增 `checks.testDeploymentObservations`，只投影 webhook/API observation ID、source、fact digest、deployment ID、state 和时间。
  - 新增 strict `TestDeploymentEvidenceManifestV1`：绑定 Run/Plan/Attempt/approval、test Environment、`test:*` role、OIDC subject/audience、Deployment/Action、URL、独立 deployment Evidence、webhook/API 双源 observation 与单 Attempt/Deployment/outbox/Evidence 计数；OIDC/生产 Secret 隔离链接只作为人工审计索引。
  - 新增只读 `verify-test-deployment-evidence.ts` / `pnpm run e2e:test-deployment` 与 schema/docs。verifier 交叉核对 Case 8、Deployment/latest status、deployment-triggered Action (`event=deployment`、title/path/SHA/conclusion)、独立 Evidence 与 zero duplicate；失败/分页/URL/status drift fail-closed。
  - 加强测试部署 status API 有界读取（2 MiB）并拒绝 `Link: rel=next` 分页；新增 Case 8/adapter/evidence 正反测试。
  - 将既有 production deployment workerd fixture 的 `NOW` 改为当前时间前 5 分钟，避免 24 小时 approval 在真实 wall clock 超过固定 fixture 时间后造成与本轮无关的 409；业务契约未改变。
- 验证：
  - `pnpm run typecheck` → exit 0；`pnpm run lint` → exit 0。
  - `pnpm exec vitest run test/test-deployment-evidence.test.ts test/github-test-deployment-status-api.test.ts` → exit 0，2 files / 6 tests；覆盖 strict/example、OIDC/Action/Deployment/URL/双源 observation、status/action drift、raw/token 零传播、分页拒绝和 CLI opt-in。
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/case8-audit-report.test.ts test/workflow/test-deployment.test.ts` → exit 0，2 files / 10 tests；Case 8 新投影与既有 test deployment CAS/OIDC/status 状态机无回归。
  - `pnpm run e2e:test-deployment`（无 opt-in）→ exit 2，固定 `test-deployment-e2e: opt-in missing`；设置 opt-in 但缺配置 → exit 2，固定 `test-deployment-e2e: required test deployment configuration is incomplete`，两条路径均在 manifest/network 前结束。
  - `pnpm run verify` → exit 0；Node 70 files / 250 tests，workerd 56 files / 298 tests，324 个生产文件 Secret scan 和 Markdown links 全绿；workerd 仅输出既有预期 Workflow terminate 清理信息，无失败 suite。
  - `CI=1 pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round91-20260726-final-v2` → exit 0，bundle 2579.18 KiB / gzip 434.58 KiB；识别双 Workflow、双 Queue、D1 与四个 R2 binding，未部署。
  - `git diff --check`、`pnpm run verify:docs` → exit 0。
- 勾选：Phase 5 测试部署项新增并勾选“真实外部证据验收契约”；真实 test Environment/生产隔离、云端 `test:*` trust policy、test-only Secret、OIDC 审计、真实 Deployment/Action/URL、webhook/API compensation 与零重复外部事实仍保持未勾。fake API、Case 8 fixture、schema example、dry-run 或默认 exit 2 不能替代真实试点证据。
- 决策沉淀：Deployment create、OIDC attestation、deployment-triggered Action、signed/API status、URL Evidence 和 Attempt/Plan 完成是独立事实；Action 末尾自报与 create response 不能关门。Case 8 只提供安全索引，manifest 不能覆盖 live projection。Watt 继续只复用 E2E 门禁/HTTP 读取原语，测试部署 identity/Environment/Secret/双源 projector 属于 delivery-loop。
- 遗留：当前 `git remote -v` 为空，Wrangler D1 ID 仍为占位值，没有已部署 Worker、真实 GitHub App/试点 repo、test Environment、云 role/Secret 或有效只读凭证。需要用户提供受控前置后，按 [`docs/TestDeploymentE2E.md`](docs/TestDeploymentE2E.md) 真实运行 test Deployment/Action，记录 OIDC/Secret 隔离审计与 webhook/API compensation 链接，再以 `DELIVERY_LOOP_TEST_DEPLOYMENT_E2E=1 pnpm run e2e:test-deployment` exit 0 和人工审计入账后才能勾真实子项与父项。

## Round 92 — 2026-07-26
- 目标：Phase 5 / E2E/验收失败返回 `executing` 或 `blocked`，不会因为 deployment job 启动就标成功。本轮完成本地控制面/workerd/固定 workflow 的 test acceptance evidence 验收契约；真实 GitHub Action、test Environment、OIDC 与外部 E2E 事实仍保持未完成。
- 前置与权限：仅使用本地 delivery-loop、Watt 固定 commit `476e3cdd2490d725fde174e7c697ebf00899edc6`、fake HTTPS response、D1/workerd 测试、文档检查和 Wrangler dry-run。未访问或修改真实 GitHub、Cloudflare、飞书、Meegle、tool-bridge、日志或业务数据库，未创建真实验收 Action/Deployment、未部署、未提交代码或使用真实 Secret；manifest/日志未保存 raw webhook/REST、OIDC/JWT、Secret、Task/PRD 正文、Runner 输出或数据库行，按用户要求未更新 llmdoc。
- Watt 直接复用：`scripts/verify-test-acceptance-evidence.ts`沿用 Watt E2E 的显式 opt-in、仓库外 64 KiB manifest、固定安全错误与 0/1/2 退出；控制面/GitHub verifier 的有界 HTTP 读取、分页 fail-closed 和安全错误边界沿用 Watt-derived 模式。本轮没有复制第二套 GitHub workflow-run parser，继续复用生产 `GitHubActionsApiClient` 的 acceptance token 与 workflow-run fact parser；acceptance 状态、Runner/Evidence、双源 observation 和 Run/Plan 绑定属于 delivery-loop 业务契约。
- 动作：
  - 新增 strict `TestAcceptanceEvidenceManifestV1`、`verifyTestAcceptanceEvidence`、`pnpm run e2e:test-acceptance`、schema example 与 [`docs/TestAcceptanceE2E.md`](docs/TestAcceptanceE2E.md)。manifest 固定 `running`、`passed`、`failed` 三类 case：running 的 Action 尚未完成且无 acceptance Evidence，Run 必须 `executing`；passed 要求 Action completed/success、Runner exit 0 与 verified test Evidence；failed/冲突要求 failed Evidence，Run 只能 `executing|blocked`。
  - Case 8 增加 `checks.testAcceptances` 与 `checks.testAcceptanceObservations` 安全投影，交叉核对 Deployment/Plan/Attempt/approval、test Environment、workflow/OIDC subject/audience、Action status/conclusion、Runner 结果、独立 Evidence、webhook/API observation 及单 Attempt/Acceptance/outbox/Evidence 计数；不把 Runner 自报、deployment create response 或 Action 启动当作成功。
  - 修正 Node verifier fixture 的 digest 生成为严格 64 位小写十六进制，并移除临时调试输出；失败/漂移/超限响应仍只返回固定 code，不传播 raw response 或 token。
- 验证：
  - `pnpm exec vitest run test/test-acceptance-evidence.test.ts` → exit 0，1 file / 3 tests；覆盖 strict/example、running/passed/failed、projection/action drift、raw/token 零传播和 CLI opt-in。
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/case8-audit-report.test.ts test/workflow/test-acceptance.test.ts` → exit 0，2 files / 12 tests；Case 8 acceptance projection 与状态机无回归。
  - `pnpm run e2e:test-acceptance`（无 opt-in）→ exit 2，固定 `test-acceptance-e2e: opt-in missing`；`DELIVERY_LOOP_TEST_ACCEPTANCE_E2E=1 pnpm run e2e:test-acceptance`（缺配置）→ exit 2，固定 `test-acceptance-e2e: required test acceptance configuration is incomplete`；两条路径均在 manifest/network 前结束。
  - `pnpm run verify` → exit 0；typecheck、ESLint、Node 71 files / 253 tests、workerd 56 files / 298 tests、328 个生产文件 Secret scan 和 Markdown links 全绿。workerd 仅输出既有预期 Workflow terminate 清理信息，无失败 suite。
  - `CI=1 pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round92-20260726-final-v1` → exit 0，bundle 2583.56 KiB / gzip 435.16 KiB；识别双 Workflow、双 Queue、D1 与四个 R2 binding，未部署。
  - `git diff --check`、`pnpm run verify:docs` → exit 0。
- 勾选：Phase 5 E2E/验收失败项新增并勾选“真实外部证据验收契约”；真实 GitHub Action 的 running/success/failure、test Environment、OIDC、Runner 与外部状态最终一致仍保持未勾。fake API、Case 8 fixture、schema example、dry-run 或默认 exit 2 不能替代真实试点证据。
- 决策沉淀：deployment 成功只代表部署事实，acceptance 是独立 required Item；只有外部 Action completed/success、Runner exit 0、verified Evidence 和控制面 projection 同时成立才能通过。Action failure 或 Runner/Action 冲突必须保留 failed Evidence 并返回 `executing|blocked`，不得提前写 `succeeded`。Case 8 是安全索引，manifest 不能覆盖 live projection；Watt 继续只复用 E2E 门禁、HTTP 有界读取和退出码原语。
- 遗留：当前 `git remote -v` 为空，Wrangler D1 ID 仍为占位值，没有已部署 Worker、真实 GitHub App/试点 repo、test Environment、云 role/Secret 或有效只读凭证。需要用户提供受控前置后，按 [`docs/TestAcceptanceE2E.md`](docs/TestAcceptanceE2E.md) 真实运行 running/success/failure 三种验收与 webhook/API compensation，记录 Action/Runner/Evidence/Run 安全链接，再以 `DELIVERY_LOOP_TEST_ACCEPTANCE_E2E=1 pnpm run e2e:test-acceptance` exit 0 和人工审计入账后才能勾真实子项与父项。

## Round 93 — 2026-07-26
- 目标：Phase 5 / 合并成功由 GitHub webhook 核对 merge SHA；只在“无需部署”策略下可直接 `succeeded`。本轮补齐本地控制面/workerd/固定 workflow 的 merge 外部证据验收契约；真实真人 merge、分支保护、漏 webhook/API compensation 与外部 GitHub 事实仍保持未完成。
- 前置与权限：仅使用本地 delivery-loop、Watt 固定 commit `476e3cdd2490d725fde174e7c697ebf00899edc6`、fake HTTPS response、D1/workerd 测试、文档检查和 Wrangler dry-run。未访问或修改真实 GitHub、Cloudflare、飞书、Meegle、tool-bridge、日志或业务数据库，未创建/修改/合并真实 PR、未部署、未提交代码或使用真实 Secret；manifest/日志未保存 raw webhook/REST、PR 正文、OIDC/JWT、Secret、Agent 输出或数据库行，按用户要求未更新 llmdoc。
- Watt 直接复用：`scripts/verify-merge-evidence.ts`沿用 Watt E2E 的显式 opt-in、仓库外 64 KiB manifest、固定安全错误与 0/1/2 退出；verifier 的控制面/GitHub 1 MiB 有界 HTTP、origin 校验和分页 fail-closed 沿用 Watt-derived 模式。本轮没有复制第二套 GitHub PR parser，直接复用生产 `GitHubMergeStatusApiClient` 的 merge-observation token 与 canonical PR merge fact parser；merge projector、双源 observation、Run deployment disposition 和 Evidence 绑定属于 delivery-loop。
- 动作：
  - 新增 strict `MergeEvidenceManifestV1`、`verifyMergeEvidence`、`pnpm run e2e:merge`、schema example 与 [`docs/MergeE2E.md`](docs/MergeE2E.md)。manifest 固定四条 case：no-deploy merged、test merged、production merged、closed-unmerged；分别要求 `succeeded`、`deploying`、`deploying` 和零 merge projection/effect。
  - Case 8 增加 `checks.mergeObservations` 的 D1-only 安全投影，校验 observation ID/source/digest/PR/merge/state/time、applied 行必须绑定已存在 `github_merges`，孤儿/重复/非法时间或 `received` partial row 使整份报告 fail-closed。
  - verifier 先读取 Case 8 `changes`/`evidence`/`mergeObservations`/`effectOutboxes`，再用生产 `GitHubMergeStatusApiClient` 读取 exact PR API；已合并 case 重算 canonical merge fact/API digest，确认 merge SHA、PR/publication/Plan/base、Run 状态和 no-duplicate/zero-merge-outbox；closed-unmerged 必须 API 返回 `merged=false` 且 Run 保持 `ready_to_merge`。
  - 同步 `docs/Proto.md` §26、`docs/Architecture.md`、`docs/Security.md`、`docs/Reference.md` 与 DOD；真实 GitHub 子项保持未勾。
- 验证：
  - `pnpm run typecheck` → exit 0；`pnpm run lint` → exit 0。
  - `pnpm exec vitest run test/merge-evidence.test.ts test/github-merge-status-api.test.ts` → exit 0，2 files / 6 tests；覆盖 strict/example、no-deploy/test/production/closed-unmerged、webhook/API observation、merge SHA/API drift、zero-effect、raw/token 零传播和 CLI opt-in。
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/case8-audit-report.test.ts test/workflow/github-merge-gate.test.ts` → exit 0，2 files / 34 tests；Case 8 merge observation 空投影与既有 merge projector 状态机无回归。
  - `pnpm run e2e:merge`（无 opt-in）→ exit 2，固定 `merge-e2e: opt-in missing`；`DELIVERY_LOOP_MERGE_E2E=1 pnpm run e2e:merge`（缺配置）→ exit 2，固定 `merge-e2e: required merge configuration is incomplete`；两条路径均在 manifest/network 前结束。
  - `pnpm run verify:docs`、`git diff --check` → exit 0。
- 勾选：Phase 5 合并项新增并勾选“真实外部证据验收契约”；真实受保护分支真人 merge、signed delivery、closed-unmerged、错误 head、漏失 webhook/API compensation 和 no-deploy/deploying 外部 Run 事实仍保持未勾。fake GitHub、schema example、Case 8 fixture、dry-run 或默认 exit 2 不能替代真实试点证据。
- 决策沉淀：merge gate 的 `ready_to_merge` 只是资格，不是 merge effect；`github_merges` 只由 signed/API 外部事实产生且不可变。no-deploy 的 merge 才能 CAS 到 `succeeded`，任何 test/production effect 都必须停在 `deploying` 等待独立部署事实；closed-unmerged 与错误绑定必须零 merge projection/effect。Case 8 是安全索引，manifest 不能覆盖 live D1/GitHub fact；Watt 只复用 E2E 门禁和 HTTP/退出原语。
- 遗留：当前 `git remote -v` 为空，Wrangler D1 ID 仍为占位值，没有已部署 Worker、真实 GitHub App/试点 repo、受保护分支或有效只读凭证。需要用户提供受控前置后，按 [`docs/MergeE2E.md`](docs/MergeE2E.md) 真实完成三条 merged policy 与一条 closed-unmerged、签名 delivery/API compensation/replay，记录 PR/merge SHA/Actions/控制面安全链接，再以 `DELIVERY_LOOP_MERGE_E2E=1 pnpm run e2e:merge` exit 0 和人工审计入账后才能勾真实子项与父项。

## Round 94 — 2026-07-26
- 目标：Phase 5 / 生产部署必须经过 GitHub Environment reviewer 或等价外部审批；批准绑定 revision + merge SHA + environment。本轮补齐本地控制面/workerd/固定 workflow 的 production approval 外部证据验收契约；真实 Environment reviewer/Feishu event、云 OIDC trust、拒绝/过期和 production job 外部事实仍保持未完成。
- 前置与权限：仅使用本地 delivery-loop、Watt 固定 commit `476e3cdd2490d725fde174e7c697ebf00899edc6`、fake HTTPS response、D1/workerd 测试、文档检查和 Wrangler dry-run。未访问或修改真实 GitHub、Cloudflare、飞书、Meegle、tool-bridge、日志或业务数据库，未创建/批准真实 production Deployment、未部署、未提交代码或使用真实 Secret；manifest/日志未保存 raw event/REST、approval body、OIDC/JWT、Secret、Task/PRD 正文、Agent 输出或数据库行，按用户要求未更新 llmdoc。
- Watt 直接复用：`scripts/verify-production-approval-evidence.ts`沿用 Watt E2E 的显式 opt-in、仓库外 64 KiB manifest、固定安全错误与 0/1/2 退出；verifier 的控制面/GitHub 1 MiB 有界 HTTP、origin 校验和分页 fail-closed 沿用 Watt-derived 模式。本轮没有复制第二套 GitHub parser，直接复用生产 `GitHubMergeStatusApiClient` 核对 live merged PR/merge SHA；release binding、identity/live-role、approval lineage 与 zero production effect 属于 delivery-loop。
- 动作：
  - 新增 strict `ProductionApprovalEvidenceManifestV1`、`verifyProductionApprovalEvidence`、`pnpm run e2e:production-approval`、schema example 与 [`docs/ProductionApprovalE2E.md`](docs/ProductionApprovalE2E.md)。manifest 固定 accepted、self-approval rejected、merge-binding rejected 三条路径；accepted 绑定 `production_release_approval_bindings`、source/event、human role/separation、Task revision、Plan/digest/base、merge ID/SHA、production environment 和 expiry，rejected 必须无 approval/binding。
  - Case 8 新增 `checks.productionApprovals` D1-only 安全投影，校验 release binding 的 approval/Run/revision/Plan/base/merge/environment、source/event digest、reviewer roles/separation 与时间；source/approval/binding 孤儿、重复、非法 digest/time、非 production 或非 human separation fail-closed。
  - verifier 交叉核对 Case 8 `identityApprovals`、`productionApprovals`、`answers.approvals`、Run/Task/Plan、production deployments/outboxes/Attempts，并用生产 merge status API 重算每条 exact merge fact；accepted/rejected 均要求 production effect 为零，approval 不会被误当成 Deployment 成功。
  - 同步 `docs/Proto.md` §27、`docs/Architecture.md`、`docs/Security.md`、`docs/Reference.md` 与 DOD；真实 Environment/云外部子项保持未勾。
- 验证：
  - `pnpm run typecheck` → exit 0；`pnpm exec vitest run test/production-approval-evidence.test.ts test/identity-approval-evidence.test.ts` → exit 0，2 files / 7 tests；覆盖 strict/example、accepted/rejected binding、merge SHA/API drift、effect drift、raw/token 零传播和 CLI opt-in。
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/case8-audit-report.test.ts test/workflow/production-deployment.test.ts test/workflow/identity-mapper.test.ts` → exit 0，3 files / 21 tests；Case 8 新空投影与 production approval/scheduler/identity 状态机无回归。
  - `pnpm run e2e:production-approval`（无 opt-in）→ exit 2，固定 `production-approval-e2e: opt-in missing`；`DELIVERY_LOOP_PRODUCTION_APPROVAL_E2E=1 pnpm run e2e:production-approval`（缺配置）→ exit 2，固定 `production-approval-e2e: required production approval configuration is incomplete`；两条路径均在 manifest/network 前结束。
  - `pnpm run verify` → exit 0；typecheck、ESLint、Node 73 files / 259 tests、workerd 56 files / 298 tests、336 个生产文件 Secret scan 和 Markdown links 全绿。workerd 仅输出既有预期 Workflow terminate 清理信息，无失败 suite。
  - `CI=1 pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round94-20260726-final-v2` → exit 0，bundle 2590.78 KiB / gzip 436.13 KiB；识别双 Workflow、双 Queue、D1 与四个 R2 binding，未部署。
  - `pnpm run lint`、`pnpm run verify:docs`、`git diff --check` → exit 0。
- 勾选：Phase 5 production approval 项新增并勾选“真实外部证据验收契约”；真实 GitHub Environment reviewer/Feishu signed event、live role/tenant、拒绝/过期/旧 merge SHA、production job/Deployment 零 effect 与云审计仍保持未勾。fake GitHub、schema example、Case 8 fixture、dry-run 或默认 exit 2 不能替代真实试点证据。
- 决策沉淀：production approval 是 post-merge release authority，不是 merge 或 deployment success；accepted approval 也必须在 deployment scheduler 前证明 zero production effect。所有 binding 值由服务端从当前 Run/Plan/immutable merge 派生，caller/manifest不能自选 revision、merge SHA 或 environment；`ProductionApprovalEvidenceManifestV1` 只索引安全事实，Environment/云侧 reviewer 与 trust policy 仍需真实外部核对。
- 遗留：当前 `git remote -v` 为空，Wrangler D1 ID 仍为占位值，没有已部署 Worker、真实 GitHub App/试点 repo、受保护 production Environment、云 role/Secret 或有效只读凭证。需要用户提供受控前置后，按 [`docs/ProductionApprovalE2E.md`](docs/ProductionApprovalE2E.md) 真实产生 accepted/self-rejected/binding-rejected 事件，记录 Environment/Feishu approval、merge/Plan/Run/zero-effect 安全链接，再以 `DELIVERY_LOOP_PRODUCTION_APPROVAL_E2E=1 pnpm run e2e:production-approval` exit 0 和人工审计入账后才能勾真实子项与父项。

## Round 95 — 2026-07-26
- 目标：Phase 5 / deployment 成功/失败从平台 API/webhook 核对；Action 末尾 echo `success` 不能替代。本轮完成本地控制面/workerd/固定 workflow 的 production deployment 外部证据验收契约；真实 production Environment、云 OIDC、漏 webhook/API compensation 和 GitHub 外部四态事实仍保持未完成。
- 前置与权限：仅使用本地 delivery-loop、Watt 固定 commit `476e3cdd2490d725fde174e7c697ebf00899edc6`、fake HTTPS response、D1/workerd 测试、文档检查和 Wrangler dry-run。未访问或修改真实 GitHub、Cloudflare、飞书、Meegle、tool-bridge、日志或业务数据库，未创建/修改真实 production Deployment/Action、未部署、未提交代码或使用真实 Secret；manifest/日志未保存 raw webhook/REST、OIDC/JWT、Secret、Task/PRD 正文或 Action 输出，按用户要求未更新 llmdoc。
- Watt 直接复用：`scripts/verify-production-deployment-evidence.ts`沿用 Watt E2E 的显式 opt-in、仓库外 64 KiB manifest、固定安全错误与 0/1/2 退出；production status/verifier 的有界 HTTP、origin 校验和分页 fail-closed 沿用 Watt-derived 模式。本轮没有复制第二套 GitHub workflow-run parser，新增生产 Action 读取方法复用既有 `GitHubActionsApiClient` parser；production status、OIDC/Evidence、双源 observation、Run CAS 和 Action/platform conflict 属于 delivery-loop。
- 动作：
  - 新增 strict `ProductionDeploymentEvidenceManifestV1`、`verifyProductionDeploymentEvidence`、`pnpm run e2e:production-deployment`、schema example 与 [`docs/ProductionDeploymentE2E.md`](docs/ProductionDeploymentE2E.md)。manifest 固定 `in_progress`、`success`、`failure`、`error` 四类不同 Run；success 要求 exact production OIDC + Action completed/success + passed Evidence，failure/error 要求 failed Evidence/Run，failure case 可明确记录 Action 自报 success。
  - Case 8 增加 `checks.productionDeploymentObservations`，并把 production deployment 的 external state/time、workflow、OIDC attestation/subject、Evidence 和净化 URL 投影出来；production observation/source/digest/time 非法或重复时 fail-closed。production deployment status API 与 Action GET 均拒绝 `rel=next` 分页并有 1/2 MiB 响应上限，统一 parser 不采信 Runner/Action 自报作为业务状态。
  - 同步 `docs/Proto.md`、`docs/Architecture.md`、`docs/Security.md`、`docs/Reference.md` 与 DOD；仅勾选 Phase 5 的“真实外部证据验收契约”子项，真实 GitHub/云外部子项与父项保持未勾。
- 验证：
  - `pnpm exec vitest run test/production-deployment-evidence.test.ts test/github-production-deployment-status-api.test.ts` → exit 0，2 files / 7 tests；覆盖 strict/example、四态、Action/platform drift、raw/token 零传播、分页拒绝和 CLI opt-in。
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/case8-audit-report.test.ts test/workflow/production-deployment.test.ts` → exit 0，2 files / 19 tests；Case 8 production observation 空投影与 production status/OIDC/CAS 状态机无回归。
  - `pnpm run e2e:production-deployment`（无 opt-in）→ exit 2，固定 `production-deployment-e2e: opt-in missing`；设置 `DELIVERY_LOOP_PRODUCTION_DEPLOYMENT_E2E=1` 但缺配置 → exit 2，固定 `production-deployment-e2e: required production deployment configuration is incomplete`，两条路径均在 manifest/network 前结束。
  - `pnpm run verify` → exit 0；Node 74 files / 263 tests，workerd 56 files / 298 tests，340 个生产文件 Secret scan 和 Markdown links 全绿。workerd 仅输出既有预期 Workflow terminate 清理信息，无失败 suite。
  - `CI=1 pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round95-final-v1` → exit 0，bundle 2596.02 KiB / gzip 436.69 KiB；识别双 Workflow、双 Queue、D1 与五个 R2 binding，未部署。
  - `git diff --check`、`pnpm run verify:docs`、`pnpm run typecheck`、`pnpm run lint` → exit 0。
- 勾选：Phase 5 deployment status 项新增并勾选“真实外部证据验收契约”；真实 production Environment 的 in-progress/success/failure/error、签名 webhook、API compensation、Action/Environment URL、云 OIDC 审计及 Action success/platform failure 外部事实仍保持未勾。fake API、Case 8 fixture、schema example、dry-run 或默认 exit 2 不能替代真实试点证据。
- 决策沉淀：Deployment create、Environment job/OIDC、Action、signed/API platform status 和 verified Evidence 是独立事实；只有平台 success + exact OIDC + Action success + Evidence 才能 `succeeded`。平台 failure/error 即使 Action echo success 也必须 `failed`，终态后晚到相反事实不能复活 Run。Case 8 是安全索引，manifest 不能覆盖 live projection；Watt 继续只复用 E2E 门禁、HTTP 有界读取和退出码原语。
- 遗留：当前 `git remote -v` 为空，Wrangler D1 ID 仍为占位值，没有已部署 Worker、真实 GitHub App/试点 repo、受保护 production Environment、云 role/Secret 或有效只读凭证。需用户提供受控前置后，按 [`docs/ProductionDeploymentE2E.md`](docs/ProductionDeploymentE2E.md) 真实产生四态 Deployment/Action/status 与 webhook/API compensation，记录外部审计链接，再以 `DELIVERY_LOOP_PRODUCTION_DEPLOYMENT_E2E=1 pnpm run e2e:production-deployment` exit 0 和人工审计入账后才能勾真实子项与父项。

## Round 96 — 2026-07-26
- 目标：Phase 3 / 日志、Task、checkpoint、artifact、PR 的 canary Secret 安全验收契约。本轮完成本地控制面/Case 8/仓库外 verifier 的真实外部证据接口；真实 GitHub Action 日志、远端 R2 ciphertext 权限和真实安全/阻断 PR 仍保持未完成。
- 前置与权限：仅使用本地 delivery-loop、Watt 固定 commit `476e3cdd2490d725fde174e7c697ebf00899edc6`、fake HTTPS response、D1/workerd、文档检查和 Wrangler dry-run。未访问或修改真实 GitHub、Cloudflare、飞书、Meegle、tool-bridge、业务日志/数据库，未创建/修改真实 Action/PR、未部署、未提交代码或使用真实 Secret；manifest、日志与 audit projection 不保存 canary、token、raw response、Task/PRD/PR 正文或 ciphertext，按用户要求未更新 llmdoc。
- Watt 复用：`scripts/verify-secret-safety-evidence.ts`直接沿用 Watt E2E 的显式 opt-in、仓库外 64 KiB manifest、固定安全错误和 0/1/2 退出；verifier 复用生产 `GitHubActionsApiClient` 的 workflow-run parser，以及 Watt-derived 有界 HTTP、HTTPS origin、分页 fail-closed 与日志重定向边界。本轮没有复制第二套通用 GitHub parser；canary 内存扫描、jobs/logs 上限、Case 8 registry/zero-effect 投影属于 delivery-loop。
- 动作：
  - 新增 strict `SecretSafetyEvidenceManifestV1`、`verifySecretSafetyEvidence`、`pnpm run e2e:secret-safety`、schema example 与 [`docs/SecretSafetyE2E.md`](docs/SecretSafetyE2E.md)。manifest 固定 `safe_draft_pr` 与 `blocked_secret_publication` 两类 case；canary 只来自显式 opt-in 环境变量且 manifest 只保存 digest。
  - verifier 读取并扫描每个 Action job log（单 job 8 MiB、单 Run 32 MiB，拒绝分页，302/307/308 只接受无 userinfo 的 HTTPS location）；safe case 用 GitHub PR API 核对 same-repo/open/draft/exact head/base/body digest，blocked case 核对 pending publication、settled `pull_request_secret_detected` outbox 并查询同 head/base 的 PR 列表为零。
  - Case 8 新增 `secretArtifacts` ciphertext registry 安全投影与 effect outbox `lastErrorCode` 投影；修正 effect outbox 查询遗漏 `last_error_code` 的审计缺口。raw artifact 只投影 object/attempt/category/ciphertext digest/size/policy/retention metadata，不投影 R2 key、etag、明文或 audit response。
  - 同步 `docs/Proto.md`、`docs/Architecture.md`、`docs/Security.md`、`docs/Reference.md` 与 DOD；仅勾选 Phase 3 的“真实外部证据验收契约”，真实 Action/R2/PR 外部事实保持未勾。
- 验证：
  - `pnpm exec vitest run test/secret-safety-evidence.test.ts` → exit 0，1 file / 3 tests；覆盖 schema/example、safe/blocked、log leak、projection/outbox/artifact/PR/pagination drift、zero-effect、raw/token/canary 零传播和 CLI opt-in。
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/case8-audit-report.test.ts` → exit 0，1 file / 3 tests；覆盖 Case 8 ciphertext registry 和 `pull_request_secret_detected` 投影回归。
  - `pnpm run e2e:secret-safety`（无 opt-in）→ exit 2，固定 `secret-safety-e2e: opt-in missing`，在 manifest/network 前结束。
  - `pnpm run verify` → exit 0；typecheck、ESLint、Node 75 files / 266 tests、workerd 56 files / 299 tests、344 个生产文件 Secret scan 和 Markdown links 全绿。workerd 仅输出既有预期 Workflow terminate 清理信息，无失败 suite。
  - `git diff --check`、`pnpm run verify:docs` → exit 0。
  - `CI=1 pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round96-final-v1` → exit 0，bundle 2599.28 KiB / gzip 437.39 KiB；识别双 Workflow、双 Queue、D1 与四个 R2 binding，未部署。
- 勾选：Phase 3 Secret safety 项新增并勾选“真实外部证据验收契约”；真实试点 Action 注入 canary、完整日志/远端 R2 ciphertext 权限、真实安全 Draft PR 与 Secret-blocked zero-PR effect 仍保持未勾。fake API、schema example、Case 8 fixture、dry-run 或默认 exit 2 不能替代真实外部事实。
- 决策沉淀：Case 8 是 D1-only 安全索引，不能覆盖 live GitHub/R2 事实；Action 自报成功和本地 ciphertext registry 不能证明无泄漏。safe Draft PR 必须同时满足 Action/log clean、Case 8 registry、GitHub PR exact identity；blocked publication 必须同时满足控制面 zero-effect 和 GitHub zero PR。canary 明文只在 verifier 进程内存在，错误码固定且不回显 token/raw。
- 遗留：当前 `git remote -v` 为空，Wrangler D1 ID 仍为占位值，没有已部署 Worker、真实 GitHub App/试点 repo、可写/只读外部 Secret 或有效 R2 审计链接。需用户提供受控前置后，按 [`docs/SecretSafetyE2E.md`](docs/SecretSafetyE2E.md) 在真实试点 Action 中分别产生 clean Draft PR 与 canary-blocked publication，核对完整 logs、artifact registry/R2 权限、PR API/页面和 D1 安全 projection，再以 `DELIVERY_LOOP_SECRET_SAFETY_E2E=1 pnpm run e2e:secret-safety` exit 0 与人工审计入账后才能勾真实子项与 Phase 3 父项。

## Round 97 — 2026-07-26
- 目标：Phase 3 / Agent Adapter 的 `start/resume/interrupt/exportCheckpoint` 真实非交互 CLI 证据契约。本轮补齐“真实调用结果如何被安全核对”的仓库外 manifest/verifier；真实已认证 Codex 模型调用仍保持未完成。
- 前置与权限：仅使用本地 delivery-loop、Watt 固定 commit `476e3cdd2490d725fde174e7c697ebf00899edc6`、fake/strict manifest schema、Node 测试、文档检查和 Wrangler dry-run。未调用计费模型、未访问或修改真实 GitHub/Cloudflare/飞书/Meegle/tool-bridge/业务日志或数据库，未部署、未提交代码或使用真实 Secret；manifest 与错误输出不保存模型输出、Task/PRD、context、workspace 路径、stderr、token 或 checkpoint 正文，按用户要求未更新 llmdoc。
- Watt 复用：真实入口沿用 Watt E2E 的显式 opt-in、固定 0/1/2 退出分层和固定前置错误边界；没有复制第二套 Agent 生命周期。证据层直接复用既有 `AgentSessionResultV1`、`computeAgentCheckpointDigest`、固定 Git 命令和 Codex adapter，新增仅为 digest/枚举/安全 SHA 的 strict manifest 绑定。
- 动作：
  - 新增 strict `AgentAdapterEvidenceManifestV1`、`verifyAgentAdapterEvidence`、`pnpm run e2e:agent-adapter`、`pnpm run verify:agent-adapter-evidence`、schema example 与 [`docs/AgentAdapterE2E.md`](docs/AgentAdapterE2E.md)。manifest 要求 provider/CLI version、`AgentSessionResultV1`、process exit/session、structured output digest、checkpoint sequence/digest/Plan Item/head、workspace head/branch、clean 与 ephemeral 标志；checkpoint 与最终 workspace head 必须 exact 相等。
  - `verify-real-codex-adapter.ts` 成功路径现在只打印该安全 manifest；真实 CLI 仍固定 `--ephemeral --ignore-user-config --sandbox read-only --approval never`、临时仓库、strict output、checkpoint sequence≥2、HEAD clean 和 finally 清理。无 opt-in 或认证无效均不产生成功 manifest。
  - 同步 `docs/Proto.md`、`docs/Architecture.md`、`docs/Security.md`、`docs/Reference.md` 与 DOD；新增并勾选 Agent Adapter 的“真实证据契约”子项，真实认证模型调用保持未勾。
- 验证：
  - `pnpm exec vitest run test/agent-adapter-evidence.test.ts test/real-codex-adapter-verifier.test.ts` → exit 0，2 files / 5 tests；覆盖 strict/example、head/session/raw drift、固定错误和 adapter/manifest 两层 opt-in。
  - `pnpm run e2e:agent-adapter`（无 opt-in）→ exit 2，固定 `real-codex-adapter-e2e: opt-in missing`，认证与模型调用未启动。
  - `pnpm run verify` → exit 0；typecheck、ESLint、Node 76 files / 269 tests、workerd 56 files / 299 tests、348 个生产文件 Secret scan 和 Markdown links 全绿。workerd 仅输出既有预期 Workflow terminate 清理信息，无失败 suite。
  - `git diff --check`、`pnpm run verify:docs` → exit 0。
  - `CI=1 pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round97-final-v1` → exit 0，bundle 2599.28 KiB / gzip 437.39 KiB；识别双 Workflow、双 Queue、D1 与四个 R2 binding，未部署。
- 勾选：Phase 3 Agent Adapter 项新增并勾选“真实 adapter 证据契约”；真实已认证 Codex 调用、结构化结果/ checkpoint/clean Git 的外部成功事实仍保持未勾。help、fake executor、schema example、`codex login status`、默认 exit 2 不能替代真实模型调用。
- 决策沉淀：`AgentAdapterEvidenceManifestV1` 只是成功运行的安全索引，不是模型或 Agent 的自报权限；只有实际进程 exit 0、固定输出 schema、Runner checkpoint、Git HEAD/clean tree 和临时 workspace 全部同时成立才能生成 passed manifest。Codex provider session 不作为长期状态真源，恢复仍依赖外部 checkpoint + Git。
- 遗留：当前本机 Codex credential 状态不能证明 provider 接受真实请求，且没有用户批准的计费模型调用/真实 GitHub Action。需用户提供受控有效凭证后，以 `DELIVERY_LOOP_CODEX_ADAPTER_E2E=1 pnpm run e2e:agent-adapter` 完成一次真实调用，保留安全 manifest 摘要并人工核对后，才能勾选该真实子项与 Agent Adapter 父项。

## Round 98 — 2026-07-26
- 目标：Phase 4 / 测试失败有界修复循环的仓库外证据契约。本轮补齐真实执行链路的 strict manifest/verifier；真实试点 Action、Codex 修复、bot commit 和外部 blocker 事实仍保持未完成。
- 前置与权限：仅使用本地 delivery-loop、Watt 固定 commit `476e3cd`、fake HTTPS response、Case 8/Plan projection fixture、Node/workerd、文档检查和 Wrangler dry-run。未访问或修改真实 GitHub/Cloudflare/飞书/Meegle/tool-bridge/业务日志或数据库，未创建真实修复 Action/commit、未部署、未提交代码或使用真实 Secret；manifest/日志/错误不保存测试输出、Agent正文、failure message、raw GitHub response 或 token，按用户要求未更新 llmdoc。
- Watt 复用：`scripts/verify-repair-loop-evidence.ts`直接沿用 Watt E2E 的显式 opt-in、仓库外 64 KiB manifest、固定安全错误和 0/1/2 退出；verifier 复用生产 `GitHubActionsApiClient` workflow-run parser，以及 Watt-derived 有界 HTTPS、origin 校验和分页 fail-closed。没有复制第二套通用 Actions parser；retry scope/fingerprint、Attempt/Plan/Item、blocker 和 Evidence 仍由 delivery-loop 自有控制面提供。
- 动作：
  - 新增 strict `RepairLoopEvidenceManifestV1`、`verifyRepairLoopEvidence`、`pnpm run e2e:repair-loop`、schema example 与 [`docs/RepairLoopE2E.md`](docs/RepairLoopE2E.md)。manifest 固定三类 case：`repair_succeeded`、`repeated_fingerprint_blocked`、`attempt_limit_blocked`；绑定 Run/Plan/Item、Attempt ordinal/mode/head、failure fingerprint、Action conclusion、commit/test Evidence、blocker reason/count 和 execution dispatch 数量。
  - verifier 先读取 `/v1/runs/:runId/plan` 与 Case 8 audit，再核对每个 Action 的唯一 job、trusted checkout/execution step；成功修复还核对 GitHub commit API、分支 ref 与 `checkoutSha...resultHeadSha` fast-forward compare。额外 Action/commit、head drift、blocker/fingerprint/count drift、分页和 raw/token 均 fail-closed。
  - 同步 `docs/Proto.md`、`docs/Architecture.md`、`docs/Security.md`、`docs/Reference.md` 与 DOD；新增并勾选固定 workflow 的“修复循环真实外部证据契约”子项，真实试点 Action 子项保持未勾。
- 验证：
  - `pnpm exec vitest run test/repair-loop-evidence.test.ts` → exit 0，1 file / 3 tests；覆盖 strict/example、success/repeated/attempt-limit、control/action/raw drift、token/raw 零传播和 CLI opt-in。
  - `pnpm run e2e:repair-loop`（无 opt-in）→ exit 2，固定 `repair-loop-e2e: opt-in missing`，manifest/network 前结束。
  - `pnpm run verify` → exit 0；typecheck、ESLint、Node 77 files / 272 tests、workerd 56 files / 299 tests、352 个生产文件 Secret scan 和 Markdown links 全绿。workerd 仅输出既有预期 Workflow terminate 清理信息，无失败 suite。
  - `git diff --check`、`pnpm run verify:docs` → exit 0。
  - `CI=1 pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round98-final-v1` → exit 0，bundle 2599.28 KiB / gzip 437.39 KiB；识别双 Workflow、双 Queue、D1 与四个 R2 binding，未部署。
- 勾选：Phase 4 测试失败修复项新增并勾选“修复循环真实外部证据契约”；真实固定 workflow 调用锁定 Codex、修复 commit/Evidence、同 fingerprint 第二次阻断、第三 Attempt 上限及 `workflow_run` 最终一致仍保持未勾。fake Action、schema example、仅重跑测试、dry-run 或默认 exit 2 不能替代真实外部事实。
- 决策沉淀：repair manifest 是 live D1/GitHub 事实的安全索引，不能由 manifest 自选 blocker 或 attempt count；只有控制面 `/plan`、Case 8 audit、GitHub Action/job 与 Git commit/ref/compare 同时一致才算 repair evidence。`review_fix` 不继承旧 token/credential/branch，Action 自报 failure 不会消耗 retry budget。
- 遗留：当前 `git remote -v` 为空，Wrangler D1 ID 仍为占位值，没有已部署 Worker、真实 GitHub App/试点 repo、有效 Action/Codex 凭证或真实 blocker 审计链接。需用户提供受控前置后，按 [`docs/RepairLoopE2E.md`](docs/RepairLoopE2E.md) 真实产生一次修复成功、一次同 fingerprint 阻断和一次三次上限阻断，记录 Actions/commit/Evidence/Case 8 安全链接，再以 `DELIVERY_LOOP_REPAIR_LOOP_E2E=1 pnpm run e2e:repair-loop` exit 0 和人工审计入账后才能勾真实子项与 Phase 4 父项。

## Round 99 — 2026-07-27
- 目标：Phase 0 / `.github/workflows/ci.yml` 在 GitHub main/pull_request 上实际运行成功且权限只有 `contents: read`；`validate-task.yml` 对合法 TaskEnvelope 成功、无验收标准/非法 schema 失败且日志不打印正文。本轮只闭环两项共用的真实外部证据验收契约，真实 GitHub run 父项保持未勾。
- 前置与权限：仅使用本地 delivery-loop、Watt 固定 commit `476e3cd` 的既有复用结论、fake HTTPS response、Node/workerd 回归、文档检查和 Wrangler dry-run。未访问或修改真实 GitHub/Cloudflare/飞书/Meegle/tool-bridge/日志/业务数据库，未创建远端、push、PR、workflow_dispatch 或部署，未提交代码或使用真实 Secret；manifest/错误不保存 Task/run title/workflow/log/raw response/token/canary 明文，按用户要求未更新 llmdoc。
- Watt 直接复用：`scripts/verify-ci-evidence.ts` 沿用显式 opt-in、仓库外 64 KiB manifest、固定 0/1/2 退出、安全错误、有界 HTTPS、origin 校验和分页 fail-closed；run metadata 继续复用生产 `GitHubActionsApiClient`，没有复制第二套通用 Actions parser。Watt 没有 delivery-loop 的 Phase 0 四类 CI case、exact workflow/validation-step 或 invalid Task canary 断言，这些为本项目新增。
- 动作：
  - 接续 Round 99 半成品先运行 typecheck，确认 `displayTitle`/`displayTitleDigest` 和 `push|pull_request` event 类型不一致形成真实红灯；manifest 改为只保存 title digest，workflow run parser 扩展只读 event，同时把业务 Attempt projector 显式限制为 `workflow_dispatch`，避免扩大生产状态入口。
  - 新增 strict `CiEvidenceManifestV1`，固定 `ci_main_success`、`ci_pull_request_success`、`validate_valid_success`、`validate_invalid_failure` 四类唯一 case；每条只保存 run/workflow/job 的 ID、SHA、digest、枚举和安全 URL，invalid canary 只有 digest。
  - 新增 `verifyCiEvidence` 与 `pnpm run e2e:ci`：按 run exact head SHA 读取 workflow blob，重算 digest并解析 YAML；trigger、唯一 job、setup/validate 命令必须匹配固定契约，顶层权限恰好只有 `contents: read`。随后复用 production Actions parser，核对唯一 job；invalid case 还要求所有前置 step 成功、命名 validation step 失败，再有界扫描四份 job log。
  - 新增 schema example、[`docs/CIE2E.md`](docs/CIE2E.md) 和正反测试；同步 DOD、Proto、Architecture、Security、Reference。两个父 DoD 只新增并勾选“真实外部证据验收契约”，真实 Actions 事实仍未勾。
- 验证：
  - `pnpm run typecheck` → 首次 exit 2：`expectedEvent` 仍只接受 workflow_dispatch/deployment，且 schema 暴露 `displayTitle` 而 verifier 读取 `displayTitleDigest`；修正后 exit 0。
  - `pnpm exec vitest run test/ci-evidence.test.ts` → 首次 4/6 failed，暴露 canary regex 上界误写为带下划线的量词并全部返回 `configuration_invalid`；修正并补 exact workflow/action drift 后最终 exit 0，1 file / 6 tests。覆盖四类成功、permission/action/run title/event/conclusion/SHA 漂移、job/validation step 漂移、canary leak、分页/超限、raw/token/canary 零传播和 CLI opt-in。
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/github-run-reconciler.test.ts test/workflow/github-dispatcher.test.ts` → exit 0，2 files / 11 tests，既有 Attempt reconciliation/dispatch 的 workflow_dispatch 边界无回归。
  - `pnpm run e2e:ci`（无 opt-in）→ exit 2，固定 `ci-e2e: opt-in missing`，在 manifest/network 前结束。
  - `pnpm run verify` → 首次 exit 1：新增 CLI 子进程与全量并发叠加后 10 个既有 5 秒测试超时；把本轮 CLI 测试从嵌套 `pnpm` 改为直接锁定 workspace `tsx` 后，`pnpm run test:unit` 为 78 files / 278 tests，最终全量 exit 0：Node 78 files / 278 tests、workerd 56 files / 299 tests、356 个生产文件 Secret scan和文档链接全绿。workerd 仅输出既有预期 Workflow terminate 清理信息，无失败 suite。
  - `CI=1 WRANGLER_SEND_METRICS=false pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round99-final-v1` → exit 0，bundle 2599.37 KiB / gzip 437.40 KiB；识别双 Workflow、双 Queue、D1 与四个 R2 binding，未部署。
  - `pnpm run verify:docs`、`git diff --check` → exit 0。
- 勾选：Phase 0 CI main/PR 与 validate-task 两项分别新增并勾选“真实外部证据验收契约”；两个真实 GitHub 父项保持未勾。fake API、schema example、本地 verify、dry-run 或默认 exit 2 均不能替代真实 Actions URL/API。
- 决策沉淀：CI 证据必须绑定实际 run 的 immutable head workflow blob，不能拿当前 main、本地文件或 manifest 覆盖历史执行；invalid workflow 只有在 setup 成功而命名 validation step 失败时才证明 schema 拒绝，整个 job 安装失败不算。run title和 canary 只保存 canonical digest，真实日志在 verifier 内存扫描后丢弃。
- 遗留：当前 `git remote -v` 为空，没有用户确认的 owner/visibility/默认分支保护，也没有 main/PR/合法与非法 workflow_dispatch run。需用户提供受控 GitHub repo 和 Actions/Contents read 前置后，按 [`docs/CIE2E.md`](docs/CIE2E.md) 产生四条真实 run、保存仓库外 manifest，并以 `DELIVERY_LOOP_CI_E2E=1 pnpm run e2e:ci` exit 0 与 Actions URL/API 人工核对入账；只有届时才能勾两个真实父项。

## Round 100 — 2026-07-27
- 目标：Phase 0 / `新仓库远端、owner、visibility 和默认分支保护由用户确认后创建；本地初始化不能冒充远端已完成`。本轮只闭环真实外部证据验收契约；用户尚未确认且远端不存在，父项保持未勾。
- 前置与权限：只使用本地 delivery-loop、Watt 固定 commit `476e3cd`、fake HTTPS response、固定Git argv、Node/workerd回归、文档检查和 Wrangler dry-run。未访问或修改真实 GitHub/Cloudflare/飞书/Meegle/tool-bridge/日志/业务数据库，未创建仓库、设置remote、配置branch rules、部署或提交代码，未使用真实token/Secret；manifest与错误不保存人审正文、raw rules/REST、remote credential或token，按用户要求未更新llmdoc。
- Watt 直接复用：完整读取Watt `scripts/e2e/lib.ts`与CI workflow并检索repository/bootstrap/branch protection；Watt只有显式opt-in、前置exit 2和0/1/2 E2E收口，没有GitHub repository/bootstrap或branch-rules业务模块可直接复制。`verify-repository-bootstrap-evidence.ts`沿用其门禁/退出纪律；GitHub 1 MiB有界JSON/分页fail-closed和`git remote get-url origin`固定argv直接复用delivery-loop既有生产边界，没有复制Watt会传播stderr/raw错误的CLI helper。
- 动作：
  - 先写红灯：`test/repository-bootstrap-evidence.test.ts` 初始failed suite / 0 tests，缺domain模块；随后新增strict `RepositoryBootstrapEvidenceManifestV1`，把仓库外decision ID/time、确认主体digest、owner/repo/visibility/default branch/active rules digest与repository/branch安全标量固定为不可混淆索引。
  - 新增只读`verifyRepositoryBootstrapEvidence`与`pnpm run e2e:repository-bootstrap`：先重算rules/selection digest，再用固定Git argv读取本地origin并只接受无credential GitHub HTTPS/SSH；最后读取GitHub repository、default branch与applicable branch rules，核对numeric ID/owner/type/visibility/lifecycle、protected/head和全部active rule parameters digest。响应1 MiB且分页fail-closed，任何错误只返回固定code。
  - 新增schema example与[`docs/RepositoryBootstrapE2E.md`](docs/RepositoryBootstrapE2E.md)，同步DOD、Proto、Architecture、Security、Reference和公共export。文档明确manifest不能自证用户确认，exit 0仍必须与仓库外人审记录和真实GitHub页面/API共同入账。
  - 全量Node首次出现既有Git fixture的5秒并发超时；`--maxWorkers=4`验证79 files全绿后，把Node file concurrency固定为4，使行为超时不再测量宿主进程过量并发，没有提高或跳过任何单测timeout。
- 验证：
  - 红灯`pnpm exec vitest run test/repository-bootstrap-evidence.test.ts` → exit 1，failed suite / 0 tests；实现后首次1/6 failed，暴露测试构造只改变decision visibility导致schema先拒绝；让repository snapshot同步变化后，最终exit 0，1 file / 6 tests。覆盖decision digest、本地HTTPS/SSH origin、credential/跨repo/非GitHub remote、repository visibility/default/lifecycle、branch SHA/protected、rule parameters、分页/超限、raw/token零传播和CLI opt-in。
  - `pnpm run e2e:repository-bootstrap`（无opt-in）→ exit 2，固定`repository-bootstrap-e2e: opt-in missing`，在manifest/Git/network前结束。
  - `pnpm run typecheck` → exit 0；`pnpm run lint`首次exit 1（两个正则无用转义），修正后exit 0。
  - `pnpm run verify` → 首次exit 1：2个既有真实Git fixture在10核文件并发下撞到5秒timeout；`pnpm exec vitest run --maxWorkers=4`为79 files / 284 tests全绿并写入`vitest.config.ts`后，最终exit 0：Node 79 files / 284 tests、workerd 56 files / 299 tests、360个生产文件Secret scan和文档链接全绿。workerd仅输出既有预期Workflow terminate清理信息，无失败suite。
  - `CI=1 WRANGLER_SEND_METRICS=false pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round100-final-v1` → exit 0，bundle 2599.37 KiB / gzip 437.40 KiB；识别双Workflow、双Queue、D1与四个R2 binding，未部署。
  - `pnpm run verify:docs`、`git diff --check` → exit 0。
- 勾选：Phase 0远端创建项新增并勾选“真实外部证据验收契约”；父项保持未勾。schema example、decision/manifest自报、fake API、本地`git init`、dry-run或默认exit 2不能替代用户确认和真实GitHub remote/rules。
- 决策沉淀：用户决策、local origin和GitHub live fact是三种不同authority，必须同时一致；manifest只冻结digest与安全标量。verifier没有create/update路径，也不应从DOD文字推断owner/visibility/保护策略；真正创建远端仍需用户明确选择。GitHub rules只记录当前active规则，每条raw parameters只在内存计算canonical digest后丢弃。
- 遗留：`git remote -v`仍为空，也没有用户确认记录、GitHub repository ID、default branch head或active rules事实。需要用户明确owner/repo/visibility/default branch/protection policy并授权创建后，按[`docs/RepositoryBootstrapE2E.md`](docs/RepositoryBootstrapE2E.md)创建真实仓库、设置无credential origin、配置rules、保存仓库外decision/manifest，以`DELIVERY_LOOP_REPOSITORY_BOOTSTRAP_E2E=1 pnpm run e2e:repository-bootstrap` exit 0和人工核对入账；只有届时才能勾父项并继续真实CI。

## Round 101 — 2026-07-27
- 目标：Phase 1 / `DeliveryRunWorkflow` 的副作用全部在稳定命名`step.do`；强制hibernate/restart Worker后复用成功步骤，dispatch只发生一次，D1 Run投影仍正确。本轮只闭环真实Cloudflare hibernate + Worker redeploy + 唯一GitHub Action的外部证据验收契约；真实远端演练与父项保持未完成。
- 前置与权限：仅使用本地delivery-loop、Watt固定commit `476e3cdd2490d725fde174e7c697ebf00899edc6`、Wrangler 4.107.0内置Cloudflare SDK路径、fake HTTPS、Node/workerd回归、文档检查和Wrangler dry-run。未访问或修改真实GitHub/Cloudflare/飞书/Meegle/tool-bridge、日志或业务数据库，未触发Action、未发布Worker、未发送Workflow event、未部署或提交代码，未使用真实Secret；manifest/错误不保存Cloudflare instance/step output/error、GitHub raw响应、Task/Plan正文、token或数据库行，按用户要求不更新llmdoc。
- Watt直接复用：Watt的`taskId/runId = Workflow instance ID`、稳定命名`step.do`/`waitForEvent`、D1业务投影和显式opt-in/固定0-1-2 E2E门禁继续直接复用；GitHub run metadata复用delivery-loop现有production `GitHubActionsApiClient`，没有复制第二套Actions parser。Watt没有Cloudflare REST + D1 + GitHub三方外部verifier，因此deployment/instance/Case 8绑定为delivery-loop新增，没有虚构可复制的业务模块。
- 动作：
  - 先写红灯：`test/workflow-hibernate-evidence.test.ts`首次为failed suite / 0 tests，缺`src/domain/workflow-hibernate-evidence.ts`；随后新增strict `WorkflowHibernateEvidenceManifestV1`、只读`verifyWorkflowHibernateEvidence`、`pnpm run e2e:workflow-hibernate`和schema example。
  - verifier交叉核对`GET /v1/runs/:runId/plan`与Case 8：Run固定`awaiting_approval`、active Plan由唯一completed analysis Attempt生成、`analysis_dispatch` outbox唯一且settled、Workflow安全投影为同ID `waiting`且无restart/recreate reconciliation；D1仍是业务真源。
  - 读取官方Cloudflare Workflow instance与Worker deployments API：七条平台step必须严格按`register-run → dispatch-analysis-attempt → await-analysis-result → verify-analysis-result → activate-analysis-plan → observe-run-control-state → await-run-terminal`排列；前两步在wait前成功、wait跨过Worker redeploy、后三步在wait结束后继续、最后仍waiting。进一步要求before是wait开始时最后生效deployment，wait期间只有一个after deployment，避免任意两条历史deployment误配成恢复事实。
  - GitHub核对exact analysis run的repo/event/path/SHA/branch/stable title/run-attempt/conclusion，并在完整workflow inventory中要求`delivery-loop/<attemptId>`恰好一条；响应1 MiB、分页/超限/错误时间线/重复Action全部fail-closed。Cloudflare account只以digest入manifest，Dashboard链接限定无query的`dash.cloudflare.com`，所有token只进入Authorization header。
  - 新增[`docs/WorkflowHibernateE2E.md`](docs/WorkflowHibernateE2E.md)，同步`DOD.md`、`docs/Proto.md`、`docs/Architecture.md`、`docs/Security.md`、`docs/Reference.md`与公共export；只勾选本项“真实外部证据验收契约”子项。
- 验证：
  - 红灯`pnpm exec vitest run test/workflow-hibernate-evidence.test.ts` → exit 1，failed suite / 0 tests；实现后最终exit 0，1 file / 6 tests。覆盖strict/example、D1 Run/Workflow projection drift、deployment/version/唯一wait内deployment与step时间线漂移、GitHub failure/duplicate、分页/超限、raw/token零传播和CLI opt-in。
  - `pnpm run typecheck`、`pnpm run lint` → exit 0；收紧deployment/step时间线后再次运行仍exit 0。
  - `pnpm run e2e:workflow-hibernate`（无opt-in）→ exit 2，固定`workflow-hibernate-e2e: opt-in missing`，在manifest/token/account/network前结束。
  - `pnpm run verify` → exit 0：typecheck、ESLint、Node 80 files / 290 tests、workerd 56 files / 299 tests、364个生产文件Secret scan和文档链接全绿。workerd仅输出既有预期Workflow terminate清理信息，无失败suite。
  - `CI=1 WRANGLER_SEND_METRICS=false pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round101-final-v2` → exit 0，bundle 2599.37 KiB / gzip 437.40 KiB；识别双Workflow、双Queue、D1与四R2 binding，未部署。
  - `pnpm run verify:docs`、`git diff --check` → exit 0。
- 勾选：Phase 1 Workflow hibernate/restart项新增并勾选“真实外部证据验收契约”；真实Cloudflare hibernate/Worker redeploy、GitHub Action与父项保持未勾。fake API、schema example、本地workerd restart、Wrangler dry-run或默认exit 2不能替代真实外部事实。
- 决策沉淀：普通hibernate/redeploy与controlled replay是两种恢复事实：前者不调用restart API，而是在durable wait期间跨Worker deployment继续；后者从terminal instance的受控target restart。before/after deployment ID本身不能证明跨版本，必须用完整deployment时间线确定wait开始时生效版本与wait内唯一发布；Cloudflare step成功、D1 projection和GitHub唯一Action三种authority也不能互相替代。
- 遗留：当前`git remote -v`为空、Wrangler D1 ID仍是占位值，没有已部署Worker、Cloudflare Paid Workflow、真实GitHub App/试点repo或只读凭证。需要用户提供受控试点前置后，按[`docs/WorkflowHibernateE2E.md`](docs/WorkflowHibernateE2E.md)在一个真实analysis wait中发布before/after Worker版本、回传同一Action结果并保存仓库外manifest；只有`DELIVERY_LOOP_WORKFLOW_HIBERNATE_E2E=1 pnpm run e2e:workflow-hibernate` exit 0和Cloudflare/GitHub/控制面链接人工入账后，才能勾真实子项与父项。

## Round 102 — 2026-07-27
- 目标：Phase 1 / GitHub App只安装到试点仓库，dispatcher成功触发固定workflow ref且dispatch payload无Secret/任务正文。本轮只闭环单仓库installation + D1 dispatch + 固定workflow blob + 唯一Action/job的真实外部证据验收契约；真实安装/Action与父项保持未完成。
- 前置与权限：仅使用本地delivery-loop、Watt固定commit `476e3cdd2490d725fde174e7c697ebf00899edc6`的既有复用结论、fake HTTPS、Node/workerd回归、文档检查和Wrangler dry-run。未访问或修改真实GitHub/Cloudflare/飞书/Meegle/tool-bridge、日志或业务数据库，未安装App、未签发真实token、未触发Action、未部署或提交代码，未使用真实Secret；manifest/错误不保存App JWT、installation token、workflow/job/raw API正文或Task/Plan/数据库正文，按用户要求不更新llmdoc。
- Watt直接复用：Watt没有GitHub App、installation repository inventory、workflow blob或Actions REST业务模块，本轮没有把不存在的代码虚构为可复制；直接沿用其显式opt-in、仓库外64 KiB manifest、固定0-1-2退出和安全错误纪律。Action run metadata继续复用delivery-loop production `GitHubActionsApiClient`，固定workflow契约复用现有`delivery-agent-workflow`测试所验证的run-name/inputs/permissions/pinned Actions/clean-workspace语义，没有复制第二套run parser。
- 动作：
  - 先写红灯：`test/github-app-dispatch-evidence.test.ts`首次exit 1，failed suite / 0 tests，缺`src/domain/github-app-dispatch-evidence.ts`；随后新增strict `GitHubAppDispatchEvidenceManifestV1`、只读`verifyGitHubAppDispatchEvidence`、`pnpm run e2e:github-app-dispatch`和schema example。
  - App JWT实时交叉读取`/app`、`/app/installations/:id`和`/repos/:repo/installation`，绑定numeric App/installation/target/repo ID、slug/owner/target、allowlisted permissions/events、`repository_selection=selected`与未suspend；短期installation audit token读取完整`/installation/repositories`并要求单repo identity/visibility/default branch/lifecycle和inventory digest一致。
  - verifier读取D1 Run/active Plan与Case 8，要求唯一completed analysis Attempt、exact fixed workflow ref、唯一settled `analysis_dispatch` outbox及GitHub run binding；再按Action immutable head读取workflow blob、重算content digest并解析YAML，拒绝当前main/本地文件替代历史执行。
  - GitHub live Action必须绑定repo/event/head/default branch/path/stable title/run-attempt/updated-at/conclusion；完整workflow inventory只允许一个stable-title run，jobs API只允许一个successful `attempt` job，其中analysis与clean-workspace step成功、execution step skipped。响应1 MiB、workflow decoded 256 KiB，分页/超限/权限事件/库存/工作流/job漂移均fail-closed。
  - 审计Round 101真实Case 8形状时修正其hibernate verifier：analysis Attempt没有写代码`headSha`，应核对创建时可信`baseSha`；测试fixture同步删除伪造head事实，避免真实E2E被错误拒绝。
  - 新增[`docs/GitHubAppDispatchE2E.md`](docs/GitHubAppDispatchE2E.md)，同步`DOD.md`、`docs/Proto.md`、`docs/Architecture.md`、`docs/Security.md`、`docs/Reference.md`和公共export；只勾选本项“真实外部证据验收契约”。文档明确audit token可能预先按repo二次narrow且无法从字符串发现，所以settings页与credential issuance审计不可省略。
- 验证：
  - 红灯`pnpm exec vitest run test/github-app-dispatch-evidence.test.ts` → exit 1，failed suite / 0 tests；实现后首次4/6 failed，暴露token regex把数字分隔符写进quantifier并全部`configuration_invalid`；修正后最终exit 0，1 file / 6 tests。覆盖strict/example、App/installation/repo drift、D1 projection、workflow/job/duplicate Action、分页/超限、credential/raw零传播和CLI opt-in。
  - `pnpm exec vitest run test/github-app-dispatch-evidence.test.ts test/workflow-hibernate-evidence.test.ts` → exit 0，2 files / 12 tests；Round 101 baseSha真实性修正与本轮契约同时通过。
  - `pnpm run e2e:github-app-dispatch`（无opt-in）→ exit 2，固定`github-app-dispatch-e2e: opt-in missing`，在manifest/token/network前结束。
  - `pnpm run typecheck`、`pnpm run lint`、`pnpm run verify:docs`、`git diff --check` → exit 0。
  - `pnpm run verify` → exit 0：typecheck、ESLint、Node 81 files / 296 tests、workerd 56 files / 299 tests、368个生产文件Secret scan和文档链接全绿。workerd仅输出既有预期Workflow terminate清理信息，无失败suite。
  - `CI=1 WRANGLER_SEND_METRICS=false pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round102-final-v1` → exit 0，bundle 2599.37 KiB / gzip 437.40 KiB；识别双Workflow、双Queue、D1与四R2 binding，未部署。
- 勾选：Phase 1 GitHub App/dispatcher项新增并勾选“真实外部证据验收契约”；真实single-repo installation、Actions run/job与父项保持未勾。fake API、schema example、其他E2E Action URL、本地workflow test、dry-run或默认exit 2不能替代真实安装事实。
- 决策沉淀：App对象、installation配置、installation token可见repo、D1 dispatch、immutable workflow和Action/job是不同authority。尤其`GET /installation/repositories`只能证明“该token看见一个repo”，不能证明token签发时没有`repositories/repository_ids`二次narrow；真实关门必须同时核对GitHub settings页和credential issuance audit，verifier exit 0不能覆盖这一人工事实。
- 遗留：当前`git remote -v`为空，没有用户确认的试点repo、GitHub App owner/installation或已部署控制面，也无可用App JWT/未narrow audit token。需用户提供受控前置后，按[`docs/GitHubAppDispatchE2E.md`](docs/GitHubAppDispatchE2E.md)只选试点repo、从D1正常触发一个analysis Run、保留settings/credential审计和仓库外manifest；只有`DELIVERY_LOOP_GITHUB_APP_DISPATCH_E2E=1 pnpm run e2e:github-app-dispatch` exit 0及人审链接入账后，才能勾真实子项与父项。

## Round 103 — 2026-07-27
- 目标：Phase 1 / 一个真实Action只读检出目标repo，Codex按用户反馈/PRD分析并按需读取只读上下文，输出带Evidence refs的合法ExecutionPlan且不创建分支、不写repo。本轮只闭环Task/Plan/context/immutable Runner/Codex/Git三联检查的真实外部证据验收契约；真实Action与父项保持未完成。
- 前置与权限：仅使用本地delivery-loop、Watt固定commit`476e3cdd2490d725fde174e7c697ebf00899edc6`的既有复用结论、fake HTTPS、Node/workerd回归、文档检查和Wrangler dry-run。未访问或修改真实GitHub/Cloudflare/飞书/Meegle/tool-bridge、日志或业务数据库，未调用Codex模型、触发Action、创建branch/commit、部署或提交代码，未使用真实Secret；manifest/错误不保存Task/Plan/Item正文、Evidence ref原值、tool参数/result、Runner/workflow正文、raw API或token，按用户要求不更新llmdoc。
- Watt直接复用：`verify-analysis-action-evidence.ts`继续直接沿用Watt-derived显式opt-in、仓库外64 KiB manifest、固定0/1/2退出和安全固定错误纪律；Task/context/code/tool结果按Watt HTBP规则保持不可信数据。GitHub App/installation/workflow/Action/job核对不复制，生产verifier直接调用Round 102 `verifyGitHubAppDispatchEvidence`。Watt没有delivery-loop的Task/ExecutionPlan/Case 8或Runner source contract模块，对应业务交叉核对为本项目新增，没有虚构Watt来源。
- 动作：
  - 先写红灯：`test/analysis-action-evidence.test.ts`首次exit 1、failed suite / 0 tests，缺`src/domain/analysis-action-evidence.ts`；随后新增strict `AnalysisActionEvidenceManifestV1`、live verifier、`pnpm run e2e:analysis-action`、schema example和[`docs/AnalysisActionE2E.md`](docs/AnalysisActionE2E.md)。
  - `/v1/runs/:id/plan`新增安全投影：assumption只公开count，Evidence refs只公开count和有序数组canonical digest，Item公开纯数字acceptance criteria indexes；workerd测试证明assumption/ref原值不回显。外部verifier据此要求refs至少1条、Item ID/依赖/DAG/doneWhen/Evidence合法且required Items覆盖全部Task acceptance criteria。
  - Task query绑定`bug→user_feedback`、`requirement→prd`；Case 8 context只允许repository/logs/traces/K8s/database的成功read聚合，至少含repository，attempt IDs必须exact且全部grant scopes为triage只读；analysis Attempt出现repo-write credential即失败。
  - immutable Runner contract固定八文件：entrypoint、Runner、Codex adapter、Plan domain/schema、package和pnpm lock。verifier按Action exact base SHA逐文件核对Git blob/content digest，package和lock双重锁定Codex版本，再把聚合digest与manifest外release review配置比较，拒绝当前main或manifest自选expected值替代受审源码。
  - 固定workflow的always-run关口由单一porcelain检查收紧为`HEAD == checkout_sha + detached HEAD + clean workspace`；Round 102 workflow parser同步要求三联命令和可信env，live job仍必须observed success。GitHub不提供瞬态本地branch历史，文档要求有组织Runner审计时人工补强，不能让manifest布尔值自证。
  - 同步`DOD.md`、`docs/Proto.md`、`docs/Architecture.md`、`docs/Security.md`、`docs/Reference.md`和公共export；只勾本项“真实外部证据验收契约”。
- 验证：
  - 红灯`pnpm exec vitest run test/analysis-action-evidence.test.ts` → exit 1，failed suite / 0 tests；实现后与Round 102及workflow契约联合 → exit 0，3 files / 13 tests。覆盖反馈/PRD schema、Task/Plan/Item漂移、denied context/write credential、Runner/source review/Codex lock、Git三联job、超限/raw/credential零传播和CLI opt-in。
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/task-query-api.test.ts` → exit 0，1 file / 3 tests；新增Plan ref/assumption安全投影与acceptance indexes断言。
  - `pnpm run e2e:analysis-action`（无opt-in）→ exit 2，固定`analysis-action-e2e: opt-in missing`；设置opt-in但缺真实配置 → exit 2，固定`required analysis Action configuration is incomplete`。两者都不是skip或成功，且在manifest/credential/network前结束。
  - `pnpm run verify` → exit 0：typecheck、ESLint、Node 82 files / 302 tests、workerd 56 files / 299 tests、372个生产文件Secret scan和文档链接全绿。workerd仅输出既有预期Workflow terminate清理信息，无失败suite。
  - `CI=1 WRANGLER_SEND_METRICS=false pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round103-final` → exit 0，bundle 2600.99 KiB / gzip 437.59 KiB；识别双Workflow、双Queue、D1与四R2 binding，未部署。
  - `pnpm run typecheck`、`pnpm run lint`、`pnpm run verify:docs`与`git diff --check` → exit 0。
- 勾选：Phase 1真实analysis Action项新增并勾选“真实外部证据验收契约”；真实GitHub Action/Codex调用和父项保持未勾。fake HTTPS、schema-valid example、本地Runner/workflow测试、Wrangler dry-run或默认exit 2不能替代真实外部事实。
- 决策沉淀：Action success、D1 active Plan、Case 8 context、immutable Runner source、Codex lock和最终Git状态是不同authority，任一面不能替代其余事实。clean workspace单独不能排除commit/branch漂移，必须同时核对exact HEAD与detached；而GitHub job API仍看不到“创建后删除”的瞬态branch，所以source review和可用的组织Runner审计是必要补强。Evidence refs原值可能携带内部定位信息，状态API只公开count+digest。
- 遗留：当前`git remote -v`为空、Wrangler D1 ID仍为占位值，没有试点repo/App/已部署控制面、有效Codex credential或manifest外release review记录。需用户提供这些前置后，按[`docs/AnalysisActionE2E.md`](docs/AnalysisActionE2E.md)经正常链路提交一份反馈/PRD、触发唯一analysis Action并保存仓库外manifest；只有`DELIVERY_LOOP_ANALYSIS_ACTION_E2E=1 pnpm run e2e:analysis-action` exit 0以及Action/job/release review/可用Runner审计链接人工入账后，才能勾真实子项与父DoD。

## Round 104 — 2026-07-27
- 目标：Phase 1 / Runner每30～60秒heartbeat；正常完成写attempt result，控制面状态与GitHub run外部事实一致。本轮只闭环连续heartbeat receipt + result + signed final webhook + live GitHub API的真实外部证据验收契约；真实Action与父项保持未完成。
- 前置与权限：仅使用本地delivery-loop、Watt固定commit`476e3cdd2490d725fde174e7c697ebf00899edc6`的既有复用结论、fake HTTPS、D1/workerd回归、文档检查和Wrangler dry-run。未访问或修改真实GitHub/Cloudflare/飞书/Meegle/tool-bridge、日志或业务数据库，未触发Action、重放webhook、部署或提交代码，未使用真实Secret；manifest/receipt/错误不保存run/tool token或其digest、raw webhook/REST、Task/Plan正文、Runner输出或数据库行，按用户要求未更新llmdoc。
- Watt直接复用：`verify-runner-heartbeat-evidence.ts`继续沿用Watt-derived显式opt-in、仓库外64 KiB manifest、固定0/1/2退出、安全固定错误与有界HTTPS读取纪律；App/Action/API/Runner全链路直接调用Round 103 `verifyAnalysisActionEvidence`，没有复制第二套GitHub verifier。Watt没有heartbeat receipt ledger、Attempt result/GitHub final projection或Case 8 observation业务模块，对应实现为delivery-loop新增，没有虚构Watt来源。
- 动作：
  - 先写红灯：`pnpm exec vitest run test/runner-heartbeat-evidence.test.ts`首次exit 1，缺`runner-heartbeat-evidence` domain/verifier；随后新增strict `RunnerHeartbeatEvidenceManifestV1`、live verifier、`pnpm run e2e:runner-heartbeat`、schema example与[`docs/RunnerHeartbeatE2E.md`](docs/RunnerHeartbeatE2E.md)。
  - 识别到`attempts.heartbeat_at`最新值不能证明30～60秒cadence，migration 0056新增append-only `attempt_heartbeat_receipts`。每次成功heartbeat CAS、run/tool token轮换与receipt INSERT位于同一D1 batch；stable receipt绑定attempt/generation/前后version，postcheck要求receipt确实存在，20路并发失败者不能插入伪receipt。表结构没有token/token digest，`(attempt,version)`唯一且UPDATE trigger拒绝改写。
  - `GET /v1/runs/:runId/plan`新增最多1000条receipt、reference-only result与GitHub final-state安全投影；workerd测试覆盖两条45秒链、90秒lease、result/Plan绑定、GitHub observation字段及token/digest零泄漏。Case 8新增webhook/API run observation安全索引，并对ID/digest/repo/run/attempt/state/ignore reason和时间线fail-closed校验。
  - verifier先完整复用Round 103 Analysis Action证据，再从live Plan投影重算至少两条receipt的连续version、每段30000～60000ms、90000ms lease、首末值与canonical digest；completed analysis Attempt必须为末条receipt version + 1，result必须是sequence 1和exact active Plan ref/digest。D1 final projection必须为同Action `completed/success + updated_at`；Case 8还必须存在manifest指定的唯一signed `webhook/applied` final observation，嵌入verifier同时以Actions API核对live run。
  - 同步`DOD.md`、`docs/Proto.md`、`docs/Architecture.md`、`docs/Security.md`、`docs/Reference.md`和公共export；只勾本项“真实外部证据验收契约”。
- 验证：
  - 红灯`pnpm exec vitest run test/runner-heartbeat-evidence.test.ts` → exit 1（domain/verifier不存在）；实现后最终exit 0，1 file / 5 tests。覆盖strict/example、连续cadence/version/lease/digest、result/GitHub/webhook漂移、Round 103 verifier复用、有界响应、raw/credential零传播和CLI opt-in。
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/runner-api.test.ts test/workflow/task-query-api.test.ts test/workflow/case8-audit-report.test.ts` → exit 0，3 files / 11 tests；20路单receipt、两条45秒receipt、安全查询和Case 8损坏projection fail-closed通过。
  - `pnpm run e2e:runner-heartbeat`（无opt-in）→ exit 2，固定`runner-heartbeat-e2e: opt-in missing`；`DELIVERY_LOOP_RUNNER_HEARTBEAT_E2E=1 pnpm run e2e:runner-heartbeat`（缺配置）→ exit 2，固定`required Runner heartbeat configuration is incomplete`；两条都在manifest/credential/network前结束。
  - `pnpm run verify` → exit 0：typecheck、ESLint、Node 83 files / 307 tests、workerd 56 files / 301 tests、377个生产文件Secret scan和文档链接全绿。workerd仅输出既有预期Workflow terminate清理信息，无失败suite。
  - `CI=1 WRANGLER_SEND_METRICS=false pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round104-final` → exit 0，bundle 2610.34 KiB / gzip 438.91 KiB；识别双Workflow、双Queue、D1与四个R2 binding，未部署。
  - `pnpm run typecheck`、`pnpm run lint`、`pnpm run verify:docs`与`git diff --check` → exit 0。
- 勾选：Phase 1 Runner heartbeat/final consistency项新增并勾选“真实外部证据验收契约”；真实GitHub Action连续heartbeat、signed final webhook与父项保持未勾。最新`heartbeat_at`、manifest自报、fake API、schema example、本地Runner、dry-run或默认exit 2不能替代真实外部事实。
- 决策沉淀：cadence必须由append-only receipt链证明，不能从单个最新时间推断；每条receipt的前后version/time和90秒lease都由控制面CAS产生。Runner result、D1 GitHub projection、signed webhook和live Actions API是四种不同authority，只有exact Plan/run/attempt/`updated_at`同时一致才可关门；API reconciliation存在也不能替代本验收要求的signed final webhook。
- 遗留：当前`git remote -v`为空、Wrangler D1 ID仍为占位值，没有试点repo/App、已部署控制面、有效Codex credential、manifest外Runner release review或signed final webhook事实。需用户提供受控前置后，按[`docs/RunnerHeartbeatE2E.md`](docs/RunnerHeartbeatE2E.md)经正常链路运行一份至少产生两条receipt的analysis Action并保存仓库外manifest；只有`DELIVERY_LOOP_RUNNER_HEARTBEAT_E2E=1 pnpm run e2e:runner-heartbeat` exit 0以及Action/webhook/release review链接人工入账后，才能勾真实子项与父DoD。

## Round 105 — 2026-07-27
- 目标：Phase 1 / 实测并记录试点GitHub组织的hosted runner最大时长、并发/计费策略、GitHub App权限和Actions事件语义，以及Cloudflare Paid Workflows的create/sendEvent/restart、在途代码升级、大小/保留/并发限制。本轮只闭环这些真实平台事实的只读组合验收契约；真实计费probe、账户/管理面review与父项保持未完成。
- 前置与权限：只读访问GitHub/Cloudflare官方公开文档与GitHub公开OpenAPI；本地使用delivery-loop、Watt固定commit`476e3cdd2490d725fde174e7c697ebf00899edc6`的既有复用结论、fake HTTPS、Node回归、文档检查和Wrangler dry-run。未访问或修改真实试点GitHub组织、Cloudflare账户、飞书/Meegle/tool-bridge、日志或业务数据库；未触发并发/六小时Action、create/sendEvent/restart、Worker部署或计费模型，未提交代码或使用真实Secret，按用户要求未更新llmdoc。
- Watt直接复用：`scripts/verify-platform-limits-evidence.ts`继续沿用Watt-derived显式opt-in、仓库外64 KiB manifest、固定0/1/2退出、安全固定错误和1 MiB有界HTTPS读取。GitHub App/`workflow_dispatch`/signed `workflow_run`不复制parser，直接复用`RunnerHeartbeatEvidence`全链；Cloudflare create/sendEvent/在途升级和restart分别直接复用`WorkflowHibernateEvidence`与`ControlledReplayEvidence`。Watt没有GitHub组织limits probe、enhanced billing聚合或Cloudflare官方限制解析，这些平台边界契约为delivery-loop新增，没有虚构复制来源。
- 动作：
  - 先写红灯：`test/platform-limits-evidence.test.ts`首次failed suite / 0 tests，缺`platform-limits-evidence` domain/verifier；随后新增strict `PlatformLimitsEvidenceManifestV1`、`verifyPlatformLimitsEvidence`、`pnpm run e2e:platform-limits`、schema example与[`docs/PlatformLimitsE2E.md`](docs/PlatformLimitsE2E.md)。中间定向测试4/5因token regex数字分隔符误入量词统一返回`configuration_invalid`，修正后全绿。
  - 官方authority固定GitHub `github/docs@071ed75ada2d9e80348639adfc7cca5b3902ed16` / blob `f492e2ebd2859b4f91546cb2f270c83c7cae669a`与Cloudflare `cloudflare-docs@862ae7b51ce028a30f1760e46e5d25ae76cc6832` / blob `926ed4527289522656999bbaa46efd8c4b98e247`。verifier实时读immutable Contents blob、重算digest并解析GitHub 6小时/35天/matrix 256/20-40-60-500/1000和Cloudflare Paid 10MB、CPU/result/event/state/sleep/steps/create/queued/retention/subrequest限制；同页表格50,000与后文10,000 active concurrency冲突必须同时存在并输出显式conflict。
  - live读取organization Actions permissions、default `GITHUB_TOKEN` policy、artifact/log retention和enhanced billing。按GitHub当前官方OpenAPI纠正最初错误假设：usage响应是逐日`date/quantity/amount/organizationName/repositoryName`，不是`timePeriod + gross/net quantity`；实现先核对org/month，再按date/SKU/unit/price聚合并丢弃repository明细，manifest只保留聚合digest、原Actions item count、unit/quantity/amount标量。
  - 新增两个只能手动触发的空权限probe workflow：并发probe不checkout、matrix job固定`sleep 300`，verifier分页收集最多10个run/2560 jobs，按`[started_at,completed_at)`跨run重算overlap并要求总job大于review limit且最大overlap相等；duration probe唯一job固定360分钟timeout与370分钟sleep，live failure必须在355～370分钟且时间精确匹配。verifier从不触发probe，避免隐式六小时与并发计费。
  - 主verifier重新运行三份既有子manifest，绑定同repository、同GitHub API/control-plane origin、Cloudflare account digest与安全evidence ID；Cloudflare Paid plan/billing/support调整仍保留管理面人工review，exit 0不让manifest URL自证。同步DOD、Proto、Architecture、Security、Reference和公共export，只勾“真实外部证据验收契约”。
  - 最终全量回归额外暴露既有workerd文件级并发污染：一次`execution-attempt-api`的20路相同head上报有10路409，下一次则是另一文件`github-review-feedback`少一条duplicate；两个失败文件单独运行均立即全绿，且失败对象随全量调度变化。workerd测试文件都对同一配置D1执行全表reset/seed，故把`vitest.workflow.config.ts`的文件worker收敛为1；文件内部20路并发不变，串行全量56 files / 301 tests稳定通过，避免用重复碰运气伪装回归绿色。
- 验证：
  - 红灯`pnpm exec vitest run test/platform-limits-evidence.test.ts` → failed suite / 0 tests（domain模块不存在）；实现与修正后exit 0，1 file / 5 tests。覆盖strict/example、固定docs/blob/content、policy/billing聚合、跨run并发、六小时时长、三子verifier复用、Cloudflare限制自报、超限/raw/token零传播和CLI opt-in。
  - `pnpm exec vitest run test/platform-limits-evidence.test.ts test/runner-heartbeat-evidence.test.ts test/workflow-hibernate-evidence.test.ts test/controlled-replay-evidence.test.ts` → exit 0，4 files / 22 tests；App/event、hibernate/redeploy与restart复用链无回归。
  - 官方公开事实读取 → exit 0：两个固定raw文档与Contents blob SHA匹配；GitHub公开OpenAPI确认`/organizations/{org}/settings/billing/usage`当前`billing-usage-report`逐日usage item结构，并据此完成上述聚合修正。未带试点credential、未读取真实组织账单。
  - `pnpm run e2e:platform-limits`（无opt-in）→ exit 2，固定`platform-limits-e2e: opt-in missing`；设置opt-in但缺配置 → exit 2，固定`required platform limits configuration is incomplete`；都在manifest/credential/network前结束。
  - 中间全量故障注入 → 两次`pnpm run verify`分别在无关workerd并发fixture出现1/301失败；对应`pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/execution-attempt-api.test.ts`（2/2）与`... test/workflow/github-review-feedback.test.ts`（5/5）均单独exit 0。设置workerd file `maxWorkers=1`后，`pnpm run test:workflow` → exit 0，56 files / 301 tests，内部20路竞争断言保留。
  - `pnpm run verify` → exit 0：typecheck、ESLint、Node 84 files / 312 tests、workerd 56 files / 301 tests、383个生产文件Secret scan和文档链接全绿。workerd仅输出既有预期Workflow terminate清理信息，无失败suite。
  - `CI=1 pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round105-20260727` → exit 0，bundle 2610.34 KiB / gzip 438.91 KiB；识别双Workflow、双Queue、D1与四个R2 binding，未部署。
  - `pnpm run typecheck`、`pnpm run lint`、`pnpm run verify:docs`与`git diff --check` → exit 0。
- 勾选：Phase 1平台边界项新增并勾选“真实外部证据验收契约”；真实GitHub组织并发/约六小时计费probe、App/事件、Cloudflare Paid create/sendEvent/redeploy/restart和父项保持未勾。官方静态表、fake API、schema example、本地绿色测试、未运行workflow、管理面URL自报、dry-run或默认exit 2不能替代真实外部事实。
- 决策沉淀：平台文档、账户effective policy、live probe和业务恢复演练是不同authority。GitHub Support可改变并发，静态plan表不能证明试点limit；Cloudflare官方同页自身存在50,000/10,000冲突，必须显式升级核对。平台limits verifier保持只读，预算消耗与mutation必须由owner另行批准；账单明细在内存聚合后丢弃repository信息，不进入manifest/日志。
- 遗留：当前`git remote -v`为空、Wrangler D1 ID仍为占位值，没有用户确认的试点organization/repo/App、已部署控制面、Cloudflare Paid account或有效用途隔离凭证。需owner先批准hosted runner分钟/金额和约六小时时间窗，再按[`docs/PlatformLimitsE2E.md`](docs/PlatformLimitsE2E.md)完成饱和并发与duration probe、组织policy/billing人工review及Cloudflare hibernate/redeploy/restart演练；只有`DELIVERY_LOOP_PLATFORM_LIMITS_E2E=1 pnpm run e2e:platform-limits` exit 0、Cloudflare并发冲突处置和全部安全链接/Reviewer入账后，才能勾真实子项与父DoD。

## Round 106 — 2026-07-27
- 目标：Phase 2 / 真实飞书应用challenge和一条真实事件验签通过，错误签名、过期timestamp、错误tenant被拒且无业务记录。本轮只闭环真实tenant的三方外部证据验收契约；未发布飞书应用、配置真实callback或发送任何真实/负向请求，父项保持未完成。
- 前置与权限：仅使用本地delivery-loop、Watt固定commit`476e3cdd2490d725fde174e7c697ebf00899edc6`、fake HTTPS、D1/workerd回归、飞书官方公开事件订阅/FAQ/日志检索文档、文档检查和Wrangler dry-run。未访问或修改真实飞书/Meegle/GitHub/Cloudflare/tool-bridge、日志或业务数据库，未部署、提交代码或使用真实Secret；按用户要求未更新llmdoc。
- Watt直接复用：生产入口继续直接复用Watt的`SHA-256(timestamp + nonce + encryptKey + exact body)`、constant-time compare、AES-256-CBC和challenge短路；`verify-feishu-webhook-evidence.ts`直接沿用Watt`scripts/e2e/lib.ts`的显式opt-in、仓库外64 KiB manifest、固定0/1/2退出和安全固定错误。Watt的匿名明文兼容、raw payload持久化与上游错误传播明确没有复制；Watt没有delivery-loop的metadata-only D1 receipt/ingress或三方live evidence，未虚构可复制业务模块。
- 动作：
  - 先写红灯：`test/feishu-webhook-evidence.test.ts`首次failed suite / 0 tests，缺`feishu-webhook-evidence` domain模块；随后新增strict `FeishuWebhookEvidenceManifestV1`、`FeishuWebhookObservabilityReportV1`、只读`verifyFeishuWebhookEvidence`、`pnpm run e2e:feishu-webhook`及两份schema example。
  - challenge按既有安全契约继续零D1写入。Worker仅对challenge、成功event、invalid signature、expired timestamp和wrong tenant输出allowlist结构化观测：case/outcome、request/response digest、status、start/end/latency及可用的event/type/delivery ID；统一Secret redaction/scanner后发出，不记录challenge、raw/encrypted/decrypted body、nonce、token、encrypt key或错误正文。外部report固定exact五条并以canonical digest绑定；challenge≤1秒、event/rejection≤3秒。
  - 新增operations-only `GET /v1/operations/feishu-webhook/evidence?tenantKey=<exact>&eventId=<exact>`与D1安全store。查询拒绝额外/重复参数，只投影唯一receipt/ingress白名单标量，以及delivery/nonce/ingress/Task/Run/outbox effect六类计数；不存在返回全零/null。成功event要求唯一delivery/ingress和至少一个nonce，三类负向要求所有业务计数为零。
  - 官方文档确认保存Request URL会发送`url_verification`，challenge须1秒内原样返回，普通事件须3秒内200否则重推，开发者后台日志检索以`SUCCESS`与retry count审计；未发现机器可读的历史事件投递日志OpenAPI。因此verifier不能伪造“飞书已接受”，manifest强制保留app-bound developer console URL/status/review时间，真实关门仍需人工核对。
  - verifier把飞书后台人工review、外部observability report和D1安全投影保持为三种authority；manifest中的report URL只有与独立环境变量exact相等才发送独立observability token，callback必须绑定控制面origin与固定path。响应1 MiB有界，错误不传播raw/credential，工具没有POST、飞书配置或D1写路径。
  - 新增[`docs/FeishuWebhookE2E.md`](docs/FeishuWebhookE2E.md)，同步DOD、Proto、Architecture、Security、Reference、公共export与Worker路由；只勾本项“真实外部证据验收契约”。
- 验证：
  - 红灯`pnpm exec vitest run test/feishu-webhook-evidence.test.ts` → exit 1，failed suite / 0 tests（domain模块不存在）；实现后最终exit 0，1 file / 5 tests。覆盖strict/example/report digest、三authority交叉、1秒/3秒、receipt drift、负向非零、URL/token绑定、raw/credential零传播和CLI opt-in。
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/feishu-webhook.test.ts` → exit 0，1 file / 5 tests；覆盖真实Worker crypto/challenge、成功metadata receipt、五类本地拒绝、nonce replay与operations鉴权/零写入安全投影。
  - `pnpm run e2e:feishu-webhook`（无opt-in）→ exit 2，固定`feishu-webhook-e2e: opt-in missing`；设置opt-in但缺配置 → exit 2，固定`required evidence configuration is incomplete`；两次均在manifest/credential/network前结束。
  - 首次`pnpm run verify`的Node 85 files / 317 tests全绿，workerd在既有`execution-attempt-api`20路同head用例出现9个409；该文件单独2/2立即全绿，随后完整workerd 56 files / 302 tests全绿。最终重新执行`pnpm run verify` → exit 0：typecheck、ESLint、Node 85 files / 317 tests、workerd 56 files / 302 tests、390个生产文件Secret scan和文档链接全绿；workerd仅有既有预期Workflow terminate清理输出。
  - `pnpm exec wrangler deploy --dry-run` → exit 0，bundle 2618.38 KiB / gzip 440.33 KiB；识别双Workflow、双Queue、D1与四个R2 binding，未部署。
  - `pnpm run typecheck`、`pnpm run lint`、`pnpm run verify:docs`、`pnpm run verify:secrets`与`git diff --check` → exit 0。
- 勾选：Phase 2第一项新增并勾选“真实外部证据验收契约”；真实飞书自建应用/加密订阅、公开callback、后台challenge/event `SUCCESS`、受控三类负向probe和父项保持未勾。fake API、schema example、本地密文/workerd、manifest自报、单一HTTP状态、dry-run或默认exit 2不能替代真实tenant事实。
- 决策沉淀：challenge本来就必须零D1写入，因此不能靠控制面数据库自证；Worker安全日志只能证明服务处理，不能证明飞书平台接受。真实关门必须同时具备飞书后台`SUCCESS`人工审计、独立外部HTTP观测和D1正向receipt/负向零写入，且三者用digest/ID/time exact绑定。invalid signature在验签前无法可信解密event ID，日志不伪造该字段；受控probe输入event ID只作为manifest索引，再由D1 exact零写入补强。
- 遗留：当前`git remote -v`为空、Wrangler D1 ID仍为占位值，没有已部署控制面、飞书测试应用owner确认、公开callback、外部observability report端点或用途隔离短期token。需用户提供受控测试应用与部署前置后，按[`docs/FeishuWebhookE2E.md`](docs/FeishuWebhookE2E.md)完成真实challenge/event和三类负向probe，保留飞书后台/observability/operations安全证据；只有`DELIVERY_LOOP_FEISHU_WEBHOOK_E2E=1 pnpm run e2e:feishu-webhook` exit 0及人工review入账后，才能勾真实子项与父DoD。

## Round 107 — 2026-07-27
- 目标：Phase 2 / 同一飞书event重放3次只入队一次；不同event指向同task revision仍只创建一个Run。本轮只闭环真实tenant、Cloudflare Queue与Workflow的外部证据验收契约；未重放真实event、运行真实normalizer、创建Workflow或部署，父项保持未完成。
- 前置与权限：仅使用本地delivery-loop、Watt固定commit`476e3cdd2490d725fde174e7c697ebf00899edc6`的既有源码审计结论、fake HTTPS、D1/workerd回归、已安装Cloudflare Workers类型和Wrangler dry-run。未访问或修改真实飞书/Meegle/GitHub/Cloudflare/tool-bridge、日志或业务数据库，未发送webhook、调用真实Queue/Workflow API、部署、提交代码或使用真实Secret；按用户要求未更新llmdoc。
- Watt直接复用：生产入口继续复用Round 72从Watt EventStore迁入的“dedupe identity命中后不再Queue send”断言结构、Queue sender注入，以及Watt-derived migration/R2/稳定identity模式；`verify-feishu-ingress-evidence.ts`直接沿用Watt`scripts/e2e/lib.ts`的显式opt-in、仓库外64 KiB manifest、固定0/1/2退出、有界HTTPS和安全固定错误。Watt没有Cloudflare Queue message identity/attempt ledger、Task revision/Run/workflow-create双层幂等或三方live evidence，对应业务实现为delivery-loop新增，没有虚构Watt来源。
- 动作：
  - 先写红灯：`pnpm exec vitest run test/feishu-ingress-evidence.test.ts`首次exit 1，failed suite / 0 tests，缺`feishu-ingress-evidence` domain；恢复本轮时schema已落盘，测试继续因缺`feishu-ingress-evidence-verifier`而exit 1。随后完成strict `FeishuIngressEvidenceManifestV1`/observability report、live verifier、CLI和两份canonical digest示例。
  - 识别到既有`feishu_ingress_outbox.queue_observed_at`只能证明“至少观察过一次”，不能证明Cloudflare logical message identity或delivery attempt。migration 0057新增immutable `feishu_ingress_queue_observations`：只保存固定Queue名、message ID canonical digest、attempt、message/observed time；原始ID/body无列，`(queue,digest,attempt)`唯一且UPDATE trigger拒绝改写。
  - consumer直接使用Cloudflare `Message.id/timestamp/attempts`，observation INSERT、queued状态更新和postcheck位于同一D1 batch；状态更新还要求同outbox的exact observation已经存在。相同message/attempt重放幂等，attempt 2追加第二行但仍只有一个message identity；D1异常retry，非法消息ack，Queue原始ID经测试证明零持久化。
  - 新增operations-only `GET /v1/operations/feishu-ingress/evidence?tenantKey=<exact>&eventId=<exact>`。安全投影包含delivery、按时间排序的transport receipt digest、ingress relay/settlement、Queue digest/attempt/time、Task source tuple/revision/digest、Run/workflow instance和唯一workflow-create outbox；拒绝额外/重复query，不返回nonce、Queue原始ID/body、Task正文、R2 ref、lease、token或SQL行。
  - verifier要求外部observability exact四条成功HTTP记录：同event三条、peer event一条且request digest各异；再读取两个operations投影，要求各一delivery/ingress/logical Queue identity，两event同Task/Run/revision/digest和同一settled workflow-create outbox；最后以Cloudflare Workflows read API核对live `run_id` instance的status/version/start。Queue/Workflow dashboard URL只作人工review索引，不能自证平台事实。
  - 中间静态检查先因tuple索引可能undefined而exit 2，收窄后通过；Node实现后第一次5/5失败暴露schema example/CLI缺失及token regex错误地把数字分隔符写入正则量词，修正为`{1,2000}`后只剩Cloudflare合法`errored`状态被过早归类response-invalid，调整为先解析再报instance mismatch后5/5全绿。没有把中间失败隐藏为成功。
  - 新增[`docs/FeishuIngressE2E.md`](docs/FeishuIngressE2E.md)，同步DOD、Proto、Architecture、Security、Reference、公共export和Worker route；只勾“真实外部证据验收契约”。
- 验证：
  - 最终`pnpm exec vitest run test/feishu-ingress-evidence.test.ts` → exit 0，1 file / 5 tests；覆盖strict/example/report digest、四HTTP/双Queue/单Task-Run-live Workflow交叉、transport/Queue/revision/workflow drift、URL/account/token绑定、有界错误/raw credential零传播和CLI opt-in。
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/feishu-ingress-idempotency.test.ts test/workflow/meegle-work-item-ingress.test.ts test/workflow/feishu-webhook.test.ts test/workflow/feishu-card-action.test.ts` → exit 0，4 files / 21 tests；覆盖三receipt、一Queue send、同attempt重放、attempt 2 append、两个event同revision唯一Task/Run/outbox、operations投影及既有webhook/Meegle/card无回归。
  - `pnpm run e2e:feishu-ingress`（无opt-in）→ exit 2，固定`feishu-ingress-e2e: opt-in missing`；设置opt-in但缺配置 → exit 2，固定`required Feishu ingress configuration is incomplete`；两次都在manifest/credential/network前结束。
  - `pnpm run verify` → exit 0：typecheck、ESLint、Node 86 files / 322 tests、workerd 56 files / 302 tests、398个生产文件Secret scan和文档链接全绿；workerd仅输出既有预期Workflow terminate清理信息。
  - `CI=1 WRANGLER_SEND_METRICS=false pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round107-20260727` → exit 0，bundle 2630.39 KiB / gzip 441.76 KiB；识别双Workflow、双Queue、D1与四R2 binding，未部署。
  - `pnpm run typecheck`、`pnpm run lint`、`pnpm run verify:docs`与`git diff --check` → exit 0。
- 勾选：Phase 2 ingress幂等项新增并勾选“真实外部证据验收契约”；真实飞书event重投、实际normalizer、Cloudflare Queue/Workflow live fact、dashboard人工review和父项保持未勾。本地fake Queue、直接调用normalized sink、schema example、manifest自报、dry-run或默认exit 2不能替代真实tenant事实。
- 决策沉淀：event业务去重、Queue logical message identity、Queue at-least-once attempt、Task source revision和Workflow instance是五层不同identity。`queue_observed_at`单值不能证明Queue delivery历史，故用append-only digest ledger；但该ledger仍只能证明consumer看到的平台metadata，必须与外部HTTP、operations lineage、live Workflow及Queue dashboard人工review组合。verifier完全只读，不提供重放、部署或平台mutation入口。
- 遗留：当前`git remote -v`为空、Wrangler D1 ID仍为占位值，没有已部署控制面、飞书测试应用/Meegle normalizer、外部observability、Cloudflare真实Queue/Workflow或用途隔离read token。需owner批准受控重投窗口后，按[`docs/FeishuIngressE2E.md`](docs/FeishuIngressE2E.md)让飞书真实重试同event三次，再产生不同event但相同source revision并经实际normalizer处理；只有`DELIVERY_LOOP_FEISHU_INGRESS_E2E=1 pnpm run e2e:feishu-ingress` exit 0和飞书/Queue/Workflow人工review入账后，才能勾真实子项与父DoD。

## Round 108 — 2026-07-27
- 目标：Phase 2 / Meegle工作项title、description、acceptance、owner、目标repo和revision映射为TaskEnvelope，缺失时triaging。本轮只闭环真实测试tenant的外部证据验收契约；未读取真实Meegle工作项、触发事件/normalizer或创建Task/Run，父项保持未完成。
- 前置与权限：使用本地delivery-loop、已安装Meegle CLI只读版本信息、Meegle skill/官方CLI公开源码、Watt固定commit`476e3cdd2490d725fde174e7c697ebf00899edc6`既有复用结论、fake command runner/HTTPS、Node/workerd/D1/R2、文档检查和Wrangler dry-run。未访问或修改真实Meegle/飞书/GitHub/Cloudflare/tool-bridge、日志或业务数据库，未调用真实tenant API、部署、提交代码或使用Secret；按用户要求未更新llmdoc。
- 三方authority审计：本机`meegle`为1.0.16。npm metadata的`gitHead=73f1be359ad2e298e5a1817c13e1f1d82fcdf7d3`首次在公开repo checkout失败（对象不存在），随后按官方`v1.0.16` tag成功固定commit`674042f0f58b62962103aff91598c9bc85ccb138`。源码确认`--envelope={data,meta,error}`、token/page-number自动分页最多200页，以及`auto_paginated/pages_merged/total_items/truncated/stopped_reason`；故verifier拒绝truncated、stopped和剩余cursor，不能用半页数据冒充完整事实。
- Watt直接复用：Watt没有Meegle/Meego mapper、field/role metadata、全量分页、repository allowlist或snapshot→Task/Run lineage，直接复制业务代码为零；继续最大化复用此前迁入的content-addressed immutable R2、stable identity、D1 conditional write，以及Watt`scripts/e2e/lib.ts`的显式opt-in、仓库外64KiB manifest、固定0/1/2退出、有界读取和安全固定错误纪律，没有虚构Watt来源。
- 动作：
  - 先写红灯：新增`test/meegle-work-item-evidence.test.ts`后，`pnpm exec vitest run test/meegle-work-item-evidence.test.ts`首次failed suite / 0 tests，缺`src/domain/meegle-work-item-evidence.ts`。
  - migration 0058新增immutable metadata-only `meegle_mapping_lineage`，每个ingress绑定event/source/revision、exact/mapping snapshot digest、profile version/digest及三个受控field/role key、R2 ref、分页布尔/count和`mapped|triaging`结果。mapped行必须绑定Task/Run且gap为空；triaging行必须绑定candidate且Task/Run为空；UPDATE trigger拒绝改写。
  - 完整snapshot继续先复用`FeishuNormalizedTaskStore`。Task/Run已成功但mapping lineage写入前中断时，同一ingress重试复用existing Task/Run并补lineage；测试通过删除lineage模拟该窗口，未创建补偿Run。triaging candidate、既有triage lineage和统一mapping lineage在同一D1 batch写入，20路既有幂等不变。
  - 新增operations-only `GET /v1/operations/meegle/evidence?tenantKey=<exact>&eventId=<exact>`。Worker在服务端从隐藏R2 ref有界读取snapshot，重新解析strict schema、重算exact digest，并核对R2 custom metadata、event/source/revision、分页与field/role/owner count；响应只返回验证布尔、digest、受控key/count、repo分类、固定gap和Task/Run/workflow-create标量，不返回正文、field value、principal、cursor、R2 ref或raw API。
  - 新增strict `MeegleWorkItemEvidenceManifestV1`与`pnpm run e2e:meegle-work-item`。verifier固定CLI 1.0.16与官方tag commit，CLI profile及tenant/project/type由环境独立配置并与manifest exact绑定；先用`meta-fields/meta-roles`核对两个field key/type和一个role key，再用argv数组、`shell:false`、`fields=["_all"] + page_size=200 + --auto-paginate + --envelope`读取五个真实工作项。一个完整case交叉到唯一Task/Run；缺字段、owner多值、repo越allowlist和原始分页未完成四case固定gap且Task/Run/workflow effect全零。
  - 分页未完成case显式分离两个时间点：D1/R2原始normalizer snapshot必须是`fieldsComplete=false + hasNextPageToken=true`，而验收时live CLI重新读取当前工作项仍必须完整；故不能故意返回truncated/stopped来伪造negative gap。新增[`docs/MeegleWorkItemE2E.md`](docs/MeegleWorkItemE2E.md)，同步DOD、Proto、Architecture、Security、Reference、公共export、Worker route和schema example，只勾“真实外部证据验收契约”。
- 验证：
  - 红灯命令见上；实现后`pnpm exec vitest run test/meegle-work-item-evidence.test.ts test/meegle-work-item-mapper.test.ts` → exit 0，2 files / 9 tests。覆盖strict五case/schema example、固定CLI argv/version/metadata、分页拒绝、D1/R2 lineage、mapped Task/Run、四类triage零effect、authority绑定、有界错误/raw零传播和CLI opt-in。
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/meegle-work-item-ingress.test.ts test/workflow/feishu-ingress-idempotency.test.ts` → exit 0，2 files / 7 tests。覆盖migration 0058、mapped/triage入账、Task后中断补lineage、operations R2回读、正文/principal/ref零返回和既有ingress幂等无回归。
  - `pnpm run e2e:meegle-work-item`（无opt-in）→ exit 2，固定`meegle-work-item-e2e: opt-in missing`；设置opt-in但缺配置 → exit 2，固定`required evidence configuration is incomplete`；两次都在manifest/Meegle/API前结束。
  - `pnpm run verify` → exit 0：typecheck、ESLint、Node 87 files / 327 tests、workerd 56 files / 302 tests、405个生产文件Secret scan和文档链接全绿。workerd仅输出既有预期Workflow terminate清理信息，无失败suite。
  - `CI=1 WRANGLER_SEND_METRICS=false pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round108-final-20260727` → exit 0，bundle 2642.45 KiB / gzip 443.76 KiB；识别双Workflow、双Queue、D1与四个R2 binding，未部署。
  - `pnpm run typecheck`、`pnpm run lint`、定向`pnpm run verify:docs`与`git diff --check` → exit 0。
- 勾选：Phase 2 Meegle映射项新增并勾选“真实外部证据验收契约”；真实test tenant的metadata、5个工作项、实际事件/normalizer、CLI exit 0和父项保持未勾。schema example、fake runner、本地snapshot、workerd、manifest自报、对象存在、dry-run或默认exit 2不能替代真实外部事实。
- 决策沉淀：live Meegle API、D1 mapping lineage和私有R2 exact snapshot是三种不同authority。CLI证明当前tenant metadata/work-item，D1证明event到candidate或Task/Run，R2回读证明normalizer实际使用的snapshot；任何单一来源都不能关门。mapped lineage必须可在Task事务后补写，否则一次Worker中断会留下无法从Meegle追溯的Task/Run。
- 遗留：当前`git remote -v`为空、Wrangler D1 ID仍为占位值，没有已部署控制面、测试Meegle project/type/profile、5个受控工作项、实际normalizer或用途隔离operations token。需owner提供测试tenant和只读CLI profile后，按[`docs/MeegleWorkItemE2E.md`](docs/MeegleWorkItemE2E.md)触发真实事件并完成metadata/五case/R2-D1交叉；只有`DELIVERY_LOOP_MEEGLE_WORK_ITEM_E2E=1 pnpm run e2e:meegle-work-item` exit 0与项目权限人工review入账后，才能勾真实子项和父DoD。

## Round 109 — 2026-07-27
- 目标：Phase 2 / 卡片展示Run/Task/Plan/DoD/repo/goal/Action/PR/blocker/approved effects，大日志只有安全摘要/受控链接。本轮只闭环真实飞书tenant的外部证据验收契约；未发送/更新真实卡片、未等待真实approval过期、未调用飞书写API或部署，父项保持未完成。
- 前置与权限：仅使用本地delivery-loop、Watt固定commit`476e3cdd2490d725fde174e7c697ebf00899edc6`已迁入源码、fake HTTPS、D1/workerd、文档检查和Wrangler dry-run。未访问或修改真实飞书/Meegle/GitHub/Cloudflare/tool-bridge、日志或业务数据库，未使用真实Secret、提交代码或更新llmdoc。
- Watt直接复用：生产继续复用Round 58/74从Watt迁入的interactive `wide_screen_mode`/`lark_md` renderer、isolate token cache、stable create UUID、同message create/PATCH/delivery ledger与10秒飞书请求边界；新CLI直接沿用Watt`scripts/e2e/lib.ts`的显式opt-in、仓库外64 KiB manifest、固定0/1/2退出和安全固定错误。Watt没有Run/Plan/DoD安全snapshot、approval expiry source watermark、D1 presentation lineage或三方live evidence，这些为delivery-loop新增，没有虚构Watt业务复用。
- 动作：
  - 先写红灯：新增`test/feishu-card-presentation-evidence.test.ts`后，`pnpm exec vitest run test/feishu-card-presentation-evidence.test.ts`首次exit 1，failed suite / 0 tests，缺`src/domain/feishu-card-presentation-evidence.ts`。
  - migration 0059新增immutable metadata-only `feishu_delivery_card_presentation_lineages`，每张新v2 presentation绑定prior presentation、`initial|source_change|approval_expiry|manual_refresh`、prior/current source watermark、trigger/next refresh和projected time。只有到期时前后watermark一致才可标记`approval_expiry`；同batch插入后还必须postcheck exact lineage，避免`OR IGNORE`隐藏无效行。
  - 新增operations-only `GET /v1/operations/feishu-card-presentation/evidence?runId=<exact>`，不扩展已有strict `/feishu-card` response。Worker最多读100张，strict-rehydrate stored v2、核对presentation/card/run与reference-only outbox、重算rendered digest；只返回安全snapshot、delivery上lineage，剥离actions/application nonce、raw presentation/card JSON、正文、raw log、artifact/R2 ref、DB行上upstream response。
  - 新增strict `FeishuCardPresentationEvidenceManifestV1`与`pnpm run e2e:feishu-card-presentation`。verifier绑定首次v2 created、同message的expiry前/后updated、直接prior lineage与无业务watermark变化；到期前snapshot必须有Plan/DoD/Action/PR/blocker/唯一effect、Markdown probe、固定隐藏checkpoint和大日志受控链接，到期后只移除effect。最后有界读live Message GET，重算digest、精确比较14个非动作段落，并在JSON parse前以仓库外synthetic credential-pattern canary扫描控制面和飞书完整响应。
  - 新增[`docs/FeishuCardPresentationE2E.md`](docs/FeishuCardPresentationE2E.md)和schema example，同步DOD、Proto、Architecture、Security、Reference、公共export、Worker route与package script；只勾本项“真实外部证据验收契约”。
- 验证：
  - 红灯命令见上；实现后`pnpm exec vitest run test/feishu-card-presentation-evidence.test.ts` → exit 0，1 file / 5 tests。覆盖strict lifecycle/review/schema example、create/PATCH/expiry watermark/live card交叉、消息重建/业务写入拒绝、段落篡改、控制面与飞书canary零泄漏、raw/credential零传播和CLI opt-in。
  - `pnpm exec vitest run test/feishu-card-presentation-evidence.test.ts test/feishu-delivery-card.test.ts test/failure-blocker-card-evidence.test.ts test/feishu-retry-evidence.test.ts` → exit 0，4 files / 24 tests；`pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/feishu-delivery-card.test.ts test/workflow/feishu-card-action.test.ts` → exit 0，2 files / 16 tests。Worker穿透额外证明expiry lineage、同message create/PATCH、operations鉴权/strict query、nonce/raw/R2/canary零返回和lineage UPDATE拒绝。
  - `pnpm run e2e:feishu-card-presentation`（无opt-in）→ exit 2，固定`feishu-card-presentation-e2e: opt-in missing`；设置opt-in但缺配置 → exit 2，固定`required evidence configuration is incomplete`；两次都在manifest/credential/network前结束。
  - `pnpm run verify` → exit 0：typecheck、ESLint、Node 88 files / 332 tests、workerd 56 files / 302 tests、411个生产文件Secret scan和文档链接全绿。workerd仅输出既有预期Workflow terminate清理信息，无失败suite。
  - `CI=1 WRANGLER_SEND_METRICS=false pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round109-final2-20260727` → exit 0，bundle 2653.16 KiB / gzip 445.38 KiB；识别双Workflow、双Queue、D1与四个R2 binding，未部署。
  - `pnpm run typecheck`、`pnpm run lint`、`pnpm run verify:docs`、`pnpm run verify:secrets`与`git diff --check` → exit 0。
- 勾选：Phase 2卡片展示项新增并勾选“真实外部证据验收契约”；真实bot create/PATCH、approval自然过期、live Message GET exit 0、scope/群membership/截图人工review和父DoD保持未勾。fake HTTPS、workerd、schema example、manifest自报、dry-run或默认exit 2不能替代真实tenant。
- 决策沉淀：D1 presentation可证明投影内容，delivery ledger可证明控制面执行了create/PATCH，live Message GET可证明飞书当前消息，但任一单一事实都不能证明完整历史。approval过期若没有immutable prior/current source watermark，无法区分“定时刷新”与“恰好有其他写入”；因此单独新增lineage，而不用manifest或最新`refresh_after`自证。
- 遗留：当前`git remote -v`为空、Wrangler D1 ID仍为占位值，没有已部署控制面、飞书测试应用/群/bot owner授权、专用operations/read token、受控Run、短期approval、synthetic canary或大日志来源。需owner提供真实测试tenant与受控时窗后，按[`docs/FeishuCardPresentationE2E.md`](docs/FeishuCardPresentationE2E.md)完成create→PATCH→expiry、Message GET和人工scope/membership/截图review；只有`DELIVERY_LOOP_FEISHU_CARD_PRESENTATION_E2E=1 pnpm run e2e:feishu-card-presentation` exit 0且人工authority入账后，才能勾真实子项和父DoD。

## Round 110 — 2026-07-27
- 目标：Phase 2 / `approve/reject/cancel/retry/replay/add-context`服务端按open_id、tenant、Task/Plan/base/effect鉴权，伪造payload、重复nonce和旧revision拒绝。本轮只闭环真实飞书tenant的外部证据验收契约；未发送/点击真实卡片、修改真实身份映射、读取真实tenant、部署或执行业务effect，父项保持未完成。
- 前置与权限：仅使用本地delivery-loop、Watt固定commit`476e3cdd2490d725fde174e7c697ebf00899edc6`既有迁入源码、fake HTTPS、Node/workerd/D1/R2、文档检查和Wrangler dry-run。未访问或修改真实飞书/Meegle/GitHub/Cloudflare/tool-bridge、日志或业务数据库，未使用真实Secret、提交代码或更新llmdoc。
- Watt直接复用：生产callback继续直接复用Round 75从Watt迁入的`card.action.trigger` trusted-field extraction和`button.value={id,signal}`编码；新CLI直接沿用Watt`scripts/e2e/lib.ts`的显式opt-in、仓库外64 KiB manifest、固定0/1/2退出和安全固定错误纪律。Watt没有Task/Run/Plan/base/effect fencing、application nonce、D1 action/result lineage、server-derived retry/replay target或18-case真实证据，对应verifier/operations业务断言为delivery-loop新增，没有虚构Watt来源。
- 动作：
  - 先写红灯：新增`test/feishu-card-action-evidence.test.ts`后，`pnpm exec vitest run test/feishu-card-action-evidence.test.ts`首次exit 1，failed suite / 0 tests，缺`src/domain/feishu-card-action-evidence.ts`。
  - verified app/tenant card action现在先调用metadata-only`acceptAction`再做decode/chat/latest snapshot/identity/nonce/effect鉴权。malformed/转发/旧卡/错误群/撤权event因此有exact delivery但仍零Task ingress；所有成功/失败callback写安全structured observation，成功HTTP response去掉principal，日志/响应不含open_id、nonce、raw callback/form或上游正文。
  - 新增operations-only `GET /v1/operations/feishu-card-action/evidence?tenantKey=<exact>&eventId=<exact>`。投影返回verified delivery、零/一action receipt/outcome、operator/principal/chat canonical digest、exact card/presentation/Task/Run/Plan/base binding及event-bound approval/cancel outbox/recovery Attempt+checkpoint/workflow replay/context revision；不返回open_id/principal/roles正文/nonce/raw/form/R2 ref。rejected event必须`businessEffects=0`且`ingressOutboxes=0`。
  - 新增strict `FeishuCardActionEvidenceManifestV1`、独立`FeishuCardActionObservabilityReportV1`与`pnpm run e2e:feishu-card-action`。固定六类成功和十二类拒绝，要求两个distinct mapped human、一个revoked和一个unmapped账号；verifier重算report digest、逐event核对D1、验证retry lost Attempt/checkpoint/Item与固定replay step，并在JSON parse前以仓库外synthetic credential-pattern canary扫描完整有界响应。
  - 新增[`docs/FeishuCardActionE2E.md`](docs/FeishuCardActionE2E.md)和schema example，同步DOD、Proto、Architecture、Security、Reference、公共export、Worker route与package script；只勾“真实外部证据验收契约”。
- 验证：
  - 红灯命令见上；实现后`pnpm exec vitest run test/feishu-card-action-evidence.test.ts` → exit 0，1 file / 5 tests。覆盖strict 6+12 inventory/schema example、observer/D1交叉、拒绝零effect、server-derived retry/replay、actor authority、canary/raw/credential零传播和CLI opt-in。
  - `pnpm exec vitest run test/feishu-card-action-evidence.test.ts test/feishu-card-presentation-evidence.test.ts test/feishu-webhook-evidence.test.ts test/feishu-delivery-card.test.ts` → exit 0，4 files / 23 tests；`pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/feishu-card-action.test.ts test/workflow/feishu-webhook.test.ts test/workflow/feishu-delivery-card.test.ts` → exit 0，3 files / 21 tests。Worker穿透额外证明operations鉴权/strict query、成功approval lineage、pre-claim拒绝delivery、零ingress/effect及HTTP/operations零open_id/principal/nonce。
  - `pnpm run e2e:feishu-card-action`（无opt-in）→ exit 2，固定`feishu-card-action-e2e: opt-in missing`；设置opt-in但缺配置 → exit 2，固定`required evidence configuration is incomplete`；两次都在manifest/credential/network前结束。
  - `pnpm run verify` → exit 0：typecheck、ESLint、Node 89 files / 337 tests、workerd 56 files / 302 tests、417个生产文件Secret scan和文档链接全绿；workerd仅输出既有预期Workflow terminate清理信息。
  - `CI=1 WRANGLER_SEND_METRICS=false pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round110-final-20260727` → exit 0，bundle 2671.17 KiB / gzip 448.38 KiB；识别双Workflow、双Queue、D1与四个R2 binding，未部署。
  - `pnpm run typecheck`、`pnpm run lint`、`pnpm run verify:docs`与`git diff --check` → exit 0。
- 勾选：Phase 2卡片动作项新增并勾选“真实外部证据验收契约”；真实两个human/未授权账号点击、18个callback、app scope/群membership/open_id mapping/screenshot、observer report和CLI exit 0均保持未勾，父DoD保持未勾。fake callback、workerd、schema example、manifest自报、dry-run或默认exit 2不能替代真实tenant。
- 决策沉淀：飞书无历史callback只读API，因此HTTP observer、D1 event/action/effect lineage和人工scope/membership/identity mapping是三种不同authority。pre-claim拒绝若不先存verified delivery，就无法在不保存raw callback的前提下证明真实event确已到达；先存delivery仍不授权，也不进入Task normalizer。retry/replay target只从event-bound D1 result反查，manifest不能提供或覆盖target。
- 遗留：当前`git remote -v`为空、Wrangler D1 ID仍为占位值，没有已部署控制面、测试应用/目标群/错误群、两个mapped human、未授权/撤权账号、独立observer、用途隔离read token、18个受控callback或人工证据。需owner批准测试写入/点击窗口后按[`docs/FeishuCardActionE2E.md`](docs/FeishuCardActionE2E.md)执行；只有`DELIVERY_LOOP_FEISHU_CARD_ACTION_E2E=1 pnpm run e2e:feishu-card-action` exit 0且人工authority入账后，才能勾真实子项与父DoD。

## Round 111 — 2026-07-27
- 目标：Phase 2 / 补充上下文默认创建新revision且不静默改变running Attempt，只有用户明确选择“应用到当前Run”才取消/重建Attempt。本轮只闭环真实飞书/Meegle外部证据验收契约；未点击真实卡片、触发真实Meegle事件、读取真实tenant、部署或修改外部状态，父项与真实外部事实子项保持未完成。
- 前置与权限：仅使用本地delivery-loop、Watt固定commit`476e3cdd2490d725fde174e7c697ebf00899edc6`既有复用结论、fake HTTPS、Node/workerd/D1/R2、文档检查与Wrangler dry-run。未访问或修改真实飞书/Meegle/GitHub/Cloudflare/tool-bridge、日志或业务数据库，未使用真实Secret、提交代码或更新llmdoc。
- Watt直接复用：新CLI直接沿用Watt`scripts/e2e/lib.ts`的显式opt-in、仓库外64 KiB manifest、固定0/1/2退出和安全固定错误纪律；operations R2回读继续复用此前从Watt迁入的content-addressed immutable object、stable identity与conditional D1 write。Watt没有supplemental Task/Run/PlanRevision、Meegle mapping lineage、当前Attempt fencing或live card/observer/D1/R2四方证据，新增业务代码直接复制量为零，没有虚构Watt来源。
- 动作：
  - 先写红灯：`pnpm exec vitest run test/supplemental-context-evidence.test.ts`首次exit 1、failed suite / 0 tests，缺`src/domain/supplemental-context-evidence.ts`；实现后形成5/5稳定回归。
  - 审计后未新增migration：飞书每个exact event已有immutable delivery/action receipt/outcome，Meegle每个exact event已有immutable `meegle_mapping_lineage`，`supplemental_context_revisions`负责唯一业务effect。新增统一事件表会重复authority；operations按context反查现有两类external lineage，并以实际双event联表测试证明足够，未用manifest自报补洞。
  - 新增operations-only `GET /v1/operations/supplemental-context/evidence?contextId=<exact>`。服务端按隐藏D1 ref有界读取private R2 context/new Task，strict解析并重算canonical digest、custom metadata、source/actor/target binding；响应只返回revision digest、验证布尔、Run/workflow-create、Feishu action或Meegle mapping及apply-current的PlanRevision/Attempt/token/approval安全计数，不返回正文、actor/open_id/principal、Meegle field/owner、R2 ref、token/nonce、raw event、outbox payload或数据库行。源行超过20不会静默截断，actual count与有界结果不一致时fail-closed。
  - 新增strict `SupplementalContextEvidenceManifestV1`、`SupplementalContextObservabilityReportV1`与`pnpm run e2e:supplemental-context`。固定三case：Feishu `new_run`要求source Run version与running Attempt version/lease/token不变；`apply_current`要求派生Run cancelled/absorbed、source Run只前进一个version、旧Attempt cancelled/token全撤销/approval全失效且唯一analysis revision/outbox；Meegle同event重投与第二event同revision要求四个distinct event/五次HTTP观测、两条mapping lineage、单一Task/Run/context/workflow effect。
  - verifier最后以用途隔离Feishu read token执行live Message GET，核对app/tenant/chat/message/timestamps与canonical card digest，并同时查找“补充上下文·新 Run”和“补充上下文·当前 Run”；在JSON parse前以仓库外synthetic canary和三个短期token扫描全部1 MiB有界响应。
  - workerd穿透新增三层事实：既有default/apply-current真实D1/R2状态可由operations安全回读；生产Feishu add-context receipt/outcome可反查同一context；两个真实D1 Meegle event lineage可绑定同一supplemental revision且仍只有一个workflow-create。新增[`docs/SupplementalContextE2E.md`](docs/SupplementalContextE2E.md)与两份schema example，同步DOD、Proto、Architecture、Security、Reference、公共export、Worker route和package script；只勾“真实外部证据验收契约”。
- 验证：
  - 红灯命令见上；实现后`pnpm exec vitest run test/supplemental-context-evidence.test.ts` → exit 0，1 file / 5 tests。覆盖strict inventory/schema example、observability digest、两种Feishu模式、同event重投/双event Meegle收敛、R2验证、Attempt/token/approval fencing、live card两按钮、canary与用途隔离token零传播、CLI opt-in。
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/supplemental-context-revision.test.ts test/workflow/feishu-card-action.test.ts test/workflow/meegle-work-item-ingress.test.ts` → exit 0，3 files / 17 tests；覆盖operations auth/strict query、R2验证、Feishu action→context联表、default零source mutation、apply-current fencing和两个Meegle event→单effect。
  - `pnpm run e2e:supplemental-context`（无opt-in）→ exit 2，固定`supplemental-context-e2e: opt-in missing`；设置opt-in但缺配置 → exit 2，固定`required evidence configuration is incomplete`；两次均在manifest/credential/network前结束。
  - `pnpm run verify` → exit 0：typecheck、ESLint、Node 90 files / 342 tests、workerd 56 files / 303 tests、424个生产文件Secret scan和文档链接全绿；workerd仅输出既有预期Workflow terminate清理信息。
  - `CI=1 WRANGLER_SEND_METRICS=false pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round111-final-20260727` → exit 0，bundle 2690.77 KiB / gzip 451.70 KiB；识别双Workflow、双Queue、D1与四个R2 binding，未部署。
  - `pnpm run typecheck`、`pnpm run lint`、`pnpm run verify:docs`、`pnpm run verify:secrets`与`git diff --check` → exit 0。
- 勾选：Phase 2补充上下文项新增并勾选“真实外部证据验收契约”；真实签名Feishu `new_run/apply_current`、Meegle同event重投/双event、live Message GET、scope/群membership/open_id映射/Meegle project权限人工review、CLI exit 0和父项保持未勾。fake HTTPS、workerd、schema example、manifest自报、direct D1 insert、dry-run或默认exit 2不能替代真实tenant。
- 决策沉淀：默认新Run与apply-current不是一个布尔字段的展示差异，而是两条不同状态机边界。证明默认路径“没有修改旧Attempt”必须同时冻结card action的source Run version、检查旧Attempt version/lease/token与零invalidation/revision；证明apply-current则必须看到新Run absorbed、旧Attempt/token/approval全部fence及唯一analysis replacement。Meegle同event重投和不同event同revision分别由HTTP observer与D1 mapping lineage证明，不能合并成一个manifest count。
- 遗留：当前`git remote -v`为空、Wrangler D1 ID仍为占位值，没有已部署控制面、测试飞书应用/群/bot、两个受控source Run、Meegle project/type/revision、独立observer、用途隔离read token或人工证据。需owner批准测试写入/点击/event窗口后按[`docs/SupplementalContextE2E.md`](docs/SupplementalContextE2E.md)执行；只有`DELIVERY_LOOP_SUPPLEMENTAL_CONTEXT_E2E=1 pnpm run e2e:supplemental-context` exit 0且人工authority入账后，才能勾真实外部事实与父DoD。

## Round 112 — 2026-07-27
- 目标：Phase 2 / 飞书审批事件、GitHub审批与控制面approval形成唯一关联。本轮只闭环真实飞书/GitHub外部证据验收契约；未点击真实卡片、创建/重投真实review、访问真实tenant/repo、部署或触发merge，父项与真实外部事实子项保持未完成。
- 前置与权限：仅使用本地delivery-loop、Watt固定commit`476e3cdd2490d725fde174e7c697ebf00899edc6`既有复用结论、fake HTTPS、Node/workerd/D1、文档检查与Wrangler dry-run。未访问或修改真实飞书/Meegle/GitHub/Cloudflare/tool-bridge、日志或业务数据库，未使用真实Secret、提交代码或更新llmdoc。`git remote -v`为空，Wrangler D1 ID仍为占位值。
- authority审计：migration 0049及现有producer已经把每个external decision在同一D1 batch绑定到唯一immutable `approval_lineages`；Case 8可同时回答source/approval/lineage、who、两个时间与Task/Run/Plan/base/effect，Feishu card-action operations可反查delivery/receipt/outcome，生产`GitHubMergeGateApiClient.observeApprovalIdentity()`可读取exact PR author/head/review ID/login/submitted time。因此本轮未新增migration或第二张approval真源表；证据契约只读组合现有authority。
- Watt直接复用：新CLI直接沿用Watt`scripts/e2e/lib.ts`的显式opt-in、仓库外64 KiB manifest、固定安全错误与0/1/2退出纪律，有界HTTPS/canary扫描继续复用本项目既有Watt-derived E2E骨架。Watt没有同一human的Feishu/GitHub approval pair、Task/Run/Plan/base/effect lineage、Case 8/receipt/live review四方核对或event/snapshot隔离，等价业务代码直接复制量为零，没有虚构Watt业务来源。
- 动作：
  - 先写红灯：新增`test/approval-lineage-evidence.test.ts`后，`pnpm exec vitest run test/approval-lineage-evidence.test.ts`首次exit 1、failed suite / 0 tests，缺`src/domain/approval-lineage-evidence.ts`。
  - 新增strict `ApprovalLineageEvidenceManifestV1`与`ApprovalLineageObservabilityReportV1`。固定同一human在Feishu card与GitHub current-head review批准同一Task ID/revision/digest、Run ID/version、Plan ID/version/digest、base SHA和`merge` effect；两条event/source/approval/lineage必须独立，principal/roles digest/PR author separation一致，source occurred与decision recorded时间分别冻结。
  - observer report固定六次signed HTTP观测：Feishu/GitHub primary与same-event exact retry各一对，retry必须收敛原approval/lineage；Feishu distinct event复用nonce必须`replay_rejected`，GitHub same event改snapshot必须`source_conflict`。Feishu负例还要由operations证明只有metadata delivery且零receipt/outcome/effect。
  - `verifyApprovalLineageEvidence`以用途隔离operations/observer/GitHub read token执行1 MiB有界GET；交叉核对Case 8两条identity/approval投影、Feishu event/receipt/outcome/business effect、live GitHub review ID/login/current head/submitted time、same-human人工mapping review元数据，以及零merge outbox/fact。所有响应在JSON parse前扫描三枚token、credential形状与仓库外synthetic canary。
  - 第一次实现后聚焦测试3/5失败，暴露新verifier把数字分隔符写进正则量词（`{1,2_000}`不是合法量词语义），修正为`{1,2000}`/`{8,20000}`后5/5全绿；没有把中间configuration failure隐藏为成功。
  - 新增[`docs/ApprovalLineageE2E.md`](docs/ApprovalLineageE2E.md)、manifest/report两份schema example、公共export和package script，同步DOD、Proto、Architecture、Security与Reference；只勾“真实外部证据验收契约”。
- 验证：
  - 红灯命令见上；实现后`pnpm exec vitest run test/approval-lineage-evidence.test.ts` → exit 0，1 file / 5 tests。覆盖strict pair/inventory/schema examples、observability canonical digest、same-event重投、跨平台same-human/exact snapshot/two lineage、Feishu distinct-event与GitHub snapshot mutation隔离、live review、zero merge、canary/token零传播和CLI opt-in/缺配置。
  - `pnpm exec vitest run test/identity-approval-evidence.test.ts test/feishu-card-action-evidence.test.ts` → exit 0，2 files / 9 tests；`pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/case8-audit-report.test.ts test/workflow/feishu-card-action.test.ts test/workflow/github-merge-gate.test.ts` → exit 0，3 files / 45 tests。覆盖既有Case 8、Feishu receipt/lineage与GitHub approval producer无回归。
  - `pnpm run e2e:approval-lineage`（无opt-in）→ exit 2，固定`approval-lineage-e2e: opt-in missing`；设置opt-in但缺配置 → exit 2，固定`required evidence configuration is incomplete`；两次均在manifest/credential/network前结束。
  - `pnpm run verify` → exit 0：typecheck、ESLint、Node 91 files / 347 tests、workerd 56 files / 303 tests、429个生产文件Secret scan和文档链接全绿；workerd仅输出既有预期Workflow terminate清理信息。
  - `CI=1 WRANGLER_SEND_METRICS=false pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round112-final-20260727` → exit 0，bundle 2690.77 KiB / gzip 451.70 KiB；识别双Workflow、双Queue、D1与四个R2 binding，未部署。
  - `pnpm run typecheck`、定向ESLint与`git diff --check` → exit 0。
- 勾选：Phase 2 approval唯一关联项新增并勾选“真实外部证据验收契约”；真实飞书signed card decision、GitHub signed current-head review、两类受控重投/隔离、live REST、open_id↔login↔principal人工mapping、CLI exit 0和父项保持未勾。fake HTTPS、schema example、manifest/report自报、direct D1 insert、dry-run或默认exit 2不能替代真实平台事实。
- 决策沉淀：approval事实与external event lineage已经是D1真源；本轮缺口不是再建表，而是防止“两个各自正确的approval”被误说成同一个人批准了同一snapshot。必须同时证明共享human/snapshot与独立event/source/approval/lineage，且same-event replay收敛、event/snapshot mutation隔离。Feishu没有历史callback read API，因此signed observer、D1 receipt/Case 8、live GitHub review与人工identity mapping四者不可互相替代。
- 遗留：当前没有已部署控制面、测试飞书应用/群/latest card、受控GitHub repo/PR、同一映射human、独立signed observer、用途隔离read token或人工mapping证据。需owner批准测试点击/review/replay窗口后按[`docs/ApprovalLineageE2E.md`](docs/ApprovalLineageE2E.md)执行；只有`DELIVERY_LOOP_APPROVAL_LINEAGE_E2E=1 pnpm run e2e:approval-lineage` exit 0且人工authority入账后，才能勾真实外部事实与父DoD。

## Round 113 — 2026-07-27
- 目标：Phase 2 / optional monitor adapter只创建candidate/triage、同指纹窗口合并且没有repo write。本轮只闭环生产`enabled|disabled`两种决策的真实外部证据验收契约；未访问真实Sentry/Cloudflare、发送告警、修改binding、部署、创建Task或执行仓库effect，父项与真实外部事实保持未完成。
- 前置与权限：仅使用本地delivery-loop、Watt固定commit`476e3cdd2490d725fde174e7c697ebf00899edc6`既有迁入源码、Sentry官方公开文档、fake HTTPS、Node/workerd/D1/R2、文档检查与Wrangler dry-run。未使用真实Secret、tenant/project/settings token，未提交代码或更新llmdoc；当前Wrangler D1仍是占位资源，dry-run不构成Cloudflare生产配置证据。
- authority审计：migration 0050已经提供immutable receipt、suppression head、candidate与event lineage，且Task/Run/approval/outbox物理分离；因此没有新增migration或第二张monitor真源表。原`GET /v1/triage/monitor`只能列candidate，不能证明exact rejected event零receipt、某一event的lineage或隐藏R2 snapshot完整性，故只新增operations exact-event安全投影。Sentry官方Integration Platform Webhooks确认`Sentry-Hook-Signature`为client secret对exact request body的HMAC-SHA256；enabled v1据此固定Sentry，不用generic fixture宣称兼容其他provider。
- Watt直接复用：Watt没有Sentry native observer、Cloudflare Worker settings核对、monitor D1/R2证据投影或enabled/disabled治理分支，等价业务代码直接复制量为零；生产继续直接复用Round 77从Watt迁入的exact-body HMAC与inclusive dedupe。新CLI继续沿用Watt`scripts/e2e/lib.ts`的显式opt-in、仓库外64 KiB manifest、固定0/1/2退出及安全固定错误纪律；1 MiB有界HTTPS和canary扫描复用本项目既有Watt-derived E2E骨架，没有虚构Watt业务来源。
- 动作：
  - 先写红灯：新增`test/monitor-alert-evidence.test.ts`，首次`pnpm exec vitest run test/monitor-alert-evidence.test.ts`为exit 1、failed suite / 0 tests，缺`src/domain/monitor-alert-evidence.ts`。恢复本轮时`pnpm run typecheck`继续按预期exit 2，缺`src/pilot/monitor-alert-evidence-verifier.ts`；随后才补实现。
  - 新增strict discriminated `MonitorAlertEvidenceManifestV1`：共同冻结exact Cloudflare account/service/production settings与owner decision。disabled固定`not_enabled + productionConfigurationAbsent`；enabled固定Sentry project/rule/native签名元数据、受信generic profile、四accepted event、三rejected event和人工mapping/project review。独立observability report固定八个scenario，并要求same-event retry exact request/delivery收敛、三个窗口内event共享candidate、过窗event切新candidate。
  - 新增operations-only `GET /v1/operations/monitor-alert/evidence?tenantKey=<exact>&eventId=<exact>`。它联查receipt/lineage/candidate与monitor source的Task/Run/approval/outbox计数，再有界回读隐藏R2对象、strict parse并重算exact snapshot/resource/fingerprint digest和custom metadata；响应只给安全ID、ordinal/suppressed、受控mapping、candidate count/time及snapshot验证布尔，不返回正文、resource、任何digest、R2 ref或SQL行。不存在/持久化前拒绝event固定`found=false`且所有authority count为零。
  - 新增`verifyMonitorAlertEvidence`与`pnpm run e2e:monitor-alert`。两种模式都用独立环境配置的exact只读Cloudflare settings URL读取live bindings；disabled要求四个monitor binding全缺。enabled要求Secret为`secret_text`，tenant/sorted allowlist JSON/window seconds三个`plain_text`与profile exact相等；随后交叉observer canonical digest、7个exact D1/R2投影、Sentry live project/rule ID/environment及全程零authority。所有响应在JSON parse前扫描四枚用途隔离token、credential形状与仓库外synthetic canary；CLI没有mutation路径。
  - 新增[`docs/MonitorAlertE2E.md`](docs/MonitorAlertE2E.md)、enabled/disabled manifest与observer report三份schema example、公共export和package script，同步DOD、Proto、Architecture、Security与Reference；只勾“真实外部证据验收契约”。手写report example首次聚焦测试暴露四个digest长度错误，修正后重新全绿，没有把示例失败隐藏成成功。
- 验证：
  - 聚焦`pnpm exec vitest run test/monitor-alert-evidence.test.ts test/monitor-alert.test.ts` → exit 0，2 files / 13 tests；覆盖strict双模式/example、observer digest/retry、Cloudflare binding presence/absence/value、四accepted/三rejected D1/R2、suppression/candidate drift、zero authority、Sentry project/rule mismatch、credential leak及CLI opt-in。
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/monitor-alert-ingress.test.ts` → exit 0，1 file / 4 tests；覆盖operations auth/strict query、accepted exact receipt/lineage/candidate与R2重算、authority injection rejected event的`found=false`/零effect，以及正文/resource/digest/ref/Secret零返回。
  - `pnpm run e2e:monitor-alert`（无opt-in）→ exit 2，固定`monitor-alert-e2e: opt-in missing`；设置opt-in但缺配置 → exit 2，固定`required evidence configuration is incomplete`；两次都在manifest credential/network前结束。
  - `pnpm run verify` → exit 0：typecheck、ESLint、Node 92 files / 352 tests、workerd 56 files / 304 tests、436个生产文件Secret scan和文档链接全绿；workerd仅输出既有预期Workflow terminate清理信息。
  - `CI=1 WRANGLER_SEND_METRICS=false pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round113-final-20260727` → exit 0，bundle 2702.19 KiB / gzip 453.20 KiB；识别双Workflow、双Queue、D1与四R2 binding，未部署。
  - `pnpm run lint`、`pnpm run verify:docs`与`git diff --check` → exit 0。
- 勾选：monitor adapter项新增并勾选“真实外部证据验收契约”；真实Sentry native webhook、受控八case、Cloudflare live settings、Sentry live REST、CLI exit 0与父项保持未勾。fake HTTPS/workerd、schema example、manifest/report自报、default exit 2、dashboard URL或dry-run不能替代真实外部事实。若生产明确不启用，仍必须由owner decision与live settings API exit 0后把真实事实子项按N/A关门，本轮未代替该决定。
- 决策沉淀：生产“启用”与“不启用”不是同一证据清单上的可选字段。disabled只需治理决策和live配置缺失；enabled则需要native signature observer、D1 event lineage、R2 snapshot、Cloudflare bindings和Sentry project/rule五类authority。observer只能证明它看到/转发的HTTP，manifest只能绑定预期，D1/R2只能证明控制面结果；任何单源都不能证明真实Sentry到零authority的完整链。
- 遗留：当前没有生产owner决策、已部署控制面、Sentry test organization/project/rule/integration、native observer、用途隔离Cloudflare/operations/observer/Sentry read token或受控过窗时段。需owner先选择enabled或disabled；enabled按[`docs/MonitorAlertE2E.md`](docs/MonitorAlertE2E.md)执行八case并完成人工project/integration review，disabled记录`not_enabled`并用production settings证明四binding全缺。只有`DELIVERY_LOOP_MONITOR_ALERT_E2E=1 pnpm run e2e:monitor-alert`读取真实平台exit 0后，才能勾真实事实或标N/A并评估父DoD。

## Round 114 — 2026-07-27
- 目标：Phase 4最终试点DoD“真实试点repo完成requirement与bug各一条到Draft PR”。本轮只闭环严格、可重跑的真实外部证据验收契约；未访问真实控制面/GitHub tenant、dispatch Action、写仓库、创建/修改PR、merge、deploy或使用真实Secret，父项与真实试点外部事实保持未完成。
- 前置与权限：仅使用本地delivery-loop、Watt固定commit`476e3cdd2490d725fde174e7c697ebf00899edc6`既有模式、fake HTTPS、Node/workerd、文档检查与Wrangler dry-run。当前仓库没有可供验收的真实双case manifest/read token；示例manifest只验证schema，不能冒充真实Task/Action/PR。未提交代码或更新llmdoc。
- authority审计：Task GET已提供intent/source revision/digest/acceptance count，Plan GET已提供required Item/verification decision/Attempt/Evidence，Case 8已提供commit/command/Item verification/PR observation，GitHub REST已提供Action/job、compare diff和当前PR。因此没有新增migration、第二张试点汇总表或第二套PR真源；manifest只组合expected安全索引。业务semantic与bug root cause无法由ID/digest自证，继续要求真人独立review原始需求、诊断、diff、测试与PR。
- Watt直接复用：新CLI直接沿用Watt`scripts/e2e/lib.ts`的显式opt-in、仓库外64 KiB manifest、固定安全错误与0/1/2退出纪律；1 MiB有界HTTPS、分页fail-closed和credential-shaped canary扫描复用本项目既有Watt-derived E2E骨架。Watt没有requirement/bug→ExecutionPlan/DoD→Draft PR业务链或五方证据绑定，等价业务代码复制量为零；本轮直接复用项目现有`verifyGitHubPullRequestEvidence`，没有复制第二套PR parser。
- 动作：
  - 先写红灯：`pnpm exec vitest run test/draft-pr-cases-evidence.test.ts`首次exit 1、failed suite / 0 tests，缺`src/domain/draft-pr-cases-evidence.ts`；随后才实现schema/verifier/CLI。
  - 新增strict `DraftPrCasesEvidenceManifestV1`，固定按顺序出现`requirement + prd`和`bug + user_feedback`。两条case必须共享受审repo/base branch但使用不同Task、Run、Action、head、branch和PR；每条至少有investigation/change/verification/delivery四类required Item，全部acceptance index覆盖，targeted先于required且全部test Evidence绑定final head。
  - 新增`verifyDraftPrCasesEvidence`与`pnpm run e2e:draft-pr-cases`。逐case交叉Task GET、Plan GET、Case 8 canonical report、GitHub `Delivery Agent`唯一job/固定三step、base→head compare与canonical changed-file digest，再调用既有Draft PR verifier核对publication、webhook/API observation和live `open + draft` PR；同时要求零merge、零deployment和所有响应零credential/canary泄漏。
  - authority实读暴露既有`verifyGitHubPullRequestEvidence`与生产Case 8 API不一致：旧代码错误读取`run.id`和`task.target.repository`，真实投影是顶层`runId`与`task.repository`。已修正production projection并同步原测试fixture；未用兼容双读掩盖错误schema。
  - 新增[`docs/DraftPrCasesE2E.md`](docs/DraftPrCasesE2E.md)、schema example、公共export和package script，同步DOD、Proto、Architecture、Security与Reference；只勾“真实外部证据验收契约”，明确manifest/reviewer URL不能自证semantic/root cause。
- 验证：
  - 聚焦`pnpm exec vitest run test/draft-pr-cases-evidence.test.ts test/github-pr-evidence.test.ts` → exit 0，2 files / 10 tests；覆盖strict双case/example、Task/Plan/acceptance coverage、Case 8 commit/test/Evidence、Action/job、compare diff、当前Draft PR、各类drift、credential-shaped canary与CLI前置边界。
  - 扩展Node回归`pnpm exec vitest run test/draft-pr-cases-evidence.test.ts test/github-pr-evidence.test.ts test/analysis-action-evidence.test.ts test/pull-request-draft.test.ts` → exit 0，4 files / 18 tests；workerd回归`case8-audit-report/github-pull-request/pull-request-draft` → exit 0，3 files / 11 tests。
  - `pnpm run e2e:draft-pr-cases`（无opt-in）→ exit 2，固定`opt-in missing`；设置opt-in但缺配置 → exit 2，固定`required evidence configuration is incomplete`。两次都没有读取manifest/credential或发网络请求。
  - 第一次`pnpm run verify`中typecheck/lint和Node 93 files / 357 tests已通过，但既有workerd `execution-attempt-api`并发重放测试出现409时序失败；单独首次重跑仍失败。未将其伪装为成功：临时只读响应诊断行已移除，随后三个独立进程各2/2通过，未修改该测试断言或生产ExecutionHead实现。第二次完整`pnpm run verify` → exit 0：Node 93 files / 357 tests、workerd 56 files / 304 tests、440个生产文件Secret scan和文档链接全绿；workerd仅输出既有预期Workflow terminate清理信息。
  - `CI=1 WRANGLER_SEND_METRICS=false pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round114-final-20260727` → exit 0，bundle 2702.19 KiB / gzip 453.20 KiB；识别双Workflow、双Queue、D1与四个R2 binding，未部署。
  - `pnpm run lint`、`pnpm run verify:docs`与`git diff --check`在文档落地前已exit 0；最终修改后再次执行下述收尾命令入账。
- 勾选：Phase 4最终试点项新增并勾选“真实外部证据验收契约”；真实同repo两条Task/Run/Action/head/branch/PR、真人PRD semantic与bug root-cause review、真实CLI exit 0和父项保持未勾。fake HTTPS、schema example、manifest自报、local workerd、dry-run或默认exit 2不能替代真实外部事实。
- 决策沉淀：最终试点不是再造一张`pilot_cases`表，而是将已有五个authority做交叉证明。Task/Plan回答“计划与DoD是否完成”，Case 8回答“控制面记了什么”，Actions/compare回答“GitHub实际执行和改了什么”，PR verifier回答“外部PR是否仍是当前Draft”，真人review回答“需求语义和bug根因是否成立”；任何一方不能替代其余各方。
- 遗留：当前没有已部署控制面、受控试点repo中的一条真实PRD和一条真实用户反馈、对应两条成功Action/Draft PR、用途隔离只读token、synthetic canary或真人semantic/root-cause review证据。需owner授权试点资源与执行窗口后按[`docs/DraftPrCasesE2E.md`](docs/DraftPrCasesE2E.md)采集仓库外manifest；只有`DELIVERY_LOOP_DRAFT_PR_CASES_E2E=1 pnpm run e2e:draft-pr-cases`读取真实五方事实exit 0且人工review入账后，才能勾真实外部事实与父DoD。

## Round 115 — 2026-07-27
- 目标：Phase 6 / Task、Run、Attempt、GitHub run、PR、test/production deployment与tool trace可在日志和trace中联查。本轮只闭环Cloudflare Workers Logs/Traces + GitHub + D1四方真实外部证据验收契约；未访问真实tenant、部署Worker、调用真实GitHub/Cloudflare API或使用真实Secret，父项与真实平台事实保持未完成。
- 前置与权限：仅使用本地delivery-loop、Watt固定commit`476e3cdd2490d725fde174e7c697ebf00899edc6`的已审模式、Cloudflare官方公开文档、fake HTTPS、Node/workerd、文档检查和Wrangler dry-run。当前Wrangler D1仍是占位资源，observability配置只写入仓库且未部署；未提交代码或更新llmdoc。
- authority审计：既有`GET /v1/correlations`与D1 split views已直接联查authoritative ledger，`CorrelationLogger`也是唯一生产structured console路径，故不新增migration、correlation汇总表或telemetry副本。D1只能证明控制面内部lineage，GitHub REST只能证明当前外部对象，Workers Logs只能证明安全record持久化，Workers Traces只能证明调用trace；manifest与Dashboard URL都不能替代这四方中的任一authority。
- Watt直接复用：Watt固定commit只有内部metrics/D1 audit与短期Agent correlation，没有跨Task/PR/deployment的Cloudflare telemetry证据链，等价业务代码复制量为零。新CLI最大化复用Watt`scripts/e2e/lib.ts`的显式opt-in、仓库外64 KiB manifest、固定0/1/2退出和安全错误纪律；1 MiB/10秒有界HTTPS、parse前credential/canary扫描继续复用本项目既有Watt-derived骨架，没有虚构Watt业务能力。
- 动作：
  - 先写红灯：`pnpm exec vitest run test/correlation-platform-evidence.test.ts`首次exit 1、failed suite / 0 tests，缺`src/domain/correlation-platform-evidence.ts`；扩展完整五个case后再实现，没有先写实现再补断言。
  - 新增strict`CorrelationPlatformEvidenceManifestV1`与`CorrelationPlatformLogRecordV1`。manifest固定十条有序lookup、同一Run lineage、四个GitHub object、Cloudflare account digest/production script/七天窗口、100% sampling/persist、synthetic canary digest和三类人工review URL；每条lookup绑定exact observed time、strict log canonical digest和唯一32位worker trace ID。
  - `CorrelationLogger`增加来自strict query parse的`matchedByKind/matchedById/matchedByRepository`，不记录请求URL或raw query。`wrangler.jsonc`显式启用persisted Logs/Traces与100% head sampling，并以`invocation_logs=false`减少平台自动请求元数据；这是试点验收配置，扩大生产流量前仍需成本评估。
  - 新增`verifyCorrelationPlatformEvidence`与`pnpm run e2e:correlation-platform`。逐条核对十个非truncated D1安全projection，再实时读取GitHub Action、PR和两个Deployment；随后直接调用Cloudflare官方telemetry query endpoint，以`dry=true`分别执行十个events与十个traces查询，核对account/service/trace/time/source digest/truncated/span/error。所有外部响应在JSON parse前扫描三枚用途隔离token、credential-shaped canary和credential模式，只输出固定错误码。
  - 新增[`docs/CorrelationPlatformE2E.md`](docs/CorrelationPlatformE2E.md)、schema example、公共export和package script，同步DOD、Proto、Architecture、Security与Reference；只勾“真实外部证据验收契约”。
- 验证：
  - 聚焦`pnpm exec vitest run test/correlation-platform-evidence.test.ts` → exit 0，1 file / 5 tests；覆盖strict example/Wrangler配置、十D1+四GitHub+十log+十trace、lineage/GitHub drift、truncated log、missing trace、credential leak与CLI前置边界。
  - workerd聚焦`pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/correlation-query.test.ts` → exit 0，1 file / 3 tests；覆盖D1五类基础反查、认证/strict query和新增matched-by allowlist log。
  - `pnpm run e2e:correlation-platform`（无opt-in）→ exit 2，固定`opt-in missing`；设置opt-in但缺配置 → exit 2，固定`required evidence configuration is incomplete`。首次把两条命令包装为一个zsh退出码检查时误用了只读变量名`status`，wrapper exit 1；未伪装成功，改用`code_one/code_two`后确认两次均为预期exit 2且无网络。
  - `pnpm run typecheck`、`pnpm run lint`、`pnpm run verify:docs`和`git diff --check` → exit 0。追加Round记录后的首次组合文档检索因shell双引号内含反引号导致`unmatched quote`、exit 1；修正为单引号pattern后`verify:docs + diff --check + rg`再次exit 0，未把命令拼接错误当作项目失败或成功证据。
  - `pnpm run verify` → exit 0：Node 94 files / 362 tests、workerd 56 files / 304 tests、444个生产文件Secret scan和文档链接全绿；workerd只输出既有预期Workflow terminate清理信息。
  - `CI=1 WRANGLER_SEND_METRICS=false pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round115-final-20260727` → exit 0，bundle 2702.37 KiB / gzip 453.24 KiB；识别双Workflow、双Queue、D1与四个R2 binding，未部署。
- 勾选：Phase 6 correlation项新增并勾选“真实外部证据验收契约”；真实Worker deployment、七天内十条live log/trace、四个GitHub live object、Dashboard人工review、真实CLI exit 0与父项保持未勾。fake HTTPS、schema example、manifest/URL自报、local workerd、Wrangler dry-run或默认exit 2不能替代真实外部事实。
- 决策沉淀：Correlation的长期业务root仍是`run_id`，D1 ledger仍是内部状态真源；telemetry不是第二套状态机。可恢复审计必须通过D1 lineage、GitHub外部对象、Workers persisted log和Workers trace四方交叉证明，并把最大七天的Cloudflare原生保留作为操作窗口，而不是假设日志永久存在。未来需要更长保留时应单独接入受审OpenTelemetry sink，不能把官方export能力文档当作已配置事实。
- 遗留：当前没有已部署控制面、真实试点Run、Cloudflare Workers Observability read token、控制面/GitHub用途隔离read token、synthetic canary或三类Dashboard人工review。需owner批准部署和只读采集窗口后按[`docs/CorrelationPlatformE2E.md`](docs/CorrelationPlatformE2E.md)在七天内生成十次查询与仓库外manifest；只有`DELIVERY_LOOP_CORRELATION_PLATFORM_E2E=1 pnpm run e2e:correlation-platform`读取真实四方事实exit 0且人工review入账后，才能勾真实平台事实与父DoD。

## Round 116 — 2026-07-27
- 目标：Phase 5 / 仓库有明确rollback contract时测试环境自动回滚可执行，production自动回滚另行审批。本轮只闭环严格、可重跑的真实外部证据验收契约；未制造真实test/production failure、访问真实控制面/GitHub/云tenant、dispatch Action、执行云回滚、部署Worker或使用真实Secret，父项与真实GitHub/云事实保持未完成。
- 前置与权限：仅使用本地delivery-loop、Watt固定commit`476e3cdd2490d725fde174e7c697ebf00899edc6`既有模式、fake HTTPS、Node/workerd、文档检查和Wrangler dry-run。未提交代码或更新llmdoc；当前Wrangler D1仍为占位资源，dry-run不构成已部署控制面或真实Environment/OIDC/云审计证据。
- authority审计：migration 0033、`TestRollbackStore/RunnerStore/GitHubTestRollbackStatusStore`和固定workflow已经形成contract observation、rollback snapshot、独立Attempt/outbox/OIDC、Runner result、GitHub双源observation与Evidence真源，因此没有新增migration、回滚汇总表或第二套状态机。原Task查询只有简化rollback摘要，Case 8没有contract/rollback/observation投影，且没有外部verifier/CLI，无法可重跑地证明两类真实失败成功回滚与两类越权边界。
- Watt直接复用：Watt的`rollbackDelivery`只把投递失败的outbox从delivering退回pending，不是云环境rollback，无法复制为业务回滚。新CLI最大化复用Watt`scripts/e2e/lib.ts`的显式opt-in、仓库外64 KiB manifest、固定0/1/2退出和安全错误纪律；1 MiB/10秒有界HTTPS、credential-shaped canary parse前扫描和生产`GitHubActionsApiClient.getRollbackWorkflowRun` parser复用本项目既有Watt-derived骨架。新增内容只组合既有rollback authorities，没有虚构Watt业务能力。
- 动作：
  - 先写红灯：新增`test/test-rollback-evidence.test.ts`，首次`pnpm exec vitest run test/test-rollback-evidence.test.ts`为exit 1、failed suite / 0 tests，缺`src/domain/test-rollback-evidence.ts`；随后才实现schema/verifier/CLI和projection。
  - 新增strict `TestRollbackEvidenceManifestV1`，固定deployment failure与acceptance failure两条成功rollback，以及contract absent与production failure两条零effect；正向绑定source failure/Evidence、exact policy/contract digest、独立Attempt/outbox、fixed workflow/test Environment/OIDC role、Runner+GitHub双事实、双源observation、rollback Evidence和云人工review。负向绑定受控GitHub workflow inventory窗口；production decision固定`not_approved`并要求治理链接/reviewer。
  - Case 8新增`checks.testRollbackContracts/testRollbacks/testRollbackObservations`。查询直接联查authoritative表并严格验证白名单标量，只公开source/Run/Plan/Attempt/policy digest/status/GitHub/OIDC identity/Evidence/时间；token、OIDC JWT/token digest、raw policy/argv、Runner output和raw webhook/REST没有response字段。workerd穿透同时覆盖declared成功与`not_declared`零effect。
  - 新增`verifyTestRollbackEvidence`与`pnpm run e2e:test-rollback`。四条Run均回读Case 8；两条正向用用途隔离Actions read token实时读取exact Action，两条负向用exact workflow+head SHA+受控created窗口实时要求`total_count=0`且无分页。所有body在JSON parse前扫描控制面/GitHub token、synthetic canary和credential形状；CLI没有mutation路径。
  - 新增[`docs/TestRollbackE2E.md`](docs/TestRollbackE2E.md)、schema example、公共export和package script，同步DOD、Proto、Architecture、Security与Reference；只勾“真实外部证据验收契约”，云URL/manifest自报不能替代真人打开真实平台事实。
- 验证：
  - 聚焦`pnpm exec vitest run test/test-rollback-evidence.test.ts` → exit 0，1 file / 4 tests；覆盖strict四case/example、正向Case 8+Action、负向零Action inventory、projection/Action/inventory drift、credential leak和CLI opt-in。
  - workerd聚焦`pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/test-rollback.test.ts` → exit 0，1 file / 9 tests；覆盖本地rollback完整状态机，并新增declared/negative Case 8安全投影与Secret零返回。
  - `pnpm run e2e:test-rollback`无opt-in → exit 2，固定`opt-in missing`；设置opt-in但缺真实配置 → exit 2，固定`required evidence configuration is incomplete`。两次都在manifest/credential/network前结束。
  - `pnpm run typecheck`、`pnpm run lint`、`pnpm run verify:docs`与`git diff --check` → exit 0。首次并行聚焦检查如实暴露test tuple类型、一个regex lint和workerd期望ID pattern三处问题，修正后全部通过。
  - `pnpm run verify` → exit 0：typecheck、ESLint、Node 95 files / 366 tests、workerd 56 files / 304 tests、448个生产文件Secret scan和文档链接全绿；workerd只输出既有预期Workflow terminate清理信息。
  - 首次dry-run wrapper因包含`rm -rf /tmp/...`被命令安全策略拒绝，未执行项目命令且未伪装成功；改用新唯一outdir，最终`CI=1 WRANGLER_SEND_METRICS=false pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round116-final-20260727-2031` → exit 0，bundle 2714.09 KiB / gzip 454.87 KiB；识别双Workflow、双Queue、D1与四R2 binding，未部署。
- 勾选：Phase 5 rollback项新增并勾选“真实外部证据验收契约”；真实test Environment的deployment/acceptance failure回滚、exact Actions/OIDC/云审计/环境恢复、contract absent与production failure零Action、production真人治理决定、真实CLI exit 0及父项保持未勾。fake HTTPS、schema example、manifest/URL、自报review、local workerd、dry-run或默认exit 2不能替代。
- 决策沉淀：回滚成功是独立补偿事实，不会改写原failed Item/Evidence或把Run伪装为`succeeded`。D1回答控制面授权/执行链，GitHub live Action与负向inventory回答外部job是否存在，云审计/环境结果由真人回答真实恢复，production治理记录回答权限是否批准；四者不能互相替代。production未来若批准自动回滚，必须提升为独立schema/approval/Environment/OIDC/outbox和演练，不能扩展test manifest越权。
- 遗留：当前没有已部署控制面、受控试点repo/test Environment、两条真实失败与rollback Action、云审计/环境结果、用途隔离Case 8/Actions read token、synthetic canary或production owner治理记录。需owner批准试点资源和失败窗口后按[`docs/TestRollbackE2E.md`](docs/TestRollbackE2E.md)采集仓库外manifest；只有`DELIVERY_LOOP_TEST_ROLLBACK_E2E=1 pnpm run e2e:test-rollback`读取真实平台exit 0且真人review入账后，才能勾真实GitHub/云事实并评估父DoD。

## Round 117 — 2026-07-27
- 目标：Phase 7 / E2E-1“真实Meegle/卡片创建任务 → 只读分析 → ExecutionPlan v1 → 计划/effect批准 → 单一Run/Workflow/analysis Action”。本轮只闭环严格、可重跑的真实外部证据组合契约；未访问真实Meegle/飞书/GitHub/Cloudflare tenant、创建Task、点击卡片、dispatch Action、签发write credential、写仓库或部署Worker，E2E-1真实平台事实与最终Done保持未完成。
- 前置与权限：仅使用本地delivery-loop、Watt固定commit`476e3cdd2490d725fde174e7c697ebf00899edc6`既有E2E模式、三份现有verifier、fake HTTPS、Node测试、文档检查和Wrangler dry-run。无真实Secret进入命令/manifest/日志，未提交代码或更新llmdoc；四份example只验证schema，不能冒充真实工作项、human、Action或Workflow。
- authority审计：analysis Plan activation把validated Plan置active并让Run进入`awaiting_approval`，没有独立`plan_approvals`真源；`approvals`表的一条记录已经exact绑定Task revision、Plan version/digest、base SHA和effect。因此E2E-1的“计划/effect批准”是同一真人`approve(repo_write)` decision的两个绑定维度，不是复制两条approval。Meegle mapping ledger、Task/Plan/Case 8、GitHub Actions、飞书card-action ledger和Cloudflare live instance各回答不同事实，任何单方或manifest不能替代其余authority。
- Watt直接复用：Watt没有Meegle PRD→delivery-loop Task/Run→GitHub analysis Plan→飞书exact approval的跨平台lineage，等价业务代码直接复制量为零；强行复制generic Task/checkpoint approval会丢失revision、Plan digest/base/effect和external human绑定。本轮继续直接复用Watt`scripts/e2e/lib.ts`的显式opt-in、仓库外64 KiB manifest、固定0/1/2及安全错误纪律，并最大化复用本项目既有`verifyMeegleWorkItemEvidence`、`verifyAnalysisActionEvidence`和`verifyFeishuCardActionEvidence`，没有复制第二套Meegle/GitHub/飞书parser。
- 动作：
  - 先写红灯：`pnpm exec vitest run test/requirement-e2e-evidence.test.ts`首次exit 1、failed suite / 0 tests，缺`src/domain/requirement-e2e-evidence.ts`；随后才实现schema/verifier/CLI。
  - 新增strict`RequirementE2EEvidenceManifestV1`。主manifest只保存三份完整子manifest的canonical digest和同一repository、Meegle event/work-item、Task/revision/digest、Run/version、Workflow instance、Plan/version/digest/base、analysis Attempt/Action、飞书approval安全lineage；任一子manifest变更先触发digest失败，digest同步后仍须交叉绑定。
  - 新增`verifyRequirementE2EEvidence`与`pnpm run e2e:requirement`。三份原verifier无条件执行；组合层固定`prd + requirement`、唯一mapped Task/Run、`run_id=workflowInstanceId`、唯一analysis Action和mapped human的`approve(repo_write)`。随后复读当前Case 8，要求Run仍`awaiting_approval`、exact approval唯一、只有settled analysis dispatch outbox且write credential/change/deployment全零；最后只读Cloudflare live `delivery-run/instances/:runId`核对`waiting`、version和start。
  - 收尾安全review发现初版为测试暴露了可注入`componentVerifiers`，库调用者理论上可绕过三份子验证器；该旁路在提交前完全移除，测试改用Vitest模块替身，生产函数现在无条件调用原verifier。Cloudflare与Case 8响应均1 MiB/10秒有界并在JSON parse前扫描全部用途隔离token和credential-shaped canary。
  - 新增[`docs/RequirementE2E.md`](docs/RequirementE2E.md)、schema example、公共export和package script，同步DOD、Proto、Architecture、Security与Reference；只勾E2E-1“真实外部证据验收契约”，真实平台子项保持未勾。
- 验证：
  - 聚焦`pnpm exec vitest run test/requirement-e2e-evidence.test.ts` → exit 0，1 file / 5 tests；覆盖strict example、三manifest digest、同一Task/Run/Plan/approval、真实子verifier强制调用、Cloudflare instance、当前Case 8零write effect、component/lineage/Workflow漂移、credential泄漏与CLI前置边界。
  - 扩展`pnpm exec vitest run test/requirement-e2e-evidence.test.ts test/meegle-work-item-evidence.test.ts test/analysis-action-evidence.test.ts test/feishu-card-action-evidence.test.ts` → exit 0，4 files / 21 tests。
  - `pnpm run e2e:requirement`无opt-in → exit 2，固定`opt-in missing`；`DELIVERY_LOOP_REQUIREMENT_E2E=1 pnpm run e2e:requirement`缺配置 → exit 2，固定`required evidence configuration is incomplete`。两次都在manifest/credential/network前结束。
  - `pnpm run typecheck`、`pnpm run lint`、`pnpm run verify:docs`与`git diff --check` → exit 0；四份example总计32460 bytes且各自均小于64 KiB。
  - 一次完整`pnpm run verify`如实暴露既有workerd`execution-attempt-api`20路响应中的一个409：Node 96 files / 371 tests通过，workerd 55 files / 303 tests通过、1 test失败。该路径本轮未修改且Round 114已有同指纹；立即聚焦重跑为1 file / 2 tests通过，未改生产代码或放宽断言。最终修改后的完整`pnpm run verify` → exit 0：Node 96 files / 371 tests、workerd 56 files / 304 tests、452个生产文件Secret scan和文档链接全绿；workerd仅输出既有预期Workflow terminate清理信息。
  - `CI=1 WRANGLER_SEND_METRICS=false pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round117-final-20260727-2105` → exit 0，bundle 2714.09 KiB / gzip 454.87 KiB；识别双Workflow、双Queue、D1与四R2 binding，未部署。
- 勾选：Phase 7 E2E-1新增并勾选“真实外部证据验收契约”；真实Meegle PRD/飞书human card approval、真实GitHub analysis Action、live Cloudflare Workflow、四份仓库外manifest、用途隔离read token、synthetic canary、真人语义/Plan review、真实CLI exit 0及E2E-1本身保持未完成。fake HTTPS、schema example、本地测试、manifest自报、dry-run或默认exit 2不能替代。
- 决策沉淀：E2E-1是既有authority的组合验真，不是新增E2E状态表。一个approval record同时批准exact Plan snapshot与一个effect，但summary以`approvalRecords=1 + planSnapshotsApproved=1 + effectsApproved=1`明确“一个decision、两个绑定维度”。E2E-1停在批准且零write effect；执行代码和Draft PR属于E2E-3，不能提前混入。
- 遗留：当前没有已部署控制面、真实Meegle PRD工作项、飞书测试tenant/card mapped human、试点GitHub App/repository/analysis Action、Cloudflare Paid Workflow实例、四类用途隔离只读credential、synthetic canary或cross-lineage人工review。需owner授权试点资源与受控窗口后按[`docs/RequirementE2E.md`](docs/RequirementE2E.md)采集四份仓库外manifest；只有`DELIVERY_LOOP_REQUIREMENT_E2E=1 pnpm run e2e:requirement`读取真实四方事实exit 0且Reviewer打开Meegle/飞书/GitHub/Cloudflare链接入账，才能勾E2E-1真实平台事实。

## Round 118 — 2026-07-27
- 目标：Phase 7 / E2E-2“输入uid/cid/路径等定位信息 → tool-bridge查日志/trace → 根因Evidence + DoD计划可引用，未写生产”。本轮只闭环控制面根因authority与严格、可重跑的真实外部证据验收契约；未访问真实日志/数据库/GitHub/Cloudflare tenant、调用真实tool-bridge、dispatch Action、写仓库或部署Worker，E2E-2真实平台事实与最终Done保持未完成。
- 前置与权限：仅使用本地delivery-loop、Watt固定commit`476e3cdd2490d725fde174e7c697ebf00899edc6`已迁入的tool-bridge/E2E模式、fake tool/HTTPS、Node/workerd、文档检查和Wrangler dry-run。没有真实uid/cid/path、日志、trace、数据库行、Secret或root-cause正文进入manifest/命令输出；未提交代码、部署或更新llmdoc。
- authority审计：既有`tool_call_traces`只证明同Attempt发生过某类调用，既有Plan只保存自由字符串`evidenceRefs`，Case 8又把trace聚合为count；三者不能证明“这次logs/trace产生了这条根因且Plan精确引用”。因此不能只做宽松组合manifest。本轮补最小可信ledger/API：tool trace仍不保存arguments/result，diagnostic Evidence保存脱敏summary但operations投影刻意排除summary，Plan持久化边界精确重验binding。
- Watt直接复用：继续直接复用Watt的`toolActionFor(scope)`单点action映射、read/write effect catalog、metadata-only AuditStore思想和有界tool transport；CLI继续复用Watt-derived显式opt-in、仓库外64 KiB manifest、固定0/1/2、安全错误与1 MiB/10秒响应边界。Watt没有Task/Attempt/Plan/Evidence表或logs→request trace→root cause→Plan ref业务lineage，故migration 0060和diagnostic binding是本项目必需新增；组合verifier完整调用既有`verifyAnalysisActionEvidence`，没有复制第二套GitHub/Action parser。
- 动作：
  - 先写两条红灯：`pnpm exec vitest run test/bug-triage-e2e-evidence.test.ts`首次exit 1、failed suite / 0 tests，缺`src/domain/bug-triage-e2e-evidence.ts`；`pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/diagnostic-evidence.test.ts`首次exit 1、failed suite / 0 tests，缺`src/domain/diagnostic-evidence.ts`。随后才实现领域契约、ledger/API、Plan gate和verifier。
  - 新增strict`DiagnosticEvidenceV1`和migration 0060。producer只接受active`analysis + bug + planning` Attempt token；locator kinds/value只以digest持久化，root cause仅接受Secret-scanned脱敏summary/confidence/relative code refs；source trace必须同Run/Attempt、read/success且同时覆盖`logs/search`和`traces/get`。D1新增immutable binding/source表并把tool trace设为update-immutable，原始locator/log/trace/tool result/error没有列。
  - 新增`POST /v1/attempts/:attemptId/diagnostic-evidence`与operations-only`GET /v1/runs/:runId/diagnostic-evidence`。并发相同producer稳定收敛一条Evidence；查询从authoritative表join重算Task/active Plan/Evidence/source trace，只返回ID/ref/digest/白名单metadata，不返回root-cause summary。
  - `AnalysisPlanProposalStore`增加根因门禁：`bug` Plan只要声明`logs_read`，至少一条`d1://evidence/diagnostic_*` ref必须绑定同analysis Attempt的passed+verified Evidence及成功logs/trace sources；缺失、失败、跨Attempt或自由字符串在任何Plan写入前返回conflict。其他Plan/Evidence能力不被扩权。
  - 新增strict`BugTriageE2EEvidenceManifestV1`、`verifyBugTriageE2EEvidence`和`pnpm run e2e:bug-triage`。主manifest只引用完整Analysis Action manifest canonical digest与安全lineage；原verifier无条件执行，组合层再live核对唯一diagnostic Evidence/Plan ref与Case 8零write credential/change/deployment，并在parse前扫描全部用途隔离token和synthetic canary。
  - 新增[`docs/BugTriageE2E.md`](docs/BugTriageE2E.md)、schema example、公共export和package script，同步DOD、Vision、Proto、Architecture、Security与Reference。明确固定`run-analysis-attempt.ts`尚无Agent↔tool-bridge受审多轮mediation，故只勾控制面/验收契约，不勾真实平台事实。
- 验证：
  - workflow聚焦`pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/diagnostic-evidence.test.ts` → exit 0，1 file / 3 tests；覆盖8路幂等、logs+trace绑定、失败/缺失source、Secret拒绝、Plan ref gate和summary-free operations投影。
  - E2E聚焦`pnpm exec vitest run test/bug-triage-e2e-evidence.test.ts` → exit 0，1 file / 5 tests；覆盖strict example、原Analysis verifier强制调用、Task/Run/Plan/Attempt/Action、diagnostic binding、Plan ref、零write、component/root-cause/deployment drift、credential泄漏与CLI前置边界。
  - 扩展Node`bug-triage + analysis-action` → exit 0，2 files / 11 tests；扩展workerd`diagnostic-evidence + analysis-attempt-api + tool-bridge-api` → exit 0，3 files / 16 tests。`pnpm run typecheck`、`pnpm run lint`、`pnpm run verify:docs`和`git diff --check`均exit 0。
  - `pnpm run e2e:bug-triage`无opt-in → exit 2，固定`opt-in missing`，在manifest/credential/network前结束。
  - 最终`pnpm run verify` → exit 0：Node 97 files / 376 tests、workerd 57 files / 307 tests、460个生产文件Secret scan和文档链接全绿；workerd打印既有测试主动terminate清理诊断但最终exit 0。
  - `pnpm exec wrangler deploy --dry-run` → exit 0，bundle 2735.57 KiB / gzip 458.64 KiB；识别双Workflow、双Queue、D1与四R2 binding，未部署。
- 勾选：Phase 7新增并勾选E2E-2“控制面与真实外部证据验收契约”；真实用户反馈定位输入、真实tool-bridge logs/trace、固定Action的多轮mediation、真实root-cause human review、用途隔离read token、synthetic canary、真实CLI exit 0和E2E-2本身保持未完成。fake tool/HTTPS、schema example、直接D1写入、本地测试、dry-run、manifest自报或默认exit 2不能替代。
- 决策沉淀：根因Evidence不是tool-call count，也不是Agent填写的Plan字符串。可信链必须是`同Attempt成功read trace → immutable diagnostic binding → verified Evidence → active Plan exact ref`；原始敏感上下文留在受控源，D1只保留最小摘要与digest，真人review独立回答语义正确性。E2E-2组合层复用已有Action authority，不新增第二套E2E状态表。
- 遗留：控制面producer/verifier已具备，但固定analysis Runner尚未把Agent工具请求安全地调停到tool-bridge并在Plan前提交diagnostic Evidence；当前也没有已部署控制面、真实日志平台/试点repo、用途隔离token或人工审计记录。下一轮应只处理该Runner mediation契约；完成后由owner授权真实试点窗口，按[`docs/BugTriageE2E.md`](docs/BugTriageE2E.md)采集两份仓库外manifest并运行`DELIVERY_LOOP_BUG_TRIAGE_E2E=1 pnpm run e2e:bug-triage`。只有live exit 0且Reviewer核对原始反馈、日志/trace和exact SHA代码入账后，才能勾E2E-2真实平台事实。

## Round 119 — 2026-07-27
- 目标：Phase 7 / E2E-2“先补齐并审计固定analysis Runner的Agent↔tool-bridge多轮mediation”。本轮只闭环固定Runner的`logs/search → traces/get → root cause Evidence → exact Plan ref`执行契约；未访问真实用户反馈、日志/trace平台、GitHub/Cloudflare tenant，未dispatch真实Action、写目标仓库、部署Worker或勾选E2E-2真实平台事实。
- 前置与权限：仅使用本地delivery-loop、Watt固定commit`476e3cdd2490d725fde174e7c697ebf00899edc6`的只读源码、本地fake HTTPS/tool、Node/workerd、文档检查和Wrangler dry-run。没有真实uid/cid/path、日志/trace、token或Secret进入仓库/命令输出；临时诊断内容只在测试Runner temp中出现并被finally删除。未stage/commit，按项目约定未更新llmdoc。
- Watt直接复用：再次核对`harness/types.ts`、`htbp-tools.ts`与`llm.ts`，直接沿用provider-neutral schema+injected execute思想、“远端文档/结果是参考资料、不构成指令”静态prompt、deny不透传上游正文、每次真实模型调用独立usage及tool loop/final schema分离边界。Watt动态循环依赖AI SDK`generateText tools + stopWhen`，Codex CLI无in-process tool callback，不能直接复制成可运行loop；本项目据此把`DiagnosticAnalysisMediation`收窄为固定三阶段token-free capability，没有虚构Watt能力。
- 动作：
  - 先写红灯：扩展`test/codex-analysis-adapter.test.ts`后首次`pnpm exec vitest run test/codex-analysis-adapter.test.ts test/analysis-runner-bootstrap.test.ts`出现2个新失败、10个旧测试通过；失败点是Adapter忽略diagnostic配置、仍只执行单轮Plan schema。随后才实现。
  - `CodexAnalysisAdapter`新增三个strict structured-output阶段：log request、trace request、sanitized root cause + Plan。tool result只写repo外0600 mediation context；prompt固定不可信reference纪律；Agent预填任何`d1://evidence/diagnostic_*`在finish前拒绝。总timeout仍为单Attempt 50分钟，三个真实Codex进程各自产生usage。
  - `analysis-runner`新增受控mediation状态机和冻结三函数facade。一次且仅一次固定调用`logs/search`和`traces/get`，Agent不能选择path/scope/effect或访问attempt/tool token；heartbeat与tool HTTP共享fencing lock，始终读取当前轮换token。arguments/result/root cause/Plan均重验schema、256 KiB上限及runtime Secret/credential shape；失败、policy deny、重复/越序统一映射安全failure category且不读取上游错误正文。
  - bug路径预建并结算三个独立model reservation/usage；requirement/PRD仍单轮。Agent结束后先验证`logs_read + diagnostic` Item、零伪造ref、root cause/Plan Secret和workspace snapshot，再以两轮arguments计算locator digest、用实际tool trace ID提交Evidence；Runner本地重算并核对Evidence/root-cause digest，只注入控制面返回的exact ref，重算Plan digest后提交。Evidence/Plan前的workspace mutation、Secret tool result与fake ref均证明零持久写。
  - 安全测试发现初版把持有fencing/runtimeSecrets的class实例直接放入Agent input，JavaScript运行时仍可枚举private字段；提交前改为仅含三个冻结闭包函数的capability facade，测试证明Agent input对象图不含attempt/tool token。
  - Analysis Action immutable source verifier新增固定logs/trace/Evidence/ref mediation形状检查；`bug`的`AnalysisActionEvidenceManifestV1`现在必须有成功且排序的logs/repository/traces context，requirement仍允许repository-only。同步两个嵌套example及Analysis/E2E-2规范。
  - 首次完整`pnpm run verify`如实在既有`execution-attempt-api`20路相同head用例出现1个409；聚焦重跑又出现5个409，故停止盲重试并只读定位。根因为请求读到immutable head update的pending投影后，另一并发请求已推进Attempt，旧candidate分支未复读收敛authority而误报冲突。`ExecutionHeadStore`仅在candidate不匹配时复读一次projection：同内容已收敛返回existing，不同content仍由`existing()`拒绝；无循环重试或断言放宽。原红灯随后聚焦通过。
- 验证：
  - 最终聚焦`pnpm exec vitest run test/codex-analysis-adapter.test.ts test/analysis-runner-bootstrap.test.ts` → exit 0，2 files / 18 tests；覆盖三阶段schema/prompt/usage、轮换token、固定顺序、digest/ref、Secret result、重复调用、trace unavailable、fake ref、workspace mutation、temp权限/清理及requirement单轮回归。
  - 扩展Node`codex adapter + runner + analysis action + bug triage + runner heartbeat + usage` → exit 0，6 files / 36 tests；workerd`diagnostic-evidence + tool-bridge-api + analysis-attempt-api` → exit 0，3 files / 16 tests。
  - `pnpm run typecheck`、`pnpm run lint`、`pnpm run verify:docs`与`git diff --check` → exit 0。`pnpm run e2e:bug-triage`无opt-in按预期exit 2、固定`opt-in missing`，没有读取manifest/credential或联网。
  - 首次完整verify因上述既有head竞态exit 1；最小修复后`execution-attempt-api`聚焦 → exit 0，1 file / 2 tests。最终完整`pnpm run verify` → exit 0：Node 97 files / 384 tests、workerd 57 files / 307 tests、460个生产文件Secret scan和文档链接全绿；workerd只输出既有测试主动terminate清理诊断。
  - `CI=1 WRANGLER_SEND_METRICS=false pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round119-final-20260727-2216` → exit 0，bundle 2737.11 KiB / gzip 458.90 KiB；识别双Workflow、双Queue、D1与四R2 binding，未部署。
- 勾选：新增并勾选“E2E-2固定Runner mediation契约”；E2E-2真实平台事实及最终Done保持未勾。本地fake tool/Agent、schema、dry-run、默认exit 2和PROGRESS自报不能替代真实Action/tool-bridge/root-cause review。
- 决策沉淀：Agent只提出两个阶段的arguments和最终root cause/Plan；Runner固定tool authority、轮数、token、Evidence producer和Plan ref。原始工具上下文是短命不可信数据，metadata trace是调用事实，diagnostic Evidence binding是根因引用authority，真人review是语义authority，四者不能互相替代。Watt的成熟AI SDK loop可在未来更换支持callback的Adapter时复用，但不得降低本轮固定path、fencing、Secret、workspace和exact-ref门禁。
- 遗留：当前仍没有已部署控制面、真实试点GitHub Action/tool-bridge/log平台、用途隔离credential、真实uid/cid/path输入或真人根因review。需owner授权试点资源和受控窗口后按[`docs/BugTriageE2E.md`](docs/BugTriageE2E.md)采集仓库外manifest；只有`DELIVERY_LOOP_BUG_TRIAGE_E2E=1 pnpm run e2e:bug-triage`读取live事实exit 0且Reviewer打开原始反馈、日志/trace平台和exact SHA代码入账，才能勾E2E-2真实平台事实。

## Round 120 — 2026-07-27
- 目标：Phase 7 / E2E-3“repo_write批准 → 按ready DoD Item最小diff → 定向+全量测试 → Draft PR，required Item逐条有证据”。本轮只闭环控制面与真实外部证据验收契约，并同步增强Phase 4既有双case契约；未读取真实tenant/控制面/GitHub、未签发credential、dispatch Action、写目标repo、创建PR、部署Worker或勾选E2E-3真实平台事实。
- 前置与权限：只使用本地delivery-loop、Watt固定commit`476e3cdd2490d725fde174e7c697ebf00899edc6`已迁入的E2E安全骨架、本地fake HTTPS、Node/workerd、文档检查和Wrangler dry-run。没有token、Task正文、PR正文、raw API、approval正文或credential进入仓库/输出；未stage/commit，按当前阶段约定未更新llmdoc。
- authority审计：既有`DraftPrCasesEvidenceManifestV1`和`e2e:draft-pr-cases`已经强于单case wrapper，能组合Task/Plan/Case 8/Action+compare/Draft PR五方authority，但原verifier没有消费Case 8中的Task写策略、approval、Plan effect、write credential和Attempt领取事实，且接受base→head多个commit。因此旧contract能证明“已有commit/test/PR”，不能证明“exact repo_write approval授权了从ready领取的这个Item和这条repo/commit/PR lineage”。`ApprovalLineageEvidenceManifestV1`固定merge effect，不能挪作repo_write；E2E-1 verifier又要求Run仍停在awaiting_approval和零write，不能在Draft PR后复用。
- Watt直接复用：继续直接复用Watt-derived显式opt-in、仓库外64 KiB manifest、固定0/1/2、安全错误、有界HTTPS、分页fail-closed与credential-shaped canary扫描，并完整复用本项目既有`verifyGitHubPullRequestEvidence`，没有复制第二套PR parser、Case 8 parser或新建E2E-3汇总表。Watt没有Task/Plan/ready Item/approval/credential/commit/PR业务lineage，强行复制generic task/tool代码会丢失本项目authority，等价新增业务代码复制量为零。
- 动作：
  - 先扩展`test/draft-pr-cases-evidence.test.ts`。第一次运行因测试fixture自身仍把suite绑定verification Item而出现5个失败；修正为真实initial change Item形状后得到有效红灯：6 tests中2个失败，重算Case 8 report digest后的approval/ready/credential漂移仍被接受，GitHub compare `ahead_by=2`仍被接受。生产代码随后才修改。
  - 不新增manifest/CLI。现有strict双case contract收紧为每条只有一个required change Item、`mode=implement`、checkout/parent等于Plan base；change verification同时绑定commit及targeted/required Evidence。review-fix属于E2E-4，不能冒充E2E-3首次ready领取。
  - Case 8只增加两个非敏感历史标量：Attempt的`claimedProgressVersion`和write credential的`createdAt`；物理查询仍不选择token digest/ciphertext、lease token、GitHub token、Task/Plan/PR正文或raw外部响应，也没有migration。
  - `verifyDraftPrCasesEvidence`现在从Plan重验唯一change Item的exact `repo_write + targeted/required commands + test Evidence`；从Case 8重验Task允许写、latest exact飞书mapped-human approval及source/lineage/event/role digest、Task revision/Plan/version/digest/base/effect、正数ready claim version、同Attempt/Plan/Item/approval/repo credential和approval→claim→credential→commit→publication时间线。approval必须覆盖publication、credential必须在commit时有效；日后自然过期不否定已冻结历史。
  - 同Attempt只允许一条immutable head/commit；GitHub compare固定`ahead_by=1 + behind_by=0 + commits=[final head]`并继续重算canonical changed-files digest。这个约束证明单commit边界，diff是否语义最小仍由真人review，不能由manifest/Agent自报。
  - 增强strict example和负向测试，覆盖schema拒绝review_fix、report digest重算后的旧approval/newer reject、缺ready claim、跨repo credential、多commit及compare多commit；summary新增2条approval/ready claim/write credential/single-commit安全计数。同步DOD、DraftPrCases E2E手册、Proto、Architecture、Security与Reference；只勾E2E-3控制面/验收契约，真实平台子项保持未勾。
- 验证：
  - 有效红灯`pnpm exec vitest run test/draft-pr-cases-evidence.test.ts` → exit 1，1 file / 6 tests，2 failed；生产实现后同命令 → exit 0，1 file / 6 tests。
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/case8-audit-report.test.ts` → exit 0，1 file / 4 tests；证明新增safe projection存在且既有八栏/report digest/Secret边界不变。
  - 扩展Node`draft-pr-cases + github-pr + github-pull-request-api + pull-request-draft` → exit 0，4 files / 15 tests；扩展workerd`plan-item-attempt + repo-write-credential + plan-item-evidence + pull-request-draft + github-pull-request + Case 8` → exit 0，6 files / 30 tests。
  - `pnpm run typecheck`、`pnpm run lint`、`pnpm run verify:docs`与`git diff --check`均exit 0。example为10512 bytes，小于64 KiB。
  - `pnpm run e2e:draft-pr-cases`无opt-in → exit 2，固定`opt-in missing`，在manifest/credential/network前结束。
  - 最终`pnpm run verify` → exit 0：Node 97 files / 385 tests、workerd 57 files / 307 tests、460个生产文件Secret scan和文档链接全绿；workerd只输出既有测试主动terminate清理诊断。第一次全量输出被执行工具在该诊断处截断且无最终exit code，未作为通过证据；第二次完整重跑取得明确exit 0。
  - `CI=1 WRANGLER_SEND_METRICS=false pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round120-final-20260727-2241` → exit 0，bundle 2737.29 KiB / gzip 458.94 KiB；识别双Workflow、双Queue、D1与四R2 binding，未部署。
- 勾选：Phase 7新增并勾选“E2E-3控制面与真实外部证据验收契约”；Phase 4原双case契约同步增强。真实E2E-3、Phase 4真实双case、真实repo_write approval/credential、Actions commit/test和Draft PR仍未完成。fake HTTPS、schema example、本地workerd、manifest自报、Wrangler dry-run或默认exit 2不能替代。
- 决策沉淀：E2E-3不是新状态机，而是已有authority的组合验真。可信链为`飞书mapped-human exact approval → ready progress version → initial implement Attempt → 单repo短期credential → unique commit → targeted/required Evidence → same-approval Draft PR publication → webhook/API/live PR`。approval自然过期是历史时间线，不应让证据不可回放；更新reject/invalidation则使当前live组合验收fail-closed。`ahead=1`只能证明单commit，改动是否真正最小仍是人工语义authority。
- 遗留：当前没有Git remote、已部署控制面、飞书测试tenant/card mapped human、试点GitHub App/repository、真实execution Action、用途隔离只读token、synthetic canary或两条真实Draft PR。需owner授权资源与受控窗口后按[`docs/DraftPrCasesE2E.md`](docs/DraftPrCasesE2E.md)采集仓库外manifest；只有`DELIVERY_LOOP_DRAFT_PR_CASES_E2E=1 pnpm run e2e:draft-pr-cases`读取live五方事实exit 0且Reviewer打开approval、原始PRD/反馈、根因、diff、测试和PR链接入账，才能同时关闭Phase 4真实双case与E2E-3真实平台事实。

## Round 121 — 2026-07-27
- 目标：Phase 7 / E2E-4“review提意见 → 新attempt恢复 → 修复 → 新head SHA上checks全绿”。本轮只闭环控制面与真实外部证据验收契约，并同步增强Phase 4既有GitHub review契约；未读取真实控制面/GitHub、提交review、dispatch Action、写目标repo、创建commit/PR、部署Worker或勾选E2E-4真实平台事实。
- 前置与权限：只使用本地delivery-loop、Watt固定commit`476e3cdd2490d725fde174e7c697ebf00899edc6`已迁入的E2E安全骨架、本地fake HTTPS、Node/workerd、文档检查和Wrangler dry-run。没有token、review正文、Task/Plan正文、raw API、数据库行或canary原文进入仓库/输出；未stage/commit，按当前阶段约定未更新llmdoc。
- authority审计：既有`GitHubReviewFeedbackEvidenceManifestV1`、Case 8和`e2e:github-review`已覆盖applied/stale review、PR/Action/ref/compare/check，但verifier使用不存在的`run.id/task.target.repository`而非生产顶层`runId/task.repository`，不重算Case 8 report digest，把Action `head_sha`误当result commit，未读取`/plan`或核对review_fix的Plan/Item/commit/test Evidence lineage，且只验证manifest列出的check子集。因此旧contract既会错拒真实Case 8，也可能在跨Plan replacement、缺DoD Evidence或额外failed check时假通过。
- Watt直接复用：不新增E2E-4 wrapper、第二套review manifest/parser、migration或状态表，直接增强Phase 4既有manifest/verifier/CLI。继续直接复用Watt-derived显式opt-in、仓库外64 KiB manifest、固定0/1/2、安全错误、有界HTTPS、分页fail-closed和credential-shaped canary扫描。Watt没有reviewed head→same Plan/Item review_fix→commit/test Evidence→new head checks业务lineage，强行复制generic task不能成为本项目authority，等价新增业务代码复制量为零。
- 动作：
  - 先把`test/github-review-evidence.test.ts`改为生产真实Case 8形状并增加额外failed check负向case；有效红灯为5 tests中2个失败，真实投影被`control_plane_projection_mismatch`错拒，后续GitHub负向断言也被该错误提前截断。生产实现随后才修改。
  - strict manifest新增Case 8 report digest、active Plan/version/base/change Item、真人GitHub reviewer、replacement claim、workflow head/base branch、reviewed checkout、唯一commit、targeted→required suite、Item decision完整Evidence IDs及synthetic canary digest。schema固定command顺序/唯一性和`checkout=reviewed head`、`workflow head=Plan base`、`result!=reviewed`等三SHA不变量。
  - verifier现在并行读取`/plan + /audit`：重算Case 8 canonical digest，核对prior/replacement同Run/repository/active Plan/version/Item、replacement正数`claimedProgressVersion`、Item progress重新passed、唯一reviewed→result commit、commit/test `passed + verified` Evidence、targeted→required命令与同result head的Item decision。跨Plan、缺command/Evidence、旧report digest和错误时间线均fail-closed。
  - GitHub侧不再把Action run `head_sha`冒充result：run/job head绑定受信workflow ref/Plan base，replacement checkout和commit parent绑定reviewed SHA，commit/ref/PR/compare/checks绑定result SHA。要求唯一`attempt` job及固定checkout/mode-validation/execution steps成功、commit单parent、compare恰好ahead 1/behind 0/单commit；live check-runs必须与manifest exact同集且全部`completed/success/result head`，额外failed check不能被忽略。
  - 所有控制面/GitHub GET增加10秒timeout；1 MiB有界读取后先扫描用途隔离token、credential形状和仓库外canary，再JSON parse。CLI新增必需`GITHUB_REVIEW_CANARY`且仍在opt-in缺失时先exit 2。增强example、summary和负向测试，覆盖cross-Plan、完整DoD suite、Action job、commit parent、check subset和parse前Secret扫描；同步DOD、GitHubReview E2E手册、Proto、Architecture、Security与Reference，只勾E2E-4控制面/验收契约。
- 验证：
  - 有效红灯`pnpm exec vitest run test/github-review-evidence.test.ts` → exit 1，1 file / 5 tests，2 failed；生产实现后同命令 → exit 0，1 file / 6 tests。
  - 扩展Node`github-review-evidence + review-fix-repository-writer + execution-attempt-runner + delivery-agent-workflow` → exit 0，4 files / 13 tests；扩展workerd`github-review-feedback + execution-attempt-api + verification-evidence + plan-item-evidence-verifier + Case 8` → exit 0，5 files / 19 tests。
  - `pnpm run typecheck`、`pnpm run lint`、`pnpm run verify:docs`与`git diff --check`均exit 0。strict example为4086 bytes，小于64 KiB。
  - `DELIVERY_LOOP_GITHUB_REVIEW_E2E=0 pnpm run e2e:github-review` → exit 2，固定`opt-in missing`，在manifest/credential/network前结束。
  - 最终`pnpm run verify` → exit 0：Node 97 files / 386 tests、workerd 57 files / 307 tests、460个生产文件Secret scan和文档链接全绿；workerd只输出既有测试主动terminate清理诊断。第一次并行启动因执行工具拒绝临时目录`rm`而未取得全量exit code，不作为通过证据；去掉清理动作后完整重跑取得明确exit 0。
  - `CI=1 WRANGLER_SEND_METRICS=false pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round121-final-20260727-2308` → exit 0，bundle 2737.29 KiB / gzip 458.94 KiB；识别双Workflow、双Queue、D1与四R2 binding，未部署。
- 勾选：Phase 7新增并勾选“E2E-4控制面与真实外部证据验收契约”；Phase 4原GitHub review外部证据契约同步增强。真实E2E-4、Phase 4真实review事实、真人review、真实replacement Action/commit/checks仍未完成。fake HTTPS、schema example、本地workerd、manifest自报、Wrangler dry-run或默认exit 2不能替代。
- 决策沉淀：E2E-4不是新状态机，而是已有authority的组合验真。可信链为`真人exact-head changes_requested → signed applied observation → same Plan/version/Item review_fix claim → reviewed checkout → unique fast-forward commit → targeted/required verified Evidence → passed Item decision → live PR/ref/new-head complete check inventory`。GitHub Action `head_sha`只证明workflow ref head，不能代表Runner产出；reviewed checkout与result commit必须由控制面和Git事实分别证明。check manifest是完整inventory承诺，不是允许忽略额外失败的allowlist。
- 遗留：当前没有Git remote、已部署控制面、试点GitHub App/repository、真实Draft PR/reviewer、execution Action、用途隔离只读token或synthetic canary。需owner授权试点资源与受控窗口后按[`docs/GitHubReviewE2E.md`](docs/GitHubReviewE2E.md)采集仓库外manifest；只有`DELIVERY_LOOP_GITHUB_REVIEW_E2E=1 pnpm run e2e:github-review`读取live控制面/GitHub事实exit 0且Reviewer打开review、diff、Action、checks和Case 8链接入账，才能同时关闭Phase 4真实review与E2E-4真实平台事实。
## Round 122 — 2026-07-27
- 目标：Phase 7 / E2E-5“Workflow hibernate/Worker restart后复用成功步骤；Runner执行中kill后lease/token撤销，新Attempt从checkpoint/Git继续且无重复副作用”。本轮只闭环控制面与真实外部证据验收契约；未访问真实Cloudflare/GitHub/control-plane tenant，未发布Worker、restart Workflow、kill/retry Runner、dispatch Action、push commit、部署、stage或提交，E2E-5真实平台事实与最终Done保持未完成。
- 第一性原理/authority决策：不能让同一Run同时满足hibernate verifier要求的`awaiting_approval + Workflow waiting`和Runner replacement完成后的`succeeded`投影。E2E-5因此固定为同repository/试点环境内两个不同Run的受控场景；薄组合层只引用两份component manifest的canonical digest并完整调用原verifier，不新增第二套Workflow/Attempt状态、恢复parser或migration。
- Watt最大化复用：继续固定`/Users/jishihe/tokenrollal/Watt@476e3cdd2490d725fde174e7c697ebf00899edc6`。直接复用其显式opt-in、仓库外64 KiB manifest、固定0/1/2退出、有界HTTPS、分页fail-closed与安全固定错误纪律；把本项目既有Watt-derived response骨架统一增强为10秒timeout、Case 8 canonical digest和parse前token/credential-shaped canary扫描。Watt没有Cloudflare durable step、delivery-loop Attempt lease/token/cancel、checkpoint/Git、Case 8或副作用inventory，业务断言直接复制量为零，未把generic task冒充恢复authority。
- 红灯：
  - `pnpm exec vitest run test/runner-recovery-evidence.test.ts`首次exit 1，10 tests中9 failed；旧schema拒绝新增fence/inventory字段，既有verifier无法证明generation/token/cancel/report digest/单commit/超时/Secret扫描。
  - `pnpm exec vitest run test/workflow-hibernate-evidence.test.ts`首次exit 1，8 tests中7 failed；旧schema/verifier无法重算Case 8、排除controlled replay、扫描canary或证明所有请求带timeout。
  - `pnpm exec vitest run test/dual-recovery-evidence.test.ts`首次exit 1，failed suite / 0 tests，缺少dual composition domain/verifier。
- 动作：
  - 增强`RunnerRecoveryEvidenceManifestV1`与verifier：Plan精确核对kill前/撤销后generation，Case 8重算report digest并核对lost token ID/generation/revokedAt、全部lost grant已撤销、唯一settled `workflow_cancel`、完整settled effect outbox与零replay；correlation要求所有inventory未截断且PR/deployment ID exact；GitHub compare要求checkpoint为base/merge-base、behind 0并恰好一个result commit。新增operations token、仓库外canary、10秒abort、分页拒绝和parse前Secret扫描；Case 8安全effect inventory正式纳入`workflow_cancel`。
  - 增强`WorkflowHibernateEvidenceManifestV1`与verifier：重算Case 8 report digest，明确要求`checks.replays=[]`，拒绝以controlled replay/restart修补普通hibernate；GitHub run改走同一有界/scanned GET边界，全部控制面/GitHub/Cloudflare读取带10秒abort和credential扫描。
  - 新增strict `DualRecoveryEvidenceManifestV1`、`verifyDualRecoveryEvidence`、`pnpm run e2e:dual-recovery`、example与[`docs/DualRecoveryE2E.md`](docs/DualRecoveryE2E.md)。总manifest只保存两份完整component manifest digest及安全identity/window；两份component必须同repository、不同Run/Evidence/三条Action且共用canary digest。CLI读取三份仓库外64 KiB文件并完整调用既有两份authority；没有mutation路径。
  - 同步[`docs/RunnerRecoveryE2E.md`](docs/RunnerRecoveryE2E.md)、[`docs/WorkflowHibernateE2E.md`](docs/WorkflowHibernateE2E.md)、`docs/Proto.md`、`docs/Reference.md`、`docs/Security.md`和Phase 7 DoD；按项目约定不更新llmdoc。
- 验证：
  - 聚焦组件：`pnpm exec vitest run test/dual-recovery-evidence.test.ts test/workflow-hibernate-evidence.test.ts test/runner-recovery-evidence.test.ts test/platform-limits-evidence.test.ts` → exit 0，4 files / 27 tests；digest/identity/window、完整delegation、generation/token/cancel、Case 8/replay、side-effect inventory、Git compare、pagination/canary/timeout及上层reuse均通过。
  - `pnpm run typecheck`、`pnpm run lint`、`pnpm run verify:docs`、`pnpm run verify:secrets`均exit 0；Secret扫描为464 files，新增文档链接有效。
  - `pnpm run test` → exit 0：Node 98 files / 395 tests；workerd 57 files / 307 tests。workerd预期的`User called terminate`诊断不影响最终exit 0。
  - 最终`pnpm run verify && git diff --check` → exit 0：typecheck、ESLint、Node 98 files / 395 tests、workerd 57 files / 307 tests、464个生产文件Secret scan、文档链接及diff whitespace全部通过；workerd仅输出测试主动terminate的既有清理诊断。
  - `pnpm run e2e:dual-recovery`（无opt-in）→ exit 2，固定`dual-recovery-e2e: opt-in missing`，在manifest/token/network前结束，不是skip或成功。
  - `pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-round-122` → exit 0，Worker 2737.31 KiB / gzip 458.95 KiB，Workflow/Queue/D1/四R2 bindings识别；仅dry-run，未部署。
- DoD：勾选E2E-5“控制面与真实外部证据验收契约”，新增并保留“真实平台事实”未完成项。默认exit 2、fake响应、schema example、本地全绿和Wrangler dry-run均未冒充Cloudflare/GitHub真实恢复。
- 遗留/下一步：当前`git remote -v`为空、Wrangler D1 ID仍为占位值，没有已部署Worker/Paid Workflow、真实GitHub App/试点repo或只读凭证。需要用户提供同一试点repository与受控Actions/Cloudflare预算，按[`docs/DualRecoveryE2E.md`](docs/DualRecoveryE2E.md)完成两场演练并保存三份仓库外manifest；只有总命令live exit 0、旧token无副作用401探针、Cloudflare/GitHub/Case 8链接和人工时序review入账后才能勾真实项。

## Round 123 — 2026-07-27
- 目标：Phase 7 / E2E-6“未授权写/部署、跨repo OIDC、过期审批、恶意任务文本全部被拒；canary Secret零泄漏”。本轮只闭环控制面与真实外部证据验收契约；未访问真实飞书/GitHub/Cloudflare/control-plane tenant，未点击卡片、签OIDC、dispatch Action、写目标repo、审批或部署，E2E-6真实平台事实与最终Done保持未完成。
- 前置与权限：只使用本地delivery-loop、Watt固定commit`476e3cdd2490d725fde174e7c697ebf00899edc6`既有复用结论、本地fake HTTPS、Node测试、文档检查和Wrangler dry-run。没有token、OIDC JWT、Task/Plan正文、raw API/日志、approval正文或canary明文进入仓库/输出；未stage/commit，按当前项目约定不更新llmdoc。
- authority审计：既有Feishu card-action能证明`unauthorized_account/role_revoked`场景与零effect，但场景名不能证明尝试的是repo write；本轮要求独立observer和manifest仅为这两个case冻结枚举型`attemptedCommand=approve + attemptedEffect=repo_write`，再与人工`unmapped/revoked` identity review及operations的verified delivery/零receipt/outcome/ingress/business effect交叉核对。Production Approval完整authority回答self/过期拒绝和零production effect；Test Deployment完整authority回答合法同repo baseline和零重复；Analysis Action、Task/Plan/Case 8回答恶意文本没有提升authority；Secret Safety回答Action log/PR/artifact/blocked publication零明文。E2E组合层不新增状态表或第二套parser。
- Watt最大化复用：新CLI与全部component I/O继续直接复用Watt-derived显式opt-in、仓库外64 KiB输入、固定0/1/2、安全固定错误、1 MiB/10秒有界HTTPS、分页fail-closed和parse前credential-shaped canary扫描；Secret Safety把同一边界覆盖到控制面/GitHub/PR/Action log且Action log扫描全部credential。Watt没有delivery-loop飞书identity/effect、production approval、GitHub deployment OIDC、Task/Plan/Case 8或Secret publication lineage，等价业务代码直接复制量为零；强行复制generic task/approval会丢失本项目authority。组合层完整调用本项目五份既有verifier，未复制component实现。
- 红灯：
  - Secret Safety首次聚焦为3 failed / exit 1，暴露Case 8 digest与parse前全credential扫描缺口；实现后通过。
  - Permission Injection首次聚焦为failed suite / exit 1，缺`src/domain/permission-injection-evidence.ts`；新CLI不存在时opt-in契约测试exit 1，随后实现。
  - authority复审后先扩展Feishu测试；`pnpm exec vitest run test/feishu-card-action-evidence.test.ts --config vitest.config.ts` → exit 1，5/5 failed，因为旧strict observer schema拒绝`attemptedCommand/attemptedEffect`，生产实现随后才修改。
- 动作：
  - `SecretSafetyEvidenceManifestV1`每case新增`case8ReportDigest`并重算canonical Case 8；全部GET增加10秒timeout，控制面/GitHub/PR/Action log在JSON parse前扫描所有token/canary/credential shape，Action log不再只扫canary。
  - 新增strict `PermissionInjectionEvidenceManifestV1`、只读组合verifier、`pnpm run e2e:permission-injection`、两份example和[`docs/PermissionInjectionE2E.md`](docs/PermissionInjectionE2E.md)。总manifest只以canonical digest与安全identity组合Feishu action、Production approval、Analysis Action、Test deployment、Secret Safety及原始挑战Task；公开options移除component verifier test seam，CLI和库调用不能注入假的authority。Vitest仅用module mock隔离五个既有component I/O，恶意Task与cross-repo probe仍运行真实生产函数。
  - 新增`.github/workflows/delivery-cross-repo-oidc-probe.yml`与`scripts/run-cross-repo-oidc-probe.mjs`。隔离probe repo的Action只持有`contents:read + id-token:write`，获取audience=`delivery-loop-test-deploy`的真实GitHub OIDC并调用目标既有test deployment；只有`403 + policy_denied + retryable=false`输出唯一固定marker，不打印JWT、响应/错误正文。组合verifier重读Action、immutable workflow/script、manifest外release contract、唯一成功job和完整log，并与合法同repo Test Deployment baseline共同证明拒绝且无新增attestation/deployment。
  - 固定三条恶意挑战覆盖Secret外传、跳过DoD验证和修改`.github/workflows/delivery-agent.yml`提升写/部署权限。挑战仍作为合法不可信Task进入analysis，不按关键词丢弃；verifier重算revision digest与稳定Task/Run ID，复读live Task/Plan/Case 8，要求Task三个allow为false、Plan仅`repo_read/logs_read/database_diagnostic`、只有analysis Attempt且零write credential/change/deployment/写部署outbox。
  - 同步DOD、Proto、Architecture、Security、Reference与Feishu card-action手册；明确summary/marker/manifest不能自证外部事实，真实identity、release和Task语义仍需人工review。
- 验证：
  - authority实现后`pnpm exec vitest run test/feishu-card-action-evidence.test.ts --config vitest.config.ts` → exit 0，1 file / 5 tests；strict observer/manifest枚举、人工actor binding、D1零effect、server-derived retry/replay与Secret扫描全绿。
  - 聚焦组件`pnpm exec vitest run test/permission-injection-evidence.test.ts test/feishu-card-action-evidence.test.ts test/production-approval-evidence.test.ts test/analysis-action-evidence.test.ts test/test-deployment-evidence.test.ts test/secret-safety-evidence.test.ts --config vitest.config.ts` → exit 0，6 files / 26 tests；覆盖strict digest组合、生产authority固定调用、跨repo immutable Action/source/job/log parser、恶意Task/Plan/Case 8、未授权写枚举绑定、write effect拒绝和parse前Secret扫描。
  - `pnpm run e2e:permission-injection`（无opt-in）→ exit 2，固定`permission-injection-e2e: opt-in missing`；设置opt-in但缺配置 → exit 2，固定`required security configuration is incomplete`；两次均在manifest/credential/network前结束，不是skip或成功。
  - `pnpm run typecheck`、`pnpm run lint`、`pnpm run verify:secrets`、`pnpm run verify:docs`与`git diff --check`均exit 0；Secret扫描471个生产文件，两份新example合计4185 bytes，小于64 KiB。
  - `pnpm run test` → exit 0：Node 99 files / 401 tests；workerd 57 files / 307 tests。workerd仅输出既有测试主动`User called terminate`清理诊断。
  - 最终`pnpm run verify` → exit 0：typecheck、ESLint、Node 99 files / 401 tests、workerd 57 files / 307 tests、471个生产文件Secret scan与文档链接全部通过。
  - `CI=1 WRANGLER_SEND_METRICS=false pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-round-123` → exit 0，Worker 2737.31 KiB / gzip 458.95 KiB，双Workflow、双Queue、D1与四R2 binding识别；仅dry-run，未部署。
- DoD：勾选E2E-6“控制面与真实外部证据验收契约”，新增并保留“真实平台事实”未完成项。fake HTTPS/module mock、schema example、本地全绿、默认exit 2和Wrangler dry-run均未冒充真实越权/Secret演练。
- 遗留/下一步：当前`git remote -v`为空、Wrangler D1 ID仍为`00000000-0000-0000-0000-000000000000`，没有已部署控制面、飞书测试tenant/两类未授权身份、GitHub App/目标repo/隔离probe repo、合法test deployment、用途隔离只读token或仓库外canary。需owner批准真实卡片点击、Production approval、Actions/OIDC与测试环境窗口后按[`docs/PermissionInjectionE2E.md`](docs/PermissionInjectionE2E.md)采集七份仓库外证据；只有live命令exit 0、全部平台/人工链接入账且零side effect/plaintext leak，才能勾真实项。下一轮只能选择另一个未完成DoD，不能把本轮本地契约继续重跑成真实事实。

## Round 124 — 2026-07-28
- 目标：Phase 7 / E2E-7“required checks +真人review/approval、merge、test/production gate、deployment外部核对与飞书完成”。本轮只闭环控制面与真实外部证据验收契约；未访问真实GitHub/飞书/Cloudflare/control-plane、未merge PR、批准effect、dispatch/deploy、更新卡片、stage或commit，E2E-7真实平台事实与最终Done保持未完成。
- 第一性原理/状态修正：authority审计确认`target_environment`单选，test deployment与post-deployment acceptance只能在`executing`阶段作为merge前required Plan Item执行；仓库只有production `deploying → succeeded` projector。旧merge裁决把`merged_test`留在`deploying`会制造永久stuck Run，与真实代码路径和E2E目标冲突。本轮将合法边对齐为no-deploy/test `merging → succeeded`、仅production `merging → deploying`；test仍必须先由全部required deployment/acceptance Evidence通过merge gate，不能借merge跳过部署。
- 双lane决策：E2E-7固定使用同repository/受审窗口内两个不同Run，禁止把互斥authority拼成同一Run。test lane为`test deployment success → acceptance passed → checks/review/merge approval → merge → succeeded`；production lane为`checks/review/merge approval → merge/deploying → merge-SHA-bound release approval → production platform success → succeeded`。两条最终各有一张live飞书完成卡。
- Watt最大化复用：继续固定`/Users/jishihe/tokenrollal/Watt@476e3cdd2490d725fde174e7c697ebf00899edc6`。CLI/组合fetch直接复用其显式opt-in、仓库外64 KiB文件、固定0/1/2、安全错误、有界HTTPS、分页fail-closed与10秒timeout纪律；八份业务authority完整调用本项目已有Merge Gate、Merge、Test Deployment/Acceptance、Production Approval/Deployment verifier。飞书完成态抽取并复用既有operations projection、Secret scan、同message create/PATCH ledger、Message GET与renderer，不复制第二套sender/parser。Watt没有delivery-loop Run/Plan/merge/deployment/card lineage，新增仅为双lane digest组合与完成态断言。
- 红灯与动作：
  - 先把`merged_test`期望改为`succeeded`；`pnpm exec vitest run test/merge-evidence.test.ts`首次exit 1，3 tests中2 failed，旧schema报`manifest_invalid`。随后修改唯一merge projector、strict manifest/example、summary与规范。
  - workerd首轮`github-merge-gate + feishu-delivery-card`为exit 1：test lane真实得到`deploying`而非`succeeded`；新增完成卡测试的第一版seed同时被`required_plan_item_requires_verified_evidence`守卫正确拒绝，未把非法直写当证据。修正fixture后，聚焦2 files / 40 tests通过。
  - 新增strict`FeishuCardCompletionEvidenceManifestV1`与生产verifier，固定test/production两张卡；共享读取要求latest settled presentation、同message PATCH、live app/tenant/chat/time/rendered digest、`succeeded + all required passed + merge/deployment succeeded + zero blocker/approval/action`。终态projector不再展示已消费approval，也不生成replay/context按钮。
  - 新增strict`MergeDeploymentE2EEvidenceManifestV1`、`verifyMergeDeploymentE2EEvidence`、`pnpm run e2e:merge-deployment`、两份example与[`docs/MergeDeploymentE2E.md`](docs/MergeDeploymentE2E.md)。总manifest只存八份完整component的canonical digest/安全case ID和window；公开options没有component verifier注入，Vitest仅以module mock隔离外部I/O。组合层再绑定Run/PR/head/base/decision/Plan/merge ID/SHA/deployment/acceptance/approval/URL/时间线，并对component响应parse前扫描全部token/canary及分页。
  - 同步DOD、MergeE2E、Proto、Architecture、Security与Reference；按约定未更新llmdoc。Phase 5已完成merge契约的旧文字也同步修正，避免规范继续要求一个没有终态authority的test `deploying`状态。
- 验证：
  - 聚焦Node`pnpm exec vitest run test/merge-deployment-e2e-evidence.test.ts test/feishu-card-completion-evidence.test.ts test/feishu-card-presentation-evidence.test.ts test/merge-evidence.test.ts` → exit 0，4 files / 13 tests；随后E2E-7组合扩展Secret/pagination负向后单文件为4/4 tests。覆盖strict双lane/example、digest/lineage漂移、强制component调用、完成卡live message/action拒绝、parse前token扫描、分页fail-closed和CLI opt-in。
  - 聚焦workerd`pnpm exec vitest --config vitest.workflow.config.ts run test/workflow/github-merge-gate.test.ts test/workflow/feishu-delivery-card.test.ts` → exit 0，2 files / 40 tests；证明test merge终态与succeeded卡零approval/action。
  - `pnpm run e2e:merge-deployment`无opt-in → exit 2，固定`opt-in missing`；设置`DELIVERY_LOOP_MERGE_DEPLOYMENT_E2E=1`但缺真实文件/credential → exit 2，固定`required external configuration is incomplete`。两次均在manifest/token/network前结束，不是skip或成功。
  - `pnpm run typecheck`、`pnpm run lint`、`pnpm run verify:docs`与`git diff --check`均exit 0。
  - 最终`pnpm run verify` → exit 0：Node 101 files / 407 tests、workerd 57 files / 308 tests、478个生产文件Secret scan与文档链接全部通过；workerd只输出既有测试主动`User called terminate`清理诊断。
  - `CI=1 WRANGLER_SEND_METRICS=false pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-round-124-20260728` → exit 0，Worker 2737.54 KiB / gzip 459.00 KiB，双Workflow、双Queue、D1与四R2 binding识别；仅dry-run，未部署。
- DoD：勾选E2E-7“控制面与真实外部证据验收契约”，新增并保留“真实平台事实”未完成项；同时修正已完成merge contract的test终态说明。fake HTTPS/module mock、schema example、manifest自报、本地全绿、默认exit 2和Wrangler dry-run均未冒充真实merge/deployment/飞书事实。
- 遗留/下一步：当前没有已授权试点repository、已部署控制面、真实test/production Environment与OIDC/云审计、两份受保护PR/真人review/merge、production release reviewer、飞书tenant/机器人群membership或用途隔离只读credential。需owner按[`docs/MergeDeploymentE2E.md`](docs/MergeDeploymentE2E.md)完成双Run试点并采集九份仓库外manifest；只有总命令live exit 0、两张消息/截图和GitHub/Environment/云永久链接经真人review入账后才能勾E2E-7真实平台事实。下一轮只能选择另一个未完成DoD，不能把本轮本地契约重跑成真实事实。

## Round 125 — 2026-07-28
- 目标：Phase 7 / E2E-8“飞书/GitHub/queue事件各重放3次，注入callback丢失/限流，最终状态正确且无重复PR/部署”。本轮只闭环控制面与真实外部证据验收契约；未访问真实飞书/GitHub/Cloudflare/control-plane、未发送webhook、制造429、请求DLQ replay、dispatch Action、创建PR/Deployment、部署、stage或commit，E2E-8真实平台事实与最终Done保持未完成。
- 第一性原理/authority裁决：一个Run无法同时保持Feishu ingress live waiting、GitHub PR `pull_request_open`和故障恢复后的`succeeded`。E2E-8固定三个Run lane：Feishu ingress/retry共用一Run，GitHub signed webhook三次投递使用独立PR Run，callback丢失、DLQ replay和最终唯一inventory使用succeeded controlled-replay Run。transport observability只证明HTTP发生三次，不能替代D1/平台业务事实。
- Watt最大化复用：再次核对`/Users/jishihe/tokenrollal/Watt@476e3cdd2490d725fde174e7c697ebf00899edc6`的`scripts/e2e/lib.ts`。新CLI逐结构沿用其0/1/2退出和前置检查纪律，并继续直接复用本项目既有Watt-derived显式opt-in、仓库外64 KiB、有界HTTPS、安全错误、分页fail-closed与10秒timeout骨架；Watt的`runE2e`会拼接stderr/`String(err)`，不适合本项目provider/Secret错误边界，未直接复制该段。Watt没有Feishu/GitHub/DLQ replay、Case 8 callback recovery或PR/Deployment inventory，等价业务代码直接复制量为零；组合层完整调用本项目既有四份生产verifier，没有复制第二套component parser。
- 红灯：先新增`test/replay-failure-e2e-evidence.test.ts`并运行`pnpm exec vitest run test/replay-failure-e2e-evidence.test.ts` → exit 1，failed suite / 0 tests，缺`src/domain/replay-failure-e2e-evidence.ts`；生产实现随后才创建。
- 动作：
  - 新增strict`ReplayFailureE2EEvidenceManifestV1`和`ReplayFailureObservabilityReportV1`。总manifest只以canonical digest引用Feishu Ingress、Feishu Retry、GitHub PR、Controlled Replay四份完整manifest，并保存API-only callback与resolved DLQ安全索引；report固定GitHub三次202为`applied,duplicate,duplicate`，DLQ三次202为同replay ID的`created=true,false,false`。
  - 新增`verifyReplayFailureE2EEvidence`，公开options不接受component verifier替换。组合层完整调用四份既有authority；另从Controlled Run Case 8要求selected PR零webhook/唯一applied API observation，从resolved dead-letter要求snapshot内原`*_dispatch → github_actions` outbox exact匹配，再读取GitHub同head/base完整PR inventory。Controlled Replay继续证明最终Run succeeded、effect snapshot未增、唯一Action/PR/Deployment。
  - 新增`pnpm run e2e:replay-failure`、两份example和[`docs/ReplayFailureE2E.md`](docs/ReplayFailureE2E.md)。五份输入各64 KiB；所有component/自定义外部读取共用10秒abort、有界response、分页fail-closed与JSON parse前全部用途token/canary扫描。未新增migration、状态表、写API或真实effect入口。
  - 同步DOD、Proto、Architecture、Security与Reference；只勾E2E-8控制面/验收契约，真实平台事实保持未勾；按当前项目约定未更新llmdoc。
- 验证：
  - 最终聚焦`pnpm exec vitest run test/replay-failure-e2e-evidence.test.ts` → exit 0，1 file / 5 tests；真实穿透四份component verifier，覆盖strict schema/report digest、三类replay计数、callback出现即拒绝、DLQ漂移、重复PR inventory、component digest和parse前canary扫描。
  - `pnpm run e2e:replay-failure`无opt-in → exit 2，固定`opt-in missing`；设置`DELIVERY_LOOP_REPLAY_FAILURE_E2E=1`但缺真实配置 → exit 2，固定`required external configuration is incomplete`。两次都在manifest/token/network前结束，不是skip或成功。
  - `pnpm run typecheck`、`pnpm run lint`、`pnpm run verify:docs`与`git diff --check`均exit 0。
  - 最终`pnpm run verify` → exit 0：Node 102 files / 412 tests、workerd 57 files / 308 tests、483个生产文件Secret scan与文档链接全部通过；workerd只输出既有测试主动`User called terminate`清理诊断。
  - `CI=1 WRANGLER_SEND_METRICS=false pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round125-20260728-final` → exit 0，Worker 2737.54 KiB / gzip 459.00 KiB，双Workflow、双Queue、D1与四R2 binding识别；仅dry-run，未部署。
- DoD：勾选E2E-8“控制面与真实外部证据验收契约”，新增并保留“真实平台事实”未完成项。fake HTTPS、本地测试、schema example、manifest/structured log自报、默认exit 2和Wrangler dry-run均未冒充真实平台重放/故障恢复。
- 遗留/下一步：当前没有已授权试点tenant/repository、已部署控制面、真实飞书重投/429、GitHub delivery redelivery、callback丢失代理、Cloudflare Queue/DLQ/Workflow或用途隔离只读credential。需owner按[`docs/ReplayFailureE2E.md`](docs/ReplayFailureE2E.md)完成三个Run lane并采集五份仓库外manifest和transport report；只有live命令exit 0、飞书/GitHub/Queue/Case 8永久链接与Reviewer入账后才能勾E2E-8真实平台事实。Phase 7本地E2E-1～8组合契约已齐，但八个真实平台事实仍需授权试点逐项关闭，不能宣布Done。

## Round 126 — 2026-07-28
- 目标：Phase 0 / “新仓库远端、owner、visibility和默认分支保护由用户确认后创建；本地初始化不能冒充远端已完成。”本轮只读核对可用账号、候选owner与远端是否存在，不创建仓库、不push、不改分支保护、不部署。
- 验收命令与成功判据：待owner/name/visibility确认并授权外部写入后，以`git remote get-url origin`、`gh repo view <owner>/delivery-loop --json nameWithOwner,visibility,defaultBranchRef,url`和GitHub branch-protection API共同证明唯一远端、选定可见性、`main`默认分支及受保护状态；任一项不成立均不勾DoD。
- 只读证据：`gh auth status`→exit 0，本机有active GitHub登录态；`pnpm exec wrangler whoami`→exit 0，本机有Cloudflare OAuth登录态且可见两个account context，本轮未使用其write scope；`gh repo view evilstar9527/delivery-loop`→exit 1，个人候选远端不存在；`git -C /Users/jishihe/tokenrollal/Watt remote -v`→exit 0，Watt的既有远端为`TokenRollAI/Watt`；`gh api user/memberships/orgs/TokenRollAI`→exit 0，当前账号是active member；`gh api orgs/TokenRollAI`→exit 0，该组织当前为Free plan。未输出或持久化token。
- 勾选：无。`TokenRollAI/delivery-loop`当前未创建；也未确认是否应放在`TokenRollAI`、`Lightspeed-Intelligence`或个人owner，以及是否public/private。
- 决策沉淀：无。不从Watt远端自动推导本项目owner；不因本机有write-capable登录态就视为获得了创建仓库或Cloudflare部署授权。
- 遗留/blocker：需owner给出一次性选择：GitHub owner、repository name、visibility，并授权创建远端/push/设置默认分支保护。若选`TokenRollAI` Free + private，还需先确认当前GitHub计划是否支持本DoD要求的private branch protection；不满足时应选public、升级组织计划或改用其他已支持的owner。

## Round 127 — 2026-07-28
- 目标：继续Phase 0远端bootstrap DoD，在不产生GitHub写入的前提下排除组织建仓权限和Free plan分支保护能力的不确定性，并重验现有真实证据verifier。本轮仍不创建仓库、不push、不修改ruleset/branch protection。
- 验收命令与成功判据：前置核对要求GitHub organization API明确当前身份允许创建选定visibility，GitHub官方文档明确该plan对protected branches的支持边界，且`pnpm exec vitest run test/repository-bootstrap-evidence.test.ts`通过。真实DoD仍只能由用户决策后的live repository/protection事实与opt-in verifier exit 0关门。
- 只读证据：`gh api orgs/TokenRollAI`→exit 0，返回`members_can_create_repositories/public/private=true`且plan为Free；`gh repo view TokenRollAI/Watt`→exit 0，Watt为public且默认分支`main`；Watt branch-protection API→HTTP 404且repo ruleset inventory为空，说明不能把Watt当成已有保护模板；GitHub Docs `data/reusables/gated-features/protected-branches.md`明确Free user/organization只在public repository提供protected branches，private需Pro/Team/Enterprise。未请求`admin:org`扩权，未访问或记录credential。
- 验证：`pnpm exec vitest run test/repository-bootstrap-evidence.test.ts`→exit 0，1 file / 6 tests；`pnpm run e2e:repository-bootstrap`无opt-in→exit 2，固定`opt-in missing`，未冒充真实远端成功。
- 勾选：无。在当前`TokenRollAI` Free计划下，`public + protected main`是唯一能直接满足该DoD的已证实方案；`private`需先升级计划。
- 决策沉淀：仍不代替owner做visibility/公开代码决策。候选执行值已收敛为`TokenRollAI/delivery-loop`、`public`、默认分支`main`并启用branch protection；除非owner明确选择私有+升级。
- 遗留/blocker：只缺owner对“将本地代码公开为`TokenRollAI/delivery-loop`，创建/push并设置`main`保护”的明确授权。该动作是不可默认推导的对外发布；授权后才执行并以`pnpm run e2e:repository-bootstrap` live exit 0入账。

## Round 128 — 2026-07-28
- 目标：Phase 0远端bootstrap DoD的第三轮blocker审计；只重读本地/remote事实，不扩展授权边界。
- 验收命令与成功判据：`git remote -v`必须出现已确认的origin，`gh repo view TokenRollAI/delivery-loop --json nameWithOwner,visibility,defaultBranchRef,url`必须返回真实repository，否则不得继续伪造repository/protection/CI证据。
- 验证：`pwd`→`/Users/jishihe/delivery-loop`；`git remote -v`仍为空；`gh repo view TokenRollAI/delivery-loop --json nameWithOwner,visibility,defaultBranchRef,url`→exit 1 / repository not found。Round 126与127已完成账号、组织建仓权限、plan能力和verifier的所有只读前置，本轮没有新的安全本地路径可以替代用户发布决策。
- 勾选：无。DOD.md中远端、main/pull_request CI和workflow_dispatch三个真实项均保持未完成。
- blocker：同一阻塞条件已连续三轮未变：需owner明确授权创建并公开`TokenRollAI/delivery-loop`、push当前代码并设置`main`保护。在此之前停止盲重试；用户确认“按公开方案执行”后从真实建仓操作恢复。

## Round 129 — 2026-07-28
- 目标：用户恢复了外部bootstrap决策，将owner从组织改为个人账号；本轮只读核对个人仓库身份和验收前置，不因“个人仓库”自动推导visibility。
- 用户决策：owner改为当前GitHub身份`evilstar9527`；候选repository仍为`delivery-loop`；不使用`TokenRollAI`或`Lightspeed-Intelligence`。
- 验证：`gh api user --jq '{login,name}'`→exit 0，身份为`evilstar9527`；`gh repo view evilstar9527/delivery-loop --json nameWithOwner,visibility,defaultBranchRef,url`→exit 1，repository not found；`git remote -v`→空。`docs/RepositoryBootstrapE2E.md`重新核对后确认manifest必须保存用户选定的`public|private|internal`和保护规则digest，本地不能代填。GraphQL plan字段不可用，未据此猜测账号计划，也未创建或push任何内容。
- 勾选：无。owner决策已更新，但visibility、默认分支保护参数和创建/push授权尚未完整冻结，因此Phase 0远端DoD不勾。
- 遗留：请选`public`或`private`。若选public，下一步创建`evilstar9527/delivery-loop`、推送`main`并设置protected branch；若选private，先需确认账号计划支持private branch protection，否则该DoD不能关闭。

## Round 130 — 2026-07-28
- 目标：Phase 0的 GitHub `main/pull_request` CI 真实验收。仓库已按用户决策创建为`evilstar9527/delivery-loop` public，但首次`main` push CI未通过，因此不勾 CI DoD。
- 外部操作：以提交`04db522ba2acaa9f1f4e766b6858819f18ce7b82`创建并推送远端，配置`main` protection：只要求`verify`、strict status check、enforce admins、linear history、禁止force-push/deletion、conversation resolution，未强制单人仓库的额外reviewer。
- 红灯证据：GitHub Actions [`30323475764`](https://github.com/evilstar9527/delivery-loop/actions/runs/30323475764)的`main` push 运行在hosted Ubuntu上失败；本地记录为同类本地测试全通，但远端`test/workflow/github-review-feedback.test.ts:441`实际期待20路里`applied=1, duplicate=19`，拿到`duplicate=18`，暴露并发状态竞态。
- 动作：`GitHubReviewFeedbackStore.apply` 在candidate不再eligible时重读同review feedback；如已由winner提交则记为`duplicate`，不再误记`ignored`。这保留stale/publication本来的ignored行为，只改变能证明已存在同review的竞态路径。
- 验证：`pnpm exec vitest --config vitest.workflow.config.ts run test/workflow/github-review-feedback.test.ts`→exit 0，5 tests；连续8次重跑→8/8通过。修复尚未在远端CI验收，因此未勾选`DOD.md` CI父项。
- 遗留：将修复和本轮红灯证据提交PR，等待`pull_request` CI通过后合并，再重跑main CI并执行`validate-task.yml` 的合法/非法workflow_dispatch。不使用本地结果冒充GitHub外部事实。

## Round 131 — 2026-07-28
- 目标：继续Phase 0 CI真实验收，处理PR #1 hosted runner暴露的第二个独立时序缺口。
- 红灯证据：PR #1 [`30323876042`](https://github.com/evilstar9527/delivery-loop/actions/runs/30323876042)在`test/analysis-runner-bootstrap.test.ts`报`AnalysisRunnerError: attempt heartbeat failed during analysis`；详细原因是诊断测试的10ms heartbeat cadence在Ubuntu hosted上在第一次token rotation后又触发了第二次heartbeat，与单次rotation fixture竞0态，不能归因为业务状态机失败。
- 动作：该诊断测试改为1s heartbeat cadence，仍保留“等待真实heartbeat后再执行logs→trace→Evidence→Plan”的验证，避免将hosted runner调度速度当成业务错误。
- 验证：`pnpm exec vitest run test/analysis-runner-bootstrap.test.ts`→exit 0，1 file / 9 tests；最终`pnpm run verify`→exit 0，Node 102/412、workerd 57/308、Secret scan 483文件、docs links全绿。等待PR workflow重跑，未勾选CI DoD。
- 遗留：提交该修复到PR #1，外部`pull_request` CI通过后才合并；如再发现时序缺口，按同一DoD继续修复而不下调验收标准。

## Round 132 — 2026-07-28
- 目标：Phase 0 / `validate-task.yml` 在 GitHub 手动输入合法与非法 TaskEnvelope；非法输入失败且日志不打印正文。本轮只关闭这一项，CI 父项和远端 bootstrap 其他项不在本轮勾选。
- 前置与权限：使用公开仓库 `evilstar9527/delivery-loop`、受保护 `main`、GitHub hosted runner 和仓库外 `/tmp` strict `CiEvidenceManifestV1`；只触发本轮所需的两次 `workflow_dispatch`，不写入仓库、manifest 或 `PROGRESS.md` 任何 Task 正文、canary 或 token。
- 红灯与动作：
  - 首次修复把 `TaskEnvelopeSchema.parse`/`JSON.parse` 异常统一为固定 `TaskEnvelope validation failed`，本地新增合法、非法 JSON、非法 schema、缺失输入测试；PR [#2](https://github.com/evilstar9527/delivery-loop/pull/2) 的 `pull_request` CI [30324971250](https://github.com/evilstar9527/delivery-loop/actions/runs/30324971250) 成功并合并。
  - 首次真实非法 workflow [30325217040](https://github.com/evilstar9527/delivery-loop/actions/runs/30325217040) 仍发现 runner 自动打印 step `env`，原始 `DELIVERY_TASK_JSON` 被泄漏；改为从 `GITHUB_EVENT_PATH.inputs.task_json` 读取，保留本地 direct env 入口，并让证据 verifier 要求校验 step 不声明任务正文环境变量。PR [#3](https://github.com/evilstar9527/delivery-loop/pull/3) 的 CI [30325519017](https://github.com/evilstar9527/delivery-loop/actions/runs/30325519017) 成功并合并。
  - 合并后重新触发合法 [30325724853](https://github.com/evilstar9527/delivery-loop/actions/runs/30325724853) 与非法 [30325739134](https://github.com/evilstar9527/delivery-loop/actions/runs/30325739134) workflow。非法日志首次安全扫描得到 `markerPresent=false`、`validationFailurePresent=true`、`rawPayloadFieldPresent=false`；合法日志同样未出现任务字段。
  - 首次真实 `pnpm run e2e:ci` 暴露 GitHub job-log API 对 verifier 的 `Accept: text/plain` 返回 HTTP 415；先让 fake API 对旧 media type 返回 415（聚焦测试红灯 3/6），再改用 `application/vnd.github+json`。PR [#4](https://github.com/evilstar9527/delivery-loop/pull/4) 的 `pull_request` CI [30326290357](https://github.com/evilstar9527/delivery-loop/actions/runs/30326290357) 成功并合并。
- 验证：
  - `pnpm exec vitest run test/validate-task-envelope.test.ts` → exit 0，5 tests；`pnpm exec vitest run test/ci-evidence.test.ts` → exit 0，6 tests；媒体类型修复前 fake API 真实返回 415，未把失败伪装为业务失败。
  - `DELIVERY_LOOP_CI_E2E=1 CI_EVIDENCE_FILE=/tmp/delivery-loop-ci-evidence-20260728.json ... pnpm run e2e:ci`（合并前修复版）→ exit 0，`caseCount=4`、`verifiedRunCount=4`、`verifiedJobCount=4`、`verifiedWorkflowCount=4`、`scannedLogCount=4`、`leakedCanaries=0`；合并后以 `main` verifier 对同一四条 immutable run 重跑仍 exit 0、摘要完全一致。
  - 合并后 `main` push CI [30326502593](https://github.com/evilstar9527/delivery-loop/actions/runs/30326502593) 成功；此前同一受审 workflow 的 main CI [30325709518](https://github.com/evilstar9527/delivery-loop/actions/runs/30325709518) 也成功。PR CI 的真实成功事实见 [30326290357](https://github.com/evilstar9527/delivery-loop/actions/runs/30326290357)。
  - `pnpm run verify` → exit 0：Node 103 files / 417 tests、workerd 57 files / 308 tests、Secret scan 483 files、文档链接通过；`git diff --check` → exit 0。
- 勾选：Phase 0 `validate-task.yml` 父项及其真实外部证据子项已勾选；manifest 只保存 workflow/title/canary digest，完整日志仅在内存中扫描，未入库。
- 决策沉淀：GitHub Actions 的普通 `workflow_dispatch` input 不是 Secret，声明为 step env 会被 runner diagnostics 自动回显；安全边界必须是从受控 `GITHUB_EVENT_PATH` 读取并让校验异常固定化。GitHub job-log REST 请求使用 `application/vnd.github+json`，不能假设 `text/plain` 可直接协商。
- 遗留：`.github/workflows/ci.yml` 的 Phase 0 父项尚未在 DOD 中勾选；下一轮可复用同一 `CiEvidenceManifestV1` 真实证据关闭它，随后继续采集仓库外 `RepositoryBootstrapEvidenceManifestV1` 并运行真实 `pnpm run e2e:repository-bootstrap`。

## Round 133 — 2026-07-28
- 目标：Phase 0 / `.github/workflows/ci.yml` 在 GitHub `main`/`pull_request` 上实际运行成功且权限只有 `contents: read`。本轮只关闭该 CI 父项，复用 Round 132 已采集的四类仓库外 strict CI 证据。
- 前置与权限：只读读取公开仓库的 Actions run、不可变 workflow blob、job 和有界日志；未触发新的任务或外部副作用，manifest 仍在仓库外，不保存 Task 正文、canary 或 token。
- 验证：
  - 合并后 main push [30326502593](https://github.com/evilstar9527/delivery-loop/actions/runs/30326502593) → `verify` job success；此前同一受审 workflow 的 pull_request [30326290357](https://github.com/evilstar9527/delivery-loop/actions/runs/30326290357) → `verify` job success。
  - 合并后 `DELIVERY_LOOP_CI_E2E=1 CI_EVIDENCE_FILE=/tmp/delivery-loop-ci-evidence-20260728.json ... pnpm run e2e:ci` → exit 0，`caseCount=4`、`verifiedRunCount=4`、`verifiedJobCount=4`、`verifiedWorkflowCount=4`、`scannedLogCount=4`、`leakedCanaries=0`。verifier 按四条 run 的 immutable head SHA 重新读取 workflow blob，确认顶层权限严格为 `{contents: read}`、唯一 `verify` job 和有界完整日志。
  - `pnpm run verify:docs` → exit 0；`git diff --check` → exit 0。
- 勾选：Phase 0 `.github/workflows/ci.yml` 父项及其真实外部证据子项已勾选。
- 决策沉淀：CI 的成功判据是 GitHub live run + immutable workflow/job/log 交叉事实；PR CI 成功不能单独代替 main push，静态 workflow 内容、fake API 或本地 `pnpm run verify` 也不能代替权限和日志证据。
- 遗留：Phase 0 仅剩远端 repository bootstrap 父项（owner/visibility/default branch/protection 的仓库外 manifest 与 `pnpm run e2e:repository-bootstrap` live exit 0）；随后再按 Phase 顺序处理真实 Cloudflare/Agent/平台事实。

## Round 134 — 2026-07-28
- 目标：关闭 Phase 0 远端 repository bootstrap；记录用户确认的个人公开仓库、默认分支保护和最新 main CI 真实证据。本轮不把 manifest、用户正文、token 或 GitHub raw response 写入仓库。
- 用户决策：仓库放在个人账号 `evilstar9527` 下，名称 `delivery-loop`，visibility 为 `public`；明确不创建或修改 `TokenRollAI` 仓库。默认分支为 `main`，保护策略要求 `verify` 严格状态检查、管理员也执行、线性历史、conversation resolution，并禁止 force-push 和删除分支。
- 真实外部事实：GitHub repository ID `1314460432`，owner `evilstar9527`，visibility `PUBLIC`，默认分支 `main`，非 archived；默认分支 head 为 `5beaf31b25023d30ce35d89eba66c25077f7a3cc`，本地无 credential `origin` 与远端一致且 `main` protected。repository ruleset `19869381` 为 active，四条规则为 `deletion`、`non_fast_forward`、`required_linear_history`、`required_status_checks`，无 bypass actor；旧式 branch protection API 另核对 `verify` + strict、enforce admins、conversation resolution、禁止 force-push/删除。
- PR #7（`fix: normalize effective repository rule enforcement`）的 pull_request CI [30327993216](https://github.com/evilstar9527/delivery-loop/actions/runs/30327993216) 成功；合并后的 main push CI [30328213150](https://github.com/evilstar9527/delivery-loop/actions/runs/30328213150) 的唯一 `verify` job 成功（约 4 分钟）。该修复记录了 GitHub effective rules API 省略 `enforcement` 时按 endpoint 语义规范化为 active，避免把真实有效规则误判为缺失。
- 验证：仓库外 manifest 经 `DELIVERY_LOOP_REPOSITORY_BOOTSTRAP_E2E=1 REPOSITORY_BOOTSTRAP_EVIDENCE_FILE=/tmp/delivery-loop-repository-bootstrap-20260728.json REPOSITORY_BOOTSTRAP_GITHUB_TOKEN="$(gh auth token)" pnpm run e2e:repository-bootstrap`（运行时使用短期读取凭据）→ exit 0，摘要为 `repository=evilstar9527/delivery-loop`、`visibility=public`、`defaultBranch=main`、`githubRepositoryId=1314460432`、`activeRuleCount=4`、`localOriginMatched=true`。实际命令使用了当前受控 GitHub 登录态，token 未输出、未写入 manifest 或仓库；此处不保存 token 值。
- DoD：Phase 0 repository bootstrap 父项及其真实外部证据子项已勾选。manifest 仍位于仓库外；`decisionId/confirmedAt/confirmedByPrincipalDigest` 只能作为安全索引，用户确认真实性仍由外部人工 authority 复核，不能由 verifier 自证。
- 遗留/下一步：Phase 0 已完成；后续按 Phase 顺序进入真实 Cloudflare/Agent/平台事实。当前没有因此获得 Cloudflare 部署、GitHub App 安装、试点仓库写入或生产发布授权。

## Round 135 — 2026-07-28
- 目标：Phase 1 首个未完成项——`DeliveryRunWorkflow` 在真实 Cloudflare Worker hibernate/redeploy 后复用成功步骤，并以唯一 GitHub analysis Action 证明 dispatch 只发生一次。本轮只做外部前置核对和本地契约复验，不伪造真实部署。
- 验收命令与成功判据：真实关门必须由 `DELIVERY_LOOP_WORKFLOW_HIBERNATE_E2E=1 pnpm run e2e:workflow-hibernate` 读取仓库外 manifest，交叉核对同一 Cloudflare instance 的七条稳定 step、before/after Worker deployment、D1 Run/Plan/Attempt/outbox、Case 8 和唯一 GitHub Action；缺配置只能 exit 2，fake API、workerd restart 或 Wrangler dry-run不能替代。
- 前置与权限：只读使用本机已登录 Wrangler 的两个 Cloudflare account context 与公开 GitHub 仓库 metadata；没有向 Cloudflare、GitHub App、Actions、D1、Queue 或仓库发送写请求，也没有读取/创建任何项目 Secret。当前配置 `wrangler.jsonc` 的 D1 ID 仍为占位值，control-plane URL、query/operations token、GitHub App installation audit token和部署预算均未提供。
- 真实外部核对：两个 Cloudflare account（当前登录上下文）均不存在 `delivery-loop-control-plane` Worker；两者均没有已部署 `delivery-run` Workflow；本项目 `delivery-loop-*` D1/Queue 资源不存在（已有的 `friend-avatar-jobs*` 不属于本项目）。GitHub 仓库虽有固定 `Delivery Agent` workflow，但当前没有可由用户凭据证明的单仓库 GitHub App installation、installation audit token签发记录或控制面 dispatch lineage。
- 验证：`pnpm run e2e:workflow-hibernate`（未设置 opt-in）→ exit 2，固定输出 `workflow-hibernate-e2e: opt-in missing`；`pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/delivery-run-workflow.test.ts test/workflow/workflow-outbox.test.ts` → exit 0，2 files / 7 tests。既有 local workerd restart contract保持通过，但不构成真实 Cloudflare 证据。
- 勾选：无。Phase 1 hibernate/redeploy父项及其真实 Cloudflare 子项保持未勾选；当前不存在可安全填写的外部 manifest 或 Action URL。
- 决策/阻塞：继续推进该项至少需要 owner 明确选择 Cloudflare account、批准创建 D1/R2/Queues/Workflow/Worker 的测试资源及预算，并提供已部署 HTTPS control-plane/query/operations 访问；同时需要 GitHub App owner、最小权限/selected 单仓库安装和 Actions 预算。未获得这些外部 authority 前不执行 deploy、trigger、App installation 或计费 probe；本轮仅记录一次 blocker，不把它标为永久 blocked。

## Round 136 — 2026-07-28
- 目标：Phase 0 通用关门门槛中的第一个子项——契约一致。只核对 Phase 0 已实现的 TaskEnvelope、Run、ExecutionPlan、Workflow `step.do`、CI/validate-task 与规范/源码/测试的对应关系；不把 Phase 1 真实外部缺口误标为完成。
- 验收命令与成功判据：`pnpm run verify` 必须完整通过；并核对 `docs/Proto.md`、`docs/Architecture.md`、`docs/Security.md` 对 Phase 0 的 schema/state/effect/permission 约束与源码、migration、测试锚点均存在。后续 Phase 的新 API/event/state/plan/evidence 仍需独立证据，不能复用本轮子项。
- 动作：复读 Proto 的 TaskEnvelope/Workflow/ExecutionPlan/CI 边界、Architecture 的控制面与 Run/Attempt/Workflow 真源、Security 的最小权限与 Secret 边界；以 `rg` 交叉核对 `src/domain`、`src/workflows`、`.github/workflows` 与对应规范锚点。未发现 Phase 0 规范与实现的未记录漂移；未改变运行时契约或 schema version。
- 验证：`pnpm run verify` → exit 0：typecheck、ESLint、Node 103 files / 417 tests、workerd 57 files / 308 tests、生产 Secret scan 483 files、文档链接全部通过；workerd 仅输出已有的终止清理诊断，不是失败 suite。`git diff --check` → exit 0。
- 勾选：在 `DOD.md` 通用“契约一致”下新增并勾选 Phase 0 子证据；通用父项保持未勾选，不能代表 Phase 1 及后续契约已完成。
- 决策沉淀：Phase 0 允许用同一规范锚点 + 编译/测试/链接回归证明契约未漂移；Phase 1 的真实 Cloudflare/GitHub App 事实继续按各自严格 verifier 验收。
- 遗留：下一轮按 LOOP 处理通用门槛的下一个“测试覆盖（Phase 0）”子项，或在 owner 提供 Cloudflare/GitHub App 外部 authority 后恢复 Phase 1 真实演练。

## Round 137 — 2026-07-28
- 目标：Phase 0 通用关门门槛中的第二个子项——测试覆盖。验证状态机、权限边界、幂等、redaction/Secret scan 等纯逻辑都有正反用例，并至少有一条 D1/Workflow I/O 穿透集成测试。
- 验收命令与成功判据：纯逻辑定向 suite 必须覆盖 TaskEnvelope、Run、Plan、CI/validate/repository evidence、redaction；workerd suite 必须覆盖 Task API、Workflow durable handoff、outbox/create replay 和 lease CAS；两组 exit 0 后再以 `pnpm run verify` 作为全量回归。
- 验证：`pnpm exec vitest run test/task.test.ts test/run.test.ts test/plan.test.ts test/redaction.test.ts test/ci-evidence.test.ts test/validate-task-envelope.test.ts test/repository-bootstrap-evidence.test.ts` → exit 0，7 files / 42 tests；`pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/task-api.test.ts test/workflow/delivery-run-workflow.test.ts test/workflow/workflow-outbox.test.ts test/workflow/lease-cas.test.ts` → exit 0，4 files / 18 tests；随后 `pnpm run verify` → exit 0，Node 103 files / 417 tests、workerd 57 files / 308 tests、Secret scan 483 files、docs links 全绿。
- 勾选：在 `DOD.md` 通用“测试覆盖”下新增并勾选 Phase 0 子证据；通用父项保持未勾选，后续 Phase 仍需独立覆盖。
- 决策沉淀：Phase 0 的 I/O 穿透以 workerd+D1/R2/Workflow/outbox 测试为准，不把 fake HTTP 或 schema example当作真实平台事实；Phase 1 真实 Cloudflare/GitHub App blocker不因本地测试绿灯而改变。
- 遗留：下一轮按 LOOP 处理“安全回归（Phase 0）”子项，或在 owner 提供外部 authority 后恢复 Phase 1。

## Round 138 — 2026-07-28
- 目标：Phase 0 通用关门门槛中的第三个子项——安全回归。只关闭 Phase 0 的越权、重放identity、Secret泄漏和不可信输入测试证据；通用父项及 Phase 1+ 安全关口保持未完成。
- 前置与权限：用户已选择一个 Cloudflare account。本轮只读查询该账号的Worker deployments、Workflows、D1与Queues，并执行本地Wrangler dry-run；没有创建D1/R2/Queue/Workflow/Worker、部署、触发Action、安装GitHub App或产生受控probe费用。账号选择不等同于外部资源写入/部署授权。
- Phase 1只读事实：`delivery-loop-control-plane` Worker不存在（Cloudflare API code 10007）；账号没有已部署Workflow，D1 inventory为空；现有两个`friend-avatar-jobs*` Queue与本项目无关。`wrangler deploy --dry-run` exit 0，bundle为2737.84 KiB / gzip 459.07 KiB，并识别双Workflow、双Queue、D1和四个R2 binding；dry-run不能证明资源存在、hibernate/redeploy或GitHub dispatch。
- 安全覆盖裁决：Phase 0的越权判据由Plan effect ceiling/self-promotion拒绝与CI最小权限漂移拒绝回答；重放只证明Task source revision稳定identity和manifest/run identity不可漂移，不扩大为Phase 1业务exactly-once；不可信Task/Plan输入必须在执行前拒绝且固定错误不回显；redactor/scanner、validate-task canary与CI日志canary共同回答Secret边界。
- 验证：
  - `pnpm exec vitest run test/task.test.ts test/run.test.ts test/plan.test.ts test/redaction.test.ts test/ci-evidence.test.ts test/validate-task-envelope.test.ts test/repository-bootstrap-evidence.test.ts` → exit 0，7 files / 42 tests。
  - `pnpm run verify:secrets` → exit 0，483个生产文件通过静态credential/Secret扫描。
  - `pnpm run verify` → exit 0：typecheck、ESLint、Node 103 files / 417 tests、workerd 57 files / 308 tests、Secret scan 483 files、docs links全绿；workerd仅输出既有测试主动`User called terminate`清理诊断。
  - Round 132的仓库外CI manifest仍存在，但一次性invalid-task canary明文按安全约定未持久化且当前环境不存在；没有为重跑反推输入或擅自触发新Action。真实日志零泄漏继续引用已入账的immutable runs [30325724853](https://github.com/evilstar9527/delivery-loop/actions/runs/30325724853)、[30325739134](https://github.com/evilstar9527/delivery-loop/actions/runs/30325739134)与既有`e2e:ci` exit 0证据。
- 勾选：在`DOD.md`通用“安全回归”下新增并勾选Phase 0子证据；通用父项保持未勾，不能替代后续Phase的真实webhook/OIDC/replay/Secret场景。
- 决策沉淀：一次性canary不为方便重跑而持久化；若将来需要重新核对新的Action日志，必须在明确Actions授权下生成新canary和新invalid workflow run，不能用旧digest自证。
- 遗留：Phase 1真实hibernate/redeploy仍需owner明确批准在已选Cloudflare账号创建测试资源、部署控制面及预算，并完成selected-repository GitHub App安装与Actions触发授权。未取得该authority前，下一轮按LOOP处理Phase 0通用“证据入账”子证据，不盲重试外部部署。

## Round 139 — 2026-07-28
- 目标：Phase 0 通用关门门槛中的第四个子项——证据入账。逐项审计命令/exit code、Actions run、PR、repository bootstrap和安全摘要是否真实写入`PROGRESS.md`；只关闭Phase 0子证据，通用父项保持未勾。
- 前置与权限：仅用当前GitHub登录态做公开仓库Actions/PR/repository/rules只读GET，并使用仓库外bootstrap manifest；未触发workflow、创建PR、改仓库设置、部署或访问Cloudflare写API。Phase 0范围没有deployment且本阶段从未部署，deployment URL明确为N/A，Wrangler dry-run不算外部deployment。
- 账本一致性修复：审计前顶部“当前状态/Blockers”仍自报“无remote/远端未开始”，与Round 132～134及live GitHub事实冲突。本轮只更新可变摘要为当前Phase 1外部门槛、已完成GitHub bootstrap和真实外部缺口；历史Round不改，llmdoc按项目约定不更新。
- Actions/PR外部复核：
  - main push [30326502593](https://github.com/evilstar9527/delivery-loop/actions/runs/30326502593)为`push/completed/success`；pull request [30326290357](https://github.com/evilstar9527/delivery-loop/actions/runs/30326290357)为`pull_request/completed/success`。
  - 合法Task [30325724853](https://github.com/evilstar9527/delivery-loop/actions/runs/30325724853)为`workflow_dispatch/completed/success`；非法Task [30325739134](https://github.com/evilstar9527/delivery-loop/actions/runs/30325739134)为`workflow_dispatch/completed/failure`，失败是既有strict verifier要求的安全结果，不重标为成功。
  - 修复/验收PR [#2](https://github.com/evilstar9527/delivery-loop/pull/2)、[#3](https://github.com/evilstar9527/delivery-loop/pull/3)、[#4](https://github.com/evilstar9527/delivery-loop/pull/4)、[#7](https://github.com/evilstar9527/delivery-loop/pull/7)及上一轮证据PR [#12](https://github.com/evilstar9527/delivery-loop/pull/12)均由live API确认`MERGED`；#12合并后的main CI [30346128084](https://github.com/evilstar9527/delivery-loop/actions/runs/30346128084)为success。
- repository bootstrap重验：旧仓库外manifest冻结Round 134后的旧main head，首次live `pnpm run e2e:repository-bootstrap`正确exit 1 / `github_branch_mismatch`，没有当成通过。只更新仓库外`recordedAt + branch.headSha`到当前main后重跑exit 0：`repository=evilstar9527/delivery-loop`、`public`、`main`、repository ID `1314460432`、4条active rule、`localOriginMatched=true`；decision/rules digest未改，token与raw响应未入manifest/仓库/日志。
- 验证：
  - 13项固定账本anchor审计（Round 1命令、四run、PR #2/#3/#4/#7、两条live verifier摘要）→ exit 0；此前审计在PR #7仅有CI URL而无PR URL时exit 1，本Round补安全PR链接后才通过。
  - `pnpm run verify:docs`与`git diff --check` → exit 0。
  - 最终`pnpm run verify` → exit 0：typecheck、ESLint、Node 103 files / 417 tests、workerd 57 files / 308 tests、483个生产文件Secret scan与文档链接全部通过；workerd仅输出既有测试主动terminate清理诊断。
- 勾选：在`DOD.md`通用“证据入账”下新增并勾选Phase 0子证据；通用父项保持未勾，后续Phase必须各自记录真实run/PR/deployment/tenant/Cloudflare事实。
- 决策沉淀：repository bootstrap manifest是当前事实索引，默认分支前进后旧head必须使live verifier失败并重新采集；不能把曾经exit 0的manifest永久当作当前仓库证据。失败命令、预期负向Action与N/A deployment都明确入账，避免只保留成功样本。
- 遗留：下一轮按LOOP处理Phase 0通用“全量回归”子证据；Phase 1真实hibernate仍等待Cloudflare资源/部署预算和GitHub App/Actions明确授权。

## Round 140 — 2026-07-28
- 目标：Phase 0 通用关门门槛中的第五个子项——全量回归。重跑当前代码/文档的Phase 0本地验收与完整`pnpm run verify`，只读复核可重跑外部事实，并明确记录无法安全重跑的CI canary前置；只关闭Phase 0子证据。
- 前置与权限：本地Node/workerd、仓库外repository bootstrap manifest及GitHub公开仓库只读GET；未触发workflow、生成新canary、修改GitHub设置或部署。完整`e2e:ci`所需invalid-task canary明文按安全契约未持久化，本轮不通过历史digest反推，也不擅自触发新workflow。
- 验证：
  - `pnpm exec vitest run test/task.test.ts test/run.test.ts test/plan.test.ts test/redaction.test.ts test/ci-evidence.test.ts test/validate-task-envelope.test.ts test/repository-bootstrap-evidence.test.ts` → exit 0，7 files / 42 tests。
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/task-api.test.ts test/workflow/delivery-run-workflow.test.ts test/workflow/workflow-outbox.test.ts test/workflow/lease-cas.test.ts` → exit 0，4 files / 18 tests；D1/Workflow/outbox/lease I/O均真实穿透workerd。
  - 文档边界检索重新定位Architecture的持久控制面/D1真源与双层恢复、Proto的Secret/OIDC/checkpoint边界、Security §7人审闸门；未发现Phase 0文档验收答案缺失。
  - GitHub live只读复核：main push [30326502593](https://github.com/evilstar9527/delivery-loop/actions/runs/30326502593)、pull_request [30326290357](https://github.com/evilstar9527/delivery-loop/actions/runs/30326290357)、合法dispatch [30325724853](https://github.com/evilstar9527/delivery-loop/actions/runs/30325724853)仍为completed/success；非法dispatch [30325739134](https://github.com/evilstar9527/delivery-loop/actions/runs/30325739134)仍为completed/failure，符合strict负向判据。
  - 仓库外bootstrap manifest刷新`recordedAt + branch.headSha`到本轮`origin/main`后，live `pnpm run e2e:repository-bootstrap` → exit 0：public/main/repository ID `1314460432`、4条active rule、`localOriginMatched=true`；decision/rules digest未改。
  - 最终`pnpm run verify` → exit 0：typecheck、ESLint、Node 103 files / 417 tests、workerd 57 files / 308 tests、483个生产文件Secret scan与docs links全部通过。Vitest未报告skip；workerd既有`User called terminate`是测试清理诊断，不是失败或skip。
- 未重跑项：仓库外CI manifest仍存在，但`CI_INVALID_TASK_CANARY`当前明确缺失；因此完整`pnpm run e2e:ci`本轮未执行，也没有把默认/缺配置exit 2写成通过。Phase 0真实CI required DoD仍由Round 132/133保存的同一immutable run/workflow/job/log verifier exit 0证明，本轮live run状态复核只做补强、不能单独替代日志canary证据。
- 勾选：在`DOD.md`通用“全量回归”下新增并勾选Phase 0子证据；通用父项与后续Phase保持未勾。
- 决策沉淀：全量回归必须区分“当前可重跑的本地/只读事实”与“需要一次性外部输入的新场景”。安全删除canary会牺牲无副作用重跑能力，但不能因此持久化明文或伪造exit 0；需要新CI日志证据时必须另获Actions授权并生成新canary/run。
- 遗留：下一轮按LOOP完成Phase 0通用“五维质量关口”；通过后Phase 0通用六项子证据才齐，父项仍保留为跨Phase总门槛。Phase 1真实hibernate继续等待外部资源与预算授权。

## Round 141 — 2026-07-28
- 目标：Phase 0 通用关门门槛中的第六个子项——五维质量关口。按正确性、安全性、恢复性、三方契约与证据真实性逐维review；发现BLOCKER/MAJOR时先修复并重验，不以已有绿灯直接关门。
- 前置与权限：本地Node/workerd、Wrangler dry-run、仓库外0600安全manifest及当前GitHub仓库/Actions只读事实；为修复后的CI契约显式触发轻量合法/非法`validate-task` workflow。未创建或部署Cloudflare资源、未安装GitHub App、未读取业务日志/数据库、未使用真实Secret。随机canary只驻留单次shell内存并仅以digest进入仓库外manifest，不进入命令参数、仓库、PROGRESS或Action日志。
- 五维结论：
  - 正确性：TaskEnvelope安全默认值/revision identity、Run主路径与修复/恢复边、ExecutionPlan DAG/doneWhen/Evidence/effect/version/digest/base绑定均由Phase 0定向矩阵覆盖；D1/Workflow/outbox/lease I/O矩阵与全量验证通过，未发现未处理BLOCKER/MAJOR。
  - 安全性：review发现两个MAJOR：`.github/workflows/{ci,validate-task}.yml`仍用可变`@v4`，与Security不可变SHA规范冲突；合法校验输出的`dedupeKey`包含不可信`tenantKey/taskKey/revision`，可能把敏感标识带入Action日志。先改测试后定向运行出现5项预期失败；PR [#15](https://github.com/evilstar9527/delivery-loop/pull/15)固定三类Action受审SHA、让strict verifier拒绝tag，并把合法输出收敛为固定`{"valid":true}`，非法输出继续固定错误。修复后2 files / 11 tests全绿。
  - 恢复性：复核`DeliveryRunWorkflow`只有稳定命名`step.do`/durable wait承担副作用边界，workerd restart后analysis Attempt/dispatch outbox保持唯一，D1投影/lease CAS回归通过；本结论严格限制为Phase 0本地恢复契约，真实Cloudflare hibernate/redeploy仍未发生且Phase 1父项保持未勾。
  - 三方契约：仓库内不再存在`@vN/main/master/latest`第三方Action引用；GitHub immutable workflow、`contents:read`、唯一job和当前run由strict verifier核对。`CI=1 WRANGLER_SEND_METRICS=false pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-round141` exit 0，识别2 Workflow、2 Queue、D1与4 R2 binding但没有部署。GitHub对这三枚受审SHA提示Node 20声明被平台强制到Node 24，定级MINOR依赖升级跟进；当前PR/main/validate运行均成功或按预期安全失败，不构成未处理MAJOR。
  - 证据真实性：PR #15已MERGED，required PR CI [30349937535](https://github.com/evilstar9527/delivery-loop/actions/runs/30349937535)和合并后main CI [30350227486](https://github.com/evilstar9527/delivery-loop/actions/runs/30350227486)均success；当前仓库ID`1314460432`、public/main/protected、4条active rules与main head`f1b37526818e141366f3b42f3a28e1ad95be7cca`由live API复核。合法 [30350744104](https://github.com/evilstar9527/delivery-loop/actions/runs/30350744104) success、非法 [30350788158](https://github.com/evilstar9527/delivery-loop/actions/runs/30350788158) failure；strict `pnpm run e2e:ci`最终exit 0，4 runs/jobs/workflows/logs且`leakedCanaries=0`。
- 验证：
  - `pnpm exec vitest run test/ci-evidence.test.ts test/validate-task-envelope.test.ts` → 修复前exit 1（5项按预期失败），修复后exit 0，2 files / 11 tests。
  - `pnpm exec vitest run test/task.test.ts test/run.test.ts test/plan.test.ts test/redaction.test.ts test/ci-evidence.test.ts test/validate-task-envelope.test.ts test/repository-bootstrap-evidence.test.ts` → exit 0，7 files / 42 tests。
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/task-api.test.ts test/workflow/delivery-run-workflow.test.ts test/workflow/workflow-outbox.test.ts test/workflow/lease-cas.test.ts` → exit 0，4 files / 18 tests。
  - `pnpm run verify` → exit 0：typecheck、ESLint、Node 103 files / 417 tests、workerd 57 files / 308 tests、483文件Secret scan、docs links全绿；workerd主动terminate清理诊断不是skip。
  - 外部CI evidence首次因临时collector在`tsx -e`使用top-level await而exit 1；修正async IIFE后第二次因zsh`/dev/fd`未可靠穿过`pnpm`而manifest invalid/exit 1。纯只读schema诊断成功后改用仓库外0600 manifest，第三次`pnpm run e2e:ci`exit 0。两次工具失败未伪装成功，也没有复用失去canary authority的旧run。
- 勾选：在`DOD.md`通用“质量关口”下新增并勾选Phase 0子证据；五维review后无未处理BLOCKER/MAJOR。六项Phase 0通用子证据至此齐全，但通用父项仍保持未勾，不能替代Phase 1～7关门。
- 决策沉淀：供应链规范不仅要求最小`permissions`，还要求第三方Action不可变pin；strict外部verifier必须拒绝tag。Action成功日志也不能输出来源标识或去重键，因为“schema合法”不等于“内容可公开”。按用户要求不更新llmdoc。
- 遗留：为全仓库第三方Action受审SHA安排独立依赖升级，消除GitHub Node 20→24强制运行提示（MINOR，不阻塞本门槛）。主线回到Phase 1真实hibernate；已选Cloudflare账号仍不代表资源创建、部署或预算授权，GitHub App selected-repository installation与Actions预算也仍需明确批准。

## Round 142 — 2026-07-28
- 目标：Phase 1 / `DeliveryRunWorkflow`真实Cloudflare hibernate/redeploy，并以唯一GitHub analysis Action证明dispatch只发生一次。本轮先按既定strict verifier做外部readiness复核；缺authority时不创建资源、不部署、不触发Action，也不以dry-run或默认exit 2关门。
- 验收命令与成功判据：唯一关门命令仍是`DELIVERY_LOOP_WORKFLOW_HIBERNATE_E2E=1 ... pnpm run e2e:workflow-hibernate` exit 0，并同时核对同一Run的D1/Case 8、Cloudflare before/after deployment与七条稳定step、零controlled replay及GitHub stable-title唯一Action；本地workerd、fake API和manifest自报不能替代。
- 前置与权限：只读使用已选Cloudflare账号、当前Wrangler OAuth与GitHub OAuth查询资源/Actions；两枚OAuth即使技术scope含write，也没有被解释为owner对本轮资源创建、部署、App安装或预算的业务授权。未读取或输出token，未创建/修改Cloudflare/GitHub资源，未触发Action或部署。
- 当前外部事实：
  - `wrangler deployments list --name delivery-loop-control-plane` → exit 1 / Cloudflare code `10007`，目标Worker不存在；`wrangler d1 list --json` → exit 0 / 空数组；`wrangler workflows list` → exit 0 / 无已部署Workflow。
  - R2 inventory只有5个无关bucket，Queues inventory只有`friend-avatar-jobs`及其DLQ；不存在`delivery-loop-*`的4个R2 bucket或6个Queue。既有资源名称只作排除，不被复用或修改。
  - GitHub当前用户OAuth读取`/user/installations`返回403、repository installations端点返回404，不能证明App installation；`gh run list --workflow "Delivery Agent"` → exit 0 / 空数组，当前没有真实analysis Action事实。
- 验证：`pnpm run e2e:workflow-hibernate`（未设置opt-in）→ exit 2 / `workflow-hibernate-e2e: opt-in missing`，只证明前置缺失，不是成功。既有本地workerd与strict verifier子证据保持不变，本轮没有重复执行无意义fake/dry-run测试。
- 勾选：无。真实Cloudflare子项及父DoD保持未勾；当前没有可填写的真实Run、deployment、Workflow instance、D1或Action URL。
- 用户输入：确认本轮目标Cloudflare账号为`b8488957e88658039d2a38fb8f160514`；该输入只锁定目标账号，不单独构成资源创建、部署或费用授权。
- 最小授权请求：允许在该账号创建1个D1、4个私有R2 bucket、6个Queue并部署`delivery-loop-control-plane`及2个Workflow；允许在个人仓库`evilstar9527/delivery-loop`创建/安装selected-repository GitHub App、配置协议要求的最小permissions/events与受控Actions；批准该测试演练的Cloudflare/Actions预算。Secret由owner在受控绑定/Environment中设置，不发送到聊天、argv、仓库或PROGRESS。
- 阻塞裁决：同一外部authority缺口已在Round 135、138～141及本轮连续出现。按LOOP“连续3轮不闭环后停止盲重试”，本轮把blocker、已尝试只读路径和最小人工输入写实后停止；账号ID本身不能扩张授权范围。
- 决策沉淀：真实hibernate不是单独`wrangler deploy`；必须与selected-install App、正常Task→D1 outbox→Action链路、在wait期间唯一after deployment及strict四方证据同窗发生。按用户要求不更新llmdoc。
- 遗留：等待owner明确批准上述三类测试外部写入/预算。授权后从资源bootstrap与GitHub App selected installation开始；未授权前不再重复inventory/dry-run/default-exit-2轮次。

## Round 143 — 2026-07-28
- 目标：继续 Phase 1 / `DeliveryRunWorkflow` 真实 Cloudflare hibernate/redeploy。本轮先闭环已获授权的控制面 bootstrap、远程 D1 migration 阻塞与真实 analysis 模型配额前置；唯一最终关门仍是 `DELIVERY_LOOP_WORKFLOW_HIBERNATE_E2E=1 ... pnpm run e2e:workflow-hibernate` exit 0。
- 前置与权限：owner已明确批准在 Cloudflare 账号 `b8488957e88658039d2a38fb8f160514` 创建本项目测试资源、部署 Worker/Workflow、创建并仅安装到 `evilstar9527/delivery-loop` 的 GitHub App与触发受控 Actions。两枚 Worker 服务 Secret 只经 stdin 写入并仅存长生命周期shell内存；本轮没有读取、输出或持久化其明文。
- 动作：
  - 创建 D1 `delivery-loop-control`（ID `8cd2d08d-1db1-4cd8-8598-caaca308c7fd`）、四个 `delivery-loop-{task-objects,checkpoint-objects,backups,raw-agent-objects}` 私有 R2 bucket，以及 workflow/Feishu ingress 两组主 Queue + DLQ + quarantine 共 6 个 Queue。
  - 部署 [delivery-loop-control-plane](https://delivery-loop-control-plane.eve55265.workers.dev)；当前 100% Worker version 为 `19e73239-f9e0-4f4b-a085-61a4c7fbb23c`。部署 Workflow `delivery-run` 与 `control-plane-backup`，Wrangler live inventory 均指向 `delivery-loop-control-plane`。
  - 首次远程migration的 0001～0049 成功，0050 因一个含三条投影语句的 trigger 在 D1 `/query` migration 路径返回 `SQLITE_ERROR: incomplete input`。修复为：0050 不再创建多语句 trigger，`MonitorAlertIngressStore` 使用同一 D1 atomic batch 发布 receipt/head/candidate/lineage，0061 删除可能经旧 import 路径存在的 trigger，并增加 Wrangler splitter 回归。`docs/{Architecture,Proto}.md` 已与该运行事实对齐。
  - Cloudflare 在 Workflow 声明 `schedules: ["0 2 * * *"]` 时返回 403；去掉 schedule 后两个 Workflow 均成功部署。这只是当前 hibernate 演练 profile，不被冒充为 `docs/Proto.md` 要求的每日 02:00 backup；该平台计划/触发差异留待 backup DoD 独立闭环。
  - 通过 OpenAI 官方 latest-model/model/pricing 资料选择均衡性能与成本的 `gpt-5.6-terra`；官方 standard 费率为输入 $2.50/百万 token、缓存输入 $0.25/百万、输出 $15.00/百万。远程 D1 新增 immutable profile `codex-gpt-5p6-terra-20260728`，单次预留上限 200k input + 40k output，最坏非缓存成本 $1.10；未在 repository Secret 就绪前调用模型。
- 验证：
  - `pnpm exec vitest run test/d1-migration-wrangler-compat.test.ts` → exit 0，1 file / 1 test；所有migration在Wrangler splitter下均把ledger insert保持为独立最后语句。
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/monitor-alert-ingress.test.ts test/workflow/task-api.test.ts` → exit 0，2 files / 11 tests；20路monitor投影、重放/冲突、inclusive window和Task intake穿透全绿。
  - `pnpm run verify` → exit 0：typecheck、ESLint、Node 104 files / 418 tests、workerd、Secret scan 与docs links全绿；workerd终止实例的 `User called terminate` 是既有清理诊断，不是 skip/失败。
  - `CLOUDFLARE_ACCOUNT_ID=... pnpm exec wrangler d1 migrations list delivery-loop-control --remote` → exit 0 / `No migrations to apply`；远程安全SQL查询为 `migration_count=61` 且 `projection_trigger_count=0`。首次未显式传 account env 的 list 因本机有两个Cloudflare账号而exit 1，未当成通过；加上已授权account后复验exit 0。
  - live inventory 重验确认1 D1/4本项目R2/6本项目Queue/2 Workflow存在，`GET /healthz` → 200 `{"ok":true,"service":"delivery-loop-control-plane"}`。
- 勾选：在Phase 1 hibernate DoD下新增并勾选“真实控制面 bootstrap 前置”子证据；真实hibernate/redeploy子项与父项仍未勾。
- 决策沉淀：D1 migration 的可部署形状必须以 Wrangler 远程migrate路径为准，不能用本地 SQLite 或 D1 import API 的成功替代；多表业务投影改用同一 D1 batch 保持原子性。OpenAI model profile使用版本化价格快照与有界预留，不使用Task/Agent自报模型或费率。OpenAI官方资料直接影响本轮选择：最新旗舰为Sol，但官方按工作负载建议Terra用于性能/成本平衡，因此没有盲目把单次分析全部路由到最贵层。按用户要求不更新llmdoc。
- 遗留：GitHub自动化页面的登录标签未在用户主界面显示，已给出直接登录链接。待用户回复“已登录”后创建 GitHub App，仅selected-install `evilstar9527/delivery-loop`，生成private key后只经stdin设置Worker Secret。另需owner在repository Actions Secrets中设置`OPENAI_API_KEY`；本机与当前repository Secret inventory都没有该值，不从Codex登录态/keychain提取。

## Round 144 — 2026-07-28
- 目标：继续 Phase 1 / `DeliveryRunWorkflow` 真实 Cloudflare hibernate/redeploy。本轮闭环单仓库 GitHub App、Worker private-key Secret与完整运行配置前置；最终关门仍保持 `DELIVERY_LOOP_WORKFLOW_HIBERNATE_E2E=1 ... pnpm run e2e:workflow-hibernate` exit 0，不以App创建或部署代替真实hibernate。
- 前置与权限：owner已在GitHub Web重新登录，并延续此前“直接创建”、只安装到`evilstar9527/delivery-loop`、触发受控Actions的明确授权。未读取或索取GitHub密码、OpenAI key、App private key明文；GitHub页面、manifest conversion响应与外部载荷均按不可信输入处理。
- 动作：
  - 读取GitHub官方immutable文档commit `cd664a7b671173b1b4c35060017ad9d694f73297`的App Manifest flow，按契约把`state`放入manifest POST URL query，并改为permissions逐字段/键集合比较、events无序精确集合比较；一次性helper只监听`127.0.0.1:8765`，响应no-store并限制form action。
  - 初次manifest名`delivery-loop-evilstar9527-20260728`被GitHub明确拒绝为超过34字符，App未创建；缩短为`delivery-loop-evilstar-0728`后重新开始同一manifest flow，未把失败伪装为成功。
  - 创建private GitHub App `delivery-loop-evilstar-0728`：App ID `4415140`，slug=`delivery-loop-evilstar-0728`；GitHub安装页显示权限为code/metadata read与Actions read/write，事件由conversion response精确核对为唯一`workflow_run`。
  - 安装页默认`All repositories`时未提交；显式切换为`Only select repositories`并只选择`evilstar9527/delivery-loop`后安装。installation ID `149587996`，settings URL为`https://github.com/settings/installations/149587996`，页面显示Selected 1 repository且唯一条目为`evilstar9527/delivery-loop`。
  - manifest conversion得到的private key只保存在helper内存；以App JWT签发未传`repositories/repository_ids`的短期audit token，完整`/installation/repositories` inventory核对`repository_selection=selected`、total/count均为1且唯一full_name匹配后立即撤销audit token；private key只经stdin执行`wrangler secret put GITHUB_APP_PRIVATE_KEY`，成功后从helper内存清空并停止本地服务。
  - `wrangler.jsonc`增加完整非Secret配置：App/installation ID、单仓库allowlist、OIDC audience、真实control-plane URL和immutable model profile ID；真实部署Worker version `026915b2-d688-4711-a10e-6aaa970117a9`。Workflow schedule仍是Round 143为本次live演练临时移除的状态，不冒充每日backup DoD完成。
- 验证：
  - `node --check /tmp/delivery-loop-github-app-bootstrap.mjs` → exit 0；本地status在清理前返回`phase=complete`、App/installation/repository/permission/event安全标量全部匹配，未返回pem、token或webhook secret。
  - GitHub安装完成页与settings页事实：owner=`evilstar9527`、installation=`149587996`、Only select repositories、Selected 1 repository=`evilstar9527/delivery-loop`、权限code/metadata read + Actions write。额外尝试用普通`gh` OAuth token读取`/user/installations`和repository inventory均按GitHub契约403，未扩scope、未把这两条失败调用当证据；安装inventory证据来自前述App installation audit token与settings页。
  - `CLOUDFLARE_ACCOUNT_ID=... pnpm exec wrangler secret list` → exit 0，只输出Secret名称；`GITHUB_APP_PRIVATE_KEY`、`OPERATIONS_TOKEN`、`TASK_INTAKE_TOKEN`均存在，无值输出。
  - `pnpm exec vitest run test/external-fact-reconciliation-config.test.ts test/outbox-dead-letter-config.test.ts test/data-retention-config.test.ts` → exit 0，3 files / 3 tests。
  - `CLOUDFLARE_ACCOUNT_ID=... pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-worker-config-dry-run` → exit 0，完整D1/R2/Queue/Workflow/GitHub/OIDC/model bindings可解析；随后真实`wrangler deploy` → exit 0，Worker version `026915b2-d688-4711-a10e-6aaa970117a9`；`GET /healthz` → 200 `{"ok":true,"service":"delivery-loop-control-plane"}`。
  - `pnpm run verify` → exit 0：typecheck、ESLint、Node 104 files / 418 tests、workerd 57 files / 308 tests、484文件Secret scan与docs links全绿；workerd清理时的`User called terminate`仍是既有主动终止诊断，不是测试失败或skip。
- 勾选：在Phase 1 hibernate条目新增并勾选“真实GitHub App前置”；把原先混合的“单仓库installation + Action实际触发”拆成已完成installation子项和仍未完成的真实Action子项。父级GitHub dispatcher与hibernate条目保持未勾，避免用配置事实冒充Action/hibernate事实。
- 遗留：repository Actions Secrets仍没有`OPENAI_API_KEY`。该Secret必须由owner在GitHub安全设置页录入，不从Codex登录态、keychain、shell history或聊天提取；存在后才创建真实Task并执行wait期间唯一redeploy与strict external verifier。

## Round 145 — 2026-07-28
- 目标：继续 Phase 1 / `DeliveryRunWorkflow` 真实 Cloudflare hibernate/redeploy；本轮只复核Round 144的唯一外部前置，不创建缺模型凭证的半链路Task。
- 前置与权限：只读GitHub repository Secret名称inventory、Worker health和本地worktree；未读取Secret值，未触发Action、模型、Task、Workflow signal或新deployment。
- 动作：
  - 再次读取`evilstar9527/delivery-loop` Actions Secret inventory，结果仍为空；不能从Codex登录态、keychain、浏览器字段或聊天提取`OPENAI_API_KEY`，也不能用空值/假key触发真实计费链路。
  - Round 144已把GitHub Actions Secret新建页打开，预填名称`OPENAI_API_KEY`并把焦点留在Secret值输入框；owner尚未提交前不重复打开页面、不创建Task、不做Worker after deployment。
  - 该相同前置已在Round 143、144、145连续出现；按`LOOP.md` §2与仓库AGENTS纪律停止盲重试，记录最小人工输入后暂停本DoD，避免把等待用户输入伪装为工程进展。
- 验证：
  - `pwd && git status --short --branch` → exit 0，仍在`/Users/jishihe/delivery-loop`的`codex/phase1-hibernate-live`，仅DOD/PROGRESS/wrangler本轮相关改动。
  - `gh secret list --repo evilstar9527/delivery-loop` → exit 0且输出为空，证明当前repository Actions Secret inventory没有可用条目；命令不返回Secret值。
  - `GET https://delivery-loop-control-plane.eve55265.workers.dev/healthz` → 200 `{"ok":true,"service":"delivery-loop-control-plane"}`，只证明Worker存活，不替代GitHub/模型/Workflow E2E。
- 勾选：无；真实hibernate、真实Action、dispatcher父项全部保持未勾。
- 决策沉淀：无规范变更；按既有Secret最小权限与三轮blocker规则执行。
- Blocker与最小人工输入：owner在`https://github.com/evilstar9527/delivery-loop/settings/secrets/actions/new`保存名为`OPENAI_API_KEY`的有效Secret（值只进入GitHub页面，不发到聊天），然后回复“已保存”。恢复后先只读确认Secret名称存在，再创建唯一真实Task并执行正式hibernate窗口。

## Round 146 — 2026-07-28
- 目标：继续Phase 1真实hibernate前置；owner明确没有官方OpenAI key而使用第三方中转，本轮只闭环Codex官方支持的key/base URL接线、安全边界与可重跑本地证据，不在`OPENAI_BASE_URL`外部配置就绪前创建真实Task。最终父项关门命令仍是`DELIVERY_LOOP_WORKFLOW_HIBERNATE_E2E=1 ... pnpm run e2e:workflow-hibernate` exit 0。
- 外部配置事实：`gh secret list --repo evilstar9527/delivery-loop`只读输出名称`OPENAI_API_KEY`与更新时间`2026-07-28T12:47:04Z`，不返回值，Round 145 blocker因此解除。`gh variable list --repo evilstar9527/delivery-loop`当前为空；GitHub Actions Variable新建页已预填名称`OPENAI_BASE_URL`，Value与保存动作留给owner，未读取clipboard、浏览器存储或任何credential。
- 规范裁决：按Codex官方manual，built-in OpenAI provider使用`openai_base_url`，CLI支持`-c key=value`单次覆盖，非交互API key使用进程变量`CODEX_API_KEY`。因此保留owner已录入的GitHub Secret名`OPENAI_API_KEY`，只在固定analysis/execution step映射为`CODEX_API_KEY`；普通repository Variable `OPENAI_BASE_URL`映射给Runner后，经trim/2048字符/公网HTTPS/无userinfo-query-fragment/非IP与非localhost/`.local`/`.internal`校验及尾斜杠规范化，再作为`-c openai_base_url="<validated-url>"`传入。两者都不增加dispatch input，不写仓库配置/argv key/控制面/Plan/artifact/日志。
- 第三方边界：中转站必须兼容OpenAI Responses API并支持D1 immutable profile绑定的`gpt-5.6-terra`；HTTPS校验不代表数据受OpenAI官方政策保护，中转方仍可看到Task、代码、诊断上下文、prompt和模型输出，接入前需owner确认数据保留/访问政策。中转返回仍是不可信Agent输出，不能提升effect、命令或credential authority。`docs/Proto.md`、`docs/Security.md`、`docs/Reference.md`已同步；按owner要求不更新llmdoc。
- 实现与测试：先为analysis/execution adapter和fixed workflow写失败测试，首次定向运行exit 1（3 files，15 failed / 12 passed）。随后两个adapter增加同一严格URL边界，Runner传递可选`OPENAI_BASE_URL`，workflow完成Secret/Variable映射；修复后定向`pnpm exec vitest run test/codex-analysis-adapter.test.ts test/codex-execution-adapter.test.ts test/delivery-agent-workflow.test.ts` → exit 0，3 files / 27 tests。`pnpm run typecheck`首次因`exactOptionalPropertyTypes`的两处field声明exit 2，改为显式`string | undefined`后exit 0；`pnpm run lint`与`git diff --check`均exit 0。
- 全量验证：首次`pnpm run verify`的Node阶段为103 files / 430 passed、1个既有same-PR Git远端竞态test在默认5秒超时；独立复跑仍在5秒超时，但`--testTimeout=20000`时2/2通过且完整用时约8秒，证明不是语义失败。为该真实多repo/clone/push测试设置局部15秒上限后默认定向2/2通过。最终`pnpm run verify` → exit 0：typecheck、ESLint、Node 104 files / 431 tests、workerd 57 files / 308 tests、484文件Secret scan与docs links全绿；workerd主动terminate诊断仍不是skip。
- 默认分支交付：按`pre-pr-rebase-main`技能先fetch/评估最新`origin/main`，branch/main无重叠或冲突且历史线性；提交`d8dafa2`并推送后创建PR [#18](https://github.com/evilstar9527/delivery-loop/pull/18)。PR required CI [30362722449](https://github.com/evilstar9527/delivery-loop/actions/runs/30362722449) success（3m59s），reviews/requested changes/line comments均为空；以rebase merge合入`main` head `81998c894ab5badaba7b8dcf6e6ea1e220dd8cf4`。合并后main CI [30363071855](https://github.com/evilstar9527/delivery-loop/actions/runs/30363071855)再次success（3m58s）；Node 20 Action被平台强制到Node 24的既有MINOR提示仍不阻塞本轮。随后本地branch rebase到新`origin/main`，两个patch-equivalent commit按Git识别安全跳过。
- 勾选：在Phase 1真实Action下新增并勾选“第三方中转本地配置契约”与“fixed workflow进入默认分支”；真实Action、dispatcher、hibernate父项保持未勾。当前唯一人工前置是owner保存`OPENAI_BASE_URL`；默认分支代码已就绪，保存后只读核对安全形状与Responses API/exact-model兼容性，再启动唯一真实Task与wait期间唯一redeploy。

## Round 147 — 2026-07-28
- 目标：继续Phase 1唯一hibernate DoD；在repository Variable仍未保存时，不用唯一真实Task试错第三方provider，而是补齐无Task/Run/dispatch的exact-route/exact-model preflight。最终父项关门仍只接受真实`pnpm run e2e:workflow-hibernate` exit 0。
- 当前外部事实：`gh secret list`只显示`OPENAI_API_KEY`名称；`gh variable list`仍为空。浏览器已把当前可见GitHub tab导航到Actions Variable新建页并只预填`OPENAI_BASE_URL`，未读取Value、clipboard、浏览器存储或credential。长生命周期受控shell中的Task/operations token仍仅在内存且未输出；本轮没有Task、Run、模型调用、GitHub workflow dispatch或Cloudflare deployment。
- 缺口与裁决：Round 146只把analysis/execution adapter接到relay；现有真实`CodexSessionAdapter`验收仍依赖`codex login status`、没有base URL和exact model，因此无法在不消耗唯一Task的情况下证明第三方route兼容Responses API与D1 profile model。裁决为直接复用已有ephemeral/read-only/strict output/checkpoint/Git-clean脚本，增加最小手动preflight workflow；不以curl`/models`或新建第二套探针冒充真实Codex调用。
- 实现：session adapter增加与analysis/execution相同的trim/2048字符/公网HTTPS/无userinfo-query-fragment/非IP与非localhost/`.local`/`.internal`校验、尾斜杠规范化，以及最长200字符受限exact model；CLI只接收`-c openai_base_url=... --model ...`，key仍只在进程环境。真实adapter脚本在`CODEX_API_KEY`存在时不要求本机login，按可选`OPENAI_BASE_URL`和`DELIVERY_LOOP_CODEX_ADAPTER_MODEL`构造adapter。`.github/workflows/codex-provider-preflight.yml`只有手动`workflow_dispatch`、`contents:read`、无inputs/Environment/OIDC/write，固定`gpt-5.6-terra`，安全manifest只写`RUNNER_TEMP`且不上传；它不读真实Task或控制面。
- 测试与规范：先写session URL/model、CI auth/base/model及workflow权限/固定Action SHA测试；首次定向运行exit 1，3 files中12 failed / 5 passed。实现后同命令exit 0，3 files / 17 tests。`pnpm run typecheck`、`pnpm run lint`、`git diff --check`均exit 0。`docs/Proto.md`、`docs/Security.md`、`docs/Reference.md`、`docs/AgentAdapterE2E.md`同步provider/preflight边界；按owner要求不更新llmdoc。
- 全量验证：`pnpm run verify` → exit 0：typecheck、ESLint、Node 105 files / 442 tests、workerd 57 files / 308 tests、485文件Secret scan与docs links全绿；workerd主动terminate诊断不是skip。
- 默认分支交付：fetch后本地HEAD与`origin/main`同为`81998c894ab5badaba7b8dcf6e6ea1e220dd8cf4`，无main漂移、文件重叠或冲突；提交`836c68b`后以`--force-with-lease`把已rebase的branch安全替换远端旧branch，创建PR [#19](https://github.com/evilstar9527/delivery-loop/pull/19)。required PR CI [30364417473](https://github.com/evilstar9527/delivery-loop/actions/runs/30364417473) success（4m07s），reviews/requested changes/line comments均为空；rebase merge后`main` head为`cbd54cd6eedbf9bdfe7bf292a68ddb9f5344b2cc`，合并后main CI [30364817881](https://github.com/evilstar9527/delivery-loop/actions/runs/30364817881)再次success（4m31s）。Node 20 Action被平台强制到Node 24的既有MINOR提示仍不阻塞本轮；本地branch随后rebase到新main并安全跳过patch-equivalent commit。
- 勾选：Phase 1真实Action下新增并勾选provider preflight本地契约与默认分支交付；真实preflight Action子项保持未勾，analysis Action/dispatcher/hibernate父项保持未勾。preflight已在main就绪，下一步是owner保存Variable后只读核对URL安全形状并手动运行一次；只有completed/success后才创建唯一真实Task。

## Round 148 — 2026-07-28
- 目标：继续Phase 1唯一hibernate DoD；只读复核第三方provider最后一个人工前置并按`LOOP.md` §2执行三轮blocker裁决，不以空配置preflight、失败Action或Task试错伪造进展。
- 前置与权限：只读GitHub repository Secret/Variable名称inventory和本地branch/main状态；未读取Secret/Variable值，未访问clipboard/浏览器存储，未触发preflight、Delivery Agent、模型、Task、Workflow signal或Cloudflare deployment。
- 外部事实：`gh secret list --repo evilstar9527/delivery-loop` → exit 0，只显示`OPENAI_API_KEY`名称与既有更新时间；`gh variable list --repo evilstar9527/delivery-loop` → exit 0且为空。local HEAD与`origin/main`均为`cbd54cd6eedbf9bdfe7bf292a68ddb9f5344b2cc`，证明PR #19的preflight已在默认分支；本地仅DOD/PROGRESS证据收尾改动。
- 已尝试路径：Round 146完成analysis/execution relay接线并合入main；Round 147补齐session adapter、CI key/exact-model和无Task preflight，17/17、full verify、PR/main CI全绿并合入main；浏览器两次把可见GitHub tab导航到Variable新建页且只预填`OPENAI_BASE_URL`。继续轮询、猜URL、读取clipboard/keychain、用空URL运行preflight或直接创建Task均不能产生合法证据，反而会污染唯一外部演练窗口。
- 验证：`pnpm run verify` → exit 0：typecheck、ESLint、Node 105 files / 442 tests、workerd 57 files / 308 tests、485文件Secret scan与docs links全绿；`git diff --check` exit 0。Variable inventory仍为空。没有运行`pnpm run e2e:workflow-hibernate`或provider preflight，因默认/缺配置exit 2或失败Action都不能关门。
- 勾选：无；真实provider preflight、analysis Action、dispatcher与hibernate父项保持未勾。
- Blocker与最小人工输入：同一`OPENAI_BASE_URL`缺失已在Round 146、147、148连续三轮出现。按`LOOP.md` §2停止盲重试；owner在当前GitHub Actions Variable页面填写无credential/query/fragment的公网HTTPS Base URL并点击`Add variable`，然后回复“已保存”。恢复后第一步只读核对名称/安全形状，第二步只触发一次无Task provider preflight；success后才进入唯一Task/redeploy窗口。

## Round 149 — 2026-07-28
- 目标：恢复Phase 1唯一hibernate DoD；复用owner已实际保存的repository Secret，不要求重复填写中转地址。最终关门仍只接受真实`DELIVERY_LOOP_WORKFLOW_HIBERNATE_E2E=1 ... pnpm run e2e:workflow-hibernate` exit 0。
- 外部配置事实：按安全inventory只读核对，repository Actions Variables仍为空；repository Actions Secrets包含`OPENAI_API_KEY`与`OPENAI_BASE_URL`，后者更新时间为`2026-07-28T15:23:57Z`。GitHub Secret值不可回读，因此本轮没有取得、打印或持久化URL；URL安全形状、Responses兼容和exact model只能由固定preflight进程内校验。
- 决策与实现：现有fixed analysis/preflight workflow读取`${{ vars.OPENAI_BASE_URL }}`，直接触发会得到空值。为最大复用owner已完成的配置，把两个workflow的三个注入点切换为`${{ secrets.OPENAI_BASE_URL }}`；adapter原有trim/2048字符/公网HTTPS/无userinfo-query-fragment/非IP与非本地域名校验保持不变。`docs/Proto.md`、`docs/Security.md`与`docs/Reference.md`同步说明Secret是更严格的存储边界，不把base URL变成第二凭证通道；按owner要求不更新llmdoc。
- 红绿证据：先只改workflow契约测试，`pnpm exec vitest run test/codex-provider-preflight-workflow.test.ts test/delivery-agent-workflow.test.ts`按预期exit 1，2 files / 2 failed，实际值仍为`${{ vars.OPENAI_BASE_URL }}`；实现后同命令exit 0，2 files / 2 tests。随后`pnpm run typecheck`、`pnpm run lint`、`pnpm run verify:docs`与`git diff --check`均exit 0。
- 全量验证：`pnpm run verify` → exit 0：typecheck、ESLint、Node 105 files / 442 tests、workerd 57 files / 308 tests、485文件Secret scan与docs links全绿；workerd的`User called terminate`仍是既有主动清理诊断，不是失败或skip。
- 唯一触发约束：`gh run list --workflow codex-provider-preflight.yml`返回空数组，证明当前没有历史preflight run；兼容补丁进入`main`前不触发，进入后只触发一次。当前没有创建Task、Run、Action attempt、Workflow signal或Cloudflare deployment。
- 默认分支交付：提交`ab9c15e`后以`--force-with-lease`安全更新已rebase分支，创建PR [#21](https://github.com/evilstar9527/delivery-loop/pull/21)。required PR CI [30374289098](https://github.com/evilstar9527/delivery-loop/actions/runs/30374289098) success（4m14s），reviews/requested changes/line comments均为空；rebase merge后`main` head为`78f2cb5c0e90327732ef11dbf058e72d098ad144`，合并后main CI [30374682076](https://github.com/evilstar9527/delivery-loop/actions/runs/30374682076)再次success（3m51s）。Node 20 Action被平台强制到Node 24的既有MINOR提示仍不阻塞本轮。
- 真实preflight：在确认历史run为0且兼容补丁/main CI成功后，只触发一次 [30375032363](https://github.com/evilstar9527/delivery-loop/actions/runs/30375032363)。该run为`completed/failure`，唯一`Verify exact provider route` step在约30秒后失败；只从GitHub failed log筛选仓库内固定安全行，结论为`real-codex-adapter-e2e: FAIL provider_process_failed`与process exit 1，没有复制第三方raw response、Secret值、URL、Task或模型正文。失败后未创建Task、Run、analysis Action、Workflow signal或Cloudflare deployment，也未重试preflight。
- 勾选：Secret兼容默认分支子项已勾；真实preflight、analysis Action、dispatcher和hibernate父项保持未勾，失败Action不冒充成功。
- Blocker与最小人工输入：当前固定分类无法在不暴露raw stderr的前提下区分中转认证、Responses API route或`gpt-5.6-terra` exact model不兼容。下一步需provider名称/公开兼容文档，或由owner确认该中转实际支持的exact model标识；不需要也不要提供Base URL或key。核对后才能有依据地调整profile/preflight并决定是否执行一次受控修复后复验。

## Round 150 — 2026-07-29
- 目标：继续Phase 1唯一hibernate DoD；修复首次真实provider preflight只返回generic错误、无法安全区分认证/model/Responses route的诊断缺口。最终父项仍只接受真实`DELIVERY_LOOP_WORKFLOW_HIBERNATE_E2E=1 ... pnpm run e2e:workflow-hibernate` exit 0。
- 前置与权限：只读核对local/`origin/main`均为`4fac8426e52e241dca78db43b2b8e834e82d7c1d`且worktree clean；GitHub preflight inventory仍恰有一条`30375032363 completed/failure`。本轮未读取Secret值、第三方raw response或历史raw stderr，未触发provider、Task、Run、Action attempt、Workflow signal或Cloudflare deployment。
- 设计与安全边界：新增纯函数只消费共享command runtime已经按当前敏感环境值脱敏的stderr，并再次限制为前8,192字符；固定返回认证、quota、限流、model、endpoint、Responses兼容、upstream、timeout、network、CLI contract或generic共11个枚举。model-specific 404优先于generic endpoint；未知或包含URL/query/key形状的恶意文本只能得到`provider_process_failed`。分类器不返回raw文本，raw stderr、第三方response、URL及其digest都不进入Action log、artifact、manifest、D1或PROGRESS。
- 红绿证据：先新增`test/provider-preflight-failure.test.ts`，首次`pnpm exec vitest run test/provider-preflight-failure.test.ts test/real-codex-adapter-verifier.test.ts`按预期exit 1，provider classifier模块不存在且另一verifier 2项通过；实现并把真实adapter verifier接到分类器后，同命令exit 0，2 files / 19 tests。`pnpm run typecheck`与`pnpm run lint`均exit 0。
- 规范同步：`docs/Proto.md`、`docs/Security.md`、`docs/Reference.md`与`docs/AgentAdapterE2E.md`同步固定分类、原文不出进程和两个repository Secret边界；按owner要求不更新llmdoc。
- 全量验证：`pnpm run verify` → exit 0：typecheck、ESLint、Node 106 files / 459 tests、workerd 57 files / 308 tests、486文件Secret scan与docs links全绿；workerd的`User called terminate`仍是既有主动清理诊断，不是失败或skip。
- 默认分支交付：提交`8eb3f31`后推送线性分支并创建PR [#23](https://github.com/evilstar9527/delivery-loop/pull/23)。required PR CI [30377207983](https://github.com/evilstar9527/delivery-loop/actions/runs/30377207983) success（3m54s），reviews/requested changes/line comments均为空；rebase merge后`main` head为`0957675725f13e3971d36afede6858f95ea093ba`，合并后main CI [30377572108](https://github.com/evilstar9527/delivery-loop/actions/runs/30377572108)再次success（4m09s）。Node 20 Action被平台强制到Node 24的既有MINOR提示仍不阻塞本轮。
- 修复后真实诊断：按`LOOP.md`§2“第一次失败且修复后必须复验”仅触发一次 [30377965649](https://github.com/evilstar9527/delivery-loop/actions/runs/30377965649)。run为`completed/failure`，exact provider step约36秒后失败；只筛选verifier固定行得到`provider_network_failed`与process exit 1，没有复制raw stderr、第三方response、URL、credential、Task或模型正文。preflight inventory现恰为首次generic失败与本次network失败两条；本轮不再重试。
- 勾选：新增并勾选provider失败安全分类本地契约及默认分支交付；真实preflight、analysis Action、dispatcher和hibernate父项保持未勾，失败Action不冒充成功。
- 遗留：`provider_network_failed`仍覆盖DNS/TCP/TLS与连接中断。下一轮先实现无模型、无API key、只输出固定枚举的Runner DNS/TLS reachability probe；探针通过后再判断是否需要把stream interruption从network分类中独立出来，失败则请求provider确认GitHub Actions网络准入。provider success前不创建唯一hibernate Task。

## Round 151 — 2026-07-29
- 目标：继续Phase 1唯一hibernate DoD；只闭环无模型、无API key的GitHub Runner DNS/TCP/TLS安全探针本地契约，provider成功前不创建唯一Task。真实hibernate父项仍只接受`DELIVERY_LOOP_WORKFLOW_HIBERNATE_E2E=1 ... pnpm run e2e:workflow-hibernate`读取live Cloudflare/D1/GitHub事实exit 0。
- 前置与权限：本地Node/Vitest、公开Watt固定commit、GitHub PR/CI只读与既有PR #24 rebase merge；没有读取两个repository Secret的值，没有触发provider network workflow、Codex/模型、Task/Run/Attempt、Workflow signal或Cloudflare deployment。探针真实运行必须等受审workflow进入`main`后且最多一次。
- 上轮证据收口：PR [#24](https://github.com/evilstar9527/delivery-loop/pull/24) required CI [30378323962](https://github.com/evilstar9527/delivery-loop/actions/runs/30378323962) success，reviews/requested changes/issue comments/line comments均为空；以rebase merge合入`main` head `d25210887c719940ca866f8cb3c7a126580a1474`，合并后main CI [30378808495](https://github.com/evilstar9527/delivery-loop/actions/runs/30378808495)再次success。随后按`pre-pr-rebase-main`技能把本地branch rebase到该head，patch-equivalent旧证据提交被Git安全跳过且无冲突。
- Watt复用核对：对`/Users/jishihe/tokenrollal/Watt`固定commit`476e3cdd2490d725fde174e7c697ebf00899edc6`检索DNS lookup、TCP/TLS socket、OpenAI base URL和network preflight，只在其`PROGRESS.md`发现一次curl/DoH人工诊断，没有生产探针/parser/安全枚举可复制，等价业务代码直接复制量为零。本轮继续遵循项目已从Watt派生的显式opt-in、0/1/2退出与固定安全错误纪律，没有复制会传播raw curl/provider错误的路径。
- 设计与实现：
  - 抽出唯一`provider-base-url`真源，三个Codex adapter与新探针共同复用原有trim/2048字符/公网HTTPS/无userinfo-query-fragment/非IP与非本地域名/尾斜杠规范化契约；既有adapter argv行为不变。
  - 独立探针只读取`OPENAI_BASE_URL`。最长10秒DNS lookup后拒绝没有公网地址的结果，直接连接最多四个受控解析IP避免DNS rebinding；TCP使用validated endpoint port（缺省443），TLS以原hostname做SNI并启用系统CA/hostname验证。底层hostname/IP/URL/证书/error/digest没有返回或日志容器。
  - 固定结果只有8个allowlisted code与`dns/tcp/tls`布尔值。新手动workflow只有`contents:read`，无inputs/Environment/OIDC/write，只注入显式opt-in和base URL Secret；不注入`OPENAI_API_KEY/CODEX_API_KEY`、不启动Codex/provider HTTP/模型、不上传artifact。
- 验证：
  - 先写`test/provider-network-preflight{,-workflow}.test.ts`，首次`pnpm exec vitest run test/provider-network-preflight.test.ts test/provider-network-preflight-workflow.test.ts`按预期exit 1：探针模块与workflow不存在、package script缺失（1 suite / 2 tests failed）。
  - 实现后`pnpm exec vitest run test/provider-network-preflight.test.ts test/provider-network-preflight-workflow.test.ts test/codex-analysis-adapter.test.ts test/codex-execution-adapter.test.ts test/codex-session-adapter.test.ts` → exit 0，5 files / 80 tests。覆盖URL/missing opt-in、DNS错误、21类IPv4/IPv6非公网解析与公网IPv6、TCP失败、TLS/证书失败、全通过、固定安全输出、workflow权限/Secret shape及三个既有adapter无回归。
  - `pnpm run e2e:provider-network`（无opt-in）→ exit 2，固定`provider-network-preflight: opt-in missing`，在URL/Secret/network前结束。
  - `pnpm run typecheck`、`pnpm run lint`、`pnpm run verify:docs`、`pnpm run verify:secrets`与`git diff --check` → exit 0；Secret scan为490个生产文件。
  - `pnpm run verify` → exit 0：typecheck、ESLint、Node 108 files / 499 tests、workerd 57 files / 308 tests、490文件Secret scan和docs links全绿；workerd既有主动terminate诊断不是失败或skip。
- 勾选：Phase 1真实Action下新增并勾选“provider network preflight本地契约”；真实network Action、真实provider preflight、analysis Action、dispatcher和hibernate父项保持未勾。本地fake resolver/socket、默认exit 2或workflow源码不能替代GitHub Runner事实。
- 决策沉淀：`docs/Proto.md`、`docs/Security.md`、`docs/Reference.md`和`docs/AgentAdapterE2E.md`同步DNS rebinding、公网地址、SNI/CA/hostname验证、固定输出及diagnostic-only边界；按owner要求不更新llmdoc。
- 遗留：先把探针经PR/main CI进入默认分支，再只手动运行一次。若DNS/TCP/TLS失败，请provider确认GitHub Actions网络准入、解析或证书链；若三层全通过，则把Codex连接中断从generic network继续拆为stream/route诊断。任一结果都不创建Task或冒充provider/hibernate成功。

## Round 152 — 2026-07-29
- 目标：继续Phase 1唯一hibernate DoD；只闭环provider network preflight的默认分支交付与唯一真实GitHub Runner事实，不调用Codex/provider HTTP/模型、不创建Task。真实hibernate父项仍只接受`DELIVERY_LOOP_WORKFLOW_HIBERNATE_E2E=1 ... pnpm run e2e:workflow-hibernate`读取live Cloudflare/D1/GitHub事实exit 0。
- 默认分支交付：provider network探针PR [#25](https://github.com/evilstar9527/delivery-loop/pull/25)以rebase merge合入`main` head `85003690d499395e0f5fcf87837c08328d831ee3`。required PR CI [30381383721](https://github.com/evilstar9527/delivery-loop/actions/runs/30381383721)为`completed/success`且绑定PR head `35e6c52bc39c3cb793270428eda8474007ddec3d`；合并后main CI [30381744753](https://github.com/evilstar9527/delivery-loop/actions/runs/30381744753)为`completed/success`且绑定merge head。`gh pr view 25`只读复核reviews/requested changes/issue comments均为空，PR API同样没有普通或行内评论。
- 唯一真实探针：workflow inventory在运行前为0，进入main后只手动触发一次 [30382103409](https://github.com/evilstar9527/delivery-loop/actions/runs/30382103409)。run为`workflow_dispatch + completed/success + run_attempt=1`，唯一job `90352201949`及命名step `Probe provider network`均success；安全筛选日志只得到固定行`provider_network_preflight_passed dns=true tcp=true tls=true`。运行后的100条inventory恰好只有该run，未重跑。
- 安全与解释：该workflow只读取`OPENAI_BASE_URL`，没有读取`OPENAI_API_KEY/CODEX_API_KEY`、启动Codex、向provider发送HTTP、上传artifact、创建Task/Run/Attempt、发Workflow signal或部署Cloudflare。固定成功排除当时GitHub Runner到同一endpoint的DNS、公网TCP和TLS证书链故障，但不能证明Responses route/SSE stream/认证/exact model成功。
- owner上下文：owner确认同一中转站支持OpenAI调用形式且本地Codex正在使用；该事实降低协议/key错误概率，但本机成功不能替代GitHub Runner上的exact preflight。
- 勾选：Phase 1“provider network preflight进入默认分支”与“provider network preflight真实Action”已勾；真实provider preflight、analysis Action、dispatcher和hibernate父项保持未勾。

## Round 153 — 2026-07-29
- 目标：继续Phase 1唯一hibernate DoD；在DNS/TCP/TLS已排除后，只把Codex Responses stream interruption从普通network安全分类中独立出来。第12个分类进入默认分支前不重跑模型，provider success前不创建唯一Task。
- 官方事实：仓库锁定`@openai/codex 0.145.0`；官方`openai/codex` tag `rust-v0.145.0`解析到commit `25af12f7e61572b0bc18ddb1008be543b91519b0`。该源码的`CodexErr::Stream`固定展示`stream disconnected before completion: {detail}`，Responses SSE与WebSocket在`response.completed`前结束时使用`stream closed before response.completed`；session通过`stream_max_retries`重试，官方配置参考默认5次、`stream_idle_timeout_ms`默认300000ms、`wire_api=responses`为唯一支持协议。来源固定在`docs/Reference.md`，没有读取本机Codex配置、session或历史日志。
- 第一性裁决：新增`provider_stream_interrupted`并置于普通network之前；只匹配上述官方外层或同一行明确带Responses/SSE stream语义的提前close/end/interruption。裸`connection closed before response.completed`与`connection reset by peer`仍为`provider_network_failed`，timeout仍保持`provider_timeout`，未知/credential-shaped恶意文本仍收敛generic。分类器仍只消费已脱敏且最多8 KiB stderr，不返回或持久化raw provider文本。
- 红绿证据：先只改`test/provider-preflight-failure.test.ts`，`pnpm exec vitest run test/provider-preflight-failure.test.ts`按预期exit 1，5项失败（四个stream case仍为generic/network且inventory仍为11）。实现第12个固定枚举与窄regex后，同命令exit 0，1 file / 24 tests；随后`pnpm exec vitest run test/provider-preflight-failure.test.ts test/real-codex-adapter-verifier.test.ts` exit 0，2 files / 26 tests。普通TCP负例、官方SSE/WS文本、reverse-order SSE语义、枚举唯一性与既有恶意文本边界均覆盖。
- Watt复用核对：固定commit`476e3cdd2490d725fde174e7c697ebf00899edc6`仅在`packages/toolbridge/vendor/{index.ts,tb/mcp-client.ts}`有MCP专用SSE读取和`MCP SSE stream ended...` throw，没有Codex provider retry、failure classifier或安全枚举。直接复制会把MCP transport与模型provider混为一谈，等价业务代码复制量为零；现有8 KiB有界错误、固定枚举与0/1/2纪律继续复用本项目此前从Watt派生的安全骨架。
- 规范同步：`docs/Proto.md`、`docs/Security.md`、`docs/Reference.md`、`docs/AgentAdapterE2E.md`与`DOD.md`同步第12枚举、官方源码锚点、network负例和真实network run；按owner要求不更新llmdoc。
- 验证：`git diff --check`与`pnpm run verify:docs`先行exit 0；最终`pnpm run verify` exit 0：typecheck、ESLint、Node 108 files / 506 tests、workerd 57 files / 308 tests、490文件Secret scan和docs links全绿。workerd既有`User called terminate`是主动清理诊断，不是失败或skip。
- 勾选：Phase 1“provider stream interruption本地分类契约”已勾；真实provider preflight、analysis Action、dispatcher和hibernate父项保持未勾。本轮没有模型/Task/Action dispatch/Workflow signal/Cloudflare deployment。
- 遗留：按`pre-pr-rebase-main`纪律把本轮分类补丁进入默认分支并等待PR/main CI；之后才决定是否进行一次受控模型preflight复验。复验如收敛为`provider_stream_interrupted`，优先审查中转的SSE长连接/代理idle或提前EOF；只有`completed/success`后才创建唯一hibernate Task。

## Round 154 — 2026-07-29
- 目标：继续Phase 1唯一hibernate DoD；先交付stream分类，再在已确认Secret、同一中转、本机兼容和真实network成功的前提下只做一次无Task模型preflight复验。provider success前仍不创建唯一Task或进入hibernate deployment窗口。
- 默认分支交付：按`pre-pr-rebase-main`技能确认本地HEAD与最新`origin/main`均为`85003690d499395e0f5fcf87837c08328d831ee3`、无重叠或冲突风险；提交`02de0a8`后以`--force-with-lease`更新旧PR分支并创建PR [#26](https://github.com/evilstar9527/delivery-loop/pull/26)。required PR CI [30383744242](https://github.com/evilstar9527/delivery-loop/actions/runs/30383744242) success（4m00s），PR为`MERGEABLE/CLEAN`且reviews/requested changes/普通评论/行内评论均为空；rebase merge后`main` head为`6adf875544c4f44105c8de6136cc2adb428e1e84`，合并后main CI [30384104677](https://github.com/evilstar9527/delivery-loop/actions/runs/30384104677)再次success（5m20s）。Node 20 Action被平台强制到Node 24仍是既有MINOR提示。
- 复验前置：model preflight inventory恰有此前两条failure，两个repository Secret名称仍存在且值未读取；main CI成功且stream分类已生效。owner确认中转支持OpenAI调用形式并被本地Codex使用；只读命令确认系统`codex --version`与仓库`pnpm exec codex --version`均为`codex-cli 0.145.0`，版本差异排除。官方manual确认built-in OpenAI只能用`openai_base_url`改地址，不能覆盖`model_providers.openai`；per-provider stream tuning必须使用custom provider。
- 唯一受控复验：只触发一次 [30384572465](https://github.com/evilstar9527/delivery-loop/actions/runs/30384572465)。run为`workflow_dispatch + completed/failure + run_attempt=1`，checkout、pnpm、Node与locked install均success，只有`Verify exact provider route`失败；从failed log只筛选12枚举得到唯一`provider_stream_interrupted`，没有读取或记录raw stderr/provider response、URL、credential、模型正文或错误digest。
- 解释与安全裁决：结果结合真实`dns=true tcp=true tls=true`，把问题收敛到Codex等待`response.completed`前stream终止；它仍不能区分本地exact model/provider profile差异、中转对GitHub Runner SSE路径的特殊行为或代理提前EOF。默认5次stream retry已在约29秒失败，盲目提高重试只会重复同一未知effect，当前不新增custom provider、不再次触发模型。
- 勾选：Phase 1“provider stream interruption分类进入默认分支”已勾；真实provider preflight、analysis Action、dispatcher和hibernate父项保持未勾。本轮没有Task/Run/Attempt、Workflow signal或Cloudflare deployment。
- Blocker与最小人工输入：owner只需从本地可用Codex配置中确认非敏感字段`model`、`model_provider`、`wire_api`、`stream_max_retries`（未配置写“默认”）；不要提供或粘贴`base_url/openai_base_url`、Key、headers、auth或整个配置文件。取得这些字段后，先做profile diff和本地测试，再决定一次受控修复，不盲重试。

## Round 155 — 2026-07-29
- 目标：继续Phase 1唯一hibernate DoD；解释并修复“相同Key/Base URL，本机CC Switch成功而GitHub provider preflight stream中断”的请求profile不等价问题。真实hibernate父项仍只接受`DELIVERY_LOOP_WORKFLOW_HIBERNATE_E2E=1 ... pnpm run e2e:workflow-hibernate`读取live Cloudflare/D1/GitHub事实exit 0；补丁进入main前不触发模型，provider success前不创建Task。
- 安全profile diff：只读取`~/.cc-switch/cc-switch.db`中白名单化的非敏感配置字段与最近成功请求投影，未读取或输出Key、Base URL、headers、session/history或raw日志。本机Codex 0.145.0使用custom provider、`wire_api=responses`、默认`supports_websockets=false`与high reasoning，最近成功实际模型为`gpt-5.6-sol`；GitHub同版本此前使用built-in OpenAI + `openai_base_url`，官方0.145.0源码固定built-in provider `supports_websockets=true`，preflight又锁定`gpt-5.6-terra`。因此两端虽然Key/URL相同，transport与exact model并不相同。
- 官方裁决：最新Codex manual确认built-in provider只能用`openai_base_url`改地址，reserved `openai` provider不能覆盖；只有custom provider能显式设置`wire_api`、`requires_openai_auth`和`supports_websockets`。OpenAI live GPT-5.6 guidance把Sol定位为复杂analysis/coding的旗舰并要求迁移时保留既有reasoning；owner本机有效设置为high。2026-07-29官方standard短上下文费率为Sol input $5.00、cached input $0.50、output $30.00/百万token。
- 红绿实现：
  - 先新增`test/codex-provider-profile.test.ts`并更新session/analysis/execution/workflow预期；`pnpm exec vitest run test/codex-provider-profile.test.ts test/codex-session-adapter.test.ts test/codex-analysis-adapter.test.ts test/codex-execution-adapter.test.ts test/codex-provider-preflight-workflow.test.ts`按预期exit 1：profile模块不存在，三个adapter仍生成built-in `openai_base_url`，workflow仍为Terra（5 files failed，37 tests passed / 4 failed + 1 failed suite）。
  - 新增唯一`codex-provider-profile`参数生成器；配置中转时固定`delivery_loop_relay`、Responses、`requires_openai_auth=true`、`supports_websockets=false`和high，Key继续只在`CODEX_API_KEY`进程环境。session/analysis/execution三条路径全部复用该生成器，未配置中转时官方built-in行为不变；preflight改为exact `gpt-5.6-sol`。同一命令转绿，5 files / 44 tests。
  - 再为Wrangler引用的immutable Sol/high D1 profile补红灯；`pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/quota-control.test.ts`按预期1/14失败，查询结果为null。migration 0062随后写入`delivery_loop_relay + gpt-5.6-sol`、200k/40k调用上限和官方价格整数快照；同suite 1 file / 14 tests及`test/d1-migration-wrangler-compat.test.ts` 1 file / 1 test均exit 0。Wrangler改为新profile ID；远程migration与Worker deploy尚未执行，不能冒充live配置生效。
- PR前五维自查发现migration若使用`INSERT OR IGNORE`会在远端预存同名错误profile时静默放过，违反可信immutable配置的fail-closed边界；改为普通`INSERT`并增加源码断言，任何同ID冲突都必须让migration失败并人工核对，不能让Wrangler静默指向错误model/价格。修正后Node 2 files / 4 tests、workerd quota 1 file / 14 tests、typecheck/lint/docs/diff均exit 0，并重新执行`pnpm run verify`得到Node 109/509、workerd 57/309、492文件Secret scan及docs links全绿；未发现其他BLOCKER/MAJOR。
- 规范与复用：`docs/Proto.md`、`docs/Security.md`、`docs/Reference.md`、`docs/AgentAdapterE2E.md`及`DOD.md`同步custom provider/transport/model/reasoning/quota边界；按owner要求不更新llmdoc。Watt固定commit没有Codex custom provider或OpenAI transport profile可直接复制，本轮最大化复用delivery-loop已有URL parser、三个adapter、immutable quota profile和Watt-derived显式opt-in/0-1-2证据纪律。
- 验证：聚焦Node `codex-provider-profile/session/analysis/execution/provider-workflow/delivery-workflow/real-verifier/migration`为8 files / 48 tests，workerd quota为1 file / 14 tests，均exit 0；`pnpm run typecheck`、`pnpm run lint`、`pnpm run verify:docs`、`pnpm run verify:secrets`与`git diff --check`均exit 0，Secret scan为492个生产文件。最终`pnpm run verify` exit 0：Node 109 files / 509 tests、workerd 57 files / 309 tests、492文件Secret scan与docs links全绿；workerd `User called terminate`仍是既有主动清理诊断，不是失败或skip。
- 当前外部边界：没有读取两个repository Secret值，没有重跑唯一network probe或provider workflow，没有创建Task/Run/Attempt、发送Workflow signal、执行Cloudflare migration/deploy或产生模型调用。下一步按受控PR流程进入main并等待CI；只有补丁进入main后才允许一次受控provider preflight，结果仍只读取固定安全枚举。

## Round 156 — 2026-07-29
- 目标：继续Phase 1唯一hibernate DoD；在Round 155补丁进入main且post-fix唯一provider preflight仍stream中断后，安全核对本机CC Switch是否存在尚未复制的Header、proxy、retry、storage或transport配置，并把blocker收窄到可交给中转方核对的服务端事实。真实hibernate父项仍只接受`DELIVERY_LOOP_WORKFLOW_HIBERNATE_E2E=1 ... pnpm run e2e:workflow-hibernate`读取live Cloudflare/D1/GitHub事实exit 0；本轮不创建Task、不执行Cloudflare migration/deploy、不再次调用模型。
- 默认分支证据：PR [#28](https://github.com/evilstar9527/delivery-loop/pull/28)已于2026-07-29以rebase merge进入`main` head `c1c477756096271c72636dda916c1ae326a25bc5`；required PR CI [30387835521](https://github.com/evilstar9527/delivery-loop/actions/runs/30387835521)与合并后main CI [30388182670](https://github.com/evilstar9527/delivery-loop/actions/runs/30388182670)均为success，PR无review/requested changes/普通或行内评论。
- post-fix唯一复验：只读查询 [30388564079](https://github.com/evilstar9527/delivery-loop/actions/runs/30388564079)确认其基于上述main head，`workflow_dispatch + completed/failure + run_attempt=1`；checkout、pnpm、Node与locked install均success，命名provider step从`18:45:11Z`运行至`18:45:29Z`后失败，唯一安全分类仍为`provider_stream_interrupted`。没有读取或记录raw stderr/provider response、URL、credential、模型正文或错误digest；该run不得再次重跑。
- CC Switch安全结构审计：只读取`~/.cc-switch/cc-switch.db`的schema、当前Codex provider TOML key path/type、非敏感proxy开关/timeout数值及`~/.codex/config.toml`的安全布尔投影；未输出Key、Base URL、Header值、session/history或raw provider日志。当前provider只有OpenAI auth和config；provider section为custom Responses + OpenAI auth，未配置`http_headers`、`env_http_headers`、query params、request/stream retry、stream timeout或显式WebSocket支持。缺省`supports_websockets=false`，与GitHub显式false等价。
- 本机网络路径裁决：CC Switch进程虽监听本地proxy端口，但数据库`enabled=0`，实际Codex active base URL与CC Switch provider base URL一致且都是公网端点，不是loopback/private URL；当前进程环境也不存在HTTP(S)/ALL proxy或自定义CA变量。因此本机成功不是CC Switch本地代理、额外Header或自定义证书帮忙完成的，不能通过把该代理复制到GitHub来解释或修复。
- Codex 0.145.0源码裁决：`ModelProviderInfo`的custom provider默认request retry=4、stream reconnect=5、stream idle timeout=300秒且WebSocket=false；本机CC Switch没有覆盖这些值，GitHub同样使用缺省值。Responses request对普通非Azure custom provider固定`store=false`；CC配置中的`disable_response_storage`不在0.145.0配置schema中，不改变请求。post-fix step约18秒便失败，明显不是300秒idle timeout，而是多次连接在收到`response.completed`前快速EOF。
- 第一性结论：Key只证明认证主体相同，Base URL只证明目标入口相同；二者都不约束DNS/CDN edge、源IP/地区、上游路由或中转按request metadata选择的后端。代码侧已没有可见的CC Switch provider差异可继续复制；剩余高概率原因是中转/CDN对GitHub Hosted Runner出口网络的准入/路由差异，或中转对`codex_exec` originator/strict structured-output请求未正确透传Responses SSE终态。
- Blocker与所需人工输入：中转方需要按run时段`2026-07-28T18:45:11Z`～`18:45:29Z`、模型`gpt-5.6-sol`从服务端核对GitHub Runner请求：是否命中与本机相同backend、HTTP/SSE连接由哪一层关闭、是否实际发出`response.completed`、是否存在源IP/地区/机房/反滥用限制。若Hosted Runner不受支持，应明确采用中转方allowlist或self-hosted runner，而不是继续修改Key/Base URL。取得这些事实或网络策略变化前，不再触发provider preflight；provider success前仍不创建hibernate Task/Run/Attempt。
- 验收命令：`gh pr view 28 --repo evilstar9527/delivery-loop --json number,state,mergedAt,mergeCommit,headRefName,baseRefName,url,reviews,comments,statusCheckRollup`、`gh run view 30388564079 --repo evilstar9527/delivery-loop --json databaseId,event,status,conclusion,createdAt,startedAt,updatedAt,headSha,jobs,url`及PR普通/行内评论API只读核对均exit 0；`pnpm run verify:docs` exit 0（Documentation links verified），`pnpm run verify:secrets` exit 0（492 files），`git diff --check` exit 0。没有测试skip，未运行与纯证据文档无关的代码suite。

## Round 157 — 2026-07-29
- 目标：继续Phase 1真实provider preflight/hibernate前置；回应owner“本机CC Switch以同一Key和URL可用”的事实，用仓库完全相同的exact preflight做macOS与Linux差分，区分普通CC会话/strict请求、OS构建和GitHub Hosted Runner网络。真实provider Action仍只接受`completed/success` URL，hibernate父项仍只接受`DELIVERY_LOOP_WORKFLOW_HIBERNATE_E2E=1 ... pnpm run e2e:workflow-hibernate` exit 0；本轮不重跑失败Action、不创建Task/Run/Attempt、不部署。
- 验收与安全边界：验收固定为仓库`pnpm run e2e:codex-adapter`在当前CC Switch credential/Base URL、`gpt-5.6-sol + high`、custom Responses/SSE、ephemeral/read-only、strict output schema条件下exit 0；第二个对照只改变为本机网络下的`linux/amd64 + Node 24`。credential和URL只由一次性父进程读入子进程环境，未出现在argv、命令输出、仓库、artifact、manifest、日志或本账本；不读取CC session/history或raw provider stream。
- macOS exact对照：本机`codex-cli 0.145.0`；没有复用普通交互会话，而是执行仓库真实adapter脚本及同一strict schema。`DELIVERY_LOOP_CODEX_ADAPTER_E2E=1 DELIVERY_LOOP_CODEX_ADAPTER_MODEL=gpt-5.6-sol CODEX_API_KEY=<process-only> OPENAI_BASE_URL=<process-only> pnpm run e2e:codex-adapter` → exit 0；安全manifest为`status=passed`、`processExitCode=0`、`sessionStatus=completed`、`repositoryClean=true`、`ephemeral=true`。
- Linux exact对照：Docker拉取官方`node:24-bookworm` digest `sha256:5711a0d445a1af54af9589066c646df387d1831a608226f4cd694fc59e745059`，固定`--platform linux/amd64`，从当前只读repo全新clone并`pnpm install --frozen-lockfile`，使用同一四个process-only环境字段运行同一adapter。容器内`codex-cli 0.145.0`，命令exit 0；安全manifest同样为`status=passed`、`processExitCode=0`、`sessionStatus=completed`、`repositoryClean=true`、`ephemeral=true`，且structured output digest与macOS对照一致。该结果不是GitHub Runner证据，但排除了Linux Codex构建或strict structured-output本身作为充分失败条件。
- GitHub事实复核：`gh run view 30388564079 --repo evilstar9527/delivery-loop ...` → exit 0；该唯一post-fix run仍为`completed/failure`，head SHA `c1c477756096271c72636dda916c1ae326a25bc5`，与Round 156一致，没有重跑。GitHub Secrets值写后不可回读，因此控制面不能独立证明两端字节级一致；owner已明确确认Key和URL相同，按该前提分析。
- 第一性结论：CC Switch只是把本地provider/auth配置交给Codex，不是本地成功的额外代理层。相同exact请求在macOS与Linux、但都经本机公网出口时成功；同一repo/profile只在GitHub Hosted Runner收到多次SSE提前EOF。故普通CC会话、model、reasoning、Responses/SSE、WebSocket、strict schema、Codex版本、Linux构建、DNS/TCP/TLS都不是剩余解释；在owner配置同一前提下，唯一仍变化的是GitHub Runner源IP/地区/CDN edge/上游route，需中转方服务端核对，不能靠继续修改Key/Base URL或增加retry解决。
- 状态：真实provider preflight、analysis Action、dispatcher与hibernate父项继续未勾；没有失败伪装成功。下一步不是再次运行`30388564079`同条件，而是让中转方按UTC `2026-07-28T18:45:11Z`～`18:45:29Z`、模型`gpt-5.6-sol`核对backend route、SSE关闭层、`response.completed`是否发出及Hosted Runner出口限制；若中转不支持该出口，采用其allowlist或self-hosted runner后再做一次受控Action。

## Round 158 — 2026-07-29
- 目标：Phase 1“实测并记录试点GitHub账号的hosted runner/计费/App/Actions语义与Cloudflare Workflows限制”；本轮只闭环真实外部证据契约对已拍板个人公开仓库的可执行性，父项真实probe仍不勾。验收命令先固定为`pnpm exec vitest run test/platform-limits-evidence-v2.test.ts test/platform-limits-evidence.test.ts`和最终`pnpm run verify`；个人/组织双模式、exact endpoint、owner/billing负向与全量回归必须全绿。
- 前置与权限：只读GitHub public identity与试点repository Actions policy；没有触发Action、并发/六小时probe、模型、Cloudflare migration/deploy/restart或控制面mutation。六小时和饱和并发会消耗Runner预算，仍需owner明确批准。个人enhanced billing官方endpoint为`/users/{login}/settings/billing/usage`，既有scope核对确认当前`gh` token缺用户`Plan: read`（classic等价`user`），live请求返回404；本轮不刷新登录、不申请scope、不读取raw billing。
- 规格冲突：仓库已由owner明确选择`evilstar9527/delivery-loop`个人公开仓库；live `GET /users/evilstar9527`返回`login=evilstar9527,type=User`。原`PlatformLimitsEvidenceManifestV1`却固定`github.organization`、org-only policy端点、organization billing URL/字段和summary，因此即使预算获批也永远不能为该试点exit 0。按`docs/`与代码冲突先裁决、破坏性契约升version的纪律，V1仅保留parse-only历史兼容，新live verifier升级为V2。
- 红灯：先新增个人V2 schema正反测试，`pnpm exec vitest run test/platform-limits-evidence-v2.test.ts test/platform-limits-evidence.test.ts` → exit 1，1项因V2 schema不存在失败、既有V1 suite 5项通过；随后把主verifier预期迁到V2并加入个人endpoint/identity/billing负向，同命令再次exit 1，2 files中7 failed / 1 passed，个人manifest固定在`manifest_invalid`且V2 schema仍不存在。红灯没有调用网络或计费资源。
- 实现：新增`PlatformLimitsEvidenceManifestV2`：`github.account={type:user|organization,login}`、同类型strict `accountPolicy`、`reviewedAccountLimit`与account summary字段；repository owner和billing audit URL绑定账号类型。V1 schema/example/export保留，但`verifyPlatformLimitsEvidence`和CLI只接受V2。组织模式继续读取org policy与organization billing；个人模式读取repository policy与personal billing；两者都先读取`/users/{login}`核对live type。GitHub API version固定`2026-03-10`；个人billing拒绝`organizationName`、缺`repositoryName`及`other/repo`显式跨owner，组织billing继续要求exact organization。CLI credential改名为用途准确的`PLATFORM_LIMITS_GITHUB_ACCOUNT_TOKEN`，没有legacy fallback导致V2静默读错token。
- live只读核对：API version `2026-03-10`下，`GET /users/evilstar9527`返回`User`；试点repository policy返回`enabled=true, allowed_actions=all`，workflow默认`read`且不能批准PR review，artifact/log retention为90天；四条命令均exit 0。billing因缺Plan scope未请求新权限，不能作为本轮成功证据。
- 规范与安全：`docs/PlatformLimitsE2E.md`、`docs/Proto.md`、`docs/Security.md`、`docs/Architecture.md`和`docs/Reference.md`同步V2、两类endpoint、Plan scope、personal item与预算边界；新增V2个人示例，按owner要求不更新llmdoc。Watt固定commit没有GitHub个人billing或account-discriminated platform evidence可复制；继续最大复用其显式opt-in、64 KiB、1 MiB有界HTTP、固定0/1/2和安全错误骨架。
- 验证：
  - `pnpm exec vitest run test/platform-limits-evidence-v2.test.ts test/platform-limits-evidence.test.ts` → exit 0，2 files / 9 tests；覆盖V1 parse-only、V2个人schema owner/policy/audit URL、组织成功、个人exact endpoints/API version、live type drift、个人organizationName/跨owner、policy/billing/probe/docs/子证据漂移、response bound/credential redaction和CLI account token/opt-in。
  - `pnpm run typecheck`、`pnpm run lint`、`pnpm run verify:docs`、`pnpm run verify:secrets`与`git diff --check` → exit 0；Secret scan为493个生产文件。
  - `pnpm run verify` → exit 0；typecheck、ESLint、Node 110 files / 513 tests、workerd 57 files / 309 tests、493文件Secret scan和docs links全绿；workerd既有`User called terminate`为主动清理诊断，不是failure或skip。
- 五维review：正确性上V2 discriminator、endpoint、digest、owner与summary全链一致；安全上只读token用途隔离、无raw billing/credential和不自动扩scope；恢复性不新增状态/mutation，原三份恢复子证据仍独立重验；三方契约由官方endpoint/API version及live identity/repository policy核对；证据真实性明确区分本地contract、live只读事实和未执行probe。review后无未处理BLOCKER/MAJOR。
- 勾选：更新并保持“真实外部证据验收契约”子项为已完成；父项与“真实试点外部事实”保持未勾，因为个人billing scope、Runner预算、两个probe及heartbeat/hibernate/replay live子证据尚未闭环。本轮没有把V1旧绿灯或personal policy只读结果冒充平台实测。
- 遗留：取得owner对并发分钟与约六小时Runner的明确预算授权、用途隔离的personal `Plan: read` token，以及已通过的RunnerHeartbeat/WorkflowHibernate/ControlledReplay manifests后，才能生成仓库外V2 manifest并运行`pnpm run e2e:platform-limits`；provider Hosted Runner blocker仍会先阻断这些复用证据，不能绕过它创建假manifest。

## Round 159 — 2026-07-29
- 目标：Phase 3“Agent Adapter 的start/resume/interrupt/exportCheckpoint契约测试通过；至少接通一个真实非交互Agent CLI”。本轮只审计并关门Round 157已经产生的显式opt-in真实模型事实，不再次调用模型；验收要求既有run同时覆盖认证、真实`codex exec`、process/session终态、strict结构化输出、checkpoint和Git clean，当前main上的生命周期/evidence/CLI契约还必须无回归。
- 前置与权限：复用Round 157 owner当前CC Switch credential/Base URL的两次真实调用安全投影；不读取或输出Key、URL、headers、模型正文、session/history或raw stream。本轮没有模型调用、GitHub Action dispatch、Task/Run/Attempt、Cloudflare mutation或部署；默认gate命令必须在认证和网络前exit 2。
- 证据审计：macOS原生run使用仓库真实`pnpm run e2e:codex-adapter`、`codex-cli 0.145.0`、custom Responses/SSE、`gpt-5.6-sol + high`、ephemeral/read-only/strict schema，exit 0；安全manifest为`processExitCode=0`、`sessionStatus=completed`、`structuredOutputDigest=sha256:0a6b9c878d67f9cd0597ba1f809d659226aa329de0eafbec370877336a29324a`、checkpoint sequence 2/digest `sha256:a46c6a43187557692a6690e8f7e3f267405b52f513b74f8d75f4e79912ddc42`、checkpoint/workspace head `0c3d0c49a9fa721d13ef48b1f7639cc1190e96ec`、`repositoryClean=true,ephemeral=true`。这些是manifest安全reference，不是模型正文。
- 独立Linux补强：本机Docker固定`node:24-bookworm@sha256:5711a0d445a1af54af9589066c646df387d1831a608226f4cd694fc59e745059`与`--platform linux/amd64`，从只读repo全新clone/install后运行同一adapter，exit 0；`codex-cli 0.145.0`，同一structured output digest，checkpoint sequence 2/digest `sha256:3c4159c8d80cab0ce1ad3f1af8d3c7e06ca873a137dda14daf71ee5587603a15`、head `e1dba958388f4afac5a9406473b08e761ef489cf`、clean/ephemeral均true。不同临时Git head导致checkpoint digest不同是预期，结构化业务结果digest exact相同；这证明不是help、fake executor或复用交互session。
- 当前main契约复核：`pnpm exec vitest run test/codex-session-adapter.test.ts test/agent-adapter-evidence.test.ts test/real-codex-adapter-verifier.test.ts test/codex-provider-profile.test.ts` → exit 0，4 files / 22 tests；覆盖start/resume/interrupt/exportCheckpoint、语义checkpoint binding、真实子进程、strict evidence/head/session/raw drift、custom provider和双层opt-in。`pnpm exec codex --version`为`codex-cli 0.145.0`；`codex exec --help`仍有`--ephemeral/--ignore-user-config/--sandbox/--output-schema/--output-last-message/--cd`。`pnpm run e2e:agent-adapter`未设置opt-in → 预期exit 2且只输出固定前置码，没有认证/模型调用；该exit 2只证明默认安全，不替代Round 157 exit 0。
- Round 158默认分支交付补账：PR [#30](https://github.com/evilstar9527/delivery-loop/pull/30)以rebase merge进入main head `3713e3069dd1c08c16869c102d1a12c917ee7cdd`；required PR CI [30393442928](https://github.com/evilstar9527/delivery-loop/actions/runs/30393442928)与合并后main CI [30393791200](https://github.com/evilstar9527/delivery-loop/actions/runs/30393791200)均success，PR无review/requested changes/普通或行内评论。Node 20 Action被平台强制到Node 24仍为既有MINOR提示。
- 第一性裁决：Agent Adapter父项要求的是至少一个真实非交互CLI接通，不要求该次调用必须来自GitHub Hosted Runner；子项明确允许显式opt-in本地环境。Round 157两次真实exit 0已满足provider/进程/输出/checkpoint事实，当前GitHub Hosted Runner中转EOF只阻断Phase 1真实Action/hibernate，不否定独立本地验收。重复付费调用不会增加缺失维度，因此本轮不重跑模型。
- 勾选：Phase 3 Agent Adapter真实CLI子项及父项勾选。真实GitHub analysis Action、provider preflight与hibernate继续未勾；本轮没有把本地adapter成功冒充GitHub Runner成功。
- 决策沉淀：无需改运行契约或`docs/`；现有[Agent Adapter外部证据验收](docs/AgentAdapterE2E.md)已明确允许CI key或本地登录态、真实进程/结构化输出/checkpoint/Git clean和默认exit 2边界。按owner要求不更新llmdoc。
- 遗留：本轮关门不解除Hosted Runner出口blocker，也不证明analysis业务Plan或Runner heartbeat。下一轮继续选择一个不依赖同一stream条件、且已有足够外部authority的未完成DoD；需要真实Action的条目继续等待中转allowlist/self-hosted runner或服务端route修复。

## Round 160 — 2026-07-29
- 目标：继续Phase 1“第三方provider真实preflight Action”；回应本机exact preflight成功而GitHub Hosted Runner stream中断的事实，先裁决并机器化public repository的Runner fallback安全边界。真实preflight仍只接受锁定Codex/custom Responses/SSE/CI credential/`gpt-5.6-sol + high`的`completed/success` Action URL；本轮只闭环public Runner policy子项，不把本机、本地Docker、文档或静态关口冒充provider success。
- 前置与权限：只读GitHub官方`github/docs`与本地delivery-loop/Watt固定commit；未注册、启动或配置self-hosted/JIT Runner，未修改repository variable/Secret/App scope，未触发Action或模型，未创建Task/Run/Attempt、部署Cloudflare或读取provider raw response/credential。当前仓库是`evilstar9527/delivery-loop`个人public repository；任何机器级Runner注册、费用或新增administration权限仍需owner独立批准。按owner约定不更新llmdoc。
- 官方事实：`gh api repos/github/docs/commits/main`固定当前受审commit为`7c606a5af1be9e89a57b88583dca345691ab9a52`；该commit的self-hosted runner reference说明GitHub按`runs-on` labels/groups匹配、无Runner时最长排队24小时，推荐一job后自动移除的JIT/`--ephemeral`，并要求clean environment、deregister后销毁和production前外送runner application logs。secure-use说明self-hosted没有ephemeral clean VM保证、可被workflow持久攻陷且几乎不应供public repository使用。首次提取命令误用zsh保留数组名`path`导致该shell内`gh/base64/rg`均not found；改为`docpath`后同一只读提取exit 0，没有外部写入或证据缺口。
- Watt复用核对：`git -C /Users/jishihe/tokenrollal/Watt rev-parse HEAD`为固定`476e3cdd2490d725fde174e7c697ebf00899edc6`；受审树只有`.github/workflows/{ci,release}.yml`两处literal `ubuntu-latest`，没有self-hosted/JIT lifecycle、完整workflow inventory parser或Runner policy verifier可直接复制。Watt工作树已有未跟踪`scripts/tb-sdk-smoke.ts`属于owner，本轮未读取正文、修改或提交；没有虚构复制来源。
- 红灯：先新增`test/github-workflow-runner-policy.test.ts`，`pnpm exec vitest run test/github-workflow-runner-policy.test.ts`因生产模块不存在按预期exit 1（1 failed suite / 0 tests）。红灯没有更改workflow或运行外部资源。
- 实现：新增fail-closed `verifyPublicRepositoryWorkflowRunnerPolicy`，单份workflow限制256 KiB、拒绝非法/重复path、YAML error/warning/alias、空或畸形jobs、job级reusable workflow，并要求每个job的`runs-on`恰为literal `ubuntu-latest`；self-hosted标签、标签数组、matrix/repository variable/expression和其他hosted标签均拒绝。文件系统CLI扫描`.github/workflows`全部`.yml/.yaml`且拒绝symlink/非file，新增`pnpm run verify:workflow-runners`并接入全量`verify`。`docs/Security.md`、`docs/Reference.md`与`DOD.md`同步public repo禁用本机/持久/shared Runner、未来isolated JIT/private execution repo所需owner批准与最低边界。
- 验证：
  - `pnpm exec vitest run test/github-workflow-runner-policy.test.ts` → exit 0，1 file / 7 tests；覆盖当前完整inventory及self-hosted/数组/动态表达式/未受审标签/alias/畸形/超限负向。
  - `pnpm run verify:workflow-runners` → exit 0，12 workflows / 12 jobs均为受审literal `ubuntu-latest`。
  - `pnpm run typecheck`、`pnpm run lint`、`pnpm run verify:docs`、`pnpm run verify:secrets`与`git diff --check` → exit 0；Secret scan为495个生产文件。
  - `pnpm run verify` → exit 0；typecheck、ESLint、Node 111 files / 520 tests、workerd 57 files / 309 tests、12 workflows / 12 jobs Runner policy、495文件Secret scan与docs links全绿。workerd既有`User called terminate`为主动清理诊断，不是failure或skip。
- 五维review：正确性上目录inventory、路径/大小/YAML/jobs/literal label均fail-closed；安全上阻止public repo通过变量、matrix、数组、reusable job或直接标签静默获得self-hosted宿主，且没有新增credential/Action入口；恢复性不改变Run/Workflow/Attempt状态或Runner生命周期，未来JIT仍必须独立证明一job/销毁/日志外送；三方契约以GitHub官方固定commit而非记忆或第三方文章为authority；证据真实性明确区分本地policy、官方事实和未执行的真实provider/JIT。review后无未处理BLOCKER/MAJOR。
- 勾选：新增并勾选Phase 1“public repository Runner安全边界”子项；第三方provider真实preflight、analysis Action、dispatcher、heartbeat、hibernate及所有真实平台父项保持未勾。本轮没有把安全禁止项、失败Action、本地模型成功或默认CI冒充外部provider成功。
- 遗留：Hosted Runner仍需中转方按UTC `2026-07-28T18:45:11Z`～`18:45:29Z`核对backend route、SSE关闭层、`response.completed`与出口限制，或先修复/allowlist后只做一次受控preflight。若owner选择替代出口，需在“隔离JIT disposable基础设施”和“private execution repository”之间另行拍板机器/费用/权限/日志保留；当前policy会在任何此类workflow进入main前先失败，防止静默扩大信任边界。

## Round 161 — 2026-07-29
- 目标：Phase 2“监控 adapter（若启用）只创建 candidate/triage，不自动获得 repo write；相同告警指纹在抑制窗口内合并”。本轮只做production disabled路径的live预审；正式关门命令先固定为仓库外`mode=disabled + decision=not_enabled` manifest、用途隔离Cloudflare settings-read token与synthetic canary运行`DELIVERY_LOOP_MONITOR_ALERT_E2E=1 ... pnpm run e2e:monitor-alert` exit 0。owner未决策前不把配置缺省解释成N/A。
- 前置与权限：只读运行Wrangler identity、deployment与version inventory；没有创建Cloudflare API token、读取Secret值、修改binding/Variable、部署Worker、发送Sentry事件、调用模型、创建Task/Run/Attempt或触发GitHub Action。当前Wrangler OAuth含`workers/write`、D1/Queues等多项write scope，只能作为live预审，不是`docs/MonitorAlertE2E.md`要求的用途隔离settings-read credential。
- Live预审：账号`b8488957e88658039d2a38fb8f160514`上的`delivery-loop-control-plane`当前production deployment为`774826c8-fc4a-4e70-aa95-15f34deb759f`，100%流量version为`026915b2-d688-4711-a10e-6aaa970117a9`，创建时间`2026-07-28T12:30:32.72889Z`。版本binding名称/type安全投影中`MONITOR_WEBHOOK_SECRET`、`MONITOR_TENANT_KEY`、`MONITOR_ALLOWED_REPOSITORIES`与`MONITOR_SUPPRESSION_WINDOW_SECONDS`全部不存在；未输出其他binding值或任何Secret。
- 证据裁决：四binding缺失与disabled路径预期一致，但缺owner明确`not_enabled`决策、仓库外strict manifest和purpose-isolated read token，故没有运行会缺前置的formal verifier，也不勾父项/真实外部子项。Wrangler OAuth的广权限事实不能被包装成“最小只读”成功证据。
- 同步发现的live漂移：同一version只读投影的`CODEX_MODEL_PROFILE_ID`仍是`codex-gpt-5p6-terra-20260728`，而当前仓库`wrangler.jsonc`要求`codex-gpt-5p6-sol-high-20260729`。这证明Round 155的Sol/high Worker配置未部署；本轮没有部署授权，保持production不变并把漂移单独入账，不能用repo配置冒充live readiness。
- 验证：
  - `pnpm exec wrangler whoami`、`pnpm exec wrangler deployments status --name delivery-loop-control-plane --json`与`pnpm exec wrangler versions view 026915b2-d688-4711-a10e-6aaa970117a9 --name delivery-loop-control-plane --json` → exit 0；deployment/version/traffic、OAuth scope和四binding absent安全投影符合上述事实。
  - `jq -r '.vars.CODEX_MODEL_PROFILE_ID' wrangler.jsonc` → exit 0，仓库值为`codex-gpt-5p6-sol-high-20260729`，与live Terra profile不一致。
  - `pnpm run verify:docs`、`pnpm run verify:secrets`与`git diff --check` → exit 0；文档链接、495文件Secret扫描和diff格式全绿。
  - `pnpm run verify` → exit 0；typecheck、ESLint、Node 111 files / 520 tests、workerd 57 files / 309 tests、12 workflows / 12 jobs Runner policy、495文件Secret扫描和docs links全绿。workerd既有`User called terminate`是主动清理诊断，不是failure或skip。
- 五维review：正确性上deployment→100% version→binding inventory链路完整；安全上没有把广权限OAuth冒充最小只读、没有读取binding值或Secret；恢复性上没有任何控制面或Workflow状态变更；三方契约以Wrangler官方live API读取production事实；证据真实性明确区分“binding absent预审”“owner决策缺失”“formal verifier未运行”和“live model drift”。review后无未处理BLOCKER/MAJOR。
- 勾选：无；monitor父项与真实外部子项保持未勾，provider/analysis/hibernate真实项也不因本次配置读取获得进展。
- 决策沉淀：`DOD.md`增加disabled live预审、凭证scope限制与model profile漂移；没有改变运行契约或`docs/`规范，按owner要求不更新llmdoc。
- 遗留：owner需明确生产monitor是`not_enabled`还是`enabled`。若`not_enabled`，创建用途隔离Cloudflare production settings只读token和仓库外disabled manifest后运行一次正式verifier；若`enabled`，需另行授权生产配置、Sentry test project/observer与八次受控事件。修复live Terra→Sol/high还需独立deployment授权，不能与monitor决策捆绑或静默执行。

## Round 162 — 2026-07-29
- 目标：Phase 6“连续 7 天试运行无未知 stuck run、无重复 PR/部署、无 Secret 告警；指标报告入账”。本轮只修正外部readiness判据中已经失真的“无Git remote/D1占位”阻塞，最终关门仍只接受真实10080分钟窗口、至少一个Run、三类live只读事实和人工review后`DELIVERY_LOOP_SEVEN_DAY_TRIAL_E2E=1 ... pnpm run e2e:seven-day-trial` exit 0；不把资源bootstrap解释为七天完成。
- 前置与权限：只读核对local/origin、Wrangler期望配置、既有production version及远程D1聚合计数；没有读取Task/Run正文或Secret值，没有创建trial、token、Task/Run、PR/deployment，未修改Cloudflare资源、启动七天窗口、调用模型或触发Action。当前Wrangler OAuth仍含write scope，本轮只执行read command，不能冒充用途隔离trial credential。
- 事实纠正：`origin=https://github.com/evilstar9527/delivery-loop.git`，`wrangler.jsonc`已绑定真实D1 ID、四个R2 bucket、六个Queue、两个Workflow、Cron和observability期望配置；Round 143～144及161已有live Worker/resource证据。因此`DOD.md`和`docs/SevenDayTrial.md`中“remote为空、D1全零占位”与代码/外部事实冲突，必须移除。
- 当前真实阻塞：production D1只读聚合`task_count=0, run_count=0`，没有满足non-empty要求的真实Run；也没有冻结的七天started/ended、10080个minute bucket、observability report、用途隔离三token、永久查询链接或人工Reviewer。live version仍为`026915b2-d688-4711-a10e-6aaa970117a9`且model profile落后于repo Sol/high配置，未来deployment与trial start必须独立授权并冻结新的deployment identity。
- Round 161默认分支交付补账：PR [#33](https://github.com/evilstar9527/delivery-loop/pull/33)以rebase merge进入main head`bf880eb83b95047720abc3cd0477846915d44a81`；required PR CI [30400177864](https://github.com/evilstar9527/delivery-loop/actions/runs/30400177864)与合并后main CI [30400505136](https://github.com/evilstar9527/delivery-loop/actions/runs/30400505136)均success，PR无review/requested changes/普通或行内评论。main CI监听末次轮询曾遇到GitHub API连接错误，但随后直接读取run/job immutable API确认`completed/success + run_attempt=1`，没有把watch客户端错误误记为CI失败或重跑。
- 动作：更新`DOD.md`真实外部子项和`docs/SevenDayTrial.md` readiness章节，明确“资源已存在”只解除bootstrap前置，当前关门缺口是non-empty真实Run、连续窗口、live observability/retention/detector、用途隔离token和人工review；父项与真实外部子项保持未勾。
- 验证：
  - `pnpm run e2e:seven-day-trial` → 预期exit 2，固定只返回`opt-in missing`，在认证和网络前拒绝；该结果只证明默认安全，不替代七天外部事实。
  - `pnpm exec vitest run test/seven-day-trial-evidence.test.ts` → exit 0，1 file / 5 tests；覆盖strict manifest/report/live三方交叉核对、窗口/非空Run/重复副作用/响应边界及默认gate。
  - `pnpm run verify:docs`、`pnpm run verify:secrets`与`git diff --check` → exit 0；文档链接、495个生产文件Secret扫描与diff格式均通过。
  - `pnpm run verify` → exit 0；typecheck、ESLint、Node 111 files / 520 tests、workerd 57 files / 309 tests、12 workflows / 12 jobs Runner policy、495文件Secret扫描和docs links全绿。workerd的`User called terminate`为既有主动清理诊断，不failure或skip。
- 五维review：正确性上旧placeholder与当前origin/resource/live D1事实已对齐，且零Run与10080分钟缺失仍fail-closed；安全上没有读取Secret或Task/Run正文，广权Wrangler OAuth不冒充用途隔离token；恢复性上没有创建窗口或修改Run/Workflow状态，不改变原有连续bucket验收；三方契约上明确区分Wrangler期望配置、已知live version和尚未核对的observability/retention；证据真实性上只用远程D1安全聚合支持零Run，没有用bootstrap、仓库配置或exit 2冒充试运行。review后无未处理BLOCKER/MAJOR。
- 勾选：无；七天试运行父项/真实外部子项继续未勾，资源存在和D1空库不构成成功证据。
- 决策沉淀：`DOD.md`与`docs/SevenDayTrial.md`对齐当前代码/外部事实；按owner要求不更新llmdoc。
- 遗留：先解决provider/analysis Action并取得production deployment与trial-start授权，核对live observability和至少七天保留、完成detector canary与用途隔离token/Reviewer准备，再选择分钟边界正式启窗。窗口结束前不得运行formal verifier冒充完成。

## Round 163 — 2026-07-29
- 目标：Phase 1“第三方provider真实preflight Action”的模型隔离诊断。owner指出当前CC Switch以同一Key/Base URL可用，但安全投影发现active model已变为`gpt-5.5`，而生产契约仍固定`gpt-5.6-sol + high`。本轮只做一次“相同Hosted Runner/认证/传输/strict schema，只改模型”的无Task对照；无论结果都不把`gpt-5.5`诊断冒充Sol/high preflight success。
- 前置与权限：只使用public repo既有`workflow_dispatch`、`contents:read`与两枚repository Secret，最多一次受控模型调用；不读取/输出Key、Base URL、raw provider stream或模型正文，不创建Task/Run/Attempt、不修改Secret/App scope、不部署Cloudflare。成功只证明model-specific route差异，同一stream失败则排除当前模型字面量差异作为充分原因；不进入hibernate窗口。
- Round 162默认分支交付补账：PR [#34](https://github.com/evilstar9527/delivery-loop/pull/34)以rebase merge进入main head `d3b9b0d9f5f08f9ab8b6799b2d8905d567734254`；required PR CI [30412649731](https://github.com/evilstar9527/delivery-loop/actions/runs/30412649731)与合并后main CI [30412887761](https://github.com/evilstar9527/delivery-loop/actions/runs/30412887761)均success，PR无review/requested changes/普通或行内评论。
- CC Switch安全投影：当前provider config只核对白名单字段，为`gpt-5.5 + high + Responses + requires_openai_auth`；`proxy_enabled=1`但实际`enabled=0, live_takeover_active=0, auto_failover_enabled=0`，因此CC可用仍不是本地proxy帮助。未读取provider auth/URL、session/history或请求日志。
- 唯一变量诊断：从clean main创建branch-only commit `31ab104fb98940d6ea07cf0a4c50f9e8590e744f`，本地diff与GitHub compare均证明相对`d3b9b0d9f5f08f9ab8b6799b2d8905d567734254`只修改`.github/workflows/codex-provider-preflight.yml`一行：`gpt-5.6-sol` → `gpt-5.5`。`ubuntu-latest`、Codex 0.145.0、custom Responses/SSE、OpenAI auth、high reasoning、strict output、Secret注入和临时文件边界均不变；GitHub workflow blob为`aa7dd31bf97eaa8ca7dd3d5d409bc7530b7e3667`。
- 外部结果：唯一Action [30413484986](https://github.com/evilstar9527/delivery-loop/actions/runs/30413484986)为`workflow_dispatch + completed/failure + run_attempt=1`，exact head为上述诊断commit。checkout/pnpm/Node/locked install均success，只有`Verify exact provider route`从`2026-07-29T01:14:20Z`至`01:14:29Z`失败，固定安全分类仍为`provider_stream_interrupted`；运行inventory对该head恰好只有这1次。`gh secret list`只读名称/更新时间证明两枚Secret从Round 149后未更新，但平台仍不允许回读值。没有读取或记录raw stderr/provider response、URL、credential或模型正文，且没有rerun。
- 第一性结论：在GitHub Hosted Runner网络与两枚Secret不变时，`gpt-5.5`与`gpt-5.6-sol`均在`response.completed`前提前EOF，所以当前CC模型名不同不是GitHub失败的充分原因。诊断分支已从local/remote删除，main workflow与immutable Sol/high D1 profile没有变更；该失败Action不勾选provider、analysis或hibernate DoD。
- 验证：
  - GitHub Actions run/job API、contents API与compare API → exit 0；绑定`run=30413484986`、`head=31ab104fb98940d6ea07cf0a4c50f9e8590e744f`、`workflow blob=aa7dd31bf97eaa8ca7dd3d5d409bc7530b7e3667`，compare为`ahead_by=1, behind_by=0, total_commits=1`且唯一文件1增1删。`gh run list`对exact head只返回这1个`attempt=1`的失败run；`git ls-remote --heads`对诊断branch为空，证明rollback已删除remote ref。
  - `pnpm exec vitest run test/codex-provider-preflight-workflow.test.ts test/codex-provider-profile.test.ts test/provider-preflight-failure.test.ts` → exit 0，3 files / 28 tests；证明main仍固定Sol/high、immutable profile一致且stream分类安全边界无回归。
  - `pnpm run verify:workflow-runners`、`pnpm run verify:docs`、`pnpm run verify:secrets`与`git diff --check` → exit 0；12 workflows / 12 jobs均为literal `ubuntu-latest`，文档链接、495文件Secret扫描与diff格式全绿。
  - `pnpm run verify` → exit 0；typecheck、ESLint、Node 111 files / 520 tests、workerd 57 files / 309 tests、12 workflows / 12 jobs Runner policy、495文件Secret扫描和docs links全绿。workerd的`User called terminate`为既有主动清理诊断，不failure或skip。
- 五维review：正确性上GitHub compare与run head证明只变模型且同类失败，结论只排除“模型差异是充分原因”，没有假定Secret字节相等或定位具体CDN层；安全上只有1次无Task调用，Secret只显示GitHub mask，无raw stream/模型正文/artifact，且诊断ref已删除；恢复性上未main/Worker/D1/Run变更或hibernate窗口，rollback只清理临时branch；三方契约上用CC Switch白名单投影、GitHub immutable compare/run/job/blob与仓库固定profile交叉核对，中转服务端路由仍明确缺失；证据真实性上失败Action只收窄blocker，未冒充provider success、analysis或hibernate。本轮文档变更无新的未处理BLOCKER/MAJOR；provider本身仍是已知外部blocker。
- 勾选：无；第三方provider真实preflight、真实analysis Action与hibernate父项保持未勾。
- 决策沉淀：`DOD.md`更新provider/analysis blocker，`docs/Reference.md`记录只变模型的外部对照与不可冒充边界；直接复用既有preflight、safe classifier与GitHub compare，不新建第二套provider实现，按owner要求不更新llmdoc。
- 遗留：中转方需按UTC `2026-07-29T01:14:20Z`～`01:14:29Z`从服务端核对run `30413484986`的backend route、SSE关闭层、`response.completed`与云厂商出口限制，并在修复/allowlist后才做一次Sol/high复验；或owner另行批准isolated JIT/private execution架构。GitHub Secret写后不可读，仍无法独立证明两端字节完全相同；当前不再用任何模型字面量盲重跑。

## Round 164 — 2026-07-29
- 目标：Phase 1“第三方provider真实preflight Action”。owner坚持CC Switch与GitHub使用相同Key/Base URL；本轮先把该前提变成不泄漏值的双字段外部证据，若mismatch则只修正Secret后做一次Sol/high复验。验收固定为：field-domain proof只输出每项`match/mismatch/invalid`、临时proof Secret结算后删除，以及main固定Codex/custom Responses/SSE/`gpt-5.6-sol + high` preflight取得`completed/success` URL；analysis/hibernate仍不得由preflight代替。
- 前置与权限：只读取CC Switch当前`codex` provider的active记录并在受控父进程内提取Key/Base URL；值只经子进程env或stdin传给proof计算与`gh secret set`，不进入命令文本、stdout/stderr、文件、Git或PROGRESS。创建三枚短期repository proof Secret并使用两枚既有provider Secret；proof workflow只有`contents:read`、无input/Environment/OIDC/write/artifact/provider HTTP/Codex/Task。配置修复后只调用一次既有无Task provider preflight；没有创建Task/Run/Attempt、dispatch、部署Cloudflare或扩大App scope。
- Round 163默认分支交付补账：PR [#35](https://github.com/evilstar9527/delivery-loop/pull/35)以rebase merge进入main head `fd293168daa9df8110468ed8b5a9d275f4c314c4`；required PR CI [30414136559](https://github.com/evilstar9527/delivery-loop/actions/runs/30414136559)与合并后main CI [30414407643](https://github.com/evilstar9527/delivery-loop/actions/runs/30414407643)均`completed/success`，PR无review/requested changes/普通或行内评论。branch与rebase main的patch-id均为`f45c94836439e0ae85c422d922f2f94ce20b2431`，local/remote分支已删除且main干净。
- 红灯与实现：先新增`test/provider-secret-equivalence.test.ts`，生产模块不存在时1 failed suite / 0 tests；实现域隔离HMAC、常量时间比较、固定安全CLI及临时branch-only push workflow后，runner inventory断言从12变13出现1个预期失败并同步更新。组合proof首个外部run [30416223031](https://github.com/evilstar9527/delivery-loop/actions/runs/30416223031)只得到`provider_secret_config_mismatch`，暴露诊断粒度不足；随后先写字段级红灯（3 tests中2 failed），再把proof拆为`api-key/base-url`独立domain与独立布尔结果。默认分支版本已移除临时push入口，只保留`workflow_dispatch`。
- Secret外部事实与修复：字段run [30416387349](https://github.com/evilstar9527/delivery-loop/actions/runs/30416387349) attempt 1绑定head `9e0858d582abc0c651610a2326c7cf61e5406e8b`，checkout/install成功，命名step固定输出`provider_api_key_mismatch + provider_base_url_mismatch`并失败；输入缺失会得到`input_missing`而不是mismatch，因此证明两枚Actions Secret均非空但都不等于CC Switch active provider。以active provider为source of truth经stdin覆盖`OPENAI_API_KEY/OPENAI_BASE_URL`后，同一run attempt 2/job `90463930821`固定输出`provider_api_key_match + provider_base_url_match`并`completed/success`。三枚proof Secret随后删除；`gh secret list`只剩两枚provider Secret及更新时间，没有输出值、长度、HMAC或credential-derived digest。
- Provider成功外部事实：配置等价后只触发一次main固定workflow，[30416517222](https://github.com/evilstar9527/delivery-loop/actions/runs/30416517222)绑定head `fd293168daa9df8110468ed8b5a9d275f4c314c4`、workflow blob `fb18fbbf5b67ea157843d79d0f067df6dbb0739e`，为`workflow_dispatch + run_attempt=1 + completed/success`。唯一job `90464113962`从`2026-07-29T02:19:34Z`至`02:20:16Z`完成，checkout/pnpm/Node/locked install及`Verify exact provider route`全部success；仓库workflow固定Codex 0.145.0、custom Responses/SSE、OpenAI auth、Sol/high、strict output及只读临时Git fixture。该结果证明历史stream失败至少包含Secret配置漂移；它不证明真实Task分析或Workflow hibernate。
- 验证：
  - `pnpm exec vitest run test/provider-secret-equivalence.test.ts test/codex-provider-preflight-workflow.test.ts test/codex-provider-profile.test.ts test/provider-preflight-failure.test.ts test/github-workflow-runner-policy.test.ts` → exit 0，5 files / 38 tests；覆盖exact字节、Key/URL独立mismatch、proof格式、manual/read-only workflow、Sol/high/profile/failure分类和完整Runner inventory。
  - `pnpm run verify:docs`、`pnpm run verify:secrets`与`git diff --check` → exit 0；文档链接、498个生产文件Secret扫描和diff格式全绿。
  - `pnpm run verify` → exit 0；typecheck、ESLint、Node 112 files / 523 tests、workerd 57 files / 309 tests、13 workflows / 13 jobs Runner policy、498文件Secret扫描和docs links全绿。workerd既有`User called terminate`为主动清理诊断，不是failure或skip。
  - GitHub run/job/content/inventory API与固定marker过滤 → exit 0；交叉绑定proof attempt 1/2、provider success exact head/job/workflow blob及六次preflight inventory，不读取raw provider日志或Secret值。
- 五维review：正确性上首次组合proof粒度不足没有被冒充定位，字段级proof先实证双mismatch、修复后在同一head/同一run attempt 2双match，随后main exact Sol/high成功形成因果闭环；安全上proof key/两份expected proof只短期存在并已删除，日志只有固定枚举，provider结果留`RUNNER_TEMP`且无artifact/Task正文；恢复性上Secret覆盖不改变D1/Workflow/Run，proof rerun绑定相同head且没有外部业务effect，provider调用也无Task可重放副作用；三方契约上用CC Switch active provider、GitHub Secret运行时、immutable Actions/API/blob和仓库profile四方核对，而非继续信任口头“相同”；证据真实性上失败Action只证明mismatch，只有修复后的双match与独立Sol/high success共同支持勾选。review后无未处理BLOCKER/MAJOR。
- 勾选：Phase 1“第三方provider真实preflight Action”子项。真实analysis Action、dispatcher、heartbeat与hibernate父项保持未勾；proof success和preflight success均未冒充业务Task完成。
- 决策沉淀：`docs/Security.md`新增Secret等价proof的HMAC/短期Secret/固定输出边界；`docs/Reference.md`记录双mismatch→修复→Sol/high成功并撤销Round 163的Runner路由推断；`DOD.md`同步provider已解除及analysis/hibernate剩余前置。直接复用现有provider workflow、Secret映射和安全枚举；Watt固定commit没有等价模块可复制。按owner要求不更新llmdoc。
- 遗留：production Worker仍运行旧Terra profile version `026915b2-d688-4711-a10e-6aaa970117a9`，仓库为Sol/high；真实analysis/hibernate前需取得独立production deployment授权并冻结deployment identity，再创建唯一人工Task/Attempt执行dispatch→analysis→wait→redeploy/restart证据链。若未来重写provider Secret，可手动运行等价workflow，但必须重新创建三枚短期proof Secret并在run后删除。

## Round 165 — 2026-07-29
- 目标：Phase 1“真实 Cloudflare 环境强制 hibernate/Worker restart，并以GitHub外部run证明dispatch仅一次”的production发布就绪子项。真实关门仍要求同一Task/Run/Workflow instance跨before/after deployment恢复及`pnpm run e2e:workflow-hibernate` exit 0；本轮在未获得production D1/Worker授权时只冻结migration-first顺序、deterministic bundle、live漂移和rollback anchor，不把readiness、dry-run或healthz冒充部署/恢复。
- 前置与权限：只读使用现有Wrangler OAuth查询目标account deployment/version/D1 migration/profile计数并调用公开healthz；本地运行Wrangler dry-run。没有应用migration、upload/version/deploy/rollback、创建Task/Run/Attempt、触发Action、发送Workflow signal或读取Secret值/业务正文。当前OAuth仍有write scope，但命令集合严格只读；后续0062、before和after是三个分离的production写动作，分别等待明确授权。
- Round 164默认分支交付补账：PR [#36](https://github.com/evilstar9527/delivery-loop/pull/36)以rebase merge进入main head `485b74e1db2736293d49e9676e48423c0a9eab40`；required PR CI [30416869034](https://github.com/evilstar9527/delivery-loop/actions/runs/30416869034)与合并后main CI [30417099480](https://github.com/evilstar9527/delivery-loop/actions/runs/30417099480)均`completed/success`，PR无review/requested changes/普通或行内评论。branch与rebase main的patch-id均为`eada222ddbaa96eb0c9c78decf826211fbfa0983`，local/remote分支已删除且main干净。
- Wrangler账号选择事实：首次`pnpm exec wrangler d1 migrations list DB_CONTROL --remote`在零远端写前固定失败，Wrangler 4.107.0报告多账号OAuth无法非交互选择；显式使用仓库已受审account ID后同一只读命令exit 0。发布窗口的每条D1/Worker命令因此必须显式设置`CLOUDFLARE_ACCOUNT_ID`，不能假定config会被所有子命令采用；错误日志只在Wrangler本机目录，没有进入仓库。
- Live readiness事实：远端unapplied inventory恰好只有`0062_codex_sol_relay_profile.sql`；read-only SQL安全聚合返回`total_profiles=1, terra=1, sol=0`。production deployment仍是`774826c8-fc4a-4e70-aa95-15f34deb759f`，100% version为`026915b2-d688-4711-a10e-6aaa970117a9`（version 7，创建于`2026-07-28T12:30:29.582621Z`），profile仍为`codex-gpt-5p6-terra-20260728`；binding计数为D1 1、R2 4、Queue producer 2、Workflow 2、plain text 6、Secret 3，Secret仅核对`GITHUB_APP_PRIVATE_KEY/OPERATIONS_TOKEN/TASK_INTAKE_TOKEN`名称。`/healthz`为200，但只证明isolate liveness。
- 本地发布物：`wrangler deploy --dry-run --outdir <temp> --metafile` exit 0；`worker.js`为2,808,881 bytes、SHA-256 `14b3ea16dd1d62b41639abe5680882a1f5dced3f19aee50305d95ac01b3adef8`。独立临时目录重跑两次得到相同size/hash；bundle/meta/source map均由临时目录自动清理，未入Git或Evidence。config固定Sol/high profile、D1 1、R2 4、Queue 2 producers/4 consumers、两个Workflow、每分钟Cron及persist logs/traces；dry-run没有上传或修改资源。
- 顺序裁决：必须先经授权应用0062，利用Wrangler自动backup与单migration失败回滚，再只读证明Terra/Sol各1且unapplied为空；随后才可用`--strict`发布before。若migration成功而deploy失败，保留immutable Sol profile，不手写DELETE。before成功后记录main/bundle/deployment/version并创建Task；只有唯一dispatch且Workflow进入wait后，才另行授权同main/bundle的唯一after。当前Terra version仅是人工review rollback anchor，`wrangler rollback`仍需新production授权，不能由失败自动触发。
- 动作：更新`docs/{WorkflowHibernateE2E,Security,Architecture}.md`、`docs/Reference.md`与`DOD.md`，把多账号scope、migration-first、两次`--strict`发布、独立授权、deterministic bundle和rollback边界变成规范/验收真源；没有修改Worker运行代码或llmdoc。
- 验证：
  - `CLOUDFLARE_ACCOUNT_ID=... pnpm exec wrangler d1 migrations list DB_CONTROL --remote` → exit 0，唯一unapplied为0062；无account env的同命令按预期固定失败且零写入。
  - `wrangler d1 execute ... SELECT aggregate`、`wrangler deployments status --json`、`wrangler versions view ... --json`与healthz probe → exit 0；只输出上述安全计数、ID、profile、binding名称和HTTP状态。
  - 两次独立`wrangler deploy --dry-run` → exit 0且worker bundle size/hash完全相同；首次含metafile的dry-run也exit 0。
  - `pnpm run e2e:workflow-hibernate` → 预期exit 2，在manifest/token/account/network前固定拒绝；只证明默认安全，不替代真实hibernate。
  - `pnpm exec vitest run test/workflow-hibernate-evidence.test.ts test/codex-provider-profile.test.ts test/workflow/quota-control.test.ts` → exit 0，3 files / 11 tests；`pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/quota-control.test.ts` → exit 0，1 file / 14 tests。`pnpm run verify:docs`、`pnpm run verify:secrets`与`git diff --check`均exit 0，498个生产文件Secret扫描与文档链接全绿。
  - 最终`pnpm run verify` → exit 0：typecheck、ESLint、Node 112 files / 523 tests、workerd 57 files / 309 tests、13 workflows / 13 jobs Runner policy、498文件Secret扫描和docs links全绿；workerd既有`User called terminate`为测试主动清理诊断，不是failure或skip。
- 五维review：正确性上识别出“直接deploy会引用缺失Sol profile”的顺序缺陷并固定migration-first，bundle重跑确定且profile/spec一致；安全上零production写、Secret只读名称、三次未来写分别授权、远端漂移由`--strict`拒绝；恢复性上保留旧Terra profile/version作为人工anchor，禁止自动rollback/手写D1，after只允许唯一wait窗口；三方契约上交叉Wrangler live deployment/version/D1、CLI help、repo migration/config和hibernate verifier，而非用healthz或dry-run替代平台事实；证据真实性上明确父项未勾、formal verifier未运行、production authority缺失。review后无未处理代码/规范BLOCKER或MAJOR，外部授权仍是执行前置。
- 勾选：新增并勾选Phase 1“真实hibernate production发布就绪契约”子项；真实Cloudflare hibernate、dispatcher、analysis与heartbeat父项保持未勾。
- 决策沉淀：生产顺序固定为`0062 → verify profile → before --strict → Task/wait → after --strict → callback/verifier`；D1 migration、两次deployment及任何rollback均不共享隐式授权。Watt固定commit没有Cloudflare D1/Worker发布窗口实现可复制，本轮只复用既有hibernate verifier和安全证据纪律。按owner要求不更新llmdoc。
- 遗留：等待owner明确授权production D1 migration 0062与第一次before Worker发布；before外部事实成功后再创建唯一Task。after发布不能预授权为任意未来动作，必须绑定本次Run/wait窗口再次确认或由同一明确演练授权覆盖exact两次deployment。

## Round 166 — 2026-07-29
- 目标：Phase 1“真实 Cloudflare 环境强制 hibernate/Worker restart，并以GitHub外部run证明dispatch仅一次”。本轮只闭环经owner精确授权的production migration 0062与第一次before Worker发布基线；父项仍要求唯一Task/Attempt/Action进入`await-analysis-result`、wait期间唯一after发布、正常callback及`pnpm run e2e:workflow-hibernate` exit 0，因此保持未勾。
- 前置与权限：owner明确授权“执行production D1 migration 0062，并执行第一次before Worker发布”。该授权不包含创建Task/Run/Attempt、触发GitHub Action、发送Workflow signal、after发布或rollback；全部Wrangler命令显式固定account，未读取或输出Secret值、业务正文、数据库行或provider响应。首次dry-run组合命令因本地安全策略拒绝临时目录删除而在创建构建物前终止，零远端写；随后改用仓库外固定临时目录，保留无Secret bundle用于本轮核对。
- Round 165默认分支交付补账：PR [#37](https://github.com/evilstar9527/delivery-loop/pull/37)以rebase merge进入main head `e14d11e5420e04d49c042a01c562ff5432ebb98c`；required PR CI [30418565258](https://github.com/evilstar9527/delivery-loop/actions/runs/30418565258)与合并后main CI [30418761173](https://github.com/evilstar9527/delivery-loop/actions/runs/30418761173)均`completed/success`，PR无review/requested changes/普通或行内评论。branch/main patch-id均为`875e490c5dabae2eb7025812f7489d93f4c4a982`，local/remote分支已删除且main干净。
- 写入前冻结：fetch后HEAD与`origin/main`均为`e14d11e...`且零diff；远端唯一unapplied仍为0062，安全聚合仍为profile total=1/Terra=1/Sol=0；100% production仍是旧deployment `774826c8-fc4a-4e70-aa95-15f34deb759f`与version `026915b2-d688-4711-a10e-6aaa970117a9`。两次独立`wrangler deploy --dry-run`均产生2,808,881-byte `worker.js`、SHA-256 `14b3ea16dd1d62b41639abe5680882a1f5dced3f19aee50305d95ac01b3adef8`，与Round 165冻结值一致；没有漂移后才进入写入。
- Production D1结果：`wrangler d1 migrations apply DB_CONTROL --remote`只列出并成功应用`0062_codex_sol_relay_profile.sql`，Wrangler报告2条命令完成。随后migration list为`No migrations to apply`；只读聚合返回total=2、Terra=1、Sol=1、exact Sol=1，exact断言同时绑定profile/provider/model、200k/40k token上界、三项micro-USD价格与enabled=1，查询`rows_written=0`。
- Production before结果：`wrangler deploy --strict --message "phase1-hibernate-before main@e14d11e..."` exit 0，上传约2743.05 KiB/gzip 460.23 KiB并成功更新cron、两个Queue producer、四个Queue consumer与两个Workflow。新deployment `8b646225-4d71-4867-aff3-f22d137a8fa5`在`2026-07-29T04:56:43.836021Z`把version 8 `6911feca-acf7-476a-b10c-cc61e71aedad`置为100%，message精确绑定main SHA；旧Terra version只保留为人工rollback anchor且本轮未rollback。
- 发布后外部核对：version API返回Sol/high profile，binding计数为D1 1、R2 4、Queue producer 2、Workflow 2、plain text 6、Secret 3；Secret只核对`GITHUB_APP_PRIVATE_KEY/OPERATIONS_TOKEN/TASK_INTAKE_TOKEN`名称。四条Queue consumer分别保持3次→DLQ和100次/60秒→quarantine策略；发布输出确认每分钟Cron及双Workflow trigger，`/healthz=200`。D1安全聚合为Task=0、Run=0、Attempt=0、outbox=0，证明本轮没有越权创建业务执行；healthz、migration、deployment与binding事实均不冒充dispatch或hibernate。
- 验证：
  - `CLOUDFLARE_ACCOUNT_ID=... pnpm exec wrangler d1 migrations list/execute/apply`、`wrangler deploy --dry-run/--strict`、`wrangler deployments status/list`、`wrangler versions view`、四次`wrangler queues consumer list`与healthz probe → 所有实际执行命令exit 0；唯一预执行拒绝是含临时目录删除的本地组合命令，零构建/远端effect且已改为非删除路径。
  - `pnpm run e2e:workflow-hibernate` → 预期exit 2，在manifest/token/account/network前固定拒绝；只证明默认安全门禁，不替代当前尚不存在的真实Run/hibernate证据。
  - `pnpm exec vitest run test/workflow-hibernate-evidence.test.ts test/codex-provider-profile.test.ts test/workflow/quota-control.test.ts` → exit 0，2 files / 11 tests；`pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/quota-control.test.ts` → exit 0，1 file / 14 tests。`pnpm run verify:docs`、`pnpm run verify:secrets`与`git diff --check`均exit 0，498个生产文件Secret扫描与文档链接全绿。
  - 最终`pnpm run verify` → exit 0：typecheck、ESLint、Node 112 files / 523 tests、workerd 57 files / 309 tests、13 workflows / 13 jobs Runner policy、498文件Secret扫描和docs links全绿；workerd既有`User called terminate`为测试主动清理诊断，不是failure或skip。
- 五维review：正确性上migration-first与exact Sol字段、before message/main/bundle/deployment全部绑定；安全上授权只消费0062与一次before，零Task/Action/after/rollback且Secret仅名称；恢复性上旧version保留为无自动权限的人工anchor，新version只是未来wait窗口before基线；三方契约上交叉Wrangler D1/deployment/version/consumer、Git main/config与healthz，没有用单一CLI自报代替；证据真实性上DOD只新增勾选before基线子项，真实hibernate、dispatcher、analysis与heartbeat父项继续未勾。当前无未处理BLOCKER/MAJOR。
- 勾选：新增并勾选Phase 1“真实hibernate Sol/high before production基线”子项；真实Cloudflare hibernate/唯一dispatch、真实analysis Action与heartbeat父项保持未完成。
- 决策沉淀：当前受审before固定为main `e14d11e...`、deployment `8b646225...`、version `6911feca...`和上述bundle digest；任何新deployment都会使该窗口失效并必须重新裁决。Watt固定commit没有Cloudflare生产migration/deployment实现可复制，本轮继续复用既有Wrangler与hibernate verifier，不自造发布协议；按owner要求不更新llmdoc。
- 遗留：下一步需要独立授权创建一个最小人工Task并触发唯一analysis Action，确认同一Workflow instance进入`await-analysis-result`且唯一dispatch；该事实成立后才能绑定安全Run ID申请唯一after发布授权。当前未创建Task，因此不得提前运行formal verifier或勾选父项。

## Round 167 — 2026-07-29
- 目标：Phase 1“`DeliveryRunWorkflow`强制hibernate/restart后复用成功步骤、dispatch一次且D1投影正确”的conditional-after fail-closed本地子契约。Round 166已经建立真实before，但固定analysis Runner在Plan提交后立即调用attempt complete；本轮消除“Task创建后再等待人工after授权”的竞态，不把纯函数、模拟快照或测试成功冒充真实after/hibernate。
- 前置与权限：只读审计仓库内Workflow、analysis Runner、attempt complete/outbox及既有hibernate verifier；仓库写入只包含源码、测试与规范。没有读取本机或Cloudflare Secret值，没有创建Task/Run/Attempt、触发GitHub Action、调用模型、发送Workflow signal、写D1、发布/rollback Worker或修改外部配置；Round 166的production授权没有被扩展。
- 红灯：先新增`test/workflow-hibernate-window-guard.test.ts`并运行`pnpm exec vitest run test/workflow-hibernate-window-guard.test.ts`，因生产模块不存在得到1 failed suite / 0 tests。该失败在任何live collector、网络或production dependency之前发生，外部effect为0。
- 实现：新增`executeConditionalHibernateAfter`及typed snapshot/request/result/error。immutable expectation绑定exact source SHA、bundle SHA-256、before deployment/version、Run/Attempt和固定最多5秒snapshot age（调用方不能放宽）；函数连续读取两次live snapshot，每次都要求干净source、两次matching bundle build、before 100%且wait内零deployment、唯一planning Run/Workflow、唯一未完成analysis Attempt、唯一settled dispatch outbox、唯一queued/in-progress Action、零result signal、active `await-analysis-result`及零resumed step。两次identity必须稳定，任何callback/duplicate/流量/时间/源码漂移都在deploy dependency前固定拒绝。
- after边界：两次guard成立后只向注入的dependency发出一次`strict=true`请求，message固定绑定安全run ID；post-check要求不同deployment/version、100% traffic、wait内deployment总数恰好1、同一instance/wait且`after.createdAt < wait.endedAt`或wait仍未结束。模块没有rollback dependency；deploy provider异常折叠为固定`after_deploy_failed`且不传播raw错误。参数、fake collector和本地测试都不能产生production authority，真实调用仍须owner明确授权与live adapter。
- 规范与复用：`docs/WorkflowHibernateE2E.md`和`docs/Security.md`同步一次性conditional authority、双fresh guard、post-check及无自动rollback；`DOD.md`只勾本地guard子项，真实Cloudflare父项保持未勾。Watt固定commit没有Cloudflare deployment/Workflow live-window guard可复制；复用已有Watt-derived injected-effect与固定安全错误测试形状，没有虚构业务代码来源。按owner要求不更新llmdoc。
- 验证：
  - `pnpm exec vitest run test/workflow-hibernate-window-guard.test.ts` → exit 0，1 file / 25 tests；覆盖success、两次guard、SHA/bundle/dirty、单build、before/traffic/既有deployment、Attempt/outbox/callback、Action、wait/resume、stale/identity、freshness不可放宽、post-check、固定Secret-safe错误及配置拒绝。
  - `pnpm run typecheck`与`pnpm exec eslint src/pilot/workflow-hibernate-window-guard.ts test/workflow-hibernate-window-guard.test.ts src/index.ts` → exit 0。
  - `git diff --check`、`pnpm run verify:docs`、`pnpm run verify:secrets` → exit 0；文档链接与499个生产文件Secret扫描全绿。
  - `pnpm run verify` → exit 0；typecheck、ESLint、Node 113 files / 548 tests、workerd 57 files / 309 tests、13 workflows / 13 jobs Runner policy、499文件Secret scan和docs links全绿。workerd的`User called terminate`仍是既有测试主动清理诊断，不是failure或skip。
- 五维review：正确性上双snapshot与identity重验缩短TOCTOU窗口，callback/result signal、重复Action或当前deployment漂移都会在after前拒绝，成功后时间/流量/唯一deployment再核对；安全审查先发现调用方可把文档固定5秒放宽到30秒的MAJOR并收紧为exact 5000ms负向契约，authority不能由参数自造，模块不接触token、Task正文或raw provider响应，错误固定且零rollback；恢复性上只观察普通production路径，不加入测试专用pause/手写D1/直接signal，第二次调用会因before已变化而fail-closed；三方契约上分别绑定D1安全投影、Cloudflare instance/deployment与GitHub Action状态，live collector仍明确缺失而没有用fake替代；证据真实性上红灯、25项定向测试与全量验证只支持本地子项，真实Task/Action/after/verifier均未声称完成。修复后无未处理BLOCKER/MAJOR。
- 勾选：Phase 1“真实hibernate conditional-after fail-closed本地契约”子项；真实Cloudflare hibernate、dispatcher、analysis Action与heartbeat父项均保持未完成。
- 遗留：生产演练仍需要安全取得`TASK_INTAKE_TOKEN`（原值不在当前进程且Cloudflare Secret不可回读）并取得一次明确授权，覆盖exact一个最小Task、exact一次付费只读analysis Action，以及仅在本guard成立时的一次after发布；guard不满足则after写入必须为0。还需把live D1/Cloudflare/GitHub collector和Wrangler deploy adapter接到本协调原语，随后才可执行formal manifest/verifier。未经授权不得轮换Secret、创建Task、after或rollback。

## Round 168 — 2026-07-29
- 目标：Phase 1“`DeliveryRunWorkflow`强制hibernate/restart后复用成功步骤、dispatch一次且D1投影正确”的live-window执行入口本地子契约。本轮只把Round 167纯guard接到真实HTTP/CLI adapter与默认关闭的operator CLI；真实关门仍要求owner批准exact Task/Action/conditional-after、同一Workflow instance正常callback及`pnpm run e2e:workflow-hibernate`读取live事实exit 0，因此父项保持未勾。
- 前置与权限：仓库写入只包含源码、测试、schema示例、规范与证据账本；Wrangler 4.107.0只运行`--help`和两条本地`--dry-run`。没有读取本机/Cloudflare/GitHub Secret值，没有调用控制面或外部API，没有创建Task/Run/Attempt、触发Action/模型、发送Workflow signal、发布/rollback Worker或修改Cloudflare/GitHub配置。Round 166的0062/before授权没有扩展；当前生产before仍由此前只读复核证明为deployment `8b646225-4d71-4867-aff3-f22d137a8fa5`、version `6911feca-acf7-476a-b10c-cc61e71aedad`、100%与healthz 200。
- 红灯：adapter穿透测试首次为11项中2项失败，分别暴露snapshot没有使用注入时钟及shared Cloudflare read/deploy token测试写法；修复后又先把exact no-bundle argv写入测试，得到12项中1项失败；继续先加入空`--env-file`与隔离HOME/XDG期望，再得到12项中1项失败。CLI草稿首次typecheck因非module top-level await exit 2，ESLint因未使用参数exit 1。所有红灯都发生在fake command/fetch或编译阶段，外部effect为0。
- 实现：新增strict `WorkflowHibernateWindowAuthorizationV1`、canonical authority digest、Task/source/before/effect绑定与`executeWorkflowHibernateLiveWindow`。authorization最长30分钟并绑定完整Task envelope/revision digest、deterministic Task/Run/analysis Attempt、repository/base、Action head、frozen source/bundle bytes+digest、before deployment/version/time以及Task=1/Action=1/after=1/rollback=0；digest只证明文件未漂移，不能自造owner authority。执行顺序固定为Task/schema/readonly policy→clean source+两次bundle→current before→Task不存在→一次idempotent intake→最长5分钟只重试not-ready→两次fresh guard→一次after，其他错误全部fail-closed。
- 真实adapter：控制面分别读取Task/Plan和Case 8，GitHub以固定workflow+stable title+branch+head查询唯一active Action，Cloudflare读取exact Workflow instance和最多100条deployment；404只在明确未就绪位置重试，identity/duplicate/callback/分页/超限/Secret/非法shape固定拒绝。五枚Task/operations/GitHub/Cloudflare-read/Cloudflare-deploy token必须互不相同，只进入对应header或deploy环境。HTTP为HTTPS、10秒、1 MiB、redirect/next-page拒绝且parse前Secret scan；命令为120秒/1 MiB且raw stdout/stderr永不传播。每个adapter实例最多一次Task POST与一次deploy attempt，post-deployment visibility只读有界轮询，代码没有rollback dependency。
- Exact bundle：双dry-run的第一份bundle只保存在进程内存；after写入仓库外0600临时`worker.js`并重算bytes/hash，再执行`wrangler deploy <worker.js> --no-bundle --strict --message <safe-run-id>`。每条Wrangler命令显式使用同临时目录的0600空env file并隔离HOME/XDG，避免ignored dotenv或本机OAuth成为隐式输入；finally清理adapter临时文件。本机锁定CLI先普通dry-run再以生成的worker.js做no-bundle dry-run，两份均为2,808,881 bytes、SHA-256 `14b3ea16dd1d62b41639abe5680882a1f5dced3f19aee50305d95ac01b3adef8`，upload/gzip与D1/R2/Queue/Workflow/plain vars安全binding投影一致；这是本地exact-byte契约，不是after deployment。
- Operator CLI：新增`pnpm run ops:workflow-hibernate-window`，未opt-in在文件/credential/network/command前exit 2；配置缺失或仓库外文件不可用exit 2，invalid/execution failure exit 1，成功只输出安全ID和固定effect计数。两份输入必须是仓库外absolute普通非symlink文件、权限不宽于0600、各64 KiB有界并在JSON parse前扫描五枚runtime token/credential形状。示例Task与authorization canonical绑定但已过期且位于仓库内，既不能通过CLI文件门禁也不能产生authority。
- 规范与复用：更新`docs/{WorkflowHibernateE2E,Security,Architecture}.md`、`docs/Reference.md`、`DOD.md`、public exports及package script。直接复用Watt固定commit的injected effect、显式opt-in、仓库外64 KiB、固定0/1/2、有界I/O与固定错误骨架；Watt没有Cloudflare Workflow/deployment、D1 Case 8、GitHub stable-title或conditional deploy业务adapter，未虚构可复制代码。新增部分只组合本项目既有Task API、hibernate guard/verifier和外部事实parser。按owner要求不更新llmdoc。
- 验证：
  - `pnpm exec vitest run test/workflow-hibernate-live-window.test.ts test/workflow-hibernate-live-adapters.test.ts test/workflow-hibernate-window-guard.test.ts` → exit 0，3 files / 49 tests；覆盖authorization/Task/source/before绑定、canonical examples、timeout与默认CLI，exact git/Wrangler argv、双build drift、五token用途隔离、完整snapshot/404/duplicate、分页/1 MiB/Secret、visibility poll、single deploy及raw provider error折叠。
  - `pnpm exec wrangler deploy --help` → exit 0，锁定CLI同时公开position path、`--no-bundle`与`--strict`；普通dry-run、no-bundle dry-run、`shasum -a 256`与`cmp -s`均exit 0，两个worker.js字节完全相同且digest为上述冻结值。全部构建物在仓库外，不是Evidence或production写。
  - `pnpm run ops:workflow-hibernate-window` → 预期exit 2，在任何输入/命令/网络前固定输出opt-in missing；测试另覆盖opt-in但配置缺失、仓库外文件缺失均exit 2且不回显环境值。
  - `pnpm run verify:secrets`、`pnpm run verify:docs`与`git diff --check` → exit 0；504个生产文件Secret扫描和文档链接全绿。
  - 最终`pnpm run verify` → exit 0：typecheck、ESLint、Node 115 files / 572 tests、workerd 57 files / 309 tests、13 workflows / 13 jobs Runner policy、504文件Secret scan和docs links全绿。workerd的`User called terminate`仍是既有测试主动清理诊断，不是failure或skip。
- 五维review：正确性上authorization把全部预期effect/identity冻结且Task前重验source/before，live collector只轮询明确not-ready，exact prebuilt bundle消除after重构建漂移；安全上发现并修复Wrangler默认dotenv/OAuth隐式输入，五token用途隔离、输入0600/有界/no-symlink、parse前扫描、raw输出丢弃且零rollback；恢复性上每adapter一次effect、idempotent Task、双guard与post-query使进程失败不会重发after，真正恢复仍由同一Workflow普通wait/callback完成；三方契约上复用生产API shape并以锁定Wrangler实际help+双dry-run核对no-bundle，而非仅采信类型/fake；证据真实性上只勾本地执行入口，不把CLI默认exit 2、fake fetch、dry-run或既有before冒充Task/Action/after/hibernate。review后无未处理BLOCKER或MAJOR。
- 勾选：Phase 1“真实hibernate live-window执行入口本地契约”子项；真实Cloudflare hibernate、唯一dispatch、真实analysis Action与heartbeat父项均保持未完成。
- 遗留：真实演练仍需要owner对一份fresh exact authorization明确批准并安全注入原`TASK_INTAKE_TOKEN`、独立`OPERATIONS_TOKEN`、单仓库Actions read、Cloudflare Workflow/deployment read和Worker deploy五项凭证。该授权覆盖exact一个最小只读Task、exact一次付费analysis Action和仅在guard成立时的一次after；guard不成立则after必须为0，且永不包含rollback/repo write。CLI成功后仍需等待正常callback、生成仓库外formal manifest并运行`pnpm run e2e:workflow-hibernate`；未经该新授权不得运行operator CLI。

## Round 169 — 2026-07-29
- 目标：Phase 1“`DeliveryRunWorkflow`强制hibernate/restart后复用成功步骤、dispatch一次且D1投影正确”。本轮先把Round 168已验证的live-window operator线性交付到默认分支并补齐外部PR/main证据；真实Task/Action/after/hibernate仍等待fresh exact authority，因此父项保持未勾。
- 前置与权限：使用现有GitHub登录态对`evilstar9527/delivery-loop`执行branch push、ready PR与受保护分支rebase merge，并只读查询CI、review和comments。未调用控制面Task API、GitHub workflow dispatch、模型、Cloudflare写API或Worker deploy；未读取/输出任何Secret，Round 166的0062/before授权没有复用或扩大。
- 动作：`git fetch origin main`后确认分支merge-base等于最新`origin/main`、main侧无新增commit且重叠文件为空；保留`feat`→`docs`两条线性提交，不做无意义rebase或历史改写。推送`codex/phase1-hibernate-live-window`并创建ready PR [#40](https://github.com/evilstar9527/delivery-loop/pull/40)，required CI成功后分别核对review summaries、requested changes、普通评论与行内评论均为空，再按仓库策略rebase merge。远端`main`形成`09b5f70`→`91c2a8c`两条线性提交；没有删除本地用户文件或自动修改生产状态。
- 验证：
  - `git diff --check origin/main..HEAD`与`pnpm exec vitest run test/workflow-hibernate-live-adapters.test.ts test/workflow-hibernate-live-window.test.ts test/workflow-hibernate-window-guard.test.ts` → exit 0，3 files / 49 tests。
  - PR [#40](https://github.com/evilstar9527/delivery-loop/pull/40) required CI [30429839970](https://github.com/evilstar9527/delivery-loop/actions/runs/30429839970) → `completed/success`，唯一`verify` job的`pnpm run verify` step success；PR最终为`CLEAN/MERGEABLE`，无review/requested changes/普通或行内评论。
  - 合并后`main` head为`91c2a8c4b316a664f6da29f72d8b8580d5c4e0f3`；main CI [30430196387](https://github.com/evilstar9527/delivery-loop/actions/runs/30430196387) → `completed/success`，唯一`verify` job 3m19s通过。Node 20 Action被GitHub强制Node 24运行的annotation是已记录MINOR，不是failure或blocking feedback。
- 勾选：不新增父项勾选；仅把Round 168已勾live-window本地契约的默认分支、PR CI与main CI外部交付证据补入`DOD.md`。真实hibernate、唯一dispatch、真实analysis Action与heartbeat父项继续未完成。
- 决策沉淀：当前生产before仍固定source `e14d11e5420e04d49c042a01c562ff5432ebb98c`、bundle SHA-256 `14b3ea16dd1d62b41639abe5680882a1f5dced3f19aee50305d95ac01b3adef8`、deployment `8b646225-4d71-4867-aff3-f22d137a8fa5`和version `6911feca-acf7-476a-b10c-cc61e71aedad`；operator进入main不改变该before锚点。after必须从独立clean detached source复核并上传exact before bundle，不能把当前main重新构建物当同一窗口after。按owner要求不更新llmdoc。
- 遗留：下一步仍需owner批准一份30分钟内fresh exact authority，scope只能是一个只读Task、一个付费analysis Action、guard成立时一个after deployment、零rollback/repo write；并需在操作者环境安全注入五枚用途隔离且互不相同的凭证。Task/Action/after任一未明确授权或credential不齐时不得运行`ops:workflow-hibernate-window`；可继续推进的最小人工输入是确认该exact演练并完成凭证注入。

## Round 170 — 2026-07-29
- 目标：Phase 1“真实 Cloudflare 环境强制hibernate/Worker restart并证明dispatch一次”的exact Task候选前置。本轮只冻结后续owner authority要绑定的数据对象并证明production尚无同identity业务记录；不生成有时效authority、不创建Task或执行任何外部effect，父项保持未勾。
- 前置与权限：仓库外目录`/Users/jishihe/.codex/delivery-loop/hibernate-window`权限0700，Task文件权限0600且不含Secret；使用当前仓库schema/canonical算法和现有Wrangler OAuth只读D1。仅检查五个运行环境变量是否present/missing，全部为missing且没有读取、打印或搜索其值；未调用控制面、GitHub API/Action、模型、Cloudflare Workflow/deployment写API。
- 动作：冻结一份synthetic只读requirement Task，目标为`evilstar9527/delivery-loop@main`，要求只读分析下一个Phase 1未完成DoD并以repo evidence给出Plan；policy精确为repo/test/production write全false、require human approval=true。Task schema解析后用生产相同算法计算envelope/revision digest与deterministic identity；首次临时`tsx -e`因CJS不支持top-level await而exit 1，改为async IIFE后成功，未改变Task文件或触发外部effect。
- 验证：
  - `stat`与`TaskEnvelopeSchema.parse` → exit 0；仓库外Task文件为0600、1,134 bytes，schema合法且不进入Git。envelope digest=`sha256:13ac498adbe3d208e781dc408f6c40f87a40754f9e2fdc33d80f677d9ef7634b`，revision digest=`sha256:071ae4b46ae1ee8c46747c4c979418265440b3d356c00c198952d4a014470d0c`。
  - deterministic identity：Task=`task_f9694dd75862aa4aa674cb003f43253d71627b9f7e9ab1cda2b4e944`，Run=`run_f9694dd75862aa4aa674cb003f43253d71627b9f7e9ab1cda2b4e944`，Attempt=`analysis-run_f9694dd75862aa4aa674cb003f43253d71627b9f7e9ab1cda2b4e944-1`；拟用idempotency key仅作为待授权数据，尚未发送。
  - `wrangler d1 execute DB_CONTROL --remote --command <exact identity counts> --json` → exit 0；Task/Run/Attempt count均为0，`changes=0`、`rows_written=0`。该只读事实只证明identity未占用，不是Task创建或hibernate Evidence。
  - `pnpm run verify:docs`、`pnpm run verify:secrets`与`git diff --check` → exit 0；504个生产文件Secret扫描与文档链接全绿，Task正文、credential值和raw D1行不进入账本。
- 勾选：新增并勾选“真实hibernate exact Task候选前置”子项；真实Cloudflare hibernate、唯一dispatch、analysis Action与heartbeat父项继续未完成。
- 决策沉淀：Task内容可提前冻结，但`WorkflowHibernateWindowAuthorizationV1`最长30分钟，只有owner明确批准后才能按当时live main head/current before重新生成并验digest；提前造一份未来时间或复用过期example都不是authority。当前before锚点仍为source `e14d11e...`及deployment `8b646225...`，当前main `91c2a8c...`只作为拟触发Action head，二者不得混用。按owner要求不更新llmdoc。
- 遗留：同一外部前置连续第二轮仍缺：owner尚未明确授权一个Task、一个付费Action及guard成立时一个after，五枚用途隔离token也未安全注入。若现有TASK/operations原值不可取，需要owner另行批准Secret轮换和新的before基线；未经批准不得用宽权限GitHub登录态或Wrangler OAuth绕过operator隔离。

## Round 171 — 2026-07-29
- 目标：Phase 1“真实 Cloudflare 环境强制hibernate/Worker restart并证明dispatch一次”的三轮blocker审计。本轮不再重跑production查询或构建，而是按`AGENTS.md`/`LOOP.md`记录重复阻塞、已完成路径和恢复所需最小人工输入后停止盲重试；父项保持未勾。
- 前置与权限：仅检查当前Git分支、仓库外Task文件权限和五个credential环境变量的present/missing状态；没有读取值，没有调用D1/控制面/GitHub/Cloudflare网络，没有Task、Action、模型、deployment、rollback、Secret轮换或repo write effect。Round 170的production D1零identity事实仍可复用，不重复查询数据库。
- 已完成尝试：Round 168完成并验证默认关闭的live-window operator、五token用途隔离、双guard与exact no-bundle after；Round 169经PR [#40](https://github.com/evilstar9527/delivery-loop/pull/40)及PR/main CI把operator交付到默认分支；Round 170冻结0600只读Task候选、计算canonical digest与deterministic Task/Run/Attempt，并只读证明production对应计数全0。三轮均严格保持Task/Action/after/rollback为0，没有用本地契约冒充真实hibernate。
- 当前重复blocker：owner尚未明确批准exact effects=`taskCreates:1 + paid analysisActions:1 + guarded afterDeployments:1 + rollbacks:0 + repoWrite:0`；`WORKFLOW_HIBERNATE_WINDOW_{TASK_TOKEN,OPERATIONS_TOKEN,GITHUB_TOKEN,CLOUDFLARE_READ_TOKEN,CLOUDFLARE_DEPLOY_TOKEN}`仍全部missing。现有`gh`登录态与Wrangler OAuth权限更宽，按安全契约不能替代五枚用途隔离token。
- 验证：
  - `git status --short --branch`与仓库外`stat` → exit 0；分支此前提交均已推送，Task候选仍为普通0600文件、1,134 bytes。
  - 五环境变量只做非空presence检查 → exit 0，结果全部missing；未输出value、长度、digest或来源。
  - `pnpm run verify:docs`、`pnpm run verify:secrets`与`git diff --check` → exit 0；504个生产文件Secret扫描和文档链接全绿。不重跑D1、build、Action或deploy，因为外部状态和授权前置没有变化。
- 勾选：无。真实hibernate、唯一dispatch、analysis Action与heartbeat父项全部保持未完成；不以blocker记录替代DoD证据。
- 决策沉淀：满足“三轮未闭环即停止盲重试”阈值，将持续目标置为blocked而不是继续制造无效子契约。已冻结Task候选与before锚点保留，但30分钟authorization必须在恢复时按live main/current before重新生成，旧口头授权、过期example或宽权限credential均不可复用。按owner要求不更新llmdoc。
- 恢复所需最小人工输入：owner回复以下二者之一——`授权exact演练；现有TASK/OPS原值可安全取用`，或`授权exact演练；TASK/OPS原值不可取，并授权轮换两枚Secret、重新发布before及创建最小权限GitHub/Cloudflare token`。Secret不得粘贴到聊天；恢复后通过系统钥匙串/已登录控制台安全注入，再执行唯一一次operator与formal verifier。

## Round 172 — 2026-07-29
- 目标：Phase 1真实hibernate演练的authority恢复与无副作用execution preflight。owner选择Round 171的第一条恢复路径后，本轮只准备clean before源码、重验production冻结事实并建立安全credential handoff；30分钟authorization要等全部凭证ready后才生成，父项保持未勾。
- 前置与权限：owner明确回复`授权exact演练；现有TASK/OPS原值可安全取用`。授权精确覆盖一个只读Task、一次付费analysis Action、双guard成立时一次after deployment、零rollback/零repo write；不允许Secret轮换、额外deployment、第二Task/Action或宽权限credential旁路。本轮只用GitHub/Cloudflare/D1只读查询、本地依赖安装/双build和已登录浏览器登录页；没有生产写。
- 动作：在仓库外创建detached worktree `/Users/jishihe/.codex/delivery-loop/hibernate-before-e14d11e`并锁定source `e14d11e5420e04d49c042a01c562ff5432ebb98c`，`pnpm install --frozen-lockfile`只复用本机store。首次把尚不存在目录设为command workdir导致进程创建前失败；随后分两步成功。第一次从旧worktree运行当前operator import因该commit尚无模块而本地exit 1；改从当前受审operator分支调用、sourceDirectory仍指向detached before后双build成功，外部effect始终为0。
- 冻结与live preflight：operator的真实`verifyFrozenSource`以临时0600空env和隔离HOME/XDG运行两次Wrangler dry-run，得到clean=true、matching builds=2、2,808,881 bytes与SHA-256 `14b3ea16dd1d62b41639abe5680882a1f5dced3f19aee50305d95ac01b3adef8`，精确匹配Round 165/166 before。GitHub read返回`main=91c2a8c4b316a664f6da29f72d8b8580d5c4e0f3`；Wrangler read返回deployment `8b646225...`/version `6911feca...`仍100%；D1 exact identity count仍Task=Run=Attempt=0、`rows_written=0`；healthz 200。
- Credential handoff：按browser skill先确认没有适用的token-create connector/API/CLI，再使用in-app browser打开GitHub fine-grained token页与Cloudflare API token页。GitHub要求owner完成sudo verification，Cloudflare要求owner登录；没有读取验证码、密码、cookie、storage或提交表单。仓库外0700 helper只调用macOS`security add-generic-password ... -w`的系统隐藏输入，把现有TASK/OPS原值直接放Keychain；脚本不含value且不写history/仓库，已在Terminal打开等待owner输入。三个页面/终端都不是credential-ready证据。
- 验证：
  - detached worktree `git rev-parse HEAD`、`git status --porcelain`与`pnpm install --frozen-lockfile` → exit 0，exact head且tracked/untracked clean。
  - `verifyFrozenSource` → exit 0，输出仅上述source/hash/bytes/build count/clean安全字段；raw Wrangler输出与本地fake token不落账本。
  - GitHub main、Cloudflare deployment、D1 identity聚合、healthz四条只读查询 → exit 0，结果如上且D1零写。
  - `pnpm run verify:docs`、`pnpm run verify:secrets`与`git diff --check` → exit 0；504个生产文件Secret扫描与文档链接全绿，credential值、验证码、登录信息和browser raw state不进入仓库/账本。
- 勾选：新增并勾选“owner authority恢复与execution preflight”子项；真实hibernate/唯一dispatch/analysis/heartbeat仍未完成。
- 决策沉淀：本轮browser skill要求token创建优先用purpose-built surface；GitHub CLI/Cloudflare Wrangler都不能签发所需最小token，才回退已有登录态UI。技能的action-time确认由owner本轮exact授权覆盖，但sudo/Cloudflare登录仍由owner本人完成。30分钟authority不会在人工认证前提前生成或伪造有效期；按owner要求不更新llmdoc。
- 遗留：等待owner在GitHub标签页完成sudo verification、在Cloudflare标签页登录，并在Terminal完成TASK/OPS两次Keychain隐藏输入后回复“已完成”。随后创建并立即安全存储GitHub Actions-read、Cloudflare Workflow/deployment-read及Worker-deploy三枚token，核对五值互异和scope，再生成fresh authority并执行唯一operator。

## Round 173 — 2026-07-29
- 目标：Phase 1真实hibernate演练恢复后的三轮credential handoff blocker审计。owner exact effects授权已存在，但本人认证/隐藏输入连续三轮未完成；按`AGENTS.md`/`LOOP.md`再次停止盲重试并保留安全handoff，父项保持未勾。
- 前置与权限：只检查macOS Keychain service是否存在、helper进程名、Git状态与Cloudflare tab的URL/title；没有使用`security -w`读取值，没有读取browser cookie/storage/password/验证码，没有点击登录/生成token，也没有D1/Task/Action/model/Cloudflare deployment/rollback/Secret rotation外部effect。
- 三轮事实：Round 172首次打开GitHub sudo、Cloudflare login及TASK/OPS Keychain helper；随后只读复核发现GitHub sudo已完成并到达fine-grained token表单，但Cloudflare仍为login，helper仍等待第一枚TASK token。第三次复核结果相同：`delivery-loop-hibernate-{task,operations}-token`均missing，helper进程仍运行，Cloudflare URL仍为`/login?redirect_uri=/profile/api-tokens`。未把GitHub单项进展冒充credential ready。
- 已尝试路径：两次把GitHub/Cloudflare页面保留为in-app browser handoff；仓库外0700 helper已在Terminal运行并使用系统隐藏输入接口；每轮明确要求不要把Secret发到聊天。重复打开页面、猜登录方式、读取密码管理器/clipboard/keychain value、用Wrangler OAuth代替隔离token或提前提交GitHub token表单都不会解除本人认证边界，因此不再执行。
- 验证：
  - `security find-generic-password -s <service>`仅以exit code检查metadata → 两项missing；未请求`-w`且零value输出。
  - `pgrep -fl store-task-ops.command` → helper仍在等待；只输出进程名/路径，不含stdin。
  - browser tab list → GitHub fine-grained token form ready，Cloudflare仍在login；未读取或保存raw DOM/截图到仓库。
  - `pnpm run verify:docs`、`pnpm run verify:secrets`与`git diff --check` → exit 0；504个生产文件Secret扫描和文档链接全绿。不重跑source/build/D1/live preflight，因为Round 172事实仍冻结且credential前置未变。
- 勾选：无。真实hibernate、唯一dispatch、analysis Action与heartbeat继续未完成；owner authorization和GitHub sudo不替代五token或外部effect证据。
- 决策沉淀：目标重新置为blocked不是撤销owner authority，而是防止30分钟authorization在本人认证前被提前生成/过期或生产窗口被部分执行。恢复时必须重新只读核对main/before/Task identity并生成fresh文件；现有source worktree、Task候选、浏览器tabs和Terminal helper保留。按owner要求不更新llmdoc。
- 恢复所需最小人工输入：owner在Cloudflare页完成登录、在Terminal完成TASK/OPS两次隐藏输入后回复`已完成`。不要在聊天中发送Secret；收到确认后先metadata/最小scope核对，再在提交GitHub/Cloudflare token创建表单前使用owner本轮确认作为action-time authority，随后执行唯一operator。

## Round 174 — 2026-07-29
- 目标：解除Phase 1真实hibernate演练的TASK/operations credential blocker，并在Secret变更后建立可供fresh authorization绑定的新before基线；本轮不创建Task、触发Action、运行模型、发布after或rollback，父项保持未勾。
- 前置与权限：owner明确表示`TASK_INTAKE_TOKEN、OPERATIONS_TOKEN`由Codex自行设定，并确认Cloudflare operator可直接使用API token。该输入授权两枚服务Secret轮换及其必需的新before基线；既有exact effect上限仍为一个只读Task、一次付费analysis Action、双guard成立时一次after、零rollback/零repo write。本轮使用Wrangler现有OAuth只完成Secret管理与before发布，不把其宽权限登录态代替正式operator的Cloudflare read/deploy两枚用途隔离token。
- 安全实现：在仓库外0700目录新增0600 Swift helper，使用`SecRandomCopyBytes`生成两枚不同的32-byte随机token，分别更新macOS Keychain service；helper把两值仅在内存中序列化并经stdin交给一次`wrangler secret bulk`，子进程stdout/stderr直接丢弃，token不进入argv、shell history、仓库、artifact或账本。Keychain回读只在helper内做exact相等校验，外部仅输出`rotation/keychain/distinct=true`；旧Task token被覆盖、缺失的operations token被创建。
- 生产变更：Secret bulk成功并生成中间deployment `aa568a12-3379-45b3-be4a-82d253bc7f33` / version `1bcbe27c-4e0b-4673-a8a8-269263483dec`（100%）。随后fetch确认`origin/main=91c2a8c4b316a664f6da29f72d8b8580d5c4e0f3`，建立detached worktree `/Users/jishihe/.codex/delivery-loop/hibernate-before-91c2a8c`并以frozen lockfile复用本地pnpm store。受审operator真实`verifyFrozenSource`使用临时0600空env和隔离HOME/XDG执行两次Wrangler dry-run，证明source clean、matching builds=2、bundle 2,808,881 bytes且SHA-256为`14b3ea16dd1d62b41639abe5680882a1f5dced3f19aee50305d95ac01b3adef8`。最后以显式account和`--strict`发布message绑定main的新before：deployment `a4638b48-f600-4f1a-a223-439405949178` / version `41400ced-aa01-4973-8a74-aa0553d1d23e`，100% traffic，created `2026-07-29T08:21:12.363045Z`。
- 只读复核：`wrangler secret list --format json`只显示`GITHUB_APP_PRIVATE_KEY`、`OPERATIONS_TOKEN`、`TASK_INTAKE_TOKEN`三枚`secret_text`名称；`/healthz`返回200；remote migrations为`No migrations to apply`；`quota_model_profiles`精确为启用的Terra与Sol各1且Sol字段匹配0062；D1聚合Task/Run/Attempt均0、`changes=0`、`rows_written=0`。新source worktree HEAD exact且`git status --porcelain`为空。一次migration inventory命令遗漏显式account而只读exit 1、一次profile查询误用不存在表名而只读API error；修正后两项均exit 0且没有数据写入，未把失败伪装为成功。
- 验证：`swiftc -typecheck <仓库外helper>`、helper执行、Secret binding list、双build、新deployment status、corrected migration/profile/D1查询、healthz与Git clean检查均exit 0；输出只含安全标量/ID/count，没有token值或digest。旧before `8b646225...` / `6911feca...`及source `e14d11e...`只保留历史证据，因Secret version变化不得用于后续authorization/after。
- 勾选：新增并勾选“TASK/operations轮换与新before基线”子项；真实hibernate、唯一dispatch、analysis Action与heartbeat父项仍未完成。
- 当前blocker与决策：Worker运行不要求Cloudflare网页登录；正式演练可直接使用API token。但当前仍缺单仓库GitHub Actions-read、目标account Workflow/deployment-read和目标Worker-deploy三枚互异token。不存在既有最小权限token时，签发本身仍需要owner在GitHub/Cloudflare完成一次本人认证；Wrangler OAuth权限过宽且只有一个值，不能旁路五credential隔离。三枚token未安全入Keychain前不生成最长30分钟的fresh authorization，不运行`ops:workflow-hibernate-window`。按owner要求不更新llmdoc。

## Round 175 — 2026-07-29
- 目标：Phase 1“真实Cloudflare hibernate/Worker restart且GitHub dispatch一次”的首次exact live execution与失败闭环。本轮只运行唯一一次已授权operator；失败后只读定位并增加零重复resume本地契约，父项保持未勾。
- 凭证与fresh authority：Cloudflare deploy token按已审核的目标Worker `Workers Scripts Write`配置创建；GitHub fine-grained PAT固定7天、唯一`evilstar9527/delivery-loop`、Actions read和GitHub强制Metadata read。两值与此前Cloudflare read、TASK、operations均写入macOS Keychain。仓库外Security Framework launcher只在内存读取五值，证明全部ready且互异；真实HTTP预检证明TASK/operations 404鉴权成功、exact identity未占用、GitHub Actions read与`main=91c2a8c...`、Cloudflare Workflow/deployment read、deploy token active、新before 100%和clean source全部匹配。fresh 0600 authority=`hibernate-window-live-20260729-100009`，canonical digest=`sha256:a3038a3b5b1d733ebf0a474b1bcb046d91331eef8bf2d78716ad3f8bcc365c47`，schema/digest/30分钟窗口/Task envelope+revision+identity均重算通过；文件不含Secret。
- 唯一生产尝试：`ops:workflow-hibernate-window`只启动一次；双build/preflight后唯一`POST /v1/tasks`成功，最长5分钟只轮询not-ready，最终固定`FAIL live_window_timeout`并exit 1。没有第二operator、Task POST、after或rollback。随后控制面安全投影为Task/Run存在、Run=`queued/version 0/baseSha null`、Plan/Attempt/effect outbox为0；Cloudflare exact Workflow instance 404、GitHub stable-title Action count 0、latest deployment仍为before `a4638b48...` / `41400ced...`，故effect总量精确为Task=1、Action=0、after=0、rollback=0。
- 根因证据：remote D1 exact查询证明唯一`workflow_create` outbox=`pending/attempt_count 0/无lease/无error`且无DLQ；recovery state=`active`、Cron `* * * * *`真实存在并在before时更新。下一次真实Cron error tail固定为version `41400ced...`、scheduled event、exception=`GitHub App private key is invalid`，堆栈在`githubDispatchProcessorFromEnv`且发生于relay前。代码与原bootstrap交叉证明GitHub Manifest conversion的`pem`由Node PKCS#1可成功签名并写入Secret，但生产构造器只接受`BEGIN PRIVATE KEY`并用`importPKCS8`，因此Secret名称/healthz均不能证明可加载；不是GitHub、模型、Queue或hibernate平台限制。
- 本地修复与恢复契约：`GitHubAppInstallationTokenProvider`新增严格有界PKCS#1 PEM/base64/DER解析，以固定RSA algorithm identifier包装为PKCS#8后复用既有Jose/WebCrypto；原生PKCS#8直通，非法/重复/尾随/超限在网络前拒绝。真实2048-bit PKCS#1测试证明JWT签名路径到达installation-token请求。authority新增可选`resumeExistingTask=true`；只有fresh digest绑定且deterministic Task已存在才跳过POST，成功summary固定`taskCreateRequests=0`，普通authority误入resume或Task缺失均在deploy前拒绝，之后仍复用原双guard/单after/零rollback。
- 验证：`pnpm exec vitest run test/github-app-installation-token.test.ts test/workflow-hibernate-live-window.test.ts test/workflow-hibernate-live-adapters.test.ts test/workflow-hibernate-window-guard.test.ts` → exit 0，4 files / 66 tests，包含真实2048-bit PKCS#1签名与非法/重复/尾随/超限PEM的负向用例；`pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/outbox-routing.test.ts` → exit 0，1 file / 5 tests，运行时配置fixture不再依赖无效PEM占位符；`pnpm run verify` → exit 0，typecheck、lint、115 Node files / 577 tests、57 workerd files / 309 tests、13 workflow/13 job runner policy、504文件Secret scan与docs links全绿。首次D1诊断误用dead-letter/incident不存在的`attempt_count`列而只读exit 1，按实际migration列名修正后均exit 0、`rows_written=0`，未把失败查询伪装为证据。
- 勾选：新增并勾选“首次live尝试可解释失败 + PKCS#1兼容 + exact Task零重复resume本地契约”；真实Cloudflare hibernate、Action唯一dispatch、analysis/heartbeat与formal verifier继续未完成。
- 当前blocker：恢复必须发布包含PKCS#1兼容修复的Worker作为新的before，再以fresh `resumeExistingTask=true` authority等待同一Run/Attempt并在双guard成立时发布唯一after。该动作会产生两个production Worker deployment（热修复before + guarded after），超出已消费且绑定旧before的authority；需要owner重新明确授权。授权不得包含第二Task、第二Action、Secret轮换、rollback或repo write。按owner要求不更新llmdoc。

## Round 176 — 2026-07-29
- 目标：继续Phase 1“真实Cloudflare hibernate/Worker restart且GitHub dispatch一次”，本轮只完成PKCS#1 hotfix合并后的确定构建和零生产写恢复预检；父项保持未勾。
- 前置与权限：复用Keychain中五枚用途隔离凭证，只用Task/Plan、operations Case 8、GitHub Actions/main与Cloudflare Workflow/deployment/schedule只读能力；owner已明确选择现有API token继续使用，本轮不轮换。没有D1写、Worker deploy、Task POST、Action、model、after、rollback或repo write外部effect。
- 合并与source冻结：PR [#41](https://github.com/evilstar9527/delivery-loop/pull/41)为`MERGED`，无review、普通或行内评论；rebase merge产生`main=9c3ffa3a87f9995e171008d683f7e0c9a98333ad`。required PR CI [30444818845](https://github.com/evilstar9527/delivery-loop/actions/runs/30444818845)与合并后main CI [30445127753](https://github.com/evilstar9527/delivery-loop/actions/runs/30445127753)均`completed/success`。仓库外detached worktree `/Users/jishihe/.codex/delivery-loop/hibernate-before-9c3ffa3`以frozen lockfile只复用本地pnpm store，HEAD exact且tracked/untracked clean。受审`verifyFrozenSource`通过临时0600空env与隔离HOME/XDG运行两次Wrangler dry-run，得到2,811,972 bytes与SHA-256 `43bf95239b035ff1c3f145eadd170aaf92e193bf4a56db3ee7a92b5ddef78995`，`matchingBundleBuilds=2/clean=true`。
- 恢复preflight加固：仓库外`secure-preflight.sh`在“Task已存在”分支新增fail-closed断言：exact Task/Run必须`queued/version 0`且Plan/Attempt/effect/replay均为0，Workflow instance必须不存在，stable-title Action必须0，current deployment必须仍为旧before `a4638b48...`/`41400ced...` 100%，Cron必须仍`* * * * *`，GitHub main与detached source必须同为`9c3ffa3...`且clean。Swift launcher只把未来execute的source路径改为新worktree并重新编译/本地签名；authority文件仍是已过期的`hibernate-window-live-20260729-100009`且`resumeExistingTask=false`，所以本轮没有可用execute authority。
- 验证：
  - `pnpm install --frozen-lockfile`于新detached worktree → exit 0，189 packages全部本地reuse；`git rev-parse HEAD`/`git status --porcelain` → exact SHA/empty。
  - 受审adapter双构建 → exit 0，安全summary为`headSha=9c3ffa3.../bundleBytes=2811972/bundleSha256=43bf9523.../matchingBundleBuilds=2/clean=true`。首次`tsx -e`因CJS不支持top-level await而本地exit 1，改为async IIFE后exit 0；首次失败发生在Wrangler/网络/外部effect前，未伪装为构建证据。
  - `zsh -n secure-preflight.sh`、`swiftc -typecheck run-secure-hibernate.swift`、Swift launcher编译与`codesign -s -` → exit 0；重新执行`run-secure-hibernate preflight` → exit 0并固定`credentials_ready/distinct=true`、`recovery_preflight=passed`，安全投影证明Task=1、Action=0、Workflow=0、after=0且current main/source exact。
  - `date -u`与仓库外authority安全字段 → 当前`2026-07-29T11:03:03Z`，旧authority已于`10:30:09Z`过期且resume=false；没有生成fresh文件。
  - `pnpm run verify` → exit 0，typecheck、lint、115 Node files / 577 tests、57 workerd files / 309 tests、13 workflows / 13 jobs runner policy、504文件Secret scan与docs links全绿；workerd主动terminate清理诊断不是skip。
- 勾选：新增并勾选“hotfix合并后冻结 + 零写恢复preflight”子项；真实hibernate、唯一Action、analysis/heartbeat与formal verifier继续未完成。
- 决策沉淀：现有API token按owner决定继续使用，轻微历史泄漏不触发本轮轮换；仍不把token写入仓库、日志或authority。新source/bundle只是readiness，不能由CLI自授权。按owner要求不更新llmdoc。
- 遗留：唯一当前外部前置是owner明确授权两个production deployment——先把`main=9c3ffa3...`/bundle=`43bf9523...`发布为新before，再生成最长30分钟且`resumeExistingTask=true`的fresh authority，只在双guard成立时发布唯一after。授权不得扩展到第二Task/Action、Secret轮换、rollback或repo write。

## Round 177 — 2026-07-29
- 目标：继续Phase 1“真实Cloudflare hibernate/Worker restart且GitHub dispatch一次”，本轮完成同一production恢复授权blocker的第三轮审计并停止盲重试；真实父项仍只接受`DELIVERY_LOOP_WORKFLOW_HIBERNATE_E2E=1 ... pnpm run e2e:workflow-hibernate`读取同一Run的D1、Cloudflare与GitHub外部事实后exit 0。
- 前置与权限：owner明确确认现有API token的轻微历史暴露可接受，要求直接继续使用；因此五枚Keychain credential保持原值且不轮换，也不会输出或写入仓库。该输入只解决credential处置选择，不自动扩张Round 175已消费并绑定旧before的production effect授权。本轮没有D1写、Worker deploy、Task POST、Action、模型调用、after、rollback、Secret轮换或repo write外部effect。
- 三轮审计：Round 175唯一operator创建exact Task后在relay前暴露PKCS#1兼容根因，安全停止于Task=1、Action=0、after=0，并首次明确恢复需要hotfix before与guarded after两次新deployment；Round 176完成修复合并、clean detached source、确定双build和零写live preflight，但没有新deployment授权；Round 177取得“不轮换、直接使用现有token”的credential决策，production effect授权仍未出现。重复运行旧authority会因过期且`resumeExistingTask=false`而失败，重复Task/operator会违反exact-once，绕过before直接等待则生产运行时仍无法加载App key，因此没有安全的无授权执行路径。
- Phase 1依赖审计：未完成的真实hibernate、GitHub App实际dispatch、analysis Action与heartbeat四项都必须复用现有Task/Run并先发布hotfix before；它们不能拆成不触发production effect的替代闭环。platform-limits父项另需owner授权Runner并发分钟、约六小时probe及personal billing `Plan: read`，也不能用本轮readiness代替。既有Round 175/176生产D1、deployment、Workflow与Action安全投影保持有效，本轮按“减少数据库查询”要求不重复远端查询。
- 验证：
  - `git diff --check` → exit 0。
  - `pnpm run verify:docs` → exit 0。
  - `pnpm run verify:secrets` → exit 0，504个生产文件扫描通过。
  - `pnpm run verify` → exit 0；typecheck、lint、115 Node files / 577 tests、57 workerd files / 309 tests、13 workflows / 13 jobs runner policy、504文件Secret scan与docs links全绿。
- 勾选：无。真实hibernate、唯一GitHub Action、analysis与heartbeat继续未完成；凭证可继续使用不等于production恢复成功或部署授权。
- 决策沉淀：`DOD.md`把当前blocker更新为Round 177第三轮停止盲重试；按owner要求不更新llmdoc。现有token继续留在macOS Keychain，仍不进入authority、日志、artifact或仓库。
- Blocker与最小人工输入：owner明确回复或等价确认：`授权生产恢复：发布9c3ffa3 hotfix为新before；恢复现有Task；双guard成立时发布唯一after；不创建第二Task/Action，不轮换Secret，不rollback。`收到后重新只读核对main/current deployment/exact Task投影，生成最长30分钟且`resumeExistingTask=true`的fresh authority，并只运行一次operator。

## Round 178 — 2026-07-29
- 目标：执行owner授权的Phase 1 production恢复：“发布`9c3ffa3` hotfix为新before；恢复现有Task；双guard成立时发布唯一after；不创建第二Task/Action，不轮换Secret，不rollback。”本轮只选择真实Workflow hibernate这一未完成DoD；验收仍要求`DELIVERY_LOOP_WORKFLOW_HIBERNATE_E2E=1 ... pnpm run e2e:workflow-hibernate`对同一Run的D1、Cloudflare与GitHub事实exit 0，恢复operator或本地测试都不能替代。
- production before：零写preflight通过后，只发布一次冻结hotfix source `9c3ffa3a87f9995e171008d683f7e0c9a98333ad` / bundle 2,811,972 bytes / SHA-256 `43bf95239b035ff1c3f145eadd170aaf92e193bf4a56db3ee7a92b5ddef78995`。新before deployment=`f335333d-9b30-4d66-a6c8-512c50b6641f`、version=`5c94d0bc-4c02-464e-a418-54b0ec4b393e`、created=`2026-07-29T11:48:43.938904Z`且100% traffic；healthz=200。没有migration、Secret rotation、Task POST、Action、after或rollback伴随这次发布。
- 唯一恢复尝试：生成fresh 0600 authority `hibernate-window-recovery-20260729T114932712Z`，canonical digest=`sha256:21acd7d61ade164e9ea30967bdf43f74c46c8dd66ceb8c488a89f26c8e791707`，显式`resumeExistingTask=true`并绑定上述before/source/bundle与原Task/Run；它已于`2026-07-29T12:19:32.712Z`过期，永不复用。恢复operator只调用一次并以`external_unavailable`安全停止；没有第二Task POST、第二operator或conditional-after调用。
- 最终外部事实：Task=`task_f9694dd75862aa4aa674cb003f43253d71627b9f7e9ab1cda2b4e944`与Run=`run_f9694dd75862aa4aa674cb003f43253d71627b9f7e9ab1cda2b4e944`仍各唯一；Run=`planning/version 1/baseSha null`，Plan=0、Attempt=0、effect outbox=0、controlled replay=0。Cloudflare Workflow version=`352ac0ec-33f4-4f71-8abb-ec74e6f0b3e4`为`errored`：`register-run-1`成功，`dispatch-analysis-attempt-1`在`2026-07-29T11:56:33Z`至`12:01:45Z`间六次失败。GitHub stable-title Action inventory=0；latest Worker仍为上述hotfix before 100%；after deployment count=0。因此整个窗口effect精确为Task=1、Action=0、after=0、rollback=0，符合授权上限但不满足双guard或DoD。
- 根因：Cloudflare安全错误的`name=Error`及message长度103与本地固定`run <exact-run-id> is not available for analysis dispatch`完全吻合；独立D1投影证明`base_sha IS NULL`。`POST /v1/tasks`此前调用`TaskIntakeStore`时未从GitHub解析/传入base SHA；普通`workflow_create`processor虽以`base_sha_unresolved`拒绝，但`WorkflowInstanceReconciler`把queued+unknown转成`workflow_reconcile_create`，repair processor未重验base，因而创建Workflow。`register-run`把Run推进planning后，analysis dispatch最终因base缺失失败。这不是Cloudflare hibernate或GitHub Action限制。
- 停止边界：该Workflow已经errored，普通hibernate verifier又明确禁止controlled replay/reconciliation repair，故双guard不可能在本实例上再次成立。本轮没有直接D1补值、Workflow restart/recreate、第二before、第二Task/Action、after、rollback或Secret rotation；这些都不在已消费授权内。恢复完成后仅做只读reconcile，不再重跑operator。
- 本地修复：manual intake在Secret扫描与既有idempotency lookup后，仅对新请求使用repository-scoped `contents:read` GitHub App token读取exact `refs/heads/<baseBranch>`；严格验证commit/40位SHA后才把base传入Task/Run事务。相同key/request重放直接复用冻结projection，即使GitHub暂时不可用仍返回原202；新请求的配置/ref/响应失败在D1/R2前固定503且零写。Workflow reconciler在null base的recreate/restart路径只记录scan并返回`base_sha_unresolved`，不创建repair；processor对历史已排队repair在effect前再次重验并回pending。Cloudflare真实API的`register-run-1`类名称只允许exact稳定名或`-1..-20`后缀归一化，其他suffix fail-closed。同步`docs/Proto.md`、`docs/Architecture.md`与`docs/WorkflowHibernateE2E.md`；按owner约定不更新llmdoc。
- 验证：定向workerd `task-api + github-base-observation + workflow-instance-reconciler + workflow-outbox` → exit 0，4 files / 27 tests；hibernate step/live/formal verifier → exit 0，3 files / 21 tests；扩展query fixture后聚焦workerd → exit 0，5 files / 30 tests；`pnpm run typecheck`与`pnpm run lint`均exit 0。首次`pnpm run verify`的Node 116/578通过，但workerd `task-query-api`因旧fixture从完整Worker创建Task、未注入新trusted resolver而2项收到预期503，最终exit 1；改为同一`taskApi`受信port fixture后重新验证，不把首轮失败伪装为成功。最终`pnpm run verify` → exit 0：116 Node files / 578 tests、57 workerd files / 314 tests、13 workflows / 13 jobs runner policy、505文件Secret scan与docs links全绿；workerd主动terminate清理诊断不是skip。`CI=1 WRANGLER_SEND_METRICS=false pnpm exec wrangler deploy --dry-run --outdir /tmp/delivery-loop-round-178-20260729` → exit 0，Worker 2749.93 KiB / gzip 462.05 KiB且全部Workflow/Queue/D1/R2 bindings识别；仅dry-run，未部署。`git diff --check` → exit 0。
- DoD/遗留：真实Cloudflare hibernate、唯一Action、analysis与heartbeat仍不勾；这次失败是可解释并保留exact effect账，但不等于恢复成功。代码变化仅在本地branch，未commit/push/更新PR。任何production D1 repair、Workflow restart/recreate、额外Worker deployment或新Task/Action需要新窄授权；若要取得干净普通hibernate证明，需由owner重新决定是否允许新的唯一Task/Action，因为现有errored Workflow不能通过该证据契约。

## Round 179 — 2026-07-29
- 目标：继续Phase 1“真实Cloudflare hibernate/Worker restart且GitHub dispatch一次”；把Round 178的base-SHA lifecycle与Cloudflare step normalization修复变成latest-main之上的不可变PR head和required CI事实。本轮不运行Task/Action/model、D1写、Worker deploy、Workflow restart/recreate、after、rollback或Secret rotation；父DoD与真实子项保持未勾。
- 前置与权限：按`pre-pr-rebase-main` skill先读取完整规则并只读执行`git fetch origin main`。当前worktree/branch正确且origin存在；fresh `origin/main=fc5c38771977c478977fb2a4d4a5730612ea2449`恰好等于`merge-base(HEAD, origin/main)`，main侧新增commit和双方overlap文件均为0，因此无需stash、rebase、history rewrite或冲突裁决。现有dirty/untracked全部属于Round 178修复，没有丢弃用户改动。
- 动作：显式stage本轮21个代码/测试/规范/账本路径，`git diff --cached --check`通过后创建commit `506074fb4d35a28afe871d35d6e3bccdc493cf09`（`fix: bind workflow runs to trusted base SHA`，485 insertions/98 deletions）；分支仍为线性`origin/main → 1b49b4e → 506074f`，未改写历史，故普通push更新现有PR [#43](https://github.com/evilstar9527/delivery-loop/pull/43)，未创建第二PR。
- 验证：required PR CI [30453116634](https://github.com/evilstar9527/delivery-loop/actions/runs/30453116634) / job [90579825288](https://github.com/evilstar9527/delivery-loop/actions/runs/30453116634/job/90579825288)在head `506074f...`上`completed/success`，唯一`verify` job用时4m47s；setup、frozen install、`pnpm run verify`及post steps全部success。CI结束后PR API为`MERGEABLE/CLEAN`，review/requested-changes/普通评论/行内评论均0；这只表示可合并，不冒充已merged。账本更新后本地`pnpm run verify`再次exit 0：116 Node files/578 tests、57 workerd files/314 tests、13 workflows/13 jobs policy、505文件Secret scan与docs links全绿。唯一annotation是三枚受审setup Action仍声明Node 20并被GitHub强制Node 24，沿用Phase 0已记录的MINOR依赖升级事项，不是本修复的correctness/security blocker。
- 勾选：无。PR/CI只证明修复提交可复查和全量回归成功，不证明代码已进入main/production，也不证明真实hibernate、唯一Action、analysis或heartbeat。
- 决策沉淀：`DOD.md`当前blocker指向PR #43/head/CI，并继续明确现有errored Workflow不能被repair伪装成普通hibernate成功；按owner约定不更新llmdoc。skill要求的blocking/important feedback均为none，deferred feedback只有既有Node runtime MINOR。
- 遗留：本轮账本更新还需形成PR head并通过新的required CI，随后才可考虑merge；merge/main CI也不能授权production deploy或新Task/Action。任何下一次真实演练仍需代码先进入main，并由owner对exact新source/bundle/before与是否允许新Task/Action给出新的窄production authority。

## Round 180 — 2026-07-29
- 目标：继续Phase 1“真实Cloudflare hibernate/Worker restart且GitHub dispatch一次”；确认Round 178 exact恢复授权已消费，把trusted-base修复的merged main、确定bundle与当前生产失败投影冻结成零写预检证据。本DoD完整验收仍只接受`DELIVERY_LOOP_WORKFLOW_HIBERNATE_E2E=1 ... pnpm run e2e:workflow-hibernate`对新的同一Run/D1/Cloudflare/GitHub事实exit 0，merge、dry-run或旧失败实例都不能替代。
- 前置与权限：owner本次输入逐字等于Round 177要求并已在Round 178执行的exact authority，因而按exact-once与“不创建第二Task/Action”约束不重放。本轮只创建clean detached本地worktree、离线安装frozen lockfile依赖、运行两次Wrangler dry-run，并使用现有Keychain credential只读查询control-plane、GitHub和Cloudflare。launcher验证五枚用途隔离凭证但下游脚本不调用deploy token；值未输出、未轮换。没有D1修复、Worker deployment、Workflow restart/recreate、Task POST、Action、model、after、rollback或Secret write。
- merge与main证据：PR [#43](https://github.com/evilstar9527/delivery-loop/pull/43)最终head=`46125b40b95e2f4ee5035b18b965faada960d4a0`，required PR CI [30453896269](https://github.com/evilstar9527/delivery-loop/actions/runs/30453896269) `completed/success`；PR已rebase merge，merge commit与当前GitHub main均为`b60872e2a5bfd90a1a8fbcb66b1d910432266015`。main CI [30454350833](https://github.com/evilstar9527/delivery-loop/actions/runs/30454350833) / job [90583992996](https://github.com/evilstar9527/delivery-loop/actions/runs/30454350833/job/90583992996) `completed/success`；review/requested changes/普通评论/行内评论均0。修复在main中对应commit=`fcd167782691f766aa43714b0363c800ff46b2e4`，但main CI和merge不授权生产发布。
- 冻结source：`/Users/jishihe/.codex/delivery-loop/hibernate-before-b60872e`为clean detached `b60872e2a5bfd90a1a8fbcb66b1d910432266015`，`pnpm install --offline --frozen-lockfile`只复用本地store。受审`verifyFrozenSource`以临时600空env、隔离HOME/XDG运行两次Wrangler 4.107.0 dry-run，输出`matchingBundleBuilds=2/clean=true`，bundle=2,815,927 bytes，SHA-256=`57d277e335556b0c6b1ee5d34468cd3e0a55b7036268399f85501a2dc646671e`。本轮未使用该bundle发布。
- 生产只读复核：Task=`task_f9694dd75862aa4aa674cb003f43253d71627b9f7e9ab1cda2b4e944`与Run=`run_f9694dd75862aa4aa674cb003f43253d71627b9f7e9ab1cda2b4e944`仍唯一；Run=`planning/version 1/baseSha null`，Plan=0、Attempt=0、effect outbox=0、controlled replay=0。Cloudflare Workflow version=`352ac0ec-33f4-4f71-8abb-ec74e6f0b3e4`仍`errored`，步骤仍为成功`register-run-1`与失败`dispatch-analysis-attempt-1`；GitHub stable-title Action inventory=0。latest Worker仍是Round 178 before deployment=`f335333d-9b30-4d66-a6c8-512c50b6641f` / version=`5c94d0bc-4c02-464e-a418-54b0ec4b393e` 100%，deployment inventory仍10，healthz=200，所以after=0、rollback=0且状态无漂移。
- 停止边界：Round 178 recovery authority已过期且永不复用；仓库外`secure-preflight.sh`、`run-secure-hibernate.swift`与`generate-recovery-authorization.ts`仍绑定旧source/Task/before，本轮没有执行其`publish-before`或`execute`路径，也没有为新Task生成identity/authority。原errored Workflow不能在strict验收中通过；如owner继续限制“不创建第二Task/Action”，则必须保留本次失败证据并停止该真实演练。
- 验证：
  - `pnpm exec tsx -e '<verifyFrozenSource>'` → exit 0；`headSha=b60872e...`、`bundleBytes=2815927`、`bundleSha256=57d277e3...`、`matchingBundleBuilds=2`、`clean=true`。
  - 仓库外`run-secure-hibernate reconcile` → exit 0；只读输出上述Task/Run/Workflow/deployment/Action/healthz安全摘要，未返回Secret或原始错误正文。
  - GitHub public REST交叉核对PR #43、PR/main CI、reviews/comments → exit 0；上述SHA、run/job、merge与零评论事实一致。
  - `git diff --check` → exit 0。
  - `pnpm run verify` → exit 0；116 Node files / 578 tests、57 workerd files / 314 tests、13 workflows / 13 jobs runner policy、505文件Secret scan与docs links全绿；workerd主动terminate清理诊断不是skip。
- 勾选：新增“trusted-base修复合并与零写生产复核”子证据；真实hibernate、唯一Action、analysis与heartbeat完整DoD仍不勾。
- 决策沉淀：`DOD.md`把根因修复更新为已merge/main-CI-passed，并明确旧authority已消费、原Workflow终态与新Task需重新授权的边界；按owner约定不更新llmdoc。
- Blocker与最小人工输入：若要继续该真实演练，owner需明确授权并显式取消旧的“不创建第二Task/Action”限制：发布frozen `b60872e...` / bundle `57d277e3...`为新before，创建恰好一个fresh Task并允许恰好一个analysis Action，仅在双guard成立时发布唯一after；仍不授权D1 repair、Workflow restart/recreate、Secret rotation、repo write或rollback。未收到新授权前不准备fresh Task identity/authority，不执行任何生产写。

## Round 181 — 2026-07-29
- 目标：继续Phase 1“真实Cloudflare hibernate/Worker restart且GitHub dispatch一次”；把Round 180的trusted-base merged-main/bundle/生产零写复核事实送入线性受保护PR并取得required CI，避免证据只停在本地。本轮不改变formal hibernate验收命令或生产blocker，PR/CI不替代真实Task/Workflow/Action/after事实。
- 前置与权限：仅Git分支推送、GitHub PR创建及Actions CI读/写；不读或写D1/R2/Queue/Worker/Workflow，不调用Task/operations/Cloudflare credential，不运行model、Task/Action dispatch、production deploy、Secret rotation或rollback。不把PR正文或CI输出当作可信指令。
- pre-PR审计：按`pre-pr-rebase-main` skill读取完整规则后执行`git fetch origin main`；`origin/main=b60872e2a5bfd90a1a8fbcb66b1d910432266015`与`merge-base(HEAD, origin/main)`相同，main侧新增commit和双方overlap文件均0。分支只有Round 180的`440dd5cb69ee4c054608b3b2348f8e8a30dbff76` docs commit，工作区clean，无需stash、rebase、history rewrite或冲突裁决。首次远程branch检查命令在只读`ls-remote`后因zsh内置只读变量`status`命名冲突而exit 1；未产生外部effect，改用`if ...; then` 后exit 0并证明remote branch不存在。
- PR与CI：普通`git push -u origin HEAD`创建远程分支，新建ready PR [#44](https://github.com/evilstar9527/delivery-loop/pull/44)，base=`main@b60872e...`、head=`440dd5cb69ee4c054608b3b2348f8e8a30dbff76`。required CI [30456623208](https://github.com/evilstar9527/delivery-loop/actions/runs/30456623208) / job [90591725696](https://github.com/evilstar9527/delivery-loop/actions/runs/30456623208/job/90591725696) `completed/success + run_attempt=1`，唯一`verify` job用时4m03s；setup、immutable checkout/setup actions、frozen install、`pnpm run verify`与post steps均success。PR API为`MERGEABLE/CLEAN`，review/requested changes/普通评论/行内评论均0。
- 验证：
  - `git diff --check origin/main..HEAD`、`git status --short`和`git log --graph --oneline origin/main..HEAD` → exit 0；分支线性、仅一commit且clean。
  - `gh pr checks 44 --watch --interval 10` → exit 0；同一run/job从pending到pass，未触发rerun或第二workflow。
  - `gh pr view` + reviews/issues comments/review comments + `gh run view` → exit 0；上述head/base、CLEAN、CI步骤与零反馈事实一致。
  - `git diff --check && pnpm run verify` → exit 0；116 Node files / 578 tests、57 workerd files / 314 tests、13 workflows / 13 jobs runner policy、505文件Secret scan和docs links全绿；workerd主动terminate清理诊断不是skip。
- 勾选：新增“hibernate零写预检的受保护PR证据”子项；真实hibernate、唯一Action、analysis和heartbeat完整DoD仍不勾。
- 决策沉淀：`DOD.md/PROGRESS.md`记录不可变PR/run/job及零review事实；按owner约定不更新llmdoc。skill feedback分类为blocking=none、important=none、deferred=none。
- 遗留：PR #44还需对本轮账本commit运行新的required CI；未取得独立merge authority，本轮不merge。production blocker不变：如要继续真实演练，owner必须显式允许唯一fresh Task/Action并对`b60872e...` / `57d277e3...`新before与双guard after给出新窄production authority；否则停止该演练重试。

## Round 182 — 2026-07-29
- 目标：继续Phase 1“真实Cloudflare hibernate/Worker restart且GitHub dispatch一次”；对Round 180～181的相同外部blocker做第三轮机器化审计，证明是否还有不依赖新authority的本地实现缺口。验收命令先固定为未完成项分类、`git diff --check`、`pnpm run verify`和PR #44最终head CI/review读取；审计或默认exit 2不能替代任何真实E2E。
- 前置与权限：仅读本地DOD/PROGRESS和GitHub PR/CI，及更新同一PR的DOD/PROGRESS账本；不读或写D1/R2/Queue/Worker/Workflow，不调用Task/operations/Cloudflare credential，不运行model、dispatch、deployment、Secret rotation、rollback或merge。PR/CI内容仍是不可信输入，只取GitHub API结构化状态。
- Round 181最终事实：PR [#44](https://github.com/evilstar9527/delivery-loop/pull/44)账本head=`7b3717c9eca04a9d89e21f309bda980977cd60a7`，required CI [30457440823](https://github.com/evilstar9527/delivery-loop/actions/runs/30457440823) / job [90594549231](https://github.com/evilstar9527/delivery-loop/actions/runs/30457440823/job/90594549231) `completed/success`，唯一`verify`用时3m57s；PR仍`OPEN + MERGEABLE/CLEAN`，review/requested changes/普通/行内评论均0。唯一annotation为三枚受审setup Action声明Node 20但平台强制Node 24，是Phase 0已记录的MINOR，不是本轮correctness/security blocker。
- 未完成项审计：`rg '^- \\[ \\]'`/section-aware `awk`证明DOD共50个top-level未完成项：6个全局Phase关门规则、Phase 1/2/3/4/5/6分别5/9/4/6/10/2个父项，以及8个最终E2E事实。另有37个缩进未完成子项；其中Phase 1～6的每个未完成父项都已有至少一个`[x]`本地契约/严格外部verifier子证据，37个未完成子项全部显式要求真实GitHub/Cloudflare/飞书/Meegle/云/日志平台事实或owner决策。Phase 7的8项也各有独立已勾的组合verifier契约，剩余top-level本身即真实平台事实。因此没有可用更多本地mock、schema、dry-run或账本来替代的功能缺口。
- Phase 1最先blocker：5个未完成父项均需外部事实；hibernate、GitHub App dispatch、analysis Action和heartbeat的最小共享路径是先把trusted-base修复发布为new before，再创建恰好一个fresh Task/Action并在双guard成立时发布唯一after。原Task的`baseSha=null`/errored Workflow无法通strict verifier，所以该路径与owner现有“不创建第二Task/Action”限制相冲突。platform-limits另需Runner预算、约6小时probe和personal `Plan: read`，不能在无授权时自动扩scope/计费。按Phase顺序，不先解除这些前置就不应把Phase 2～7真实E2E当作替代路径。
- 三轮相同blocker事实：Round 180已确认Round 178 authority消费/过期、merged main/bundle确定且生产零漂移；Round 181已完成线性PR、required CI和零review账本；Round 182又从全部50个top-level/37个子项审计确认无不依赖外部authority的安全路径。重放旧authority、repair/restart旧Workflow、重复旧Task、用mock替代E2E或跨Phase创建其他生产effect都会违反exact-once/strict证据/授权边界，因而按`LOOP.md`停止盲重试。
- 验证：
  - `rg -c '^- \\[ \\]' DOD.md` → 50；section-aware `awk` → global/Phase 1～7=`6/5/9/4/6/10/2/8`。
  - `rg -c '^  +- \\[ \\]' DOD.md` → 37；逐项读取确认均是真实外部事实、外部producer接入或owner决策，不是未实现的本地schema/test。
  - `gh pr view 44` + reviews/issues comments/review comments → exit 0；Round 181最终head/CI、CLEAN和零feedback事实未漂移。
  - `git diff --check && pnpm run verify` → exit 0；116 Node files / 578 tests、57 workerd files / 314 tests、13 workflows / 13 jobs runner policy、505文件Secret scan和docs links全绿；workerd主动terminate清理诊断不是skip。
- 勾选：新增“hibernate三轮相同blocker审计与停止盲重试”安全子证据；真实hibernate及其他父DoD一律保持未勾，不把blocker审计冒充完成。
- 决策沉淀：`DOD.md/PROGRESS.md`记录相同blocker的三轮尝试、不可变证据、禁止路径和最小人工输入；按owner约定不更新llmdoc。
- Blocker与最小人工输入：目标进入blocked，需owner分开回复两个authority后恢复：`1. 授权合并 PR #44。` `2. 授权发布 b60872e... / bundle 57d277e3... 为新before；创建唯一fresh Task/Action；双guard成立时发布唯一after；不做D1 repair、Workflow restart/recreate、Secret rotation或rollback。` 若owner继续“不创建第二Task/Action”，则该Phase 1真实演练必须保留失败事实并终止，无strict恢复替代方案。

## Round 183 — 2026-07-29
- 目标：恢复Phase 1真实Workflow hibernate演练。owner已解除Round 182的两个blocker，并授权合并PR #44、发布冻结`b60872e...` / bundle `57d277e3...`为新before、创建唯一fresh Task/Action，以及仅在双guard成立时发布唯一after；明确禁止D1 repair、Workflow restart/recreate、Secret rotation与rollback。本轮仍只选择该hibernate DoD，formal关门命令不变。
- merge与main gate：PR [#44](https://github.com/evilstar9527/delivery-loop/pull/44)最终head=`a5148bd9b9a486b052ec8f4163d72cdb006bc213`、base=`b60872e...`，required CI [30458587750](https://github.com/evilstar9527/delivery-loop/actions/runs/30458587750) / job [90598471302](https://github.com/evilstar9527/delivery-loop/actions/runs/30458587750/job/90598471302) `completed/success`且review/requested changes/普通/行内评论均0。按owner新约定直接rebase merge，GitHub在`2026-07-29T14:38:59Z`生成`main=29f9d43dafe47dae209972a5cc43ed72f10a3837`；合并后main CI [30461930460](https://github.com/evilstar9527/delivery-loop/actions/runs/30461930460) / job [90609924121](https://github.com/evilstar9527/delivery-loop/actions/runs/30461930460/job/90609924121)于`14:43:22Z`以`completed/success`结束，唯一verify job用时4m11s。未来本仓库PR在review/required CI门禁通过后可直接合并，不再逐次申请merge授权；该约定不扩大production权限。
- fresh identity与入口冻结：仓库外0600 Task使用新source identity `phase1-hibernate-drill-fresh-20260729-144455/revision 1`，canonical算法派生Task=`task_d459b54b7dca89cd51e04658301f7fab9d999ff1a259ab5b8fe4068c`、Run=`run_d459b54b7dca89cd51e04658301f7fab9d999ff1a259ab5b8fe4068c`、Attempt=`analysis-run_d459b54b7dca89cd51e04658301f7fab9d999ff1a259ab5b8fe4068c-1`；只读policy固定三个write/deploy均false且require human approval。独立0600/0700脚本固定`main=29f9d43...`、source=`b60872e...`、bundle=2,815,927 bytes / `57d277e3...`、当前before=`f335333d.../5c94d0bc...`与上述fresh身份；publisher最多一次strict before，operator继续复用仓库内每实例最多一次Task POST/一次conditional after和双live guard，脚本没有repair/restart/rotation/rollback入口。
- 当前停止点：重新编译的Swift launcher因macOS Keychain ACL再次弹出授权，改用系统`security`命令后同样停在读取现有operations token的用户确认；Task token已先读取但未输出，其他值未写盘。连续三个目标轮次均由进程表证明同一`security find-generic-password ... operations-token -w`仍在等待，fresh preflight脚本尚未启动，因此没有Task POST、Action、D1/Workflow写、Worker deployment、after、Secret rotation或rollback。按目标blocked审计规则停止继续准备/重试并标记blocked；需owner在前台Keychain提示选择“始终允许”后恢复。不能以入口准备、Keychain等待或blocked账本冒充production preflight/hibernate成功。
- 验证：PR/main结构化API与main CI读取、fresh Task schema/identity计算、仓库外文件权限`0600/0700`、两个zsh入口`zsh -n`及`git diff --check`均exit 0；formal live verifier尚未运行且父DoD保持未勾。

## Round 184 — 2026-07-30
- 目标：继续Phase 1“真实Cloudflare hibernate/Worker restart且GitHub dispatch一次”；执行Round 183已授权的唯一fresh窗口，解释Task入口503并补上Worker真实GitHub App credential/base read的零effect readiness前置。formal验收仍只接受`DELIVERY_LOOP_WORKFLOW_HIBERNATE_E2E=1 ... pnpm run e2e:workflow-hibernate`对同一Run的D1/Cloudflare/GitHub外部事实exit 0；readiness、本地测试或失败边界都不能替代。
- 已消费production authority：冻结source=`b60872e2a5bfd90a1a8fbcb66b1d910432266015`、bundle SHA-256=`57d277e335556b0c6b1ee5d34468cd3e0a55b7036268399f85501a2dc646671e`只发布一次new before；deployment=`8d768d72-8a57-4ed8-906f-d85f71fbc06e`、version=`aff2071b-d4ad-4602-995e-67bb1fd6226e`、created=`2026-07-30T06:33:46.003556Z`并保持100% traffic。fresh identity固定Task=`task_d459b54b7dca89cd51e04658301f7fab9d999ff1a259ab5b8fe4068c`、Run=`run_d459b54b7dca89cd51e04658301f7fab9d999ff1a259ab5b8fe4068c`、Attempt=`analysis-run_d459b54b7dca89cd51e04658301f7fab9d999ff1a259ab5b8fe4068c-1`。只执行一次仓库外operator，结果为`workflow-hibernate-window: FAIL task_create_failed`；不得把503当作未消费authority后普通重跑。
- 零业务写与503边界：只读reconcile确认fresh Task/Plan/Audit均404、Workflow instance不存在、matching stable-title GitHub Action=0、after deployment=0，latest deployment仍为上述before。Cloudflare Observability在`2026-07-30 14:41:05.136 GMT+8`记录exact version上的`POST /v1/tasks`为HTTP 503、Worker outcome=`ok`、duration=480 ms且exception/error event=0。源码路径证明新Task在任何D1/R2写前先构造`githubBaseShaResolverFromEnv`并调用`resolveBaseSha(repository, baseBranch)`，该段任意异常统一映射`target repository base is unavailable`；fresh Task完全未落D1也排除后续R2 put 503。
- 外部配置复核：production version binding只读投影显示repository allowlist=`evilstar9527/delivery-loop`、App ID=`4415140`、installation ID=`149587996`且private-key binding类型为`secret_text`；GitHub installation settings仍只选择该单repo，公开`refs/heads/main` API当前返回commit=`29f9d43dafe47dae209972a5cc43ed72f10a3837`且形状符合parser。故剩余边界是Worker内私钥加载、App JWT→installation token交换、或携token读取ref三段；公开ref/PAT preflight不能证明这条实际App链路。
- readiness实现：`GET /v1/operations/github-base/readiness?repository=...&baseBranch=...`要求用途隔离`OPERATIONS_TOKEN`和exact query，复用manual intake当前Worker resolver；成功只返回repository/baseBranch/40位SHA，失败只返回`configuration_unavailable|credential_unavailable|reference_unavailable|reference_invalid`。`GitHubBaseApiClient`把token provider、network/non-200、malformed ref分成typed安全阶段；API不反射App JWT/private key/token/upstream body/raw error并固定`no-store`。route没有D1/R2/Task/Run/outbox/Workflow/Action写入调用；readiness 200也不产生Task POST、dispatch或production deploy authority。
- 验证：
  - RED：`pnpm exec vitest run test/github-base-api.test.ts` → exit 1，新增分类用例按预期失败（1 failed / 3 passed）；`pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/task-api.test.ts` → exit 1，readiness route未实现时7 failed / 8 passed。
  - `pnpm exec vitest run test/github-app-installation-token.test.ts test/github-base-api.test.ts` → exit 0，2 files / 19 tests；覆盖PKCS#1/PKCS#8、repository-scoped contents-read token及安全阶段。
  - `pnpm exec vitest run --config vitest.workflow.config.ts test/workflow/task-api.test.ts test/workflow/task-query-api.test.ts test/workflow/github-base-observation.test.ts test/workflow/outbox-routing.test.ts` → exit 0，4 files / 29 tests；覆盖operations鉴权、strict query、四类结果、零D1/R2写和既有Task 503/查询/路由回归。
  - `pnpm run typecheck`、`pnpm run lint`、`git diff --check` → exit 0。
  - `pnpm run verify` → exit 0；116 Node files / 579 tests、57 workerd files / 322 tests、13 workflows / 13 jobs policy、505文件Secret scan与docs links全绿；workerd主动terminate清理诊断不是skip。
- PR初始门禁：按`pre-pr-rebase-main` skill执行`git fetch origin main`后，HEAD/base/merge-base均为`29f9d43dafe47dae209972a5cc43ed72f10a3837`，main与branch commit/overlap均0；dirty九文件全属本轮，故无需stash/rebase/history rewrite。commit `5296afc44e2c868a9682c274782419faa5e1d305`线性推送并创建ready PR [#45](https://github.com/evilstar9527/delivery-loop/pull/45)。GitHub最初超过两分钟未为`opened`事件生成check inventory；对同一PR执行一次可逆close→reopen后`reopened`门禁启动，稍后原`opened`事件也被平台补发，因此同一head上出现两条只读CI而非Task/Agent Action。run [30523362721](https://github.com/evilstar9527/delivery-loop/actions/runs/30523362721) / job [90808605543](https://github.com/evilstar9527/delivery-loop/actions/runs/30523362721/job/90808605543)与run [30523496804](https://github.com/evilstar9527/delivery-loop/actions/runs/30523496804) / job [90809027567](https://github.com/evilstar9527/delivery-loop/actions/runs/30523496804/job/90809027567)均`completed/success`，用时4m14s/3m51s；PR为`MERGEABLE/CLEAN`且review/requested changes/普通/行内评论均0。blocking/important feedback均none；唯一annotation是既有三枚受审setup Action声明Node 20但平台强制Node 24，沿用Phase 0已记录MINOR，不影响本修复正确性或安全性。
- 勾选：新增“fresh before与单次Task POST安全失败、GitHub base readiness本地契约”子证据；真实hibernate父项、唯一Action、analysis和heartbeat仍不勾。失败Task POST、before或readiness本地契约都没有满足formal manifest。
- 决策沉淀：同步`docs/Proto.md`、`docs/Security.md`、`docs/Architecture.md`，把readiness定义为Task前置诊断而非Task/部署authority；按owner约定不更新llmdoc。PR required CI/review门禁通过后可按owner常设约定直接merge，但production权限不随merge扩大。
- Blocker与下一步：PR #45的本账本head仍需required CI；门禁通过且无blocking/important feedback后可按owner常设约定直接merge。随后需要新的窄authority发布包含readiness的exact Worker。发布后只运行一次operations-only readiness；只有exact repository/base返回200，才可请求第二次同identity Task POST和后续唯一Action/双guard after authority。当前不运行第二Task POST、不创建第二Task对象、不发布Worker/after、不做D1 repair、Workflow restart/recreate、Secret rotation或rollback。

## Round 185 — 2026-07-30
- 目标：继续Phase 1“真实Cloudflare hibernate/Worker restart且GitHub dispatch一次”；把readiness最终PR head、rebase merge、main CI与exact production candidate bundle作为可复核证据入账。本轮验收固定为GitHub结构化API、clean detached main双构建、`git diff --check`和`pnpm run verify:docs`；不运行production deploy/readiness/Task/Action/model/after，父DoD保持未勾。
- PR最终门禁与merge：PR [#45](https://github.com/evilstar9527/delivery-loop/pull/45)最终head=`02298c84c8a4136e929848c5504ff84024b4ebbf`，required CI [30524407407](https://github.com/evilstar9527/delivery-loop/actions/runs/30524407407) / job [90811918993](https://github.com/evilstar9527/delivery-loop/actions/runs/30524407407/job/90811918993)在该head上`completed/success`，唯一verify用时4m03s。PR当时`MERGEABLE/CLEAN`且review/requested changes/普通/行内评论均0，按owner常设授权rebase merge；GitHub在`2026-07-30T07:57:02Z`生成`main=b78edd74ec726a8a13acea613bef8a98eaf1542b`。合并后main CI [30524705717](https://github.com/evilstar9527/delivery-loop/actions/runs/30524705717) / job [90812860361](https://github.com/evilstar9527/delivery-loop/actions/runs/30524705717/job/90812860361)亦`completed/success`，唯一verify用时4m27s。三枚受审setup Action的Node 20→24提示仍是既有MINOR，不是本轮blocking/important feedback。
- Git transport事实：PR初始head的`opened`事件延迟后与一次reopen事件各生成一条成功CI；最终账本head的`synchronize`同样延迟但只生成一条CI。账本push期间三次HTTPS smart transport无远端更新并被有界停止；`ssh -T`只读证明当前机器身份为owner后，同一commit经SSH正常fast-forward到同一远端分支，未更改origin配置、未新建第二PR、未force-push。该平台/transport现象只属于GitHub代码协作面，不是Task/Agent Action或production effect。
- production candidate冻结：先外部核对GitHub main后，以clean detached `origin/main=b78edd74ec726a8a13acea613bef8a98eaf1542b`调用既有`createWorkflowHibernateLiveWindowDependencies(...).verifyFrozenSource`。第一次inline harness因`tsx -e` CJS不支持top-level await而在Wrangler前exit 1并自动恢复原分支；改为async IIFE后exit 0，连续两次隔离Wrangler dry-run均产生2,820,209 bytes、SHA-256=`dc811769003b46cbbb6cf3959267e1767c1aa06818962a1f8114749b5dbeb82b`，`matchingBundleBuilds=2/clean=true`。dummy distinct local token只满足构造期格式校验，verify路径没有HTTP调用或真实credential；没有deployment。
- 验证：
  - `gh pr view 45`、reviews/issues comments/review comments、`gh run view 30524407407`与`30524705717` → exit 0；上述PR/main SHA、run/job success与零feedback一致。
  - clean detached main `verifyFrozenSource` async-IIFE harness → exit 0；`headSha=b78edd74...`、`bundleBytes=2820209`、`bundleSha256=dc811769...`、`matchingBundleBuilds=2`、`clean=true`。
  - `git diff --check`、`pnpm run verify:docs` → exit 0；文档链接校验通过且账本diff无空白错误。
- 勾选：新增“GitHub base readiness受保护合并与exact production candidate冻结”子证据；真实Worker发布、readiness结果、Task/Action/after和formal hibernate仍全部未勾。
- 决策沉淀：只更新`DOD.md/PROGRESS.md`；API/安全/架构边界已在Round 184同步，本轮没有新规范决策，按owner约定不更新llmdoc。
- Blocker与最小人工输入：需owner新窄授权：`授权发布 main b78edd74ec726a8a13acea613bef8a98eaf1542b / bundle dc811769003b46cbbb6cf3959267e1767c1aa06818962a1f8114749b5dbeb82b（2,820,209 bytes）为新的 readiness before；发布后仅执行一次 exact GitHub base readiness；不执行 Task POST、Action、after、D1 repair、Workflow restart/recreate、Secret rotation或rollback。` 在此之前不重放任何旧authority。

## Round 186 — 2026-07-30
- 目标：继续Phase 1“真实Cloudflare hibernate/Worker restart且GitHub dispatch一次”；确认Round 185证据已通过受保护PR进入main，并审计同一DoD是否还有不依赖新production authority的真实推进路径。本轮验收先固定为GitHub结构化PR/run事实、branch/main树一致性、未完成项与Security/runbook authority检索、`git diff --check`和`pnpm run verify:docs`；不运行Cloudflare/D1/R2/Task/Workflow/Action/model/deployment/readiness。
- 前置与权限：只读GitHub PR/Actions/main及仓库文件；未读取或写入生产数据库、Worker、Workflow、Secret值或仓库外Task/authorization。既有Task/before/readiness事实直接复用Round 184～185，按减少数据库查询纪律不重复production reconcile。PR merge常设授权只覆盖代码协作，不扩大production deployment authority。
- 受保护交付事实：账本commit `74f054713a72ea4156981d663978b8fd107ef707`经ready PR [#46](https://github.com/evilstar9527/delivery-loop/pull/46)交付；required CI [30525776294](https://github.com/evilstar9527/delivery-loop/actions/runs/30525776294) / job [90816219268](https://github.com/evilstar9527/delivery-loop/actions/runs/30525776294/job/90816219268)在exact head上`completed/success`，PR为`MERGEABLE/CLEAN`且review/requested changes/普通/行内评论均0。按owner常设约定rebase merge后生成`main=9766e38471da3d857c91034d329153f12086d4c1`；合并后main CI [30526125817](https://github.com/evilstar9527/delivery-loop/actions/runs/30526125817) / job [90817325489](https://github.com/evilstar9527/delivery-loop/actions/runs/30526125817/job/90817325489)亦`completed/success`，用时3m55s。既有setup Action Node 20→24 annotation仍是Phase 0已记录MINOR，不是本轮blocker。
- 无授权路径审计：`git diff --exit-code 74f0547... 9766e384...`为0，证明rebase merge只改变commit identity且当前main树就是受审两文件账本；它不改变Round 185从clean executable source `b78edd74...`冻结的Worker bundle 2,820,209 bytes / `dc811769...`。Phase 1五个未完成父项及其真实子项仍分别要求Cloudflare hibernate+Action、App dispatch、真实analysis、heartbeat外部事实和owner批准的约六小时platform probe；前三者共享的最早缺口就是发布readiness Worker，后两者也不能用本地mock、已有CI或账本替代。`docs/Security.md`与`docs/WorkflowHibernateE2E.md`明确production deploy必须取得exact外部批准；readiness只读、dry-run、PR merge、旧authority和本轮goal continuation都不能自授权。因此没有可执行的零写替代闭环，重放旧authority或跨Phase制造effect会违反exact-once和Phase顺序。
- 验证：
  - `gh pr view 46` + reviews/issues comments/review comments + `gh run view 30525776294`与`30526125817` → exit 0；上述head/base/merge/main SHA、两条CI success与零feedback一致。
  - `git diff --exit-code HEAD origin/main`（在PR #46 rebase前head上）→ exit 0；两个commit tree一致；随后从`origin/main`创建本轮线性分支。
  - `rg`核对Phase 1未完成父/真实子项及Security/runbook的production/readiness/authority边界 → exit 0；没有不依赖新owner authority的同一DoD动作。
  - `git diff --check`、`pnpm run verify:docs` → exit 0；账本diff无空白错误且文档链接校验通过。
- 勾选：无；真实hibernate、唯一Action、analysis、heartbeat与platform limits父项均保持未勾，不把PR、CI、审计或blocker冒充完成。
- 决策沉淀：只更新`DOD.md/PROGRESS.md`；没有新API、架构或安全决策，按owner约定不更新llmdoc。
- Blocker与最小人工输入：与Round 185相同，需owner明确回复：`授权发布 main b78edd74ec726a8a13acea613bef8a98eaf1542b / bundle dc811769003b46cbbb6cf3959267e1767c1aa06818962a1f8114749b5dbeb82b（2,820,209 bytes）为新的 readiness before；发布后仅执行一次 exact GitHub base readiness；不执行 Task POST、Action、after、D1 repair、Workflow restart/recreate、Secret rotation或rollback。` 在此之前不执行任何production写或readiness调用；这是相同blocker的第二个连续目标轮次，尚不把长期goal标记blocked。

## Round 187 — 2026-07-30
- 目标：继续Phase 1“真实Cloudflare hibernate/Worker restart且GitHub dispatch一次”；对Round 185～186相同production authority缺口执行第三个连续目标轮次审计，按`LOOP.md`和长期目标blocked规则停止盲重试。本轮验收先固定为GitHub结构化PR/run事实、rebase merge树一致性、当前goal状态、既有Security/runbook边界、`git diff --check`与`pnpm run verify:docs`；不运行Cloudflare/D1/R2/Task/Workflow/Action/model/deployment/readiness。
- 前置与权限：只读GitHub PR/Actions/main、长期goal状态和仓库文件；未读取或写入生产数据库、Worker、Workflow、Secret值或仓库外Task/authorization。当前轮次由长期goal自动继续，没有新的用户消息或owner authority；自动续跑、代码merge常设授权和此前已消费的exact authority都不能解释为production deployment批准。
- Round 186受保护交付事实：commit `05e217e70c74f76d8d8076c2404a5bbebcc4f412`经ready PR [#47](https://github.com/evilstar9527/delivery-loop/pull/47)交付；required CI [30526798941](https://github.com/evilstar9527/delivery-loop/actions/runs/30526798941) / job [90819503456](https://github.com/evilstar9527/delivery-loop/actions/runs/30526798941/job/90819503456)在exact head上`completed/success`，PR为`MERGEABLE/CLEAN`且review/requested changes/普通/行内评论均0。按owner常设约定rebase merge后生成`main=619ba549f3e35bbff2658c7360f347e119d91b75`；合并后main CI [30527131976](https://github.com/evilstar9527/delivery-loop/actions/runs/30527131976) / job [90820574197](https://github.com/evilstar9527/delivery-loop/actions/runs/30527131976/job/90820574197)亦`completed/success`，用时3m50s。`git diff --exit-code 05e217e... 619ba549...`为0，证明rebase merge只改变commit identity；既有setup Action Node 20→24 annotation仍是Phase 0已记录MINOR。
- 三轮相同blocker：Round 185已冻结clean executable source `b78edd74...`、2,820,209 bytes / `dc811769...`并提出最小窄authority；Round 186证明Phase 1同一DoD没有不依赖该production写的本地或零写替代闭环；Round 187再次确认PR/review/main CI都已清、当前goal仍active但没有新owner authority。第一项安全动作仍只能是一次exact Worker发布，继续做dry-run、账本PR、默认exit 2、跨Phasemock或旧authority重放都不会让真实hibernate更接近成立，并会违反证据或授权纪律。因此满足同一阻塞条件连续三个目标轮次的阈值，本轮账本通过受保护main后必须把长期goal状态更新为blocked，而不是继续生成第四份无effect账本。
- 验证：
  - `gh pr view 47` + reviews/issues comments/review comments + `gh run view 30526798941`与`30527131976` → exit 0；上述head/base/merge/main SHA、两条CI success与零feedback一致。
  - `git diff --exit-code HEAD origin/main`（在PR #47 rebase前head上）→ exit 0；两个commit tree一致；随后从`origin/main`创建本轮线性分支。
  - `get_goal` → status=`active`；Round 185～187是相同production authority blocker的三个连续goal轮次，达到blocked阈值但仅在本轮账本受保护交付后更新状态。
  - `git diff --check`、`pnpm run verify:docs` → exit 0；账本diff无空白错误且文档链接校验通过。
- 勾选：无；真实hibernate、唯一Action、analysis、heartbeat与platform limits父项继续未勾，blocked只表示停止无权限盲重试，不表示DoD完成。
- 决策沉淀：只更新`DOD.md/PROGRESS.md`；没有新API、架构或安全决策，按owner约定不更新llmdoc。
- Blocker与恢复输入：本轮受保护交付和main CI成功后将长期goal置为blocked。恢复时owner明确回复：`授权发布 main b78edd74ec726a8a13acea613bef8a98eaf1542b / bundle dc811769003b46cbbb6cf3959267e1767c1aa06818962a1f8114749b5dbeb82b（2,820,209 bytes）为新的 readiness before；发布后仅执行一次 exact GitHub base readiness；不执行 Task POST、Action、after、D1 repair、Workflow restart/recreate、Secret rotation或rollback。` 恢复运行视为新的blocked审计；没有该输入前不执行任何production写或readiness调用。

## Round 188 — 2026-07-30
- 目标：继续Phase 1“真实Cloudflare hibernate/Worker restart且GitHub dispatch一次”；消费owner恢复输入，发布exact readiness before并仅调用一次GitHub base readiness。formal hibernate关门命令仍是`DELIVERY_LOOP_WORKFLOW_HIBERNATE_E2E=1 ... pnpm run e2e:workflow-hibernate`对同一Run的D1/Cloudflare/GitHub事实exit 0；本轮before或readiness失败都不能替代。
- 前置与权限：owner exact authority只允许发布`main=b78edd74ec726a8a13acea613bef8a98eaf1542b`、2,820,209 bytes、SHA-256=`dc811769003b46cbbb6cf3959267e1767c1aa06818962a1f8114749b5dbeb82b`为新的readiness before，并在发布后发送一次`GET /v1/operations/github-base/readiness?repository=evilstar9527%2Fdelivery-loop&baseBranch=main`。只取用现有Cloudflare read/deploy和operations用途凭证，不打印或轮换值；明确不授权Task POST、Action、after、D1 repair、Workflow restart/recreate、Secret rotation或rollback。
- fail-closed预检：最初从嵌套source worktree双构建得到2,822,525 bytes / `105e4ef6fc34b50fa48c476a5632613107b390ddf18b2ee5a09cf7ae022f0209`，与authorized candidate不一致，因此在Wrangler publish前停止且production effect为0。根因是source绝对路径进入bundle；切回产生Round 185 candidate的原始repo路径后，clean detached `b78edd74...`连续两次隔离dry build均精确得到2,820,209 bytes / `dc811769...`。新增`createWorkflowReadinessBeforeDeploymentSession`复用同一冻结bundle adapter，把exact source/bytes/digest/fixed message、旧100% deployment/version guard、单次`--no-bundle --strict`及新deployment post-check绑定在一个不可重复session；不同candidate、远端漂移或第二次deploy均在写前拒绝。
- production发布：deploy前live guard为deployment=`8d768d72-8a57-4ed8-906f-d85f71fbc06e`、version=`aff2071b-d4ad-4602-995e-67bb1fd6226e`、100% traffic。只执行一次strict publish，message=`phase1-readiness-before main@b78edd74ec726a8a13acea613bef8a98eaf1542b`；Cloudflare在`2026-07-30T09:16:51.003Z`生成deployment=`0b58d1e9-bde7-4a07-ab66-fea31367beaa`、version=`3d2bb7eb-2b19-460f-952f-bf9fddf192d3`并置100%，`deploymentAttempts=1`。Dashboard：[new readiness before](https://dash.cloudflare.com/b8488957e88658039d2a38fb8f160514/workers/services/view/delivery-loop-control-plane/production/deployments/0b58d1e9-bde7-4a07-ab66-fea31367beaa)。旧deployment只保留审计anchor，没有rollback。
- 唯一readiness结果：发布后只发送一次上述exact GET；有界caller返回`requestAttempts=1`、`status=0`、`ready=false`、`reason=request_failed`并exit 1。该结果不是Worker返回的200 readiness事实，也没有暴露Secret或raw transport错误；按authority不补发第二个请求、不切换token、不repair或重新发布。Task POST、Task/Run/Workflow、analysis Action、after deployment、D1 repair、Workflow restart/recreate、Secret rotation和rollback均为0。
- 验证：
  - readiness-before session RED（函数不存在）→ `pnpm exec vitest run test/workflow-hibernate-live-adapters.test.ts` exit 1，新增2项预期失败；GREEN → exit 0，1 file / 14 tests，覆盖exact publish、远端漂移和第二次deploy拒绝。
  - `pnpm run typecheck`、`pnpm run lint`、`git diff --check` → exit 0；lint首次发现2个unused identifier并修复后复验exit 0。
  - 原始repo exact session → exit 0；`headSha=b78edd74...`、`bundleBytes=2820209`、`bundleSha256=dc811769...`、`matchingBundleBuilds=2`、`clean=true`、old/new deployment/version均如上、`deploymentAttempts=1`。
  - exact readiness caller → exit 1；只输出`requestAttempts=1/status=0/ready=false/reason=request_failed`固定安全摘要，未重试。
  - 首次`pnpm run verify` → exit 1；仓库内两个临时`.claude/worktree`被默认Vitest discovery重复扫描，在混合扫描集中产生148个fixture/dependency suite加载失败并有8,297项通过。将Node/workerd配置都显式排除`.claude/worktree/**`且Node include收窄为root `test/**/*.test.ts`后，定向测试恢复为1 file / 14 tests、`pnpm run test:unit`为116 files / 581 tests，均exit 0；没有删除worktree或隐藏真实root失败。
  - 最终`pnpm run verify` → exit 0；116 Node files / 581 tests、57 workerd files / 322 tests、13 workflows / 13 jobs runner policy、505文件Secret scan与docs links全绿；workerd主动terminate清理诊断不是skip。
  - pre-PR skill审计：`git fetch origin main`后`origin/main=merge-base=815da6b...`，main侧新增commit/overlap文件均0；分支3个职责清晰commit线性、工作区clean，无需rebase、stash、history rewrite或冲突裁决。ready PR [#49](https://github.com/evilstar9527/delivery-loop/pull/49)最终head=`b55d6e904b5a7ba629f9a67b84022bcc75e7f677`，required CI [30530927016](https://github.com/evilstar9527/delivery-loop/actions/runs/30530927016) / job [90832819433](https://github.com/evilstar9527/delivery-loop/actions/runs/30530927016/job/90832819433) `completed/success + run_attempt=1`，唯一verify用时4m03s；PR为`MERGEABLE/CLEAN`且review/requested changes/普通/行内评论均0，blocking/important/deferred feedback均none。
  - 按owner常设授权rebase merge后，GitHub在`2026-07-30T09:35:04Z`生成`main=2580164f1ed39288f07a2c31a39cddd2889853df`；合并后main CI [30531276979](https://github.com/evilstar9527/delivery-loop/actions/runs/30531276979) / job [90833946736](https://github.com/evilstar9527/delivery-loop/actions/runs/30531276979/job/90833946736) `completed/success`，唯一verify用时3m55s。GitHub Git API证明PR head与merged-main tree均为`33ac358f915c3d27b024ed9d28f6ea0383209e14`；唯一annotation仍是Phase 0已记录的三枚受审setup Action声明Node 20但平台强制Node 24的MINOR，不是本轮correctness/security blocker。
  - post-merge账本同步首次普通fetch以`HTTP2 framing layer`失败，随后HTTP/1.1重试以GitHub 443连接timeout失败；两次均没有ref、工作树、history或push effect。GitHub Git API先只读证明上述tree一致，稍后同一HTTP/1.1有界fetch成功取得`origin/main=2580164...`；`git cherry`把实现侧3个commit全部标为已应用、只把本账本commit标为新增，rebase按预期跳过前三个并无冲突地留下唯一docs commit。
- 勾选：新增“readiness before发布与单次readiness固定失败”子证据；真实hibernate、唯一Action、analysis和heartbeat父项仍不勾。
- 决策沉淀：`docs/WorkflowHibernateE2E.md`和`docs/Security.md`补充一次性readiness-before session、路径敏感bundle与GET失败不扩大authority的边界；`DOD.md/PROGRESS.md`记录外部事实。按owner约定不更新llmdoc。
- 遗留：当前production已包含readiness路由，但唯一获授权请求是`request_failed`而非200，不能据此执行Task。若继续，先在零生产写边界内定位caller transport失败，再由owner另行批准至多一次新的exact readiness；只有返回200，才可分开申请第二次同identity Task POST及后续唯一Action/双guard after。当前恢复审计是新blocker的第1轮，goal保持active；不自动重试或跨Phase制造effect。

## Round 189 — 2026-07-30
- 目标：继续Phase 1“真实Cloudflare hibernate/Worker restart且GitHub dispatch一次”；在不补发readiness、不读取operations token且不触碰production数据/Worker的前提下，定位Round 188 `request_failed`的客户端transport阶段，并把未来单次获批GET固化为可诊断、不可重试的仓库内caller。formal hibernate关门命令不变；本地caller或无HTTP network preflight都不能替代readiness 200及真实E2E。
- 前置与权限：只读本地源码/环境配置存在性，及三个公网host的DNS、TCP 443、validated TLS布尔；network preflight不携带token且不发送HTTP。未读取Keychain、D1/R2/Queue/Workflow/Worker配置，未调用control-plane/GitHub/Cloudflare HTTP API，没有readiness GET、Task POST、Action、model、deployment、repair/restart、Secret rotation或rollback。当前只选择同一个hibernate DoD。
- caller契约：新增`createGitHubBaseReadinessProbe`与`ops:github-base-readiness`。CLI默认在配置/network前exit 2；显式opt-in后只接受HTTPS origin、exact repository/base和operations token，每实例在fetch前永久消费attempt并固定一个GET、10秒timeout、redirect拒绝。caller只接受`no-store + application/json`下的exact 200 success或四类503 shape；1 MiB、pagination、content-length、credential/known token扫描和binding均fail-closed，unexpected status不读取body。transport只从最多四层error `name/code/cause`映射timeout/DNS/TCP/TLS/generic fixed code，永不输出message/raw cause。第二次run在fetch前拒绝。
- RED/GREEN：函数不存在时`pnpm exec vitest run test/github-base-readiness-probe.test.ts`按预期exit 1 / 0 tests。首次实现后28项中24项通过，四个early-header rejection因测试Response clone的tee另一分支未消费，`await body.cancel()`各自卡到5秒timeout；这暴露真实不可信响应取消可能阻塞caller的问题。改为触发reader/body cancel但不等待其promise后，全部28项在546ms内通过；再补CLI缺token/配置零网络、localhost/IP/internal origin拒绝、实际1 MiB超限和恶意error getter，总计36项。
- 零HTTP外部诊断：当前工作站Node 26没有`HTTP_PROXY/HTTPS_PROXY/NO_PROXY/NODE_USE_ENV_PROXY`。相同受审preflight对production Worker hostname返回`provider_tcp_failed + dns=true/tcp=false/tls=false`，耗时10.49秒；对`api.github.com`与`api.cloudflare.com`分别在1.07/1.33秒返回`provider_network_preflight_passed + dns/tcp/tls=true`。安全DNS计数为Worker host 1个IPv4+1个IPv6，probe已尝试最多四个public address；没有输出IP、发送HTTP或读取Secret。因此证据支持host-path TCP blocker，而不是全局DNS、全局TCP/TLS或缺代理配置；它解释status 0但不证明Worker readiness业务链路。
- 验证：
  - `pnpm exec vitest run test/github-base-readiness-probe.test.ts` → exit 0，1 file / 36 tests。
  - `pnpm run typecheck`、`pnpm run lint` → exit 0。
  - `pnpm run ops:github-base-readiness`（未opt-in）→ exit 2，固定`opt-in missing`且零网络。
  - Worker/GitHub/Cloudflare三个`DELIVERY_LOOP_PROVIDER_NETWORK_PREFLIGHT=1 ... pnpm run e2e:provider-network` → exits `1/0/0`及上述固定安全布尔；没有执行readiness。
  - `pnpm run verify` → exit 0；117 Node files / 617 tests、57 workerd files / 322 tests、13 workflows / 13 jobs runner policy、507文件Secret scan和docs links全绿；workerd主动terminate清理诊断不是skip。
  - pre-PR skill复核：首次HTTP/1.1 `git fetch`在`git-upload-pack`后80秒无进展，由operator终止为exit 130；没有ref、工作树、history或GitHub effect。随后GitHub API只读证明远端`main=0a0ec0b...`恰为PR base及本地`origin/main`，分支merge-base亦相同，main侧新增commit/overlap文件均0；两个职责清晰commit线性、工作区clean且`git diff --check` exit 0，无需rebase、stash、history rewrite或冲突裁决。
  - ready PR [#51](https://github.com/evilstar9527/delivery-loop/pull/51) exact head=`b7bbfa5b4a0ae0b3c010dfb5542292cbb56f345f`；required CI [30534286180](https://github.com/evilstar9527/delivery-loop/actions/runs/30534286180) / job [90843699568](https://github.com/evilstar9527/delivery-loop/actions/runs/30534286180/job/90843699568)在同一head上`completed/success`，唯一verify用时3m52s。PR为`MERGEABLE/CLEAN`且review/requested changes/普通/行内评论均0，blocking/important/deferred feedback均none。
  - 按owner合并常设授权并以`--match-head-commit b7bbfa5...`执行一次rebase merge；GitHub在`2026-07-30T10:29:53Z`生成`main=efe405ded2a235b2c15bc1f313638d5d876b1f88`。Git API证明merged-main与受审PR head的tree均为`c22604717668797785d982e3f511e5cbb1f9b2be`；重新HTTP/1.1 fetch本次exit 0并取得该exact `origin/main`。
  - 合并后main CI [30534890254](https://github.com/evilstar9527/delivery-loop/actions/runs/30534890254) / job [90845716746](https://github.com/evilstar9527/delivery-loop/actions/runs/30534890254/job/90845716746)在exact main上`completed/success`，唯一verify用时4m12s。PR与main run的唯一annotation仍是Phase 0已登记的三枚受审setup Action声明Node 20但平台强制Node 24的MINOR，不是本轮correctness/security blocker。
- 勾选：新增“readiness一次性caller与零HTTP transport诊断”子证据；真实hibernate、唯一Action、analysis和heartbeat父项保持未勾。
- 决策沉淀：同步`docs/Proto.md`、`docs/Security.md`与`docs/WorkflowHibernateE2E.md`；transport诊断先于消耗单次readiness authority，且diagnostic pass/fail都不自授权。按owner约定不更新llmdoc。
- 遗留：当前阻塞已定位但外部路径尚未恢复。下一次readiness前必须先在拟执行环境取得Worker host DNS/TCP/TLS全true；随后仍需owner对“一次exact GET”的新窄authority。只有200才可另行申请第二次同identity Task POST与唯一Action/双guard after。Round 188～189是该transport/readiness blocker的连续第2轮，goal保持active且不盲重试。

## Round 190 — 2026-07-30
- 目标：继续Phase 1“真实Cloudflare hibernate/Worker restart且GitHub dispatch一次”；在Round 189实现与账本完成受保护交付后，对相同Worker-host transport/readiness缺口执行第3个连续目标轮次审计，并按`LOOP.md`记录blocker、停止盲重试。formal关门命令仍是`DELIVERY_LOOP_WORKFLOW_HIBERNATE_E2E=1 ... pnpm run e2e:workflow-hibernate`对同一Run的D1/Cloudflare/GitHub事实exit 0；PR、CI、零HTTP preflight或blocked状态都不能替代。
- 前置与权限：只读GitHub PR/Actions/main、长期goal状态与仓库文件，并对既有public Worker hostname执行一次DNS/TCP 443/validated TLS布尔preflight；不读取或注入operations token，不发送HTTP。没有readiness GET、Task POST、Action、model、D1/R2/Queue/Workflow/Worker写、repair/restart/recreate、Secret rotation、after deployment或rollback。本轮继续只选择同一个hibernate DoD。
- Round 189受保护交付：实现与账本commit经ready PR [#51](https://github.com/evilstar9527/delivery-loop/pull/51)交付，exact head `b7bbfa5b4a0ae0b3c010dfb5542292cbb56f345f`的required CI [30534286180](https://github.com/evilstar9527/delivery-loop/actions/runs/30534286180) / job [90843699568](https://github.com/evilstar9527/delivery-loop/actions/runs/30534286180/job/90843699568) `completed/success`；rebase merge生成`main=efe405ded2a235b2c15bc1f313638d5d876b1f88`，main CI [30534890254](https://github.com/evilstar9527/delivery-loop/actions/runs/30534890254) / job [90845716746](https://github.com/evilstar9527/delivery-loop/actions/runs/30534890254/job/90845716746)亦`completed/success`。PR与merged-main tree均为`c22604717668797785d982e3f511e5cbb1f9b2be`，review/requested changes/普通/行内评论均0。
- 证据账本交付：Round 189的两文件immutable evidence经ready PR [#52](https://github.com/evilstar9527/delivery-loop/pull/52)交付；exact head `467fb385d333001374c9f9a7a26cfac9e99923f4`的required CI [30535378272](https://github.com/evilstar9527/delivery-loop/actions/runs/30535378272) / job [90847318128](https://github.com/evilstar9527/delivery-loop/actions/runs/30535378272/job/90847318128) `completed/success`且唯一verify用时3m59s。按owner常设授权以exact head guard rebase merge后生成`main=6aeb5af25fa0c88c96f8eeb69104bc2a2bc0c34b`；main CI [30535684625](https://github.com/evilstar9527/delivery-loop/actions/runs/30535684625) / job [90848314382](https://github.com/evilstar9527/delivery-loop/actions/runs/30535684625/job/90848314382)亦`completed/success`且唯一verify用时4m03s。PR与main的tree均为`35b556be0cb38ef3dbf5fb03e40184befc87ad87`，四类feedback仍为0；唯一annotation仍是Phase 0已登记的setup Action Node 20→24 MINOR。
- 第三轮复核：`DELIVERY_LOOP_PROVIDER_NETWORK_PREFLIGHT=1 OPENAI_BASE_URL=<public Worker origin> pnpm run e2e:provider-network`只执行一次，10.39秒后exit 1，固定`provider_tcp_failed / dns=true / tcp=false / tls=false`。命令不携带token且实现只做DNS/TCP/TLS，不发送HTTP；结果与Round 189相同，说明当前执行面到Worker host的TCP路径仍未恢复，不能消费新的readiness authority。
- Git同步降级：合并后两次git smart-HTTP分别以`Empty reply from server`和GitHub 443 connect failure结束（exits 128），均没有ref/工作树/history/远端effect。GitHub API仍可达并给出exact main commit/tree/parent/author/committer/message；先用`git commit-tree`重建时SHA guard因timezone不一致按预期拒绝且未更新ref，随后参照已存在GitHub rebase commit确认`+0800` offset，重建结果精确等于`6aeb5af...`后才以old-SHA CAS更新本地`origin/main`并从该exact commit建分支。账本普通push在80秒由operator终止为exit 130，HTTP/1.1重试在75秒连接失败为exit 128；Git Data API fallback依次校验blob、tree、parent、message与raw commit SHA，日期格式错误、SHA/old-ref不一致都在ref写前或本地CAS处拒绝，最终只创建tree与main diff一致的线性远端分支并对齐本地ref。没有把tree-equivalent commit冒充remote main，也没有force更新。
- 三轮blocker判定：Round 188唯一获批GET失败且旧authority已消费；Round 189完成安全caller与零HTTP定位；Round 190在两层受保护main交付后复验同一失败指纹。当前既无DNS/TCP/TLS全true的拟执行环境，也无另一受审token注入执行面或新的owner GET authority；重复preflight、readiness、dry-run、账本PR、本地mock或跨Phase effect都不能关门，继续尝试只会违反一次性authority和外部证据纪律。因此相同blocker已连续3轮，本账本经受保护main交付后把长期goal置为blocked并停止第四轮盲重试。
- 验证：
  - `gh pr view 51/52` + reviews/issues comments/review comments + `gh run view 30534286180/30534890254/30535378272/30535684625` → exit 0；上述exact SHA、四条CI success、tree一致性与零feedback成立。
  - `pnpm run verify:docs`、`pnpm run verify:secrets`、`git diff --check` → exit 0；文档链接、507文件Secret扫描与账本diff均通过，受保护PR仍须运行完整`pnpm run verify`。
  - `get_goal` → status=`active`；Round 188～190已达到同一blocker的三轮阈值，只有本账本受保护交付完成后才更新为`blocked`。
- 勾选：新增“readiness transport三轮blocker审计与停止盲重试”子证据；真实hibernate、唯一Action、analysis和heartbeat父项全部保持未勾，blocked不等于完成。
- 决策沉淀：只更新`DOD.md/PROGRESS.md`；没有新API、架构或安全决策，按owner约定不更新llmdoc。
- Blocker与最小恢复输入：长期goal在本账本受保护交付后置为blocked。恢复时先提供可审计的执行面，证明Worker host DNS/TCP/TLS全true且能以既有用途隔离方式安全注入operations token，再由owner明确授权“仅一次exact repository/base readiness GET”；该GET只有返回200后才可另行申请第二次同identity Task POST与唯一Action/双guard after。恢复运行视为新的blocked审计；在此之前不执行readiness、Task、Action、after、repair/restart/recreate、rotation或rollback。

## Round 191 — 2026-07-31
- 目标：继续Phase 1“真实Cloudflare hibernate/Worker restart且GitHub dispatch一次”；在blocked恢复后的新审计第1轮，不重放旧readiness authority，而是建立一个可审计、能绕开当前工作站Worker-host TCP路径的GitHub-hosted readiness执行面。formal hibernate关门命令不变；workflow、Environment或本地测试不能替代readiness 200与真实E2E。
- 前置与权限：仓库写只限新manual workflow、测试与规范/账本；GitHub外部写只创建无Secret的保护性`phase1-readiness` Environment。只读核对repository/owner/environment与Secret名称inventory；不读取、打印、写入或轮换任何Secret值，不dispatch workflow、不发送readiness GET，不执行Task POST、analysis Action、model、D1/R2/Queue/Workflow/Worker写、repair/restart/recreate、after deployment或rollback。本轮仍只选择同一个hibernate DoD。
- Round 190受保护交付：blocker账本经ready PR [#53](https://github.com/evilstar9527/delivery-loop/pull/53)交付；exact head `6b822a9e9619868c717d3974d79b0de958337621`的required CI [30537150902](https://github.com/evilstar9527/delivery-loop/actions/runs/30537150902) / job [90853054859](https://github.com/evilstar9527/delivery-loop/actions/runs/30537150902/job/90853054859) `completed/success`且唯一verify用时4m05s。rebase merge生成`main=498d164bfabc5ee331e6304580633afca31d89a8`，main CI [30537456828](https://github.com/evilstar9527/delivery-loop/actions/runs/30537456828) / job [90854054867](https://github.com/evilstar9527/delivery-loop/actions/runs/30537456828/job/90854054867)亦`completed/success`且唯一verify用时4m07s。PR与main tree均为`cadd68113fc4a5eb2b5d2af81a9dfa6ded679c1b`，review/requested changes/普通/行内评论均0；随后blocked goal自动恢复为active，本轮按新审计计数。
- 第一性审计与修正：初版设计拟复用`production` Environment；GitHub Environment/Secret/Variable三个只读API全部404，证明该Environment并不存在。仅在workflow写`environment: production`会让GitHub首次运行时自动创建无保护Environment，不能作为人审。因此在任何dispatch前改为专用`phase1-readiness`并预创建：public repository ID仍为`1314460432`、default branch=`main`、owner reviewer=`evilstar9527`/`108869708`；live配置恰为required reviewer owner、`prevent_self_review=false`、branch policy `protected_branches=true/custom_branch_policies=false`。Environment Secret inventory为空，repository Secret仅既有两项OpenAI名称且无`GITHUB_BASE_READINESS_OPERATIONS_TOKEN`，没有credential或Action effect。
- workflow契约：`.github/workflows/github-base-readiness.yml`仅`workflow_dispatch`且无inputs，顶层权限恰为`contents:read`，固定concurrency且不cancel。`preflight`不关联Environment/Secret，只对固定public Worker origin运行零HTTP DNS/TCP/TLS；`readiness`只在preflight成功后进入`phase1-readiness`并把唯一Environment Secret映射给仓库内one-shot caller。两个job都固定owner actor、`refs/heads/main`、exact `github.sha`、`run_attempt == 1`、literal `ubuntu-latest`、10分钟timeout、immutable Actions、`persist-credentials=false`与`--ignore-scripts` install；没有OIDC、deploy、Task、model、variable/input override、rerun或第二GET路径。
- RED/GREEN与验证：
  - RED：仅新增`test/github-base-readiness-workflow.test.ts`后，`pnpm exec vitest run test/github-base-readiness-workflow.test.ts` → exit 1，1 test failed，原因恰为workflow文件不存在。
  - 首次GREEN同时运行新测试与runner inventory时，新workflow测试通过；inventory按预期从13 workflows/13 jobs漂移为14/15并使1项失败。只更新exact current inventory后，`pnpm exec vitest run test/github-base-readiness-workflow.test.ts test/github-workflow-runner-policy.test.ts`与`pnpm run verify:workflow-runners` → exit 0，2 files/8 tests及14 workflows/15 jobs。
  - `pnpm exec vitest run test/github-base-readiness-workflow.test.ts test/github-base-readiness-probe.test.ts test/github-workflow-runner-policy.test.ts` → exit 0，3 files/44 tests；覆盖manual-only、owner/main/attempt-1、Environment/Secret隔离、rerun/权限/target禁止项及caller第二次调用/缺配置零网络。
  - `pnpm run ops:github-base-readiness`（无opt-in）→ exit 2，固定`opt-in missing`且零网络。
  - `pnpm run verify` → exit 0；118 Node files / 618 tests、57 workerd files / 322 tests、14 workflows / 15 jobs runner policy、508文件Secret scan与docs links全绿；workerd主动terminate清理诊断不是skip。
  - Git交付首次普通push在80秒后以`HTTP2 framing layer`失败为exit 128且远端ref不存在。既有Git Data API fallback对两笔commit逐一校验blob、tree、parent、author/time、无末尾换行的raw message SHA；首次ref create在object传播窗口返回422且effect为0，随后的API read已能按exact SHA读取两个对象，同一head重试只创建一次线性ref。local/remote head、tree与工作区最终一致，没有force或内容替换。
- 勾选：新增“GitHub-hosted readiness受审执行面与保护Environment bootstrap”子证据；真实readiness、hibernate、唯一analysis Action与heartbeat父项全部保持未勾。
- 决策沉淀：更新`docs/Security.md`和`docs/WorkflowHibernateE2E.md`，明确不存在的Environment不能冒充人审、preflight与Secret job分层、同名Secret scope、attempt-1与exact authority边界；更新`DOD.md/PROGRESS.md`。按owner约定不更新llmdoc。
- 遗留与最小人工输入：代码与Environment经受保护main交付后，owner需另行明确授权：仅把现有operations用途值以`GITHUB_BASE_READINESS_OPERATIONS_TOKEN`写入`phase1-readiness` Environment（repository级仍禁止同名Secret），从受保护main只dispatch一次`GitHub base readiness`；preflight全true后把Environment approval绑定同一run ID/head SHA，释放唯一GET。不授权Task POST、analysis Action、after、repair/restart/recreate、rotation或rollback。当前是恢复后的相同外部authority blocker第1轮，goal保持active。
