# Cloudflare Workers Observability 最小权限 credential provisioning

## 目标与边界

本文只定义一个显式 opt-in、可重跑审计的本机操作：为目标 Cloudflare account 创建一枚短期
Account Owned API Token，权限恰好是目标 account 的 `Workers Observability Read`，验证 token 后将
secret 写入固定 macOS Keychain 槽位。它用于解除
[GitHub App transport diagnostic](GitHubAppTransportDiagnosticE2E.md) 的独立 observability-read 前置。

合并代码、schema example、单测或默认 exit 2 都不会创建真实 credential，也不等于历史 transport
diagnostic 已采集或 hibernate DoD 已完成。真实运行同时是 Cloudflare credential 写、一次 production
telemetry read 与本机 Keychain 写，必须另行取得绑定 exact account digest、token name、TTL、probe window
及固定 effect 上界的 owner authority。该 authority 不覆盖 readiness、Task、Action、Worker deploy、D1、
Secret/installation 修改、repair、restart/recreate、rotation、token delete 或 rollback。

## Cloudflare 契约事实

2026-08-02 以 Cloudflare 官方文档与 OpenAPI 核对以下事实：

- [Account API tokens](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/)
  支持 Workers Observability，新 token 使用 `cfat_` scannable format；创建 Account Owned Token 要求目标
  account 的 Super Administrator；
- 初始自动化 token 必须来自
  [Create additional tokens template](https://developers.cloudflare.com/fundamentals/api/reference/template/)，
  不能用普通 custom token 自报等价权限；
- inventory、create、permission-group discovery 与 verify 分别是
  `GET/POST /accounts/{account_id}/tokens`、
  `GET /accounts/{account_id}/tokens/permission_groups` 和
  `GET /accounts/{account_id}/tokens/verify`；
- 当前 OpenAPI 对 inventory 的 `per_page` 最大值是 50，因此实现固定
  `per_page=50&include_expired=true`；发现 `total_pages != 1` 或任一同名 token 都停止，不能把第一页当完整
  inventory，也不能把已过期同名对象静默当作可重建；
- telemetry probe 使用
  `POST /accounts/{account_id}/workers/observability/telemetry/query`。

permission group ID 不是稳定配置，严禁硬编码。工具按 exact name `Workers Observability Read` 与 exact
scope `com.cloudflare.api.account` 请求 discovery，并要求 live response 中唯一匹配；0 个、多个、scope
漂移或非法 ID 都在 create 前停止。该 endpoint 的当前 OpenAPI 不声明分页 query，collection
`result_info` 可缺省；若存在，只能把 `count` 与当前 filtered result 对齐。`total_count` 的官方语义是未应用
search parameters 时的总数，不能错误要求它等于 filtered result，也不能依赖 schema 中不存在的
`total_pages`。响应 `Link rel=next`、非第一页、count 不一致或容量小于结果数仍 fail-closed。create body
只允许一条 allow policy、一个 permission group 和一个 resource：

```text
com.cloudflare.api.account.<exact-account-id>: "*"
```

Cloudflare OpenAPI把`expires_on`声明为普通RFC 3339时间，但官方
[Create tokens via API](https://developers.cloudflare.com/fundamentals/api/how-to/create-via-api/)进一步把TTL
wire format明确为UTC整秒`YYYY-MM-DDTHH:mm:ssZ`。真实create先后使用约2小时、
24～25小时及7天TTL，且把target名称从64字符缩到50字符后都固定返回4xx；每次独立reconciliation均为
`absent`。这排除了名称长度，也反证了“只要把TTL扩到Dashboard最短可见7天预设即可”的归因。当前官方create
文档明确把`not_before`列为optional；Terraform常规acceptance直接省略它，TTL fixture则使用2018年的固定过去
时刻。项目失败请求唯一共同的非必要差异，是把`not_before`设为刚刚生效的毫秒级authority时间。因此create
body删除该可选字段，token在成功创建后立即有效。Round 241删除它后仍4xx，Round 244安全provider code为通用
`400`；两轮请求的`expires_on`仍带毫秒，和官方wire format不符。新authority因此只接受UTC整秒expiry并逐字
发送；7天～7天30分钟expiry约束继续限制未来有效期。reconciliation仍按instant比较，兼容已消费的历史小数秒
source。

## Authority 与固定 effect

从
[`cloudflare-observability-credential-provisioning-v1.example.json`](../schemas/cloudflare-observability-credential-provisioning-v1.example.json)
复制 shape 到仓库外私有绝对路径。example 已过期且全部是 synthetic 值，不是 live authority。真实文件必须
是普通非 symlink 文件、权限不宽于 `0600`、最大 64 KiB，并位于当前 repository/worktree 之外。

`authorityDigest` 是删除自身字段后的 canonical SHA-256，只发现文件漂移，不是签名、自授权或 Cloudflare
credential。owner 仍须在仓库外批准 exact digest。schema 同时固定：

- authority 生效窗口最多 30 分钟，进程必须在半开区间 `[authorizedAt, expiresAt)` 内开始；
- target token expiry必须是UTC整秒`YYYY-MM-DDTHH:mm:ssZ`，在完整authority窗口结束后至少再存活7天，且从
  `authorizedAt`起总TTL不超过7天30分钟；
- create body省略可选`not_before`与`condition`，不把短期owner authority时间误作provider token起始时间；
- token name 必须使用 `delivery-loop-workers-observability-read-*` 专用前缀；
- telemetry probe 绑定一个已经结束、最长 60 秒的 exact Worker service/window；
- Keychain service 固定为
  `delivery-loop-github-app-transport-diagnostic-cloudflare-observability-token`；
- effect 上界恰好为 inventory GET 1、permission-groups GET 1、token create POST 1、Keychain write 1、
  token verify GET 1、dry telemetry POST 1、token delete 0、retry 0。

authority 文件不保存 account ID 原文、bootstrap token、target token 或 canary，只保存 account digest 与安全
标量。bootstrap token、account ID 和 credential-shaped synthetic canary 只进入当前进程环境；三者不进入
argv、stdout/stderr、artifact、PR 或 `PROGRESS.md`。

## 显式运行

```text
DELIVERY_LOOP_CLOUDFLARE_OBSERVABILITY_CREDENTIAL_PROVISIONING=1
CLOUDFLARE_OBSERVABILITY_CREDENTIAL_AUTHORITY_FILE=<仓库外0600绝对路径>
CLOUDFLARE_OBSERVABILITY_CREDENTIAL_BOOTSTRAP_TOKEN=<Create-additional-tokens初始token>
CLOUDFLARE_OBSERVABILITY_CREDENTIAL_ACCOUNT_ID=<exact 32-hex account id>
CLOUDFLARE_OBSERVABILITY_CREDENTIAL_CANARY_SECRET=<synthetic credential-shaped canary>
CLOUDFLARE_OBSERVABILITY_CREDENTIAL_API_URL=<可选；默认https://api.cloudflare.com>
```

运行：

```bash
pnpm run ops:cloudflare-observability-credential-provision
```

固定顺序如下，任何阶段失败都停止且不 retry：

1. 在网络前核对 opt-in、仓库外 authority、canonical digest、account digest、时间/TTL、token/canary 互异，
   并用 exact service/account metadata 查询证明固定 Keychain 槽位尚不存在；不读取任何既有 Keychain 值；
2. 一次 inventory GET；分页、响应不完整或同名 token 均停止；
3. 一次 permission-group GET；只接受唯一 exact name + account scope；
4. 一次 create POST；request body 不接受调用方追加 policy/resource/condition，也不发送可选`not_before`；
5. create response 最大 1 MiB/10 秒、拒绝 redirect/pagination。新 secret 必须是 40～80 字节的 `cfat_`
   scannable value，且只允许在 `result.value` 出现一次；其他字段继续扫描 bootstrap token、canary、新 token、
   credential shape 和敏感字段名；
6. Node 只把新 token 保持在内存，用 stdin 交给固定 Swift Security Framework helper。helper argv、环境、
   stdout/stderr 和文件都不携带 secret，并以 `SecItemAdd` 拒绝覆盖已有 item；
7. 以新 token 执行一次 verify GET，要求 exact created token ID 为 `active`；
8. 以新 token 执行一次 `dry=true + view=events + limit=1 + exact service/window` telemetry probe；空结果
   可以证明 query 权限，raw event/log 不输出、不落盘。

CLI 默认未 opt-in、配置缺失或 authority 不可读时 exit 2，并在文件、Keychain、网络前停止；pre-create
事实拒绝 exit 1。create POST 一旦尝试，后续任何不确定结果都只返回固定
`created_unverified stage=token_create|keychain|token_verify|telemetry_probe`，不自动执行第二次 create、token
delete、Keychain overwrite、rotation 或 rollback。此时 token 可能已在 Cloudflare 或 Keychain 存在，后续
inventory/revoke/修复都需要新的独立 authority，不能复用原 session。
`stage=token_create`只允许附加一个不含raw status/body/error的固定`failureKind`：
`transport_unavailable|auth_rejected|request_rejected|rate_limited|upstream_unavailable|response_invalid`。
HTTP 401/403、其他4xx、429、5xx与收到响应前失败分别映射到固定类别；成功响应的pagination/size/JSON/
secret shape漂移统一`response_invalid`。该分类只用于定位，不能把4xx或transport解释为确定未创建，仍必须先
执行独立post-create reconciliation，也不能据此自动retry。

非2xx create response不再无条件丢弃全部诊断：工具先应用同一1 MiB/10秒/无redirect边界，并在JSON parse前
扫描bootstrap token、account ID、canary与全部已知credential shape。只有Cloudflare标准错误envelope中唯一的
非负安全整数code可以作为`cloudflareErrorCode=<integer>`附加到固定错误；message、raw status/body/header、
request字段和多码/非法码全部丢弃。body超限、分页、解析失败或命中任一Secret时也退化为没有provider code的
既有failureKind。数字code只缩小下一轮人工裁决范围，不改变`created_unverified`、独立reconciliation和零retry
要求。
其中只读确认exact target存在性的恢复入口固定为
[post-create reconciliation](CloudflareObservabilityCredentialReconciliation.md)；它没有create/delete/Keychain/
verify/telemetry路径，也不能从`present|absent`自行推导下一步mutation。

exit 0 只输出 authorization ID、account digest、token name、固定 permission/service、expiry、effect count、
`status=verified` 和 `plaintextLeaks=0`。它证明新 token 当时能完成 exact dry probe，但不证明历史 diagnostic、
readiness 200 或 hibernate 成功；后续 live collection+verification 仍需新的、绑定 immutable run/window 的
一次性 authority。

若 create 后 stdout 丢失但独立 reconciliation 已证明 exact target `present/active` 且固定 Keychain 槽存在，
不能重放 create 或把 metadata 升级为 verified。应使用独立的
[已有 credential 再验证](CloudflareObservabilityCredentialVerification.md) authority，只读一次 Keychain，并执行
一次 token verify 与一次 dry telemetry probe；该入口的 create/write/delete/retry 均为 0。
