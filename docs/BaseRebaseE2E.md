# Base branch rebase / conflict 外部证据验收

这条验收把 base branch 前进分成两个互斥结果：

- `passed`：GitHub `compare` 证明新 base 是旧 base 的纯 fast-forward；只有未发布、已核对的 bot head 才能在新 Attempt branch 上 rebase。控制面必须核对新 Attempt、Action、targeted/required verification、commit/head，并由 GitHub API 再核对 source/target branch ref。分支更新必须是 `fastForward=true`、`force=false`，不接受 force-push。
- `blocked`：base history 是 `behind`、`diverged` 或异常关系。控制面必须保存 immutable conflict、阻断 Run/Plan、撤销权限并创建唯一 Workflow cancel；rebase Action、target branch、execution dispatch 和新 Evidence 都不得出现，下一步固定为 `manual_rebase`。

## Manifest 与命令

Manifest 只放 ID、SHA、digest、状态、时间、Attempt/outbox 标量和无 query/fragment 的外部 API 事实，不放 diff、reason 正文、任务/PRD、raw webhook/REST 响应、日志、数据库行或 token。文件必须放在仓库外，最大 64 KiB：

```sh
DELIVERY_LOOP_BASE_REBASE_E2E=1 \
BASE_REBASE_EVIDENCE_FILE=/secure/outside/base-rebase.json \
BASE_REBASE_CONTROL_PLANE_URL=https://control.example \
BASE_REBASE_CONTROL_PLANE_TOKEN="$CONTROL_PLANE_READ_TOKEN" \
BASE_REBASE_GITHUB_TOKEN="$GITHUB_READ_TOKEN" \
pnpm run e2e:base-rebase
```

退出码沿用 Watt 固定提交 `476e3cdd2490d725fde174e7c697ebf00899edc6` 的 E2E 约定：

- `0`：Case 8、D1 rebase/conflict lineage、GitHub ref/compare、Action/branch/evidence 事实全部一致；
- `1`：manifest、控制面投影、SHA/digest、Action、branch fast-forward/no-force 或副作用事实漂移；
- `2`：没有显式 opt-in、配置不全或 manifest 不可读，且不访问网络。

## 必须人工确认的真实边界

GitHub API 能证明当前 ref 和祖先关系；`branchUpdate.force=false` 还需要试点仓库的 push webhook/audit 事实证明没有 force-push。`blocked` 路径的 `pushEvents=0` 需要用 GitHub webhook/audit 或组织审计后台核对，API 列表只能证明没有对应 workflow run、target branch 为空。示例 manifest、本地 fake API、dry-run 和默认 exit 2 只能证明本地验收契约，不能关闭真实外部 DoD。

Case 8 只投影 `checks.baseRebases` 与 `checks.baseConflicts` 的安全字段；完整差异、Git 输出和 Runner 原始错误仍留在受控执行面，不进入查询、日志或验收 manifest。
