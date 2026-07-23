# Pascal AI 内部测试反馈与复盘流程

## 1. 目标与边界

本流程把内部测试问题从提交、分级、排查、修复推进到可验证关闭。服务端审计是 AI 请求、模型、MCP 工具和工作流状态的诊断依据；Editor 手工编辑、undo/redo 和纯前端交互仍以人工证据为准。

不得为了去重或补全问题而从 AI 日志推断用户未记录的 Editor 行为，也不得在问题单中粘贴完整 Prompt、模型原始响应、私有场景 JSON、密钥或图片 Base64。

## 2. 生命周期

主状态按以下顺序推进：

```text
new → triaged → reproduced → in_progress → fixed_pending_verification → closed
```

允许使用的旁路状态：

- `needs_evidence`：缺少最小复现证据；
- `duplicate`：已确认与现有问题同一根因；
- `known_limitation`：符合已批准的能力边界；
- `blocked`：受外部服务、冻结目录或尚未解除的能力限制阻塞；
- `cannot_reproduce`：在记录的版本和环境中完成规定次数仍无法复现。

`duplicate` 必须保留原问题的 requestId、sessionId、sceneId 和证据，并链接主问题；不能直接删除。`cannot_reproduce` 不是关闭理由，仍需记录实际尝试的 commit、环境、次数和结果。

## 3. 严重度

| 等级 | 判定 |
|---|---|
| P0 | 凭据或私密内容泄漏；跨 Session/Scene 污染；不可恢复的数据丢失；未经确认的破坏性写入；错误地把有效场景当废弃对象清理 |
| P1 | 核心生成/修改不可用；不安全自动重放；局部修改越界；重复施工或恢复；结果不明确却报告成功；部署 Gate 错误给出 GO |
| P2 | 有明确 workaround 的功能故障；模板或特定输入稳定失败；失败原因、审计或进度信息不完整；明显性能退化 |
| P3 | 视觉、文案、低频可用性问题；不影响结果与数据安全的小范围体验问题 |

外部场景写入结果不明确时，最低按 P1 处理，并保持 `failed_recoverable`；在确认场景状态前不得降级或自动重试。

## 4. 首次分诊

维护者收到问题后：

1. 检查模板中的 commit、时间、环境、复现步骤和 requestId；无 requestId 时先定位三层启动、代理或浏览器故障。
2. 用 requestId 依次关联 `ai_requests`、`workflow_steps`、`ai_model_calls`、`ai_tool_calls`、`ai_scene_changes` 和 `ai_validation_results`。
3. 核对 sessionId、workflowRunId、sceneId 是否一致，确认问题属于 AI 请求、Editor 手工操作、部署环境还是外部 Provider。
4. 检查请求终态、最后一个 workflow step、稳定 error code、scene build 状态和是否存在结果不明确的写入。
5. 将问题标为可复现、需补证据、已知限制或阻塞，并指定负责人和严重度。

审计摘要只提取稳定 ID、枚举、计数、时间和版本。不得把数据库整行、用户输入、工具参数值或供应商响应复制到问题单。

## 5. 去重规则

只有以下要素足以表明同一根因时才能合并：

- 相同稳定 error code、workflow step 或 validator；
- 相同操作模式和失败 disposition；
- 相同或相邻 commit 范围；
- 相同预期/实际差异类型；
- 相同场景写入边界或恢复状态。

相似的用户表述、房型名称、截图外观或同一个 room type 不能单独作为去重依据。合并时主问题保存根因与回归状态，子问题保留各自 requestId、sessionId、sceneId、版本和影响范围，以免掩盖跨场景或并发问题。

## 6. 回归验证

能够稳定在 `pascal-ai-mcp` 内复现的问题必须优先补自动回归，包括：

- domain、validator、parser、Prompt registry 和 repository 规则；
- 队列、lease、取消、恢复和幂等竞态；
- HTTP envelope、稳定错误码和审计记录；
- MCP 客户端接线与确定性场景 diff；
- 能用固定响应重现的 Provider 错误。

以下问题可以使用明确的人工复验：

- Editor 手工拖动、undo/redo 或其它冻结目录内的行为；
- 浏览器视觉、交互时序和刷新体验；
- Editor、MCP、Proxy 三层真实部署；
- 需要人工判断的 Provider 设计质量；
- 受控旧 commit 与旧数据的回退演练。

人工复验记录必须包含 commit、环境、步骤、预期、实际、通过/失败、执行人、时间和必要的脱敏截图。不能只写“手工测过”。

## 7. 修复与关闭标准

问题进入 `fixed_pending_verification` 前必须记录：

- 已确认的根因；
- 修复 commit，或明确的 known limitation/blocked 原因；
- 自动回归用例，或符合第 6 节的人工复验步骤；
- 是否改变数据、审计、恢复或用户可见行为；
- 相关文档、追踪矩阵和能力矩阵是否需要同步。

关闭前必须满足：

1. 回归在当前目标 commit 上通过；
2. 没有未解释的跨 Session/Scene 影响；
3. 相关 E 阶段 Gate 已按影响范围重跑；
4. `failed_recoverable` 问题已人工确认场景保留、清理或明确处置；
5. 问题单不含禁止留存的数据；
6. 限制、负责人和后续任务已经记录。

P0/P1 由修复者以外的人复验。P2/P3 可由任务负责人复验，但必须保留证据。

## 8. 周期性复盘

内部测试期间至少每个测试批次复盘一次：

- 按严重度、stage、error code、validator 和操作模式聚类；
- 检查重复失败是否缺少自动回归；
- 检查 `needs_evidence` 是否暴露模板或界面取证缺口；
- 检查 known limitation 是否已经影响部署 Gate；
- 检查审计、日志和 artifact/checkpoint 增长；
- 把已验证的稳定问题加入 deterministic Case 或相应演练。

复盘只使用现有审计和人工证据，不新增 Editor 行为采集，也不把场景差异解释为某个用户动作。
