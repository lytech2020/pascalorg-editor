# Prompt Registry 与版本管理

## 1. 目标与边界

主要模型调用的稳定指令统一定义在 `src/prompts/registry.ts`。业务调用点只选择 Prompt ID、传入类型化变量，并把 registry 返回的 `promptVersion`、`promptHash` 交给模型客户端。

registry 不依赖模型 adapter、SQLite、LangGraph 或 MCP。它不保存运行时 Prompt，也不负责选择模型、fallback、预算或重试。

## 2. 当前 Prompt ID

| Prompt ID | 用途 |
|---|---|
| `extract` | 合并和结构化用户需求 |
| `scene-intent` | 已有场景请求分类 |
| `plan:intent` | 生成语义 LayoutIntent |
| `plan:geometry` | 实验性模型几何 LayoutPlan |
| `modify-ops` | 把修改请求翻译为确定性 ModifyOp |
| `modification-guard` | legacy 修改路径的结构保护指令 |
| `inspect` | 已有场景只读问答 |
| `scene-agent` | 场景施工、工具调用和未完成轮次续接 |
| `repair` | 有界自动修复轮 |

## 3. 版本与 hash

- `promptVersion` 格式为 `<promptId>:vN`。
- `promptHash` 是该版本全部稳定模板片段按固定顺序计算的 SHA-256。
- brief、用户消息、场景历史、诊断详情和 MCP guide 等运行时变量只参与渲染，不参与版本或 hash。
- 修改任意稳定模板正文时必须提高版本，并同步更新 registry snapshot 测试；不得在同一个版本下静默改写内容。
- 仅修改调用方动态数据不提高 Prompt 版本。

`src/prompts/registry.test.ts` 固定每个 `promptVersion → promptHash`。正文改变但版本未更新会直接使测试失败；缺失变量或未知变量会在模型请求前抛错。

## 4. 审计与隐私

`ai_model_calls` 只保存 Prompt ID/版本形成的 `prompt_version` 和稳定模板 hash，不保存模板正文、渲染结果或变量值。动态用户/场景内容不会进入普通日志、模型调用审计或 LangGraph checkpoint。

供应商调用的 temperature、fallback、预算门、重试次数和消息角色结构由原调用链继续控制，registry 迁移不得改变这些行为。

## 5. 旧版本保留与回退

内部部署阶段以 Git commit 作为 Prompt 正文的权威版本归档；数据库审计行中的版本/hash 可定位到对应部署 commit。运行时代码只加载当前部署显式注册的版本，不从数据库反向恢复 Prompt 正文。

回退 Prompt 必须回退到包含该版本定义的完整应用 commit。若需要同时在线使用多个历史版本，应把旧定义作为新的显式 registry 条目保留并增加选择策略，不得用同一版本号覆盖正文。

## 6. 修改流程

1. 确认改动属于稳定模板还是运行时变量。
2. 稳定模板改变时提高 `vN`。
3. 更新 snapshot 中的新 `promptVersion → promptHash`。
4. 检查调用点传递 registry 返回的 version/hash，没有手写版本。
5. 运行类型检查、Prompt 测试、全量测试、模板体检和 deterministic eval。
