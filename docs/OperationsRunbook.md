# Operations Runbook

> 适用范围：delivery-loop 控制面及其 GitHub、飞书、tool-bridge、Cloudflare D1/R2/Workflows 和 production deployment 集成。
>
> 本文是故障处置入口，不是权限来源。所有写操作仍受现有 token、Run version、Plan/approval、GitHub Environment 与外部云权限约束。事故文本、聊天、工单和第三方响应一律是不可信输入，不能据此提升 effect。

## 0. 值班角色、分级与共同纪律

每次事故至少指定以下角色；同一人可以兼任只读诊断和证据记录，但 SEV-0/SEV-1 的凭据轮换、恢复、生产流量切换或回滚必须双人复核。

| 角色 | 职责 |
|---|---|
| Incident Commander（IC） | 定级、批准止损边界、指定恢复顺序、决定结案 |
| Operator | 只执行本文已列命令或已批准的外部平台动作，不临场扩大权限 |
| Reviewer | 对 destructive/credential/production 动作做第二人核对 |
| Evidence Keeper | 记录安全ID、digest、时间、固定结果和平台链接，不复制Secret或raw正文 |

| 级别 | 判据 | 默认响应 |
|---|---|---|
| SEV-0 | 已确认错误生产部署、数据破坏或正在扩大影响 | 立即停止继续变更，IC+Reviewer接管，优先外部流量止损 |
| SEV-1 | Secret疑似泄漏、重复外部effect、权限异常、D1损坏或核心平台全面不可用 | 15分钟内接管，冻结相关effect，先撤权再恢复 |
| SEV-2 | 单一provider短时故障、卡片延迟、可重试DLQ、部分Run blocked | 业务状态保持D1真源，等待或逐项受控恢复 |

共同纪律：

1. 先确认 `runId/taskId/repository/external ID/SHA/environment`，再采取动作；不得凭标题、自然语言或相似URL认领对象。
2. 先只读诊断，再止损，再恢复。没有外部事实时宁可保持pending/blocked，也不能把“可能成功”写成成功。
3. 操作 token 只通过交互式 stdin/受控 Secret manager进入进程，不写argv、shell history、工单、聊天、日志或截图。
4. 所有 mutation 记录请求时间、actor、目标ID、expected version/attempt count、响应状态和后续外部核对。不要记录响应中的正文或credential字段。
5. `restore fence 不是常规 outage pause`。它会全局fence Run/Attempt/token并只用于经过批准的D1恢复，不能拿来暂停GitHub、飞书或tool-bridge。
6. 当前没有全局 provider pause API。需要紧急冻结某个provider时，在该provider管理面暂停App/workflow/Environment/role，并对受影响Run逐一执行version-bound cancel；该动作属于外部平台人工处置。
7. `/healthz` 只证明 Worker isolate 存活，不证明D1、R2、Workflow、Queue、GitHub、飞书或tool-bridge可用。

## 1. 安全命令环境

在无命令历史记录的受控终端中设置非敏感目标；token用隐藏输入读取。退出事故终端时执行`unset OPERATIONS_TOKEN TASK_INTAKE_TOKEN`。不要启用`set -x`，不要把完整HTTP响应重定向到公共artifact。

```sh
: "${CONTROL_PLANE_ORIGIN:?set the deployed HTTPS control-plane origin}"
read -rsp 'Operations token: ' OPERATIONS_TOKEN
printf '\n'
read -rsp 'Task service token: ' TASK_INTAKE_TOKEN
printf '\n'
export OPERATIONS_TOKEN TASK_INTAKE_TOKEN
```

先做Worker liveness探针；它不能代替后续D1/provider探针。

```sh
curl --fail-with-body --silent --show-error \
  "${CONTROL_PLANE_ORIGIN:?}/healthz"
```

任何从响应复制出的ID都先按服务端约束核对：业务ID只含字母、数字、`_`、`-`；GitHub repository为`owner/name`；SHA为40位小写十六进制；外链必须是无userinfo/query/fragment的HTTPS地址。

execution raw transcript producer还要求专用私有R2 binding `RAW_AGENT_OBJECTS`与Worker Secret `RAW_AGENT_ARTIFACT_ENCRYPTION_KEY`同时存在。key必须是base64url编码的32 bytes，只能用`wrangler secret put`经stdin配置；不得写`wrangler.jsonc`、`.env`、Action变量、PR或事故记录。缺key时artifact endpoint固定503且execution fail-closed，不能临时把正文改写到checkpoint、Task bucket、Action artifact或普通日志。

## 2. 已实现控制面命令

下表是当前代码中真实存在的operations/read/recovery入口。未列出的能力不得由Runbook文字“创造”。`TASK_INTAKE_TOKEN`虽然名称沿用intake，但当前也保护Task/Run只读查询与version-bound cancel/retry；`OPERATIONS_TOKEN`只保护DLQ、backup/restore、Case 8 audit、retention与飞书卡片安全查询/刷新。

| Method | Path | 身份 | 作用与边界 |
|---|---|---|---|
| `GET` | `/v1/dead-letters` | operations | 只列固定状态、ID、destination、attempt count和安全错误码 |
| `POST` | `/v1/dead-letters/:deadLetterId/replay` | operations | 只以exact outbox attempt count重放原outbox，不接受payload/effect |
| `GET` | `/v1/runs/:runId/feishu-card` | operations | 只读latest/delivered presentation、outbox与message安全ID/状态，不返回tenant/chat/card正文 |
| `POST` | `/v1/runs/:runId/feishu-card/refresh` | operations | exact current presentation/revision/digest创建新immutable presentation/outbox，不接受message/card/effect/reason |
| `GET` | `/v1/correlations` | task service | 从Task/Run/Attempt/GitHub run/PR/deployment/trace安全ID定位唯一Run |
| `GET` | `/v1/runs/:runId/plan` | task service | 读取D1 Run/Plan/Attempt/Evidence/incident/deployment安全投影 |
| `POST` | `/v1/runs/:runId/cancel` | task service | 以expected Run version撤销active Attempt/token并创建fenced cancel intent |
| `POST` | `/v1/runs/:runId/retry` | task service | 仅对满足blocked/lost/checkpoint/Plan条件的Run调度replacement Attempt |
| `GET` | `/v1/runs/:runId/audit` | operations | 读取八栏Case 8 D1-only报告并记录本次access |
| `GET` | `/v1/backups` | operations | 读取安全backup manifest索引；也是比healthz更强的D1只读探针 |
| `POST` | `/v1/restores/:restoreId/fence` | operations | 经manifest验证后进入全局restoring并撤销authority |
| `GET` | `/v1/restores/:restoreId` | operations | 查询restore generation、状态和安全一致性分类 |
| `POST` | `/v1/restores/:restoreId/complete` | operations | 九类一致性和零active credential全部通过后才恢复serving |

常用只读查询：

```sh
: "${RUN_ID:?set an exact Run ID}"
curl --fail-with-body --silent --show-error \
  -H "authorization: Bearer ${TASK_INTAKE_TOKEN:?}" \
  "${CONTROL_PLANE_ORIGIN:?}/v1/runs/${RUN_ID:?}/plan"

curl --fail-with-body --silent --show-error \
  -H "authorization: Bearer ${OPERATIONS_TOKEN:?}" \
  "${CONTROL_PLANE_ORIGIN:?}/v1/runs/${RUN_ID:?}/audit"
```

按GitHub PR/deployment定位Run时必须携带repository scope；其他kind使用同一路由但必须省略`repository`参数：

```sh
: "${CORRELATION_KIND:?set a supported correlation kind}"
: "${CORRELATION_ID:?set the exact external ID}"
: "${REPOSITORY:?set the exact owner/name scope for github_pr or github_deployment}"
curl --fail-with-body --silent --show-error --get \
  -H "authorization: Bearer ${TASK_INTAKE_TOKEN:?}" \
  --data-urlencode "kind=${CORRELATION_KIND:?}" \
  --data-urlencode "id=${CORRELATION_ID:?}" \
  --data-urlencode "repository=${REPOSITORY:?}" \
  "${CONTROL_PLANE_ORIGIN:?}/v1/correlations"
```

列出DLQ；只允许`status=open|replay_requested|resolved`和`limit<=100`：

```sh
curl --fail-with-body --silent --show-error \
  -H "authorization: Bearer ${OPERATIONS_TOKEN:?}" \
  "${CONTROL_PLANE_ORIGIN:?}/v1/dead-letters?status=open&limit=100"
```

取消单个Run是止损写操作，执行前必须从最新Plan响应取得`version`并由第二人核对。409表示状态已变化，必须重新只读查询，不能盲重试旧version。

```sh
: "${RUN_ID:?set an exact Run ID}"
: "${EXPECTED_RUN_VERSION:?set the latest numeric Run version}"
case "${EXPECTED_RUN_VERSION}" in ''|*[!0-9]*) exit 2 ;; esac
curl --fail-with-body --silent --show-error \
  -X POST \
  -H "authorization: Bearer ${TASK_INTAKE_TOKEN:?}" \
  -H 'content-type: application/json' \
  --data "{\"expectedRunVersion\":${EXPECTED_RUN_VERSION:?}}" \
  "${CONTROL_PLANE_ORIGIN:?}/v1/runs/${RUN_ID:?}/cancel"
```

DLQ恢复必须从list响应复制同一条`id + outboxAttemptCount`，一次只放行一个，先观察外部事实再继续下一条。

```sh
: "${DEAD_LETTER_ID:?set an exact dead-letter ID}"
: "${EXPECTED_OUTBOX_ATTEMPT_COUNT:?set the listed numeric attempt count}"
: "${REPLAY_REASON_CODE:?use upstream_recovered or configuration_fixed}"
case "${EXPECTED_OUTBOX_ATTEMPT_COUNT}" in ''|*[!0-9]*) exit 2 ;; esac
case "${REPLAY_REASON_CODE}" in upstream_recovered|configuration_fixed) ;; *) exit 2 ;; esac
curl --fail-with-body --silent --show-error \
  -X POST \
  -H "authorization: Bearer ${OPERATIONS_TOKEN:?}" \
  -H 'content-type: application/json' \
  --data "{\"expectedOutboxAttemptCount\":${EXPECTED_OUTBOX_ATTEMPT_COUNT:?},\"reasonCode\":\"${REPLAY_REASON_CODE:?}\"}" \
  "${CONTROL_PLANE_ORIGIN:?}/v1/dead-letters/${DEAD_LETTER_ID:?}/replay"
```

## IR-GITHUB — GitHub 故障

### 触发与分级

- SEV-2：GitHub API/Actions短时5xx或timeout、`github_*` destination outbox进入DLQ、queued/deploying stuck incident出现，但未观察到重复或越权effect。
- SEV-1：401/403持续出现、GitHub App权限/installation漂移、外部run/PR/deployment与D1绑定不一致，或同一stable identity疑似产生重复PR/部署。401/403先按credential/configuration incident处理，不能笼统归因于provider outage。
- SEV-0：错误production effect正在执行，立即转`IR-WRONG-PRODUCTION-DEPLOYMENT`。

### 只读诊断

1. 用Task/Run/Attempt/GitHub run/PR/deployment ID调用correlation查询，固定唯一Run和repository scope；多Run或404时停止，不按URL标题猜测。
2. 查询Run Plan和Case 8 audit，核对Run version、active Plan/digest、Attempt status/generation、outbox/dead-letter、PR/deployment ID、exact SHA、approval和Evidence。不要读取R2正文或Workflow output。
3. 从GitHub Status、Actions/PR/Deployments只读页面或独立read token核对外部事实。控制面`reported`、Runner输出、create响应或HTTP timeout都不是GitHub终态。
4. 列出open DLQ并按`destination`筛选`github_actions/github_api/github_deployments/github_acceptance/github_test_rollback/github_production_deployments`；不提交自选destination。

### 止损与授权

当前没有全局 provider pause API。SEV-1需要冻结GitHub写入时，由IC在GitHub管理面暂停对应workflow、禁用App installation或收紧Environment，并记录外部审计链接；这是外部平台人工处置。对已知active Run逐一使用最新version执行cancel，使attempt/tool token撤销、write credential进入revocation路径和旧Workflow被fence。不要为普通5xx取消所有Run，也不要使用restore fence。

若怀疑App private key、installation token或webhook secret泄漏，立即进入`IR-SECRET`；在旧`GITHUB_CREDENTIAL_ENCRYPTION_KEY`仍可用时先让scheduled revoker撤销已签发token，再轮换加密key。重复PR/部署时先在GitHub外部阻止继续执行，保留两个外部ID和stable control-plane identity，不删除任何一方记录。

### 恢复

provider outage恢复后先等待一分钟Cron读取GitHub外部事实；它会核对Actions run、PR/base/merge/check、test/production deployment、acceptance/rollback并送回原projector。只有DLQ仍open且外部没有已成功effect时，才用list返回的exact attempt count逐条请求`upstream_recovered` replay。401/403修复后使用`configuration_fixed`；相同dead letter重复请求只应返回同一replay ID。

对blocked Runner的恢复不能用DLQ replay替代。只有Run查询证明blocked、旧Attempt lost、Workflow cancel settled、active Plan/Item和checkpoint仍有效时，才按`POST /v1/runs/:runId/retry` strict schema提交exact Run/Plan/Item版本；否则创建新Task revision或升级人工处理。

### 验证与结案

结案必须同时满足：GitHub read API/页面确认exact repository+SHA+run/PR/deployment事实；D1 Plan投影与外部状态一致；相关outbox settled、dead letter resolved；没有新增open stuck incident；Case 8 report中的changes/checks/deployments与外部ID一致。连续观察至少两个Cron周期，不以单次200或Agent自报作为恢复证明。

### 证据

记录incident ID、SEV、IC/Reviewer、Run/Task/Attempt、repository、Plan digest、head/merge SHA、GitHub run/PR/deployment数字ID、dead-letter/replay ID、查询时间、去query的GitHub链接、Case 8 report digest和最终状态。不得保存App private key、installation token、webhook payload、PR正文、日志正文或GitHub raw REST response。

### 禁止项

- 禁止盲重放timeout后的create/dispatch；必须先reconcile stable identity。
- 禁止通过改D1、改outbox destination或伪造webhook“修复”GitHub状态。
- 禁止把GitHub App权限临时扩大到组织全部仓库。
- 禁止把`healthz`、Workflow status或Runner success当作GitHub effect成功。

## IR-FEISHU — 飞书故障

### 触发与分级

- SEV-2：卡片presentation长期pending、已知message PATCH结果未结算、`feishu_cards` destination进入DLQ、飞书429/5xx或tenant token暂时不可用。
- SEV-1：tenant/chat/app/message exact binding漂移、token-invalid持续出现、来源事件或审批身份无法验真、Secret疑似泄漏，或同一Run出现无法解释的多张活跃卡片。
- 飞书展示延迟不等于Run停滞；D1 Run/Plan仍是业务真源。先区分“消息未进入控制面”“Run已推进但卡片未更新”“POST/PATCH外部成功但响应丢失”。

### 只读诊断

1. 查询Task/Run Plan，核对`feishuCards`安全投影、latest/delivered revision、active message ID、presentation/outbox/delivery/observation状态；不要从群聊天正文推断控制面状态。
2. 列出open DLQ，筛选`feishu_cards` destination，并核对同一Run/outbox attempt count。
3. 对已有message ID，等待或观察每分钟reconciler通过官方message GET核对exact tenant/chat/app/message、`interactive`、未删除和latest card digest。它只结算原presentation，不创建新消息。
4. 若是入站/credential链路，按Watt事故复盘的分段思想核对：Worker liveness → provider credential/challenge → 预先批准的测试tenant无扰探针 → D1安全投影。每段单独采证，不得等待自然流量。

### 止损与授权

当前没有全局 provider pause API。身份验签或卡片内容绑定异常时，在飞书应用管理面暂停对应订阅/机器人或撤销受影响Secret，并对可能被错误审批/取消的Run按latest version逐一cancel；这是外部平台人工处置。普通发送outage不应取消正常Run，控制面可以继续推进并让卡片稍后收敛。

若首次POST响应在message ID入账前丢失，不得搜索群历史或按相似正文认领消息；原producer使用最长一小时稳定UUID重试。若已知message ID的PATCH响应丢失，保留pending让exact GET reconciliation收敛，不手工创建第二张卡。Secret轮换转入`IR-SECRET`并保持旧/新依赖顺序。

### 恢复

限流/timeout/5xx恢复后先观察两个Cron周期。仍在DLQ的原outbox可按exact attempt count逐条以`upstream_recovered` replay；修复app/tenant/chat配置或Secret后使用`configuration_fixed`。这些可重试故障必须继续使用原outbox，不要创建refresh。飞书token cache在token-invalid时会清除并重新获取；Operator不应把tenant token复制到工单或D1。

只有latest outbox已因业务拒绝terminal settle，或配置/平台问题修复后必须重建相同事实的最终卡片时，才使用人工refresh。先读取安全快照，把返回的latest三元组分别放入受控shell变量；不得提交新的card body、message ID、destination、effect或reason。

```sh
: "${RUN_ID:?set exact Run ID}"
curl --fail-with-body --silent --show-error \
  -H "authorization: Bearer ${OPERATIONS_TOKEN:?}" \
  "${CONTROL_PLANE_ORIGIN:?}/v1/runs/${RUN_ID:?}/feishu-card"

: "${EXPECTED_PRESENTATION_ID:?copy latest.presentationId}"
: "${EXPECTED_REVISION:?copy latest.revision}"
: "${EXPECTED_DIGEST:?copy latest.digest}"
REFRESH_BODY=$(printf \
  '{"expectedPresentationId":"%s","expectedRevision":%s,"expectedDigest":"%s"}' \
  "${EXPECTED_PRESENTATION_ID:?}" "${EXPECTED_REVISION:?}" "${EXPECTED_DIGEST:?}")
curl --fail-with-body --silent --show-error \
  -X POST \
  -H "authorization: Bearer ${OPERATIONS_TOKEN:?}" \
  -H 'content-type: application/json' \
  --data "${REFRESH_BODY:?}" \
  "${CONTROL_PLANE_ORIGIN:?}/v1/runs/${RUN_ID:?}/feishu-card/refresh"
unset REFRESH_BODY EXPECTED_PRESENTATION_ID EXPECTED_REVISION EXPECTED_DIGEST
```

相同snapshot重试会返回同一request/presentation/outbox；从未请求过的旧snapshot返回409。刷新保留旧rejected delivery并创建新outbox。若POST响应丢失，只需重新GET核对或等待Cron；已落库request会自动完成投影，不要再次手工发消息。

本项目采用从Watt 476e3cdd2490d725fde174e7c697ebf00899edc6事故复盘直接提炼的强制纪律：`重签依赖凭据 → 通过 stdin 更新 Secret → 分段探测`。不得等待自然流量，也不运行会覆盖完整配置的 setup；只更新受影响凭据和最小绑定，传播窗口后立即用测试tenant探针及D1投影闭环。

### 验证与结案

结案要求latest presentation已delivery、message/chat/app/digest exact一致、相关outbox settled/dead letter resolved、旧凭据不可用、新测试探针通过，并确认没有重复active message ID。Run状态从D1 Plan查询核对，审批类事故还需Case 8 report确认actor/source/approval没有漂移。至少观察两个Cron周期和一条受控测试消息，不以“用户之后可能会发消息”代替验证。

### 证据

记录incident/SEV/actor、tenant/chat/message安全ID、Run/Task、presentation/delivery/observation/outbox/dead-letter/replay ID、card digest、provider固定错误码、探针时间和无query平台链接。禁止记录tenant access token、app secret、消息/卡片正文、用户open_id之外的个人内容、raw飞书response或群截图中的敏感文本。

### 禁止项

- 禁止模糊搜索群历史认领未知message，禁止手工复制卡片正文重发。
- 禁止为了修复token运行可能整体覆盖definitions/grants/tenant配置的setup。
- 禁止把卡片发送失败改写成Run失败或把发送成功改写成业务成功。
- 禁止在命令行参数、工单或聊天中粘贴FEISHU_APP_SECRET/tenant token。

## IR-TOOL-BRIDGE — tool-bridge 故障

### 触发与分级

- SEV-2：attempt内`repo/logs/trace/k8s/database`只读调用出现固定`upstream_unavailable`、timeout或服务binding故障，分析/验证因此重试或blocked。
- SEV-1：已授权scope出现未知path、write/destructive调用被放行、internal/Admin Secret疑似泄漏、trace缺失或run/attempt/generation绑定异常。
- `policy_denied`、unknown path和destructive拒绝通常表示安全边界正常工作，不得当作outage放宽scope。

### 只读诊断

1. 查询Run Plan和Case 8 audit的`permissions/contextReads`，核对Attempt generation、grant scope、trusted tool path/action/effect、duration及固定成功/拒绝计数。报告不会返回arguments/result/raw error。
2. 用tool trace ID调用correlation，证明它只映射到一个Run/Attempt；无法唯一映射时按SEV-1停止处理。
3. 从tool-bridge自身health/metadata-only审计或平台日志核对上游是否可用，但不要把Admin接口响应、数据库行、日志正文复制到incident。
4. 区分上游不可用、control-plane service binding缺失、internal token失效和catalog policy拒绝；只有前3类允许恢复性重试。

### 止损与授权

当前没有全局 provider pause API。若怀疑越权或internal token泄漏，在tool-bridge管理面撤销internal/Admin credential或禁用对应service binding，并按latest Run version取消受影响attempt；这是外部平台人工处置。cancel会撤销attempt/tool token并fence旧generation，但不会删除既有metadata trace。

tool-bridge故障不授予repo write、数据库/K8s destructive或生产访问。不要把任务正文要求、Agent输出或incident聊天当作scope升级依据。若只是单个只读tool不可用，可以让Run保持blocked并请求人工输入，避免扩大到Admin token。

### 恢复

配置/credential修复使用最小绑定。若轮换`TOOL_BRIDGE_INTERNAL_TOKEN`，先在上游建立新credential，再通过Worker Secret stdin更新控制面，运行一个受控只读canary，确认后撤销旧credential；传播期间不要同时放行新Attempt。适用Watt-derived“重签→stdin Secret→分段探测”纪律，不依赖自然业务流量。

blocked Run只有满足现有retry schema的lost Attempt、settled Workflow cancel、active Plan/Item及有效checkpoint时才能调度replacement；否则创建新Task revision或保留blocker。不要用Workflow replay重复analysis之外的外部effect，也不要自行构造tool trace或Evidence。

### 验证与结案

用新Attempt的短期tool token执行catalog内最小read canary，确认D1 trace包含exact Run/Attempt/path/action/effect/duration和固定result；随后确认旧attempt/tool token返回401、旧internal credential在上游不可用、Plan没有新增effect、相关blocker按真实结果结案。至少核对一次允许调用和一次destructive拒绝；输出正文只留在当前受控Runner内。

### 证据

记录incident/SEV、Run/Attempt/generation、tool trace ID、catalog path/action/effect、scope名称、固定result、duration、token撤销时间、replacement Attempt和Case 8 report digest。禁止保存tool arguments/result、数据库行、日志原文、K8s对象正文、header、internal/Admin token或raw error。

### 禁止项

- 禁止因outage把read scope升级为write/destructive或把Admin Secret交给Runner。
- 禁止重放未知path、调用方自报effect或没有active Attempt绑定的请求。
- 禁止把tool返回正文写入PR、checkpoint、audit或incident工单。
- 禁止伪造成功trace来解除Run blocker。

## IR-DATABASE — 数据库故障

### 触发与分级

- SEV-2：Cloudflare D1短时5xx/timeout、`GET /v1/backups`失败而`/healthz`仍200、Queue因D1不可用持续retry，但没有完整性异常。
- SEV-1：D1数据损坏、foreign-key/Task-Run-Plan-Approval-Evidence lineage不一致、错误迁移、需要Time Travel/import，或恢复后存在不明active token/credential。
- 先区分“服务暂不可用”和“数据错误”。provider outage不应触发destructive restore；恢复入口只服务已批准、已选定backup/manifest的灾备。

### 只读诊断

1. `/healthz`只测Worker。使用`GET /v1/backups?limit=5`作为受控D1查询；若也失败，结合Cloudflare D1/Workers/Queues状态页和只读observability确认范围。
2. D1可读时查询受影响Run Plan与Case 8 audit，记录Run/Plan/Attempt/token/credential安全投影；不要执行临时SQL或导出整库到本地。
3. 读取backup列表，核对backup ID、manifest digest、bookmark、object count/bytes和created time。D1 dump、signed URL和R2正文不能进入incident记录。
4. 需要恢复时先由IC+Reviewer确认恢复点、业务影响、Cloudflare账户/数据库identity和外部traffic isolation方案。

```sh
curl --fail-with-body --silent --show-error \
  -H "authorization: Bearer ${OPERATIONS_TOKEN:?}" \
  "${CONTROL_PLANE_ORIGIN:?}/v1/backups?limit=5"
```

### 止损与授权

普通D1 outage期间让Worker请求失败、Queue retry和Workflow等待，不执行restore。需要destructive Time Travel/import时，先在Cloudflare edge/deployment面阻断普通业务入口和scheduled/Queue消费；当前控制面没有独立pre-import maintenance API，这是外部平台人工处置。确认流量已隔离后，按Cloudflare官方D1 Time Travel/import流程恢复选定点，不运行任意ad-hoc SQL。

外部恢复完成后立即调用本项目restore fence，以manifest重新验证backup并把恢复出的authority全部隔离。fence会阻断普通HTTP/Queue/Cron effect、提升Attempt generation、撤销内部token并把GitHub credential置为revocation pending；它不能替代导入前的外部流量隔离。

### 恢复

从backup list复制exact`backupId + manifestDigest`，为本次演练生成不含业务含义的稳定`RESTORE_ID`。先fence，轮询状态并等待scheduled GitHub revoker完成；只有九类一致性与零active credential全部passed时才complete。409必须重新GET状态，不得改manifest或跳过检查。

```sh
: "${RESTORE_ID:?set the approved restore ID}"
: "${BACKUP_ID:?set the exact listed backup ID}"
: "${MANIFEST_DIGEST:?set the exact sha256 manifest digest}"
curl --fail-with-body --silent --show-error \
  -X POST \
  -H "authorization: Bearer ${OPERATIONS_TOKEN:?}" \
  -H 'content-type: application/json' \
  --data "{\"backupId\":\"${BACKUP_ID:?}\",\"manifestDigest\":\"${MANIFEST_DIGEST:?}\"}" \
  "${CONTROL_PLANE_ORIGIN:?}/v1/restores/${RESTORE_ID:?}/fence"

curl --fail-with-body --silent --show-error \
  -H "authorization: Bearer ${OPERATIONS_TOKEN:?}" \
  "${CONTROL_PLANE_ORIGIN:?}/v1/restores/${RESTORE_ID:?}"
```

确认GET显示所有检查passed且无pending credential后，由双人复核执行complete：

```sh
curl --fail-with-body --silent --show-error \
  -X POST \
  -H "authorization: Bearer ${OPERATIONS_TOKEN:?}" \
  -H 'content-type: application/json' \
  --data "{\"backupId\":\"${BACKUP_ID:?}\",\"manifestDigest\":\"${MANIFEST_DIGEST:?}\"}" \
  "${CONTROL_PLANE_ORIGIN:?}/v1/restores/${RESTORE_ID:?}/complete"
```

### 验证与结案

complete成功后重新执行backup list、代表性Task/Run Plan和Case 8 audit；核对Task/Run/Plan/Approval/Evidence/Audit、foreign key、R2 descriptors和Workflow status projection一致。确认恢复前active attempt/tool token均401、GitHub write credential已撤销、Queue恢复消费且没有重复dispatch/PR/deploy。观察至少两个Cron周期；远端D1 restore链接、RTO/RPO和数据窗口必须入账，不能用本地workerd演练替代。

### 证据

记录incident/SEV、数据库identity、批准人、traffic isolation时间、backup/restore ID、manifest digest、bookmark、fence generation、九类check固定结果、token/credential撤销计数、complete时间、RTO/RPO和Cloudflare审计链接。不记录SQL dump、D1行、Task正文、R2 key/body、signed URL、token digest/ciphertext或provider raw error。

### 禁止项

- 禁止把`/healthz` 200当作D1健康，禁止因短时outage执行restore。
- 禁止手写UPDATE/DELETE修业务状态、跳过foreign-key/lineage检查或在pending credential时complete。
- 禁止把restore API当任意SQL/R2恢复接口；它只接受服务端可推导的backup/manifest identity。
- 禁止在未做外部traffic isolation时执行destructive Time Travel/import。

## IR-SECRET — Secret 泄漏

### 触发与分级

任何明文credential出现在日志、artifact、PR、卡片、checkpoint、audit、聊天、工单、终端录屏或不可信输入，或provider报告key/token被滥用，立即定为SEV-1；已造成production mutation则升级SEV-0并同时进入错误部署流程。不要在告警/工单中重复粘贴Secret来“证明”泄漏，记录Secret名称、来源类别、首次/最后暴露时间和安全finding digest即可。

受影响面至少分类：`OPERATIONS_TOKEN`、`TASK_INTAKE_TOKEN`、`APPROVAL_ADAPTER_TOKEN`、`GITHUB_WEBHOOK_SECRET`、GitHub App private key/installation token、`GITHUB_CREDENTIAL_ENCRYPTION_KEY`、`FEISHU_APP_SECRET`、`FEISHU_EVENT_ENCRYPT_KEY`、`FEISHU_EVENT_VERIFICATION_TOKEN`、`MONITOR_WEBHOOK_SECRET`、`TOOL_BRIDGE_INTERNAL_TOKEN`、`D1_BACKUP_API_TOKEN`、`RAW_AGENT_ARTIFACT_ENCRYPTION_KEY`、Agent/model credential。该列表与代码中的唯一Worker Secret catalog一致；每类撤销方、传播窗口和旧凭据验证方式不同。

### 只读诊断

1. 停止传播：限制incident频道和artifact访问，不下载整份日志；用现有Secret scanner/finding定位path+kind，不输出命中值。
2. 查询受影响时间窗内Run Plan、correlation和Case 8 audit，收集actor/source/permission/effect/credential状态与外部IDs。不要读取R2原文或credential ciphertext。
3. 在provider安全审计面核对key使用、App installation、webhook、Environment、云role和最近mutation；只保存安全链接/ID/digest。
4. 识别依赖链。尤其GitHub write token密文仍需旧encryption key才能由scheduled revoker解密撤销；不能先把旧key销毁。

### 止损与授权

IC决定credential级隔离，Reviewer核对。先在签发/消费provider撤销或禁用受影响authority，再更新控制面Secret；对受影响active Run逐一latest-version cancel。`OPERATIONS_TOKEN`泄漏时先在Cloudflare访问层限制operations路径，再轮换；`TASK_INTAKE_TOKEN`泄漏时阻断Task入口和Run人工动作；GitHub App key泄漏时在GitHub撤销key/installation；飞书/tool-bridge/云role同样先在其信任根侧止损。

`GITHUB_CREDENTIAL_ENCRYPTION_KEY`泄漏但仍可用时，先保留它仅供scheduled revoker解密并撤销全部受影响GitHub installation token，确认credential状态revoked/ciphertext清空后再轮换。若旧key已丢失或攻击者可能掌握密文，必须在GitHub撤销App key/installation，从provider侧使所有派生token失效。

### 恢复

每个Secret执行同一受控骨架：provider重签/撤销旧authority → 通过stdin更新Worker/上游Secret → 分段canary → 明确验证旧值失效。该纪律直接复用Watt 476e3cdd2490d725fde174e7c697ebf00899edc6的真实飞书pluginToken事故结论：`重签依赖凭据 → 通过 stdin 更新 Secret → 分段探测`，不得等待自然流量；不运行会覆盖完整配置的 setup。

Worker Secret只通过交互提示输入，命令中不带value、不启用shell trace。每次只轮换一个依赖组并观察传播；双端token先让消费者接受新值，再切生产者，最后撤销旧值，避免同时失联。

```sh
: "${SECRET_NAME:?set one approved Worker Secret name}"
case "${SECRET_NAME}" in
  OPERATIONS_TOKEN|TASK_INTAKE_TOKEN|APPROVAL_ADAPTER_TOKEN|GITHUB_WEBHOOK_SECRET|\
  GITHUB_APP_PRIVATE_KEY|GITHUB_CREDENTIAL_ENCRYPTION_KEY|FEISHU_APP_SECRET|\
  FEISHU_EVENT_ENCRYPT_KEY|FEISHU_EVENT_VERIFICATION_TOKEN|MONITOR_WEBHOOK_SECRET|\
  TOOL_BRIDGE_INTERNAL_TOKEN|D1_BACKUP_API_TOKEN|RAW_AGENT_ARTIFACT_ENCRYPTION_KEY) ;;
  *) exit 2 ;;
esac
pnpm exec wrangler secret put "${SECRET_NAME:?}"
```

代码/配置修复后运行本地静态安全关口；它只证明仓库生产文件无硬编码，不证明provider旧凭据已撤销。

```sh
pnpm run verify:secrets
```

### 验证与结案

结案必须逐Secret证明：旧credential在无副作用探针或provider审计中不可用；新credential通过最小分段canary；受影响Attempt/tool token已401；GitHub write credential已revoked且ciphertext清空；没有新异常approval/PR/deployment；相关Run/Case 8报告与外部审计一致；仓库Secret scan全绿。至少观察一个最长token TTL和两个Cron周期，不能只证明“新值能用”。

### 证据

记录incident/SEV、Secret名称和类别、finding digest/path kind、暴露/撤销/轮换/传播/验证时间、provider key ID或安全审计链接、受影响Run/Attempt/credential ID、旧值失效结果、新canary结果、Reviewer和后续清理任务。禁止记录Secret值、token/ciphertext/digest明细、含Secret的日志行、raw webhook、终端历史或截图。

### 禁止项

- 禁止把Secret粘贴到argv、环境导出赋值、PR、工单、聊天或PROGRESS。
- 禁止先轮换encryption key导致既有GitHub token无法解密撤销。
- 禁止一次运行全量setup覆盖无关grants/definitions/config，禁止等待自然流量发现静默断链。
- 禁止只更新Worker Secret而不在provider撤销旧authority，或只跑本地Secret scan就结案。

## IR-WRONG-PRODUCTION-DEPLOYMENT — 错误生产部署

### 触发与分级

已确认production环境运行了错误SHA/配置、健康指标或用户影响显著恶化、Deployment success与实际环境不一致，或错误effect正在扩散，立即SEV-0。疑似但未确认时仍按SEV-1冻结后续production变更。触发事实必须来自production监控、GitHub Deployment/Environment或云平台，而不是Agent/Runner自报。

### 只读诊断

1. 从production deployment ID、GitHub deployment ID、Run或merge SHA做correlation，核对唯一repository/Run。
2. 查询Run Plan和Case 8 audit，冻结Task revision、Plan/digest、merge ID/SHA、production approval、deployment/attempt/Evidence、environment URL和时间线。
3. 在GitHub Deployments/Environment、云部署平台和监控中确认当前实际SHA、流量、最后已知健康SHA、影响范围和是否仍有job执行。只读核对至少两类外部事实。
4. 若只是控制面投影落后，等待production status reconciliation；若环境确实错误，不能通过补发success/failure webhook或改D1解决。

### 止损与授权

当前没有 production rollback API。IC与production Reviewer必须先在GitHub Environment/云平台暂停后续production job、冻结发布role或流量，再选择外部平台已有且组织批准的rollback/traffic-shift手册；这是外部平台人工处置。`test rollback 不能用于 production`，production failure也不会继承test contract或既有deploy approval。

如果错误job仍绑定active Run，可用latest-version cancel撤销控制面Attempt/token和后续intent，但cancel不能撤回已经发生的云变更。已经`succeeded/failed`的Run和verified Evidence不可改写；事故处置必须创建独立incident和后续Task/Run，而不是“修正”历史。

### 恢复

优先按目标环境自身经过演练的方式切回最后已知健康SHA/配置；回滚必须由独立production authority和双人复核执行，不能调用本项目test rollback workflow。若组织没有已验证production rollback能力，执行受控流量隔离并走forward-fix：新Task revision → 新Plan/approval → 新commit/PR/check → 新production deployment。不要force push旧PR或复用旧approval。

控制面当前只会通过signed/API-reconciled production deployment status把`in_progress/success/failure/error`投影到原Run；一个已终态success的Run不会因晚到failure被改写。外部rollback/traffic shift成功必须作为incident证据，后续需要新增独立production compensation ledger时另立DoD，不得在本次事故中临时写SQL。

### 验证与结案

结案要求：外部云平台确认实际运行last-known-good或forward-fix exact SHA；用户关键SLO恢复并持续观察组织规定窗口；GitHub Environment无未授权pending job；控制面旧Run历史保持不变，新修复Run/Deployment有独立approval与Evidence；没有重复PR/deployment/outbox；Case 8报告能解释原部署和新处置。单一GitHub success、Run succeeded或监控瞬时恢复都不足以结案。

### 证据

记录incident/SEV/IC/双人批准、旧/错误/恢复SHA、repository、Run/Plan/merge/deployment/approval/Evidence ID、GitHub/云平台deployment和traffic-shift安全链接、影响/止损/恢复时间、SLO窗口、选择rollback或forward-fix的理由与后续Task ID。禁止保存云credential、环境变量、部署日志正文、用户数据、raw API response或Secret。

### 禁止项

- 禁止调用test rollback、复用test role/approval或把production failure解释为自动回滚授权。
- 禁止force push、删除Deployment/Evidence、改D1终态或伪造deployment_status。
- 禁止在没有last-known-good和双人批准时盲目回滚，禁止把控制面cancel当作云环境回滚。
- 禁止用restore fence处理应用部署错误；D1 restore只用于数据库灾备。

## 9. 演练、维护与结案清单

每季度至少做一次不触发真实生产写的tabletop：为六类incident各选一个安全fixture，逐项确认值班人能定位Run、识别权限边界、说出止损authority、找到验证事实和证据字段。D1 restore、真实Secret轮换和production流量切换必须另做显式opt-in演练并由平台owner批准；本地workerd或Wrangler dry-run不能冒充远端操作。

每次修改本手册或operations路由后先运行机器契约：

```sh
pnpm run verify:runbook
```

每次事故结案都检查：

- 触发信号是否能在下一次更早发现；静默故障不得继续依赖自然流量。
- runbook命令是否仍对应当前路由/schema，provider权限是否仍最小。
- 是否产生新Secret、raw payload、自由文本错误或重复external effect泄漏面。
- 是否需要新增真实capability；若当前没有provider pause、production compensation等能力，创建独立DoD/ADR，而不是把愿望写回本手册当成现状。
- `PROGRESS.md`只记录可重跑命令、退出码、安全ID/digest和外部链接摘要，不复制生产日志/数据库行/用户正文/Secret。
