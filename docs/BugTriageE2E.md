# E2E-2 缺陷分诊真实外部证据验收

## 1. 验收目标

E2E-2证明一条真实`user_feedback + bug`任务中的`uid/cid/path`等定位信息，经同一个analysis Attempt调用真实tool-bridge的`logs/search`和`traces/get`后，形成一条可审计的根因Evidence；active `ExecutionPlan v1`必须精确引用这条Evidence。场景停在`awaiting_approval`，不得签发repo-write credential、产生commit/PR或触发test/production deployment。

控制面不保存原始定位值、日志、trace、数据库行或tool响应。`DiagnosticEvidenceV1`只接受locator kinds/digest、经Secret扫描的根因摘要与代码引用、以及成功tool trace ID；D1的`diagnostic_evidence_bindings`和`diagnostic_evidence_trace_sources`只保存digest和metadata。operations查询也不返回根因摘要，只返回可交叉核对的digest、Plan ref和只读source trace。

## 2. 权威链路

| 事实 | 权威来源 | 验证方式 |
|---|---|---|
| 用户反馈Task、唯一analysis Action、只读workspace和context调用 | Task/Plan/Case 8 + GitHub App/Actions/immutable source | 完整复用`verifyAnalysisActionEvidence` |
| 根因Evidence来自同Attempt的日志与request trace | D1 diagnostic binding + immutable tool-call trace | live `GET /v1/runs/:runId/diagnostic-evidence` |
| Plan精确引用根因Evidence | `execution_plan_evidence_refs`与diagnostic binding join | 同一operations安全投影 |
| 未写生产 | Case 8的credential/change/deployment/effect outbox | E2E-2 verifier复读live Case 8 |
| 定位输入与根因语义正确 | 原始反馈、受控日志平台链接和代码快照 | 独立真人cross-review |

主`BugTriageE2EEvidenceManifestV1`只保存Analysis Action manifest的canonical digest、跨系统lineage、诊断digest/trace ID和人工review记录。manifest不能创建诊断Evidence，也不能替代live tool trace、Plan ref或零写入状态。

## 3. 采集步骤

1. 以真实用户反馈创建bug Task；反馈中提供本次排障所需的uid、cid、请求path等定位信息。原始值只进入受控Task/R2和tool调用，不写manifest或进度日志。
2. 在同一个analysis Attempt中通过最小scope tool token调用`logs/search`，从成功结果定位request trace，再调用`traces/get`。失败、timeout、policy denied或其他Attempt的trace都不能作为根因source。
3. 对脱敏后的根因摘要和代码引用提交`POST /v1/attempts/:attemptId/diagnostic-evidence`；保存返回的Evidence ID/ref和三类digest。随后提交Plan，至少一个`logs_read`调查Item引用该Evidence ref。
4. 等待固定analysis Action成功并由控制面激活Plan；确认Run停在`awaiting_approval`。分别生成Analysis Action完整manifest和本E2E-2主manifest。
5. Reviewer打开原始反馈、日志/trace平台受控链接、exact base SHA代码与Plan，核对locator输入、根因结论和零生产写。只把无query/fragment的HTTPS审计链接和安全结论写入manifest。

单份manifest最大64 KiB，必须保存在仓库外。不得保存uid/cid原值、日志/trace正文、根因摘要、token、raw API response或credential-shaped canary。

当前仓库已经具备tool proxy、diagnostic Evidence producer API、Plan binding、固定Runner三阶段mediation和外部verifier。bug Action会以三个独立model reservation固定执行`logs/search → traces/get → root cause/Plan`，Evidence只在workspace仍clean后创建，exact ref由Runner注入。真实E2E-2仍保持未完成：本地fake调用、schema测试、手工D1写入或Wrangler dry-run都不能替代已部署控制面、真实Action/tool-bridge和真人根因review。

## 4. 运行

```bash
export DELIVERY_LOOP_BUG_TRIAGE_E2E=1
export BUG_TRIAGE_E2E_EVIDENCE_FILE=/secure/e2e-2.json
export BUG_TRIAGE_E2E_ANALYSIS_EVIDENCE_FILE=/secure/analysis-action.json

export BUG_TRIAGE_E2E_CONTROL_PLANE_URL=https://control-plane.example
read -rs BUG_TRIAGE_E2E_CONTROL_PLANE_TOKEN
export BUG_TRIAGE_E2E_CONTROL_PLANE_TOKEN
read -rs BUG_TRIAGE_E2E_OPERATIONS_TOKEN
export BUG_TRIAGE_E2E_OPERATIONS_TOKEN

read -rs BUG_TRIAGE_E2E_GITHUB_APP_JWT
export BUG_TRIAGE_E2E_GITHUB_APP_JWT
read -rs BUG_TRIAGE_E2E_GITHUB_INSTALLATION_AUDIT_TOKEN
export BUG_TRIAGE_E2E_GITHUB_INSTALLATION_AUDIT_TOKEN
export BUG_TRIAGE_E2E_RUNNER_CONTRACT_DIGEST=sha256:...

read -rs BUG_TRIAGE_E2E_CANARY_SECRET
export BUG_TRIAGE_E2E_CANARY_SECRET

pnpm run e2e:bug-triage
```

可选`BUG_TRIAGE_E2E_GITHUB_API_URL`默认使用GitHub官方API。所有credential用途隔离且只读；CLI未显式opt-in时在读取manifest/token或联网前exit 2。

## 5. 退出码与完成边界

- `0`：原Analysis Action verifier通过；live diagnostic投影证明唯一根因Evidence、成功logs/trace source和唯一Plan ref；Case 8证明零write credential/change/deployment；安全扫描无命中。
- `1`：schema、component digest、Task/Run/Plan/Attempt lineage、diagnostic binding、live状态或Secret扫描失败。
- `2`：缺opt-in、配置不完整或manifest不可读。

exit 0仍不能由manifest自证用户反馈定位值或根因语义。Reviewer必须完成cross-review并把时间、安全summary和审计链接写入`PROGRESS.md`，真实平台子项才可勾选。
