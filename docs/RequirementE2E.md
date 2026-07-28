# E2E-1 飞书需求真实外部证据验收

## 1. 验收目标

E2E-1证明同一个真实需求从Meegle进入控制面后，只创建一个Task、一个Run和一个Cloudflare Workflow实例；唯一analysis GitHub Action以只读方式产生合法`ExecutionPlan v1`；随后由真实飞书mapped human对exact Plan快照和`repo_write` effect作一次批准。该场景停在批准完成，不执行仓库写入；代码交付由E2E-3独立验收。

这里没有独立的“Plan approval”记录。analysis完成后Plan进入`active`、Run停在`awaiting_approval`；飞书`approve`产生的`approvals`行同时绑定`taskRevision + planVersion + planDigest + baseSha + effect`。因此一个受信approval既批准计划快照，也批准对应effect，但不能被计作两条数据库decision。

## 2. 事实来源

| 事实 | 权威来源 | 复用的验证器 |
|---|---|---|
| Meegle工作项、映射、唯一Task/Run | live Meegle CLI + operations安全投影 | `verifyMeegleWorkItemEvidence` |
| 只读analysis、Plan、唯一Action/job | Task/Plan/Case 8 + GitHub App/Actions/immutable source | `verifyAnalysisActionEvidence` |
| 真人卡片actor、exact approval与零仓库effect | 独立callback观测 + 飞书operations投影 | `verifyFeishuCardActionEvidence` |
| Workflow实例存在且仍等待批准后控制流 | Cloudflare Workflows live instance API | E2E-1组合验证器只读核对 |

主`RequirementE2EEvidenceManifestV1`不复制三份子证据结论。它只保存三份完整manifest的canonical digest、跨系统lineage、Cloudflare实例安全索引和人工cross-review记录。任何子manifest改变都先触发digest失败；digest同步后仍必须通过同一Task/Run/Plan/approval交叉绑定。组合verifier还会复读当前Case 8，要求Run仍是`awaiting_approval`、只有已settled analysis dispatch outbox、exact approval唯一，且repository write credential、change和deployment都为零。

## 3. 采集步骤

1. 在已发布的真实Meegle项目中创建一条完整PRD工作项，验收字段、owner role和目标repository必须符合受审mapping profile；让真实事件经过飞书ingress、Queue和Meegle normalizer。
2. 等待唯一`run_id`对应的analysis Action完成。确认Task分类为`prd + requirement`，Plan至少有一个Evidence ref，workspace保持detached、clean且HEAD未移动。
3. 在同一Run卡片上由mapped human点击`approve`，effect固定为`repo_write`。记录event/action receipt/approval ID；此时不要领取execution Item、签发write credential或push分支。
4. 分别按[Meegle工作项验收](MeegleWorkItemE2E.md)、[Analysis Action验收](AnalysisActionE2E.md)和[飞书卡片动作验收](FeishuCardActionE2E.md)生成三份仓库外manifest。三份文件都必须来自同一试点窗口，其中卡片manifest的`approve` case必须是本次需求Run。
5. 用三份manifest的canonical digest填写主manifest，并记录同一Run的Cloudflare Workflow version/status/start与Dashboard链接。独立reviewer打开Meegle原始PRD、Plan安全展示、飞书卡片和三方审计链接，确认需求语义及批准意图。

四份manifest都必须保存在仓库外受控位置，单份最大64 KiB。不得把工作项正文、卡片正文、open_id、token、account ID、原始API响应或Secret写入manifest、日志或`PROGRESS.md`。

## 4. 运行

```bash
export DELIVERY_LOOP_REQUIREMENT_E2E=1
export REQUIREMENT_E2E_EVIDENCE_FILE=/secure/e2e-1.json
export REQUIREMENT_E2E_MEEGLE_EVIDENCE_FILE=/secure/meegle-work-item.json
export REQUIREMENT_E2E_ANALYSIS_EVIDENCE_FILE=/secure/analysis-action.json
export REQUIREMENT_E2E_FEISHU_CARD_ACTION_EVIDENCE_FILE=/secure/feishu-card-action.json

export REQUIREMENT_E2E_CONTROL_PLANE_URL=https://control-plane.example
read -rs REQUIREMENT_E2E_CONTROL_PLANE_TOKEN
export REQUIREMENT_E2E_CONTROL_PLANE_TOKEN
read -rs REQUIREMENT_E2E_OPERATIONS_TOKEN
export REQUIREMENT_E2E_OPERATIONS_TOKEN

export REQUIREMENT_E2E_MEEGLE_CLI_PROFILE=delivery-loop-evidence
export REQUIREMENT_E2E_MEEGLE_TENANT_KEY=tenant-key
export REQUIREMENT_E2E_MEEGLE_PROJECT_KEY=project-key
export REQUIREMENT_E2E_MEEGLE_WORK_ITEM_TYPE_KEY=story

read -rs REQUIREMENT_E2E_GITHUB_APP_JWT
export REQUIREMENT_E2E_GITHUB_APP_JWT
read -rs REQUIREMENT_E2E_GITHUB_INSTALLATION_AUDIT_TOKEN
export REQUIREMENT_E2E_GITHUB_INSTALLATION_AUDIT_TOKEN
export REQUIREMENT_E2E_RUNNER_CONTRACT_DIGEST=sha256:...

export REQUIREMENT_E2E_FEISHU_OBSERVABILITY_URL=https://observer.example/e2e-1
read -rs REQUIREMENT_E2E_FEISHU_OBSERVABILITY_TOKEN
export REQUIREMENT_E2E_FEISHU_OBSERVABILITY_TOKEN
read -rs REQUIREMENT_E2E_CANARY_SECRET
export REQUIREMENT_E2E_CANARY_SECRET

export REQUIREMENT_E2E_CLOUDFLARE_ACCOUNT_ID=...
read -rs REQUIREMENT_E2E_CLOUDFLARE_READ_TOKEN
export REQUIREMENT_E2E_CLOUDFLARE_READ_TOKEN

pnpm run e2e:requirement
```

可选配置为`REQUIREMENT_E2E_MEEGLE_CLI_BINARY`、`REQUIREMENT_E2E_GITHUB_API_URL`和`REQUIREMENT_E2E_CLOUDFLARE_API_URL`。默认分别使用`meegle`、GitHub官方API和Cloudflare官方API。所有token必须是用途隔离的最小只读凭证；GitHub App JWT只用于既有App/installation审计，不授予repo write。

## 5. 退出码与通过判据

- `0`：三份原verifier全部通过，主manifest digest与跨系统lineage一致，Cloudflare live实例为同一`run_id`且处于`waiting`，安全扫描无命中。
- `1`：manifest/schema、子证据、Task/Run/Plan/approval绑定、Workflow事实或Secret扫描失败。
- `2`：未显式opt-in、配置缺失或任一manifest不可读。

成功summary固定报告一个mapped Task、一个Run、一个Workflow实例、一个analysis Action、一个Plan和一个approval record；`planSnapshotsApproved=1`与`effectsApproved=1`是同一approval的两个绑定维度，不是两条decision。`repositoryWrites=0`只表示E2E-1截至批准时没有仓库写effect。

exit 0仍不能由manifest自证PRD语义、飞书后台真实human身份或审计页面内容。Reviewer必须打开真实Meegle、飞书、GitHub和Cloudflare链接并把时间、safe summary和结论写入`PROGRESS.md`，才能勾选E2E-1真实平台事实。
