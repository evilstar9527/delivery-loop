# E2E-5 双层恢复真实外部证据验收

E2E-5由两个独立、受控的真实场景组成，而不是强迫同一Run同时处于互斥状态：

1. Workflow hibernate场景在analysis wait中保持`awaiting_approval + waiting`，证明Worker发布新版本后同一instance复用已完成步骤；
2. Runner kill场景最终完成replacement Attempt，证明旧lease/token/Workflow已fence，并从checkpoint/Git继续且没有重复副作用。

总验收层不复制Workflow、Attempt或GitHub parser。`DualRecoveryEvidenceManifestV1`只记录两份完整component manifest的canonical digest和安全identity；`pnpm run e2e:dual-recovery`重新读取三份仓库外manifest，先校验同repository、不同Run/Evidence/Action、同一受审窗口和同一credential-shaped canary digest，再完整调用既有`verifyWorkflowHibernateEvidence`与`verifyRunnerRecoveryEvidence`。

## 1. 前置与证据文件

- 先按[Workflow hibernate验收](WorkflowHibernateE2E.md)完成普通持久恢复场景；
- 再按[Runner强制终止恢复验收](RunnerRecoveryE2E.md)完成Runner kill场景；
- 两个场景必须使用同一试点repository和同一控制面/试点环境，但必须是不同Run、Evidence和GitHub Action；
- 保存两份component manifest，并对各自严格解析后的完整JSON计算`canonicalSha256`；
- 参照[总manifest示例](../schemas/dual-recovery-evidence-v1.example.json)记录两个digest、identity和覆盖两个场景的短时间窗。

三份manifest均在仓库外、单份不超过64 KiB，只含ID、SHA、digest、枚举、计数和时间。不得保存Task/Plan/checkpoint/Agent正文、raw API、Action log、token、canary或Secret。

## 2. 显式 opt-in

```text
DELIVERY_LOOP_DUAL_RECOVERY_E2E=1
DUAL_RECOVERY_EVIDENCE_FILE=<仓库外总manifest>
DUAL_RECOVERY_WORKFLOW_HIBERNATE_FILE=<仓库外Workflow manifest>
DUAL_RECOVERY_RUNNER_RECOVERY_FILE=<仓库外Runner manifest>
DUAL_RECOVERY_CONTROL_PLANE_URL=<控制面HTTPS origin>
DUAL_RECOVERY_CONTROL_PLANE_TOKEN=<Run/Plan/correlation只读短期token>
DUAL_RECOVERY_OPERATIONS_TOKEN=<Case 8只读短期token>
DUAL_RECOVERY_GITHUB_TOKEN=<试点仓库Actions/contents只读短期token>
DUAL_RECOVERY_CLOUDFLARE_TOKEN=<Workflow/deployments只读短期token>
DUAL_RECOVERY_CLOUDFLARE_ACCOUNT_ID=<目标account ID>
DUAL_RECOVERY_SECURITY_CANARY=<仓库外credential-shaped canary>
DUAL_RECOVERY_GITHUB_API_URL=<可选>
DUAL_RECOVERY_CLOUDFLARE_API_URL=<可选>
```

运行：

```bash
pnpm run e2e:dual-recovery
```

- `0`：两份component live verifier均通过，跨场景identity/digest/window绑定一致；
- `1`：任一manifest、digest、跨场景绑定或live authority不一致；
- `2`：未opt-in、配置缺失或任一manifest不可读取。

命令不会触发restart、kill、retry、dispatch、提交或部署。默认exit 2、本地fake、schema example、workerd测试和Wrangler dry-run都不是E2E-5真实平台通过。

## 3. 关门证据

只有总命令exit 0、两份component关门证据、Cloudflare/GitHub/控制面去query审计链接和人工时序review全部入`PROGRESS.md`，E2E-5真实平台事实才可关闭。安全summary必须固定显示两个不同Run、Workflow已复用、旧lease/token已撤销、checkpoint/Git已续跑、duplicate side effects/replay/plaintext leak均为0。
