# 识别并处理"派发进死信"的卡死 run

## 问题

7 个 run 卡在 `planning` 36–44 小时。根因已查清:

派发 `agent_execution_start` 失败 → 重试 4–12 次耗尽 → 写入
`outbox_dead_letters` 且 `status='open'` → **outbox 领取语句里有
`NOT EXISTS (... dead_letters WHERE status='open')`**(`fenced-outbox.ts:99`)
→ 这些 outbox 行永远不再被领取。

它们至今仍是 `delivery_state='pending'`、`lease_expires_at=null`、
`updated_at` 冻结在 08-19。**不是没结算,是没人来取。**

这个"进死信就停止重试"是有意设计(防止无限重试打爆下游),不是 bug。
缺的是:**没有任何东西发现 run 因此永久停滞**。

## 为什么现有检测器没抓到

`RunStuckDetector` 每分钟随 cron 跑(`worker.ts:400`),但扫描范围是:

```sql
WHERE (state = 'queued'          AND updated_at <= ?)
   OR (state = 'awaiting_review' AND updated_at <= ?)
   OR (state = 'deploying'       AND updated_at <= ?)
```

**`planning` 不在其中**,所以这 7 个从来没被看过一眼。

## 方案:新增第四类 stall — `dispatch_dead_lettered`

复用现有 incident 机制,不另建设施。

### 1. 检测

在 `scanRunStates` 增加一条 join(已用生产数据验证能精确命中那 9 行):

```sql
SELECT r.run_id, r.state, r.version, r.updated_at
FROM runs r
JOIN outbox o  ON o.run_id = r.run_id AND o.kind = 'agent_execution_start'
JOIN outbox_dead_letters dl
     ON dl.outbox_id = o.outbox_id AND dl.status = 'open'
WHERE r.state NOT IN ('succeeded','failed','cancelled','blocked')
  AND r.updated_at <= ?   -- 阈值 cutoff
```

与现有三类不同,它**不按 run.state 判定,而按"存在 open 死信"判定** ——
因为卡死的成因在派发层,不在状态本身。因此它能覆盖 `planning`、
`executing` 等任何非终态。

`status='open'` 是关键:一旦有人 `replay_requested` 或 `resolved`,
就不再算卡死,自动退出检测。

### 2. 处置 —— 置为 `blocked`,不自动取消

检测到后把 run 置为 `blocked`(沿用 `attempt-lifecycle-store.ts:474`
对 lost attempt 的同一套做法),看板 Blocked 泳道立即可见。

**为什么不自动 cancel:** `outbox_dead_letters` 支持 `replay_requested`
状态,说明死信是**可恢复**的。自动 cancel 会摧毁这条恢复路径,而且任务
静默消失 —— 操作者不知道发生过什么,也无从判断是不是该重放。
置为 `blocked` 让它可见、可决策,你再用已上线的删除功能一键清掉,
或走 replay 恢复。

这也是我在本轮实际排查中得到的教训:`executor_unavailable` 其实是
`fenced-outbox.ts:183` 对**所有未知异常**的兜底码,同窗口内有 54 个
attempt 成功,说明 executor 当时是活的。真实故障被这个码掩盖了。
自动 cancel 会让这类掩盖永久沉默。

### 3. 阈值

`deadLettered: 30 * 60`(30 分钟)。死信意味着重试已耗尽,是终态判定,
不需要长等;30 分钟给人工 replay 留窗口,且与现有 `deploying: 30*60`
一致。

### 4. 看板呈现原因

现在看板只显示 `blocked`,不说为什么。加一个 `stallReason` 字段:
overview 查询左连 open incident,卡片在 blocked 时显示
`dispatch failed · dead letter`。这样你不用查库就知道是派发问题
而不是任务本身失败。

## 改动清单

| 文件 | 改动 |
|---|---|
| `migrations/0101_dead_letter_stall.sql` | `run_stuck_incidents` 的 `state_kind` / `action` CHECK 增加新枚举值 |
| `src/reconciliation/run-stuck-detector.ts` | 新增 `deadLettered` 阈值、检测 join、`block_dead_lettered_run` 动作 |
| `src/dashboard/overview-store.ts` | 左连 open incident,导出 `stallReason` |
| `src/dashboard/dashboard-page.ts` | blocked 卡片渲染 stall 原因 |
| `test/workflow/run-stuck-detector.test.ts` | 新增:死信 run 到阈值被置 blocked;replay_requested 后不再检测;未到阈值不动 |
| `test/workflow/dashboard-api.test.ts` | 看板返回 stallReason |

**migration 注意:** SQLite 不能直接改 CHECK 约束,需要
`CREATE TABLE new → INSERT SELECT → DROP old → RENAME`。`run_stuck_incidents`
有 2 个 trigger 和 2 个 index 要一并重建,且被 `0092`/`0093` 的视图引用 ——
我会先确认这些引用不会因重建而失效,这是本次最需要小心的一步。

## 验证

- 新测试必须先复现:回滚检测逻辑后测试要失败(和本轮两次修复一样,
  我会实际验证测试有效性,不只是让它通过)
- 完整 typecheck / lint / unit / workflow
- 部署后确认新 incident 表结构正确、cron 扫描无报错、看板正常加载

## 遗留(不在本次范围)

- `executor_unavailable` 语义错误:它把未知异常报成"下游不可用",
  误导排查。应该分出一个 `executor_effect_failed` 之类的码。
  这是独立问题,建议单独一轮。
- 死信 replay 没有操作入口(`outbox_dead_letter_replays` 至今 0 行,
  机制从未被使用过)。要不要在看板上加 replay 按钮,需要你决定。
