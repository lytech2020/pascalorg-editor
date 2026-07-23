# ADR：AI 侧空间语义投影

- 状态：Accepted
- 日期：2026-07-22
- 范围：`pascal-ai-mcp/**`

## 背景

公共场景里的 Zone 同时表示卧室、走廊等室内空间，也可能表示 `Back garden` 等室外区域。AI 的 `RoomType` 是户型规划词表，不能直接作为所有 Zone 的公共类型；当前阶段也明确禁止修改 `packages/core` 和 `packages/mcp`。与此同时，仅把 `zoneId → RoomType` 放进会话会造成两类漂移：删除会话后分类消失，用户重命名 Zone 后名字正则可能改变判断。

## 决策

在 AI application SQLite 中增加 `ai_scene_spaces` 投影，以 `(scene_id, zone_id)` 为稳定主键。它是 AI 侧用途索引，不是公共 scene schema，也不是完整 LayoutPlan。

### 分类模型

`usage` 是长度受限的开放字符串。当前已知值与 `RoomType` 对齐，但读取未知新值时仍返回记录，不让整条场景语义失效。

`category` 是较稳定的粗分类：

| category | 当前用途 |
|---|---|
| `indoor_room` | bedroom、living、living_kitchen、dining、study |
| `service` | kitchen、bathroom、storage |
| `circulation` | hallway、entry |
| `outdoor` | balcony、garden 等明确室外空间 |
| `unknown` | other 或无法可靠判断的用途 |

规划生成使用显式 `RoomType → {usage, category}` 映射。旧场景名称仅在导入/inspect 类路径首次遇到该 zone 时推断一次；`garden/yard/庭院/花园` 等室外词先于房间词表识别，避免把室外 Zone 当成室内房间。

### 来源与置信度

`source` 记录 `layout_plan`、`template`、`legacy_session_cache`、`legacy_name_inference` 或 `manual`。新规划生成记录置信度 1；旧 session 的 `zoneRoomTypes` 迁入为 0.9；纯名称推断为 0.4。名称推断采用 `INSERT OR IGNORE`，因此重命名不会反复改写既有分类。

每条记录可携带 `template_id`、`plan_room_id`、`plan_version` 和 `scene_version`。当前执行器可靠提供 `plan_room_id`，并以 `layout-plan-v1` 记录语义契约版本；`scene_version` 只在既有 MCP 响应返回整数时填写，不额外查询。缺失值保持 NULL，不伪造。

### 写入与读取

`executeLayoutPlan` 在 `create_room` 成功返回 `zoneId` 后调用投影写入钩子。此时场景副作用已经发生，因此投影失败记录为执行问题并继续，不把已经建成的场景谎报为未施工。

gates、layout metrics、modify 和 diagnostics 按以下顺序取类型：

1. `ai_scene_spaces` 中 `(sceneId, zoneId)` 的已知 usage；
2. 旧会话 `zoneRoomTypes` 缓存，并一次性迁入投影；
3. 仅旧场景导入使用的名称推断，并一次性持久化。

用途投影不能恢复房间多边形、连接拓扑或完整 LayoutPlan。需要结构重建而找不到 AI DB 中原始 LayoutPlan 时，仍必须明确降级或拒绝。

### 生命周期与隐私

投影不外键关联 `ai_sessions`。删除 session 不删除它，因为用途是 scene/zone 的非内容型业务元数据；场景清理/未来正式删除策略应按 sceneId 单独处理。表中不保存 Prompt、模型回复、Zone 名称、场景快照或几何。

## 放弃的方案

- 修改 Zone schema 或 `create_room` 参数：越过当前目录边界，也会把 AI 词表错误提升为公共领域契约。
- 继续只存 `WorkflowSession.zoneRoomTypes`：删除 session 后丢失，且不是 scene 级真相源。
- 每次按名字实时分类：重命名会漂移，也无法区分室外 Zone。

## 后续

正式让 Editor、Viewer 和非 AI 消费方读取空间语义属于 `T3.1-FUTURE`，需要单独解除 `packages/**` 限制并评审公共 schema、迁移与 MCP 契约。本 ADR 不宣称完成该能力。
