# 测试失败修复循环外部证据验收

`pnpm run e2e:repair-loop` 只读核对已发生的 execution Action、控制面 Plan/Attempt/Evidence/blocker 和 GitHub commit/ref/compare，不创建新的 Attempt、Action、commit 或 PR。manifest 必须同时包含：

- `repair_succeeded`：第一次 verification failure 后只创建一个 `review_fix` Attempt，修复 Action 成功，生成新的 bot commit 和 verified commit/test Evidence；
- `repeated_fingerprint_blocked`：同一 failure fingerprint 连续两次后 Run blocked，不产生第三个 Action；
- `attempt_limit_blocked`：三个不同 fingerprint 消耗到上限后 Run blocked，不产生第四个 Action。

verifier 复用生产 `GitHubActionsApiClient` workflow-run parser，并对每个 Action 的唯一 job、checkout step 和 execution step 做有界核对；成功修复另外核对 commit API、branch ref 和 `checkoutSha...resultHeadSha` 的 fast-forward compare。控制面同时读取 `/v1/runs/:runId/plan` 与 Case 8 audit，绑定 Run/Plan/Item、Attempt ordinal/mode、Action ID/conclusion、Evidence、blocker reason/fingerprint/attempt count 和 execution dispatch 数量。

命令沿用 Watt `476e3cd` 的显式 opt-in、仓库外 64 KiB manifest、固定 0/1/2 退出、有界 HTTPS 和分页 fail-closed。默认未设置 `DELIVERY_LOOP_REPAIR_LOOP_E2E=1` 时 exit 2 且不访问网络；fake Action、schema example、仅重跑测试或 Agent 自报失败不能替代真实试点 Action 证据。
