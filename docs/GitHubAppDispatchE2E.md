# GitHub App 单仓库安装与固定 dispatch 真实验收

本文验收 Phase 1 的 GitHub App 边界：App installation选择且只选择一个试点仓库，控制面的唯一analysis dispatch触发该仓库固定`.github/workflows/delivery-agent.yml@refs/heads/<defaultBranch>`，GitHub最终只有一个stable-title Action和一个成功analysis job。

`pnpm run e2e:github-app-dispatch`严格只读，不安装App、不修改repository selection、不创建token、不触发workflow。schema example、fake API、本地dispatcher测试、其他E2E中出现的Action URL和默认exit 2都不能替代本项真实事实。

## 1. 前置与凭证边界

- GitHub App已由受控owner创建，repository permissions至少覆盖本轮manifest声明的`metadata:read + contents:read|write + actions:write`，订阅`workflow_run`；额外权限/事件只能来自schema中的产品用途allowlist，admin/org/secret等权限不允许进入manifest；
- installation的repository selection必须是`selected`，GitHub设置页中只能看到目标试点仓库；App不得安装到`All repositories`；
- `GITHUB_APP_DISPATCH_APP_JWT`是最长10分钟的App JWT，只用于读取`/app`、installation和repo→installation绑定；
- `GITHUB_APP_DISPATCH_INSTALLATION_AUDIT_TOKEN`必须由受控credential流程在不提交`repositories`或`repository_ids` narrowing的情况下签发，因此`GET /installation/repositories`代表该installation的完整selected inventory；token权限只需metadata/contents/actions read。verifier无法从token字符串反推签发body，所以最终仍必须人工核对settings页和credential issuance审计；
- 控制面Run/Plan token与Case 8 operations token用途隔离。所有凭证只从受控Environment注入，只进入Authorization header，不写manifest、命令行、日志或`PROGRESS.md`。

## 2. 真实执行与采集

1. 在GitHub App设置页选择唯一试点仓库，记录App ID/slug/owner、installation ID/target、权限、事件、repository selection和无query的settings链接。
2. 在试点仓库默认分支放置固定`.github/workflows/delivery-agent.yml`，完成branch protection后，以真实人工Task创建Run。不得直接调用GitHub workflow_dispatch绕过D1 outbox。
3. 等待analysis Attempt完成并激活Plan。控制面必须只有一个analysis Attempt、一个settled `analysis_dispatch` outbox，Attempt的`workflowRef`固定到目标default branch，Case 8中的GitHub run ID/conclusion与外部API一致。
4. 用App JWT交叉读取`GET /app`、`GET /app/installations/:id`和`GET /repos/:owner/:repo/installation`；三个响应的App/installation/target/permission/event必须相同且未suspend。
5. 用未按repository二次收窄的短期audit token读取完整`GET /installation/repositories?per_page=100`；必须`total_count=1`且唯一repo的numeric ID/full name/visibility/default branch/lifecycle匹配manifest。出现下一页直接失败。
6. 按Action的immutable head SHA读取workflow blob并计算content digest。契约必须仍是：stable run-name、仅`workflow_dispatch`、reference-only固定inputs、`contents:read + id-token:write`、60分钟job、SHA-pinned Actions、exact checkout SHA、analysis脚本和最终clean Git检查。
7. 读取exact Action、同workflow/branch的完整run inventory和jobs API。stable title `delivery-loop/<attemptId>`只能命中一个`run_attempt=1`成功Action；唯一`attempt` job中analysis step和clean-workspace step成功，execution step必须skipped。
8. 参照[示例manifest](../schemas/github-app-dispatch-evidence-v1.example.json)在仓库外记录安全标量与digest。不要复制workflow内容、job log、GitHub raw response、Task/Plan正文、App JWT或installation token。

## 3. 显式 opt-in 验证

```text
DELIVERY_LOOP_GITHUB_APP_DISPATCH_E2E=1
GITHUB_APP_DISPATCH_EVIDENCE_FILE=<仓库外manifest绝对路径>
GITHUB_APP_DISPATCH_CONTROL_PLANE_URL=<控制面HTTPS origin>
GITHUB_APP_DISPATCH_CONTROL_PLANE_TOKEN=<Run/Plan只读短期token>
GITHUB_APP_DISPATCH_OPERATIONS_TOKEN=<Case 8只读短期token>
GITHUB_APP_DISPATCH_APP_JWT=<短期GitHub App JWT>
GITHUB_APP_DISPATCH_INSTALLATION_AUDIT_TOKEN=<未按repo二次收窄的只读短期installation token>
GITHUB_APP_DISPATCH_GITHUB_API_URL=<可选；默认https://api.github.com>
```

运行：

```bash
pnpm run e2e:github-app-dispatch
```

- `0`：App/installation/repository、D1 Run/Plan/Attempt/outbox、immutable workflow blob、Action inventory和唯一job全部一致；
- `1`：manifest、live事实、权限/事件、分页/大小边界、workflow/job或duplicate计数不一致；
- `2`：未显式opt-in、配置缺失或manifest不可读取。

默认exit 2在读取manifest、token和网络之前结束。错误只输出固定code；成功summary只含App/installation/repo/Run/Action安全ID、计数和固定布尔值。

## 4. 关门证据与不能自动证明的事实

真实子项必须同时入账：verifier exit 0摘要、App与installation settings链接、无repository narrowing的audit token签发审计、唯一repo页面、Action URL、控制面Run/Case 8安全链接和采集时间。只读API能证明“该token看见一个repo”，不能单独证明token签发时没有二次repository narrowing；因此缺settings页与签发审计时，即使命令exit 0也不能勾真实子项或父DoD。
