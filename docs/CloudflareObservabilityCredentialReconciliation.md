# Cloudflare Workers Observability credential post-create reconciliation

## 目标与边界

本文只定义一个显式 opt-in、一次只读且零重试的本机操作：当
[Workers Observability credential provisioning](CloudflareObservabilityCredentialProvisioning.md)
已经尝试 create POST、但响应结果不确定时，用仍受控的 `Create additional tokens` bootstrap credential
读取一次完整 Account API Token inventory，确认 exact source authority 所绑定的 target token 是
`present` 还是 `absent`。

该操作不读取 Keychain、不验证或使用 target secret，也没有 permission-group、telemetry、create、delete、
disable、overwrite、rotation、repair 或 rollback 路径。代码合并、schema example、默认 exit 2、fake API 或
本地测试都不能证明真实 Cloudflare target 的存在性。provisioning authority 已在 create attempt 时消费，
不能重用；reconciliation 必须使用独立、绑定 source provisioning identity 与 exact token lifecycle 的
短期 owner authority。

## 只读契约

工具只允许一次：

```text
GET /client/v4/accounts/<exact-account-id>/tokens?per_page=50&include_expired=true
```

请求固定 10 秒 timeout、`redirect=error`、响应最大 1 MiB，且拒绝 `Link rel=next`。inventory 必须证明
`page=1`、`per_page=50`、`count=result.length`、`total_count=result.length` 与 `total_pages=1`；否则不能把
第一页缺少目标解释为 `absent`。所有响应在 JSON parse 前扫描 bootstrap token、synthetic canary 与 credential
shape，raw response、account ID、token ID 和错误正文不得输出或落盘。

exact token name 只允许 0 或 1 个匹配：

- 0 个输出 `status=absent`；
- 1 个还必须匹配 source create body 的 `not_before` 与 `expires_on`，时间按 instant 比较，允许 Cloudflare
  使用等价 RFC 3339 表达；状态只接受 `active|disabled|expired`，token ID 只输出 SHA-256 digest；
- 多个同名、lifecycle 漂移、未知状态或非法 ID 都 fail-closed，不能选择其中一枚或继续 mutation。

## Authority 与固定 effect

从
[`cloudflare-observability-credential-reconciliation-v1.example.json`](../schemas/cloudflare-observability-credential-reconciliation-v1.example.json)
复制 shape 到仓库外私有绝对路径。example 已过期且全是 synthetic 值，不是 live authority。文件必须是普通
非 symlink 文件、权限不宽于 `0600`、最大 64 KiB，并位于当前 repository/worktree 之外。

`authorityDigest` 是删除自身字段后的 canonical SHA-256，只用于发现文件漂移，不是签名或自授权。schema
把最长 30 分钟的执行窗口绑定到：

- source provisioning authorization ID 与 canonical authority digest；
- exact account ID digest、target token name、`not_before` 与 `expires_on`；
- inventory GET 1；permission-group/keychain/verify/telemetry/create/delete/retry 全部 0。

bootstrap token、account ID 与 credential-shaped canary 只进入当前进程环境，不进入 authority、argv、
stdout/stderr、artifact、PR 或 `PROGRESS.md`。

## 显式运行

```text
DELIVERY_LOOP_CLOUDFLARE_OBSERVABILITY_CREDENTIAL_RECONCILIATION=1
CLOUDFLARE_OBSERVABILITY_CREDENTIAL_RECONCILIATION_AUTHORITY_FILE=<仓库外0600绝对路径>
CLOUDFLARE_OBSERVABILITY_CREDENTIAL_RECONCILIATION_BOOTSTRAP_TOKEN=<仍受控的bootstrap token>
CLOUDFLARE_OBSERVABILITY_CREDENTIAL_RECONCILIATION_ACCOUNT_ID=<exact 32-hex account id>
CLOUDFLARE_OBSERVABILITY_CREDENTIAL_RECONCILIATION_CANARY_SECRET=<synthetic credential-shaped canary>
CLOUDFLARE_OBSERVABILITY_CREDENTIAL_RECONCILIATION_API_URL=<可选；默认https://api.cloudflare.com>
```

运行：

```bash
pnpm run ops:cloudflare-observability-credential-reconcile
```

未 opt-in、配置缺失或 authority 不可读时 exit 2，并在文件内容或网络前停止。live HTTP/shape/Secret/identity
失败 exit 1，且不 retry。exit 0 只输出安全 reconciliation summary 和 `plaintextLeaks=0`。

`present` 只证明 Cloudflare 保留了 exact target；create response 中的一次性 secret 仍不可恢复，不能因此写
Keychain或运行 telemetry。`absent` 也只解除“是否已经创建”的不确定性，不能自行授权第二次 create。后续
保留、撤销、替换或重新 provisioning 都是新的明确决策；verified credential 建立后，历史 transport window 的
collection 与 formal verification 仍需另一份 immutable authority。
