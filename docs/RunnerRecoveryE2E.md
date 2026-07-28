# Runner 强制终止恢复验收

本文只验收 Phase 3 的真实 GitHub Runner 恢复，不执行强制终止，也不替代本地 recovery 单测或 Phase 5 deployment Pilot。

## 1. 前置

- 已部署控制面、D1/R2、GitHub App dispatcher和试点仓库固定`.github/workflows/delivery-agent.yml`；
- 试点Run至少有两个Plan Item：第一个已由verified Evidence通过，第二个正在执行且已把checkpoint commit推到外部Git；
- GitHub只读token可读取该仓库Actions和commit；用途隔离的控制面token分别只读Plan/correlation与Case 8；
- Agent credential、repo-write approval和Actions预算已由受控Environment提供，Secret不写入manifest、argv、日志或本文。

## 2. 真实演练

1. 记录此前passed Item的ID、verification ID和Evidence ID，以及当前执行Item、Attempt、Action run ID。
2. 等待当前Attempt发布一个branch/head已与外部Git commit一致的checkpoint；保存checkpoint ID、sequence、digest、branch和SHA，不保存正文。
3. 在GitHub界面或受控API强制取消当前执行中的Action。等待控制面通过签名webhook/API reconciliation将Action结论核对为`cancelled`，stuck detector把Attempt置`lost`、将lease generation恰好提升一代、撤销该Attempt全部旧token并settle唯一`workflow_cancel` outbox。
4. 通过正常、已授权的retry入口创建replacement Attempt；不得直接改D1、伪造callback或复用旧token。等待新的Action从checkpoint继续，产生不同的result commit，并完成当前Item verification/Evidence。
5. 读取Case 8，记录可重算report digest、旧token安全ID/generation/revokedAt、lost/replacement dispatch和`workflow_cancel` outbox ID，以及完整effect outbox/PR/deployment安全inventory；不得记录token值。将这些安全ID/SHA/digest写到仓库外manifest，可从[示例manifest](../schemas/runner-recovery-evidence-v1.example.json)复制形状。示例值不是外部证据。

旧Runner在取消后不能推进head或Evidence；因此最终控制面投影必须显示lost Attempt head等于checkpoint head，replacement recovery lineage精确指向lost Attempt/checkpoint。GitHub branch ref必须指向replacement result，compare必须证明checkpoint是base/merge-base且result恰好ahead一个result commit、不behind，不能只提交两个互不相干的存在SHA。lost ordinal之后不能存在此前passed Item的Attempt，replacement也不能为该Item产生Evidence。Case 8中不得出现controlled replay，所有effect outbox必须完整入manifest且settled；correlation中的PR/deployment inventory必须完整且不分页。

## 3. 显式 opt-in 验证

在受控CI Environment或临时Secret注入环境设置：

```text
DELIVERY_LOOP_RUNNER_RECOVERY_E2E=1
RUNNER_RECOVERY_EVIDENCE_FILE=<仓库外manifest绝对路径>
RECOVERY_CONTROL_PLANE_URL=<控制面HTTPS origin>
RECOVERY_CONTROL_PLANE_TOKEN=<控制面只读短期token>
RECOVERY_OPERATIONS_TOKEN=<Case 8只读短期token>
RECOVERY_GITHUB_TOKEN=<试点仓库Actions/contents只读token>
RECOVERY_SECURITY_CANARY=<仓库外credential-shaped canary>
RECOVERY_GITHUB_API_URL=<可选；默认https://api.github.com>
```

运行：

```bash
pnpm run e2e:runner-recovery
```

退出码直接沿用Watt-derived E2E纪律：

- `0`：控制面Plan/correlation/Case 8、旧generation/token/cancel、完整副作用inventory、两条Action/job、两个commit、branch ref和单commit fast-forward事实全部匹配；
- `1`：manifest非法、API响应非法或任一事实不一致；
- `2`：未opt-in、缺前置或manifest不可读取。

所有HTTPS读取固定10秒timeout、有界读取、分页fail-closed，并在JSON parse前扫描配置token和credential-shaped canary。命令只输出固定安全摘要或错误码，不输出token、manifest、raw API、Action log、checkpoint/Agent正文或数据库行。默认exit 2表示前置缺失，不是skip、失败演练或成功。

## 4. 关门证据

只有以下事实同时存在，才能勾真实DoD：

- verifier exit 0的安全摘要；
- 旧cancelled与新successful Actions run URL，以及两者job/step状态；
- checkpoint SHA与replacement result SHA的GitHub commit URL；
- 控制面Plan/correlation/Case 8安全查询链接或受控审计记录，能复核generation提升、token撤销、cancel settled及完整effect inventory；
- 人工核对取消时序、repo-write审批仍有效且未发生越权副作用。

`PROGRESS.md`只记录上述安全URL、ID、SHA、固定状态和命令摘要；不得复制Action日志、token、raw响应、模型正文或数据库行。
