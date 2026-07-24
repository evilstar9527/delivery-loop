# delivery-loop Loop Prompt（持续交付执行契约）

> DOD 定义“什么算完成”，本文定义“每一轮怎么做”。Agent、人工开发者和 CI 都应遵守相同证据纪律。

## 0. 六条纪律

1. **每轮一个 DoD**：只选一个可闭环验收项；同一项内可以包含必需的测试、实现、文档和证据。
2. **先验收后实现**：先写下命令、外部资源和成功判据；纯逻辑优先让测试先失败一次。
3. **默认最小权限**：外部测试只申请本轮需要的 scope；不得把真实 Secret 写入仓库、prompt、命令输出或 PROGRESS。
4. **不伪造进度**：失败、skip、未配置远端、未真实部署都按事实记录；本地模拟不冒充真实 E2E。
5. **成熟原语优先**：GitHub App/OIDC/branch protection/Environment、飞书验签、SQL unique/CAS、队列和 OpenTelemetry 优先于自造协议。
6. **小步提交**：按契约、实现、测试/文档等清晰边界提交；共享工作区只提交本任务路径，不使用 `git commit -a`。

## 1. 每轮开场

1. 执行 `pwd`，确认实际 repo/worktree。
2. 读 `llmdoc/startup.md` → MUST 文档。
3. 读 `DOD.md` 当前 Phase、`PROGRESS.md` 当前状态/上一轮遗留。
4. 按任务读取 `docs/Proto.md`、`docs/Security.md` 和相关 architecture/memory；先查已有结论，避免重复外部查询。
5. 写本轮唯一目标：引用 DoD 原文、预期改动路径、验证命令、外部副作用和回滚方式。

## 2. 选择目标

- 按 Phase 顺序推进；可以提前做低风险 spike，但不能提前勾选依赖未满足的完整 DoD。
- 缺外部前置时，把缺口、需要谁提供什么、已经完成的安全检查写入 PROGRESS，然后选择同 Phase 其他不依赖项。
- 同一项连续 3 轮失败：停止盲重试，记录失败指纹、已尝试路径和最小人工输入，置为 blocker。
- 会触发真实 Action、飞书消息、部署或计费模型的测试标为 opt-in；每轮同一外部场景最多跑一次，除非第一次失败且修复后必须复验。

## 3. 实现顺序

1. 更新/确认规范和不变量；如果设计决策改变安全边界，先记录 ADR/文档再写代码。
2. 为状态机、幂等、权限、签名、redaction 写正反测试。
3. 实现最小穿透路径，不同时扩展未进入本轮 DoD 的平台能力。
4. 对 I/O 使用 adapter；领域状态不直接依赖 D1、GitHub、飞书或某个 Agent SDK。
5. 所有外部写操作带 idempotency key；数据库业务状态与 outbox 同事务。
6. 每个 Agent/Action 路径定义 timeout、cancel、heartbeat、checkpoint 和失败退出。

## 4. 验证顺序

1. 运行本项最小测试并确认关键负向用例真的失败/拒绝。
2. 运行 `pnpm run verify`，任何一步失败即本轮未完成。
3. 涉及外部平台时运行显式 opt-in E2E，保存 run/PR/deployment URL、退出码和不含 Secret 的摘要。
4. 做证据真实性核对：Agent 自报结果是否已从 GitHub/飞书/tool-bridge API 外部确认。
5. 做安全核对：权限是否比本轮需要更大、日志/artifact 是否含 Secret、取消后 token 是否撤销。

## 5. 每轮收尾

1. 在 `PROGRESS.md` 追加 Round：目标、动作、验证、勾选、决策、遗留。
2. 只有证据完整时才勾 DOD；一项部分完成时列出已通过子证据，复选框保持未勾。
3. 新增持久知识时更新 `llmdoc` 对应文档；流程踩坑写入 `llmdoc/memory/reflections/`。
4. Phase 全部 DoD 完成后：重跑全部 Phase 验收 + `pnpm run verify`，做正确性/安全/恢复/契约/证据五维 review，再更新 current-state。

## 6. PROGRESS Round 格式

```markdown
## Round <N> — <YYYY-MM-DD>
- 目标：<Phase / DoD 原文>
- 前置与权限：<使用的外部资源、scope、是否 opt-in>
- 动作：<实现与决策摘要>
- 验证：
  - `<command>` → <exit code + 关键结果>
  - <外部 URL / API 核对结果>
- 勾选：<DOD 项 / 无>
- 决策沉淀：<更新的规范/ADR/llmdoc / 无>
- 遗留：<下一步或 blocker>
```

PROGRESS 中不得粘贴 token、完整 webhook payload、用户敏感正文、数据库行或原始生产日志。
