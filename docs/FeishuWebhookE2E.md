# 飞书 challenge、事件验签与拒绝零写入真实验收

本验收关闭 Phase 2 的第一个真实 tenant 边界：飞书开发者后台实际接受加密回调 URL，一条真实事件在 3 秒内被验签并形成唯一 metadata receipt；错误签名、301 秒旧 timestamp、错误 tenant 三个受控请求被拒且没有 receipt/nonce/ingress/Task/Run/outbox 业务记录。

`pnpm run e2e:feishu-webhook`是严格只读 verifier。它不会保存回调 URL、发送事件、伪造攻击请求、修改飞书应用、查询正文或改 D1。真实配置与负向 probe 必须先由测试应用 owner 在批准窗口执行。

## 1. 三个事实来源

1. 飞书开发者后台：保存 Request URL 时真实发送`url_verification`，后台日志检索中的`SUCCESS`由人审记录。官方要求challenge在1秒内原样返回；普通事件在3秒内返回HTTP 200，否则会重推。当前官方文档没有提供机器可读的历史投递日志OpenAPI，因此developer console链接和review时间必须保留，不能由manifest自证。
2. 外部可观测平台：部署后的Worker对五类路径输出`feishu_webhook_request_observed`安全结构化日志，只含case/outcome、request/response digest、HTTP status、开始/完成时间、latency和正向event/delivery白名单ID。challenge正文、raw/encrypted/decrypted body、nonce、token、encrypt key和错误正文不进入日志。把exact五条记录导出为`FeishuWebhookObservabilityReportV1`，放在受控HTTPS只读端点；report本身以canonical SHA-256绑定。
3. 控制面D1安全投影：`GET /v1/operations/feishu-webhook/evidence?tenantKey=...&eventId=...`只接受`OPERATIONS_TOKEN`，按exact tenant/event返回receipt、ingress身份与六类计数。成功event必须唯一delivery、至少一个nonce和唯一ingress；三类拒绝必须全部为零。API不返回raw body、密文、解密正文、token、key、nonce、Task正文、R2 ref或数据库自由列。

参考官方说明：[事件订阅配置](https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case.md)、[事件订阅FAQ](https://open.feishu.cn/document/event-subscription-guide/event-subscriptions/faq.md)、[日志检索](https://open.feishu.cn/document/tools-and-resources/open-api-log-query#30d1c67a)。

## 2. 受控执行

1. 部署当前Worker到测试控制面，使用独立飞书自建测试应用；`FEISHU_EVENT_ENCRYPT_KEY`、`FEISHU_EVENT_VERIFICATION_TOKEN`、`FEISHU_APP_ID`和`FEISHU_DELIVERY_TENANT_KEY`全部以Worker Secret/受信配置注入。
2. 在飞书后台启用加密模式并保存公开HTTPS callback。确认后台challenge记录为`SUCCESS`，记录无query/fragment的应用事件配置页与日志检索页、reviewer和时间；不得复制challenge或密钥。
3. 订阅一个低风险事件并真实触发一次。记录飞书event ID/type/time，外部日志中的request/response digest、status/latency，以及operations投影中的delivery ID、event digest和唯一计数。
4. 在同一测试应用的批准窗口，用审计过的仓库外probe分别发送：错误签名、比当前时间旧301秒的签名请求、解密后tenant不同的有效签名请求。每个probe使用唯一event ID和request body；Secret只从交互式环境/Secret store进入进程，不得出现在argv、shell history、日志或manifest。确认HTTP分别为401、401、403，再查询三个exact event均为零业务记录。
5. 从外部日志只读导出exact五条记录，按[observability示例](../schemas/feishu-webhook-observability-v1.example.json)生成report；再按[主manifest示例](../schemas/feishu-webhook-evidence-v1.example.json)生成不超过64 KiB的仓库外manifest。示例ID、digest和URL不是事实证据。

入口crypto继续直接复用Watt commit `476e3cdd2490d725fde174e7c697ebf00899edc6`的`SHA-256(timestamp + nonce + encryptKey + exact body)`、constant-time compare与AES-256-CBC；CLI直接复用其显式opt-in、仓库外64 KiB manifest和0/1/2退出纪律。Watt的匿名明文兼容、raw payload持久化和上游错误传播没有复制。

## 3. 运行

```text
DELIVERY_LOOP_FEISHU_WEBHOOK_E2E=1
FEISHU_WEBHOOK_EVIDENCE_FILE=<仓库外manifest绝对路径>
FEISHU_WEBHOOK_CONTROL_PLANE_URL=<控制面HTTPS origin>
FEISHU_WEBHOOK_OPERATIONS_TOKEN=<operations只读短期token>
FEISHU_WEBHOOK_OBSERVABILITY_REPORT_URL=<与manifest完全相同的受控HTTPS URL>
FEISHU_WEBHOOK_OBSERVABILITY_TOKEN=<外部报告只读短期token>
```

```bash
pnpm run e2e:feishu-webhook
```

- `0`：外部HTTP时间线、正向immutable D1 receipt/ingress和三个负向零写入全部一致，且飞书后台人工review字段完整；
- `1`：schema/digest、1秒challenge、3秒event、event identity、D1计数或任一外部事实不一致；
- `2`：未显式opt-in、配置缺失或manifest不可读；在网络前结束。

manifest中的observability URL是不可信输入；只有独立环境变量中的exact URL与之相等才发送observability token。控制面origin还必须与callback origin相同。响应限制1 MiB，错误只打印固定code，成功summary不含credential、raw响应、challenge或数据库行。

## 4. DoD入账边界

`PROGRESS.md`只有同时记录以下事实才能勾选父项：命令exit 0与时间、飞书应用/加密/订阅状态人工review、challenge与event两条后台`SUCCESS`链接、公开callback、event/delivery ID、五条外部观测report digest、三个负向HTTP状态和四个operations安全summary、执行者/reviewer。还要人工复核飞书retry count与负向probe审计，确认没有Secret/raw body进入manifest、日志、artifact或命令行。

本地workerd、fake fetch、schema示例、manifest自报、默认exit 2或只看到Worker HTTP 200均不能替代真实飞书tenant后台`SUCCESS`。同理，飞书后台成功不能替代D1 receipt和负向零写入。
