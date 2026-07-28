# 飞书 ingress 重放、Queue 与 Task revision 真实验收

本验收关闭 Phase 2 的一个外部事实缺口：同一个真实飞书 event 被平台重投三次时，控制面只有一个逻辑 ingress/Queue effect；另一个真实 event 经实际 normalizer 指向相同 source revision 时，仍只有一个 Task、Run 和 Cloudflare Workflow instance。

`pnpm run e2e:feishu-ingress` 是只读 verifier。它不会发送 webhook、修改飞书应用、重放 Queue、创建 Workflow 或部署 Worker。没有显式 opt-in 时固定 exit 2；schema example、fake HTTP、本地 workerd、Wrangler dry-run和人工填写的 manifest 都不能替代真实证据。

## 1. 前置与权限

先完成以下受控前置：

1. 测试飞书自建应用已发布并使用加密事件订阅；公开 callback 指向已部署的本仓库 Worker。
2. D1 已应用 migration 0057；绑定的 Queue 名为 `delivery-loop-feishu-ingress`，Workflow 名为 `delivery-run`。
3. operations token 只能读取 `/v1/operations/feishu-ingress/evidence`；Cloudflare token 只需目标账户的 Workflows read，不能部署或修改 Queue/Workflow。
4. 外部 observability endpoint 与 verifier 环境变量独立配置；token 只在 URL 完全一致后进入 Authorization header。report 不保存 request body、密文、nonce、token、encrypt key、Task 正文或原始日志。
5. 由应用 owner 批准一次受控重投窗口。推荐让可信边缘代理完整转发 callback，但对飞书前两次返回可重试错误、第三次才返回成功，使飞书生成三次真实 transport delivery；不得把本地直接调用 Worker 冒充平台重投。若测试 tenant 无法产生可审计的真实 retry，本项保持未完成。

## 2. 产生事实

1. 在测试 tenant 触发一个能被 normalizer 读取的 event A。受控重投必须得到同一 event ID、同一 stable delivery/ingress identity和三条不同 request digest；每次回调仍须通过 signature、timestamp、decrypt、token、app和tenant校验。
2. 让 ingress relay 和真实 Cloudflare Queue consumer 自然运行。不要直接调用 `FeishuNormalizedTaskStore`。D1 应出现一个 ingress outbox、一个逻辑 Queue message digest，以及从 attempt 1 开始连续的 immutable Queue observation；at-least-once 的更高 attempt 可以追加，但不能产生第二个 Queue message identity。
3. 在不改变 Meegle/飞书 source task revision 和业务 snapshot 的条件下触发不同 event ID 的 event B，并让实际 normalizer 处理。event A/B 必须各有自己的delivery、ingress和Queue message identity，但两者最终绑定同一 Task ID、Run ID、task digest和唯一 settled workflow-create outbox。
4. 等待 `delivery-run` live instance 可从 Cloudflare Workflows API按 `run_id`读到；保存 version ID、status和start time。人工核对 Queue/Workflow dashboard并只在manifest中记录无query/fragment的HTTPS链接与review时间。
5. 外部观测系统生成exact四条成功回调记录：event A三条、event B一条。每条只含case/outcome、request/response digest、status、event/type/delivery ID及start/end/latency；对排除`reportDigest`的canonical report body计算SHA-256。

## 3. 仓库外 manifest

从[`schemas/feishu-ingress-evidence-v1.example.json`](../schemas/feishu-ingress-evidence-v1.example.json)复制到仓库外受控位置，并引用[`schemas/feishu-ingress-observability-v1.example.json`](../schemas/feishu-ingress-observability-v1.example.json)的真实report digest。manifest不得包含credential、raw webhook、nonce、Queue原始message ID/body、Task正文、R2 ref或数据库行。

两个event的`queueObservationCount`必须等于`maximumQueueDeliveryAttempt`；verifier进一步要求attempt从1连续递增、所有observation只有一个message digest。`workflowInstanceId`必须等于`runId`，两个operations投影必须返回同一个Task/Run/workflow-create identity，且workflow-create outbox已经settled。

## 4. 运行

```bash
export DELIVERY_LOOP_FEISHU_INGRESS_E2E=1
export FEISHU_INGRESS_EVIDENCE_FILE=/secure/outside-repo/feishu-ingress-evidence.json
export FEISHU_INGRESS_CONTROL_PLANE_URL=https://control.example.com
export FEISHU_INGRESS_OPERATIONS_TOKEN='<short-lived-read-token>'
export FEISHU_INGRESS_OBSERVABILITY_REPORT_URL=https://observability.example.com/feishu/ingress-evidence
export FEISHU_INGRESS_OBSERVABILITY_TOKEN='<short-lived-report-token>'
export FEISHU_INGRESS_CLOUDFLARE_ACCOUNT_ID='<account-id>'
export FEISHU_INGRESS_CLOUDFLARE_TOKEN='<workflows-read-token>'
pnpm run e2e:feishu-ingress
```

只有exit 0和安全summary可以入`PROGRESS.md`。同时记录飞书重投审计、Queue/Workflow dashboard人工review人和时间；不要记录token、请求正文、nonce、Queue原始message ID或数据库行。exit 1表示事实/绑定不一致，exit 2表示未opt-in或前置配置缺失。

## 5. 通过判据

- 外部observability：exact 4条真实成功回调，event A为3条、event B为1条，request digest全部不同。
- D1 operations：每event恰好1 delivery、1 ingress、1 Queue message identity、1 Task投影、1 Run投影和1 workflow-create outbox；event A有3条transport receipt。
- Queue observation：只保存Cloudflare message ID digest；delivery attempt从1连续，重复相同attempt不新增行，原始ID/body零持久化。
- Task revision：两个不同event的source system/tenant/task key/revision/task digest及Task/Run完全相同。
- Workflow：`run_id = workflow instance id`，workflow-create outbox settled，live Cloudflare status/version/start与manifest一致。
- 人工review：Queue与Workflow dashboard链接、reviewer和时间已入账。任一authority缺失时父DoD保持未勾。
