# GitHub App installation-token transport 诊断外部证据验收

## 目标与完成边界

本验收只回答一个窄问题：某次已经结束且只尝试一次的 GitHub base readiness 为什么进入
`credential_transport_unavailable`。它把同一个 GitHub Actions readiness job、当时生效的 Cloudflare
Worker deployment、唯一安全结构化诊断日志和覆盖该日志的 Worker trace 绑定起来，得到五类 allowlist
`failureKind`之一：`request_timed_out|dns_failed|tcp_failed|tls_failed|request_failed`。

这不是新的业务状态真源，也不执行恢复。`GitHubAppTransportDiagnosticEvidenceManifestV1`只是仓库外的
不可信 expected 索引；schema example、fake API、本地测试、默认 exit 2、公开503 reason或单张日志截图
都不能证明 production failureKind。即使 live verifier exit 0，也只关门该次失败的诊断事实，不代表
readiness 200、GitHub credential已修复、Task/Action/hibernate成功，更不授权重发readiness、修改
Secret/installation/private key、发布Worker、repair/restart/recreate Workflow、rollback或创建Task。

## 独立 authority 与数据源

每次 live 运行前，owner 必须另行批准一个绑定 exact repository、GitHub run/head/job window、Cloudflare
deployment/version和固定只读请求上界的 observability authority。此前的Worker发布、Environment approval、
readiness GET或Cloudflare deployment-read authority都不会自动扩张为这次读取。

verifier 按固定顺序交叉核对四类事实：

1. GitHub run必须来自`.github/workflows/github-base-readiness.yml`、`main`、repository owner、
   `workflow_dispatch + run_attempt=1`，并以failure结束；唯一`preflight` job成功、唯一`readiness` job失败。
2. readiness job log经GitHub API的一次安全HTTPS signed redirect有界读取，只能出现一条strict public
   summary：`503 + ready=false + credential_transport_unavailable + requestAttempts=1 + no-store`。
3. Cloudflare deployment inventory必须证明manifest中的100% version是job开始前最后生效的deployment，
   且闭区间`[readinessStartedAt, readinessCompletedAt]`内没有新deployment。
4. Cloudflare官方telemetry query分别执行一次`events`和一次`traces`查询；二者固定`dry=true`、
   独立`queryId`，并把job窗口仅在内存中转为Unix毫秒`timeframe.from/to`；row `limit=2`位于顶层，
   filters/groupBys/calculations才位于`parameters`。event按service/trace/event/component/operation/requestAttempts精确过滤，必须
   恰好返回一条未截断strict diagnostic；trace必须是同一service/trace，覆盖日志时间、至少一个span且
   没有error。

GitHub run/job、deployment、log和trace任一单源都不能替代其余来源；manifest中的failureKind、digest、
review URL或reviewer字段也不能覆盖live response。

## 无 trace ID 的一次性发现

formal verifier需要manifest先给出trace ID，但临时脚本或复制raw Logs响应会破坏有界、Secret-safe和可重跑
纪律。仓库因此提供一个窄的events discovery入口。仓库外collection request参考
[`github-app-transport-diagnostic-collection-v1.example.json`](../schemas/github-app-transport-diagnostic-collection-v1.example.json)，
只绑定repository、run/head/job、exact window及deployment/version；它是不可信expected索引，不是owner
authority，也不能授权任何API请求。

```text
DELIVERY_LOOP_GITHUB_APP_TRANSPORT_DIAGNOSTIC_COLLECTION=1
GITHUB_APP_TRANSPORT_DIAGNOSTIC_COLLECTION_REQUEST_FILE=/absolute/path/outside-repository/collection.json
GITHUB_APP_TRANSPORT_DIAGNOSTIC_GITHUB_READ_TOKEN=<single-repository-read-token>
GITHUB_APP_TRANSPORT_DIAGNOSTIC_CLOUDFLARE_DEPLOYMENT_READ_TOKEN=<deployment-read-token>
GITHUB_APP_TRANSPORT_DIAGNOSTIC_CLOUDFLARE_OBSERVABILITY_TOKEN=<telemetry-query-token>
GITHUB_APP_TRANSPORT_DIAGNOSTIC_CLOUDFLARE_ACCOUNT_ID=<account-id>
GITHUB_APP_TRANSPORT_DIAGNOSTIC_CANARY_SECRET=<synthetic-credential-shaped-canary>
GITHUB_APP_TRANSPORT_DIAGNOSTIC_CLOUDFLARE_API_URL=<可选；默认https://api.cloudflare.com>
```

运行：

```bash
pnpm run e2e:github-app-transport-diagnostic-collect
```

collector最多发送一次Cloudflare `events` query，不带trace ID filter，但仍固定service、event、component、
operation和`requestAttempts=1`，`queryId`=受验collection ID，exact window仅在内存中转为Unix毫秒，
顶层`limit=2`，并要求`dry=true`、唯一未截断strict log。三枚token
必须原文互异并全部进入response Secret scan；只有observability token进入该请求的Authorization header，
另外两枚不发送。默认未opt-in、配置不齐或request不可读为exit 2且零网络；403、timeout或任何失败都不
重试。

exit 0只输出可安全转入formal manifest的collection/run/head/attempt/job/deployment/version、`observedAt`、trace ID、
allowlist failureKind和canonical log digest，以及`cloudflareLogQueries=1`、`plaintextLeaks=0`、
`formalVerification=still_required`。它不写manifest、不生成reviewer/reviewedAt或Dashboard review，也不查询
trace/deployment/GitHub；输出、request文件和exit 0均不能替代真人review或formal verifier。

若一个owner authority同时覆盖discovery和formal verification，请求上界必须明确包含collector的一次events，
以及formal verifier自己的GitHub run/jobs/log、Cloudflare deployment、一次events和一次traces查询；不能把
两阶段合称“一次events”。任一阶段失败都停止，不自动重跑collector或verifier。

## manifest 采集

- 在仓库外创建manifest，形状参考
  [`github-app-transport-diagnostic-evidence-v1.example.json`](../schemas/github-app-transport-diagnostic-evidence-v1.example.json)。
  示例全部是synthetic值，`example-only-not-live`不是production证据。
- 固定失败readiness job的exact开始/结束时间；Cloudflare telemetry窗口必须逐字相同且不超过10分钟。
- 经已批准的上述collector（推荐）或Cloudflare Logs人工查询取得窗口内唯一诊断的32位worker trace ID、
  `observedAt`、strict source和failureKind；对完整strict source计算canonical SHA-256。不得把raw log、trace、错误、URL
  query、JWT/key/token、GitHub App/installation ID或response body复制到manifest或账本。
- `accountId`原文只在当前进程环境中使用，manifest只保存canonical digest。创建仓库外
  credential-shaped synthetic canary，同样只把digest写入manifest。
- 记录GitHub run与Cloudflare deployment/log/trace的人工复核入口及reviewer/time。URL和manifest自报
  不能替代真人实际打开页面并核对。

三枚读取token必须用途隔离且原文互不相同：

- 单仓库GitHub Actions/Contents read；
- 指定Worker的Cloudflare deployment read；
- 指定account的Cloudflare Workers Observability query read。

它们均不得拥有GitHub repository write/Actions dispatch、Cloudflare Worker deploy/D1 write、Secret或
Environment管理权限。

## 显式 opt-in 运行

```text
DELIVERY_LOOP_GITHUB_APP_TRANSPORT_DIAGNOSTIC_E2E=1
GITHUB_APP_TRANSPORT_DIAGNOSTIC_EVIDENCE_FILE=/absolute/path/outside-repository/evidence.json
GITHUB_APP_TRANSPORT_DIAGNOSTIC_GITHUB_READ_TOKEN=<single-repository-read-token>
GITHUB_APP_TRANSPORT_DIAGNOSTIC_CLOUDFLARE_DEPLOYMENT_READ_TOKEN=<deployment-read-token>
GITHUB_APP_TRANSPORT_DIAGNOSTIC_CLOUDFLARE_OBSERVABILITY_TOKEN=<telemetry-query-token>
GITHUB_APP_TRANSPORT_DIAGNOSTIC_CLOUDFLARE_ACCOUNT_ID=<account-id>
GITHUB_APP_TRANSPORT_DIAGNOSTIC_CANARY_SECRET=<synthetic-credential-shaped-canary>
GITHUB_APP_TRANSPORT_DIAGNOSTIC_GITHUB_API_URL=<可选；默认https://api.github.com>
GITHUB_APP_TRANSPORT_DIAGNOSTIC_CLOUDFLARE_API_URL=<可选；默认https://api.cloudflare.com>
```

运行：

```bash
pnpm run e2e:github-app-transport-diagnostic
```

- exit 0：GitHub run/jobs/log、当时deployment、唯一diagnostic与唯一trace全部一致；只输出安全ID、
  failureKind、固定查询计数、`requestAttempts=1`与`plaintextLeaks=0`。仍须把独立人工review一并入账。
- exit 1：manifest、外部事实、window/deployment、log/trace、大小边界或Secret scan任一失败。
- exit 2：未显式opt-in、配置不完整或manifest不可读；在配置完整前不访问网络。

manifest最大64 KiB；每个HTTP/log/telemetry响应最大1 MiB、10秒timeout、拒绝普通redirect/分页，响应在
JSON parse前扫描全部三枚token、canary和credential形状。GitHub signed log redirect只允许HTTPS且不携
GitHub Authorization。所有请求无自动retry，错误仅输出固定code；raw manifest、response、log、trace、
error、token、account ID和带query URL都不进入stdout/stderr、artifact、PR或`PROGRESS.md`。

## 失败处置

`failureKind`只用于生成下一条人工决策输入。要修改credential、installation、Secret、网络出口或Worker，
必须先取得与诊断证据分离的新authority并冻结exact变更；修复后如需再次readiness，还必须新建一次
`run_attempt=1`的受保护workflow run和独立Environment approval。不得rerun原job，也不得为了“验证修复”
跳过Task/Action/after的既有guard。
