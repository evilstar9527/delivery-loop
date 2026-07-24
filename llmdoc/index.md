# llmdoc 索引

> llmdoc 是面向开发 Agent 的压缩知识层。稳定产品规范在 `docs/`，完成判据在 `DOD.md`，运行证据在 `PROGRESS.md`；llmdoc 负责快速路由，不复制大段规范。

## MUST

- [startup.md](startup.md) — 每轮阅读顺序。
- [must/project-brief.md](must/project-brief.md) — 产品边界、真源与恒定纪律。
- [must/current-state.md](must/current-state.md) — 当前实现、外部状态和下一步。

## Architecture

- [architecture/code-map.md](architecture/code-map.md) — 文件与未来模块落点。

## Memory

- [memory/doc-gaps.md](memory/doc-gaps.md) — 需要后续验证/补齐的文档缺口。
- `memory/decisions/` — 影响多轮的架构决策，做出时创建 ADR。
- `memory/reflections/` — 流程误判和可复用教训，发生时创建。

## 规范路由

- 产品目标/User Cases → [../docs/Vision.md](../docs/Vision.md)
- 模块、数据流、状态与恢复 → [../docs/Architecture.md](../docs/Architecture.md)
- 事件/API/checkpoint/evidence → [../docs/Proto.md](../docs/Proto.md)
- 权限、Secret、注入与审批 → [../docs/Security.md](../docs/Security.md)
- 平台事实、选型、开放决策 → [../docs/Reference.md](../docs/Reference.md)
- 验收项 → [../DOD.md](../DOD.md)
- 单轮执行 → [../LOOP.md](../LOOP.md)
- 进度证据 → [../PROGRESS.md](../PROGRESS.md)

