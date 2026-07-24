# Pascal AI 增删改查验收

## 1. 范围与结论口径

机器可读覆盖矩阵位于 `eval/crud-matrix.json`。每项 disposition 只能有三种结论：

- `supported`：当前有确定性执行与验证边界；
- `safe_rejection`：当前能力不支持，必须在场景写入前明确拒绝；
- `failed_recoverable`：外部副作用结果不明确，保留审计并禁止盲目重放。

`supported` 不再等于“对任意场景无条件可执行”。凡依赖布局可行性、稳定词汇、目录命中、合法位置或需要确认的写操作，都带 `conditional: true` 和 `limitations`，如实表达其前提与边界（房间增删改、家具增删换、整房清空、混合修改）。验收不把“安全拒绝”伪装为功能支持，也不把“条件支持”写成无条件支持。

写入安全口径：

- 任何写工具最多由一次业务执行调用一次，结果未知时绝不自动重放；
- 一旦某次写入结果未知（传输异常），立即停止本次全部后续写入（下一个候选、下一件批量删除、下一个房间、后续门窗），剩余操作显式标记 `not_executed`，不静默略过；
- 真实副作用状态为 `no_write / write_attempted / write_confirmed / partial_write_confirmed`，由统一 MCP 写调用包装器在“调用前/成功/未知”实时回调并持久化，进程中断也不会把已发生的写入误记为 `no_write`；
- `place_item` 的 `catalog_unavailable` 会生成占位物，按已写入计（`write_confirmed`），不当作零写入，且不再继续生成更多占位物；
- 批量清空在写入前保存确认的目标 item ID 集合，执行前重新读取比对；确认等待期间家具变化则按新清单重新确认；
- 写入结果未知（`write_attempted`/`partial_write_confirmed`）不会走普通完成：立即转 `modifyResultUnknown`/destructive 话术，不保存场景、不自动重试；
- 家具读取（`get_level_summary`）失败不等于空场景：清空/删除会以 `scene_read_failed` 零写入失败，不谎报“无家具”或“已清空”；
- 零业务写入的失败不调用 `save_scene`（`finishPlanFirstModify` 按 `sceneWasWritten` 跳过持久化），满足“安全失败时写工具调用数为 0”；
- 被规划流程丢弃的家具子操作有显式 `skipped`（依赖房间已删除）状态，不静默略过；
- 零写入失败（目录无匹配、无合法位置、目标不存在、房间歧义、需澄清）绝不出现“场景可能部分修改”提示。

当前结构生成会创建门窗，但已有场景的直接门窗增删移动尚未进入 `ModifyOp` 契约；带明确目标位置的 `move_furniture` 也尚无确定性位置契约与执行器。这两类请求必须稳定拒绝，不能转入自由 MCP 写入。

## 2. 三层测试

### 2.1 零费用 deterministic

```bash
bun run internal:check -- --allow-dirty --automated-only --only=E8
```

该检查覆盖房间增删改、家具增删换、连续修改、局部范围保护、结果未知恢复边界和 eval corpus 结构。它不调用模型供应商。

第 8 节自然语言边界用例的 deterministic 归属（均为零费用，随上面命令一并运行）：

| 用例 | 断言 | 测试位置 |
|---|---|---|
| 客厅加「桌子」（含糊词） | 澄清而非静默改成书桌，零写入 | `furniture-modify.test.ts` |
| 把某房间家具都删除 | 进入显式批量确认，不把「家具」当 item | `furniture-modify.test.ts` / `agent.test.ts` |
| 删除卧室的床（卧室1/2 并存） | 严格解析，歧义澄清不选第一间 | `furniture-modify.test.ts` / `modify-ops.test.ts` |
| 目录无匹配 | 零写入，reason `catalog_no_match` | `furniture-modify.test.ts` |
| 有目录无合法位置 | 零写入，reason `no_safe_position` | `furniture-modify.test.ts` |
| `place_item` 响应丢失 | 绝不自动第二次调用，`write_attempted` | `furniture-modify.test.ts` / `scene-executor.test.ts` |
| `delete_node` 响应丢失 | 不盲目重放，`write_attempted` | `furniture-modify.test.ts` |
| swap 删除成功放置失败 | 精确报告 partial，保留 removedItemId | `furniture-modify.test.ts` |
| 混合修改逐项状态 | 按 operationId 报告 done/undone | `furniture-modify.test.ts` / `modification-postconditions.test.ts` |
| 多同类家具删除 | 不谎称「最后放置」，如实报数量 | `furniture-modify.test.ts` |
| resize 明显超出 | 双边目标验证失败 | `modification-postconditions.test.ts` |
| 零写入失败 | 不出现「场景可能部分修改」提示 | `application/modify-service.test.ts` |

### 2.2 Provider 稳定性抽查

Provider 抽查会产生真实费用，必须先由用户确认。推荐用例为：

```text
case-03-two-bed-standard
case-18-modify-swap-furniture
case-23-modify-chained
```

运行入口：

```bash
bun run release:check -- \
  --with-provider-eval \
  --provider-only=case-03-two-bed-standard,case-18-modify-swap-furniture,case-23-modify-chained \
  --provider-repeat=2
```

抽查评估重复稳定性，不以一次成功代替稳定性结论。

### 2.3 浏览器端到端

在三层服务就绪后，用一个专用测试场景按顺序执行：

1. 生成 2LDK；
2. 查询房间、面积、家具和请求状态，确认没有场景写审计；
3. 把一间卧室重命名；
4. 增加一件明确家具（如书桌/餐桌），确认餐桌类走房间中心放置；
5. 替换或删除该家具；
6. 输入客厅加「桌子」这类含糊词，确认请求澄清且零写入；
7. 存在同类多间房间时说「删卧室的床」，确认要求指明具体房间且零写入；
8. 说「把某房间家具都删了」，确认先给出目标数量并请求确认，确认后只删可移动家具、保留固定设备；
9. 执行一次结构修改（增/删/改面积）并确认；对「调整到 N㎡」验证双边达成；
10. 触发一次零写入失败（如加一个目录里没有的家具），确认回复不含「场景可能部分修改」；
11. 刷新页面，确认 Session、请求进度和最终场景仍可查询，且与实际场景结构一致；
12. 输入直接移动门、删除窗或把家具移动到指定坐标的请求，确认在施工前被安全拒绝；
13. 对比每步场景 diff，确认局部修改未触碰无关节点。

## 3. 失败记录

每个失败至少记录：

- commit、caseId、repeat；
- requestId、sessionId、sceneId；
- 预期与实际 disposition；
- 修改前后场景 diff；
- 是否发生 MCP 写入；
- 是否为 `failed_recoverable`；
- 修复对应的自动回归或人工复验步骤。

不得在报告中粘贴 Prompt、模型原始响应、图片 Base64、Secret 或完整私有场景。

## 4. 外部证据

`bun run internal:check` 的最终 Go/No-Go 只接受与当前 commit 完全一致的证据文件。证据目录需要包含：

```text
provider.json
browser.json
startup.json
rollback.json
```

每个文件格式：

```json
{
  "schemaVersion": 1,
  "kind": "provider",
  "commit": "<git commit>",
  "executedAt": "2026-07-23T10:00:00.000Z",
  "ok": true,
  "notes": "不含用户原文和 Secret 的结论"
}
```

`kind` 分别为 `provider`、`browser`、`startup`、`rollback`。缺失、失败、格式错误或 commit 不一致均保持 `NO-GO`。
