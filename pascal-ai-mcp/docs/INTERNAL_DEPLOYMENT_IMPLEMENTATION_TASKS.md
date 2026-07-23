# Pascal AI 内部部署实施任务表

## 1. 用途

本文档把 `INTERNAL_DEPLOYMENT_READINESS_TASKS.md` 中的 D1–D6 拆成可独立实现、测试、审核和提交的小任务。

需求、边界和最终验收以 `INTERNAL_DEPLOYMENT_READINESS_TASKS.md` 为准；本文档只定义实施顺序，不重复发明架构或扩大范围。

## 2. 全局执行规则

- 只修改 `pascal-ai-mcp/**`。
- 不修改 `packages/**`、`apps/**`、`pascal-reverse-proxy/**`、根配置或代理接口。
- 不修改 MCP 服务端契约。
- 每个任务完成后先运行任务级测试，再运行 `bun run check-types`。
- 每个阶段完成后运行全量 `bun test --max-concurrency=1` 和模板体检。
- 每个任务单独提交；不得把下一任务的代码提前混入当前 diff。
- 不删除、重写或放宽既有测试来迁就实现。
- 任何外部场景写入结果不明确时继续 fail-safe，不自动重放。
- Token 计费和多 API Key 自动轮换不在任务表中。

## 3. 状态图例

- `[ ]` 未开始
- `[~]` 进行中
- `[x]` 完成并通过审核
- `[!]` 阻塞，需要用户决定或解除范围限制

## 4. 阶段 A：统一验证调度（D1）

### [x] A1 盘点现有验证入口

内容：

- 列出 Plan、生成、修改、家具、最终验收阶段的现有验证函数和 MCP 验证工具。
- 标记每个验证的输入、输出、严重级别、当前调用点和审计写入点。
- 完整列出现有 `recordValidation` 调用点及其 validator ID、触发阶段和写入次数，作为 A5 去重接线的核对基线。
- 识别重复调用与不一致的失败分类，但本任务不改行为。
- 形成 `docs/VALIDATION_REGISTRY_DESIGN.md` 草案。

允许修改：`pascal-ai-mcp/docs/**`。

完成标准：设计文档能回答“哪个阶段运行哪些验证、现有真相源在哪里”，且没有代码行为变化。

### [x] A2 定义纯验证契约与 registry

依赖：A1。

内容：

- 在 domain/ports 合适位置定义 `ValidationCheck`、上下文、结果和 disposition 类型。
- 建立 registry，检查项按稳定 ID 注册。
- 类型只表达调度，不复制 validator 的判断逻辑。
- 禁止依赖 MCP、SQLite、LangGraph 或具体 adapter。

允许修改：`src/domain/**`、`src/ports/**`、对应测试。

完成标准：registry 可选择阶段所需检查项；依赖边界测试通过。

### [x] A3 接入纯计算验证

依赖：A2。

内容：

- 用 adapter/wrapper 接入现有 `validateLayoutPlan`、completion gates、家具位置和修改保护检查。
- 保留原函数和原结果语义，不复制算法。
- 为每个 wrapper 增加等价性测试：registry 调用结果与原直接调用逐字段一致。

允许修改：`src/application/**`、`src/domain/**`、必要的现有验证模块和测试。

完成标准：纯计算验证可以统一调度，现有测试结果不变。

### [x] A4 接入 MCP 验证工具

依赖：A2。

内容：

- 接入既有 `validate_scene`、`verify_scene`、碰撞检查等工具调用。
- 只调用现有 MCP 能力，不改工具 schema。
- 明确工具失败、取消和结果未知的 disposition。
- 写工具与读/验证工具的恢复边界不得混淆。

允许修改：`src/application/**`、`src/adapters/**`、`src/ports/**`、测试。

完成标准：MCP 验证可由 registry 调度；失败不产生虚假通过。

### [x] A5 统一审计与 workflow 接线

依赖：A3、A4。

内容：

- workflow 按 plan、structure、furniture、modify、verification 阶段调用 registry。
- 结果继续写入现有 `ai_validation_results`。
- 保留 request、workflow run、step、scene、validator 关联。
- 移除被 registry 取代的平行调用，但不得删除底层 validator。
- 增加迁移前后审计等价性测试：同一请求写入 `ai_validation_results` 的 validator 与次数记录集逐行一致。

允许修改：`src/application/**`、`src/agent.ts` 最小接线、telemetry/persistence adapter 和测试。

完成标准：新增验证不再需要修改 `agent.ts` 主流程；同一验证不会重复记账。

### [x] A6 D1 回归与文档定稿

依赖：A5。

内容：

- 覆盖 Plan fatal、MCP 验证失败、家具失败、修改保护、取消和中断。
- SQL 断言验证结果可按 requestId 顺序查询。
- 更新验证设计文档和部署清单状态。

完成标准：任务级测试、类型检查、全量测试、模板体检全绿；D1 经审核后标记完成。

实施状态（2026-07-23）：A1–A6 已通过独立审核。验证基线为 670 tests / 0 fail、`check-types` 干净、15 份模板体检通过。

有意行为变化：正常路径的 validator ID、摘要和写入次数保持不变；MCP 验证读取失败时由旧版“不产生验证行”改为先写一条 `status=unavailable`（reason 为 cancelled/timeout/tool_error）再抛出原错误。该行用于区分“验证未执行成功”和“验证通过”，不会把失败误判为成功。

## 5. 阶段 B：修改流程安全收口（D2）

### [x] B1 建立修改模式分类器

依赖：A2。

内容：

- 定义 `local_patch` 与 `plan_rebuild` 稳定枚举和 reason code。
- 对现有 modify ops 建立明确映射。
- 未知操作默认进入更保守的 `plan_rebuild` 或拒绝，不得猜成局部操作。

允许修改：`src/domain/**`、`src/application/modify-service*`、测试。

完成标准：每种现有修改操作都有确定模式，分类器为纯函数且三语文案不进入 domain。

### [x] B2 持久化修改模式与审计关联

依赖：B1。

内容：

- 把修改模式和 reason code 关联到 request/workflow step 或既有审计摘要。
- 不保存用户原文。
- 不新建与 `ai_requests`/`workflow_steps` 冲突的状态真相源。

允许修改：`src/persistence/**`、`src/telemetry/**`、`src/application/**`、测试。

完成标准：给定 requestId 能查明该修改为何走局部 patch 或重建。

### [x] B3 收口 local_patch 执行范围

依赖：A5、B2。

内容：

- 执行前读取目标和必要邻域。
- 对重命名、家具增删移动和已证明安全的门窗调整建立允许范围。
- 执行后对 scene diff 做确定性范围检查。
- 若出现无关节点变化，任务失败并如实报告；不承诺自动恢复原场景。

允许修改：`src/application/**`、`src/domain/**`、`src/agent.ts` 最小接线、测试。

完成标准：局部修改回归证明无关房间、结构、开口和家具不变化。

### [x] B4 收口 plan_rebuild 确认与文案

依赖：B2。

内容：

- 在确认前说明会重建的结构范围和可能影响。
- 继续使用现有 fencing、scene_build 和失败恢复策略。
- 用户回复与文档不再把结构重建称为局部施工。
- 保持现有不可盲目重放边界。

允许修改：`src/application/**`、`src/lang/**`、必要测试。

完成标准：结构修改必经确认；取消不施工；失败不谎报成功。

### [x] B5 分级验证接线

依赖：A5、B3、B4。

内容：

- `local_patch` 运行目标区域验证和最低限度全局安全 gates。
- `plan_rebuild` 运行完整 Plan 与 completion gates。
- 两种模式都记录验证结果和最终 disposition。

完成标准：修改模式与验证范围匹配；任何失败均不会把 session 标为成功。

### [x] B6 D2 回归与文档定稿

依赖：B5。

内容：

- 固定重命名、家具移动/增删、门窗安全调整、增加/删除房间、面积调整和手工场景漂移用例。
- 更新修改文档与内部部署清单状态。

完成标准：全量测试与模板体检全绿；D2 经审核后标记完成。

实施状态（2026-07-23，已通过独立审核）：

- `rename_room` 与家具增删换归类为 `local_patch`；房间增删、面积调整和混合结构请求归类为 `plan_rebuild`；未知或解析不完整的操作安全拒绝，不再静默降级到自由编辑。
- 模式、稳定 reason code 和操作类型写入当前 workflow step；step 终态即本次修改的最终 disposition，不新增平行状态表，也不保存用户原文。
- `local_patch` 在施工前后读取场景快照，只允许目标 zone、目标 item 及其父节点 children 字段发生预期变化；越界变化记录 `local-patch-scope` 失败并终止成功结算。由于 MCP 不提供通用回滚，本检查不声称能撤销已提交写入。
- `plan_rebuild` 在任何场景写入前明确说明重建范围、手工编辑覆盖风险和家具重放限制，并要求该次模式确认；确认绑定解析后 ModifyOp 数组按确定性 JSON 序列化所得的 SHA-256，二次翻译若发生漂移会重新确认。Intent/Plan 快照或可用楼层结构缺失时拒绝结构重建。Plan validator、完整场景诊断和 completion gates 继续执行并进入既有审计。
- 当前 ModifyOp 词表尚无门窗操作，也没有带明确目标位置的 `move_furniture`；这两类请求按未知操作安全拒绝，不会为了满足“局部”标签转入自由 MCP 编辑。待有确定性位置契约、执行器和范围证明后再加入 `local_patch`。
- 取消、失败和范围越界回复不再承诺“原场景未改变”或自动回滚，要求用户先检查可能已经发生的部分写入。
- 独立审核发现并关闭了结构重建缺少 level 时返回 `null`、继而静默落入自由编辑的问题。默认 `runPlanFirst` 契约现为不可空，控制流只在显式设置 `PASCAL_MODIFY_LEGACY=1` 时进入旧路径；缺少 Intent/Plan 或 level 均安全拒绝且不施工。

验证状态（2026-07-23）：`bun run check-types` 通过；修改相关定向测试 125 pass / 0 fail；在允许本机随机端口的环境运行全量测试为 690 pass / 0 fail；15 份模板体检通过；`git diff --check` 干净。

## 6. 阶段 C：Prompt registry（D3）

### [x] C1 Prompt registry 契约

内容：

- 定义 Prompt ID、版本、类型化变量、渲染结果和 hash。
- 内容变化未升版时测试失败。
- 缺失变量在模型调用前失败。
- registry 不依赖模型 adapter、SQLite 或 LangGraph。

允许修改：`src/prompts/**`、必要 port/type、测试。

完成标准：一个最小示例 Prompt 能通过 registry 渲染并生成稳定 hash。

### [x] C2 迁移 extraction 与 intent Prompt

依赖：C1。

内容：

- 迁移 requirement extraction、scene intent、layout intent。
- 保持消息结构、模型调用次数、temperature、fallback 和预算门不变。
- model call 使用 registry 返回的真实版本与 hash。

完成标准：旧行为回归通过，调用点不再内嵌这些大段 Prompt。

### [x] C3 迁移 modify 与 inspect Prompt

依赖：C2。

内容：迁移 modify ops、modification guard 和 inspect Prompt，保持行为与错误语义不变。

完成标准：对应调用点只引用 Prompt ID 和类型化变量。

### [x] C4 迁移 scene-agent 与 repair Prompt

依赖：C3。

内容：

- 迁移 scene agent 基础 Prompt、动态 guide 和 repair Prompt。
- 区分稳定模板内容与每轮动态上下文，动态用户/场景内容不得参与版本号定义。

完成标准：主要 Prompt 全部进入 registry；checkpoint 和日志不保存 Prompt 正文。

### [x] C5 Prompt 审计与迁移回归

依赖：C4。

内容：

- SQL 验证 `prompt_version`/`prompt_hash` 与 registry 一致。
- 增加版本升级测试与旧版本保留策略说明。
- 更新 Prompt 管理文档和 D3 状态。

完成标准：类型检查、全量测试、模板体检和选定 deterministic eval 全绿。

实施状态（2026-07-23，已通过独立审核）：

- 新建纯 `src/prompts/registry.ts`，以类型化变量渲染 9 个稳定 Prompt ID；缺失或未知变量在模型调用前失败。registry 不依赖模型 adapter、SQLite、LangGraph 或 MCP，并由架构边界测试锁定。
- extraction、scene intent、layout intent/geometry、modify ops、legacy modification guard、inspect、scene-agent/continuation 和 repair 已迁移。调用次数、消息角色、temperature、fallback、预算门和错误分流保持原路径。
- `RequestHooks` 接受 registry 返回的 `promptHash`；模型 attempt 与 `ai_model_calls` 使用真实 registry `promptVersion`/`promptHash`，不再由调用点手写版本。未迁移的兼容调用仍回退到 system-message hash。
- hash 只覆盖稳定模板片段；brief、用户消息、历史、诊断和 MCP guide 只参与渲染，不影响版本定义，也不进入 checkpoint、普通日志或数据库正文。
- `src/prompts/registry.test.ts` 固定 `promptVersion → promptHash`，模板正文未升版变更会失败；旧版本归档与完整 commit 回退策略见 `docs/PROMPT_MANAGEMENT.md`。
- 独立审核发现并关闭了动态内容包含 `{{...}}` 时被误判为未解析模板表达式的问题。模板语法现在只在注入动态值之前校验，用户文本中的花括号保持原样，并有 extraction、scene intent、modify ops 和 inspect 回归覆盖。
- 带稳定 `operation` 的受审计模型调用若缺少 registry `promptVersion` 或 `promptHash`，会在 HTTP 请求前响亮失败；底层无 operation 的兼容调用仍保留 system-message hash 兜底。

验证状态（2026-07-23）：`check-types` 通过；Prompt registry 与模型边界新增 2 个审核回归用例并通过；deterministic eval 112 tests / 0 fail，23 个 case / 0 个结构性问题且未调用模型或 MCP；允许本机随机端口的环境中全量测试 699 pass / 0 fail；15 份模板体检通过；`git diff --check` 干净。

## 7. 阶段 D：内部告警（D4）

### [x] D4.1 提取共享 readiness 检查服务

内容：

- 把 `/ready` 当前检查组合提取为可复用 application service。
- HTTP `/ready` 行为、鉴权、状态码和脱敏响应保持不变。
- SQLite、checkpoint、模板、MCP 和 telemetry 不得出现第二套判断。

完成标准：现有 readiness 集成测试逐项保持通过。

### [x] D4.2 实现 `ops:check`

依赖：D4.1。

内容：

- 复用 readiness service。
- 新增 queued 最大等待时间、异常 running lease、近期失败率和错误码分布。
- 支持结构化输出和健康/异常退出码。

允许修改：`scripts/**`、`src/application/**`、`src/persistence/**` 只读查询、`package.json`、测试。

完成标准：命令可供定时任务调用，不修改任何业务状态。

### [x] D4.3 告警事件、冷却与恢复

依赖：D4.2。

内容：

- 定义 warning、critical、recovered 事件。
- 相同 reason code 在冷却窗口内不重复刷屏。
- 故障恢复时产生一次 recovered。
- 输出严格脱敏。

完成标准：固定时钟测试覆盖首次告警、冷却、恢复和再次故障。

### [x] D4.4 故障注入回归

依赖：D4.3。

内容：模拟 MCP 退出、模板损坏、数据库不可写、telemetry degraded、队列积压和 lease 异常。

完成标准：自动降级、告警和恢复符合文档；写工具调用不自动重放；D4 经审核后标记完成。

实施状态（2026-07-23，已通过独立审核）：

- `/ready` 原有 SQLite、checkpoint、模板、MCP、telemetry 和 model-provider 组合已提取为纯 application `ReadinessService`；鉴权仍由 HTTP 层负责，状态码和脱敏响应结构保持不变。
- `bun run ops:check` 调用受保护的 `/ready`，并以只读 SQLite 连接补充 queued 最长等待、worker running lease、近期失败率和稳定错误码分布。命令返回结构化 JSON 与 0/1/2 退出码，不修改请求、Session、workflow 或场景状态。
- `ai_requests.execution_source` 持久标记 `worker`、`direct` 或迁移前 `legacy`；服务失败率只统计 worker 终态，不受共享数据库中的 CLI/eval 或不可判定历史记录影响。
- 服务进程使用相同 `OpsService` 周期检查。`OpsAlertTracker` 按稳定 reason code 输出 warning/critical/recovered；同类事件在冷却窗口内不重复，恢复只输出一次。
- 输出仅含稳定 reason code、状态、计数、时长和比例。原始异常、数据库路径、凭据、Prompt、用户内容、工具响应和场景内容均不进入告警。
- 既有真实 HTTP 集成测试继续覆盖 MCP 子进程退出/恢复与生产模板门控；新增固定时钟、队列/lease/失败率、不可用依赖、脱敏和真实 `ops:check` 接线测试。写工具自动重放语义未改变。
- 独立审核发现并关闭了共享数据库中 CLI/eval 终态会混入服务失败率的问题。migration v14 新增持久 `execution_source`，worker、direct 与无法可靠回填的 legacy 数据不再互相污染运维口径。

验证状态（2026-07-23）：`bun run check-types` 通过；D4 新增的 readiness、运维判断、只读指标和真实 `ops:check` 接线共 8 个测试通过；真实 server 集成测试 3 pass / 0 fail；允许本机随机端口的环境中全量测试 707 pass / 0 fail（61 个文件、2030 个断言）；15 份模板体检通过；`git diff --check` 干净；冻结目录 diff 为空。

## 8. 阶段 E：内部部署验收（D5）

### [~] E1 编写内部部署 Runbook

依赖：A6、B6、C5、D4.4。

内容：

- 环境要求和 `.env` 必填项，明确 `AI_MCP_READINESS_TOKEN`。
- 三层启动、停止、探活和日志位置。
- 只使用现有健康端点、页面或端口检查，不修改冻结目录。
- 数据目录、权限、备份、清理和恢复步骤。
- 本机/可信内网边界。

完成标准：未参与开发的人可按文档在干净环境启动系统。

实施状态（待独立审核，2026-07-23）：新增 `docs/INTERNAL_DEPLOYMENT_RUNBOOK.md`，使用现有 Editor 3002、AI 8788、Proxy 8000 命令与端点，覆盖前置依赖、必填环境变量、统一场景存储、启动/停止顺序、readiness 与 `ops:check`、数据权限、停机备份、schema 不降级回退、清理命令、日志边界和可信内网限制。未为验收修改冻结目录或新增接口。

### [~] E2 建立发布前自动 Gate

依赖：E1。

内容：

- 串联类型检查、全量测试、模板体检和 deterministic eval。
- provider eval 保持显式付费开关，不进入默认无费用 Gate。
- 输出 commit、schema、Prompt 和模板版本摘要；schema version 直接读取 `schema_migrations` 的 `MAX(version)`，不得另造版本来源。

允许修改：`pascal-ai-mcp/scripts/**`、`package.json`、docs、测试。

完成标准：单一命令能给出明确 pass/fail，不修改根 CI 或冻结目录。

实施状态（待独立审核，2026-07-23）：新增 `bun run release:check`，默认串联 typecheck、串行全量测试、`--no-artifacts` 模板体检和 deterministic eval；报告从真实临时库的 `schema_migrations MAX(version)` 读取 schema，并记录 commit/dirty、Prompt version/hash 与模板 schema。默认拒绝 dirty worktree且零 provider 调用；付费抽查必须显式给出 `--with-provider-eval`、1–3 个 case 和可选重复次数，免费 Gate 失败时不会进入付费步骤。未修改根 CI 或冻结目录。

验证状态（2026-07-23）：Gate 参数与版本来源 3 tests / 0 fail；`bun run release:check -- --allow-dirty` 在当前开发 worktree 完整通过 typecheck、串行全量测试、15 份模板无产物体检和 deterministic eval（112 tests / 0 fail，23 cases / 0 结构问题）；最终事件为 `mode=free`、schema v14、template schema v2、9 个 Prompt version/hash，未运行 provider eval。默认不带 `--allow-dirty` 时按设计以 `dirty_worktree` 非零退出。

### [~] E3 Session 与 checkpoint 恢复演练

依赖：E1。

内容：验证正常退出、进程中断、安全节点恢复、结果未知时 failed_recoverable、刷新后续查。

完成标准：演练记录包含日期、commit、requestId、sessionId、步骤和结果。

实施状态（待整批独立审核，2026-07-23）：`bun run internal:check` 的 E3 复用 durable workflow、agent process reconstruction 和 request worker 的真实 SQLite 测试，覆盖 interrupt、数据库重开、安全 plan checkpoint、lease 中断、queued 重启续跑和终态持久化。报告记录固定测试 requestId/sessionId 与测试名称，不复制恢复算法。

### [~] E4 依赖故障与降级演练

依赖：D4.4、E1。

内容：验证 MCP 退出恢复、数据库不可写、模板不可用、telemetry degraded、取消和网络中断。

完成标准：没有虚假成功，没有盲目重放，告警和 recovered 记录完整。

实施状态（待整批独立审核，2026-07-23）：E4 串联 MCP 代次/熔断、模型 attempt、readiness、ops、真实 server 与 `ops:check` 集成测试。允许临时 loopback 端口的环境中 35 pass / 0 fail；MCP 写调用不自动重放，取消/网络/模板/telemetry 故障均保留稳定失败或降级语义。

### [~] E5 并发与背压演练

依赖：E1。

内容：

- 预先确定内部测试并发人数和请求数。
- 覆盖同 session 与跨 session 提交。
- 验证排队、既定 429、最终终态和数据隔离。
- 记录最大等待时间和失败分布，不临时调大并发掩盖问题。

完成标准：所有已接受请求进入终态；session、scene、request 无互相污染。

实施状态（待整批独立审核，2026-07-23）：自动部分使用两个真实子进程验证同幂等键只创建一行，并覆盖同 Session/Scene 排他、取消优先、队列深度、重启续跑和 drain。允许临时 loopback 端口的环境中 19 pass / 0 fail。真实集中测试固定为 3 名测试者 × 3 请求、保持默认 worker 并发 1，步骤见 `docs/INTERNAL_DEPLOYMENT_DRILLS.md`；该人工证据尚未执行。

### [~] E6 备份、升级与回退演练

依赖：E1。

内容：

- 停止接收和领取请求，drain 后备份 SQLite 与 artifact。
- 记录旧 commit/schema 后执行测试升级。
- 回退时恢复旧数据备份并部署旧 commit。
- 不尝试数据库 schema 降级，不让旧代码直接打开升级后的数据库。

完成标准：在非唯一测试数据上完成一次可重复的升级和回退。

实施状态（待整批独立审核，2026-07-23）：新增停机数据备份原语，对完整 AI 数据目录生成逐文件 SHA-256 manifest，拒绝覆盖已有备份/恢复目标，并在恢复前验证完整性。自动演练在临时非唯一数据上完成“旧 schema 与 payload → 备份 → 测试升级和变更 → 删除 live → 恢复到空目录”，2 pass / 0 fail。真实旧 commit + 三组部署数据回退仍要求外部 `rollback.json`，自动测试不冒充已执行部署回退。

### [~] E7 日志与磁盘增长方案

依赖：E1。

内容：

- 定义 stdout 日志轮转和保留策略。
- 定义磁盘容量阈值与检查频率。
- artifact/checkpoint 使用既有清理命令。
- 审计表增长只监控，不在未批准保留策略时删除。

完成标准：Runbook 能回答日志和数据库增长后如何发现、如何处理。

实施状态（待整批独立审核，2026-07-23）：新增 `bun run storage:check` 与 `docs/LOG_AND_STORAGE_POLICY.md`。默认 70% warning、85% critical，命令只读文件系统、schema 与审计行数并返回 0/1/2；日志策略为 stdout/stderr 由进程管理器按 50 MiB × 10、最长 14 天轮转。artifact/checkpoint 只走既有清理命令，审计只监控不删除。

### [~] E8 AI 增删改查全量 Case 回归

依赖：A6、B6、C5、D4.4、E2。

内容：

- 建立覆盖真实 AI 场景操作的 CRUD Case 集：
  - 增：房间、门窗和家具；
  - 删：指定房间或家具，验证无关结构不被误删；
  - 改：房间面积/名称、门窗位置、家具替换和局部结构调整；
  - 查：房间、面积、家具和场景状态查询，验证只读请求不产生场景写入；
  - 混合：先增后改、先删后增和连续多轮修改；
  - 保护：局部修改后无关房间、墙体、门窗和家具保持不变；
  - 失败与恢复：目标不存在、请求含糊、面积越界、取消、网络中断、MCP 中断、刷新和重试。
- 测试分三层执行：
  1. deterministic Case，不调用模型，验证路由、操作分类、局部修改范围和失败边界；
  2. provider Case，重复运行选定用例，评估稳定性而非只看单次正确性；
  3. 浏览器端到端，真实执行“生成 → 查询 → 增加 → 修改 → 删除 → 刷新恢复”。
- provider Case 必须保留显式付费开关；运行前由用户确认，不进入默认无费用 Gate。
- 每个失败必须记录 commit、caseId、repeat、requestId、sessionId、sceneId、预期/实际结果和场景 diff；修复后补自动回归或明确人工复验步骤。
- 场景写入结果不明确时继续标记 `failed_recoverable`，不得为了让 Case 通过而自动重放或承诺当前能力不支持的回滚。

允许修改：`pascal-ai-mcp/eval/**`、`pascal-ai-mcp/scripts/**`、`pascal-ai-mcp/docs/**`、`pascal-ai-mcp/src/**` 中与失败 Case 修复直接相关的文件及测试。浏览器验收只使用现有 Editor/代理接口，不修改冻结目录。

完成标准：CRUD 与混合流程的 deterministic Case 全绿；经用户确认后完成 provider 重复抽查并形成稳定性报告；浏览器端到端无无关节点变化、虚假成功、盲目重放或跨 Session 污染；所有已知失败都有归因和处置结论。

实施状态（待整批独立审核，2026-07-23）：新增机器可读 `eval/crud-matrix.json` 与 `docs/CRUD_ACCEPTANCE.md`，区分 supported、safe_rejection 与 failed_recoverable。零费用 E8 覆盖房间/家具 CRUD、连续修改、局部范围、未知操作拒绝和 deterministic corpus，163 个定向测试及 112 个 deterministic eval 测试、23 个 case 结构检查全绿。当前已有场景的直接门窗增删移动，以及带明确目标位置但没有确定性位置契约的 `move_furniture`，均按 B 阶段决策安全拒绝，不冒充功能支持。Provider 付费重复抽查与浏览器流程尚未执行。

### [~] E9 内部部署 Go/No-Go 评审

依赖：E2–E8。

内容：汇总所有 Gate 与演练证据，逐项核对 D1–D5 完成标准。

完成标准：没有未解释的失败；剩余限制有负责人和风险说明；明确给出 Go 或 No-Go 结论。

实施状态（待整批独立审核，2026-07-23）：`bun run internal:check` 为 E3–E8 输出绑定 commit 的 JSON/Markdown 证据，并校验 provider/browser/startup/rollback 四份外部证据必须属于同一 commit。开发期 `--automated-only` 可单独验证零费用部分；`--allow-dirty` 只放行开发期自动执行，dirty worktree 无条件进入 blocker 且绝不允许最终 `GO`。正式模式在自动任务不全、dirty worktree、证据缺失或跨版本时一律 `NO-GO`。当前结论为 `NO-GO`，阻塞项仅为尚未执行的付费 provider、真实浏览器/三层启动和受控旧 commit 回退证据，不把缺证据写成通过。

## 9. 阶段 F：追踪边界与反馈（D6，不阻塞部署）

### [x] F1 建立追踪矩阵

内容：列出自动记录、人工记录、明确不记录的数据，标明真相源、保留范围和查询方式。

允许修改：`docs/**`。

完成标准：不把 AI 请求日志解释成 Editor 用户编辑行为。

实施状态（2026-07-23）：新增 `docs/INTERNAL_TEST_TRACKING.md`，逐项区分自动记录、人工记录和明确不记录的数据，标明真相源、保留范围、查询方式与证明边界；明确禁止用 AI 请求日志推断 Editor 手工编辑、undo/redo 或用户意图。

### [x] F2 内部测试问题模板

依赖：F1。

内容：定义问题报告需要的 commit、requestId、sessionId、sceneId、复现步骤、截图和预期/实际结果。

允许修改：`docs/**`。

完成标准：测试人员无需读取数据库即可提交可关联的问题。

实施状态（2026-07-23）：新增 `docs/INTERNAL_TEST_ISSUE_TEMPLATE.md`，覆盖 commit、环境、权威 ID、前置状态、AI/手工操作分离、预期/实际、终态、场景证据和隐私检查；同时规定请求未到达 AI、没有 requestId 时的取证方式。

### [x] F3 内部反馈复盘流程

依赖：F2。

内容：定义问题分级、去重、关联审计、回归用例补充和关闭标准。

完成标准：每个已修问题有自动回归或明确的人工复验步骤。

实施状态（2026-07-23）：新增 `docs/INTERNAL_TEST_FEEDBACK_PROCESS.md`，定义生命周期、P0–P3 分级、关联审计、去重、自动/人工回归边界和关闭标准；结果不明确的场景写入最低按 P1 与 `failed_recoverable` 处理，不允许盲目重放。

## 10. 阶段完成顺序

```text
A1 → A2 → A3/A4 → A5 → A6
                       ↓
              B1 → B2 → B3/B4 → B5 → B6
                       ↓
              C1 → C2 → C3 → C4 → C5
                       ↓
              D4.1 → D4.2 → D4.3 → D4.4
                       ↓
              E1 → E2/E3/E4/E5/E6/E7 → E8 → E9

F1 → F2 → F3 可与 E 阶段并行，不阻塞内部部署。
```

## 11. 每个任务的交付模板

完成任务时必须提供：

1. 任务编号和目标。
2. 实际改动文件。
3. 行为变化；若无行为变化，明确写“行为保持”。
4. 新增或更新的测试。
5. 实际执行的验证命令和结果。
6. 未执行的验证及原因。
7. 已知限制和后续任务。
8. 独立 commit。

## 12. Claude 审核重点

请只审核任务拆分和依赖关系，不把未实施任务当作代码缺陷。重点检查：

- 每个任务是否足够小，能形成独立、安全的 diff。
- 是否存在隐含修改冻结目录或 MCP 契约的步骤。
- A 阶段是否可能产生第二套验证真相源。
- B 阶段是否错误承诺外部场景回滚。
- C 阶段是否保持模型调用数量、预算与 fallback 行为。
- D 阶段是否复用 readiness，而不是复制判断。
- E 阶段是否覆盖并发、备份回退、日志磁盘和安全恢复。
- F 阶段是否诚实保留 Editor 用户行为的跨目录边界。
- 顺序是否存在循环依赖或把部署 Gate 放在依赖完成之前。
