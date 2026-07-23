# Pascal AI 内部部署准备任务清单

## 1. 目标

本文档用于收口 `pascal-ai-mcp` 的内部部署与集中测试准备工作。目标不是继续扩大产品范围，而是在保持现有功能和行为稳定的前提下，补齐验证调度、修改安全、Prompt 管理、内部告警和部署验收。

完成 D1–D5 后，可以进入内部部署和集中试用。D6 用于明确追踪边界，其中需要修改 Editor 的部分不阻塞内部部署。

## 2. 冻结边界

除非用户后续明确解除限制，实施本文档任务时必须遵守：

- 只允许修改 `pascal-ai-mcp/**`。
- 不修改 `packages/**`、`apps/**`、`pascal-reverse-proxy/**`、根配置和代理接口。
- 不修改与当前任务无关的既有行为、数据结构、Prompt、模板或测试断言。
- 不以“顺手重构”为理由改动任务范围之外的代码。
- 不修改 MCP 服务端契约，不新增依赖 `packages/mcp` 改造才能成立的承诺。
- 每个任务应形成独立、可审查的 diff；完成当前任务并通过验证后再进入下一项。
- 现有 SQLite 真相源保持不变：`ai_requests` 管请求与 lease，`workflow_steps` 管进度投影，`ai_sessions/ai_messages` 管会话，LangGraph checkpoint 只管安全执行游标。
- 无法确认外部场景副作用时继续 fail-safe，禁止根据 checkpoint 或日志盲目重放 MCP 写操作。

当前基线：commit `9b043540`；`pascal-ai-mcp` 全量测试 659 pass / 0 fail，类型检查与 15 份模板体检通过。

## 3. 明确不纳入本轮

以下两项按当前决策忽略，不作为内部部署阻塞项：

- Token 金额换算、价格表、成本账单与计费归属。
- 多套同类 API Key 池、按限额或错误自动轮换 Key。

以下跨目录事项也不在本文档实施范围内：

- Editor 用户手工编辑、撤销和重做事件的自动采集。
- 公共场景 schema、`packages/core` 或 `packages/mcp` 能力改造。
- 反向代理数据库解耦和对外身份系统。

## 4. P0：内部部署前必须完成

### [x] D1 统一验证调度

#### 目标

把现有分散的确定性验证组织成统一、可扩展、可审计的验证调度机制。模型不得决定验证是否通过。

#### 实施内容

- 定义纯类型或 port 级 `ValidationCheck` 契约，至少包含：
  - 稳定 `id`；
  - 适用阶段；
  - 检查范围；
  - 严重级别；
  - 输入要求；
  - 结构化结果；
  - 可修复、需用户确认或不可安全继续的处置分类。
- 建立 validation registry，由 workflow 按阶段选择检查项。
- 第一批接入现有能力，不重写其判断逻辑：
  - `validateLayoutPlan`；
  - completion gates；
  - `validate_scene`；
  - `verify_scene`；
  - 碰撞和家具位置检查；
  - 修改保护检查。
- 统一把结果写入现有 `ai_validation_results`，保留 request、workflow run、workflow step、scene 和 validator 关联。
- 验证摘要只允许稳定枚举与计数，不保存用户原文、完整场景或工具原始响应。
- 新增验证应通过注册完成，不得继续在 `agent.ts` 主流程增加平行分支。

#### 完成标准

- 新增一个验证项不需要修改生成/修改主流程。
- plan、生成、修改和最终验收使用同一套调度入口。
- 给定 requestId 能查询按执行顺序排列的验证结果。
- 验证写入失败的 fail-closed/fail-open 边界与现有审计策略一致。
- 现有验证结果和用户可见行为没有无意变化。

#### 重点回归

- 正常生成所有 gates 通过。
- Plan fatal 阻止施工。
- 局部修改没有改变无关结构。
- MCP 验证工具失败时不产生虚假成功。
- 取消和进程中断留下明确的未知或可恢复状态。

### [x] D2 修改流程安全收口

#### 目标

明确区分真正的局部修改和需要重规划/重建的结构修改，避免把整体重建描述成局部修改。

#### 修改模式

- `local_patch`：重命名、家具增删移动、已证明安全的门窗调整等，只触碰目标节点。
- `plan_rebuild`：房间增删、结构缩放、拓扑变化等，需要修改 Intent/Plan，并可能重建结构。

#### 实施内容

- 在执行前确定并持久记录修改模式和稳定 reason code。
- `local_patch`：
  - 执行前读取目标和必要邻域；
  - 只提交目标范围内的 patch；
  - 运行目标区域验证；
  - 再运行最低限度的全局安全 gates。
- `plan_rebuild`：
  - 明确告诉用户会重建哪些内容；
  - 沿用现有确认机制；
  - 保留场景写 fencing 和不可盲目重放限制；
  - 不在回复中宣称为局部施工。
- 修改验证失败时不得把 session 标为成功。
- 不为追求“局部”而绕过 Plan validator、completion gates 或场景版本边界。

#### 完成标准

- 重命名和家具局部修改只改变目标节点。
- `local_patch` 不改变无关房间、墙体、门窗和家具。
- 结构修改被准确标记为 `plan_rebuild`，并经过确认。
- request、workflow step、工具审计和验证审计能还原修改模式及结果。
- 文档和用户回复不再把所有修改笼统称为局部修改。

#### 重点回归

- 改房间名称。
- 移动、增加和删除单件家具。
- 增加或删除房间。
- 调整房间面积。
- 修改失败后再次确认重试。
- 现有场景包含用户手工修改时不静默覆盖。

### [x] D3 Prompt 独立管理与版本化

#### 目标

把主要 Prompt 从业务代码中移入统一 registry，建立真实可追踪的版本、hash 和渲染契约。

#### 实施内容

- 新建 `src/prompts/`，第一批覆盖：
  - requirement extraction；
  - scene intent；
  - layout intent；
  - modify ops；
  - inspect；
  - scene agent；
  - repair。
- 每个 Prompt 定义：
  - 稳定 ID；
  - 显式版本；
  - 模板正文；
  - 类型化变量；
  - 内容 hash。
- 所有调用点通过 registry 获取 Prompt，不再自行拼接独立版本号。
- `ai_model_calls.prompt_version` 和 `prompt_hash` 必须来自实际 registry 条目。
- 缺失变量应在模型调用前响亮失败。
- Prompt 内容变化必须显式升级版本，不自动覆盖旧版本语义。
- Prompt 不进入 LangGraph checkpoint，不在普通日志输出完整内容。

#### 完成标准

- 主要模型调用点不再内嵌大段 Prompt 字符串。
- 给定 model call 可以确认实际 Prompt ID、版本和 hash。
- Prompt snapshot/hash 测试能发现未升级版本的内容变化。
- 迁移前后的模型调用数量、预算门和 fallback 行为保持不变。

### [x] D4 内部告警与自动降级闭环

#### 目标

在现有 readiness、MCP 重连、熔断、模型 fallback 和队列背压基础上，增加主动、稳定、脱敏的内部故障发现能力。

#### 实施内容

- 新增内部运行状态检查命令，例如 `bun run ops:check`。
- 检查至少包括：
  - SQLite 可写；
  - checkpoint 表可写；
  - 模板库是否允许流量；
  - MCP 是否 ready；
  - telemetry 是否 degraded；
  - queued 请求最大等待时间；
  - running lease 是否异常；
  - 最近窗口内的失败率和主要稳定错误码。
- 与 `/ready` 重叠的 SQLite、checkpoint、模板、MCP 和 telemetry 检查必须复用同一套实现；`ops:check` 只扩展队列等待、lease 和失败率等运维维度，不建立第二套 readiness 判断。
- 定义结构化告警事件：`warning`、`critical`、`recovered`。
- 为同类告警增加冷却与恢复事件，避免重复刷屏。
- 内部测试阶段只要求结构化日志和非零退出码，不接入 Slack、邮件或外部监控平台。
- 告警不得输出 API Key、Token、Prompt、用户原文、完整响应或完整场景。

#### 完成标准

- MCP 退出、模板损坏、数据库不可写、telemetry 落库失败和队列积压都能产生稳定告警。
- 依赖恢复后产生对应 recovered 事件。
- 自动降级不会重放失败的写工具调用。
- `ops:check` 可供内部部署脚本和定时任务调用。

## 5. P1：部署验收与稳定性

### [ ] D5 内部部署验收流程

#### 自动验证 Gate

- `bun run check-types`。
- `bun test --max-concurrency=1`。
- `bun run templates:check -- --no-artifacts`。
- deterministic eval。
- 选定 2–3 个 provider eval 抽查用例，明确其会产生真实费用。
- 三层启动检查：Editor 3002、AI 8788、反向代理 8000。
- 三层探活只使用现有健康端点、既有页面或端口存活检查；不得为了验收给 `apps/**`、代理或其他冻结目录新增接口。

#### 故障演练

- AI 进程重启后 Session 和安全 checkpoint 可恢复。
- 生成中断后只从已验证的安全边界恢复。
- MCP 子进程退出后 readiness 降级，重连后恢复。
- SQLite 暂时不可写时不产生虚假成功。
- 同幂等键重复提交不会重复生成场景。
- 由预先确定数量的多名测试者并发提交请求，覆盖同 session 和跨 session：验证请求按预期排队、队列满时返回既定 429、全部已接受请求最终进入终态，且 session、scene、request 结果不互相污染。
- 取消、页面刷新和网络中断后，请求状态仍可继续查询。
- 场景写入结果不明确时标记 `failed_recoverable`，不自动重放。

#### AI 增删改查全量 Case 回归

- 覆盖房间、门窗和家具的增加、删除、修改与只读查询。
- 覆盖先增后改、先删后增、连续多轮修改和局部修改保护。
- 覆盖目标不存在、请求含糊、面积越界、取消、网络/MCP 中断、刷新和重试。
- 分 deterministic、provider 重复抽查和浏览器端到端三层执行；provider 测试产生真实费用，必须由用户显式确认后运行。
- 每个失败关联 commit、caseId、repeat、requestId、sessionId、sceneId 和场景 diff，修复后补回归用例。
- 只读查询不得产生场景写入；局部修改不得改变无关节点；结果不明确时不得盲目重放。

#### 部署资料

- 编写内部部署 Runbook。
- 列出 `.env` 必填项和启动前检查，明确要求配置 `AI_MCP_READINESS_TOKEN`；未配置时 `/ready` 按安全设计恒为 401，不能作为有效部署探针。
- 记录三个服务的启动、停止、健康检查和日志位置。
- 记录 SQLite、artifact 和 checkpoint 的备份、清理与恢复操作。
- 明确版本回退程序：部署前先停止接收/领取新请求并 drain，在备份 SQLite 与 artifact 后才能升级；回退时同时恢复部署前备份并部署旧 commit，不支持直接降级数据库 schema，也不得让旧代码直接打开升级后的数据库。
- 定义 stdout 日志轮转、磁盘容量告警和审计表增长监控；artifact/checkpoint 按既有清理命令处理，审计表不得在没有保留策略和明确批准时擅自删除。
- 记录版本 commit、数据库 schema version、Prompt 版本和模板 schema version。
- 明确服务仅监听本机或可信内网，身份与授权完成前不得公网暴露。

#### 完成标准

- 在干净环境按 Runbook 能一次启动三个服务。
- 自动 Gate 全绿。
- AI 增删改查 deterministic Case 全绿，provider 稳定性抽查与浏览器端到端均有版本化测试报告。
- 单请求故障演练和多测试者并发演练都有日期、版本、步骤和结果记录。
- 使用一次受控测试验证“备份 → 升级 → 回退旧 commit 与旧数据”程序可执行；不得用生产或唯一数据副本做首次演练。
- 内部测试人员能够恢复 Session、查询请求失败原因并安全停止服务。

## 6. P2：追踪范围确认

### [x] D6 追踪边界和内部测试反馈

#### 已有自动追踪

- requestId、traceId、clientRequestId、workflowRunId。
- Session 和 workflow phase。
- workflow steps、重试和恢复状态。
- 模型 attempt、Token、模型、耗时和失败码。
- 工具调用参数形状、场景版本变化和验证结果。
- confirm、cancel、retry 等 AI 请求行为。

#### 当前不自动追踪

- 用户在 Editor 中手工移动墙体、门窗或家具。
- Editor undo/redo。
- AI 完成后的人工结构修改量。
- 用户关闭面板、切换场景等纯前端行为。

#### 内部测试阶段方案

- 服务端自动追踪作为正式诊断依据。
- Editor 手工行为通过测试记录表、场景 review 和问题单人工收集。
- 不用 AI 请求日志推断并宣称真实用户编辑行为。
- 自动采集 Editor 行为继续保留为跨目录后续任务，不阻塞内部部署。

#### 完成标准

- Runbook 明确自动记录与人工记录的边界。
- 内部测试问题可以关联 requestId、sessionId、sceneId 和 commit。
- 测试人员知道哪些问题需要提供复现步骤或场景截图。

实施状态（2026-07-23）：已由 `INTERNAL_TEST_TRACKING.md`、`INTERNAL_TEST_ISSUE_TEMPLATE.md` 和 `INTERNAL_TEST_FEEDBACK_PROCESS.md` 完成。方案只使用现有服务端审计与人工取证，不修改 Editor/Proxy，也不根据 AI 日志推断用户手工行为。

## 7. 架构维持规则

当前 `pascal-ai-mcp` 的整体分层不再作为新一轮大规模重构任务。后续实施必须保持：

- domain 不依赖 HTTP、MCP、数据库、OpenAI 或 LangGraph。
- application 只依赖 ports 和纯领域能力，不直接构造 adapter。
- 新外部能力通过 port/adapter 接入。
- 新验证进入 validation registry。
- 新 Prompt 进入 prompt registry。
- `agent.ts` 不再增加可独立放入 application/domain 的大段规则。
- 依赖边界测试继续作为常规测试执行。
- 不以缩减文件行数作为架构完成标准。

## 8. 推荐实施顺序

1. D1 统一验证调度。
2. D2 修改流程安全收口。
3. D3 Prompt 独立管理与版本化。
4. D4 内部告警与自动降级闭环。
5. D5 内部部署验收流程。
6. D6 追踪边界和内部测试反馈。

D1–D4 每项完成后均运行完整类型检查与测试；D5 只在前四项完成后执行。D6 不要求解除跨目录冻结。

## 9. Claude 审核重点

请审核本清单是否满足以下要求：

1. 是否有任务会隐式要求修改 `packages/**`、`apps/**`、代理或根配置。
2. D1 是否复用现有 validator/gates，而不是另造一套判断真相源。
3. D2 是否准确区分局部 patch 与结构重建，且没有承诺 MCP 不支持的回滚能力。
4. D3 是否保证 Prompt 版本来自真实 registry，而不是调用点手写字符串。
5. D4 是否把主动告警和已有 readiness/circuit breaker 正确分层。
6. D5 的恢复测试是否只覆盖安全 checkpoint，不会盲目重放外部场景写入。
7. D6 是否诚实保留 Editor 用户行为的跨目录边界。
8. 是否存在会无意改变当前生成、修改、模板匹配、Token 记录或错误语义的任务表述。

审核本文件时只评审任务范围和验收标准，不把尚未实施的任务当成当前代码缺陷。
