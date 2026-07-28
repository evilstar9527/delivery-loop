# Plan Revision 外部证据验收

当 review、base branch 或补充上下文改变 Plan 正文、base SHA 或 effect 时，控制面必须创建 immutable `plan_revisions`，取消旧执行、使旧审批失效、运行 re-analysis，并以新 Plan 版本重新审批。旧 Plan 不能原地改写，Agent 或 caller 自报 source/ref/base/effect 不能创建 revision。

## 三类 source

同一 manifest schema 支持三种 source；真实验收至少各运行一次：

- `review_feedback`：Case 8 review observation 为 applied，review body 只以 digest 存在，reviewed commit/head 与新 revision lineage 绑定；GitHub Review API 重新计算 body digest。
- `base_update`：控制面保存 GitHub ref/compare 的 immutable observation；verifier 重新读取 base branch ref 与 `before...after` compare，核对 `ahead > 0`、`behind = 0`、merge base、reference/comparison/source digest。
- `supplemental_context`：控制面保存 Feishu/Meegle event digest、prior/new task revision、tenant/source key 和吸收到 current Run 的 lineage；上下文正文只在受控 R2 中存在，manifest 和 Case 8 不带正文。

每个 source 都必须证明：

1. Case 8 有且只有目标 revision，source kind/digest/record ID 与 source-specific lineage 完全一致；
2. prior Plan 已 `superseded`，new Plan 是 `version + 1`、`active`，至少一个 body/base/effects change 为 true；
3. analysis Attempt 和外部 GitHub Action 绑定相同 run、workflow path、stable title、requested base SHA，Action 成功；
4. prior Plan 的所有列出的旧 approvals 已 invalidated，new Plan 的 fresh approvals 绑定 exact plan/version/digest/base、真实 human/provider event、未过期且未 invalidated。

## 命令与退出码

```sh
DELIVERY_LOOP_PLAN_REVISION_E2E=1 \
PLAN_REVISION_EVIDENCE_FILE=/secure/outside/plan-revision.json \
PLAN_REVISION_CONTROL_PLANE_URL=https://control.example \
PLAN_REVISION_CONTROL_PLANE_TOKEN="$CONTROL_PLANE_READ_TOKEN" \
PLAN_REVISION_GITHUB_TOKEN="$GITHUB_READ_TOKEN" \
pnpm run e2e:plan-revision
```

- `0`：Case 8、Plan/approval lineage、analysis Action 和对应 GitHub source facts 全部一致；
- `1`：manifest/schema、Plan version/digest、approval、source、Action 或 GitHub ref/compare 不一致，或响应分页/超限；
- `2`：未显式 opt-in、配置缺失或 manifest 不可读，且不会访问网络。

CLI 是只读验收器，不创建 revision、Plan、approval、Action 或外部 source fact。三类真实 source 的 Feishu/Meegle 签名、tenant/identity 和人工审批仍需按平台后台/事件审计人工核对；本地 fake、示例 manifest、dry-run 或 exit 2 不能替代真实外部事实。

## 安全与 Watt 复用

`verify-plan-revision-evidence.ts`直接复用 Watt 固定提交 `476e3cdd2490d725fde174e7c697ebf00899edc6` 的显式 opt-in、仓库外 64 KiB manifest、固定 0/1/2 退出和安全错误骨架；HTTP 读取复用本项目已有 Watt-derived 1 MiB 流式上限。Plan revision/source/approval 业务断言为 delivery-loop 新增。

manifest、Case 8 和 summary 不保存 Task/PRD/上下文正文、R2 内容或 ref、review body、raw webhook/REST response、source payload、token、数据库行或 Action 日志；control-plane/GitHub token 只进入对应 Authorization header。
