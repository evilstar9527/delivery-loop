# 飞书卡片限流/超时与人工刷新真实验收

本文验收 Phase 2 的飞书 delivery recovery：限流、HTTP timeout 和 token invalid/refresh 只让原 outbox retry，不回退 latest/delivered revision；确认不可修复的最终卡片后，operations refresh 创建新 immutable presentation/outbox，并最终在飞书群中只有当前卡片。verifier 只读，不主动制造限流、发送或刷新消息。

## 1. 前置

- 已部署包含 retry observation projection、operations refresh 和当前 Feishu adapter 的 Worker；
- 一个真实 Run 已产生一张 v2 卡片；
- 测试群、bot scope 和消息读取权限已配置；
- operations token 与短期飞书 tenant access token 分开注入；
- 已在受控窗口执行 rate-limit、HTTP timeout、token invalid 后刷新 token，并确认原 outbox 后续成功；
- 已通过正常 operations GET/refresh 入口完成一次人工修复，不能直接改 D1 或调用 Feishu PATCH。

仓库外 manifest 只保存安全 ID、计数、固定错误码、digest、时间和消息身份，不保存 token、app secret、飞书 raw response、卡片正文、数据库行或截图二进制。

## 2. 记录事实

1. 从 operations GET 记录初始 outbox/presentation、连续 retry observation 的 attempt/error/time、initial/final revision 和 message ID。
2. 记录 refresh GET→POST 的 exact expected presentation/revision/digest、服务端 request ID、next presentation/outbox/revision，以及最终 delivered message ID。
3. 使用飞书官方 Message GET 核对最终 message 的 app/tenant/chat、interactive/non-deleted、时间和 card digest；不要复制正文。
4. 按[示例 manifest](../schemas/feishu-retry-evidence-v1.example.json)写入仓库外文件。示例 digest 不是证据。

## 3. 显式 opt-in 验证

```text
DELIVERY_LOOP_FEISHU_RETRY_E2E=1
FEISHU_RETRY_EVIDENCE_FILE=<仓库外manifest绝对路径>
FEISHU_RETRY_CONTROL_PLANE_URL=<控制面HTTPS origin>
FEISHU_RETRY_OPERATIONS_TOKEN=<operations只读短期token>
FEISHU_RETRY_FEISHU_TOKEN=<飞书消息GET短期tenant access token>
FEISHU_RETRY_FEISHU_API_URL=<可选；默认https://open.feishu.cn>
```

运行：

```bash
pnpm run e2e:feishu-retry
```

- `0`：retry history 同 outbox、连续 attempt 和固定错误码完整，latest/delivered 状态单调，refresh lineage exact，最终飞书消息与 card digest 匹配；
- `1`：历史、状态、refresh、message identity/digest 或分页/响应不一致；
- `2`：未 opt-in、配置缺失或 manifest 不可读。

命令只读，不触发重试、refresh、发送、PATCH 或 token refresh。默认 exit 2 不是通过或 skip。

## 4. 关门证据

真实 DoD 需要保存：rate-limit/timeout/token-refresh 平台时间与安全事件 ID、同一 outbox 的 D1 retry observation、operations refresh request/presentation/outbox ID、最终飞书 message ID/受控链接或截图引用，以及应用 scope/群 membership 审计。人工确认群内只有一张当前卡，且 D1/outbox/log 没有 token、raw response 或卡片正文。

本地 fake fetch、workerd、示例 manifest 和 dry-run 只能验证协议，不能替代真实 tenant、QPS/平台错误码、网络 timeout、token refresh 或消息可见性事实。
