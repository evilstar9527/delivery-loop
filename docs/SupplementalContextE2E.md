# 补充上下文 revision 与当前 Run 隔离真实验收

本文关闭 Phase 2“补充上下文默认创建新 revision；只有用户明确选择应用到当前 Run 才取消并重建 Attempt”的真实外部证据验收契约。本地 workerd、schema example、manifest 自报、默认 exit 2 或直接 D1 insert 都不能替代飞书/Meegle 事实。

## 1. 必须证明的行为

固定使用三个彼此独立的受控 case：

1. 飞书 `new_run`：真实签名 `card.action.trigger` 产生一条 action receipt/outcome 和一条 immutable supplemental context；新 Task/Run 唯一，原 Run version、running Attempt version/lease、active token、approval invalidation 与 Plan revision 都不变化；
2. 飞书 `apply_current`：另一条真实签名 action 明确绑定原 Task revision、Run version、Plan version/digest 与 base；派生的新 Run 被标记 `cancelled`，其 `workflow_create` 以 `supplemental_context_absorbed` settled；原 Run 只前进一个 version 到 `planning`，旧 Attempt cancelled、token 全部 revoked、旧审批全部 invalidated，并生成唯一 fenced analysis Attempt/dispatch；
3. Meegle convergence：两个不同真实 event 指向同一 project/type/item/external revision。每个 event 都有独立 immutable `meegle_mapping_lineage`，但 Task、Run、supplemental context 和 `workflow_create` 各只有一个。

同一张 live 飞书卡还必须同时出现 `补充上下文·新 Run` 与 `补充上下文·当前 Run`。按钮可见性不授权；callback 仍由服务端按 app、tenant、chat、open_id/live roles、latest presentation、Task/Run/Plan/base 和一次性 nonce 重验。

## 2. 四种 authority

- 独立 HTTP observer：记录四个受控 event 的五次 HTTP 观测（Meegle primary 同 event 重投一次）的 provider/scenario、安全 request/response digest、status 和 latency，不保存 body、open_id、Meegle 字段值或 token；
- operations-only 控制面投影：`GET /v1/operations/supplemental-context/evidence?contextId=<exact>` 从 D1 读取唯一 lineage/source binding，并在服务端有界回读私有 R2，strict 解析 context 与新 Task、重算 canonical digest 和 custom metadata；
- live 飞书 Message GET：核对 app/tenant/chat/message/timestamps、interactive card digest，以及两枚模式明确的按钮；
- 人工 review：核对飞书事件订阅、scope、bot 群 membership、open_id 映射、Meegle project/type 权限与受控截图。

任一来源都不能替代其他来源。尤其，R2 对象存在不等于内容正确；manifest 中列出两个 Meegle event 也不等于 D1 实际保存了两条 lineage。

## 3. 安全投影

operations 响应只返回：

- prior/new Task 与 context 的 ID、revision digest、Task/context digest及安全 source 标量；
- R2 context/new Task 是否通过 schema、canonical digest、metadata 与 D1 binding 的布尔结论；
- 新 Run 与唯一 workflow-create 的状态、version、attempt count 和固定错误码；
- 飞书 action 的 event/delivery/receipt/outcome、operator canonical digest、card/presentation/message、source Run/Plan/base binding；
- Meegle event/ingress、project/type/item/revision、exact/mapping/profile digest；
- apply-current 的当前 Run、PlanRevision、analysis Attempt/outbox、旧 Plan Attempt 的 status/version/lease generation，以及 token/approval 的计数与撤销计数。

响应没有 Task/context 正文、actor/open_id/principal、R2 ref、token/nonce digest、raw callback、Meegle 字段/owner、outbox payload/lease 或数据库行。verifier 在 JSON parse 前用仓库外 synthetic canary 和三类用途隔离 token 扫描所有有界响应。

## 4. 受控执行

1. 在两个独立 Run 的 latest 卡片分别提交相同类型的非敏感 context，一次点“新 Run”，一次点“当前 Run”；保存安全 event/delivery/receipt/outcome/context ID；
2. 对 Meegle 同一业务 revision 触发两个不同 event。两次都必须经过真实验签、分页完整 snapshot、mapping profile 与 normalizer；随后通过内部 context 边界绑定该新 revision。禁止直接向 D1/R2 插入验收数据；
3. 导出独立 [observer report 示例](../schemas/supplemental-context-observability-v1.example.json)，其中同一 Meegle primary event 有两次不同 request digest 的成功观测，并重算 `reportDigest`；
4. 复制 [manifest 示例](../schemas/supplemental-context-evidence-v1.example.json) 到仓库外，填写三条 context lineage、四个 event、live card 和人工 review 安全链接；
5. 在状态仍能证明受控边界的窗口运行只读 verifier。若新 Run 已自然推进或 apply-current analysis 已开始，重新准备 case，不能放宽断言伪装初始状态。

## 5. 只读验证

```bash
export DELIVERY_LOOP_SUPPLEMENTAL_CONTEXT_E2E=1
export SUPPLEMENTAL_CONTEXT_EVIDENCE_FILE=/absolute/path/supplemental-context-evidence.json
export SUPPLEMENTAL_CONTEXT_CONTROL_PLANE_URL=https://control-plane.example
export SUPPLEMENTAL_CONTEXT_OPERATIONS_TOKEN='<short-lived-operations-read-token>'
export SUPPLEMENTAL_CONTEXT_OBSERVABILITY_URL=https://observer.example/evidence/supplemental-context.json
export SUPPLEMENTAL_CONTEXT_OBSERVABILITY_TOKEN='<short-lived-observer-read-token>'
export SUPPLEMENTAL_CONTEXT_FEISHU_API_URL=https://open.feishu.cn
export SUPPLEMENTAL_CONTEXT_FEISHU_ACCESS_TOKEN='<short-lived-message-read-token>'
export SUPPLEMENTAL_CONTEXT_CANARY_SECRET='<synthetic-canary-used-by-the-campaign>'
pnpm run e2e:supplemental-context
```

命令只执行 bounded HTTPS GET，不点击卡片、不触发 Meegle event、不修改身份/权限、不写 D1/R2、不部署。退出码固定：`0` 为四种 authority 全部一致；`1` 为 schema、事实或安全断言失败；`2` 为未显式 opt-in 或配置缺失。默认 exit 2 不是通过。

## 6. Watt 复用边界与收尾

CLI 直接复用 Watt 固定 commit `476e3cdd2490d725fde174e7c697ebf00899edc6` 的显式 opt-in、仓库外 64 KiB manifest、固定 0/1/2 退出和安全固定错误纪律。Watt 没有 supplemental Task/Run/PlanRevision、Meegle mapping lineage、当前 Attempt fencing或上述四方 evidence；对应业务代码直接复制量为零，没有虚构 Watt 来源。

完成后撤销三个 read token 和 canary，`PROGRESS.md` 只记录 verifier exit、context/event/receipt/lineage 安全 ID、digest、时间及受控 review 链接。raw callback、正文、open_id、owner、token、nonce 和 R2 ref 不入账。只有 verifier exit 0 且人工 review 完成，才能勾真实飞书/Meegle子项与父项。
