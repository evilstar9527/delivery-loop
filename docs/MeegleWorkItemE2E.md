# Meegle 工作项映射与 triaging 真实验收

本验收关闭 Phase 2 的 Meegle 外部事实缺口：真实测试 tenant 中的字段和角色元数据被受信 profile 正确绑定；完整工作项创建唯一 Task/Run；缺字段、owner 多值、repo 越 allowlist 和原始分页未完成分别进入固定 `triaging` gap，且没有 Task、Run 或 workflow-create effect。

`pnpm run e2e:meegle-work-item` 是只读 verifier。它只执行 Meegle CLI 的元数据/工作项读取和 operations GET，不创建或修改工作项、不触发 normalizer、不写 D1/R2、不创建 Workflow。没有显式 opt-in 时固定 exit 2；schema example、注入式 fake runner、本地合成 snapshot、workerd 或 manifest 自报都不能替代真实 tenant。

## 1. 固定 authority

- CLI 固定为 `meegle 1.0.16`。本轮审计的官方 tag commit 是 `674042f0f58b62962103aff91598c9bc85ccb138`；verifier先执行`meegle --version`，manifest中的release commit只能是该值。
- npm包的`gitHead=73f1be359ad2e298e5a1817c13e1f1d82fcdf7d3`在公开仓库不可checkout，因此不能把该字段当作可复核源码authority。本验收使用官方`v1.0.16` tag commit，并把这项差异保留在证据账本。
- verifier使用argv数组和`shell:false`。每个工作项固定执行`workitem get --fields '["_all"]' --params '{"page_size":200}' --auto-paginate --envelope --format json`；不拼接shell命令。
- `--envelope`必须返回`{data,meta,error}`。`meta.truncated=true`、非空`stopped_reason`或残留`next_page_token`一律失败；200页上限或连续空页不能被解释为“已完整读取”。

## 2. 前置与权限

1. 测试tenant中准备同一project/type下的5个受控工作项：完整、缺字段、owner多值、repo越allowlist、以及曾被adapter以未完成分页snapshot处理的case。所有工作项必须通过真实事件和实际normalizer进入控制面，禁止直接调用mapper或手工写D1/R2。
2. Meegle CLI profile使用只读用户身份，能读取该project/type的metadata和5个工作项；不要把访问token写入manifest、命令行、日志或仓库。
3. 已部署控制面应用migration 0058。operations token只允许读取`GET /v1/operations/meegle/evidence`，不能调用task intake、部署或其他写接口。
4. mapping profile由控制面受信配置提供，并冻结version/digest、acceptance field key/type、owner role key、repository field key/type与allowlist。工作项正文不能提供或覆盖profile。

## 3. 产生五类真实事实

1. 先用`workitem meta-fields`精确读取验收标准和目标仓库两个field key/type，再用`workitem meta-roles`读取owner role key。role不能按同名普通field处理。
2. 完整case必须有title、description、非空验收标准、恰好一个owner、allowlist内repo和revision。实际normalizer处理后，D1必须出现一条immutable mapping lineage、一个Task、一个Run和一个workflow-create outbox；`run_id = workflow_instance_id`。
3. 缺字段case保留真实Meegle必需的title/revision，清空可为空的description/acceptance/owner/repo，并返回对应四个gap；owner多值case只返回`owner_ambiguous`；repo越allowlist只返回`target_repository_invalid`。三者都必须保持Task/Run/workflow-create为零。title/revision缺失的fail-closed仍由本地mapper负向测试覆盖，不要求测试tenant制造平台不允许的工作项。
4. 分页未完成case的原始adapter snapshot必须保存`fieldsComplete=false + hasNextPageToken=true`并只返回`source_fields_incomplete`，Task/Run/effect为零。验收时CLI仍须重新完整读取当前工作项；故live CLI输出不能truncated，而D1/R2安全lineage保留原始未完成分页事实。这两个时间点不得混为一谈。
5. 每个R2 snapshot由operations API在服务端有界回读：重新解析strict snapshot、重算exact digest，并核对R2 custom metadata、event/source/revision、field/role/owner count。响应只公开布尔验证结果、digest、配置key、count和固定状态，不返回正文、field value、principal、R2 ref、cursor或raw API。

## 4. 仓库外 manifest 与运行

复制[`schemas/meegle-work-item-evidence-v1.example.json`](../schemas/meegle-work-item-evidence-v1.example.json)到仓库外受控位置，替换为5个真实event/work-item/revision、CLI分页摘要、lineage digest和mapped Task/Run ID。manifest不得包含工作项标题/描述、owner principal、raw fields、page token、R2 ref、credential或数据库行。

```bash
export DELIVERY_LOOP_MEEGLE_WORK_ITEM_E2E=1
export MEEGLE_WORK_ITEM_EVIDENCE_FILE=/secure/outside-repo/meegle-work-item-evidence.json
export MEEGLE_WORK_ITEM_CONTROL_PLANE_URL=https://control.example.com
export MEEGLE_WORK_ITEM_OPERATIONS_TOKEN='<short-lived-operations-read-token>'
export MEEGLE_WORK_ITEM_CLI_PROFILE=delivery-loop-evidence
export MEEGLE_WORK_ITEM_TENANT_KEY=tenant_delivery_loop_pilot
export MEEGLE_WORK_ITEM_PROJECT_KEY=project_delivery
export MEEGLE_WORK_ITEM_TYPE_KEY=story
# 可选；默认从PATH执行meegle
export MEEGLE_WORK_ITEM_CLI_BINARY=/trusted/bin/meegle
pnpm run e2e:meegle-work-item
```

上述profile、tenant、project和type由运行环境独立配置，并必须与manifest exact一致；manifest不能自行选择本机其他Meegle profile或扩大读取范围。

exit 0只表示CLI live read与D1/R2安全投影交叉一致；exit 1表示事实或绑定不一致，exit 2表示未opt-in或配置缺失。只有真实normalizer事件、命令exit 0和Meegle项目/权限人工review一起入`PROGRESS.md`后，才能勾父DoD。

## 5. 通过判据

- metadata：两个field key/type和一个role key均来自live Meegle API且exact匹配mapping profile。
- pagination：5个live工作项都无truncated/stopped/cursor；pages merged与total items和manifest一致。
- lineage：每event只有一条immutable mapping lineage；exact/mapping/profile digest、source identity和受控key一致，R2对象存在且digest回读验证为true。
- mapped：完整case只有一个Task/Run/workflow-create，Task revision与work-item revision相同。
- triage：四个case分别返回固定gap；mapped lineage/Task/Run/workflow-create计数全部为零。
- 安全：summary、错误、manifest和operations响应不含工作项正文、field value、owner principal、cursor、R2 ref、token或raw response。
