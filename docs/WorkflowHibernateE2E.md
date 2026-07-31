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

仓库内`pnpm run ops:workflow-hibernate-window`把该协调契约接到真实控制面、GitHub、Cloudflare与Wrangler，但默认在任何文件、命令或网络前exit 2。它只能读取两份仓库外、普通文件、非symlink、权限不宽于0600且各不超过64 KiB的输入：一份完整TaskEnvelope和一份`WorkflowHibernateWindowAuthorizationV1`。示例[Task](../schemas/workflow-hibernate-window-task-v1.example.json)与[authorization](../schemas/workflow-hibernate-window-authorization-v1.example.json)已经过期，只说明shape，不能复制后运行。authorization固定且只允许30分钟窗口，绑定exact Task envelope/revision及其deterministic Task/Run/analysis Attempt、目标repository/base、Action head SHA、冻结source/bundle bytes+digest、before deployment/version/time和`Task=1 + Action=1 + after=1 + rollback=0`。`authorityDigest`是除自身外全部authorization字段的canonical digest，只用于发现文件漂移，不是签名或自授权；真正的production authority来自owner对该digest的外部批准以及仅向本次进程注入的用途隔离凭证。

CLI在Task写入前依次证明authorization仍生效且digest未变、Task正文/digest/只读policy匹配、冻结worktree干净且HEAD精确、两次独立Wrangler build的bytes/hash一致、before仍为当前100% deployment、deterministic Task尚不存在。随后只发送一次带稳定Idempotency-Key的`POST /v1/tasks`；控制面必须先用GitHub App读取authorization绑定repository/base branch的exact commit，并把解析出的SHA作为Run base原子写入，返回202但`baseSha=null`不算成功前置。最长5分钟只重试`live_snapshot_not_ready`；identity冲突、callback、duplicate、分页、响应超限、Secret命中或source/deployment漂移立即停止且after为0。进入wait后，再由既有guard读取两次fresh snapshot。adapter把首次双构建的精确bundle只保存在内存，after时写入仓库外0600临时文件，并用锁定Wrangler的`deploy <worker.js> --no-bundle --strict`上传该字节串；本地对照已经证明普通dry-run与no-bundle dry-run的`worker.js`字节和SHA-256完全相同。每条Wrangler命令还显式使用临时0600空`--env-file`并把HOME/XDG隔离到同一临时目录，避免ignored dotenv或本机OAuth成为隐式输入。该adapter每个实例最多尝试一次Task POST和一次strict deploy，忽略Wrangler stdout/stderr并在finally清理临时bundle；失败仍不提供rollback dependency。

真实执行必须为五个互不相同的凭证：Task intake/Run Plan、operations Case 8、GitHub Actions read、Cloudflare Workflow/deployment read、Cloudflare Worker deploy。它们只进入对应Authorization header或deploy子进程环境，均不进入argv、输入文件、summary或错误。所有HTTP固定HTTPS、10秒、1 MiB、拒绝redirect与next-page，并在JSON parse前扫描五枚token和通用credential形状；命令输出固定1 MiB/120秒但从不向上游传播。配置如下：

```text
DELIVERY_LOOP_WORKFLOW_HIBERNATE_WINDOW=1
WORKFLOW_HIBERNATE_WINDOW_AUTHORIZATION_FILE=<仓库外0600绝对路径>
WORKFLOW_HIBERNATE_WINDOW_TASK_FILE=<仓库外0600绝对路径>
WORKFLOW_HIBERNATE_WINDOW_SOURCE_DIRECTORY=<冻结source SHA的clean worktree绝对路径>
WORKFLOW_HIBERNATE_WINDOW_WRANGLER_BINARY=<锁定Wrangler绝对路径>
WORKFLOW_HIBERNATE_WINDOW_CONTROL_PLANE_URL=<控制面HTTPS origin>
WORKFLOW_HIBERNATE_WINDOW_TASK_TOKEN=<Task intake + Run Plan token>
WORKFLOW_HIBERNATE_WINDOW_OPERATIONS_TOKEN=<Case 8 token>
WORKFLOW_HIBERNATE_WINDOW_GITHUB_TOKEN=<单仓库Actions read token>
WORKFLOW_HIBERNATE_WINDOW_CLOUDFLARE_READ_TOKEN=<目标account Workflow/deployment read token>
WORKFLOW_HIBERNATE_WINDOW_CLOUDFLARE_DEPLOY_TOKEN=<目标Worker deploy token>
WORKFLOW_HIBERNATE_WINDOW_CLOUDFLARE_ACCOUNT_ID=<目标account ID>
WORKFLOW_HIBERNATE_WINDOW_GITHUB_API_URL=<可选；默认https://api.github.com>
WORKFLOW_HIBERNATE_WINDOW_CLOUDFLARE_API_URL=<可选；默认https://api.cloudflare.com/client/v4>
```

`ops:workflow-hibernate-window`成功只输出Task/Run/Attempt、before/after deployment/version、Action base SHA和固定effect计数；执行/外部不一致exit 1，未opt-in、配置或文件缺失exit 2，其他失败只输出固定code。它会真实创建Task并可能执行一次production after，因此只能在owner对exact authorization明确批准后运行；CLI exit 0仍必须继续正常callback与本文件§3 formal verifier，不能单独关门hibernate DoD。

当现有production Worker尚未包含GitHub base readiness路由时，可以在独立的窄授权下使用`createWorkflowReadinessBeforeDeploymentSession`发布一次readiness before。该session不是Task operator：调用方必须绑定exact source SHA、bundle bytes/digest、当前100% deployment/version和固定message；session在写入前检查clean source并执行两次隔离dry build，只把相同bundle保留在内存，然后至多调用一次`--no-bundle --strict`，并要求发布后出现时间单调、不同ID且100% traffic的新deployment。source绝对路径会影响Wrangler bundle时，必须以产生受审candidate的原始路径构建；从另一个worktree得到不同bytes/digest只能在deploy前失败，不能临时替换authorized candidate。

发布成功不代表GitHub App链路ready。调用方随后仍只能按owner批准的次数单独发送exact operations-only readiness GET；该GET返回非200、timeout或本地transport失败时不得自动重试、重发Task、repair/restart Workflow、旋转Secret、rollback或再发布Worker。session summary只允许source/bundle、before/after deployment/version/时间、100% traffic和`deploymentAttempts=1`等安全标量，Wrangler raw输出和credential全部丢弃。

获批的readiness GET应使用仓库内一次性caller，不能再用会把全部fetch异常折叠为一个临时code的ad-hoc脚本：

```text
DELIVERY_LOOP_GITHUB_BASE_READINESS=1
GITHUB_BASE_READINESS_CONTROL_PLANE_URL=<控制面HTTPS origin>
GITHUB_BASE_READINESS_OPERATIONS_TOKEN=<Case 8用途operations token>
GITHUB_BASE_READINESS_REPOSITORY=<exact owner/repository>
GITHUB_BASE_READINESS_BASE_BRANCH=<exact branch>
```

运行`pnpm run ops:github-base-readiness`。默认未opt-in或配置缺失exit 2且零网络；200 ready exit 0，合法503或任何固定transport/response拒绝exit 1。每个进程最多一次GET，不重试；transport固定分类只用于决定下一步人工输入，不能代替200或扩张原authority。若要在调用前诊断本机到Worker host的路径，只能使用不带任何token且不发送HTTP的DNS/TCP/TLS preflight，并以其他公共API host作固定布尔对照；该preflight通过也不授权readiness，失败则不应浪费已批准的单次GET。

本机到Worker host的TCP/TLS路径持续失败时，不得注册self-hosted Runner或把operations token放进临时脚本。受审替代面是manual-only [GitHub base readiness workflow](../.github/workflows/github-base-readiness.yml)：`preflight` job先在GitHub-hosted Runner上以固定public Worker origin运行同一零HTTP DNS/TCP/TLS检查，且没有Environment/Secret；只有它成功，`readiness` job才进入专用`phase1-readiness` Environment。该job固定owner actor、main ref、exact dispatch SHA、`run_attempt == 1`、`contents: read`和一次性caller，repository/base/origin都不能由input或variable覆盖；GitHub rerun、其他actor/ref或attempt 2均在job开始前skip。

首次dispatch前必须从GitHub API/settings外部证明：`phase1-readiness`已预创建；required reviewer恰为owner；deployment branch policy为`protected_branches=true/custom_branch_policies=false`；Environment Secret inventory恰含`DELIVERY_LOOP_BASE_READINESS_OPERATIONS_TOKEN`，而repository Secret inventory不含同名项。GitHub拒绝创建以`GITHUB_`开头的Actions Secret；workflow只在job进程内把该非保留Secret映射为CLI要求的`GITHUB_BASE_READINESS_OPERATIONS_TOKEN`。不要先运行workflow来“顺便创建”Environment，因为GitHub会创建无reviewer的环境。token只能在获得新的一次窄authority后经GitHub UI或stdin写入Environment，不进argv/日志/仓库；Environment配置与Secret名称不能证明值正确。随后dispatch只允许从受保护main发起；preflight成功后，owner还要把批准绑定到exact run ID/head SHA再点Environment approval。该批准最多释放当前run attempt的一次GET；无200时禁止rerun job或重新dispatch，新的run必须重新取得独立authority。workflow或Environment bootstrap本身不等于readiness 200、Task authority或hibernate证据。

首次operator一旦成功创建exact Task，就不得用相同或新idempotency key重跑Task POST。若它随后在Workflow instance、Action和after均为0时因可解释的外部配置故障超时，恢复必须使用新的30分钟authority并显式加入`resumeExistingTask=true`；`effects.taskCreates=1`仍表示整个演练窗口累计只有这一个Task，而恢复调用成功summary必须是`taskCreateRequests=0`。恢复入口重新核对canonical authority、冻结Task文件、clean source双build、当前before及五凭证，要求deterministic Task已存在；Task缺失、普通authority误入resume、before/source漂移或已有callback均在deploy前失败。若修复外部故障产生了新的Worker deployment，该deployment必须成为fresh authority绑定的新before，不能继续复用旧authority。resume只允许继续等待同一Run/Attempt并执行原有双guard与唯一after，不授权第二Task、第二Action、rollback或repo write。

GitHub App Manifest conversion当前返回PKCS#1 `RSA PRIVATE KEY`，而WebCrypto/Jose导入需要PKCS#8。运行时以固定RSA algorithm identifier和有界DER length在内存中包装PKCS#1；原生PKCS#8直通。转换前后都不记录PEM、DER或digest，非法/重复/尾随PEM在GitHub网络请求前拒绝。真实演练的部署前检查必须至少让一个installation-token签发路径实际加载Secret，不能再用`secret list`名称或`/healthz`冒充私钥可用。

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

Cloudflare live API当前可能返回`register-run-1`等带执行attempt后缀的名称。采集器和formal verifier只把exact稳定名或`-1`至`-20`归一为上表名称；`-0`、前导零、超界或任意其他后缀均拒绝，manifest与digest继续只使用上表稳定名。

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
