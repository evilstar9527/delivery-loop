# Workflow hibernate / Worker redeploy 真实验收

本文验收 Phase 1 的普通持久恢复：`DeliveryRunWorkflow` 在 `await-analysis-result` 等待期间 hibernate，Worker 发布新版本后由同一 Workflow instance 继续；已经成功的 `register-run` 与 `dispatch-analysis-attempt` 不重跑，D1 仍是业务状态真源，GitHub 只有一个 analysis Action。这里不是受控 replay，也不调用 Workflow restart API。

verifier 严格只读，不负责部署 Worker、发送 signal 或触发 Action。schema example、fake API、本地 workerd restart、Wrangler dry-run和默认 exit 2都不能替代真实外部事实。

## 1. 前置与最小权限

- 已部署的 Worker 名为 `delivery-loop-control-plane`，Workflow 名为 `delivery-run`；D1 migration、Queue/outbox、GitHub App dispatcher与试点仓库固定 analysis workflow均已启用；
- 试点 Task 停在 analysis，且能人为控制 `await-analysis-result` signal 的发送时间；
- Cloudflare token只允许读取目标账户的 Workflows instance和Worker deployments；GitHub token只允许读取试点仓库 Actions；控制面token分别只允许读取Run/Plan和Case 8 audit；
- before/after Worker deployment、试点Run和Action都在一个受控短窗口中完成。不要把token、Cloudflare raw step output/error、GitHub raw响应、Task/Plan正文或数据库行写入manifest。

## 2. 真实演练

### 2.1 发布前置与授权边界

真实窗口开始前必须先完成一次无写入readiness检查；它只证明待发布内容可构建，不授权D1或Worker生产变更：

```bash
export CLOUDFLARE_ACCOUNT_ID=b8488957e88658039d2a38fb8f160514
pnpm exec wrangler d1 migrations list DB_CONTROL --remote
pnpm exec wrangler deploy --dry-run --outdir <仓库外临时目录>
pnpm exec wrangler deployments status --name delivery-loop-control-plane --json
```

多账号OAuth下所有D1/Worker命令都必须显式绑定受审account ID；不能依赖交互选择或仅假定`wrangler.jsonc`会被每个子命令采用。保存dry-run `worker.js`的byte size与SHA-256、当前100% deployment/version ID和安全binding投影；bundle、metafile和source map不进入仓库或Evidence。

当前Sol/high配置依赖migration `0062_codex_sol_relay_profile.sql`。若list只返回该migration，取得独立production D1授权后必须先运行：

```bash
pnpm exec wrangler d1 migrations apply DB_CONTROL --remote
```

Wrangler会在apply前创建D1 backup，单条migration失败时回滚该migration；命令成功后仍须只读确认Sol profile恰好1条、Terra profile仍恰好1条且unapplied list为空。不得先发布引用缺失profile的Worker。migration成功而Worker发布失败时保留新增immutable profile，不手写DELETE回退。

随后取得第一次production Worker发布授权，以`--strict`发布before版本并记录main SHA、bundle digest、deployment/version ID与时间；`--strict`发现远端漂移时停止，不以`--keep-vars`或覆盖Dashboard配置绕过：

```bash
pnpm exec wrangler deploy --strict --message "phase1-hibernate-before main@<main-sha>"
```

发布后必须重新核对100% traffic、Sol/high profile binding、三枚既有Secret binding名称、D1/R2/Queue/Workflow/cron/observability安全投影和`/healthz=200`。healthz只证明isolate liveness；profile/D1、GitHub dispatch或provider成功仍需各自事实。发布前的100% version只作为人工review的rollback anchor；`wrangler rollback`是独立production写操作，未经新的明确授权不得自动执行。

Task进入`await-analysis-result`并确认唯一dispatch后，第二次after发布也需要明确production授权，继续使用相同main SHA、bundle digest与`--strict`，message绑定安全run ID。固定Runner在Plan提交后会立即执行正常callback，不能假设操作者一定来得及在Task创建后再等待一次人工授权。安全窗口应一次性授权“仅当exact guard成立时执行一次after”：授权绑定本次before deployment/version、冻结source/bundle和唯一Run/Attempt，不是任意未来Worker发布权限。wait窗口内只能出现这一个after deployment；发布失败时停止演练，不发送额外signal、不改写D1且不自动rollback。

仓库内`executeConditionalHibernateAfter`是这条conditional-after的纯协调契约，不会因函数参数或测试通过而自行产生production authority。实际操作者必须先取得上述exact授权，再让live collector提供两次连续、最多5秒陈旧的快照；每次都同时证明：

- source worktree干净且HEAD等于冻结SHA，两次独立bundle build都等于冻结digest；
- 当前100% deployment/version仍是before，wait开始后尚无其他deployment；
- 同一Run仍为`planning`且无active Plan，Workflow instance恰好1个，`register-run`与`dispatch-analysis-attempt`成功而`await-analysis-result`仍未结束，恢复步骤为0；
- analysis Attempt、已settled dispatch outbox及stable-title GitHub Action各恰好1个；Attempt只能是`pending|starting|running`，Action只能是`queued|in_progress`且result signal outbox为0，因此正常callback尚未入账。

第二次快照任何identity、状态、流量、计数或时间漂移都必须在调用Wrangler前返回固定错误，生产写为0。只有两次guard均成立才能以`--strict`调用一次after；调用后还必须证明新deployment/version不同、100% traffic、wait内deployment总数恰好1且`after.createdAt < wait.endedAt`（或wait仍未结束）。post-check失败只把本次演练判失败，不获得自动rollback权限，也不能重新创建Task/Action或执行第二次after。纯函数测试不能替代live collector、Wrangler执行或formal verifier。

1. 发布before版本，记录deployment/version ID与时间；创建一个真实Task/Run，并确认`run_id`就是Workflow instance ID。
2. 等待instance进入`await-analysis-result`。Cloudflare instance详情必须显示`register-run`与`dispatch-analysis-attempt`已经成功，D1只有一个analysis Attempt和一个`analysis_dispatch` outbox；GitHub stable title `delivery-loop/<attemptId>`只有一个Action。
3. 在正常analysis callback入账前取得上述两次fresh guard；任一guard失败则不发布。guard成立时立即发布一次after Worker版本。受控窗口内在wait开始前生效的最后一个deployment必须是before，wait期间只能有这一个after deployment。
4. 发布完成后再让同一个Action通过正常reference-only callback/outbox发送analysis result；不得手工改D1或直接调用Workflow内部方法。
5. 等待同一instance继续执行`verify-analysis-result`、`activate-analysis-plan`与`observe-run-control-state`，随后进入`await-run-terminal`。Run/Plan投影必须为`awaiting_approval + active Plan`，Case 8不得出现controlled replay，Workflow reconciliation不得出现restart/recreate repair。
6. 从Cloudflare instance API取得七条安全step标量并计算canonical digest；raw output/error只在采集进程内丢弃。再次读取并重算Case 8 report digest，再读GitHub API，确认analysis Attempt、dispatch outbox、Workflow instance和stable-title Action各为1。
7. 参照[示例manifest](../schemas/workflow-hibernate-evidence-v1.example.json)在仓库外填写`WorkflowHibernateEvidenceManifestV1`。示例值只说明形状，不是证据。

固定平台步骤顺序为：

```text
register-run
dispatch-analysis-attempt
await-analysis-result
verify-analysis-result
activate-analysis-plan
observe-run-control-state
await-run-terminal
```

前两条step及其attempt必须在wait/redeploy前完成；后三条`step.do`必须在wait结束与after deployment之后开始；最后一条wait保持未结束。步骤、attempt和deployment时间线任一倒序、wait期间额外deployment、失败step或重复Action都必须拒绝。

## 3. 显式 opt-in 验证

```text
DELIVERY_LOOP_WORKFLOW_HIBERNATE_E2E=1
WORKFLOW_HIBERNATE_EVIDENCE_FILE=<仓库外manifest绝对路径>
WORKFLOW_HIBERNATE_CONTROL_PLANE_URL=<控制面HTTPS origin>
WORKFLOW_HIBERNATE_CONTROL_PLANE_TOKEN=<Run/Plan只读短期token>
WORKFLOW_HIBERNATE_OPERATIONS_TOKEN=<Case 8只读短期token>
WORKFLOW_HIBERNATE_GITHUB_TOKEN=<试点仓库Actions只读短期token>
WORKFLOW_HIBERNATE_CLOUDFLARE_TOKEN=<Workflow/Worker deployment只读短期token>
WORKFLOW_HIBERNATE_CLOUDFLARE_ACCOUNT_ID=<目标Cloudflare account ID>
WORKFLOW_HIBERNATE_SECURITY_CANARY=<仓库外credential-shaped canary>
WORKFLOW_HIBERNATE_GITHUB_API_URL=<可选；默认https://api.github.com>
WORKFLOW_HIBERNATE_CLOUDFLARE_API_URL=<可选；默认https://api.cloudflare.com/client/v4>
```

运行：

```bash
pnpm run e2e:workflow-hibernate
```

- `0`：D1 Run/Plan/Attempt/outbox、可重算Case 8与零controlled replay、Cloudflare deployment/instance/step时间线及GitHub Action inventory全部一致；
- `1`：manifest、live投影、时间线、分页/大小边界或任一外部事实不一致；
- `2`：未显式opt-in、配置缺失或manifest不可读取。

默认exit 2在读取manifest和网络之前结束，只表示前置缺失。所有HTTPS读取固定10秒timeout、有界读取、分页fail-closed并在JSON parse前扫描token/canary。错误只输出固定code；成功summary只含安全ID、版本ID、计数与固定布尔值。

## 4. 关门证据

真实子项关门必须同时入账：verifier exit 0摘要、Cloudflare before/after deployment与同一instance的Dashboard链接、GitHub Action URL、控制面Run/Case 8安全链接，以及演练时间。人工还要核对after deployment确实由受控操作者发布、Cloudflare页面中的raw output/error没有被复制到manifest或`PROGRESS.md`。只有这些事实同时成立，才能勾选真实Cloudflare子项和父DoD。
