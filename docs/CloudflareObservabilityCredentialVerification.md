# 已有 Workers Observability credential 再验证

## 目标与边界

本入口只裁决固定 macOS Keychain 槽位中的既有用途隔离 credential 是否仍满足两个实时事实：

1. Cloudflare account-token verify 返回 authority 绑定的 exact token ID 且状态为 `active`；
2. 同一 token 能完成一次 `dry=true`、固定 service/window 的 Workers Observability telemetry probe。

Keychain item 存在、token inventory 的 `present/active`、历史 provisioning stdout、公开 503 或本地 mock
均不能替代这两个事实。本入口没有 token inventory、permission discovery、create、Keychain write、delete、
rotation、retry、diagnostic collection、readiness、Task、Action、deploy、repair 或 rollback 路径。

## Authority

从
[`cloudflare-observability-credential-verification-v1.example.json`](../schemas/cloudflare-observability-credential-verification-v1.example.json)
复制 shape 到仓库外普通、非 symlink、权限不宽于 `0600` 且不超过 64 KiB 的绝对路径。example 已过期且为
synthetic 数据，不是 live authority。`authorityDigest` 是删除自身字段后的 canonical SHA-256，只发现文件漂移，
不能自授权。

authority 最长 30 分钟，绑定 exact account digest、token ID digest、token name、固定 Keychain service/account、
已结束且最长 60 秒的 probe window，以及以下不可变 effect：

```text
Keychain read 1
account token verify GET 1
dry telemetry POST 1
inventory/permission/create/Keychain write/delete/retry 0
```

token ID 原值只存在于 Cloudflare verify response 的受控内存中；summary 仅保存其 authority-bound digest。
account ID、Keychain credential 和 synthetic canary 只进入当前进程，不进入 argv、stdout/stderr、authority、
artifact、PR 或账本。

## 显式运行

```text
DELIVERY_LOOP_CLOUDFLARE_OBSERVABILITY_CREDENTIAL_VERIFICATION=1
CLOUDFLARE_OBSERVABILITY_CREDENTIAL_VERIFICATION_AUTHORITY_FILE=<仓库外0600绝对路径>
CLOUDFLARE_OBSERVABILITY_CREDENTIAL_VERIFICATION_ACCOUNT_ID=<exact 32-hex account ID>
CLOUDFLARE_OBSERVABILITY_CREDENTIAL_VERIFICATION_CANARY_SECRET=<synthetic credential-shaped canary>
CLOUDFLARE_OBSERVABILITY_CREDENTIAL_VERIFICATION_API_URL=<可选；默认https://api.cloudflare.com>
```

运行：

```bash
pnpm run ops:cloudflare-observability-credential-verify
```

默认未 opt-in 时在读取配置、authority、Keychain 和网络前 exit 2。opt-in 后先核对 strict authority、时间窗、
canonical digest、account digest、credential/canary shape 与 HTTPS origin；然后用固定 argv 让
`/usr/bin/security`只读一次 exact service/account，stdout 以 2,000 bytes 上限留在父进程内存，stderr 丢弃，
credential 不进入环境变量或后续命令参数。

两次 Cloudflare 请求复用 provisioning 已有的 10 秒、1 MiB、redirect/pagination 拒绝、JSON 前 Secret scan、
strict envelope/parser 与单请求无 retry 边界。verify 必须返回可接受 ID、`active`，且其 canonical digest等于
authority 的 `tokenIdDigest`；identity 漂移时 telemetry 请求为 0。probe 必须回显 exact account 和
`dry=true`，raw log/event 不输出、不落盘。

probe body按Cloudflare OpenAPI固定为authority ID派生的ad-hoc `queryId`、顶层`view/dry/limit=1`，并把
authority中的ISO window转换为Unix毫秒`timeframe.from/to`；`datasets/filters/groupBys/calculations`位于
`parameters`。项目旧collector仍使用ISO timeframe且缺queryId，不能反向覆盖当前provider contract。

verify 或 probe 失败只允许附加一个安全 `failureKind`：收到HTTP响应前失败为`transport_unavailable`，
401/403为`auth_rejected`，其他4xx为`request_rejected`，429为`rate_limited`，5xx为`upstream_unavailable`，
其他status、size、pagination、JSON/envelope/result漂移为`response_invalid`。parse前或结构化响应扫描命中credential时使用
`secret_leak_detected`错误码，不回显raw body/message/status。分类不授权retry；同一authority消费后必须停止，
下一次请求需要新的authority。

exit 0 只输出安全 summary：authorization ID、account/token ID digest、token name、固定 Keychain metadata、
effect count、`status=verified` 与 `plaintextLeaks=0`。这允许 owner 后续另行签发绑定 immutable Round 207
窗口的 collection + formal verification authority；它本身不执行 collection，也不证明历史 failureKind、
readiness 200 或 hibernate 成功。
