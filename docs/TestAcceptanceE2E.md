# Test acceptance 外部证据验收

本命令只验收测试部署后的独立 acceptance Action，不创建 Action、OIDC token、测试请求或 Evidence。真实试点需要已通过的 test Deployment、test Environment、`delivery-test-acceptance.yml` 和只读 GitHub Actions 凭据。

仓库外 manifest 必须同时包含三条不同 Run/Acceptance/Action：

- `running`：Deployment 已成功但 acceptance Action 仍为 requested/queued/waiting/in-progress，不能有 acceptance Evidence；
- `passed`：Action completed/success 且 Runner result 为 exit 0，才有 verified test Evidence；
- `failed`：Action failure 或 Runner/Action 冲突，Evidence 必须为 failed，Run 仍为 `executing` 或按失败预算进入 `blocked`。

每条 case 还绑定 acceptance Attempt、test Deployment/Evidence、OIDC attestation、workflow/subject/audience、Environment URL、signed `workflow_run` webhook 与 API compensation observation，以及单 Attempt/Acceptance/dispatch outbox/Evidence 计数。manifest 不能保存 Task/PRD/日志正文、Action output、raw webhook/REST、OIDC/JWT、token 或数据库行。

## 显式 opt-in

```bash
DELIVERY_LOOP_TEST_ACCEPTANCE_E2E=1 \
TEST_ACCEPTANCE_EVIDENCE_FILE=/private/test-acceptance.json \
TEST_ACCEPTANCE_CONTROL_PLANE_URL=https://control.example \
TEST_ACCEPTANCE_CONTROL_PLANE_TOKEN="$CONTROL_PLANE_READ_TOKEN" \
TEST_ACCEPTANCE_GITHUB_TOKEN="$GITHUB_ACTIONS_READ_TOKEN" \
pnpm run e2e:test-acceptance
```

退出码沿用 Watt `476e3cdd2490d725fde174e7c697ebf00899edc6` 的显式门禁：`0` 表示 Case 8、Actions API 和独立 Evidence 全部一致；`1` 表示 manifest、Run/Plan/Attempt、Action、Runner result、observation、URL 或 zero-duplicate 事实漂移；`2` 表示未 opt-in、配置缺失或 manifest 不可读，且不会访问网络。

verifier 只读 `GET /v1/runs/:runId/audit`，复用 `GitHubActionsApiClient.getAcceptanceWorkflowRun()` 的 `workflow_dispatch` parser，并使用独立 Actions read token。请求和响应有界读取，拒绝分页；错误不会传播上游正文或 token。真实 acceptance 运行、失败 Run 状态和 webhook 丢失后的 API 补偿仍需在真实 test Environment 中人工核对并把安全链接写入 `PROGRESS.md`。
