# GitHub / Cloudflare 平台边界真实验收

本验收回答 Phase 1 最后一个平台问题：试点 GitHub 组织和 Cloudflare Paid Workflows 是否真的能承载当前控制面设计。`pnpm run e2e:platform-limits`是严格只读 verifier；它不会触发 Action、消耗六小时 Runner、创建/restart Workflow、部署 Worker或修改组织设置。所有 probe 和恢复演练必须先由受控操作者显式执行。

schema example、fake API、本地测试、Wrangler dry-run、官方文档摘要或默认 exit 2 都不是外部完成证据。verifier exit 0 之后仍须人工核对 GitHub billing/组织设置与 Cloudflare Paid plan 的受控页面；这些管理面事实没有一个足够稳定且覆盖完整的只读 API，不能由 manifest 自报替代。

## 1. 固定官方 authority

verifier不接受manifest选择任意网页或最新分支，只读取以下官方仓库不可变commit，并核对exact path、Git blob SHA、解码后的content digest和必需条目：

| 平台 | 官方仓库 / path | 受审 commit | Git blob SHA |
|---|---|---|---|
| GitHub Actions | `github/docs` / `content/actions/reference/limits.md` | `071ed75ada2d9e80348639adfc7cca5b3902ed16` | `f492e2ebd2859b4f91546cb2f270c83c7cae669a` |
| Cloudflare Workflows | `cloudflare/cloudflare-docs` / `src/content/docs/workflows/reference/limits.mdx` | `862ae7b51ce028a30f1760e46e5d25ae76cc6832` | `926ed4527289522656999bbaa46efd8c4b98e247` |

受审 GitHub 文档固定说明：hosted job 最长6小时、workflow run最长35天、单workflow matrix最多256 jobs；standard hosted concurrency 为 Free 20、Pro 40、Team 60、Enterprise 500，larger runner通常为1000。GitHub Support可以调整并发，因此plan名称或静态表格不能证明试点组织的effective limit，必须运行饱和probe并与组织/计费页面人工review记录一致。

受审 Cloudflare Paid 表格固定为：

| 限制 | Paid 值 |
|---|---:|
| Worker script | 10 MB |
| step CPU | 默认30秒，可配至5分钟 |
| step wall clock | unlimited |
| 非stream step result / event payload | 各1 MiB |
| 单instance persisted state | 1 GiB |
| sleep | 365天 |
| steps | 默认10,000，可配至25,000 |
| active concurrent instances | 50,000 |
| create rate | 300/s/account，100/s/workflow |
| queued instances | 2,000,000 |
| completed state retention | 30天 |
| subrequests | 默认10,000，可配至10,000,000 |

同一固定Cloudflare文档后文仍写“10,000 concurrent instance limit”，与表格50,000冲突。verifier要求两处文本都存在，并在summary中返回`cloudflareConcurrencyDocumentationConflictObserved=true`；平台选型以固定commit中的规范表格记录50,000，同时必须在真实账户演练和Cloudflare支持确认中保留该冲突，不能静默改写成确定事实。

## 2. GitHub 真实组织事实

用途隔离的organization-admin只读token每次live读取：

- `GET /orgs/{org}/actions/permissions`；
- `GET /orgs/{org}/actions/permissions/workflow`；
- `GET /orgs/{org}/actions/permissions/artifact-and-log-retention`；
- `GET /organizations/{org}/settings/billing/usage?year=...&month=...`。

billing endpoint只适用于GitHub enhanced billing platform且需要组织管理员读取权限。当前官方响应是逐日usage item；verifier要求`organizationName`和月份匹配后，按`date + SKU + unit type + price`聚合并丢弃`repositoryName`，manifest不保存raw response或逐仓库记录，只保存聚合digest、原Actions item count、unit types、quantity及gross/discount/net amount。probe自身必须已出现在所选月份的Actions usage中，空数组不能假绿；billing可能延迟，需等待平台账单刷新后再验收。

GitHub App安装权限和Actions事件语义不再实现第二套verifier。平台验收直接复用一份已通过的`RunnerHeartbeatEvidenceManifestV1`，它又完整复用Analysis Action与GitHub App Dispatch evidence，覆盖selected单repo installation、固定`workflow_dispatch`、唯一job、signed final `workflow_run` webhook和live Actions API最终一致。

## 3. hosted runner 并发probe

固定[并发probe workflow](../.github/workflows/platform-concurrency-probe.yml)只有手动触发、空权限、`ubuntu-latest`和一个`sleep 300` matrix job。`slots_json`必须是1～256个唯一整数的JSON数组；不要放Task正文、Secret或用户标识。若effective limit大于等于256，应在同一短窗口并行触发多条run，manifest最多记录10条。

受控执行要求：

1. 先从组织plan、support调整记录和billing页面人工记录预期effective limit；
2. 在没有其他Actions负载的窗口提交超过该limit的总jobs；
3. 等待所有probe jobs成功；每个job必须至少运行4分钟，避免短任务的调度抖动伪装成limit；
4. verifier分页读取所有jobs，以`[started_at, completed_at)`重算跨run最大overlap；同一时刻先处理结束再处理开始；
5. `requestedJobCount > reviewedOrganizationLimit`且重算最大overlap必须等于review值。低于review值说明没有真正饱和或组织当时还有其他负载，应重选窗口，不能把较小观测冒充最大值。

每个run最多256 jobs；多个run的matrix slot名称仍必须全局唯一，否则verifier拒绝。真实运行会产生Runner分钟与可能的费用，必须先由组织owner批准预算，本命令不会代为触发。

## 4. hosted runner 6小时probe

固定[时长probe workflow](../.github/workflows/platform-duration-probe.yml)只有空权限的单个`ubuntu-latest` job：job timeout固定360分钟，唯一命令`sleep 22200`会尝试运行370分钟。验收要求Action/job以`failure`结束，started/completed时间差为355～370分钟，manifest值必须与live API毫秒级相等。不可把手动cancel、Runner进程自行exit或更短`timeout-minutes`的失败写成最大时长证据。

该probe必然占用约六小时hosted runner并可能计费，只能在明确预算授权后运行一次。verifier只读取已经存在的run。

## 5. Cloudflare create/sendEvent/restart与升级

Cloudflare运行时事实全部复用已有验收，不复制恢复协议：

- [Workflow hibernate / Worker redeploy](WorkflowHibernateE2E.md)证明同一instance由before deployment创建，在`await-analysis-result`等待期间发布after版本，经正常reference-only callback/outbox `sendEvent`后继续；七个固定step只执行一次，D1 projection与唯一Action一致；
- [受控 Replay](ControlledReplayE2E.md)证明terminal verification step通过正常API/outbox调用Workflow restart，approval/effect snapshot重新核对，Action、PR和Deployment不重复；
- 当前manifest只保存三份子证据ID、Cloudflare account digest、Paid plan review时间/URL和固定限制标量。三份完整子manifest均在仓库外独立读取并重新运行原verifier，ID或repository/account绑定不一致即失败。

Cloudflare Dashboard中的Paid plan、deployment/instance/restart链接仍须人工review。API与D1 evidence可以证明运行事实，但不能单独证明账单plan、数据驻留或合规结论。

## 6. 仓库外manifest与运行

先按上述步骤生成三份既有manifest，再参考[platform limits示例](../schemas/platform-limits-evidence-v1.example.json)生成不超过64 KiB的主manifest。所有四份manifest不得保存token、JWT、App private key、Task/PRD、raw billing/API、Action log、Workflow output/error或数据库行。

主配置：

```bash
export DELIVERY_LOOP_PLATFORM_LIMITS_E2E=1
export PLATFORM_LIMITS_EVIDENCE_FILE=/absolute/path/outside/repo/platform-limits.json
export PLATFORM_LIMITS_GITHUB_ORG_TOKEN='short-lived-org-policy-and-billing-read-token'
# GitHub Enterprise测试端点可选；必须为安全HTTPS origin
export PLATFORM_LIMITS_GITHUB_API_URL=https://api.github.com
```

然后按[Runner heartbeat](RunnerHeartbeatE2E.md)、[Workflow hibernate](WorkflowHibernateE2E.md)和[Controlled Replay](ControlledReplayE2E.md)设置其既有`*_EVIDENCE_FILE`、控制面query/operations token、GitHub App/audit token、Cloudflare只读token与manifest外Runner contract digest。平台命令直接复用这些变量：

```bash
pnpm run e2e:platform-limits
```

退出码固定：

- `0`：固定官方blob、组织策略、Actions billing聚合、并发/时长probe及三份既有live evidence全部一致；
- `1`：schema、digest、policy/billing、probe时间线、分页/大小、子证据或任一live事实不一致；
- `2`：未显式opt-in、缺配置或任一manifest文件不可读；在网络前结束。

成功summary只含安全组织/repository、时长/并发/计费计数与固定布尔值。credential只进Authorization header，固定错误不传播raw response。

## 7. DoD入账

父项只有在以下事实同时写入`PROGRESS.md`后才能勾选：命令exit 0与时间、两个probe的Actions URL/immutable SHA/job count/overlap/时长、组织policy与billing人工review链接、App installation与signed event证据、Cloudflare Paid plan及hibernate/redeploy/restart Dashboard链接、三份子证据安全summary、预算owner和reviewer。还需人工检查probe日志和manifest零Secret，并明确记录Cloudflare 50,000/10,000文档冲突的处置结论。

当前无remote、试点组织/App、已部署控制面或Cloudflare Paid账户时，只能关闭“真实外部证据验收契约”子项，不能把本地绿色测试或默认exit 2写成平台实测。
