# Agent Adapter 外部证据验收

本契约只接受真实非交互 Codex adapter 已完成后的安全结果投影。它不接受 Agent 正文、模型输出、命令输出、任务正文、checkpoint 正文、token 或 workspace 路径。

真实调用入口仍是：

```bash
DELIVERY_LOOP_CODEX_ADAPTER_E2E=1 pnpm run e2e:codex-adapter
```

入口会在临时 Git 仓库中启动锁定的 `codex exec --ephemeral --ignore-user-config --sandbox read-only`，检查：

- 进程 exit code 为 0，session 为 `completed`；
- 输出只能通过 `AgentSessionResultV1`；
- Runner checkpoint sequence 至少为 2，且有 canonical digest；
- checkpoint head 与最终 Git HEAD/branch 完全一致；
- workspace clean 且临时目录可删除。

成功后只允许打印 `AgentAdapterEvidenceManifestV1` 的 digest/枚举/安全 SHA 投影。manifest 示例不是事实证据；未设置 opt-in 时 `pnpm run e2e:agent-adapter` 必须 exit 2 且不会启动 Codex。已认证模型调用仍需真实凭证，`help`、fake executor 或无效凭证不能勾选真实 DoD。
