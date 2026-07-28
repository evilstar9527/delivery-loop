# Monitor adapter 真实外部证据验收

## 目标与完成边界

本验收只回答生产是否启用 monitor adapter，以及启用时真实 Sentry webhook 是否只形成
metadata-only triage candidate、按服务端指纹抑制且始终没有 Task/Run/approval/outbox authority。
它不授权部署、发送真实告警或仓库写入，也不把 manifest、schema example、fake HTTP、workerd
或 Wrangler dry-run 当成生产事实。

生产必须二选一：

1. `enabled`：真实 Sentry project/rule、独立 observer、已部署控制面和 Cloudflare settings
   共同提供证据。
2. `disabled`：owner 明确记录 `not_enabled`，并由 Cloudflare API 证明生产 Worker 的四个
   monitor binding 全部不存在。只写 N/A 或只看仓库配置不成立。

Sentry 原生边界固定为官方 integration webhook 的 `Sentry-Hook-Signature`：client secret 对
exact request body 做 HMAC-SHA256。来源：
[Sentry Integration Platform Webhooks](https://docs.sentry.io/organization/integrations/integration-platform/webhooks/)。
observer 验证原生签名后，把允许字段规范化并用控制面 generic monitor Secret 重新签名；
Sentry payload 和 header 不是控制面 authority。

## 共同准备

- 在仓库外创建 strict manifest，参考
  [`monitor-alert-evidence-enabled-v1.example.json`](../schemas/monitor-alert-evidence-enabled-v1.example.json)
  或
  [`monitor-alert-evidence-disabled-v1.example.json`](../schemas/monitor-alert-evidence-disabled-v1.example.json)。
- 创建一枚仓库外 credential-shaped synthetic canary，只保存其 canonical SHA-256 到 manifest。
- 准备用途隔离、只读的 Cloudflare Worker settings token。manifest 不得含 token、webhook
  client secret、generic monitor Secret、raw webhook body、告警正文或 R2 ref。
- owner decision、Cloudflare dashboard URL和 reviewer/time 是人工治理证据；verifier 不会根据
  manifest 自报推断 owner 身份或 Cloudflare 权限范围。

共同环境变量：

```text
DELIVERY_LOOP_MONITOR_ALERT_E2E=1
MONITOR_ALERT_EVIDENCE_FILE=/absolute/path/outside-repository/monitor-alert-evidence.json
MONITOR_ALERT_CLOUDFLARE_API_URL=https://api.cloudflare.com/client/v4/accounts/<account>/workers/services/<service>/environments/production/settings
MONITOR_ALERT_CLOUDFLARE_API_TOKEN=<read-only settings token>
MONITOR_ALERT_CANARY_SECRET=<synthetic credential-shaped canary>
```

CLI 默认不运行；没有 opt-in 或前置配置不完整返回 exit 2。manifest 超过 64 KiB、事实不一致、
响应超过 1 MiB、分页、非 HTTPS、响应泄漏任一 token/canary/credential 或外部 API 失败返回 exit 1。

## enabled 路径

### 受控事件矩阵

在一个专用 Sentry test project/rule 中完成八次 observer 观测：

| scenario | 预期 |
|---|---|
| `primary` | 新建 candidate，ordinal 1 |
| `retry` | exact 同一原生请求重投，收敛到相同 receipt/lineage/candidate |
| `suppressed_second` | 不同 event、相同服务端 fingerprint，candidate ordinal 2 |
| `suppressed_third` | 第三个不同 event，candidate ordinal 3 |
| `after_window` | 超过首个 received time + 固定窗口，新建第二 candidate |
| `invalid_native_signature` | observer 401，不转发，控制面零 receipt/effect |
| `repository_denied` | 原生验签成功，控制面 allowlist 403，零 receipt/effect |
| `authority_injection_denied` | 原生验签成功，strict generic body 400，零 receipt/effect |

observer report 参考
[`monitor-alert-observability-v1.example.json`](../schemas/monitor-alert-observability-v1.example.json)。
它只保存安全 event ID、request/response digest、状态、固定结果、receipt/lineage/candidate ID和时间；
不保存 raw body/header/Secret/告警正文。report digest 是移除 `reportDigest` 后的 canonical SHA-256。

额外环境变量：

```text
MONITOR_ALERT_CONTROL_PLANE_URL=https://<deployed-control-plane>
MONITOR_ALERT_OPERATIONS_TOKEN=<operations read token>
MONITOR_ALERT_OBSERVABILITY_URL=https://<observer>/monitor-alert/<evidence-id>
MONITOR_ALERT_OBSERVABILITY_TOKEN=<observer read token>
MONITOR_ALERT_SENTRY_API_URL=https://sentry.io
MONITOR_ALERT_SENTRY_READ_TOKEN=<project/rule read token>
```

运行：

```bash
pnpm run e2e:monitor-alert
```

exit 0 必须同时证明：

- Cloudflare production settings 中四个 binding 恰好存在，Secret 类型为 `secret_text`；tenant、
  sorted repository allowlist JSON 和 suppression seconds 与 manifest profile exact 相等。
- observer 的 primary/retry exact digest 和业务 ID 收敛；三个窗口内不同 event 聚合到一份
  candidate，过窗 event 属于第二 candidate。
- operations-only exact-event endpoint 对四个 accepted event 返回一份 receipt/lineage/candidate，
  服务端从隐藏 R2 ref 有界回读 snapshot并重算通过；前一 candidate 最终 occurrence/lineage 为3，
  后一 candidate 为1。
- 三个 rejected event 都是 `found=false`，receipt/lineage/candidate 与所有 authority count 为零；
  四个 accepted event 的 Task/Run/approval/outbox count 同样为零。
- Sentry live project API 的 organization/project/project ID及 alert rule API 的 rule ID/environment
  与受审 manifest 一致；project/rule/integration dashboard 元数据仍由 human review确认。

## disabled 路径

manifest 固定 `mode=disabled`、`decision=not_enabled` 与
`review.productionConfigurationAbsent=true`。只需要共同环境变量，然后运行相同命令。

exit 0 只在 Cloudflare live settings 的 `result.bindings` 中以下四个名称全部不存在时成立：

```text
MONITOR_WEBHOOK_SECRET
MONITOR_TENANT_KEY
MONITOR_ALLOWED_REPOSITORIES
MONITOR_SUPPRESSION_WINDOW_SECONDS
```

任何一个存在、重复、响应不完整或 settings URL 未绑定 exact production service/environment 都失败。
disabled 结果不能证明 Sentry 行为，也不能用于勾选 enabled 的真实平台事实。

## 安全回滚

本 verifier 全程只读，不提供告警发送、binding 修改、部署、Task 提升或仓库 mutation 接口。
enabled 试验结束后是否删除 test rule/observer 或移除 production binding 是独立人工变更，必须按
部署审批执行，不能由本命令自动完成。
