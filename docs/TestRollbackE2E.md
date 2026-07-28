# Test rollback 真实外部证据验收

## 目标与完成边界

本验收证明仓库在 exact 失败 SHA 明确声明 rollback contract 时，测试环境自动回滚可以真实执行并
恢复环境；同时证明未声明 contract 和 production failure 都不会越权触发 test rollback。它不创建
失败、dispatch Action、签发 OIDC、执行云命令，也不批准 production 自动回滚。

仓库外 `TestRollbackEvidenceManifestV1` 必须固定四条独立 Run：

1. verified test deployment failure 触发 rollback，Runner exit 0 与 GitHub completed/success 双事实
   收敛为一条 verified rollback Evidence；
2. test deployment 已成功、verified post-deployment acceptance failure 触发同样的独立 rollback；
3. exact 失败 SHA 的 `delivery.yaml` 没有声明 rollback，只有 immutable negative contract
   observation，零 rollback Attempt/outbox/Action/Evidence；
4. verified production deployment failure，零 test rollback contract/Attempt/outbox/Action/Evidence。

schema example、fake HTTPS、本地 workerd、manifest 自报、默认 exit 2、Wrangler dry-run、Action URL
或云审计 URL 本身都不能替代真实外部事实。只有 live verifier exit 0，并由真人打开两条云 rollback
审计和环境结果、核对 production 决策记录后，才可勾 DOD 的真实外部事实子项。

## Authority 分工

- `GET /v1/runs/:runId/audit` 是控制面安全投影：正向 case 必须绑定 source failure Evidence、exact
  contract observation、独立 rollback snapshot/Attempt/outbox、policy/contract digest、OIDC
  attestation、Runner result、双源 observation 和 rollback Evidence。原失败 Item/Run 不得被回滚
  Evidence 伪装为 passed/succeeded。
- GitHub REST 对正向 case 实时读取 exact rollback Action；repository、workflow、head SHA、base branch、
  stable title、run attempt、status/conclusion 必须一致。控制面记录 `github_run_id` 不能替代该外部事实。
- GitHub workflow inventory 对两条负向 case 使用 exact rollback workflow、head SHA 和受控时间窗口查询；
  必须 `total_count=0`、无分页且返回零 run。manifest 的 `actions: 0` 不能自证零 Action。
- `cloudReview` 保存每次测试回滚的云审计 URL、环境结果 URL、`restored` 结果、真人 reviewer 与时间；
  verifier 只核对安全结构和已记录 review，云平台语义必须由真人打开真实外部链接复核。
- `productionDecision` 固定为 `not_approved`，并绑定仓库外治理记录与 reviewer。若未来批准 production
  自动回滚，必须另建 production 专属 revision/merge/failure/Environment/OIDC/outbox 契约与演练，
  不能复用本 test verifier 越界放行。

Case 8 只投影白名单标量：contract disposition/digest、rollback lineage/status、Runner 四个结果标量、
GitHub/OIDC identity、external fact 和 observation identity。token、OIDC JWT、raw `delivery.yaml`、argv、
Runner output、webhook/REST body、云凭据和任务正文都不得进入报告或 manifest。

## 真实演练与 manifest 采集

1. 在受控试点仓库的 `delivery.yaml` 为 test target 声明固定 rollback workflow、`test` Environment、
   `delivery-loop-test-rollback` audience、独立 `test:*` role、结构化 argv，并把
   `deployment_failure` 与 `acceptance_failure` 纳入 `automaticOn`。
2. 使用两个不同 SHA/Run 分别制造 test deployment failure 和 post-deployment acceptance failure。
   确认控制面只创建一条 rollback Attempt/outbox，固定 workflow checkout exact 失败 SHA，云角色不能
   访问 production，并由 Runner result + signed webhook/API compensation 双事实生成一条 Evidence。
3. 打开云审计和测试环境结果，确认环境恢复；把无 userinfo/query/fragment 的 HTTPS URL、reviewer 和
   review time 写入仓库外 manifest。不得把日志、命令输出、token 或 OIDC JWT写入 manifest。
4. 使用第三个 SHA 移除 rollback contract 后制造 verified test failure。等待 reconciliation 窗口结束，
   记录 `not_declared`/`policy_missing`/`policy_invalid` observation，并固定 GitHub 零 Action 查询窗口。
5. 使用第四个 Run 制造 verified production deployment failure。确认 production 自动回滚尚未批准，
   在同样受控窗口内证明 test rollback workflow 零 run，并记录真实治理决定。
6. 创建 credential-shaped synthetic canary，只把 canonical SHA-256 写入 manifest；原文仅经当前进程
   环境变量传入，用于扫描控制面和 GitHub 的每个响应。

manifest 参考
[`test-rollback-evidence-v1.example.json`](../schemas/test-rollback-evidence-v1.example.json)。四条 Run、
两条正向 Action 和两个 rollback ID 必须互异；负向窗口必须覆盖 failure/contract observation 到
reconciliation 结束，长度为 1～60 分钟，且结束时间不晚于 `recordedAt`。

## 显式 opt-in

```text
DELIVERY_LOOP_TEST_ROLLBACK_E2E=1
TEST_ROLLBACK_EVIDENCE_FILE=/absolute/path/outside-repository/test-rollback-evidence.json
TEST_ROLLBACK_CONTROL_PLANE_URL=https://<deployed-control-plane>
TEST_ROLLBACK_CONTROL_PLANE_TOKEN=<case-8-read-token>
TEST_ROLLBACK_GITHUB_API_URL=https://api.github.com
TEST_ROLLBACK_GITHUB_READ_TOKEN=<single-repository-actions-read-token>
TEST_ROLLBACK_CANARY_SECRET=<synthetic-credential-shaped-canary>
```

控制面 token 只能读 Case 8；GitHub token 只允许目标单仓库 Actions read。两者用途隔离，均不得拥有
contents write、Actions write、Environment 管理、deployment write、merge、Worker deploy 或 D1 write。

运行：

```bash
pnpm run e2e:test-rollback
```

- exit 0：两条成功 rollback 的控制面/GitHub 双事实、两条负向零 Action inventory、零重复 effect、
  零明文 credential 全部一致，并且人工 review 字段已记录；仍须真人打开真实云/治理链接后入账。
- exit 1：manifest/schema、source failure、contract、rollback lineage、Runner、OIDC、Action、Evidence、
  zero-effect inventory、响应边界或 Secret scan 任一漂移。
- exit 2：未显式 opt-in、配置缺失或 manifest 不可读；这是 prerequisite 缺失，不是通过。

CLI 最大只读 64 KiB manifest；外部 origin 必须是 HTTPS 根 origin。所有响应最大 1 MiB、10 秒超时，
并在 JSON parse 前扫描控制面 token、GitHub token、synthetic canary 和 credential 形状。CLI 不输出
manifest、上游响应、Zod issue、token 或 URL，只输出固定错误码或安全计数。

## 安全与失败处理

本命令没有 mutation 路径：不写 D1、不 dispatch Action、不执行 rollback、不修改仓库或 Environment。
遇到 credential/canary 泄漏应立即按安全事故轮换凭据并保存受控证据；不得通过修改 manifest digest、
缩短负向窗口、删除异常 Action 或放宽 verifier 掩盖。云回滚成功只恢复环境，不改变原失败 Evidence、
Plan Item 或 Run 的失败语义；业务是否重试由独立恢复/审批流程决定。
