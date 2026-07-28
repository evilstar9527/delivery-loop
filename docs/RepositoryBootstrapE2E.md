# GitHub 仓库初始化外部证据验收

`pnpm run e2e:repository-bootstrap` 只读核对用户已确认并已创建的 GitHub 仓库；它不会创建仓库、修改 visibility、设置 `origin` 或写 branch rules。真实创建仍必须在用户明确选择 owner、repository、visibility、默认分支和保护策略之后进行。

仓库外 `RepositoryBootstrapEvidenceManifestV1` 分成三层事实：

- `decision`：用户确认记录的安全索引，只保存 decision ID/time、确认主体 digest，以及 `repository + visibility + defaultBranch + protectionRulesDigest` 的 canonical selection digest；
- `repository/branch/protection`：GitHub repository ID、owner/type、visibility、默认分支 head，以及所有当前 `active` branch rule 的 type/ruleset/source/parameters digest；
- 本地 Git `origin`：命令运行时通过固定 argv `git remote get-url origin` 读取，不写 manifest；只接受无 credential 的 `https://github.com/...`、`git@github.com:...` 或 `ssh://git@github.com/...`。

manifest 不能证明“用户本人确实确认过”；`decisionId/confirmedAt/confirmedByPrincipalDigest` 必须与仓库外的人审记录一起核对。verifier 负责证明该决策摘要与当前本地 `origin`、GitHub repository、默认分支和 active rules 完全一致，避免本地 `git init`、同名其他仓库或 manifest 自报冒充远端完成。

## 真实执行

1. 用户明确确认 owner/repository、`public|private|internal`、默认分支及保护规则；把确认记录保存在受控系统，正文不要写入 manifest。
2. 用经批准的 GitHub 管理流程创建仓库和默认分支，配置 branch rules；再把本地 `origin` 设为该仓库。不要把 PAT 写进 remote URL。
3. 使用 [`repository-bootstrap-evidence-v1.example.json`](../schemas/repository-bootstrap-evidence-v1.example.json) 在仓库外创建 manifest。rule `parameters` 只在采集进程内计算 canonical SHA-256，不保存 raw rules response。
4. 使用只限定目标仓库、仅含 repository metadata/contents/rules read 的短期 token 执行：

```bash
DELIVERY_LOOP_REPOSITORY_BOOTSTRAP_E2E=1 \
REPOSITORY_BOOTSTRAP_EVIDENCE_FILE=/private/repository-bootstrap.json \
REPOSITORY_BOOTSTRAP_GITHUB_TOKEN="$GITHUB_REPOSITORY_READ_TOKEN" \
pnpm run e2e:repository-bootstrap
```

受控 GitHub API 兼容代理可通过无 userinfo/query/fragment 的 HTTPS origin 指定：

```bash
REPOSITORY_BOOTSTRAP_GITHUB_API_URL=https://api.github.example
```

## 判定与边界

- `0`：decision/rules digest、本地 origin、repository identity/visibility/lifecycle、默认分支 protected/head 及所有 active rules 全部一致；
- `1`：manifest、决策摘要、远端绑定或 GitHub live fact 不一致；
- `2`：未显式 opt-in、配置/manifest/本地 origin 缺失，并且默认无 opt-in 时在读取 manifest、Git 或网络前结束。

命令沿用 Watt `476e3cd` 的显式 opt-in、仓库外 64 KiB manifest、固定 0/1/2 和安全错误纪律；GitHub 响应限制 1 MiB并拒绝下一页。Watt 没有 repository/bootstrap/branch-rules 业务模块可直接复制，因此 repository/decision/rule binding 为 delivery-loop 新增；有界 GitHub JSON 和固定 Git argv 复用本项目既有生产原语。schema example、fake API、本地 `git init`、默认 exit 2 或 verifier 单独 exit 0 都不能替代用户确认记录和真实 GitHub 页面/API。
