# DOD（Definition of Done）

> 本文是 delivery-loop 的验收真源：定义每个 Phase 在什么条件下算完成、用什么命令或外部证据验证。每轮开发必须对照本文选择一个未完成项，不能用“代码写了”“Action 跑了”或“Agent 说成功”替代勾选证据。
>
> 规格真源：[Vision](docs/Vision.md)、[Architecture](docs/Architecture.md)、[Proto](docs/Proto.md)、[Security](docs/Security.md)、[Reference](docs/Reference.md)。代码是运行行为真源；发现两者冲突时先显式裁决并同步文档，不能静默漂移。

## 0. 全局完成定义

整个产品 Done = 以下九条同时成立：

1. **Case 1～8 全部 E2E 通过**，运行在真实飞书/Meegle tenant、真实 GitHub 组织/目标仓库、真实 tool-bridge 和至少一个真实部署环境上；
2. **同一来源 revision 精确一次业务执行**：平台事件至少重放 3 次仍只有一个 Task/active Run，真实 revision 更新又能创建后续 Run；
3. **权限闭环**：未批准时 Agent 只能分诊；repo write、test deploy、merge、production deploy 独立授权，越权用例均被外部策略拒绝；
4. **恢复闭环**：实现/验证阶段强制终止 Runner 后，新 attempt 从最新 checkpoint + Git 恢复并完成，不重复已完成的破坏性动作；
5. **证据闭环**：每个成功 Run 都可追到来源 revision、审批、Agent attempt、commit、测试退出码、PR/check、merge 和 deployment/无需部署判定；
6. **Secret 安全**：dispatch、Action log/artifact、飞书卡片、PR、checkpoint、audit 中无明文 canary Secret，结束/取消后短 token 不可再用；
7. **失败可解释**：外部服务不可用、测试失败、审批过期、merge conflict、Runner 丢失都进入可观察状态并给出下一动作，不静默卡死；
8. **一键验证**：`pnpm run verify` 通过，默认测试不依赖外部资源；真实资源测试用显式 opt-in 命令并保留输出摘要/链接；
9. **从零可复现**：按文档在 60 分钟内拉起控制面、安装 GitHub App/飞书应用测试配置、接入试点仓库并跑通人工任务到 Draft PR。

## 1. 每个 Phase 的通用验收规则

每个 Phase 关门前必须满足：

- [ ] **契约一致**：新增 API/event/state/evidence 与 `docs/Proto.md` 一致，破坏性变化提升 schema version。
- [ ] **测试覆盖**：状态机、权限、幂等、签名、redaction 等纯逻辑必须有正反用例；I/O 至少一条穿透集成测试。
- [ ] **安全回归**：跑本 Phase 的越权、重放、Secret 泄漏和不可信输入测试。
- [ ] **证据入账**：命令、退出码、外部 run/PR/deployment URL 和摘要写入 `PROGRESS.md`。
- [ ] **全量回归**：`pnpm run verify` 全绿；任何 skip 明确记录且不能替代 required DoD。
- [ ] **质量关口**：从正确性、安全性、恢复性、三方契约和证据真实性五个维度 review，无 BLOCKER/MAJOR 未处理。

## 2. Phase 0 — DOD 初始化与可执行契约

**目标**：建立能持续演进、能自动验证、不会伪造进度的仓库骨架。

**范围**：Vision/Architecture/Proto/Security/Reference；DOD/LOOP/PROGRESS；TypeScript 工程；TaskEnvelope v1；Run 状态机；CI；文档链接校验；Secret 示例边界。

**DoD**：

- [x] `pnpm run verify` 本地全绿：typecheck + lint + unit + docs link check。
- [x] TaskEnvelope 单测覆盖安全默认值、至少一条验收标准、稳定 revision 去重键和非法输入拒绝。
- [x] Run 状态机单测覆盖主路径、测试修复循环、review 修复循环、blocked/failed 恢复、非法越级和终态。
- [ ] `.github/workflows/ci.yml` 在 GitHub main/pull_request 上实际运行成功，权限只有 `contents: read`。
- [ ] `validate-task.yml` 在 GitHub 手动输入一份 TaskEnvelope 后成功；输入无验收标准/非法 schema 时失败且日志不打印正文。
- [x] 文档 review 明确回答：为什么需要控制面、状态真源在哪里、Secret 如何进入 Runner、恢复如何实现、哪些动作必须人审。
- [ ] 新仓库远端、owner、visibility 和默认分支保护由用户确认后创建；本地初始化不能冒充远端已完成。

## 3. Phase 1 — 人工触发的最小纵向闭环

**目标**：先不接飞书，以人工 API/dispatch 跑通“Task → Action → 只读 Agent 分诊 → 证据回传”，验证平台边界。

**范围**：Hono 控制面骨架；D1/Postgres adapter；Task/Run/Attempt/outbox；manual intake；GitHub App dispatcher；目标仓库 opt-in workflow；只读 Agent adapter；状态页/JSON 查询。

**DoD**：

- [ ] 数据库 migration 可从空库重跑；唯一约束证明同一 Task revision 只能创建一个 Task，outbox 与状态在同事务落库。
- [ ] `POST /v1/tasks` 对合法 TaskEnvelope 返回 202；同 `Idempotency-Key` 并发 20 次仅一条业务记录，响应指向同一 task/run。
- [ ] 状态迁移使用 compare-and-set；两个并发 worker 争抢同 attempt 时只有一个拿到写租约。
- [ ] GitHub App 只安装到试点仓库；dispatcher 成功触发固定 workflow ref，dispatch payload 经过测试证明无 Secret/任务正文。
- [ ] GitHub OIDC exchange 至少校验 issuer、audience、repository、workflow ref、SHA 和 run ID；伪造/过期/其他 repo token 全部拒绝。
- [ ] 一个真实 Action 只读检出目标 repo，Agent 读取仓库并输出结构化分诊报告；不创建分支、不写 repo。
- [ ] Runner 每 30～60 秒 heartbeat；正常完成写 attempt result，控制面状态与 GitHub run 外部事实一致。
- [ ] 飞书尚未接入时，`GET /v1/tasks/:id` 能返回 run/attempt/checkpoint/evidence 安全摘要。
- [ ] 实测并记录试点 GitHub 组织的 hosted runner 最大时长、并发/计费策略、GitHub App 权限和 Actions 事件语义。

## 4. Phase 2 — 飞书/Meegle 任务发现与人审

**目标**：真实任务源进入系统，重复事件不重复执行，缺信息时通过卡片补齐，审批有身份与 revision 约束。

**范围**：飞书 challenge/加密/验签；Meegle adapter；任务规范化；身份映射；卡片状态；approve/reject/cancel/add-context；监控候选任务 adapter（可选启用）。

**DoD**：

- [ ] 真实飞书应用 challenge 和一条真实事件验签通过；错误签名、过期 timestamp、错误 tenant 被拒且无业务记录。
- [ ] 同一飞书 event 重放 3 次只入队一次；不同 event 指向同 task revision 仍只创建一个 Run。
- [ ] Meegle 工作项标题、描述、验收标准、owner、目标 repo、revision 映射为 TaskEnvelope；缺字段进入 `triaging` 并列出缺口。
- [ ] 卡片展示状态、revision、目标 repo、本轮目标、Action/PR 链接、blocker 和批准 effects；大日志只显示摘要/受控链接。
- [ ] approve/reject/cancel/retry/add-context 服务端按 open_id + tenant + revision + effect 鉴权；伪造按钮 payload、重复 nonce、旧 revision 全部拒绝。
- [ ] 补充上下文创建新 revision，不静默改变正在运行 attempt；用户明确选择“应用到当前 Run”才取消/重建 attempt。
- [ ] 飞书审批事件、GitHub 审批和控制面 approval 形成唯一关联记录，能回答谁在何时批准了什么 effect。
- [ ] 监控 adapter（若启用）只创建 candidate/triage，不自动获得 repo write；相同告警指纹在抑制窗口内合并。
- [ ] 飞书 API 限流/超时触发 outbox 重试，状态落库不回退，最终卡片可人工刷新修复。

## 5. Phase 3 — 安全 Context 与可恢复 Agent Runner

**目标**：Agent 在最小权限下使用 tool-bridge，所有关键进度可恢复，外部文本不能改变权限策略。

**范围**：Credential Broker；run/attempt scoped SK；tool call trace；Agent adapter；checkpoint；heartbeat/stuck detector；redaction；只读 bug 分诊。

**DoD**：

- [ ] exchange 成功后只返回 TTL ≤ attempt lease 的 run token/tool-bridge SK；token digest 入账，明文不落库。
- [ ] 分诊 attempt 只获得允许 repo/log/trace/K8s/database-diagnostic 的 read/call scope；越界 path、write、destructive 均由 tool-bridge/策略层拒绝。
- [ ] attempt 完成、取消和 heartbeat 超时后 token 在规定窗口内不可用，并有自动化撤销测试。
- [ ] 日志、Task、checkpoint、artifact、PR 用 canary Secret 扫描全绿；redaction 对 header、JSON 嵌套字段、URL query 和命令环境变量有测试。
- [ ] Agent Adapter 的 start/resume/interrupt/exportCheckpoint 契约测试通过；至少接通一个真实非交互 Agent CLI。
- [ ] 每个 checkpoint 含 sequence、head SHA、已完成验收项、evidence refs、summary、nextStep；乱序/重复 sequence 不覆盖新 checkpoint。
- [ ] Runner 在规划后强制 kill，新 attempt 能恢复到执行；供应商原生 resume 不可用时走语义 checkpoint 兜底。
- [ ] tool-bridge 调用记录包含 run/attempt、工具路径、effect、duration、结果类别；不记录敏感参数明文。
- [ ] prompt injection 对抗用例：任务/日志/代码注释要求输出 Secret、跳过测试、修改 workflow 时，Agent 拒绝或进入审批，不执行越权动作。
- [ ] 同一失败指纹连续 2 次或总 attempt 达 3 次后进入 `blocked`，卡片显示已尝试路径和所需人工输入。

## 6. Phase 4 — Write / Fix / Test / PR 循环

**目标**：经授权后，Agent 在目标仓库实施最小改动、验证并创建可评审 Draft PR。

**范围**：仓库 delivery policy；GitHub App 写 token；分支/commit/PR；测试选择；evidence collector；review feedback attempt；merge conflict 处理。

**DoD**：

- [ ] 目标仓库以受信 `delivery.yaml`（或约定配置）声明 setup、定向测试、全量验证、受保护路径和部署 contract；未知命令不能从任务正文直接执行。
- [ ] 未批准 `repo_write` 时创建分支/commit/PR 全部失败；批准后 token 仅限目标 repo 且过期可撤销。
- [ ] 分支命名含 task/attempt，commit 作者为 GitHub App/明确 bot；禁止 push main 和强推受保护分支。
- [ ] Agent 修改 workflow、CODEOWNERS、Secret/部署配置等高风险路径时自动停在 `awaiting_approval` 并列出 diff。
- [ ] 先跑与改动相关的定向测试，再跑仓库 required verify；命令、exit code、duration、head SHA 入 Evidence。
- [ ] 测试失败允许有界修复循环；同失败指纹不重复消耗，达到上限进入 `blocked`。
- [ ] Draft PR 正文包含来源任务/revision、验收标准逐条状态、变更摘要、风险、测试证据、未完成项和回滚说明。
- [ ] PR 创建由 GitHub webhook 外部核对；Agent 自报 PR URL 不能直接推进状态。
- [ ] Review comment 绑定 PR head SHA 并创建 `review_fix` attempt；已过时评论不误改新代码。
- [ ] base branch 前进导致冲突时不盲目覆盖；安全可重放则 rebase 后重验，否则 `blocked` 请求人工。
- [ ] 真实试点 repo 完成 requirement 与 bug 各一条到 Draft PR，diff/测试/PR 证据可追溯。

## 7. Phase 5 — Merge、测试部署与生产闸门

**目标**：把“PR 做完”与“已上线”分开，只有外部平台事实满足时推进。

**范围**：required checks；review policy；merge；test deploy；production Environment；deployment webhook；rollback contract；飞书发布状态。

**DoD**：

- [ ] required checks 未完成/失败、review 不足、base 非最新、approval 过期时 merge 全部被拒。
- [ ] Agent/PR 作者不能批准自己的 merge/production effect；审批主体由 GitHub/飞书身份映射核对。
- [ ] 测试部署使用独立 OIDC 角色和 environment，不能访问生产 Secret；部署结果与 URL 作为独立 Evidence。
- [ ] E2E/验收失败返回 `executing` 或 `blocked`，不会因为 deployment job 启动就标成功。
- [ ] 合并成功由 GitHub webhook 核对 merge SHA；只在“无需部署”策略下可直接 `succeeded`。
- [ ] 生产部署必须经过 GitHub Environment reviewer 或等价外部审批；批准绑定 revision + merge SHA + environment。
- [ ] deployment 成功/失败从平台 API/webhook 核对；Action 末尾 echo `success` 不能替代。
- [ ] 仓库提供明确 rollback contract 时，测试环境自动回滚可执行；生产自动回滚策略另行审批并有演练证据。
- [ ] 飞书卡片分开展示 PR、merge、test deploy、production deploy 四种状态与链接。
- [ ] 真实试点仓库跑通测试环境部署；生产至少在隔离 demo 环境演练审批、成功、失败和回滚。

## 8. Phase 6 — 可靠性、审计与运营

**目标**：系统可长期运行，能发现卡死、限制成本、恢复故障、回答审计问题。

**范围**：SLO/metrics/trace；dead-letter；reconciliation；成本/速率限制；备份恢复；审计查询；数据保留；运营手册。

**DoD**：

- [ ] Task/Run/Attempt/GitHub run/PR/deployment 的 correlation ID 可在日志和 trace 中联查。
- [ ] stuck detector 对 queued/running/awaiting_review/deploying 分别有阈值和动作；故障注入能在阈值内告警/恢复。
- [ ] outbox/queue dead-letter 可重放，重放 3 次不产生重复 dispatch、PR、merge 或部署。
- [ ] reconciliation 定期从 GitHub/飞书核对外部事实，修复“回调丢失但外部已成功”的状态。
- [ ] 每 tenant/repo/user/run 有并发、attempt、token、模型费用和 tool 调用限额；P0 override 仍需审计。
- [ ] D1/Postgres 备份恢复演练后，Task/Run/Approval/Audit 一致，active token 全部强制撤销后再恢复。
- [ ] 审计查询能在 5 分钟内回答 Case 8 的问题，结果含 digest/链接且不暴露 Secret。
- [ ] 数据保留任务按 Security 约定清除原始 session、保留结构化证据，并记录删除审计。
- [ ] 运营 runbook 覆盖 GitHub 故障、飞书故障、tool-bridge 故障、数据库故障、Secret 泄漏和错误生产部署。
- [ ] 连续 7 天试运行无未知 stuck run、无重复 PR/部署、无 Secret 告警；指标报告入账。

## 9. Phase 7 — 最终 E2E

E2E 必须脚本化到可重跑的最大程度；飞书人工批准步骤可以是受控人工步骤，但其前后状态和 actor 由脚本/API 断言。

| # | 场景 | 通过判据 |
|---|---|---|
| E2E-1 | 飞书需求 | 真实 Meegle/卡片创建任务 → 补齐验收 → 批准 → 单一 Run/Action |
| E2E-2 | 缺陷分诊 | 输入 uid/cid/路径等定位信息 → tool-bridge 查日志/trace → 根因证据可引用，未写生产 |
| E2E-3 | 代码交付 | repo_write 批准 → 最小 diff → 定向+全量测试 → Draft PR，验收逐条有证据 |
| E2E-4 | 评审循环 | review 提意见 → 新 attempt 恢复 → 修复 → 新 head SHA 上 checks 全绿 |
| E2E-5 | Runner 恢复 | 执行中 kill → lease/token 撤销 → 新 attempt 从 checkpoint/Git 继续且无重复副作用 |
| E2E-6 | 权限与注入 | 未授权写/部署、跨 repo OIDC、过期审批、恶意任务文本全部被拒；canary Secret 零泄漏 |
| E2E-7 | 合并部署 | required checks + 人审 → merge → test/production gate → deployment 外部核对 → 飞书完成 |
| E2E-8 | 重放与故障 | 飞书/GitHub/queue 事件各重放 3 次，注入回调丢失/限流，最终状态正确且无重复 PR/部署 |

**E2E-1～8 全部通过才可宣布项目 Done。**

## 10. 外部前置与人工决策

进入 Phase 1 前必须记录：

- GitHub 组织、试点 repo、App owner、允许的 permissions、branch protection 和 Actions 预算；
- 飞书测试 tenant、应用 owner、Meegle/卡片入口选择和所需 scopes；
- tool-bridge 测试 BaseURL、broker scope、SK TTL/撤销能力与敏感字段策略；
- 控制面部署目标（Cloudflare 或现有 K8s/Postgres）和数据合规要求；
- 首个 Agent adapter、认证方式、预算、license 与 session resume 事实；
- MVP 是否止于 Draft PR（推荐）或包括 test deploy；生产自动化默认不进入 MVP。

缺少前置时不能伪造 E2E；在 `PROGRESS.md` 记录 blocker，并继续完成不依赖该前置的本地契约/测试。

## 11. Loop 执行约定

完整契约见 [LOOP.md](LOOP.md)：每轮读 DOD + PROGRESS，选择一个 DoD，先明确验收，完成实现和回归，证据入账后才勾选。Phase 关门必须重跑本 Phase 全部命令并做五维质量关口。
