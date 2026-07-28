# Production Environment approval 外部证据验收

本文件定义 Phase 5“生产部署必须经过 GitHub Environment reviewer 或等价外部审批；批准绑定 revision + merge SHA + environment”的只读验收契约。它不创建 Deployment、Action、Environment approval 或云资源。

## 事实边界

production approval 是 post-merge release ledger，不是 merge gate，也不是 deployment success。控制面必须从当前 Run/Task/Plan/immutable `github_merges` 派生并冻结：

- Task revision、Plan/version/digest、base SHA；
- merge ID、merge SHA、`environment=production`；
- 外部 reviewer source/event、当前 human principal、`approve:production_deploy` role 和 author separation；
- `production_release_approval_bindings` 与 accepted approval lineage。

accepted approval 本身不自动创建 production Deployment；本地验收要求 production outbox、production deployment 和 production Attempt 均为零，避免把 approval 当成 effect。self-approval、merge binding 不一致、过期或未授权路径必须没有 accepted approval/binding，也不能产生 production effect。

manifest 至少包含一条 accepted、一条 self-approval rejected 和一条 merge-binding rejected case。每条 case 同时携带已合并 PR 的安全 fact；verifier 使用生产 `GitHubMergeStatusApiClient` 重新读取 PR，确认 live merge SHA 与 manifest/控制面一致。

## Manifest 与命令

仓库外 JSON manifest 必须符合 [`schemas/production-approval-evidence-v1.example.json`](../schemas/production-approval-evidence-v1.example.json) 对应的 `ProductionApprovalEvidenceManifestV1`，最大 64 KiB。manifest 只保存安全 ID、SHA、digest、枚举、时间和 external event 索引，不保存审批正文、Task/PRD、Environment Secret、OIDC/JWT、raw webhook/REST 或 token。

```bash
DELIVERY_LOOP_PRODUCTION_APPROVAL_E2E=1 \
PRODUCTION_APPROVAL_EVIDENCE_FILE=/secure/outside-repo/production-approval.json \
PRODUCTION_APPROVAL_CONTROL_PLANE_URL=https://control.example \
PRODUCTION_APPROVAL_CONTROL_PLANE_TOKEN="$CONTROL_PLANE_READ_TOKEN" \
PRODUCTION_APPROVAL_GITHUB_TOKEN="$GITHUB_MERGE_READ_TOKEN" \
PRODUCTION_APPROVAL_GITHUB_API_URL=https://api.github.com \
pnpm run e2e:production-approval
```

退出码沿用 Watt 固定 commit `476e3cdd2490d725fde174e7c697ebf00899edc6` 的 opt-in 纪律：

- `0`：release binding、identity/rejection、live merge SHA 与 zero production effect 全部通过；
- `1`：manifest、Case 8、binding、identity、merge fact 或 effect 不一致；
- `2`：未 opt-in、配置/manifest 不可读，验证尚未开始。

## 真实试点步骤

1. 在受保护 `production` Environment 中由真人 reviewer 批准一条已经合并、且 exact Task revision/Plan/base/merge SHA 绑定的 release；保留 GitHub Environment review 或等价 Feishu approval 的安全 event ID、时间和审计链接。
2. 另制造 self-approval、旧 merge SHA/错误 binding、过期或未审批路径；记录固定拒绝原因和零 production outbox/deployment/job 事实。
3. 运行 verifier，核对 Case 8 `identityApprovals` 与 `productionApprovals`、`answers.approvals`、Run/Plan/revision/base/merge 以及 GitHub PR API。
4. 在独立 deployment/status 验收之前，不应出现 production Deployment；后续真实部署由单独的 production status DoD 验收，不能用本命令代替。

真实 Environment reviewer、GitHub/Feishu 签名 event、云 role trust 和 production Secret 隔离仍需人工外部核对；fake API、schema example、local Workerd、dry-run 或默认 exit 2 不能关闭真实 DoD。
