# 飞书卡片动作鉴权真实验收

本文关闭 Phase 2 中 `approve/reject/cancel/retry/replay/add-context` 的真实飞书 tenant 子项。它验证真实签名 callback、HTTP 响应、D1 action lineage 和人工身份/权限事实；本地加密 fixture、schema example、manifest 自报或默认 exit 2 都不能替代真实证据。

## 1. 三种 authority

飞书当前没有可供控制面事后读取完整历史卡片 callback 的只读 API，因此必须组合三种互不替代的事实：

1. 独立 HTTP observer：只保存 campaign scenario、安全 request/response digest、status、latency、event/delivery/action/result 安全 ID；不保存 request/response body、form、open_id、token 或 nonce；
2. operations-only D1 投影：按 exact `tenantKey + eventId` 返回 verified delivery、可选 action receipt/outcome 和 event-bound business effect；原始 callback、open_id、principal、chat、application nonce 与 R2 ref 不返回；
3. 人工 review：飞书后台应用权限/事件订阅、bot 群 membership、真实消息/截图，以及 `open_id → principal/live roles` 映射或撤权事实。

只有三者一致且 `pnpm run e2e:feishu-card-action` exit 0 才能作为真实子项证据。observer scenario 只是受控演练索引，不能覆盖 D1 effect；D1 delivery 也不能单独证明用户看到或点击了哪张卡。

## 2. 前置条件

- owner 批准测试应用、目标群、错误群和本轮写消息/点击窗口；不得使用生产群；
- 已部署公开 HTTPS callback，事件订阅为 active，加密验签、app/tenant/chat 配置均已生效；
- 专用 operations read token 与 observer read token 用途隔离、短期有效；
- 至少两个映射到不同 human principal 的真实账号，一个未映射账号，以及一个可在演练中撤销 action role 的账号；
- 准备多个受控 Run/latest presentation。六类动作会改变 Run，不能假设它们可在同一 Run 顺序执行；
- 准备一个仓库外 synthetic credential-pattern canary。仓库和 manifest 只记录它的 canonical digest，明文仅通过环境变量短期注入；
- observer 对 18 个 scenario 各记录一次 metadata-only HTTP 观测，并能导出 strict `FeishuCardActionObservabilityReportV1`。

应用权限至少覆盖 bot 发消息、更新消息、群消息及只读消息核对。实际 scope、事件订阅、bot membership 和账号映射由 reviewer 在 manifest 的安全链接中核对，不能由控制面自报。

## 3. 受控动作矩阵

### 六类成功动作

分别在 latest 卡片上由两个 mapped human 完成：

- `approve` 与 `reject`：exact effect 进入 approval + immutable approval lineage；
- `cancel`：result 绑定唯一 `workflow_cancel` outbox；
- `retry`：replacement Attempt 必须绑定服务端选出的 lost Attempt、checkpoint 和 Plan Item；按钮 payload 不含 target；
- `replay`：固定绑定 `verify-analysis-result / do / 1` 和唯一 replay outbox；按钮 payload 不含 step；
- `add_context`：新 Task revision 只保存 context digest/ref lineage，正文经 Secret scan 后才可进入私有 R2。

每个成功 callback 都应有一条 delivery、一条 action receipt、一条 terminal outcome、恰好一个 event-bound business effect，且 `feishu_ingress_outbox=0`。

### 十二类拒绝动作

在受控卡片/账号上逐一制造：

- `duplicate_nonce`：同一 application nonce 的第二个真实 callback；
- `tampered_value`：由测试 bot 发布 malformed value 的卡，仍必须使用飞书真实签名 callback；
- `forwarded_message`：转发/复制后的 message binding；
- `stale_card`、`stale_task_revision`、`stale_plan_version`、`stale_plan_digest`、`stale_base_sha`：点击已被新 presentation/version 取代的受控旧卡；
- `wrong_chat`：从未配置的隔离测试群触发；
- `role_revoked`：先撤销 live action role，再点击真实`approve(repo_write)`；observer与manifest只保存枚举型`attemptedCommand=approve`、`attemptedEffect=repo_write`；
- `unauthorized_account`：未映射账号点击真实`approve(repo_write)`，同样冻结上述两个安全枚举；
- `secret_add_context`：表单正文只含 synthetic canary，必须在创建 Task revision/R2 context effect 前拒绝。

除 `secret_add_context` 可留下已 claim 的 rejected receipt/outcome 外，其余拒绝均只应留下 verified delivery；全部必须满足 `businessEffects=0`、`ingressOutboxes=0`。`role_revoked/unauthorized_account`之外的拒绝scenario不得夹带attempted command/effect；禁止为了测试而伪造飞书签名或直接向 D1 插行。

## 4. 证据文件

复制 [manifest 示例](../schemas/feishu-card-action-evidence-v1.example.json) 到仓库外路径，填写：

- app/tenant/chat/callback 和 observer URL/digest；
- 六个成功、十二个拒绝 callback 的 event/delivery/request/response digest、HTTP status/time；
- 成功 action 的 card/presentation/message/Task/Run/Plan/base/action/command/result 安全 binding；
- actor 只保存 open_id/principal/roles canonical digest和 `mapped_human|revoked|unmapped` review 结论；
- developer console、permission、chat、mapping evidence 和 screenshot bundle 的受控 HTTPS 链接；
- synthetic canary digest。

manifest、observer report、截图链接或 PROGRESS 不得包含 open_id 明文、卡片 value、form 正文、token、nonce、原始 callback、数据库行或真实 Secret。

## 5. 只读验证

```bash
export DELIVERY_LOOP_FEISHU_CARD_ACTION_E2E=1
export FEISHU_CARD_ACTION_EVIDENCE_FILE=/absolute/path/feishu-card-action-evidence.json
export FEISHU_CARD_ACTION_CONTROL_PLANE_URL=https://control-plane.example
export FEISHU_CARD_ACTION_OPERATIONS_TOKEN='<short-lived-read-token>'
export FEISHU_CARD_ACTION_OBSERVABILITY_URL=https://observer.example/evidence/feishu-card-actions.json
export FEISHU_CARD_ACTION_OBSERVABILITY_TOKEN='<short-lived-read-token>'
export FEISHU_CARD_ACTION_CANARY_SECRET='<synthetic-canary-used-by-the-campaign>'
pnpm run e2e:feishu-card-action
```

verifier 只执行 bounded HTTPS GET：先读取独立 report 并重算 digest，再为 18 个 event 读取 `GET /v1/operations/feishu-card-action/evidence?tenantKey=<exact>&eventId=<exact>`。它不会发卡、改映射、重放 callback、修改 D1/R2、部署或调用业务 effect。

退出码固定为：`0` 真实事实全部一致；`1` schema/事实/安全断言失败；`2` 未 opt-in 或前置配置缺失。默认 exit 2 是 prerequisite 状态，不是通过。

## 6. 收尾

- 立即撤销 operations/observer token 和 synthetic canary；
- 保存命令退出码、18 个安全 event/result ID、observer/report digest、人工 review 链接摘要到 `PROGRESS.md`；
- 任何 raw/open_id/nonce/canary 泄漏、非零拒绝 effect、retry/replay target 漂移或人工权限证据缺失都保持真实子项未勾。
