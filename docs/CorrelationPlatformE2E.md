# Correlation 平台日志与 trace 真实外部证据验收

## 目标与完成边界

本验收用于关闭 Phase 6 correlation 项的真实外部事实：对同一个已经完成测试与生产部署的
真实试点 Run，分别用 Task、Run、Attempt、GitHub Actions run、Draft PR、控制面 test/production
deployment、两个 GitHub Deployment 和 tool-bridge trace 共十种入口查询，证明 D1 安全投影、
Cloudflare Workers Logs、Workers Traces 和 GitHub live object 指向同一条 lineage。

`CorrelationPlatformEvidenceManifestV1` 只是仓库外 expected 索引，Dashboard URL 只是人工复核入口。
manifest、schema example、fake HTTPS、本地 workerd、Wrangler dry-run、默认 exit 2 或一张截图都不能
证明已部署 Worker 的日志、trace、保留配置或 GitHub 对象真实存在。只有 live verifier exit 0 与人工
Cloudflare deployment/log/trace review 一起入账，才能勾真实平台事实；父 DoD 在此之前保持未勾。

## Authority 与固定配置

本轮不新增 correlation 汇总表。四类 authority 分工如下：

1. `GET /v1/correlations` 从 D1 既有只读 views 联查 authoritative Task/Run/Attempt、PR、deployment
   和 tool trace；十次响应都必须非 truncated，且关键状态、SHA、GitHub ID 与 manifest lineage 一致。
2. GitHub REST 实时读取一个 Actions run、当前 PR、test 和 production 两个 Deployment；D1 中出现
   一个 GitHub ID 不能替代这些外部对象存在与当前字段一致。
3. Cloudflare 官方 `POST /client/v4/accounts/{account_id}/workers/observability/telemetry/query`
   分别以 `view=events` 和 `view=traces`、`dry=true` 查询十次。每条 log 的 strict allowlist source、
   canonical digest、service/account/worker trace ID、时间和 `truncated=false` 必须一致；每条 trace
   必须覆盖对应日志时间、service 一致、至少一个 span 且无 error。
4. 人工打开 Worker deployment、Workers Logs 和 Workers Traces 三个 Dashboard 证据链接，确认生产
   script、保留/索引和实际 trace 视图；URL 自身不能替代复核。

`wrangler.jsonc` 显式固定 logs/traces `enabled=true`、`persist=true`、
`head_sampling_rate=1`。`invocation_logs=false`，避免平台自动请求元数据把 correlation query URL 带入
日志；仅保留经过统一 redaction/scanner 的 custom structured log。Cloudflare Workers Logs 最长只保留
7 天，所以 manifest 查询窗口必须完全处于记录时间之前七天内；本配置中的 100% sampling 是当前
试点验收配置，扩大生产流量前必须单独评估 telemetry 量和成本。

## 采集 manifest

- 在仓库外创建 manifest，结构参考
  [`correlation-platform-evidence-v1.example.json`](../schemas/correlation-platform-evidence-v1.example.json)。
- 选择一个 D1 已收敛为 `succeeded`、GitHub agent Action 已成功、PR publication 已 verified、test 与
  production deployment 均 succeeded、且具有一条 successful tool trace 的 Run。
- 在七天保留窗口内，对 manifest 固定顺序的十种 lookup 逐个调用已部署的
  `GET /v1/correlations?kind=...&id=...`；`github_pr` 与 `github_deployment` 必须附 exact
  `repository`。每次调用会发出一条带 `matchedByKind/matchedById/matchedByRepository` 的安全日志。
- 从 Cloudflare telemetry 事件取得每次调用的 32 位 worker trace ID、exact `observedAt` 和 strict
  log `source`；对 source 计算 canonical SHA-256 后写 `logRecordDigest`。不得复制原始请求、响应、
  token、Task/PR 正文或查询 URL到 manifest。
- 创建仓库外 credential-shaped synthetic canary，只把 canonical SHA-256 写入 manifest；canary
  原文仅经当前进程环境变量传入，用于扫描三个外部 API 的响应。
- 三枚 token 必须用途隔离：控制面 correlation read、单试点仓库 GitHub Actions/PR/Deployment read、
  Cloudflare Workers Observability read。它们都不得拥有仓库 write、merge、deployment write、Worker
  deploy、D1 write 或 Environment 管理权限。

环境变量：

```text
DELIVERY_LOOP_CORRELATION_PLATFORM_E2E=1
CORRELATION_PLATFORM_EVIDENCE_FILE=/absolute/path/outside-repository/correlation-platform-evidence.json
CORRELATION_PLATFORM_CONTROL_PLANE_URL=https://<deployed-control-plane>
CORRELATION_PLATFORM_CONTROL_PLANE_TOKEN=<correlation-read-token>
CORRELATION_PLATFORM_GITHUB_API_URL=https://api.github.com
CORRELATION_PLATFORM_GITHUB_READ_TOKEN=<single-repository-read-token>
CORRELATION_PLATFORM_CLOUDFLARE_API_URL=https://api.cloudflare.com
CORRELATION_PLATFORM_CLOUDFLARE_ACCOUNT_ID=<account-id>
CORRELATION_PLATFORM_CLOUDFLARE_OBSERVABILITY_TOKEN=<telemetry-query-token>
CORRELATION_PLATFORM_CANARY_SECRET=<synthetic-credential-shaped-canary>
```

## 运行与判据

```bash
pnpm run e2e:correlation-platform
```

- exit 0：十条 D1 projection、四个 GitHub live fact、十条 Workers Logs 和十条 Workers Traces
  全部一致，所有外部响应中没有任一配置 token、canary 或 credential 形状；仍需三项 Dashboard
  人工 review 入账后才能勾真实平台事实。
- exit 1：manifest/schema、lineage、GitHub fact、Cloudflare log/trace、响应大小或安全扫描任一失败。
- exit 2：未显式 opt-in、配置不完整或 manifest 不可读；这是 prerequisite 缺失，不是通过。

manifest 最大 64 KiB；所有 origin 必须是无 userinfo/query/fragment 的 HTTPS 根 origin；每个响应
最大 1 MiB、10 秒超时。Cloudflare query 固定 `dry=true`，不会持久化查询结果。CLI 不输出 manifest、
上游响应、Zod issue 或 token，只输出固定错误码或安全计数。

## 安全与回滚

本命令全程只读，不写 D1、不部署 Worker、不 dispatch Action、不改 PR/Deployment，也不修改
Cloudflare observability 设置。若采集期间发现日志截断、trace 缺失、repository scope 漂移或明文
credential，先按安全事件处理并轮换受影响凭据；不得通过修改 manifest digest 或放宽 verifier 掩盖。
回退 observability 配置是独立部署决策，执行前必须保留事故证据并确认不会破坏运营审计要求。
