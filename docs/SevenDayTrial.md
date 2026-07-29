# 连续七天试运行验收

本页定义Phase 6最后一项的真实外部证据流程。默认`pnpm run verify`不会访问网络；`pnpm run e2e:seven-day-trial`没有显式opt-in时固定exit 2。任何本地fake、重复执行10080次循环、修改时间或Wrangler dry-run都不能替代连续七个自然日的已部署运行。

## 1. 当前 readiness 与阻塞事实

截至2026-07-29，资源bootstrap已经不再是阻塞项：

- `origin`绑定真实试点仓库`evilstar9527/delivery-loop`；
- `wrangler.jsonc`绑定真实D1、四个私有R2 bucket、六个Queue、两个Workflow和每分钟Cron，控制面已有production deployment/version证据；
- 这些事实只证明资源存在，不证明live observability、保留期、detector或七天窗口有效。仓库期望配置不能替代Cloudflare/日志平台live facts。

当前真正缺失的是：

- production D1安全聚合仍为Task 0/Run 0，没有满足“至少一个真实Run”的非空试运行；
- 没有冻结started/ended时间的10080分钟窗口、完整minute buckets或digest-bound observability report；
- 没有用途隔离的operations/GitHub/observability只读token，也没有metrics/log/Secret alert永久查询链接和人工Reviewer记录；
- 当前production Worker仍是早于仓库Sol/high配置的version，任何后续deployment与试运行开始都须独立授权和重新冻结deployment identity，不能静默沿用仓库期望值。

因此父DoD保持未勾。完成live readiness review后才可开始真实窗口并等待完整七天；不能把资源bootstrap、仓库配置、示例manifest或本地循环当成试运行报告。

## 2. 三个独立事实源

验收器要求三类只读来源同时一致，任何一个缺失都失败：

1. **Observability report**：部署日志/指标平台提供带digest的strict JSON，列出窗口内全部Run ID、10080个分钟bucket、stuck detector与runtime Secret detector状态、已检测/已解决incident、未知或未解决stuck Run、Secret alert ID。至少一个Run，避免空环境“零告警”假绿。
2. **控制面Case 8报告**：对observability列出的每个Run调用operations-only `GET /v1/runs/:runId/audit`，确认Run创建时间落在窗口内、repository一致，并取得全部verified PR publication与GitHub-backed test/production deployment identity。每次读取本身会进入access ledger。
3. **GitHub完整inventory**：用只读token列出专用试点仓库窗口内由固定GitHub App actor创建的全部PR，以及payload带`delivery_deployment_id`或`delivery_production_deployment_id`的全部Deployment。若结果需要第二页，验证器fail closed，不能只检查前100条；试点规模超过上限时先升级分页契约。

控制面D1唯一约束不是外部“无重复”的充分证据。验收器会将GitHub完整inventory与每个Case 8报告逐项比对；同一head branch出现两个PR、同一control-plane deployment ID出现两个GitHub Deployment、外部多/少任一事实都会失败。

## 3. 窗口和metrics报告契约

窗口必须是分钟对齐、恰好`7 × 24 × 60 × 60`秒。Observability report从[示例](../schemas/seven-day-trial-observability-v1.example.json)派生，但示例不是证据：

- `service`固定`delivery-loop-control-plane`，trial/repository/window与manifest完全相同；
- `detectors.stuckRun/runtimeSecret`在整个窗口均为`active`；
- `minuteBuckets`固定`expected=10080, observed=10080, missing=0`；
- `runIds`是日志/metrics平台窗口内全部Run的去重集合，1～100条；
- `detectedStuckIncidentIds`可以非空，但必须全部出现在`resolvedStuckIncidentIds`；
- `unresolvedKnownStuckRunIds`、`unknownStuckRunIds`、`runtimeSecretAlertIds`必须为空；
- `generatedAt`不得早于窗口结束；`reportDigest`是删除自身`reportDigest`字段后对整个canonical JSON计算的SHA-256。

`metricsDashboardUrl/logQueryUrl/secretAlertQueryUrl`必须是无userinfo/query/fragment的HTTPS永久链接，并由人工确认覆盖完整窗口、正确service/repository与告警规则。验证器核对API事实和digest，但不会把链接存在等价为人工已经review内容。

## 4. 外部前置和最小权限

开始窗口前由资源owner确认并记录：

1. 专用GitHub试点仓库、固定App actor、branch protection和Actions预算；该actor在窗口内不执行delivery-loop以外的PR操作。
2. 已部署Worker HTTPS origin、真实D1/R2/Queue/Workflow bindings、Cron和至少7天日志/metrics保留。
3. operations只读审计token、GitHub `pull_requests:read + deployments:read`短期token、observability report只读token。token不进入manifest、argv、日志或PROGRESS。
4. stuck detector和runtime Secret detector在窗口开始前完成无扰canary；告警规则digest与查询链接冻结。
5. 试运行至少产生一个真实Run，并允许正常检测且解决known stuck incident；不得通过关闭检测器取得“零告警”。

## 5. Evidence manifest与opt-in命令

复制[trial manifest示例](../schemas/seven-day-trial-evidence-v1.example.json)到仓库外私有路径并替换全部值。manifest只保存ID、时间、digest和安全链接；observability token、operations token、GitHub token、日志正文、Secret值、PR正文或raw API response都不得写入。

在受控CI Environment或临时Secret注入环境设置：

```text
DELIVERY_LOOP_SEVEN_DAY_TRIAL_E2E=1
SEVEN_DAY_TRIAL_EVIDENCE_FILE=<仓库外manifest绝对路径>
SEVEN_DAY_TRIAL_CONTROL_PLANE_URL=<已部署控制面HTTPS origin>
SEVEN_DAY_TRIAL_OBSERVABILITY_URL=<受控配置的exact metrics report HTTPS URL>
SEVEN_DAY_TRIAL_OPERATIONS_TOKEN=<operations只读短期token>
SEVEN_DAY_TRIAL_GITHUB_TOKEN=<试点仓库PR/Deployment只读短期token>
SEVEN_DAY_TRIAL_OBSERVABILITY_TOKEN=<metrics report只读短期token>
SEVEN_DAY_TRIAL_GITHUB_API_URL=<可选；默认https://api.github.com>
```

运行：

```bash
pnpm run e2e:seven-day-trial
```

退出码直接沿用现有Watt-derived Pilot verifier纪律：

- `0`：三类live facts交叉核对通过；stdout只有固定计数、时间、digest和零异常结果；
- `1`：manifest/report非法、metrics缺bucket、detector inactive、stuck/Secret alert非零、Case 8漂移、GitHub inventory不完整或重复/缺失外部effect；
- `2`：未显式opt-in、缺配置或manifest不可读取，且零网络请求。

错误只输出固定code，不输出token、upstream response或manifest正文。

## 6. 最终勾选判据

只有以下证据一起进入`PROGRESS.md`才可勾父DoD：

- 真实started/ended时间相差恰好七天，observability report digest与三个永久查询链接；
- 命令`pnpm run e2e:seven-day-trial` exit 0的安全summary；
- 人工review metrics/log/Secret alert链接，证明查询scope、告警规则和10080分钟覆盖真实有效；
- GitHub完整inventory及每个Run的Case 8 report已被验证器核对；
- `unknownStuckRunCount=0`、`duplicatePullRequestCount=0`、`duplicateDeploymentCount=0`、`runtimeSecretAlertCount=0`；known stuck若出现必须全部resolved；
- 记录试点repo、Worker deployment、日志/metrics平台、证据时间和Reviewer，但不复制Secret/raw日志/数据库行。

验证器exit 0仍不能自动证明人工链接review、平台数据驻留或真实时间没有被外部系统伪造；这些是最终外部证据的一部分。
