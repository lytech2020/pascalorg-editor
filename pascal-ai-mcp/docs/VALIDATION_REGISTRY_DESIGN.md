# Pascal AI 验证调度设计

## 1. 目标与边界

验证 registry 只负责编排现有确定性判断，不复制 Plan、场景、家具或修改保护算法。模型可以根据失败结果提出修复，但不能决定验证是否通过。

本设计只修改 `pascal-ai-mcp/**`，不修改 MCP 工具 schema，也不引入新的请求、会话或审计真相源。验证结果继续写入 `ai_validation_results`。

## 2. 当前验证清单

| 能力 | 真相源 | 输入 | 输出 | 当前阶段 | 审计方式 |
|---|---|---|---|---|---|
| LayoutPlan 合法性 | `validateLayoutPlan` | plan、目标面积/房间数、norm profile | fatal、warnings、score | plan、plan-first modify | `layout-plan` |
| 完成门槛 | `evaluateCompletionGates` | zones、walls、items、当前需求目标 | gate failures | structure、furniture、modify、verification | `completion-gates` |
| MCP 场景校验 | 既有 `validate_scene` | 当前活动场景 | valid、errors | verification、modify | 并入 `scene-diagnostics` |
| MCP 场景核验 | 既有 `verify_scene` | 当前活动场景 | issues | verification、modify | 并入 `scene-diagnostics` |
| MCP 碰撞检查 | 既有 `check_collisions` | 当前活动场景 | collisions | furniture、verification、modify | 并入 `scene-diagnostics` |
| 家具位置检查 | `checkFurniturePlacement` | zones、walls、items | overlap、out-of-bounds、door-clearance | furniture、verification、modify | 并入 `scene-diagnostics` |
| 通行与外窗检查 | `findDoorlessRooms`、`findIsolatedBedrooms`、`findStrayWindows` | zones、walls、room types | 稳定问题列表 | structure、verification、modify | 并入 `scene-diagnostics` |
| 面积与需求检查 | `checkAreaRequirements`、房间需求比对 | zones、brief、room types | requirement mismatches | structure、verification、modify | 并入 `scene-diagnostics` |
| 修改保护 | `checkModificationProtection` | 修改前后节点快照、已确认请求 | 保护范围或面积问题 | modify | 并入 `scene-diagnostics` |

registry 中的组件检查可以返回结构化结果，但为保持既有审计口径，第一批只有 `layout-plan`、`completion-gates` 和 `scene-diagnostics` 直接写审计行。其余组件标记为 aggregate，由 `scene-diagnostics` 汇总计数，避免同一问题重复记账。

## 3. 现有 `recordValidation` 调用基线

生产代码只有 `agent.ts` 的私有入口调用 `AiOperationAuditor.recordValidation`。实施前业务调用点如下：

| validator ID | 触发位置 | 每次触发写入次数 | 摘要字段 |
|---|---|---:|---|
| `layout-plan` | `buildPlan` 成功或失败分支 | 1 | `fatalCount`、`warningCount`、可用时的 `score` |
| `completion-gates` | `evaluateGates` | 1 | `failedGates`、`failureKinds` |
| `scene-diagnostics` | `collectDiagnostics` | 1 | 各诊断类别的计数 |

同一次 `buildPlan` 的成功和失败分支互斥，因此不会产生两条 `layout-plan`。repair 中每次重新运行诊断会产生新行，并由当前 workflow step 推导 `repairRound`；这是执行历史，不是重复写入。

## 4. 契约

每个 `ValidationCheck` 包含：

- 稳定 `id`；
- 适用阶段；
- 检查范围和严重级别；
- 输入要求；
- 当前上下文是否满足输入的判定；
- 返回结构化 `ValidationResult` 的执行函数；
- `direct` 或 `aggregate` 审计模式。

统一结果包含 `passed`、`failed` 或 `unavailable` 状态、issue count、仅由稳定枚举与计数组成的 summary、处置分类和原验证值。处置分类为：

- `continue`：可继续；
- `repair`：可进入既有修复流程；
- `confirm`：需要用户确认后才可继续；
- `stop`：不可安全继续；
- `unavailable`：工具失败、取消或结果未知，不得当作通过。

## 5. 阶段调度

workflow 只向统一入口提交阶段与当前可用上下文。registry 按阶段选择检查，并通过 `canRun` 跳过当前尚无输入的组件。现有阶段为：

- `plan`：Plan 施工前检查；
- `structure`：结构施工后检查；
- `furniture`：家具施工后检查；
- `modify`：修改前后保护与最终检查；
- `verification`：最终验收和 repair 回合。

新增验证通过注册定义接入；生成和修改主流程不再增加 validator 专用的审计分支。

## 6. MCP 适配边界

AI 侧 adapter 只调用现有 `validate_scene`、`verify_scene` 和 `check_collisions`，不改参数或响应契约，不重放失败的工具调用。三个读取并行执行，任一调用失败时本轮 `scene-diagnostics` 记录 `unavailable`，随后继续抛出原错误，让既有失败、取消和恢复逻辑处理。

completion gates 所需的 `get_zones`、`get_walls` 和 `get_level_summary` 同样保持只读。读取失败时记录 `completion-gates=unavailable`，绝不生成虚假通过。

## 7. 审计与隐私

- `direct` 结果由统一接线写入 `ai_validation_results`。
- request、workflow run、workflow step、session、scene 和 repair round 继续由现有审计身份提供。
- summary 只允许计数、布尔值和稳定 ID；不保存用户原文、问题详情、完整场景、MCP 原始响应或 Prompt。
- 审计终态写入保持现有 fail-open 策略；验证本身或验证工具失败仍影响业务结果，不能因审计失败而改成通过。

## 8. 行为保持基线

- `validateLayoutPlan`、completion gates、家具位置和修改保护继续调用原函数。
- MCP 工具名称、调用次数、并行方式和错误传播保持不变。
- 正常路径中每次触发的直接审计记录集仍为原有 validator ID 和次数。
- 不改变模型调用数、Prompt、temperature、fallback、预算门、模板匹配或场景写入顺序。

## 9. 验收测试

- registry 的阶段选择、重复 ID 拒绝、输入不足跳过。
- wrapper 与原直接调用逐字段等价。
- 三个 MCP 验证工具各调用一次，失败不重试且返回 unavailable 审计结果。
- 正常生成/修改迁移前后的直接审计记录集按 validator 和次数一致。
- Plan fatal、completion gate 失败、家具位置失败、修改保护、取消和工具异常均不产生虚假通过。
- 给定 requestId 可按 `rowid` 顺序查询验证历史。

## 10. 实施结果

- 纯 registry 位于 `src/domain/validation-registry.ts`，不依赖 MCP、SQLite、LangGraph 或 adapter。
- application wrapper 位于 `src/application/validation-service.ts`，底层仍调用原 validator 和既有 MCP 工具。
- plan、structure、furniture、modify、verification 五个阶段均由 agent 的单一入口调度。
- plan-first modify 的候选方案检查也经 registry，但作为内部可行性判断不新增直接审计行；完成门和最终诊断继续按既有口径记账。
- 修改保护经 registry 返回 aggregate 结果，仍并入既有修复与用户结果，不新增第二条 validator 审计记录。
- MCP 验证失败路径有一项有意变化：旧版直接抛出且不写验证行；新版先记录 `unavailable`（cancelled/timeout/tool_error）再抛出原错误。成功路径的 validator ID、摘要和写入次数保持不变。
- 2026-07-23 验证：670 tests / 0 fail、`check-types` 干净、15 份模板体检通过；独立审核已通过，D1/A1–A6 已标记为 `[x]`。
