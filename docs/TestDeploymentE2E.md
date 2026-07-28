# Test deployment 外部证据验收

本命令只验收已经发生的测试部署事实，不创建 Deployment、Action、OIDC token 或 Secret。真实试点需要一个已部署控制面、只安装到试点仓库的 GitHub App、`test` Environment、测试账户的 `test:*` OIDC role，以及不含生产值的 test-only Secret。生产 Secret 隔离和云 trust policy 没有统一 API，必须同时保留外部审计链接并人工核对。

## Manifest

复制 [`test-deployment-evidence-v1.example.json`](../schemas/test-deployment-evidence-v1.example.json) 到仓库外私有位置。每个 case 绑定一个 Run、Plan、deployment Attempt、GitHub Deployment、OIDC attestation、Action run、deployment Evidence 和 `test` Environment URL；同时记录 signed `deployment_status` webhook 与 API compensation observation。`noDuplicate` 必须证明单 Attempt、单 Deployment、单 deploy outbox、单 deployment Evidence。

Manifest 只能保存安全 ID、SHA、digest、枚举、时间和无 query 的 HTTPS URL。禁止保存 OIDC/JWT、GitHub token、Environment Secret、Task/PRD/日志正文、raw webhook/REST response、Action output、R2 ref 或数据库行。`oidcAuditUrl` 与 `productionSecretIsolationEvidenceUrl` 仅作为仓库外人工审计索引，不会被 verifier 当成权限或成功事实。

## 显式 opt-in

```bash
DELIVERY_LOOP_TEST_DEPLOYMENT_E2E=1 \
TEST_DEPLOYMENT_EVIDENCE_FILE=/private/test-deployment.json \
TEST_DEPLOYMENT_CONTROL_PLANE_URL=https://control.example \
TEST_DEPLOYMENT_CONTROL_PLANE_TOKEN="$CONTROL_PLANE_READ_TOKEN" \
TEST_DEPLOYMENT_GITHUB_TOKEN="$GITHUB_DEPLOYMENTS_READ_TOKEN" \
pnpm run e2e:test-deployment
```

退出码沿用 Watt `476e3cdd2490d725fde174e7c697ebf00899edc6` 的显式门禁：

- `0`：Case 8、GitHub Deployment/latest status、deployment-triggered Action 和独立 Evidence 全部一致；
- `1`：manifest/schema、控制面投影、OIDC/Environment binding、Action、status、URL 或 zero-duplicate 事实不一致；
- `2`：没有 opt-in、配置不完整或 manifest 不可读，且不会读取网络。

verifier 只读 `GET /v1/runs/:runId/audit`，复用生产 `GitHubTestDeploymentStatusApiClient` 读取 exact Deployment 和最新 status，并复用 `GitHubActionsApiClient` 的 workflow-run parser 读取 deployment-triggered Action。所有响应有界读取、拒绝分页；token 只进入对应 `Authorization` header，错误不传播上游正文。

真实验收必须人工记录 GitHub Deployment/Action/Environment URL、OIDC 换证审计、test-only Secret 访问被生产 Secret 隔离策略拒绝的安全审计，以及 webhook 丢失后 API compensation 的控制面链接。fake API、Case 8 fixture、示例 manifest、Wrangler dry-run 和默认 exit 2 不能关闭真实 DoD。
