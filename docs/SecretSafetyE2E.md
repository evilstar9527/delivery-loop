# Secret safety 外部证据验收

本命令只读核对已经发生的 Action、GitHub Draft PR、控制面 Case 8 和 raw transcript registry，不创建 PR、Action、artifact 或 Secret。manifest 固定两类 case：

- `safe_draft_pr`：Action 成功且日志 clean，PR 已由 GitHub API 核对为同仓库/open/draft/exact head/body digest；raw transcript 只以 ciphertext digest/metadata 投影并附仓库外审计链接；
- `blocked_secret_publication`：publication 仍为 pending，pull-request outbox 以固定 `pull_request_secret_detected` settled，GitHub PR number/url/evidence 均为空。

manifest 只保存 ID、SHA、digest、枚举、时间和无 query 的 HTTPS 审计 URL，不保存 canary、Task/PRD/PR/log 正文、raw webhook/REST、Action output、ciphertext、R2 key 或 token。canary 仅由显式 opt-in 的 `SECRET_SAFETY_CANARY` 进入 verifier 内存，日志扫描发现明文立即失败且不会输出命中值。

## 显式 opt-in

```bash
DELIVERY_LOOP_SECRET_SAFETY_E2E=1 \
SECRET_SAFETY_EVIDENCE_FILE=/private/secret-safety.json \
SECRET_SAFETY_CONTROL_PLANE_URL=https://control.example \
SECRET_SAFETY_CONTROL_PLANE_TOKEN="$CONTROL_PLANE_READ_TOKEN" \
SECRET_SAFETY_GITHUB_TOKEN="$GITHUB_ACTIONS_READ_TOKEN" \
SECRET_SAFETY_CANARY="$CONTROLLED_CANARY" \
pnpm run e2e:secret-safety
```

退出码沿用 Watt `476e3cdd2490d725fde174e7c697ebf00899edc6` 的 explicit opt-in 纪律：

- `0`：Case 8、Action metadata/log jobs、PR API（或 zero PR effect）、ciphertext registry 全部一致；
- `1`：manifest、projection、Action、日志泄漏、PR 或 publication effect 不一致；
- `2`：未 opt-in、配置不完整或 manifest 不可读，且不会访问网络。

GitHub jobs/logs API 只在内存中有界读取并扫描；响应拒绝分页，单 job 8 MiB、单 Run 32 MiB。raw artifact 的真实 ciphertext 内容和云端 R2 权限仍需人工核对 `auditUrl`，verifier 不下载或解密 ciphertext。fake GitHub/workerd、示例 manifest、默认 exit 2 不能替代真实试点证据。
