# Phase 5 真实试点验收

本 runbook 只用于显式 opt-in 的真实 GitHub/Cloudflare/部署环境验收。默认 `pnpm run verify` 不读取外部凭证、不发起网络请求，也不把示例 manifest 当成完成证据。

## 1. 当前外部前置

运行前必须由资源 owner 明确提供并授权：

1. GitHub owner/repository、visibility、默认分支保护与 Actions 预算；GitHub App 只安装到该试点仓库。
2. 已部署的控制面 HTTPS origin，以及只读查询所需的短期服务 token。
3. GitHub `test` Environment、与生产账户/namespace隔离的 `test:*` OIDC role、test-only Secret和可查询测试 URL。
4. GitHub `production` Environment required reviewers；云端 `production:*` role实际指向隔离demo账户/namespace，不允许触达真实生产。
5. 可查询的OIDC审计、Environment reviewer、Secret隔离、失败与恢复结果链接。链接不得含userinfo、query token或fragment。

当前本仓库没有Git remote，`delivery.yaml`为`deployment.mode: none`，因此这些前置尚未满足。创建远端、安装App、部署控制面或触发真实Action属于外部写操作，不能由本地测试代替。

## 2. 演练顺序

### 2.1 测试环境

1. 在exact commit声明test deployment与独立acceptance contract。
2. 经exact approval创建GitHub Deployment并运行test Environment job。
3. 等待HMAC webhook或read-only API reconciliation把deployment推进为`succeeded`并生成verified Evidence。
4. 独立运行acceptance Action，要求Runner result与GitHub completed success双事实一致。
5. 从测试job读取production-only canary，预期由外部Environment/云策略拒绝；只记录安全审计URL，不记录Secret值。

### 2.2 隔离production demo

1. required reviewer批准一条绑定exact merge SHA的production deployment，得到成功的Deployment、Action、Environment URL与D1 Evidence。
2. 使用另一条Run/Deployment制造平台`failure`或`error`；Action输出不能覆盖平台失败，D1 Run必须为`failed`。
3. 对失败SHA执行仓库/平台批准的demo恢复流程。当前控制面没有production自动rollback入口，因此manifest必须如实记录`manual`或独立受审`contract`，不能把test rollback冒充production权限。
4. 证明恢复后的外部demo环境回到已知成功SHA，并保存Action、云审计与环境结果链接。

success、failure必须使用不同Run、Deployment和Action ID；rollback必须绑定failure SHA，恢复SHA必须等于manifest中的已知成功SHA。

## 3. Evidence manifest

复制 [pilot-evidence-v1.example.json](../schemas/pilot-evidence-v1.example.json) 到仓库外私有位置并替换全部占位值。该文件只允许白名单ID、SHA和无query的HTTPS证据链接；不得写token、webhook payload、Runner日志、云凭证或Secret值。

manifest本身不是外部事实。验证器会使用只读凭证交叉核对：

- 三条控制面`GET /v1/runs/:runId/plan`安全投影；
- 五条GitHub Actions run的repository、completed conclusion和exact head SHA；
- 三个GitHub Deployment的repository绑定、task、environment、SHA与latest status；
- test deployment/acceptance及production success/failure的D1 Evidence、approval和外部状态。

OIDC、reviewer、隔离与恢复结果使用manifest中的外部审计链接留账；这些平台没有统一API，仍需人工review链接内容，不能因schema通过自动视为已核对。

## 4. 显式 opt-in 命令

在受控CI Environment或临时Secret注入环境设置以下变量，避免把值写入仓库、manifest或命令输出：

```text
DELIVERY_LOOP_PILOT_E2E=1
PILOT_EVIDENCE_FILE=<仓库外manifest绝对路径>
PILOT_CONTROL_PLANE_URL=<控制面HTTPS origin>
PILOT_CONTROL_PLANE_TOKEN=<只读短期token>
PILOT_GITHUB_TOKEN=<试点仓库Actions/Deployments只读token>
PILOT_GITHUB_API_URL=<可选；默认https://api.github.com>
```

运行：

```bash
pnpm run e2e:pilot
```

退出码沿用Watt E2E纪律：

- `0`：live API交叉核对通过，输出只含安全计数和固定状态；
- `1`：manifest非法、API事实不一致或外部响应非法；
- `2`：未显式opt-in、缺少前置或manifest不可读取。

错误只输出固定错误码，不输出token、response body或manifest正文。只有exit 0、人工review全部审计链接且把外部URL/摘要写入`PROGRESS.md`后，才能勾真实试点DoD。
