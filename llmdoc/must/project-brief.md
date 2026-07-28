# 项目速览（MUST）

## 一句话定义

delivery-loop 是端到端软件交付控制面：把飞书/Meegle/GitHub/监控中的需求或缺陷，推进为有权限边界、可恢复、可审计的 GitHub Agent 执行、PR、评审和部署闭环。

## 四个平面

1. **任务/协作面**：飞书、Meegle、GitHub、监控产生事件与人类决策。
2. **持久控制面**：Cloudflare Workflows 持久编排控制流；D1 唯一保存 Task/Run/ExecutionPlan/PlanItem/Attempt、去重、状态、审批、checkpoint、evidence、audit，R2 保存受控大对象。
3. **临时执行面**：GitHub Actions 运行一次 Agent attempt；可被随时回收，不能做状态真源。
4. **上下文面**：tool-bridge 以短期最小 scope 提供 repo/log/database/K8s/飞书上下文。

## 知识真源

- 代码是运行行为真源。
- `docs/` 是规范真源；改变边界/契约/安全策略要同步更新。
- `DOD.md` 是完成判据；只有可重跑命令或外部事实可勾选。
- `PROGRESS.md` 是实际证据账本，不保存 Secret/敏感正文。
- llmdoc 是压缩导航层，不与规范重复竞争。

## 恒定纪律

- Actions 是 compute，不是 database。
- `run_id` 是 Cloudflare Workflow instance id；Workflow 状态不是对外业务状态真源。
- 任务级 DoD 是版本化 `ExecutionPlan`，每个必需 Item 必须以核对后的 Evidence 关门。
- dispatch payload 不是 Secret 通道。
- Agent 可以请求动作，不能修改 policy 或自批权限。
- repo write、test deploy、merge、production deploy 分开授权。
- Git commit 是工作区恢复真源；checkpoint 是语义进度恢复真源。
- Agent 自报的 PR/check/deploy 状态必须通过外部 API/webhook 核对。
- 飞书按钮服务端再鉴权；外部自然语言一律视为不可信数据。
