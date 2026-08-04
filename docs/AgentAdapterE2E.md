# Agent Adapter 外部证据验收

本契约只接受真实非交互 Codex adapter 已完成后的安全结果投影。它不接受 Agent 正文、模型输出、命令输出、任务正文、checkpoint 正文、token 或 workspace 路径。

真实调用入口仍是：

```bash
DELIVERY_LOOP_CODEX_ADAPTER_E2E=1 pnpm run e2e:codex-adapter
```

CI中可用`CODEX_API_KEY`代替本机Codex登录态；可选`OPENAI_BASE_URL`必须经过与生产analysis adapter相同的公网HTTPS/无凭证与query/非IP和非本地域名校验。配置中转后，session/analysis/execution统一选择`delivery_loop_relay` custom provider，固定Responses、`requires_openai_auth=true`、`supports_websockets=false`与`high` reasoning；可信调用方可用`DELIVERY_LOOP_CODEX_ADAPTER_MODEL`锁定受限格式的exact model。不得在命令行或文档中填写key值。

入口会在临时 Git 仓库中启动锁定的 `codex exec --ephemeral --ignore-user-config --sandbox read-only`，检查：

- 进程 exit code 为 0，session 为 `completed`；
- 输出只能通过 `AgentSessionResultV1`；
- Runner checkpoint sequence 至少为 2，且有 canonical digest；
- checkpoint head 与最终 Git HEAD/branch 完全一致；
- workspace clean 且临时目录可删除。

成功后只允许打印 `AgentAdapterEvidenceManifestV1` 的 digest/枚举/安全 SHA 投影。manifest 示例不是事实证据；未设置 opt-in 时 `pnpm run e2e:agent-adapter` 必须 exit 2 且不会启动 Codex。已认证模型调用仍需真实凭证，`help`、fake executor 或无效凭证不能勾选真实 DoD。

仓库的`.github/workflows/codex-provider-preflight.yml`是为第三方route准备的手动、无inputs最小入口：只有`contents:read`，没有Environment/OIDC/写权限，固定使用两个repository Secret与当前生产profile的`gpt-5.6-terra + medium + Responses SSE`运行上述验收，并把安全manifest重定向到`RUNNER_TEMP`后丢弃。analysis fixture context与production Runner一样位于workspace内0700隐藏目录/0600文件；Agent必须从文件原始字节计算context proof，adapter核对并删除proof，最后删除context后再证明Git clean。它不读取真实Task或控制面，不创建Run/Attempt，也不能替代`Delivery Agent`或Workflow hibernate verifier。历史Sol/high证据只证明当时冻结profile，不得用于替代当前production exact-route preflight。

provider进程失败时，CLI stderr仍只在受控进程内以8 KiB上限采集，并先按当前敏感环境值脱敏。preflight随后只能把它映射为认证、quota、限流、model、endpoint、Responses兼容、upstream、timeout、stream interruption、network、CLI contract或generic这12个固定枚举；进程成功但context proof缺失/错误则单独固定为`context_proof_invalid`，不能误报成provider transport失败。stream interruption只接受Codex 0.145.0官方`stream disconnected before completion`或明确带Responses/SSE stream语义的提前close/end/interruption；普通TCP `connection closed/reset`仍归network，未知文本一律收敛为generic。原始stderr、provider响应、URL和错误摘要/digest均不打印、不上传、不进入manifest或控制面。

当模型preflight收敛为`provider_network_failed`时，先运行`.github/workflows/provider-network-preflight.yml`，不能直接用业务Task继续试错。该workflow手动、无inputs、只有`contents:read`，只把repository Secret `OPENAI_BASE_URL`交给`pnpm run e2e:provider-network`；不读取API key、不启动Codex/模型、不向provider发送HTTP且不上传artifact。探针复用生产adapter的URL校验，依次验证公网DNS、endpoint TCP（未声明端口时443）与带SNI、系统CA和hostname校验的TLS。日志只会出现固定code及`dns/tcp/tls`布尔值；不得复制hostname、IP、URL、证书或底层错误。真实run `30382103409`已固定证明`dns=true tcp=true tls=true`，因此此前generic network枚举不能再作为基础网络失败的充分结论；它仍不能证明Responses stream、认证、route或model成功，真实provider preflight必须独立成功。
