# Reference

## 1. 可行性矩阵

| 需求 | 可行性 | 关键条件 |
|---|---|---|
| 飞书/Meegle 发现需求或 bug | 高 | 公网 webhook、验签、去重、字段映射；监控事件先作为候选 |
| GitHub Actions 运行 Agent | 高 | 固定 workflow、时长/并发预算、Runner 外 checkpoint |
| Agent 修改代码并建 PR | 高 | GitHub App、目标仓库 opt-in、分支保护、写租约 |
| tool-bridge 补充上下文 | 高 | run 级短期 SK、只读默认、调用审计、敏感数据脱敏 |
| Agent session 恢复 | 中高 | 供应商原生 resume 不是必需；Git + 结构化 checkpoint 是兜底 |
| 全自动合并与生产部署 | 条件可行 | required checks、Environment 审批、回滚契约；默认不全自动 |
| 仅靠 Actions 保存全部状态 | 不可接受 | Runner 临时、artifact 非事务数据库、重跑/取消会产生歧义 |
| 飞书直接触发 Action 且无中间服务 | 仅适合 demo | 无可靠验签/状态/去重/回调闭环，不能作为生产架构 |

## 2. 默认技术选型

| 能力 | 默认选择 | 原因 |
|---|---|---|
| HTTP/Worker | Hono | 与 tool-bridge 技术栈一致，可运行于 Worker/Node |
| 控制面默认宿主 | Cloudflare Worker | 低运维的公网 webhook 与定时任务入口 |
| 事务状态 | D1（接口可替换 Postgres） | Task/Run/Attempt 关系和唯一约束需要 SQL |
| 异步派发 | Cloudflare Queues + outbox | webhook 快速响应、重试不重复推进业务状态 |
| Schema | Zod | Task/checkpoint/API 单一运行时契约 |
| GitHub | GitHub App + Octokit | installation 最小权限、webhook、PR/Actions API |
| 飞书 | 官方 OpenAPI SDK/原生 HTTP 验签 | 卡片、消息、身份解析；不自造协议模型 |
| Agent | Adapter 接口 | 不绑定供应商；统一 checkpoint/evidence |
| 测试 | Vitest | 单测、状态机和协议契约；外部 E2E opt-in |
| 可观测性 | OpenTelemetry + 平台日志 | task/run/attempt/trace 关联 |

版本在实现对应 Phase 时钉死并记录验证，不在设计阶段追逐 `latest`。

## 3. GitHub 平台注意事项

- hosted runner 是短生命周期计算资源，不能把本地 session 文件当作唯一恢复来源。
- dispatch 只从目标仓库默认分支上的 workflow 定义启动；workflow 版本要进入任务证据。
- 使用 `GITHUB_TOKEN` 创建的事件可能具有防递归语义，跨仓库和需要继续触发 checks 的路径优先 GitHub App。
- `concurrency` 能取消/串行化 job，但不能替代数据库租约和业务幂等。
- Action 日志和 artifact 对仓库有读取权限的人可见，不是 Secret 通道。
- Actions job 时长、并发和计费上限属于外部事实，Phase 1 必须在目标 GitHub 组织实测并写入 `PROGRESS.md`。

## 4. 飞书平台注意事项

- webhook challenge、事件加密/签名、重试语义和卡片回调必须用真实应用实测。
- Meegle 与普通飞书任务/消息不是同一资源模型；adapter 保留来源字段，Normalizer 才统一 TaskEnvelope。
- 飞书卡片适合状态和人类动作，不是完整执行日志查看器；大日志只给受控链接与摘要。
- 事件中用户身份与 GitHub/组织角色不是天然同一身份，需要显式映射。

## 5. tool-bridge 复用边界

直接复用：渐进发现、repo/log/database/K8s/Feishu 上下文聚合、scope/effect、调用 trace。

需要新增或外置：GitHub OIDC 到短期 SK 的 broker、run/attempt 绑定、强制 TTL、结构化调用审计的关联字段。若 tool-bridge 暂无 OIDC exchange，先在 delivery-loop 控制面实现 broker adapter，不把该语义硬塞进 Agent prompt。

## 6. 动工前必须验证的外部事实

- GitHub 组织是否允许安装 App、创建 PR、触发目标 workflow、使用 Environment reviewer 和 OIDC。
- 目标仓库的分支保护、required checks、CODEOWNERS 和测试/部署命令。
- 飞书应用可订阅的事件、卡片回调、Meegle API 权限和测试 tenant。
- tool-bridge 能否签发带 `expiresAt` 的最小 scope SK、能否按 attempt 撤销、日志返回是否可 schema 脱敏。
- 选择 Cloudflare D1/Queues 是否满足数据驻留、保留和组织合规；不满足则切 Postgres/现有内部平台。
- Agent CLI 在 Actions 上的认证方式、session resume 能力、非交互退出码和许可/费用。

## 7. 尚未拍板的产品决策

这些问题不阻塞仓库初始化，但进入对应 Phase 前必须由用户/团队确认：

1. 首批目标 GitHub 组织与试点仓库，以及 GitHub App 安装负责人。
2. 飞书入口是群机器人、应用卡片、Meegle workflow，还是三者都要；MVP 推荐 Meegle + 卡片。
3. 控制面默认部署 Cloudflare 还是公司现有 K8s；MVP 推荐 Cloudflare，合规优先时选现有 K8s + Postgres。
4. 第一种 Agent adapter 与模型预算上限。
5. 自动合并策略：MVP 推荐永不自动合并，仅自动推 Draft PR。
6. 生产部署是否进入首个里程碑；MVP 推荐只到测试环境，生产作为后续 Phase。

