# Identity-bound approval E2E

本场景验证高风险 effect 的 approval 主体不是 Agent 或 PR 作者。验收需要覆盖四条事实：

- GitHub source 的真人 review actor 与 PR author 是不同身份，且有 `human + approve:merge`；
- GitHub source 的 PR 作者自批被拒绝，不能创建 approval/lineage 或 merge effect；
- Feishu source 的真人 `open_id` 与 GitHub PR author 分离，且有 `human + approve:production_deploy`；
- Feishu/Task actor 自批被拒绝，不能创建 production approval/deployment effect。

## 本地证据

`Case 8 checks.identityApprovals` 只投影 source ID/provider/tenant/event digest、channel identity、principal、roles digest、Plan/base/effect、accepted/rejected、lineage/rejection ID、固定 reason、separation 和时间。拒绝记录额外保存安全 identity snapshot；原始 GitHub review、飞书事件、request body、token 和角色正文不进入 D1。

`test/identity-approval-evidence.test.ts` 通过 fake GitHub PR/review API 覆盖 accepted separation、self-approval rejection、GitHub identity drift、Case 8 projection drift、effect drift、raw/token 零传播和 CLI opt-in；`test/workflow/case8-audit-report.test.ts` 覆盖 accepted 与 rejected D1 projection。

## 真实试点验收

准备仓库外 JSON manifest（最大 64 KiB），schema 为 `IdentityApprovalEvidenceManifestV1`。manifest 至少包含 GitHub merge 的 accepted/rejected 两条和 Feishu production 的 accepted/rejected 两条；它只保存安全 ID、principal、roles digest、event digest、时间、SHA 和 zero-effect 计数，不能保存 raw event/review body、Task/PRD 正文或 token。

```bash
DELIVERY_LOOP_IDENTITY_APPROVAL_E2E=1 \
IDENTITY_APPROVAL_EVIDENCE_FILE=/secure/outside/identity-approval.json \
IDENTITY_APPROVAL_CONTROL_PLANE_URL=https://control.example \
IDENTITY_APPROVAL_CONTROL_PLANE_TOKEN="$CONTROL_PLANE_TOKEN" \
IDENTITY_APPROVAL_GITHUB_TOKEN="$GITHUB_READ_TOKEN" \
pnpm run e2e:identity-approval
```

CLI 沿用 Watt `476e3cdd2490d725fde174e7c697ebf00899edc6` 的 opt-in、64 KiB、0/1/2 退出和固定安全错误纪律。verifier 先核对 Case 8 identity projection 与 approvals，再用生产 GitHub adapter 读取 PR/reviews，确认 reviewer actor、reviewed head 和 author login；Feishu 的签名 delivery、tenant/open_id 与后台身份映射需要真实 adapter/tenant 证据和人工核对。任何 accepted/rejected case 都要求 merge/production outbox 和 deployment effect 为零。

当前没有真实 GitHub App、飞书 tenant、已部署 Worker 或控制面 URL；本地 fake API、schema example、dry-run 或 exit 2 只能证明验收契约存在，不能勾选真实外部身份 DoD。
