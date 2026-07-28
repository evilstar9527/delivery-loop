# Runner heartbeat 与 GitHub 最终状态真实验收

本验收只回答一个问题：同一个真实只读 analysis Action 是否以30～60秒间隔持续heartbeat，正常写入reference-only Attempt result，并最终让控制面D1投影、signed GitHub webhook和GitHub Actions API对同一run的`status/conclusion/updated_at`达成一致。

它不会创建Task、触发Action、补写heartbeat、重放webhook或修改控制面。所有事实必须先由正常产品链路产生；schema example、fake API、本地workerd测试、Wrangler dry-run和默认exit 2都不是外部完成证据。

## 1. 为什么需要 receipt ledger

`attempts.heartbeat_at`只有最新值，无法证明Runner曾按30～60秒cadence连续续租。每次heartbeat成功CAS后，控制面必须在同一D1 batch向`attempt_heartbeat_receipts`追加一条不可修改的安全receipt：

```text
id
attemptId
leaseGeneration
previousVersion
version
previousHeartbeatAt
heartbeatAt
leaseExpiresAt
```

receipt不保存`attemptToken`、`toolBridgeToken`或任何token digest。`version = previousVersion + 1`，相邻receipt的`previousHeartbeatAt`必须等于上一条`heartbeatAt`，每段间隔必须为30000～60000ms，`leaseExpiresAt - heartbeatAt`必须恰好90000ms。真实关门至少需要两条receipt；最终Attempt version还要等于末条receipt version + 1，证明随后只发生了一次result complete CAS。

## 2. 事实来源

`RunnerHeartbeatEvidenceManifestV1`嵌入一份已准备好的`AnalysisActionEvidenceManifestV1`，并只追加安全计数、digest、版本和时间。`pnpm run e2e:runner-heartbeat`每次重新读取以下authority：

1. 完整复用[只读 Analysis Action 真实验收](AnalysisActionE2E.md)，重新核对单仓库GitHub App、固定workflow、唯一Action/job、反馈/PRD与Plan、只读context、受审Runner/Codex以及最终Git状态；这里的live Actions API是最终GitHub事实来源；
2. `GET /v1/runs/:runId/plan`读取D1安全投影中的Attempt、heartbeat receipts和result。verifier不相信manifest自报次数，而是从live receipt数组重算连续版本、全部间隔、90秒lease和`canonicalSha256(receipts)`；
3. 同一Plan投影中的Attempt必须为`analysis/completed`，result必须是sequence 1、`d1://execution-plans/<activePlanId>`与active Plan digest，并在末次heartbeat后上报；
4. Attempt的GitHub投影必须绑定同一Action run，状态为`completed/success`、external updated time等于Actions API的`updated_at`，且observation version大于0；
5. operations-only Case 8的`answers.checks.githubRunObservations`必须存在manifest指定的唯一`webhook/applied` final delivery，绑定同一repository/run/attempt/external time，`ignoreReason=null`。该ledger只能由已通过HMAC与全绑定projector的webhook路径产生。

API reconciliation可以修复漏失webhook，但本验收刻意要求一条真实signed final webhook，同时再由live Actions API独立核对；这样D1、webhook和API三面都不能互相自证。

## 3. manifest计算

先按[只读 Analysis Action 真实验收](AnalysisActionE2E.md)准备嵌入对象。然后从live Plan查询中筛选exact analysis Attempt的receipt，保持服务端`version`顺序，按响应中的八个固定字段原样计算：

```text
receiptsDigest = canonicalSha256(receipts)
receiptCount = receipts.length
firstVersion = receipts[0].version
lastVersion = receipts[-1].version
firstHeartbeatAt = receipts[0].heartbeatAt
lastHeartbeatAt = receipts[-1].heartbeatAt
minimumIntervalMs = min(heartbeatAt - previousHeartbeatAt)
maximumIntervalMs = max(heartbeatAt - previousHeartbeatAt)
```

result只复制`eventId/sequence/digest/reportedAt`；payload ref由verifier根据active Plan ID推导，避免manifest选择其他引用。webhook observation只复制Case 8中的`sourceId/sourceDigest/externalUpdatedAt/observedAt/processedAt`。参考形状见`schemas/runner-heartbeat-evidence-v1.example.json`。

manifest不得包含Task/Plan/Item正文、Evidence ref原值、Runner输出、raw webhook/REST、数据库行、token或token digest。不要把schema example中的占位digest当作真实结果。

## 4. 准备真实事实

1. 先满足Analysis Action验收的App、试点repository、已部署控制面、Codex credential和manifest外Runner release review前置；
2. 通过正常链路提交一份不含Secret的真实反馈或PRD，并触发唯一analysis Action；
3. 让Action自然运行到至少产生两次heartbeat。不要手工插入receipt或用测试脚本伪造cadence；
4. 确认Runner正常提交Plan/result，Workflow激活该Plan，Action最终为success；
5. 确认final `workflow_run` webhook已到达并在Case 8中为`applied`。若只存在API reconciliation而没有signed final webhook，本验收应失败；
6. 在仓库外生成不超过64 KiB的manifest，并准备用途隔离的query/operations/App/installation credential及manifest外Runner contract digest。

## 5. 运行

```bash
export DELIVERY_LOOP_RUNNER_HEARTBEAT_E2E=1
export RUNNER_HEARTBEAT_EVIDENCE_FILE=/absolute/path/outside/repo/runner-heartbeat-evidence.json
export RUNNER_HEARTBEAT_CONTROL_PLANE_URL=https://delivery.example.com
export RUNNER_HEARTBEAT_CONTROL_PLANE_TOKEN='short-lived-query-token'
export RUNNER_HEARTBEAT_OPERATIONS_TOKEN='short-lived-operations-token'
export RUNNER_HEARTBEAT_APP_JWT='short-lived-app-jwt'
export RUNNER_HEARTBEAT_INSTALLATION_AUDIT_TOKEN='short-lived-un-narrowed-audit-token'
export RUNNER_HEARTBEAT_RUNNER_CONTRACT_DIGEST='sha256:reviewed-release-digest'
pnpm run e2e:runner-heartbeat
```

GitHub Enterprise测试端点可额外设置`RUNNER_HEARTBEAT_GITHUB_API_URL`，必须是无userinfo/query/fragment的HTTPS origin。credential只进入Authorization header，不进入manifest、日志或成功摘要。

退出码固定：

- `0`：嵌入的Analysis Action证据、live receipt/result、D1 GitHub projection、signed webhook和Actions API全部一致；只打印安全ID、计数、版本、时间、Plan digest和布尔结论；
- `1`：manifest、cadence、version/lease、result、D1/webhook/API绑定或有界响应不一致；
- `2`：未显式opt-in、缺配置或manifest文件不可读；在manifest解析或网络请求前结束。

## 6. DoD入账

只有exit 0后，才把命令、时间、Task/Run/Action URL、receipt count/interval范围、result event安全ID、webhook delivery ID、immutable SHA和Runner release review记录写入`PROGRESS.md`。还要人工确认Action日志/artifact不含credential或任务敏感正文。

在没有真实试点repo/App、已部署控制面、有效Codex credential和signed final webhook时，只能勾选“真实外部证据验收契约”子项；“真实 GitHub Action 连续 heartbeat”及父DoD必须保持未勾。
