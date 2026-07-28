# 受控 Replay 真实验收

本文验收 Phase 3 的真实 verification-step replay：重新核对已经发生的交付事实，但不重复 Agent dispatch、PR或Deployment。verifier本身严格只读，不负责发起replay。

## 1. 前置

- 已部署包含terminal verification step的当前Worker/Workflow代码；
- 一个真实Run已成功，active Plan为真实终态`completed`，至少一个verification Item有current passed decision；
- 同一Run已有经webhook/API核对的Agent Action、唯一Draft PR和至少一个test或production Deployment/Evidence；
- replay涉及的repo-write/deploy等approval在预计restart完成前仍有效；
- operations、Task/query和GitHub Actions/PR/Deployment只读token分别从受控Environment注入。

所有外部Action、PR和Deployment应落在一个最长七天的受控窗口内。不要把token、replay reason、Action日志、PR/Evidence正文或数据库行写入manifest。

## 2. 真实重放

1. 读取Case 8与correlation，记录Run version、Plan/verification Item、原Agent Action、PR publication/Evidence和Deployment stable/GitHub/Evidence ID。
2. 确认GitHub Actions、PR和Deployment API当前各只有预期对象；保存安全URL，禁止复制raw响应。
3. 通过正常认证入口调用`POST /v1/runs/:runId/replay`，提交current `expectedRunVersion`、exact Plan version/verification Item和不含Secret的reason。不得直接改D1或调用Cloudflare restart。
4. 等待replay outbox settled和`restartObservedAt`；Case 8必须出现稳定`plan-v<version>-item-<id>-verify` target，新`workflow_step_executions`使用推进后的Run version。
5. 再次读取correlation与GitHub API。Agent Action title/run ID、PR head/number和Deployment stable/GitHub ID必须与重放前相同；不得出现第二个dispatch/PR/deploy。
6. 把安全ID、SHA、digest、时间窗和approval绑定写入仓库外manifest，可复制[示例manifest](../schemas/controlled-replay-evidence-v1.example.json)形状。示例值不是证据。

## 3. 显式 opt-in 验证

```text
DELIVERY_LOOP_CONTROLLED_REPLAY_E2E=1
CONTROLLED_REPLAY_EVIDENCE_FILE=<仓库外manifest绝对路径>
CONTROLLED_REPLAY_CONTROL_PLANE_URL=<控制面HTTPS origin>
CONTROLLED_REPLAY_OPERATIONS_TOKEN=<Case 8只读短期token>
CONTROLLED_REPLAY_QUERY_TOKEN=<correlation只读短期token>
CONTROLLED_REPLAY_GITHUB_TOKEN=<Actions/PR/Deployments只读token>
CONTROLLED_REPLAY_GITHUB_API_URL=<可选；默认https://api.github.com>
```

运行：

```bash
pnpm run e2e:controlled-replay
```

- `0`：replay snapshot、approval、控制面identity和GitHub inventory全部匹配，重复计数均为0；
- `1`：manifest、snapshot、approval、分页或任一live事实不一致；
- `2`：未opt-in、配置缺失或manifest不可读取。

默认exit 2是前置缺失，不是skip、成功或真实replay失败。错误只输出固定code，summary只含安全ID、计数和固定状态。

## 4. 关门证据

真实DoD需要同时保存：verifier exit 0摘要、Cloudflare Workflow restart/step证据、原Agent Action URL、唯一PR URL、每个Deployment/Environment URL，以及Case 8/correlation安全审计链接。`PROGRESS.md`只能记录这些安全URL、ID、SHA、digest、时间和固定状态；不得保存token、raw响应、日志或正文。
