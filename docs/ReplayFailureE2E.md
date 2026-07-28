# E2E-8 重放与故障真实外部证据验收

本验收证明三类事件各重放三次、GitHub callback 丢失与飞书限流后都收敛到正确状态，而且没有重复 Action、PR 或 Deployment。`pnpm run e2e:replay-failure` 是严格只读 verifier；它不会发送 webhook、请求 DLQ replay、制造 429、创建 PR/Deployment 或部署 Worker。

## 1. 为什么不是一个 Run

三个场景的 live 状态互斥，不能为了表面整齐伪装成同一个 Run：

- 飞书 lane：复用 `FeishuIngressEvidenceManifestV1` 证明同一真实 event 三次 transport delivery 只有一个 ingress/Queue identity、Task 和 Run；同一 Run 再由 `FeishuRetryEvidenceManifestV1` 证明真实 429、timeout、token-invalid 保持原 outbox，最终 refresh 卡片 settled。
- GitHub replay lane：复用 `GitHubPullRequestEvidenceManifestV1`，外部观测报告记录同一个 signed `pull_request opened` delivery 的 `applied, duplicate, duplicate` 三次 202；D1 仍只有一条 webhook fact和一条 verified publication。该 Run 验收时处于 `pull_request_open`。
- 故障恢复 lane：复用 `ControlledReplayEvidenceManifestV1` 的 succeeded Run、effect snapshot和完整 GitHub inventory。该 Run 的 PR callback 被受控丢弃，Case 8 必须只有一条 `api` observation、零 webhook observation；Cron/API reconciliation 推进同一 publication。选择 snapshot 中一个 `*_dispatch → github_actions` outbox 进入 DLQ，对 exact dead letter 连续请求 replay 三次，外部报告必须得到同一 replay ID和 `created=true,false,false`，最终 resolved dead letter仍绑定原outbox。

总 manifest 由 canonical digest 绑定四份既有 component manifest；飞书 ingress/retry 共用一个 Run，GitHub replay 和 controlled recovery 各用不同 Run，因此总计三个不同 Run。组合层不接受调用方替换 component verifier，也不新增状态表、GitHub parser 或第二套业务状态机。

## 2. 受控故障步骤

1. 在测试飞书 tenant 按[飞书 ingress 验收](FeishuIngressE2E.md)取得同 event 三次真实重投，再按[飞书卡片 retry 验收](FeishuRetryE2E.md)制造真实 429。timeout/token-invalid 是现有 component 的必需附加事实，不能只填 manifest。
2. 在试点 repository 的一份独立 Draft PR 上，让同一个 signed `pull_request opened` delivery完整到达控制面三次。独立 observability endpoint只保存request ID、delivery ID、payload digest、固定 disposition/status和时间，不保存payload、signature、PR正文或header。
3. 对 succeeded controlled-replay Run 的另一份 PR，受控代理丢弃 callback，等待至少两个Cron周期。Case 8必须只出现 API observation，且 live GitHub PR、publication、Evidence和Run终态完全匹配。若 webhook 后来补到，该case不再满足“callback丢失”，必须重新演练。
4. 选择该Run effect snapshot内一个已经存在的GitHub dispatch outbox，让真实Queue达到DLQ。使用operations list返回的exact dead-letter ID和attempt count，对现有`POST /v1/dead-letters/:id/replay`发送相同请求三次；不得提交destination、kind或payload。等待原outbox settled及dead letter resolved。
5. 重新运行 controlled replay component verifier。GitHub完整 inventory必须仍为每个Attempt一个Action、每个head一个PR、每个stable deployment ID一个Deployment；额外对象或分页不完整都失败。

## 3. 仓库外输入

主文件形状见[`replay-failure-e2e-evidence-v1.example.json`](../schemas/replay-failure-e2e-evidence-v1.example.json)，transport报告见[`replay-failure-observability-v1.example.json`](../schemas/replay-failure-observability-v1.example.json)。另提供四份完整component manifest：Feishu ingress、Feishu retry、GitHub PR和controlled replay。每份文件最大64 KiB，全部保存在仓库外。

transport报告只证明三次HTTP请求，业务真源仍由live D1/GitHub/Cloudflare/飞书交叉核对。主manifest只保存ID、SHA/digest、枚举、计数和时间；不得保存token、signature、raw webhook/Queue message、请求或响应正文、PR/Task/卡片正文、数据库行或日志。

## 4. 运行

```bash
export DELIVERY_LOOP_REPLAY_FAILURE_E2E=1
export REPLAY_FAILURE_EVIDENCE_FILE=/secure/outside-repo/replay-failure-e2e.json
export REPLAY_FAILURE_FEISHU_INGRESS_FILE=/secure/outside-repo/feishu-ingress.json
export REPLAY_FAILURE_FEISHU_RETRY_FILE=/secure/outside-repo/feishu-retry.json
export REPLAY_FAILURE_GITHUB_PULL_REQUEST_FILE=/secure/outside-repo/github-pr.json
export REPLAY_FAILURE_CONTROLLED_REPLAY_FILE=/secure/outside-repo/controlled-replay.json
export REPLAY_FAILURE_CONTROL_PLANE_URL=https://control.example.com
export REPLAY_FAILURE_OPERATIONS_TOKEN='<short-lived-operations-read-token>'
export REPLAY_FAILURE_QUERY_TOKEN='<short-lived-correlation-read-token>'
export REPLAY_FAILURE_GITHUB_TOKEN='<short-lived-actions-pr-deployments-read-token>'
export REPLAY_FAILURE_FEISHU_ACCESS_TOKEN='<short-lived-message-read-token>'
export REPLAY_FAILURE_FEISHU_INGRESS_OBSERVABILITY_REPORT_URL=https://observability.example.com/feishu/ingress
export REPLAY_FAILURE_FEISHU_INGRESS_OBSERVABILITY_TOKEN='<short-lived-ingress-report-token>'
export REPLAY_FAILURE_OBSERVABILITY_REPORT_URL=https://observability.example.com/replay-failure/report
export REPLAY_FAILURE_OBSERVABILITY_TOKEN='<short-lived-replay-report-token>'
export REPLAY_FAILURE_CLOUDFLARE_ACCOUNT_ID='<account-id>'
export REPLAY_FAILURE_CLOUDFLARE_TOKEN='<workflows-read-token>'
export REPLAY_FAILURE_SECURITY_CANARY='<credential-shaped synthetic canary>'
pnpm run e2e:replay-failure
```

可选origin为`REPLAY_FAILURE_GITHUB_API_URL`、`REPLAY_FAILURE_FEISHU_API_URL`和`REPLAY_FAILURE_CLOUDFLARE_API_URL`。所有URL必须是无userinfo/query/fragment的HTTPS边界；请求10秒timeout，外部响应有界并在JSON parse前扫描全部token和canary，分页一律fail-closed。

- exit 0：四份component live verifier、三次transport report、API-only callback recovery、resolved DLQ及GitHub唯一inventory全部匹配。
- exit 1：schema、digest、lineage、状态、inventory、Secret scan或任一live事实不匹配。
- exit 2：未显式opt-in、配置不完整或仓库外文件不可读取。

默认exit 2、schema example、fake API、本地workerd测试、structured log自报或Wrangler dry-run都不能关闭真实E2E-8。真实通过后还需Reviewer打开飞书重投/429、GitHub delivery/PR、Cloudflare Queue/DLQ/Workflow和Deployment永久链接，把时间窗、summary、report digest及reviewer写入`PROGRESS.md`。
