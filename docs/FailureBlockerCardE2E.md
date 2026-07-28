# 失败 Blocker 飞书卡片真实验收

本文验收 Phase 3 的真实失败预算卡片：同一失败指纹连续两次，或同 retry scope 到第三个 Attempt 后，Run 进入 `blocked`；真实飞书卡片只展示控制面固定的尝试路径与人工输入提示。verifier 严格只读，不负责制造失败、发送卡片或更新消息。

## 1. 前置

- 已部署包含 failure ledger、Feishu card v2 和 rendered-card digest 查询的当前 Worker；
- 一个真实 Runner Run 已经通过正常 failure API 达到 `repeated_fingerprint` 或 `attempt_limit`，Run/Plan/Item 均为 `blocked`；
- bot 已在目标测试群中发送或更新当前 interactive card，且控制面 latest presentation 已 settled 到同一 message ID；
- 飞书应用具备读取该消息的 scope 和群 membership；
- operations、Task query 与飞书消息 GET 使用三个用途隔离的短期只读 token。

不要为了验收直接改 D1、拼装 `run_blockers`、调用 card PATCH 或把 Runner 错误正文写入 manifest。真实失败必须从 Runner 的固定 code/site/path/human-input envelope 进入控制面。

## 2. 记录安全 manifest

1. 从 `GET /v1/tasks/:taskId` 记录 Task/Run/repository、active blocker ID/reason/fingerprint digest、计数、Attempt ID/ordinal、固定 path code、人工输入 code 与时间。
2. 从 `GET /v1/runs/:runId/feishu-card` 记录 latest presentation/revision/presentation digest/rendered-card digest/outbox，以及 delivered message ID。latest 必须与 delivered 完全相同，outbox 必须 settled 且没有错误码。
3. 用飞书官方 `GET /open-apis/im/v1/messages/:message_id?card_msg_content_type=user_card_content` 记录 app/tenant/chat/message ID和创建、更新时间；不要复制 raw response 或卡片正文。
4. 按[示例 manifest](../schemas/failure-blocker-card-evidence-v1.example.json)的 strict 形状写入仓库外文件。示例值不是证据。

manifest 只能保存安全 ID、枚举、计数、digest 和时间。禁止保存 access token、app secret、Runner message/stack/stdout/stderr、Task正文、卡片正文、飞书 raw response、数据库行或截图二进制。

## 3. 显式 opt-in 验证

```text
DELIVERY_LOOP_FAILURE_BLOCKER_CARD_E2E=1
FAILURE_BLOCKER_CARD_EVIDENCE_FILE=<仓库外manifest绝对路径>
FAILURE_BLOCKER_CARD_CONTROL_PLANE_URL=<控制面HTTPS origin>
FAILURE_BLOCKER_CARD_OPERATIONS_TOKEN=<卡片运维只读短期token>
FAILURE_BLOCKER_CARD_QUERY_TOKEN=<Task查询只读短期token>
FAILURE_BLOCKER_CARD_FEISHU_TOKEN=<飞书消息GET短期tenant access token>
FAILURE_BLOCKER_CARD_FEISHU_API_URL=<可选；默认https://open.feishu.cn>
```

运行：

```bash
pnpm run e2e:failure-blocker-card
```

- `0`：Task blocker、settled presentation、rendered digest、飞书message/app/tenant/chat/time与唯一 Blocker 文案全部匹配；
- `1`：manifest、控制面或飞书 live fact不一致，响应不合法，或卡片不是固定路径/人工输入投影；
- `2`：未 opt-in、配置缺失或 manifest 不可读取。

默认 exit 2 是前置缺失，不是 skip、通过或真实 tenant 失败。错误只输出固定 code；成功 summary 只含安全 ID、固定状态与计数。

## 4. 关门证据

真实 DoD 需要同时保存：verifier exit 0摘要、飞书 message ID/受控消息链接或截图引用、应用 scope 与群 membership 审计、Run/Plan/Item blocker安全查询链接，以及两次同指纹或三次不同失败的真实 Runner/Action安全 ID与时间。人工逐项确认卡片显示路径和人工输入提示，且没有 Runner 原始错误。

本地 fake REST、schema-valid 示例、Worker dry-run或默认 exit 2 都不能替代真实 tenant 卡片事实。
