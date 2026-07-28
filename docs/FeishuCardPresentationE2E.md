# 飞书交付卡片展示与自然过期真实验收

本文验收 Phase 2 的真实 interactive v2 状态卡：首次 create 后继续 PATCH 同一 message，完整展示 Run/Task/Plan/DoD/repo/本轮目标/可信链接/blocker/approved effect；最早 approval 到期且没有其他业务写入时，scheduled reconciliation 自动生成下一 presentation 并移除 effect。verifier 严格只读，不发送、PATCH、刷新卡片或修改 D1。

## 1. 前置

- 已部署 migration 0059、当前 Worker、飞书卡片 reconciler/consumer 与每分钟 scheduled reconciliation；
- 真实自建应用 bot 已加入目标测试群，具备 `im:message:send_as_bot`、`im:message:update`、`im:message.group_msg`，以及 `im:message` 或 `im:message:readonly`；
- operations token 与短期飞书 Message GET token 用途隔离；
- 测试 Run 已有 active Plan、至少一个 required DoD Item、可信 Action/PR fact、active blocker、verified Evidence 受控链接，以及一个短期有效 approval；
- 准备一个仓库外合成 canary，形状必须命中控制面 credential scanner，例如随机生成的 `ghp_` 前缀测试串。它不是可用 credential，禁止使用真实 token/Secret。

开发者后台 scope、bot 群 membership、消息链接和截图必须由人工复核。Message GET 成功及 app/tenant/chat 绑定证明当前消息读取 authority，但不能替代后台权限配置审计。

## 2. 受控序列

1. 在安全摘要来源中加入 Markdown probe；把合成 canary 放入 checkpoint summary，确认 presentation 只出现固定“摘要已隐藏”；关联一份至少 30 KiB 的真实验证日志，但卡片只写不超过 240 字的摘要与 verified HTTPS 受控链接。
2. 让当前 Run 首次产生 v2 卡片，等待 `created` delivery settled，记录 presentation/revision/digest/outbox/message/time。
3. 通过正常审批入口加入一个短期 effect；等待下一张完整 v2 presentation 以 `updated` settled 到同一 message ID。它作为 `beforeExpiry`，必须包含该 effect/expiry，且 lineage 的 `nextRefreshAt` 等于最早 expiry。
4. 从 `beforeExpiry` 起冻结 Run/Task/Plan/Item/Attempt/Evidence/approval authority 等业务写入，不调用 operations refresh。等待 approval 自然到期和 scheduled reconciliation；下一 presentation 必须直接以前一张为 prior，trigger 为 `approval_expiry`，前后 `sourceObservedAt` 完全相同，并以 `updated` settled 到同一 message ID。
5. 调用只读接口：

```text
GET /v1/operations/feishu-card-presentation/evidence?runId=<exact-run-id>
GET /open-apis/im/v1/messages/<known-message-id>?card_msg_content_type=user_card_content
```

operations 响应只含 strict-rehydrated 安全快照、canonical rendered digest、presentation/outbox/delivery/lineage 白名单字段。action nonce、原 presentation/card JSON、Task/PR 正文、raw log、R2 ref、数据库行、token 和上游响应不得出现。

## 3. 仓库外 manifest

按[示例 manifest](../schemas/feishu-card-presentation-evidence-v1.example.json)记录 Task/Run/repository、app/tenant/chat/message、三张关键 presentation、expiring effect/time、合成 canary digest、大日志 digest/size/受控链接，以及后台 scope/群 membership/截图人工 review。中间允许存在其他安全 presentation，但 `afterExpiry` 必须是 latest，且它的直接 prior 必须是 `beforeExpiry`。

manifest 不保存 canary 明文、access token、app secret、消息/card正文、日志正文、action payload、nonce、数据库行、R2 ref或截图二进制。示例 ID/digest 仅验证 schema，不是外部证据。

## 4. 显式 opt-in

```text
DELIVERY_LOOP_FEISHU_CARD_PRESENTATION_E2E=1
FEISHU_CARD_PRESENTATION_EVIDENCE_FILE=<仓库外manifest绝对路径>
FEISHU_CARD_PRESENTATION_CONTROL_PLANE_URL=<控制面HTTPS origin>
FEISHU_CARD_PRESENTATION_OPERATIONS_TOKEN=<operations只读短期token>
FEISHU_CARD_PRESENTATION_FEISHU_TOKEN=<飞书Message GET短期token>
FEISHU_CARD_PRESENTATION_CANARY_SECRET=<仓库外合成canary明文>
FEISHU_CARD_PRESENTATION_FEISHU_API_URL=<可选；默认https://open.feishu.cn>
```

运行：

```bash
pnpm run e2e:feishu-card-presentation
```

- `0`：D1 presentation/outbox/delivery/expiry lineage、完整安全快照与 live Feishu Message GET 精确一致，create/PATCH 同 message、自然过期零业务 watermark 变化、最终卡片段落和 canary 零泄漏全部通过；
- `1`：schema/binding/digest/展示段落、message identity、delivery lineage、expiry trigger/watermark 或安全扫描不一致；
- `2`：未 opt-in、配置缺失或 manifest 不可读。

缺 opt-in 的 exit 2 不是 skip 或通过。错误只输出固定 code；成功只输出安全 ID、计数和固定结论。

## 5. 关门证据

真实父 DoD 仍需同时保存：verifier exit 0摘要、message ID/受控消息链接、effect 到期前后截图引用、开发者后台 scope与群 membership reviewer、三张关键 presentation/delivery/lineage安全ID和时间，以及证明测试日志真实大于30 KiB的受控来源。人工逐项核对 card display，确认 D1 presentation、outbox operations 响应和 live message 不含合成 canary、raw log或Markdown注入结果。

本地 fake REST、workerd、schema example、manifest 自报、Wrangler dry-run或默认 exit 2 都不能替代真实 tenant 事实。
