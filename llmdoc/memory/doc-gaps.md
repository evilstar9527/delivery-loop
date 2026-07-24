# 文档缺口追踪

## 当前缺口

1. **部署宿主未拍板**：Reference 推荐 Cloudflare Worker + D1 + Queues，但合规/数据驻留未确认；Phase 1 前形成 ADR。
2. **Agent adapter 未选择**：需核实候选 CLI 的非交互认证、session resume、退出码、许可和预算；Phase 3 前形成 ADR。
3. **目标 repo contract 未定型**：`delivery.yaml` 的 setup/test/verify/protected paths/deploy schema 在 Phase 4 前写入 Proto。
4. **飞书入口未定型**：Meegle webhook、群机器人和应用卡片的 MVP 组合待用户确认；Phase 2 前写字段映射。
5. **tool-bridge broker 能力缺口**：run 级 TTL/撤销/OIDC exchange 是否内置需实查；Phase 3 前决定内置或外置 adapter。
6. **SLO 基线缺数据**：Phase 1/2 真实试运行后再确定 intake/queue/heartbeat/stuck 阈值，不能在无数据时伪精确。

缺口补齐后从本文移除，并把稳定结论写入对应规范/ADR。

