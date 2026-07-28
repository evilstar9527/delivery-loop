# E2E-7 合并、部署与飞书完成态验收

本文件定义 E2E-7 的只读、可重跑验收。命令不创建 PR、不执行 merge、不批准 effect、不触发部署，也不更新飞书消息；它只核对控制面、GitHub 与飞书中已经发生的事实。

## 为什么是两个 Run

Task 的 `target_environment` 是 `test | production | none` 单选，不能让一个 Run 同时持有 test 与 production deployment authority。test deployment 和 post-deployment acceptance 是 merge 前的 required Plan Item；只有它们已经通过，PR 才能进入 required checks、真人 review 与 merge。production deployment 则必须在 merge SHA 存在后，经独立 production approval 才能启动。

E2E-7 因此固定使用同一 repository、同一受审时间窗内的两个不同 Run：

1. test lane：test deployment 外部 success → post-deployment acceptance passed → required checks 全绿 + 真人 review/merge approval → GitHub merge → Run `succeeded` → 飞书完成卡片；
2. production lane：required checks 全绿 + 真人 review/merge approval → GitHub merge → production release approval → production deployment 外部 success → Run `succeeded` → 飞书完成卡片。

把两个 lane 强行拼成一个 Run、把 test merge 留在没有终态 projector 的 `deploying`，或用 production 结果覆盖 test 结果都属于验收失败。

## Authority 组合

总 manifest 为 [`MergeDeploymentE2EEvidenceManifestV1`](../schemas/merge-deployment-e2e-evidence-v1.example.json)，只保存八份完整 component manifest 的 canonical digest、evidence/case ID、同一 repository、受审窗口和 canary digest：

- test 与 production 各一份 `MergeGateEvidenceManifestV1`，分别证明 required checks、真人 review、最新 base 和 exact merge approval；
- 一份 `MergeEvidenceManifestV1`，选择 `merged_test` 和 `merged_production`；
- `TestDeploymentEvidenceManifestV1` 与 `TestAcceptanceEvidenceManifestV1` 的成功 case；
- `ProductionApprovalEvidenceManifestV1` 与 `ProductionDeploymentEvidenceManifestV1` 的 accepted/success case；
- [`FeishuCardCompletionEvidenceManifestV1`](../schemas/feishu-card-completion-evidence-v1.example.json) 的 test/production 两张最终卡片。

组合 verifier 无条件调用八份生产 verifier，不接受 component verifier、summary 或 pass/fail 注入。它交叉绑定 exact Run、repository、PR number/head/base、merge decision/ID/SHA、Plan version/digest、test deployment/acceptance、production approval/deployment、环境 URL 与时间线。component digest 相同也不能覆盖这些 lineage 检查。

最终飞书 verifier 复用现有 presentation operations endpoint、1 MiB/10 秒有界 GET、Secret scan、同 message create/PATCH ledger 与 `renderFeishuDeliveryCard`。每张完成卡必须是 latest settled presentation，live Message GET 的 app/tenant/chat/message/time/rendered digest 必须一致，并同时满足：

- `runState=succeeded`，全部 required/total Item passed，active blocker 为空；
- PR 为 `open`、merge 为 `merged`；对应 lane 的 deployment 为 `succeeded`，另一个环境为 `not_started`；
- 已批准 effect 与卡片 action 都为空；
- first delivery 为 create，最终 delivery 为同 message PATCH，lineage 为正常 source change且没有待过期刷新；
- live card 只含完成态 div 段落，没有 button/input/action，也没有 token/canary 明文。

scope、机器人群 membership、Environment required reviewer、云 OIDC trust、部署后的真实业务语义与截图仍是人工 authority，schema 或卡片文本不能替代。

## 命令

九份 JSON 文件必须位于仓库外且每份不超过 64 KiB：

```bash
DELIVERY_LOOP_MERGE_DEPLOYMENT_E2E=1 \
MERGE_DEPLOYMENT_EVIDENCE_FILE=/secure/e2e-7/manifest.json \
MERGE_DEPLOYMENT_TEST_GATE_FILE=/secure/e2e-7/test-gate.json \
MERGE_DEPLOYMENT_PRODUCTION_GATE_FILE=/secure/e2e-7/production-gate.json \
MERGE_DEPLOYMENT_MERGE_FILE=/secure/e2e-7/merge.json \
MERGE_DEPLOYMENT_TEST_DEPLOYMENT_FILE=/secure/e2e-7/test-deployment.json \
MERGE_DEPLOYMENT_TEST_ACCEPTANCE_FILE=/secure/e2e-7/test-acceptance.json \
MERGE_DEPLOYMENT_PRODUCTION_APPROVAL_FILE=/secure/e2e-7/production-approval.json \
MERGE_DEPLOYMENT_PRODUCTION_DEPLOYMENT_FILE=/secure/e2e-7/production-deployment.json \
MERGE_DEPLOYMENT_FEISHU_COMPLETION_FILE=/secure/e2e-7/feishu-completion.json \
MERGE_DEPLOYMENT_CONTROL_PLANE_URL=https://control.example \
MERGE_DEPLOYMENT_OPERATIONS_TOKEN="$OPERATIONS_READ_TOKEN" \
MERGE_DEPLOYMENT_GITHUB_TOKEN="$GITHUB_READ_TOKEN" \
MERGE_DEPLOYMENT_FEISHU_ACCESS_TOKEN="$FEISHU_READ_TOKEN" \
MERGE_DEPLOYMENT_SECURITY_CANARY="$SYNTHETIC_CANARY" \
pnpm run e2e:merge-deployment
```

可选 `MERGE_DEPLOYMENT_GITHUB_API_URL` 与 `MERGE_DEPLOYMENT_FEISHU_API_URL` 只接受无 userinfo/query/fragment 的 HTTPS origin。退出码沿用 Watt 固定 commit `476e3cdd2490d725fde174e7c697ebf00899edc6`：

- `0`：八份 live authority、双 lane lineage 与两张飞书完成卡全部通过；
- `1`：schema、digest、identity、状态、外部事实、卡片或 Secret 断言失败；
- `2`：未显式 opt-in、文件不可读或配置缺失，验证尚未开始。

所有外部响应有界、10 秒超时、分页 fail-closed，并在 component JSON 解析前扫描三枚用途隔离 token、synthetic canary 和 credential 形状。固定错误不返回 upstream body、manifest、token 或卡片正文。

## 真实试点步骤

1. 在同一受保护试点 repository 准备一个 test Task 与一个 production Task，分别形成不同 Run；记录 Task/Plan/PR/Action/Environment 安全链接。
2. test Run 先完成真实 test Deployment、OIDC 与 acceptance Action；required Item 全部通过后，由真人 review 并 merge。确认 merge 后 Run 直接从 `merging` 收敛到 `succeeded`，没有第二次 test deployment。
3. production Run 在 required checks 与真人 review 后 merge；由与作者分离的真人批准 exact revision + Plan + merge SHA + production environment，再让受 GitHub Environment 保护的 job 部署。用 webhook/API 双源核对真实 production success。
4. 等待两个 Run 的最终 presentation settled。真人打开两条飞书消息与截图，核对 repository、PR、merge、对应环境 URL、完成状态和无动作按钮。
5. 从仓库外采集九份 manifest，运行总命令。只有 live exit 0 且 Reviewer 把 GitHub、Cloudflare/控制面、飞书、Environment/OIDC/云审计永久链接与安全 summary 写入 `PROGRESS.md`，E2E-7 真实平台事实才通过。

fake HTTPS、module mock、schema example、manifest 自报、默认 exit 2、本地测试、Wrangler dry-run或截图单方证据均不能替代真实平台事实。
