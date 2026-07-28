# requirement / bug 到 Draft PR 的真实外部证据验收

## 目标与完成边界

本验收用于关闭 Phase 4 的最终试点项：同一个真实试点仓库中，一条 PRD requirement 和一条
user-feedback bug 分别经过 Task、ExecutionPlan/DoD、执行、测试和 PR 外部核对，最终形成两份
仍处于 `open + draft` 的 GitHub PR。两条 case 必须使用不同的 Task、Run、Action、head SHA、
branch 和 PR number，不能把同一次执行换标签后重复计数。

`DraftPrCasesEvidenceManifestV1` 只是仓库外安全索引。它不能证明 PRD 理解正确、用户反馈的
根因判断正确，也不能证明 reviewer 真实存在；requirement semantic review、bug root-cause review、
diff/test trace review 必须由真人打开原始需求、诊断证据、diff、测试和 PR 后独立完成，并把无
query/fragment 的 HTTPS 证据链接及 review 时间记录在 manifest 和 `PROGRESS.md`。schema example、
fake GitHub、local workerd、Wrangler dry-run、manifest 自报或默认 exit 2 都不能替代真实试点事实。

## Authority 与交叉核对

本轮不创建第二套试点状态表。verifier 对每条 case 读取五类既有 authority：

1. `GET /v1/tasks/:taskId`：Task digest、source revision、`requirement|bug` intent、验收标准数量、
   active Run/Plan。
2. `GET /v1/runs/:runId/plan`：全部 required investigation/change/verification/delivery Item、
   acceptance coverage、passed verification decision，以及唯一 change Item 上的`repo_write`、
   targeted/required command、Execution Attempt 和 test Evidence。
3. `GET /v1/runs/:runId/audit`：重算 Case 8 report digest，并核对Task写策略、latest exact飞书
   mapped-human `approve(repo_write)`及外部lineage、Attempt的`claimedProgressVersion`、同Attempt/Plan/Item/approval/repository的
   write credential及其安全时间线、唯一commit、targeted→required command、verified Evidence、
   Item verification、同approval Draft PR publication、零 merge 和零 deployment。
4. GitHub Actions 与 compare REST：`Delivery Agent` workflow_dispatch、唯一成功 job、三个固定
   execution step、checkout/parent/head SHA、base→head 恰好 ahead 1、behind=0且只有final commit，
   并从 canonical file projection 重算 diff digest。
5. 既有 GitHub Draft PR verifier：Case 8 publication/webhook/API observations 与 live PR 的
   repository、number、URL、base/head、body digest、`open + draft` 完全一致。

任一 authority 缺失或漂移都失败。manifest 中的 expected ID、SHA 和 digest 不能覆盖 Task/Plan、
Case 8 或 GitHub live fact。

## 准备

- 在仓库外创建 manifest，字段结构参考
  [`draft-pr-cases-evidence-v1.example.json`](../schemas/draft-pr-cases-evidence-v1.example.json)。
- requirement 固定为 `scenario=requirement,inputClass=prd`，bug 固定为
  `scenario=bug,inputClass=user_feedback`，顺序不可交换。
- 每条 Plan 至少包含并通过 investigation、change、verification、delivery 四类 required Item；
  全部 acceptance criteria index 必须被 required Item 覆盖。E2E-3固定只有一个required change
  Item，initial `implement` Attempt必须从Plan base领取该Item；review-fix属于E2E-4，不在此冒充首次交付。
- Case 8的`claimedProgressVersion`是Attempt创建时冻结的ready progress version；它只证明控制面从
  ready Item领取，不是Agent自报状态。write credential必须只限manifest repository，并与PR
  publication复用同一latest exact approval。approval必须覆盖Attempt领取至publication；credential
  必须在唯一commit发生时有效。验证器不要求approval在日后重跑时仍未过期，避免破坏证据可回放性。
- test suite 至少包含一条 targeted 和一条 required command，按实际执行顺序记录，且每条命令
  都绑定 final head 上 `verified + passed + exitCode=0` 的 Evidence。
- `changedFilesDigest` 对 GitHub compare 返回的文件按 filename 排序，只保留
  `filename/status/additions/deletions/changes/previousFilename` 后计算 canonical SHA-256。
- 创建仓库外 credential-shaped synthetic canary，只把 canonical SHA-256 写入 manifest。canary
  原文只通过环境变量进入当前进程，用于扫描控制面和 GitHub 响应。
- 控制面 token 只需 Task/Plan/Case 8 operations read；GitHub token 只需试点仓库 Actions、
  Contents/metadata 和 Pull requests read。两者都不得拥有 contents write、PR write、merge、
  deployment 或 Environment 管理权限。

环境变量：

```text
DELIVERY_LOOP_DRAFT_PR_CASES_E2E=1
DRAFT_PR_CASES_EVIDENCE_FILE=/absolute/path/outside-repository/draft-pr-cases-evidence.json
DRAFT_PR_CASES_CONTROL_PLANE_URL=https://<deployed-control-plane>
DRAFT_PR_CASES_CONTROL_PLANE_TOKEN=<task-plan-audit-read-token>
DRAFT_PR_CASES_GITHUB_API_URL=https://api.github.com
DRAFT_PR_CASES_GITHUB_READ_TOKEN=<single-repository-read-token>
DRAFT_PR_CASES_CANARY_SECRET=<synthetic-credential-shaped-canary>
```

## 运行与判据

```bash
pnpm run e2e:draft-pr-cases
```

- exit 0：两条 distinct case 的五方 live fact 全部一致，响应中未发现 token、canary 或其他
  credential 形状，并安全汇总2条approval、ready claim、write credential和single-commit diff；
  仍需人工 semantic/root-cause/diff review 证据一起入账后才能勾真实试点项/E2E-3。
- exit 1：manifest/schema、Task/Plan/Case 8、Action/job、diff、PR、分页、响应上限或安全扫描
  任一失败。
- exit 2：未显式 opt-in、配置不完整或 manifest 不可读；这表示 prerequisite 未满足，不是通过。

manifest 最大 64 KiB；所有 HTTP origin 必须是无 userinfo/query/fragment 的 HTTPS 根 origin；
每个响应最大 1 MiB、10 秒超时并拒绝 `rel=next`。verifier 不输出 manifest、Zod issue、上游响应
或 token，只输出固定错误码或安全计数。

## 安全回滚

本命令全程只读，不 dispatch Action、不写仓库、不创建/更新/关闭 PR、不 merge 或 deploy。
试点完成后保留还是关闭 Draft PR 是独立人工仓库变更；不得由 verifier 自动执行。若人工 review
发现 requirement 语义或 bug 根因不成立，应把对应 Plan/Run 按正常 revision/rework 流程处理，
不能修改 manifest 或重跑 verifier 来掩盖业务错误。
