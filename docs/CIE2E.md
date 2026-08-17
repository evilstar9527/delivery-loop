# GitHub CI 外部证据验收

`pnpm run e2e:ci` 只读核对已经发生的 GitHub Actions run、workflow blob、CI 的完整并行 job 集合、`validate-task` 唯一命名校验 job 和全部 job log；它不 push、不开 PR、不触发 workflow，也不读取或保存 Task 正文。

manifest 固定包含四类 run：

- `ci_main_success`：`.github/workflows/ci.yml` 由 `push` 触发，`headBranch=main`，Node lane、四个固定 workerd shard 和最终 `verify` 聚合 job 全部成功；
- `ci_pull_request_success`：同一 CI workflow 由 `pull_request` 触发，同一组六个 job 全部成功；
- `validate_valid_success`：`.github/workflows/validate-task.yml` 的合法 `TaskEnvelope v1` 手动校验成功；
- `validate_invalid_failure`：含受控 canary 且缺少验收标准的输入在 `Validate without printing the task body` 步骤失败，前置步骤均成功，完整 job log 不含 canary。

每个 case 绑定 repository、run ID/event/conclusion/head SHA/branch、workflow path/blob SHA/content digest、run title digest 和最终 job 结果。verifier 用 run 的不可变 `headSha` 读取 workflow blob，解析 YAML 后要求 trigger、Node lane、固定 `1/4`～`4/4` workerd matrix、只依赖这两类lane的`verify`聚合门禁，以及setup/validation命令与仓库内固定契约完全一致。它还要求真实CI run的六个展开job名称、状态和conclusion精确匹配，并扫描全部日志；`validate-task`仍只允许唯一`validate` job。第三方setup Action必须固定到受审的不可变commit SHA，顶层`permissions`必须恰好只有`contents: read`。因此main/PR的可移动分支、本地workflow文件、可变Action tag、缺失shard或同名伪步骤都不能覆盖实际运行版本。

## 真实运行与证据准备

1. 在受控远端让 main push 和一个 PR 各完成一次 CI；记录两个 Actions run URL。
2. 生成只用于本次验收的随机 canary，把它放在合法 Task 的一个 source 标识字段中，通过标准输入手动运行 `validate-task.yml`；确认命名校验步骤成功且固定输出不含任何 Task 派生值。
3. 把同一 canary 放在 invalid Task 的 `intent.description` 中，并令 `intent.acceptanceCriteria=[]`；再次通过标准输入运行 workflow，确认只有命名校验步骤因 schema 拒绝而失败。不要把 canary 写入仓库、manifest、命令参数或 PROGRESS。
4. 按 [`ci-evidence-v1.example.json`](../schemas/ci-evidence-v1.example.json) 在仓库外创建 manifest。`displayTitleDigest`、`workflowContentDigest` 和 `logCanaryDigest` 都是 canonical SHA-256；manifest 只保存 digest，不保存 run title、Task JSON、日志、token 或 canary。
5. 使用只限定该仓库且仅有 Actions/Contents read 的短期 token 执行：

```bash
DELIVERY_LOOP_CI_E2E=1 \
CI_EVIDENCE_FILE=/private/ci-evidence.json \
CI_GITHUB_TOKEN="$GITHUB_ACTIONS_READ_TOKEN" \
CI_INVALID_TASK_CANARY="$CONTROLLED_INVALID_TASK_CANARY" \
pnpm run e2e:ci
```

如需受控 GitHub API 兼容代理，可额外设置无 userinfo/query/fragment 的 HTTPS origin：

```bash
CI_GITHUB_API_URL=https://api.github.example
```

## 判定和安全边界

- `0`：四类 run、exact workflow blob、最小权限、两组完整 CI 并行 job、两个唯一 validation job、validation step 和十四份有界日志全部一致，canary 零命中；
- `1`：manifest、run、workflow、job、日志、分页或大小边界不一致；
- `2`：未显式 opt-in、配置不完整或 manifest 不可读，并在读取 manifest/访问网络前结束。

命令直接沿用 Watt `476e3cd` 的显式 opt-in、仓库外 64 KiB manifest、固定 0/1/2 退出、安全错误和有界读取纪律；Actions run 解析继续复用生产 `GitHubActionsApiClient`。GitHub JSON 单响应上限 1 MiB、单 job log 上限 8 MiB，任何下一页或不安全重定向都 fail-closed。fake API、示例 manifest、默认 exit 2、本地 `pnpm run verify` 或 dry-run 均不能替代真实 Actions URL/API 证据。
