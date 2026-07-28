# GitHub Review Fix 外部证据验收

本验收同时承担Phase 4 review反馈契约和Phase 7 E2E-4验收：证明一次真实`pull_request_review/submitted + changes_requested`只作用于它提交时绑定的PR head；控制面创建同Run/Plan/Item的新`review_fix` Attempt，从reviewed SHA恢复，在原PR branch形成修复commit并重新关门任务级DoD；旧head的review被忽略且不创建Attempt、R2 feedback或Action。验收器只读，不提交review、不触发Action、不创建分支，也不修改控制面状态。

## 事实链

控制面先从 signed review webhook 记录 metadata-only delivery。只有 review `commit_id`、PR payload head 和当前 immutable bot head 三者一致时，才写私有 R2 feedback，原子创建一个同 PR branch 的 `review_fix` Attempt、重开 passed Item 并入队 dispatch。stale head 只写 `ignored/stale_head` delivery，不能生成 feedback 或 replacement。

Case 8的`answers.checks.reviewObservations`只投影安全字段：delivery/review/publication ID、repository/PR number、reviewed head、payload/body digest、processing state、固定ignore reason、时间，以及applied feedback的ID、prior/replacement Attempt、branch、净化review URL和submitted time。不会返回review正文、R2 ref、raw webhook、REST response或token。verifier使用生产真实的顶层`runId`与`task.repository`并重算整个Case 8 report digest，不能接受manifest和局部投影一起伪造。

`/plan`与Case 8共同承担控制面authority：prior与replacement必须属于同一repository、active Plan/version和change Item；replacement的`claimedProgressVersion`为正，Plan Item完成后精确前进两个progress version。reviewed head必须同时是replacement checkout和新commit唯一parent；result head必须同时绑定immutable commit Evidence、targeted→required test Evidence、passed Item verification decision及completed replacement Attempt。

GitHub有三个不能混淆的SHA：Action run/job的`head_sha`是受信workflow ref在dispatch时的head，并绑定Plan base；Runner实际checkout的是reviewed PR head；Runner产出的是result head。验收器分别核对三者，要求唯一`attempt` job及固定checkout/mode-validation/execution steps成功，再核对commit、branch ref、单commitcompare、PR当前head和完整check-runs inventory。manifest只列一部分成功checks而live还有pending/failed/extra check时必须失败。

## 真实演练步骤

1. 在 exact Draft PR head 上由真人提交一条 `changes_requested` review，保留 GitHub review ID、delivery ID、review URL 和提交时间。
2. 让控制面 webhook projector 处理该 review，确认 Case 8 中存在一条 `applied` observation、一个 feedback lineage、一个 `review_fix` Attempt 和一个 execution dispatch；review body 只以 digest 形式存在。
3. 在旧 head 上构造另一条受控 stale review，确认它以 `ignored/stale_head` 入账，`review_feedbacks`、`review_feedback_attempts`、replacement dispatch 和 R2 feedback 数量均不增加。
4. 让固定Action从reviewed head恢复，在原PR branch做受限修复并产生一个新的bot commit。确认commit唯一parent为reviewed SHA，branch ref指向result SHA，compare恰好`ahead=1 + behind=0 + base=merge_base=reviewedHead + commits=[result]`，没有force-push。
5. 等待replacement Attempt重新执行targeted→required并由控制面核对全部commit/test Evidence；`/plan`中Item必须重新`passed`且verification decision绑定result SHA。Case 8中replacement必须携带正数`claimedProgressVersion`，同Attempt只有一条commit transition，review lineage不得被新head改写。
6. 等待新head所有check-runs完成。记录完整live inventory而不是只挑required子集；每条必须是`completed/success`且head等于result SHA。确认Action run的workflow head、job head和Runner checkout/result三类SHA各自语义正确。
7. 将Case 8 report digest、Plan/Item、applied/stale review、replacement Attempt、commit/suite/Item decision、Action/job、new SHA和完整checks安全ID写入仓库外manifest。canary只写canonical digest；不要写review正文、token、raw payload、数据库行或canary原文。

## 命令与退出码

```sh
DELIVERY_LOOP_GITHUB_REVIEW_E2E=1 \
GITHUB_REVIEW_EVIDENCE_FILE=/secure/outside/github-review.json \
GITHUB_REVIEW_CONTROL_PLANE_URL=https://control.example \
GITHUB_REVIEW_CONTROL_PLANE_TOKEN="$CONTROL_PLANE_READ_TOKEN" \
GITHUB_REVIEW_TOKEN="$GITHUB_READ_TOKEN" \
GITHUB_REVIEW_CANARY="$SYNTHETIC_CREDENTIAL_CANARY" \
pnpm run e2e:github-review
```

- `0`：`/plan`与重算后的Case 8证明同Plan/Item replacement、commit/test Evidence和passed decision，GitHub真人review、唯一Action job、PR/ref/commit/compare及新head完整checks全部一致；
- `1`：manifest/schema 或任一外部事实不一致、分页不完整、响应超限或 head/check drift；
- `2`：未显式 opt-in、配置缺失或 manifest 不可读。该路径在 manifest/network 前结束。

verifier会读取控制面`/plan`与audit，以及GitHub review list、PR、Action run/jobs、commit、branch ref、compare和check-runs API；每次GET固定10秒timeout，所有响应按1 MiB流式上限读取，redirect或发现下一页则fail-closed。控制面/GitHub token与credential-shaped synthetic canary在JSON parse前扫描；成功summary只含安全ID、状态、check计数和result SHA。

## Watt 复用与安全边界

`scripts/verify-github-review-feedback-evidence.ts`直接沿用Watt固定提交`476e3cdd2490d725fde174e7c697ebf00899edc6`的显式opt-in、仓库外64 KiB manifest、固定0/1/2退出、固定安全错误、有界HTTPS和分页fail-closed；10秒timeout与credential-shaped canary parse前扫描复用本项目既有Watt-derived骨架。E2E-4直接增强Round 86已有manifest/verifier/CLI，没有新增wrapper或第二套GitHub review parser。Watt没有head-bound review feedback、stale projector、same Plan/Item review_fix、DoD Evidence或三类SHA/check inventory业务断言，这些由delivery-loop现有控制面authority组合验真。

真实review body只在Runner受控上下文和只读verifier内存中短暂读取；D1、Case 8、日志、artifact、PR、manifest和命令输出只能保留body digest。GitHub/control-plane token只进入对应Authorization header，synthetic canary只从环境进入内存；三者都不进入manifest、URL、argv、summary或日志。
