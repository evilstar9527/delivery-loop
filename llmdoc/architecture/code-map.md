# Code Map

## 当前文件

| 路径 | 责任 |
|---|---|
| `src/domain/task.ts` | TaskEnvelope v1 与 source revision 去重键 |
| `src/domain/run.ts` | Run 状态及允许迁移 |
| `src/index.ts` | 当前公共导出 |
| `test/` | 领域契约与状态机单测 |
| `scripts/validate-task-envelope.ts` | CI/人工 task JSON 契约校验 |
| `scripts/verify-doc-links.mjs` | Markdown 本地链接校验 |
| `.github/workflows/ci.yml` | 默认回归 CI |
| `.github/workflows/validate-task.yml` | Phase 0 手工 contract smoke，不执行 Agent |

## 计划落点（到对应 Phase 才创建）

| 路径 | Phase | 责任 |
|---|---:|---|
| `apps/control-plane/` | 1 | Hono API、webhook、Task/Run orchestration |
| `packages/storage/` | 1 | SQL domain repository、migration、outbox、lease/CAS |
| `packages/github/` | 1 | GitHub App、dispatch、webhook 外部事实核对 |
| `packages/feishu/` | 2 | 飞书/Meegle adapter、卡片与身份映射 |
| `packages/broker/` | 3 | GitHub OIDC 验证、attempt token、tool-bridge grant |
| `packages/agent/` | 3 | Agent adapter、checkpoint、redaction、runner lifecycle |
| `actions/run-delivery/` | 3 | 可复用 Action/composite bootstrap |
| `packages/policy/` | 3/4 | effect gate、受保护路径、预算和循环上限 |
| `packages/evidence/` | 4 | 测试/commit/PR/check/deployment 证据收集与核对 |
| `deploy/` | 1/5 | 控制面与环境部署配置；不得先于宿主决策写死 |

领域层不能 import GitHub、飞书、Cloudflare 或 Agent SDK；平台层通过 adapter 实现领域端口。

