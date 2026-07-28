# GitHub merge 外部证据验收

本文件定义 Phase 5“合并成功由 GitHub webhook/API 核对 merge SHA；test required deployment/acceptance 已在merge前闭环，production仍等待独立事实”的可重跑验收契约。它只读已发生的控制面与 GitHub 事实，不创建、批准或合并 Pull Request。

## 事实边界

合并资格和合并事实是两件事：`ready_to_merge` 只代表 required checks、review、base 和 approval 满足，不能代表 PR 已经合并。只有 signed `pull_request` closed/merged webhook 或同一生产 projector 的 GitHub API 补偿，才能产生 `github_merges`、merge Evidence 和 merge SHA。

manifest 至少包含四类不同 Run：

- `merged_none`：GitHub PR 已合并、没有 test/production effect，Run 才能进入 `succeeded`；
- `merged_test`：test deployment与post-deployment acceptance已经作为required Plan Item通过，PR合并后Run进入`succeeded`，且不得重复部署；
- `merged_production`：PR 已合并但 production deployment 仍是后续事实，Run 必须保持 `deploying`；
- `not_merged`：closed-but-unmerged 的 PR 不能产生 merge、Evidence 或 merge effect。

每个已合并 case 同时索引 webhook 与 API observation。API observation 的 digest 必须等于 live GitHub merge fact 的 canonical digest；webhook digest 只作为签名 delivery 的安全索引。Case 8 的 `checks.mergeObservations` 只公开 observation ID/source/digest、PR number、状态和时间，不包含 payload、PR 正文、REST response 或 token。

## Manifest 与命令

仓库外 JSON manifest 必须符合 [`schemas/merge-evidence-v1.example.json`](../schemas/merge-evidence-v1.example.json) 对应的 `MergeEvidenceManifestV1`，最大 64 KiB。manifest 不能覆盖 Case 8 或 GitHub live fact。

```bash
DELIVERY_LOOP_MERGE_E2E=1 \
MERGE_EVIDENCE_FILE=/secure/outside-repo/merge.json \
MERGE_CONTROL_PLANE_URL=https://control.example \
MERGE_CONTROL_PLANE_TOKEN="$CONTROL_PLANE_READ_TOKEN" \
MERGE_GITHUB_TOKEN="$GITHUB_MERGE_READ_TOKEN" \
MERGE_GITHUB_API_URL=https://api.github.com \
pnpm run e2e:merge
```

退出码沿用 Watt 固定 commit `476e3cdd2490d725fde174e7c697ebf00899edc6` 的显式 opt-in 纪律：

- `0`：Case 8、GitHub API 和 no-effect/状态绑定全部通过；
- `1`：manifest schema、控制面 projection、webhook/API observation、merge SHA 或 Run state 不一致；
- `2`：未 opt-in、配置/manifest 不可读，验证尚未开始。

控制面和 GitHub 响应都采用 HTTPS origin、1 MiB 有界读取并拒绝分页；错误只输出固定 code。三个 token 仅在受控运行环境中注入，不写入命令参数、manifest、日志、Evidence、PR 或 `PROGRESS.md`。

## 真实试点步骤

1. 在已安装最小权限 GitHub App 的试点仓库准备三条拥有不同 deployment policy 的 PR，并由受保护分支上的真人完成合并；另准备一条 closed-but-unmerged PR。
2. 对已合并 PR 保存 signed delivery ID/digest、GitHub PR URL/merge SHA、控制面 Run/Plan/decision/publication/merge/Evidence 安全链接；对未合并 PR 保存 API `merged=false` 的安全摘要。
3. 主动漏掉一次 merge webhook，让 Cron/API compensation 发现同一 PR；重投 webhook/API 事实并证明只有一条 `github_merges`、两条 observation 和一条 merge Evidence。
4. 核对 no-deploy与test Run最终为`succeeded`，其中test已有deployment/acceptance Evidence且merge后无第二次deployment；production Run保持`deploying`等待独立事实。三者均没有merge outbox。
5. 把 manifest、命令退出码、Actions/PR/控制面链接及人工审计结论写入 `PROGRESS.md`。fake GitHub、schema example、local workerd、dry-run 或默认 exit 2 不能替代真实试点外部事实。
