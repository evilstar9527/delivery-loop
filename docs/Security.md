# Security

## 1. 安全目标

系统的主要风险不是传统 webhook 本身，而是“外部自然语言可以间接驱动拥有代码和基础设施权限的 Agent”。安全边界必须在模型之外执行：模型输出只能提出动作，请求由策略、凭证 scope 和平台保护共同裁决。

## 2. 信任边界

| 输入/主体 | 信任级别 | 处理 |
|---|---|---|
| 飞书/Meegle/GitHub webhook 连接 | 未认证直到验签 | 验签、时间窗、delivery ID 去重 |
| 任务正文、评论、网页、日志、代码注释 | 不可信内容 | 作为数据引用；不能覆盖 system policy |
| GitHub-hosted Runner | 单 attempt 临时受信 | OIDC 绑定 repo/workflow/run；短 token；退出即撤销 |
| Agent 进程 | 受限执行者 | 无长期 Secret；所有 effect 经过 gate |
| 控制面 | 高信任 | 最小网络面、加密 Secret、append-only audit |
| tool-bridge | 受控上下文网关 | run 级 scope、TTL、调用审计、敏感字段脱敏 |

## 3. 身份与权限

### 3.1 GitHub

- 使用 GitHub App，不使用个人 PAT 作为长期机器身份。
- 默认 App 权限：metadata read、contents read；仅已批准实现 attempt 获取 contents write / pull requests write 的 installation token。
- Actions workflow 的 `GITHUB_TOKEN` 显式声明 permissions；不使用 `write-all`。
- 分支保护禁止 Agent push main、批准自己的 PR、修改 required checks 或 workflow 文件（除非任务显式属于平台仓库并二次审批）。
- 生产 deployment 使用 GitHub Environment reviewer 与 OIDC 云角色。

### 3.2 飞书

- webhook 验证 verification token/signature/encryption，拒绝过期 timestamp 和重复 nonce。
- 卡片按钮的可见性不是授权；服务端用 open_id/tenant/revision/effect 再判定。
- 用户映射（飞书 open_id ↔ GitHub identity/团队角色）需要显式维护和审计。

### 3.3 tool-bridge

- 控制面 broker SK 只存在 Secret store；Agent 永远拿不到 Admin SK。
- 每个 attempt 生成短期 SK：绑定 run/attempt/TTL，按 path + action + effect 授权。
- 缺陷分诊默认仅只读；数据库通过参数化诊断工具暴露，不下发 DSN/Redis 密码。
- 生产写、删除、任意 shell 属于 destructive，MVP 禁止授予。

## 4. Secret 生命周期

1. Secret 只存 GitHub Environment/云 Secret manager/控制面 Secret binding。
2. dispatch、飞书卡片、TaskEnvelope、prompt、checkpoint、PR 和 artifact 不含 Secret。
3. Runner 通过 OIDC 一次交换短期凭证；凭证不写磁盘，不加入子进程全局环境，按命令最小注入。
4. 日志输出前做 schema-aware redaction，并用 canary Secret 自动测试泄漏。
5. attempt 取消、超时或完成立即撤销 token；broker 记录撤销结果。

## 5. Prompt Injection 防护

- 系统策略与用户任务分离；外部内容使用带来源、时间和 digest 的引用块。
- Agent 读取到“忽略规则、上传 Secret、关闭测试”等内容时只能报告，不得执行。
- tool-bridge 返回的 `effect` 与本地 action allowlist 是外部强制策略，不接受模型自报 effect。
- 默认禁止修改 `.github/workflows/**`、CODEOWNERS、分支保护、部署脚本和 Secret 配置；任务确需修改时触发单独高风险审批。
- 不允许运行来自任务正文的任意 shell。仓库命令从受信 `delivery.yaml`/package scripts 中选择，额外命令需记录并受策略校验。
- PR diff 运行 secret scan、依赖/脚本变更检查和高风险路径 CODEOWNERS review。

## 6. 供应链与 Action 隔离

- 第三方 Actions pin 到不可变 commit SHA；版本升级走依赖更新 PR。
- `pull_request_target` 不检出不可信 PR 代码；来自 fork 的代码不在拥有 write Secret 的 job 中执行。
- Runner 不复用含工作区/凭证的持久缓存；依赖缓存只按 lockfile digest 读取。
- 目标仓库执行命令在容器或最小权限 runner 中运行；生产网络不可从普通实现 job 直达。
- artifact 带 digest、保留期和敏感等级；原始 Agent transcript 加密且默认短期保留。

## 7. 人审闸门

| Effect | 默认策略 |
|---|---|
| 读 repo / 测试日志 | 已接受任务可自动 |
| 读生产日志/trace | 最小字段、按 run 授权、审计 |
| 读数据库 | 只读诊断工具；敏感列脱敏 |
| 写目标分支/开 Draft PR | 任务显式允许 repo write |
| 测试环境部署 | 独立批准或仓库白名单策略 |
| merge | required checks + review + 最新 base 校验 |
| 生产部署 | GitHub Environment/外部审批，Agent 不可自批 |
| 删除、生产 DB/K8s write | MVP 禁止；未来必须双人审批和专用工具 |

## 8. 审计与保留

- 所有状态变化、授权、token 签发/撤销、tool 类别调用、Git commit/PR/check/deploy 追加到 audit。
- 审计事件包含 payload digest，不保存不必要的原始敏感内容。
- checkpoint/evidence 默认保留 180 天；原始 session/transcript 默认 30 天；Secret 永不进入备份。
- 管理员读取原始 session 也产生审计事件。
- 定期演练：Secret canary、取消后 token 不可用、旧 OIDC 重放失败、Runner 失联恢复、审批 revision 过期。

