# 只读 Analysis Action 真实验收

本验收只回答一个问题：试点仓库中的某个真实 GitHub Action，是否在不可变 commit 上读取一份用户反馈或 PRD，以只读权限运行受审 Codex Runner，并把带非空 Evidence refs 的合法 `ExecutionPlan v1` 写回控制面，同时保持 Git HEAD、branch 状态和工作树不变。

它不会创建 Task、安装 GitHub App、触发 Action、调用 Codex、修改仓库或补写控制面状态。所有外部事实必须先由正常产品链路产生；schema example、fake API、本地 workflow 测试和 verifier 的默认 exit 2 都不是完成证据。

## 1. 事实来源

`AnalysisActionEvidenceManifestV1` 只冻结安全 ID、SHA、计数和 digest。`pnpm run e2e:analysis-action` 每次重新读取以下 authority：

1. 直接复用 [GitHub App 单仓库安装与固定 dispatch 真实验收](GitHubAppDispatchE2E.md) 的完整 verifier，核对 App/installation/repository、D1 Attempt/outbox、Action immutable workflow、唯一 stable-title run/job，以及 analysis/clean step 成功、execution step skipped；
2. `GET /v1/tasks/:taskId` 核对 `bug → user_feedback` 或 `requirement → prd`、目标仓库和 acceptance criteria 数量；
3. `GET /v1/runs/:runId/plan` 核对 active Plan identity/digest、非空 Evidence refs 的 count/digest、objective digest和完整Item安全投影；Item必须有合法ID、依赖无环、`doneWhen`与Evidence kind非空，required Item覆盖全部验收标准；
4. operations-only Case 8 核对实际 context read 聚合及attempt grant。类别只允许repository/logs/traces/K8s/database，全部必须是成功的read，至少包含repository；analysis Attempt不能出现repo-write credential；
5. GitHub Contents API从该Action的exact head SHA读取固定八文件Runner source-set、package和lockfile。每个blob/content digest及聚合contract digest都要匹配，`@openai/codex`版本必须由package与pnpm lock双重固定；contract shape还固定核对bug的`logs/search → traces/get → diagnostic-evidence → Plan exact ref` mediation和token-free capability facade；
6. immutable workflow的最终步骤必须同时执行：`HEAD == checkout_sha`、`symbolic-ref`为空、`git status --porcelain`为空。GitHub job API必须观察到该步骤成功。

GitHub不会暴露hosted Runner上“曾创建后又删除”的临时本地branch审计。因此零分支/零写入结论不是manifest布尔值自证，而是以下证据组合：Action token只有`contents:read + id-token:write`、checkout不保留credential、analysis grant全只读、没有repo-write credential、受审immutable Runner source-set没有写路径、最终HEAD仍为原SHA且detached/worktree clean。若组织另有Runner命令审计，应将其链接一并人工入账；verifier exit 0不能替代这项补强。

## 2. Runner contract digest

受审集合固定且顺序不可改：

```text
scripts/run-analysis-attempt.ts
src/runner/analysis-runner.ts
src/agent/codex-analysis-adapter.ts
src/domain/analysis-plan.ts
src/domain/plan.ts
schemas/analysis-plan-content-v1.schema.json
package.json
pnpm-lock.yaml
```

manifest v1继续只保存上述固定八文件及聚合digest。verifier还会从同一
immutable `runner.sourceSha`读取`src/agent/codex-usage.ts`、
`src/agent/command-runtime.ts`和`src/agent/provider-preflight-failure.ts`，核对usage
投影、stderr脱敏/上限及JSONL failure固定分类形状；不接受当前main或调用方提供的
替代源码，也不为这三个transitive依赖新增第二套manifest authority。

release review先从目标Action的immutable SHA读取这些文件，记录每个Git blob SHA和`canonicalSha256(source)`，然后计算：

```text
canonicalSha256({ sourceSha, codexVersion, files })
```

结果进入受控release记录，并通过`ANALYSIS_ACTION_RUNNER_CONTRACT_DIGEST`单独注入。不要从待验manifest复制该值；否则manifest可以同时改写source列表和digest，失去独立锚点。source-set任一文件、Codex版本或blob变化都必须重新review并产生新release记录。

## 3. 准备真实事实

1. 完成单仓库GitHub App安装、credential issuance审计和固定workflow准备；
2. 通过正常`POST /v1/tasks`提交一份真实但不含Secret的用户反馈或PRD，保留Task/Run ID；
3. 让D1 outbox正常触发唯一analysis Action。不得手工伪造Attempt、Plan或Case 8行；
4. 确认Action调用锁定版本Codex并成功完成；requirement/PRD可以只出现repository context。user-feedback bug必须同时出现同Attempt成功的logs、repository和traces聚合，并有四个独立model usage；其他按需context也必须在Case 8中表现为成功只读聚合；
5. 在仓库外生成manifest，可参考`schemas/analysis-action-evidence-v1.example.json`的形状。不得把Task正文、Plan objective/Item正文、Evidence ref原值、tool参数/result、workflow/source正文、raw API响应、token或Secret写入manifest；
6. 分别准备control-plane query token、operations token、App JWT、未按repository二次narrowing的installation audit token，以及manifest外的受审Runner contract digest。

## 4. 运行

```bash
export DELIVERY_LOOP_ANALYSIS_ACTION_E2E=1
export ANALYSIS_ACTION_EVIDENCE_FILE=/absolute/path/outside/repo/analysis-action-evidence.json
export ANALYSIS_ACTION_CONTROL_PLANE_URL=https://delivery.example.com
export ANALYSIS_ACTION_CONTROL_PLANE_TOKEN='short-lived-query-token'
export ANALYSIS_ACTION_OPERATIONS_TOKEN='short-lived-operations-token'
export ANALYSIS_ACTION_APP_JWT='short-lived-app-jwt'
export ANALYSIS_ACTION_INSTALLATION_AUDIT_TOKEN='short-lived-un-narrowed-audit-token'
export ANALYSIS_ACTION_RUNNER_CONTRACT_DIGEST='sha256:reviewed-release-digest'
pnpm run e2e:analysis-action
```

GitHub Enterprise测试端点可额外设置`ANALYSIS_ACTION_GITHUB_API_URL`，必须是无userinfo/query/fragment的HTTPS origin。所有credential只进入Authorization header，不进入manifest或成功摘要。

退出码固定：

- `0`：所有live authority一致；只打印ID、计数、版本、digest和布尔安全摘要；
- `1`：manifest、D1/Case 8、GitHub、Plan/context或Runner contract不一致；
- `2`：未显式opt-in、缺配置或manifest文件不可读；没有发起验收网络请求。

## 5. DoD入账

只有exit 0后，才把命令、时间、Task/Run/Action URL、immutable SHA、GitHub job URL、Runner release review记录和无瞬态branch的人工补强写入`PROGRESS.md`。本地fake测试只证明verifier会fail-closed；在真实Action、有效Codex credential和外部链接不存在时，DOD中的“真实 GitHub Action”子项及父项必须保持未勾。
