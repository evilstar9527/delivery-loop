# 飞书/GitHub审批唯一关联真实验收

本文关闭 Phase 2“飞书审批事件、GitHub 审批与控制面 approval 形成唯一关联记录”的真实外部证据验收契约。它不制造审批，只在受控审批完成后，以只读方式回答同一个真人在何时、通过什么平台，批准了哪个 Task revision、Run、Plan version/digest、base SHA 和 effect。

本地 fixture、直接 D1 insert、schema example、fake GitHub API、默认 exit 2 或 Worker dry-run 都不能替代真实平台事实。

## 1. 固定受控 pair

只使用同一测试 PR、同一 current Run snapshot 和 `effect=merge`：

1. 同一受管 human 在 latest 飞书卡片点击一次 `approve merge`；真实 `card.action.trigger` 必须通过飞书 v2 验签、app/tenant/chat/latest card/nonce/live identity 重验，形成 Feishu source、card receipt、approval 和 immutable lineage；
2. 同一 human 以映射后的 GitHub login 对该 PR 当前 head 提交一次 `APPROVED` review；GitHub webhook adapter 必须通过 `X-Hub-Signature-256`，形成独立 GitHub source、approval 和 immutable lineage；
3. 两条记录必须绑定相同 principal、Task ID/revision/digest、Run ID/version、Plan ID/version/digest、base SHA、`merge/approve` 和 PR author separation；event/source/approval/lineage ID 必须彼此不同；
4. 每条 lineage 都同时冻结平台 source occurred time 与控制面 decision recorded time。GitHub review `submitted_at` 必须等于其 source occurred time；expiry 必须晚于 recorded time；
5. 观察窗口内不得创建 merge outbox 或 merge fact。approval 是权限事实，不等于 merge 已执行。

飞书 open_id 与 GitHub login 不是天然同一身份。manifest 保存 open_id digest、safe principal 和 roles digest；人工 review 必须用受管 identity directory 证明 `feishu:<tenant> + open_id` 与 `github:<repository> + login` 在验收时都解析到同一 human principal，且仍有 `human + approve:merge`。

## 2. 重投与隔离

独立 observer report 固定六次受控观测：

- `feishu_primary` 与同 body、同 event 的 `feishu_retry` 必须返回同一 approval/lineage；
- `github_primary` 与同 body、同 event 的 `github_retry` 必须返回同一 approval/lineage；
- 复用飞书按钮 nonce 但换一个 signed event，必须以 `replay_rejected` 拒绝，operations 投影只能出现一条 metadata-only delivery，不能出现 receipt/outcome/business effect；
- GitHub 同 event 改写 Task/Plan/base snapshot 必须以 `source_conflict` 拒绝，不能把变异请求串到既有 lineage。

observer 只保存 provider/scenario、安全 event/request/response digest、签名算法、status、固定 outcome/reason、approval/lineage 安全 ID 和时间；不保存 webhook body、review body、按钮 value、open_id、Secret 或 Authorization header。`reportDigest` 对去掉自身后的 strict report 做 canonical SHA-256。

## 3. 四类 authority

- signed observer：证明两类真实 callback 的验签结果、HTTP 重投和拒绝事实；
- Case 8：`GET /v1/runs/:runId/audit` 同时核对两条 `checks.identityApprovals`、两条 `answers.approvals`、current Task/Run/Plan/base、两个时间和零 merge effect；
- Feishu action evidence：`GET /v1/operations/feishu-card-action/evidence?tenantKey=<exact>&eventId=<exact>` 把 accepted event 关联到 delivery/receipt/outcome/approval/lineage，并证明 distinct event 只有零 effect delivery；
- live GitHub REST：生产只读 `GitHubMergeGateApiClient.observeApprovalIdentity()` 读取 exact open PR 和 reviews，核对 review ID、reviewer login、current head commit、submitted time 与 PR author。

人工 mapping review 是第五个必要签字边界。任何一类 authority 都不能覆盖另一类；尤其 observer 自报、manifest 自报、Case 8 单行或 live review 单独存在，都不能证明跨平台唯一关联。

## 4. 受控执行

1. 准备一个非生产测试 repo/PR 和停留在 `awaiting_review` 的 current Run；确认 active Plan 声明 `merge`，base/head 未漂移，PR author 与 reviewer 不同；
2. 在最短窗口内完成飞书 latest card 审批和 GitHub current-head review，保存安全 event/review/delivery/source/approval/lineage ID 与两个时间；
3. 对两条 original event 各执行一次 exact 重投；再执行一个飞书 distinct-event/same-nonce 负例和一个 GitHub same-event/mutated-snapshot 负例；禁止直接写 D1；
4. 从独立 observer 导出 [report 示例](../schemas/approval-lineage-observability-v1.example.json) 形状的数据并重算 digest；
5. 复制 [manifest 示例](../schemas/approval-lineage-evidence-v1.example.json) 到仓库外，只填写安全 ID/digest/time/SHA/URL 与人工 review 元数据；
6. 在 approval 未过期、Run snapshot 未变化且 merge 尚未调度的窗口执行 verifier。窗口已变化时重新准备 case，不能降低断言。

## 5. 只读验证

```bash
export DELIVERY_LOOP_APPROVAL_LINEAGE_E2E=1
export APPROVAL_LINEAGE_EVIDENCE_FILE=/absolute/path/approval-lineage-evidence.json
export APPROVAL_LINEAGE_CONTROL_PLANE_URL=https://control-plane.example
export APPROVAL_LINEAGE_OPERATIONS_TOKEN='<short-lived-operations-read-token>'
export APPROVAL_LINEAGE_OBSERVABILITY_URL=https://observer.example/evidence/approval-lineage.json
export APPROVAL_LINEAGE_OBSERVABILITY_TOKEN='<short-lived-observer-read-token>'
export APPROVAL_LINEAGE_GITHUB_API_URL=https://api.github.com
export APPROVAL_LINEAGE_GITHUB_READ_TOKEN='<short-lived-single-repo-pr-read-token>'
export APPROVAL_LINEAGE_CANARY_SECRET='<synthetic-credential-shaped-canary>'
pnpm run e2e:approval-lineage
```

命令只执行有界 HTTPS GET，不重放 event、不点击卡片、不创建 review、不写 D1、不触发 merge、不部署。GitHub token 只需目标单仓库 PR/review read；operations、observer 与 GitHub token 必须用途隔离。所有响应在解析前扫描三类 token、仓库外 synthetic canary 和 credential 形状。

退出码固定：`0` 表示外部 report、Case 8、Feishu action projection、live GitHub review 与人工 review 元数据一致；`1` 表示 schema、事实、唯一关联、隔离、zero-effect 或安全断言失败；`2` 表示未显式 opt-in 或前置配置缺失。默认 exit 2 不是通过。

## 6. Watt复用边界与收尾

CLI 直接复用 Watt 固定 commit `476e3cdd2490d725fde174e7c697ebf00899edc6` 的显式 opt-in、仓库外 64 KiB manifest、固定安全错误与 0/1/2 退出纪律；有界 HTTPS 和 Secret canary 扫描继续复用本项目既有 Watt-derived E2E 骨架。Watt 没有 Task/revision/Plan/base/effect-bound approval lineage、Feishu/GitHub pair 或 Case 8/receipt/live review 交叉验证，等价业务代码直接复制量为零。

完成后撤销三枚 read token 和 canary。`PROGRESS.md` 只记录 verifier exit、安全 ID/digest/time 和 review URL，不记录 raw event、review正文、open_id、按钮 payload、token 或数据库行。只有 verifier exit 0 且人工 mapping review 完成，才能勾真实飞书/GitHub外部事实与父DoD。
