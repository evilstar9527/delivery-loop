# Vision

## 1. 原始问题

团队的软件交付信息分散在飞书消息、Meegle 工作项、GitHub、日志、数据库、K8s 和人工记忆里。Agent 即使能写代码，也常因缺少上下文、执行环境短暂、权限过大、结果无法审计而停在“生成补丁”，没有完成真正的交付。

本项目的原始目标是：让一个被授权的需求或缺陷，在人可以随时看见、干预和追溯的前提下，自动推进到可验证的代码与部署结果。

## 2. 产品定义

delivery-loop 是端到端交付的控制面：

1. 从飞书或 Meegle 接收原始 PRD 和 BUG 输入，并路由到对应的 GitHub 仓库；
2. 把自然语言任务规范化为有验收标准、目标仓库和权限策略的 `TaskEnvelope`；
3. 先启动只读分析 attempt：需求分析读取仓库上下文，缺陷分析除仓库上下文外按需通过 tool-bridge 只读读取日志、数据库、K8s 和协作上下文；
4. 生成版本化 `ExecutionPlan`，每个 DoD Item 同时声明目标、完成判据、验证方式、依赖和 effect；
5. 经策略校验和必要的人审后，在 GitHub Actions 中启动有界的执行 attempt；
6. 执行 DoD 计划、创建 PR 并进入评审与修复循环，直到没有 BLOCKER 或 MAJOR 问题；
7. 在明确闸门后合并和部署；
8. 以 Cloudflare Workflows 持久编排流程，以 D1 保存业务真相，并把状态、checkpoint、证据和人类操作回写飞书。

## 3. 设计原则

- **完成由证据定义**：代码存在、测试通过、PR 合并和部署成功是不同状态，不能相互代替。
- **控制与执行分离**：控制面持久化真相，Actions 只承担一次有边界的计算尝试。
- **默认最小权限**：读取上下文、写仓库、部署测试、部署生产是四个独立授权面。
- **人审是产品能力**：高风险操作停在可理解、可批准的状态，不把“全自动”当作目的。
- **可恢复优先于长驻**：Runner 随时可能消失；每个关键步骤都必须能从 Git、checkpoint 和证据恢复。
- **计划也是契约**：任务级 DoD 不是 Agent 的临时待办，而是版本化、可审批、可验证、可回放的执行计划。
- **两层恢复**：Cloudflare Workflows 恢复控制流；Git commit + Agent checkpoint 恢复一次执行尝试的工作区和语义进度。
- **外部文本不可信**：任务正文、网页、日志、代码注释都可能包含 prompt injection；策略不能由 Agent 自行放宽。
- **成熟平台原语优先**：PR、required checks、GitHub Environment、GitHub App、OIDC、飞书审批卡片优先于自造等价机制。

## 4. User Cases（最终验收视角）

### Case 1：人工发起需求

用户在飞书/Meegle 选择目标仓库并确认验收标准，控制面创建唯一任务。重复点击或事件重放不会创建第二个有效运行。

### Case 2：缺陷发现与证据化分诊

监控或人工上报缺陷后，Agent 通过 tool-bridge 只读查询日志、trace、数据库和 K8s，产出根因假设、引用证据、影响面和版本化执行计划；没有足够证据时进入 `blocked`，而不是猜测修改。

缺陷分诊的根因引用不是Agent自由填写的字符串。控制面只接受同一active analysis Attempt中成功的`logs/search + traces/get` metadata，把locator值与脱敏根因分别摘要化后形成verified diagnostic Evidence；Plan声明`logs_read`时必须引用该Evidence。原始uid/cid/path、日志、trace和tool结果不进入D1安全投影，真实语义仍由Reviewer对原始平台事实与exact代码SHA核对。

### Case 3：代码执行与验证

经授权后，Actions 为目标仓库创建隔离分支，Agent 只执行依赖已满足且已获 effect 授权的 DoD Item，实施最小改动，运行仓库约定的定向测试与回归，并创建包含逐项验收证据的 Draft PR。

### Case 4：评审修复循环

PR review 或飞书补充信息触发新 attempt。新 Runner 能恢复原分支、任务、已完成步骤和失败证据，只修复未完成项，不从零重复探索。

### Case 5：合并和部署

只有 required checks、策略检查和所需人审全部满足才允许合并。测试与生产部署分开记录；生产使用 GitHub Environment 或等价人工闸门，并具备回滚证据。

### Case 6：状态与人工操作可见

飞书卡片显示当前状态、本轮目标、Action/PR/部署链接、阻塞原因和可执行动作。审批、取消、重试、补充上下文与手工接管均写入审计事件。

### Case 7：Runner 故障后恢复

控制 Worker 或 Workflow 休眠/重启后，成功的持久步骤不会重复产生副作用；Runner 在任意关键步骤被终止后，新 attempt 能从 checkpoint + Git commit 恢复。如果 Agent 供应商不支持原生 session resume，也能用结构化摘要恢复语义进度。

### Case 8：审计与权限证明

能够回答“谁基于哪个事件、以什么权限、读取了哪些类别的上下文、改了什么、哪些检查通过、谁批准、部署到哪里”，且日志与 artifact 中无明文 Secret。

## 5. 非目标

- 不替代飞书/Meegle 的产品规划、优先级和责任人机制。
- 不替代 GitHub 的代码评审、分支保护和 CI。
- 不把 GitHub Actions 变成长驻 Agent 服务或主数据库。
- 不允许 Agent 自行提升 tool-bridge scope、关闭 required checks 或批准生产部署。
- MVP 不自动从所有日志噪声中决定“这一定是 bug”；监控事件先生成候选任务，仍需规则或人工确认。
- 不绑定单一模型供应商；Agent adapter 是可替换边界。

## 6. 成功标准

- 同一来源任务同一 revision 的重复事件产生 1 个 active run。
- 已授权任务从接收到 Action 排队的 P95 小于 5 分钟（排除 GitHub 平台排队）。
- 100% attempt 在退出前写入终态或可恢复 checkpoint；stuck detector 能发现失联 attempt。
- 100% 执行中的必需 DoD Item 都有预先声明的完成判据，只有经核对的 Evidence 才能置为 `passed`。
- 100% PR 包含任务链接、验收标准、测试命令与结果摘要。
- 未经授权的仓库写入、生产部署和 Secret 泄漏为 0。
- Case 1～8 在真实飞书、真实 GitHub 目标仓库和真实 tool-bridge 上均有可重跑 E2E 证据。
