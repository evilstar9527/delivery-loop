# Merge gate E2E

本场景验证“PR 可以合并”与“已经执行 merge effect”是两个不同事实。验收必须同时证明：

- 一个 exact PR 在 required checks、review、base、mergeability 和未过期 merge approval 均满足时，控制面产生唯一 `ready_to_merge` decision；
- required check 未完成、required check 失败、review 不足、base 非最新、approval 过期分别产生对应 rejected evaluation；
- 所有拒绝路径以及 ready 路径都没有 merge outbox、merge ledger 或 GitHub merge mutation。

## 本地穿透证据

`test/merge-gate-evidence.test.ts` 使用 fake HTTPS 响应覆盖生产 `GitHubMergeGateApiClient` 的六个只读接口：PR、base ref、branch rules、check-runs、commit statuses 和 reviews。测试还覆盖 Case 8 projection drift、GitHub fact drift、merge effect drift、raw response/token 零传播和 CLI opt-in。

`test/workflow/case8-audit-report.test.ts` 在 D1 中写入完整 rejected merge-gate observation、normalized required check、evaluation 和 publication/draft lineage，再通过 `GET /v1/runs/:id/audit` 验证安全投影。Case 8 只公开 fact digest、SHA、计数和固定 reason，不公开 GitHub REST body、review body 或 token。

## 真实试点验收

准备仓库外 JSON manifest（最大 64 KiB），schema 为 `MergeGateEvidenceManifestV1`。manifest 只能保存安全 ID、SHA、digest、状态、时间和零 effect 计数；不能保存 Task/PR 正文、raw webhook/REST response、数据库行、Agent 输出或 token。

```bash
DELIVERY_LOOP_MERGE_GATE_E2E=1 \
MERGE_GATE_EVIDENCE_FILE=/secure/outside/merge-gate.json \
MERGE_GATE_CONTROL_PLANE_URL=https://control.example \
MERGE_GATE_CONTROL_PLANE_TOKEN="$CONTROL_PLANE_TOKEN" \
MERGE_GATE_GITHUB_TOKEN="$GITHUB_READ_TOKEN" \
pnpm run e2e:merge-gate
```

CLI 行为沿用 Watt `476e3cdd2490d725fde174e7c697ebf00899edc6` 的 E2E 门禁原语：未显式 opt-in 或缺少前置配置返回 `2`；manifest/schema 或外部事实失败返回 `1`；全部事实通过返回 `0`。manifest 和响应都有大小上限，token 只进入对应 HTTP `Authorization` header，stdout 只输出计数和 reason 集合。

verifier 先读取每个 Run 的 Case 8 audit，再使用生产只读 GitHub adapter 重算完整 merge fact。ready case 要求 evaluation passed、decision 存在、Run 已进入 `ready_to_merge` 且所有 checks/reviews/base/mergeability 通过；rejected case 要求 evaluation reason exact、decision 不存在。两条路径都要求 merge changes/outboxes 为零。

当前仓库没有 Git remote、已部署 Worker、真实 GitHub App/试点 repo 或可用控制面 URL，因此默认命令只做 opt-in/configuration gate，不能把 fake API、schema example、dry-run 或 exit 2 当成真实外部 DoD。
