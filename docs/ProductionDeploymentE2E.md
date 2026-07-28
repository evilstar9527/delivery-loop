# Production deployment 外部证据验收

本命令只验收已经发生的 production Deployment 事实，不创建 Deployment、Action、OIDC token 或生产 Secret。每个 case 必须绑定同一 Run、Plan、merge SHA、production release approval、deployment Attempt、GitHub Deployment、Deployment-triggered Action 和控制面 Evidence；同时记录一条 signed `deployment_status` webhook observation 与一条 API compensation observation。

Manifest 只保存安全 ID、SHA、digest、枚举、时间和无 query 的 HTTPS URL。禁止保存 OIDC/JWT、GitHub token、Environment Secret、Task/PRD/日志正文、raw webhook/REST response、Action output、R2 ref 或数据库行。`failure` case 可以把 `actionConclusion` 记录为 `success`，用于证明 Action 末尾自报不能覆盖平台失败事实。

## 显式 opt-in

```bash
DELIVERY_LOOP_PRODUCTION_DEPLOYMENT_E2E=1 \
PRODUCTION_DEPLOYMENT_EVIDENCE_FILE=/private/production-deployment.json \
PRODUCTION_DEPLOYMENT_CONTROL_PLANE_URL=https://control.example \
PRODUCTION_DEPLOYMENT_CONTROL_PLANE_TOKEN="$CONTROL_PLANE_READ_TOKEN" \
PRODUCTION_DEPLOYMENT_GITHUB_TOKEN="$GITHUB_DEPLOYMENTS_READ_TOKEN" \
pnpm run e2e:production-deployment
```

退出码沿用 Watt `476e3cdd2490d725fde174e7c697ebf00899edc6` 的显式门禁：

- `0`：四类平台状态、Case 8 投影、GitHub Deployment/latest status、Deployment Action、双源 observation 和独立 Evidence 全部一致；
- `1`：manifest/schema、控制面投影、OIDC/Environment binding、Action、status、URL 或去重事实不一致；
- `2`：没有 opt-in、配置不完整或 manifest 不可读，且不会读取网络。

verifier 只读 `GET /v1/runs/:runId/audit`，复用生产 `GitHubProductionDeploymentStatusApiClient` 的 exact Deployment/latest status parser 和 `GitHubActionsApiClient` 的统一 workflow-run parser。所有响应拒绝分页并有 1 MiB 读取上限；token 只进入对应 `Authorization` header，错误不传播上游正文。

四类 case 固定为：

1. `in_progress`：Run 仍为 `deploying`，没有 deployment Evidence；
2. `success`：平台 status success + exact production OIDC + Action success + passed Evidence，才允许 `succeeded`；
3. `failure`：平台 status failure，即使 Action 自报 success，也必须是 failed Evidence/failed Run；
4. `error`：平台 status error，必须是 failed Evidence/failed Run。

真实验收必须人工记录 GitHub Deployment/Action/Environment URL、OIDC/cloud 审计、签名 delivery、API compensation 和 D1 Evidence/Run 链接。fake API、Case 8 fixture、示例 manifest、Wrangler dry-run 和默认 exit 2 不能关闭真实 DoD。
