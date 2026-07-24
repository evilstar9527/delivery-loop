# PROGRESS（Loop 进度与证据账本）

> 每轮只追加事实和可重跑证据。Secret、完整飞书正文、数据库行和原始生产日志不得写入本文。

## 当前状态

- **当前 Phase**：Phase 0 — DOD 初始化与可执行契约。
- **已完成**：本地仓库已创建；规范/DOD/Loop 骨架、TaskEnvelope v1、Run 状态机、CI workflow 已写入；Phase 0 本地 4 项已完成。
- **未验证外部能力**：远端 GitHub repo、GitHub App、飞书应用、控制面部署、tool-bridge broker、真实 Agent adapter 均未配置。
- **下一目标**：用户确认远端 owner/name/visibility 后创建 GitHub repo，验证 CI 与手工 Task contract workflow，完成 Phase 0 剩余 3 项。

## Blockers / 待用户决策

- 新远端仓库的 GitHub owner/organization、最终名称与 visibility 未指定；当前只创建本地 `/Users/jishihe/delivery-loop`。
- 首批试点 repo、飞书入口形态、控制面部署位置、Agent adapter 和 MVP 是否包含测试部署尚未拍板，详见 [Reference §7](docs/Reference.md#7-尚未拍板的产品决策)。

## 外部前置核对

尚未开始。Phase 1 前按 [DOD §10](DOD.md#10-外部前置与人工决策) 逐项记录，不以本机已有登录态推断组织权限。

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
