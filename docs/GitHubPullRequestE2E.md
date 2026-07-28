# GitHub Draft PR 外部证据验收

本验收只核对已经发生的事实，不创建 PR、不重放 webhook，也不替 Agent 推进 Run。PR publication 必须先由控制面从当前 Task revision、active Plan、最终 bot head 和 verified Evidence 生成 immutable prepared snapshot；Agent 提供的 URL、number 或 status 没有状态推进权限。

## 前置条件

需要一个已部署且可查询的控制面、一个已安装 delivery-loop GitHub App 的试点仓库，以及一份仓库外的 `GitHubPullRequestEvidenceManifestV1`。控制面只读 token 与 GitHub `pull_requests:read` token 必须用途隔离，token 不能写入 manifest、日志或命令输出。

manifest 至少包含：

- `runId`、repository 和 verified publication；
- publication 的 base/head branch、40 位 head SHA、body digest、PR number/HTTPS URL；
- 一条已应用的 signed `pull_request opened` webhook fact；
- 一条已应用的 GitHub API reconciliation fact。

示例结构见 [`schemas/github-pull-request-evidence-v1.example.json`](../schemas/github-pull-request-evidence-v1.example.json)。manifest 最大 64 KiB，禁止 PR 正文、raw webhook/API 响应、URL query/fragment、token 和数据库行。

## 真实演练步骤

1. 让控制面按 exact prepared snapshot 创建一份 Draft PR。创建响应仍是 `created_unverified`，不能单独把 Run 改为 `pull_request_open`。
2. 在 GitHub 记录同一 PR 的 `pull_request opened` signed webhook。projector 必须绑定 repository、publication、base/head、number 和 body digest，并写入 `applied` webhook observation。
3. 触发一次 API reconciliation，读取同一 PR 的只读 API fact。它必须绑定同一 publication、number、repository、base/head 与 digest，并写入 `applied` API observation。重复 delivery 或 reconciliation 只能复用既有 identity。
4. 从控制面 `GET /v1/runs/:runId/audit` 导出安全报告。Case 8 的 `answers.checks.pullRequestObservations` 必须公开两条白名单 observation；不得公开 raw webhook、PR body、REST response 或 token。
5. 把 manifest 放在控制面仓库之外，使用短期用途隔离 token 运行 verifier。verifier 会先核对 Case 8 publication 和两条 observation，再调用 GitHub `GET /repos/:owner/:repo/pulls/:number` 核对 `open + draft`、URL/number、base/head repository/ref/SHA 和 canonical body SHA-256。
6. 将退出码、固定 summary、PR URL、webhook delivery ID、API observation ID 和控制面 audit URL 写入 `PROGRESS.md`；只写安全 ID、digest 和链接，不写正文或凭证。

## 命令与退出码

```sh
DELIVERY_LOOP_GITHUB_PR_E2E=1 \
GITHUB_PR_EVIDENCE_FILE=/secure/outside/github-pr.json \
GITHUB_PR_CONTROL_PLANE_URL=https://control.example \
GITHUB_PR_CONTROL_PLANE_TOKEN="$CONTROL_PLANE_READ_TOKEN" \
GITHUB_PR_TOKEN="$GITHUB_PULL_REQUESTS_READ_TOKEN" \
pnpm run e2e:github-pr
```

- `0`：Case 8、webhook、API observation 和 GitHub PR live fact 全部一致；
- `1`：manifest/schema 或任一 live fact 不一致、分页/响应超限或外部事实漂移；
- `2`：没有显式 opt-in、必要配置缺失或 manifest 不可读。此路径在读取 manifest 或访问网络之前结束。

HTTP 响应按 1 MiB 流式上限读取，错误只输出固定 code。verifier 是只读的，不发送 webhook、创建/修改 PR、刷新 token 或写控制面状态；`0` 仍不能替代真实 App 安装范围、webhook 签名、Actions 关联和人工核对。

## 安全边界与 Watt 复用

`scripts/verify-github-pull-request-evidence.ts` 直接沿用 Watt 固定提交 `476e3cdd2490d725fde174e7c697ebf00899edc6` 的 E2E 纪律：显式 opt-in、仓库外 64 KiB manifest、固定 0/1/2 退出码、固定错误输出和有界读取。Watt 没有 delivery-loop 的 PR publication、Case 8 observation projection 或 GitHub body/head 业务断言；这些是本项目新增的最小事实核对，不能反称为 Watt 能力。

任何 raw PR body、webhook/API payload、GitHub response、App token 或控制面 token 都不得进入 D1、R2、日志、artifact、PR 正文或 `PROGRESS.md`。真实 GitHub 子项只有在真实 App effect、signed webhook、API reconciliation 和 verifier `exit 0` 全部入账后才能勾选。
