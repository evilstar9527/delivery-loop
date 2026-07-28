# Agent Adapter 外部证据验收

本契约只接受真实非交互 Codex adapter 已完成后的安全结果投影。它不接受 Agent 正文、模型输出、命令输出、任务正文、checkpoint 正文、token 或 workspace 路径。

真实调用入口仍是：

```bash
DELIVERY_LOOP_CODEX_ADAPTER_E2E=1 pnpm run e2e:codex-adapter
```

CI中可用`CODEX_API_KEY`代替本机Codex登录态；可选`OPENAI_BASE_URL`必须经过与生产analysis adapter相同的公网HTTPS/无凭证与query/非IP和非本地域名校验，可信调用方可用`DELIVERY_LOOP_CODEX_ADAPTER_MODEL`锁定受限格式的exact model。不得在命令行或文档中填写key值。

入口会在临时 Git 仓库中启动锁定的 `codex exec --ephemeral --ignore-user-config --sandbox read-only`，检查：

- 进程 exit code 为 0，session 为 `completed`；
- 输出只能通过 `AgentSessionResultV1`；
- Runner checkpoint sequence 至少为 2，且有 canonical digest；
- checkpoint head 与最终 Git HEAD/branch 完全一致；
- workspace clean 且临时目录可删除。

成功后只允许打印 `AgentAdapterEvidenceManifestV1` 的 digest/枚举/安全 SHA 投影。manifest 示例不是事实证据；未设置 opt-in 时 `pnpm run e2e:agent-adapter` 必须 exit 2 且不会启动 Codex。已认证模型调用仍需真实凭证，`help`、fake executor 或无效凭证不能勾选真实 DoD。

仓库的`.github/workflows/codex-provider-preflight.yml`是为第三方route准备的手动、无inputs最小入口：只有`contents:read`，没有Environment/OIDC/写权限，固定使用repository Secret/Variable与`gpt-5.6-terra`运行上述验收，并把安全manifest重定向到`RUNNER_TEMP`后丢弃。它不读取真实Task或控制面，不创建Run/Attempt，也不能替代`Delivery Agent`或Workflow hibernate verifier。
