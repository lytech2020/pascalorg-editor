# 架构改造任务清单

来源：`ARCHITECTURE_ASSESSMENT.md`（2026-07-17 评估 + 复核）。  
用法：按阶段顺序执行，一次做一个任务；完成后把 `[ ]` 改 `[x]` 并在任务下追加一行 `完成于 <日期>，<commit/备注>`。阶段内任务若无依赖标注，可按需调整顺序；跨阶段不建议跳跃。

状态标记：`[ ]` 未开始 · `[~]` 进行中 · `[x]` 完成 · `[-]` 决定不做（注明原因）

## 全局约束

- 当前实施边界（2026-07-22 起）：**只允许修改 `pascal-ai-mcp/**`**。`apps/editor/**`、`packages/**`、`pascal-reverse-proxy/**`、仓库根配置和 `.github/**` 全部冻结；即使改动看起来兼容或只是新增字段，也必须先由项目负责人明确解除对应目录约束。
- 历史已完成任务中存在少量公共仓库、Editor 接入和家具相关改动；本约束不要求在本清单中回滚它们，但后续任务不得继续扩大这些目录的 diff。调用既有 MCP 工具不等于修改 MCP，实现可继续使用现有工具契约。
- 带 ⚠️跨目录 标记的任务在当前边界下只能保留 ADR、接口需求或风险分析，不能进入代码实施，也不能标记完成。不得用 AI 数据库旁路或 `metadata` 临时字段冒充公共 scene schema/MCP 能力已经落地。
- 线上 eval 消耗真实模型费用，只在任务完成标准要求时跑；日常回归用 `bun test`。
- `requestId` 由 AI API 创建并作为业务请求主键；浏览器只能创建 `clientRequestId` / `idempotencyKey`，不得决定服务端主键。`traceId` 由可信 BFF 或 AI API 创建，不能信任浏览器自报的身份与追踪字段。
- T2.6 采用 LangGraph 持久化方案后新增服务端 `workflowRunId`：`sessionId` 表示整段会话，`requestId` 表示一次 API/队列动作，`workflowRunId` 表示可跨 chat/confirm/modify 请求暂停与恢复的一轮工作流，`traceId` 只作链路追踪。四者不得互相冒充。
- 验收标准不写死测试数量；统一表述为“当前完整测试集全过且测试数不减少”，避免任务清单随新增测试失效。
- 任何日志、错误响应和 telemetry 都不得包含 API Key、Authorization、Cookie、完整 Prompt/回复、图片 Base64 或供应商原始错误体。

---

## 阶段 0：快速见效（无依赖，可穿插任何时候做）

### [x] T0.1 AI 测试与类型检查进 CI
- 内容：新增 GitHub Actions job（或并入 `ci.yml`），按路径 `pascal-ai-mcp/**` 触发，执行 `bun run --cwd pascal-ai-mcp check-types` 和 `bun test --cwd pascal-ai-mcp`。
- 涉及：`.github/workflows/`（新文件或改 `ci.yml`）。
- 完成标准：改动 `pascal-ai-mcp` 下任意文件的 PR 会自动跑单测；不改时不触发。
- 依据：评估 §7.4、§10、§14-6（成本最低、零依赖，建议第一个做）。
- 完成于 2026-07-17，commit 874f4ad7。新增 `.github/workflows/ai-ci.yml`（触发路径 `pascal-ai-mcp/**` + `bun.lock` + workflow 自身；bun 1.3.0 对齐 mcp-ci；push 触发含 develop——本 fork 远端默认分支是 develop 而非 main，否则 push 永不触发）。GitHub 验证：PR #1 首次触发 ai-ci run #1 成功（33s，install → check-types → 497 测试 → 模板体检全绿）。注：同 PR 上 mcp-ci 失败是 packages/mcp 既有 connectHttp 测试 401 问题（本地可复现），与本任务无关，已另立任务跟踪。

### [x] T0.2 模板体检脚本化并进 CI
- 内容：`pascal-ai-mcp/package.json` scripts 增加 `templates:check` → `scripts/check-templates.ts`（CI 模式跳过 SVG 产物输出，需给脚本加对应开关）；接入 T0.1 的 workflow。模板文件、模板 schema/loader、体检脚本或相关依赖变化时都要执行，不能只监听 `templates/**`。
- 涉及：`pascal-ai-mcp/package.json`、`scripts/check-templates.ts`、workflow。
- 完成标准：坏模板 JSON / good 模板带 fatal 会让 CI 变红。
- 依赖：T0.1（共用 workflow）。
- 依据：§6.6、§7.4。
- 进展 2026-07-17：`check-templates.ts` 增加 `--no-artifacts` CI 模式（跳过 SVG）+ 失败收集与非零退出（坏 JSON/缺 meta.quality/plan.rooms、good 参照带 validator fatal 均判失败；分区器对照失败是已知差距不判失败）；`package.json` 加 `templates:check`；ai-ci.yml 增加体检步骤（触发路径 `pascal-ai-mcp/**` 已覆盖模板/loader/脚本/依赖）。本地验证：15 份模板通过 exit 0；注入坏 JSON 与 good 带 fatal 两种场景均 exit 1；完整 SVG 模式输出与既有预览零 diff。完成于 2026-07-17，commit 874f4ad7，随 T0.1 在 PR #1 的 ai-ci run #1 验证通过（Template health check 步骤绿）。
- 复审修复 2026-07-17（Codex 审阅中优先级 #4）：空模板目录不再静默通过（exit 1）；`meta.quality` 必须 ∈ {good,bad}，枚举外值（会被 seed matcher 静默禁用）判失败；新增 `scripts/check-templates.test.ts` 4 个脚本级回归用例（空目录/枚举外 quality/坏 JSON/真实库通过）。完整 Zod schema 仍归 T1.4。

### [x] T0.3 部署边界收口（local-only 加固）
- 完成于 2026-07-17。实现：`AI_MCP_HOST` 默认改 `127.0.0.1`；`/health` 只返回 `{ok}`（配置摘要移到启动日志，正式 readiness 留给 T2.5）；新增 `AI_MCP_MAX_BODY_MB`（默认 28，与前端 20MB 原图 Base64 后 26.7MB 联动）；README 新增 Deployment boundary 节。验证：真实启动冒烟测试四个场景（health 最小化、坏 JSON 400、坏图 400、超大 413）全过，监听地址确认 127.0.0.1。
- 复审修复 2026-07-17（Codex 审阅高优先级 #1 + 中优先级 #3）：①**chunked 绕过**——原实现仅 content-length 预检 + Bun `maxRequestBodySize`，实测 chunked 请求两者都拦不住（2MB 过 1MB 限返回 200）；改为 `src/http-guards.ts#readJsonBody` 流式逐块计数，超限即取消流返 413（真实服务器复验 chunked 2MB → 413）。②**图片校验只看前缀**——`isValidImageDataUrl` 现在校验 base64 结构（非空、长度 %4、合法字符）+ 解码后 PNG/JPEG magic bytes，空 payload 与垃圾 payload 均 400（复验通过）。新增 `http-guards.test.ts` 10 个用例（含 chunked 超限流式用例）；`AI_MCP_MAX_BODY_MB`/`AI_MCP_DRAIN_TIMEOUT_MS` 补进 `.env.example` 与 README。
- 内容：① `AI_MCP_HOST` 默认值 `0.0.0.0` → `127.0.0.1`（需要局域网访问时显式设置）；②未鉴权的 liveness 只返回 `{ok}`，provider/model/mcpMode 等诊断信息仅放内部 readiness/受保护端点；③ `/chat` 增加可配置的请求体大小上限、合法 JSON/data URL/MIME 校验与解析失败的 400/413 处理；④ README/部署说明明确"当前仅限本机/内网"。当前前端允许 20MB 原图，Base64 后约为 26.7MB，再加 JSON 开销，因此服务端上限必须与前端原图限制联动（可先设约 28MB，或同步下调前端限制），不能直接设 15–20MB 导致合法上传被拒。
- 涉及：`src/config.ts`、`src/server.ts`、`pascal-ai-mcp/README.md`。
- 完成标准：默认启动只监听回环地址；超过统一限制的请求返回 413，畸形 JSON/data URL 返回 400，合法的当前最大图片仍可提交；公开健康响应不暴露部署配置。
- 依据：§5.1、§14-3、§14-4。

### [x] T0.4 优雅退出：SIGTERM + session flush
- 完成于 2026-07-17。实现：SessionStore 新增 `flushAll()`（等待 write queue 落定；日常写入仍吞错误但记录 `lastFlushError`，flushAll 时上抛，后续成功写入会清除）；agent 暴露 `flushSessions()`；server 统一 `shutdown()` 处理 SIGTERM/SIGINT，flush 失败或超时以非零码退出；重复信号幂等（第二次信号立即 exit 1）。验证：`session-store.test.ts` 用例 + 真实进程 SIGTERM 冒烟 exit 0。仅覆盖协作式退出路径，不涉 SIGKILL。
- 复审修复 2026-07-17（Codex 审阅高优先级 #2）：①原实现没等 `server.stop()` 的 Promise，在途 `/chat` 完成前就可能 flush + exit 0 丢写入；现在 shutdown 顺序为 `await server.stop()`（drain 预算内等在途请求）→ 超时则 `stop(true)` 强关并记 exitCode=1 → `flushAll()` → 关 MCP。②`flushAll` 原来只等调用瞬间的队列尾，等待期间新入队的写会漏；改为循环等待直到队列稳定，并加回归用例"flush 期间插入的 set 也被落盘"。已知边界：数分钟的 `/chat` 超过 drain 预算时以非零码退出（该请求的状态确实没保住），这类长任务的真正解法是 T2.1 异步化；"慢 /chat + SIGTERM"的进程级自动化测试因需要可控慢模型调用暂未实现，等 T1.1 的 telemetry 注入点就绪后补。
- 内容：server.ts 同时处理 SIGTERM/SIGINT；停止接收新请求后，在配置的 drain timeout 内等待 SessionStore write queue flush 完成再关闭 MCP。SessionStore 暴露 `async flushAll()`（等待 writeQueue 落定，并把最终写入失败向调用方抛出，而不是吞掉）。重复信号要幂等；超时后以非零状态退出并留下明确脱敏日志。
- 涉及：`src/server.ts`、`src/session-store.ts`。
- 完成标准：收到 SIGTERM/SIGINT 的正常优雅退出路径中，最后一次已接受的 `set` 要么持久化成功，要么进程以非零状态明确失败；测试不把 SIGKILL 等不可拦截退出误算为可保证场景。
- 依据：§6.1、§7.5。
- T1.5 后续替代说明（2026-07-21）：SessionStore 与异步 JSON write queue 已删除，session/request 改为同步 SQLite 事务；协作式退出现在等待在途 handler 完成后关闭 MCP 与数据库，不再执行独立 `flushAll()`。T0.4 的“先停接流量、超时非零退出、重复信号幂等”保证保持不变。
- T2.1 后续替代说明（2026-07-21）：`/chat` handler 只负责持久入队并返回 202；退出顺序扩展为停止接收 HTTP/领取新任务 → drain 已领取 worker job → 关闭 MCP/SQLite。SIGKILL 后 queued 保留，过期 running lease 明确标记 `failed/process_interrupted`，不在缺少步骤幂等证明时整单重放。

---

## 阶段 1：可观测与数据基础（评估 §9 Phase 1）

阶段目标 / 验收：能回答“某个用户请求调用了几次哪些模型、每次多少 Token、耗时多少，以及哪一次模型 operation/attempt 失败”。施工流程中“具体哪个 workflow step 失败”的持久化查询能力由 T2.2 补齐，不计入本阶段完成标准。

### [x] T1.1 模型响应 usage 穿线
- 完成于 2026-07-18。实现：①`ChatCompletionResponse` 补 `id/model/created/usage`（`ChatCompletionUsage` 原始块，缺失字段保持缺失）；②`complete()/json()` 返回 `ModelCallResult<T>`（output + model/providerRequestId/usage/finishReason，从成功响应派生）；③`onAttempt()` 全量替换为 `onAttemptFinished(result: ModelAttemptResult)`——每次真实 HTTP attempt（成功/429、5xx/网络失败/取消）独立上报 provider、requestedModel、实际 model、attemptNo、status、httpStatus、providerErrorCode（仅从错误体解析短 code，不带原始体）、providerRequestId、finishReason、usage（缺失即 undefined 绝不写 0）、startedAt、latencyMs。未留兼容层：`onAttempt` 消费方只有 agent 的 `chargeModelCall` 一处，直接迁移；4 个 complete/json 调用点以 `.output` 解包，行为不变。附带：`retryBaseDelayMs` 可配置（默认 2000 不变，测试调 1ms 走完 5 attempt 路径）。
- 验证：新增 attempt telemetry 5 用例（成功含 usage 映射、usage 缺失为 undefined、429 重试两条独立记录含 providerErrorCode、网络失败 5 条记录、取消单条不重试）；517 测试全过（原 497 不减少）、check-types 干净。T1.2 的 persistence sink 从 `modelHooks.onAttemptFinished` 处接入。
- 复审修复 2026-07-18（Codex 审阅 2 blocker + 3 suggestion）：①**预算门前置**——新增 `onAttemptStarted`（fetch 前执行，抛错即零花费中止），agent 的 `chargeModelCall` 迁回该点，恢复 pre-T1.1 的"调用前拦截"语义；`BudgetExceededError` 不再进入 fast→main→fallback 级联（withModelFallback/withFastModel 均 instanceof 直抛）。②**2xx 坏 JSON 漏记**——新增 `invalid_response` 状态：解析失败先 finished() 记录（含 httpStatus，errorSummary 不带响应体）再抛，供应商已计费的请求不再从 telemetry 消失。③usage 补 `totalTokens`/`cacheCreationTokens`（OpenRouter `total_tokens`/`cache_write_tokens`，对齐 AI_USAGE_AUDIT_DESIGN 口径）。④`ModelAttemptResult` 补 `operation`（调用点业务标签）+ `callId`（每逻辑调用唯一，primary/fast/fallback 各自独立，attemptNo 不再跨调用碰撞）；sink 契约明确为同步 fire-and-forget，`onAttemptFinished` 抛错被吞并记日志（新用例验证不影响业务结果）。⑤取消测试重写为真实 signal 接线验证（mock 挂起至 fetch 收到的 signal 触发、外部 abort）。新增 5 用例共 522 测试全过。遗留同前：抛出的 Error message 仍含原始响应体，T1.7 承接（对外开放前必须完成）。
- 三审修复 2026-07-18（Codex 2 P1 + 1 P2）：①**body 读取期取消漏记/误记**——组合 signal 保存为 `attemptSignal`，`response.json()/text()` 统一经 `readBody` 包裹：调用方取消→`cancelled`（不重试）、超时→`network_error`、其他→`invalid_response`，非 2xx 错误体读取期取消从"零事件"修为单条 cancelled；②**预算拒绝仍计数**——`chargeModelCall` 改为先查 turn/session 双上限、全过才写入 `modelCallBudgets`，被拒的请求不再让 `modelCallsTotal` 永久多 1（T1.2 对账前提）；③**operation 高基数**——`RequestHooks.operation` 独立稳定标签（extract/modify-ops/inspect/scene-agent/scene-intent/plan:intent/plan:geometry，plan tag 剥轮次），原 sessionId 参数改记为 `sessionKey`（高基数关联键，不进聚合），6 个调用点全部标注。新增 3 用例（2xx/非 2xx body 读取期取消、operation 与 sessionKey 分离）共 524 测试全过。
- 三审复核通过 2026-07-21（Codex，commit `c44ea908`）：两个 body 读取期取消复现均变为单条 `cancelled`，预算拒绝复现保持计数不变；524 tests / 0 fail，`tsc --noEmit` 与 diff check 干净，T1.1 无阻塞项，可以进入 T1.3。非阻塞约束：调用方取消与超时同时发生时以取消优先；T1.2 建表前冻结 operation 有限词表，`sessionKey` 只作供应商关联标签、不得代替 T1.3 的权威 `sessionId`，并决定是否把 `scene-agent` 进一步拆为 generate/modify/repair 统计口径。
- 内容：① `ChatCompletionResponse` 补 `usage`（input/output/reasoning/cache tokens）、`id`、`model`、`created`；② `openai-compatible.ts` 的 `complete()/json()` 返回统一 `ModelCallResult<T>`（结构见评估 §6.2 代码块）；③把仅计数的 `onAttempt()` 扩展为 attempt 生命周期事件（如 `onAttemptStarted` + `onAttemptFinished`，或一个可 begin/finalize 的 telemetry sink），每次真实 HTTP attempt——包括网络错误、429/5xx、取消和内部重试——都产生独立结果，记录 status、attemptNo、latency、HTTP/供应商错误码，成功时再补 usage/finishReason/providerRequestId。Token 未返回时必须为 `null/undefined`，不能写 0。
- 涉及：`src/types.ts`、`src/openai-compatible.ts` 及全部调用点（agent.ts、plan-builder.ts 等）。
- 完成标准：单测注入“成功、429 后重试、网络失败、取消”四种情形，telemetry sink 对每个真实 attempt 都收到一条完整且脱敏的结果；成功调用能读取真实 token/model，失败调用也有状态和耗时；当前完整测试集全过且测试数不减少。普通业务日志和 session 不作为模型调用真相源。
- 注意：调用点很多，可以先让 `ModelCallResult` 兼容旧返回（output 字段透传），但兼容层必须标注删除条件，不能长期形成两套返回契约。
- 依据：§6.2。

### [x] T1.2 `ai_model_calls` 落库
- 完成于 2026-07-21。实现：①新增共享 `src/persistence/` 基础（`AppDatabase` 连接、WAL/busy timeout、事务 helper、`schema_migrations` 幂等迁移），默认独立库 `./.data/ai.db`，可由 `AI_MCP_DATABASE_FILE` 覆盖；server/CLI/eval 共用同一 composition 方式，模型客户端不依赖 SQLite。②迁移 v1 建 `ai_model_calls`：`call_id + attempt_no` 唯一，每次真实 attempt 一行；按 `request_id`、provider/model/time 建索引，供应商 request id 条件唯一。实际模型与所有 Token 均允许 NULL（供应商未返回时不伪造成请求模型或 0），另存 `requested_model`。③`SqliteModelAttemptRecorder` 消费 T1.1 事件并注入 T1.3 权威 requestId/traceId/sessionId；无 HTTP 入口的 CLI/eval 由 agent 内部为每个 chat 铸造 requestId。operation 冻结为 `extract/modify-ops/inspect/scene-agent/scene-intent/plan:intent/plan:geometry`，未知或高基数标签拒绝落库；本轮不拆 `scene-agent`。④系统 Prompt 只保存 SHA-256 与显式 `*:v1` 版本；request params 仅保存 temperature/tool 数量与模式/response format，不保存消息、Prompt、回答、图片 Base64 或供应商原始响应。⑤写入使用同步 SQLite 原子事务，避免 fire-and-forget 窗口；启动建库/迁移失败时服务不启动，运行期单条写失败时业务 fail-open，但日志明确 `persistence=failed`，recorder 状态转 degraded 且累计 failureCount，后续成功才恢复健康，绝不误报计量成功（readiness 暴露归 T2.5）。
- 验证：新增 migration 幂等与事务回滚测试；429→成功的真实 client 重试测试按同一 requestId 查出 2 行，行数与 `onAttemptStarted` 预算计数一致，失败行 Token/实际 model 为 NULL、成功行 usage/model/provider request id 完整；另覆盖数据库写失败降级/恢复、未知 operation 拒绝和不保存 Prompt/问题原文。535 tests / 0 fail，`tsc --noEmit` 干净。
- Claude 复审通过后的收口：migration 改为拿到 `BEGIN IMMEDIATE` 写锁后再读取已应用版本，避免 server/CLI 多进程首次启动的旧快照竞争；`invalid_response.error_summary` 只保存固定文案和错误类名，不再保存可能夹带供应商响应片段的 JSON.parse message。operation 的 SQL CHECK 暂留作第二道闸；下次新增 operation/schema migration 时重新评估移除，避免为低基数词表频繁重建表。`TelemetryStatus` 的生产消费明确归入 T2.5 readiness。
- 内容：引入 SQLite（bun:sqlite，独立于场景库，如 `.data/ai.db`）。先把连接、migration、transaction helper 做成 `src/persistence/` 的共享基础，不能私有化在 telemetry 中，以便 T1.5 并行复用；再建 `ai_model_calls` 表，由 persistence/telemetry adapter 消费 T1.1 的 attempt 事件，模型客户端不直接依赖 SQLite。每次 attempt 一行，至少包含 operation、provider、实际 model、attempt_no、status、nullable tokens、latency、finish_reason、http_status、provider_error_code、provider_request_id、prompt_version、prompt_hash、非敏感 request params、session_id、request_id、started_at/completed_at；失败与取消同样落行。价格换算不做，先存原始量；不保存完整 Prompt、消息或原始供应商响应。
- 涉及：新 `src/telemetry/` + `src/persistence/`、`src/openai-compatible.ts` hook 接线。
- 完成标准：跑一个含重试的 eval case 后，能用 SQL 按服务端 `requestId` 查出全部真实 attempt，行数与 telemetry 事件和 `modelCallsTotal` 对得上；数据库故障不会被误报为“计量成功”，并有明确的请求处理/降级策略。
- 依赖：T1.1、T1.3（表在创建时就使用权威 requestId，避免先落无关联数据再迁移）。
- 参考：`docs/AI_USAGE_AUDIT_DESIGN.md` 已有更完整表设计，可直接取子集。
- 依据：§6.2、§8.1。

### [x] T1.3 traceId / requestId 全链路
- 完成于 2026-07-21。实现：①新模块 `src/request-context.ts`——`createRequestContext(headers, body)` 每次 `/chat` 铸造权威 `requestId`（uuid，body 传入的 requestId/traceId 一律忽略）；`traceId` 采纳合法的 `x-trace-id` 头（`[A-Za-z0-9-]{8,64}`），否则新铸；`clientRequestId` 仅在合法字符串（≤64）时回显。②server `/chat` 创建 context 传入 `agent.chat`，响应附 `requestId/traceId/clientRequestId`，start/ok/failed 三类日志行统一 `[req x] [trace y]` 前缀。③agent 新增 `activeRequestContexts`（session lock 持有期挂载，runChat 包裹层管理生命周期），`onAttemptFinished` 输出结构化 model-attempt 日志（req/trace/operation/callId/attemptNo/status/model/latency/tokens）——T1.2 sink 在此处可直接拿到完整上下文。④Next.js 代理 `resolveTraceId`：采纳上游合法 `x-trace-id`（未来 BFF）否则新铸，浏览器自带头不透传；请求与响应都带 `x-trace-id`，代理日志 `[ai-proxy] [trace y]`。⑤前端每次发送生成 `clientRequestId` 入 body，收到响应后 `console.debug` 记录 client→server requestId 映射。幂等语义未做（按任务定义归 T2.2）。
- 验证：`request-context.test.ts` 4 用例（伪造 body ids 被忽略且每次唯一、合法头采纳、畸形头替换、clientRequestId 合法性）；528 测试全过、pascal-ai-mcp check-types 干净（editor 侧既有13个tsc 错误与本任务无关，改动前后计数相同）。端到端冒烟（真实服务器 + 伪造 ids + 合法 trace 头）：响应 requestId 为服务端新铸、traceId=trace-e2e-12345678、clientRequestId 回显、AI 日志两行同 ids。
- 复审修复 2026-07-21（Codex 3 P1）：①**代理信任浏览器 trace 头**——`resolveTraceId` 删除，面向浏览器的代理**始终自铸** traceId，客户端 `x-trace-id` 不再转发（未来 BFF 须走认证的服务间边界，注释已明确）；AI 服务侧保留头校验（代理是本机可信层）。②**成功链路关联缺口**——AI `/chat` 响应增加 `x-request-id`/`x-trace-id` 头（CORS `Expose-Headers` 同步放行）；代理读取上游 `x-request-id` 记入日志并转发给浏览器；前端 `requestLogRef` 滚动保存最近 20 条 RequestRecord（clientRequestId→requestId/traceId/kind/status/at），成功、失败、取消都记录，`cancelGeneration` 补 clientRequestId 与响应头读取。③**失败响应丢 ids**——`/chat` catch 不再裸抛：返回 500 `{error:'internal_error', message, requestId, traceId, clientRequestId}` 且带 identity 头（完整错误码 envelope 仍归 T1.7）；代理 503 响应带 `x-trace-id` 头与 body traceId；前端在 `response.ok` 判断**之前**记录 ids。新增 `server.integration.test.ts`（真实服务器 + MCP 子进程：伪造 ids 不生效、响应头与 body 一致、二次调用 id 不复用），529 测试全过。未自动化部分如实说明：失败路径 500 的 ids 保留和代理层为代码审查验证（强制 agent 确定性抛错需 T1.2 的注入点；Next dev 未实测但前端/代理 tsc 零新增错误）。
- 闭环修复 2026-07-21（复审 blocker + 2 建议）：①**集成测试隔离**——`server.integration.test.ts` 使用临时 `AI_MCP_SESSION_FILE`（mkdtemp）、随机 sessionId、`AI_MCP_PORT=0` 由 OS 分配端口且端口从子进程自身 stdout 解析（不可能误连别的服务）、健康检查前断言子进程存活；`config.parsePort` 允许 0。真实 `.data/sessions.json` 中已无测试会话残留。②**前端 fetch 异常也留痕**——`callAgent` 在拿到响应后立即用 body/响应头记录 RequestRecord（空/非 JSON body 也记录），catch 中若尚未记录则补一条仅含 clientRequestId 的 error 记录。③**context 提前到 body 解析之前**——`createRequestContext(headers)` 先铸 ids，解析成功后经 `clientRequestIdFrom` 附加 clientRequestId；400/413（解析失败、字段校验、超限）响应现在都带 identity 头与 body ids（集成测试断言畸形 JSON 的 400 带 `x-request-id`）。529 tests / 0 fail，AI check-types 干净，editor 侧仍为 13 个既有错误无新增。T1.3 闭环，进入 T1.2。
- 413 边界补充 2026-07-21（Codex 实现、Claude 审核通过）：Bun 的传输层硬上限改为应用限制的 2 倍，使常规 Content-Length 超限进入 `readJsonBody` 并返回带 requestId/traceId 的业务 413；预检拒绝时主动取消未消费的 request body，且 cancel 失败不改变既定 413，避免连接和后续请求卡住。真实 HTTP 测试以 1 MiB 应用限制覆盖“413 身份一致 + 后续请求返回 200”。超过 2 倍硬上限的极端请求仍由 Bun 在应用代码前直接拒绝，不承诺业务 requestId。
- 内容：① 前端每次发送只生成 `clientRequestId`（用于界面关联，未来也可作为 idempotency key 的来源）；②可信 BFF 创建/透传 `traceId`，AI API 为每次业务动作创建权威 `requestId` 并返回给前端；③ AI 服务建立显式 `RequestContext`，把 requestId/traceId/sessionId 传入所有应用步骤、trace 和结构化日志，T1.2 再写入 `ai_model_calls`。幂等语义此阶段不做（T2.2），只做贯穿标识；浏览器自报的 requestId/traceId 不能覆盖服务端值。
- 涉及：`apps/editor/components/ai-assistant-bubble.tsx`、`apps/editor/app/api/ai/[...path]/route.ts`、`src/server.ts`、`src/agent.ts`、`src/types.ts`。
- 完成标准：给定 AI API 返回的 requestId，能在前端状态、代理日志、AI 日志和测试 telemetry 中检索到同一请求；伪造客户端 requestId 不会覆盖服务端主键。T1.2 完成后，同一 ID 可继续检索 `ai_model_calls`。
- 依赖：可与 T1.1 并行；T1.2 依赖本任务，不反向依赖 T1.2。
- 依据：§5.2、§9 Phase 1。
- T2.6 演进说明（2026-07-22）：保留本任务的 `requestId` 语义，不把它改造成 LangGraph thread id；T2.6 新增独立 `workflowRunId` 作为 graph `thread_id`，后续 confirm/modify 请求以新的 requestId 关联并恢复原 workflow run。

### [x] T1.4 模板 Zod schema + schemaVersion
- 完成于 2026-07-21。实现：①新增 `src/template-schema.ts` 作为唯一契约，导出严格 `TemplateRecordSchema` 与 market/quality/typology/roomProgram 枚举，同时校验房间 ID 重复、entry/connections 引用；Zod 错误格式化为 `plan.rooms[2].type` 这类精确路径。②引入 `schemaVersion: 1` 与显式 v0→v1 运行时迁移，15 份现有模板全部标记 v1；CI 的 `templates:check` 直接解析当前 Schema，不会替入库数据暗中补版本。③加载器仍逐文件隔离失败，但额外输出 files/loaded/good/bad/failed/ready 健康摘要；开发环境 warn 后可继续，生产环境遇到非法 good/未知模板或无有效 good 模板时保留 `/health` liveness，`/chat` 统一返回 503。非法 bad 参照会报告，但有效 good 库存仍在时不挡业务；完整 readiness 端点仍由 T2.5 扩展。
- 验证：Schema/加载器/CLI 回归覆盖精确错误路径、显式版本、不支持的未来版本、good/bad 生产门控差异和 CI 缺版本失败；`templates:check --no-artifacts` 通过 15 份真实模板，`tsc --noEmit` 干净，全量 542 tests / 0 fail。
- Claude 复审建议收口（2026-07-21）：① connections 交叉校验补自环与无向重复边拒绝，错误定位到具体 `plan.connections[i]`；②模板/房间/entry/connection 标识符不再通过 `.trim()` 静默归一，首尾空白直接报错；③新增 `AI_MCP_TEMPLATES_DIR`，启动健康检查与生成时 seed matcher 使用同一配置目录，并以真实 Bun server 集成测试验证 production 下坏 good 库保持 `/health` 200、`/chat` 503 且响应携带 request identity。
- 内容：① 定义并导出 `TemplateRecordSchema`（Zod），替换 `JSON.parse(...) as TemplateRecord`；② 增加 `schemaVersion` 字段与迁移函数（全部现有模板补 version 1）；③ `market/quality/typology/roomProgram` 改枚举；④启动时加载全库并输出健康摘要。生产环境遇到非法 good 模板时保持 liveness 可用但 readiness=false、拒绝业务流量；开发模式可 warn 后跳过该模板，但 CI/测试必须失败，不能让坏模板悄悄进入主分支。
- 涉及：`src/template-seed.ts`、`templates/**/*.json`、`scripts/check-templates.ts`。
- 完成标准：故意写坏一个字段，加载即报具体路径错误而不是运行时命中才炸；`templates:check` 复用同一 schema。
- 依赖：建议在 T0.2 之后（CI 已能拦住回归）。
- 依据：§6.6。

### [x] T1.5 SessionStore 迁移到 SQLite
- 完成于 2026-07-21。实现：①共享 migration v2 新建 `ai_sessions`、`ai_messages`、`ai_requests` 与 `legacy_session_imports`；session 状态、用户可见消息和请求审计各自单一真相源，`state_json` 不再嵌套 messages，主体列 `user_id/org_id/project_id` 先以 nullable 形式预留。②新增 `SessionStateRepository`、`SessionMessageRepository`、`ChatRequestRepository` 与 `SqliteSessionPersistence`；session 更新携带 `expectedVersion` 做 CAS，陈旧 writer 明确抛 `SessionVersionConflictError`，消息替换与状态版本更新在同一 immediate transaction 中提交，不保留旧同步 `get/set` adapter。③agent/server/CLI/eval 全部改走 SQLite；chat/confirm/cancel 按 T1.3 权威 requestId 记录 started→succeeded/failed，删除 session 级联删除消息但保留 request 审计。④旧 `sessions.json` 仅按 source path + SHA-256 一次性导入：重复启动不重复导入，数据库已有 session 优先，源文件永不回写；旧 `SessionStore` 实现删除。⑤当前消息路径本来只持久化图片占位文本，repository 再以事务级校验硬拒绝 inline `data:image/*;base64`；图片 artifact 引用与生命周期仍由 T1.6 实现，本任务不提前宣称完成。
- 验证：新增 5 组持久化回归，覆盖重启恢复/消息拆表、双 writer CAS 冲突、legacy 幂等导入且不覆盖 DB、删除级联与 request 保留、Base64 原子拒绝；真实 server 集成测试按 requestId 查询两条 cancel 审计并验证 session version=2、`state_json` 无 messages。全量 546 tests / 0 fail，`check-types` 干净。
- Claude 复审建议收口（2026-07-21）：①启动 sweep/getSession 遇到 stale recovery CAS 冲突时视为另一 writer 已完成恢复，记录并重载 winner，不再导致进程启动失败；T2.1 起有有效 worker lease 的 session 不参与 stale phase recovery。②`ai_requests` 成功/失败 finish 改为 fail-open 审计尾写，落库异常只记日志，不再把已成功业务改成 500 或屏蔽原始异常；请求创建仍 fail-closed。③legacy 导入对单个 session 的结构/inline Base64 错误逐项 skip，合法 sibling 仍在同次导入成功，整体解析/数据库错误继续带源路径 fail-closed。④取消动作本身成功处理时 request 记 `succeeded`；被取消的原生成任务由 T2.1 记 `cancelled`。
- 内容：把整文件 JSON 换成 SQLite：`ai_sessions`（当前状态+version，预留 nullable user_id/org_id/project_id）、`ai_messages`（用户可见消息）、`ai_requests`（每次 chat/confirm/cancel）。旧 `sessions.json` 只作一次性迁移源。图片 Base64 不入库，改存 artifact 引用。不要把同步 `get/set` 整体替换接口永久保留下来：新增 repository 接口和带 `expectedVersion` 的事务更新/CAS（如 `updateSession`），消息和请求通过各自 repository 写入，避免 session JSON 与拆表形成两个真相源；若为降低改造风险保留旧接口，只能作为有明确删除任务的临时 adapter。
- 涉及：`src/session-store.ts`（重写/过渡 adapter）、新 `src/persistence/` repository 与迁移脚本、`src/agent.ts` 调用点。
- 完成标准：重启后会话恢复行为与现在一致；并发更新中只有正确 version 能提交，冲突返回明确错误并可重试；消息/请求不再嵌套复制到 session blob；sessions.json 不再增长；迁移可重复执行且不会重复导入。
- 依赖：T1.3。与 T1.2 共用同一 SQLite/migration 基础，但两项业务实现可以并行；T1.5 不以 `ai_model_calls` 完成为前提。
- 依据：§6.1、§8.1。
- 顺带解决：既有备忘中的"sessions.json 单文件无清理策略会一直涨"。
- T2.6 状态所有权（2026-07-22）：`ai_sessions`/`ai_messages` 继续是业务会话、用户可见消息与 LayoutPlan 的唯一真相源；LangGraph checkpoint 只保存执行游标、interrupt、最小节点输出引用和对应 session version，不复制完整消息、图片、Prompt、回复或整个 WorkflowSession。若未来要迁移业务状态所有权，必须另立 migration/切换任务，不能在 T2.6 中悄悄形成第二套会话状态。

### [x] T1.6 附件引用化与基本删除语义（最小版）
- 完成于 2026-07-22。migration v9 新增 `ai_artifacts`，保存服务端 request/session 关联、私有相对 storage key、MIME、大小、SHA-256、状态、可配置过期时间和删除重试信息；请求 `input_json` 只保留 `imageArtifactId`，不再复制 MIME/大小/hash，更不保存 Base64 或公开 URL。幂等 input hash 通过 repository 查询 artifact 指纹，因此同图重复上传仍复用原 request，而 artifact id 本身不影响判等。
- 文件 adapter 统一负责 0600 原子写、读取时 size/hash 校验、终态/取消/lease 恢复/session 删除清理。删除先把 DB 行转为不可读的 `delete_pending`，文件系统失败转 `delete_failed` 并保留固定错误码，后续维护命令可重试；文件成功删除后移除 artifact 行。进程崩在“文件落盘→登记”或“登记→request 入队”的缝隙时，维护命令分别通过旧孤儿文件和超时无 request 记录收敛；终态 request 遗留也会立即成为候选。
- `bun run data:cleanup` 现在统一 dry-run 报告 checkpoint、过期/失败 artifact 与旧孤儿文件；`--execute` 才幂等删除，`--delete-incompatible` 仍只控制显式 graph-version 清理。`AI_MCP_ARTIFACT_TTL_HOURS` 默认 24。session 删除继续由 DB trigger 清 LangGraph thread、级联消息并 scrub request payload/result；随后按 session 清短期附件，失败不恢复内容可读性且由 cleanup 重试；request/模型/工具审计和场景历史保留。
- 内容：只实现当前本机/内网阶段必要的数据卫生：① `ai_artifacts` 保存私有文件引用、hash、MIME、大小和可配置过期时间，不保存 Base64/永久公开 URL；②定义基础 session 删除语义（删除消息、短期附件及关联 LangGraph workflow thread/checkpoint，去标识化用量/状态可保留，场景历史不被聊天删除连带破坏）；③提供幂等清理命令处理过期附件、过期 checkpoint 和失败删除。checkpoint state 必须采用最小引用模型，不得把 Base64、完整消息、Prompt/回复或场景快照作为绕过本任务的第二份内容存储。本任务不包含字段/信封加密、KMS、客服原文访问审计、备份级删除或法务留存周期，这些移到 TX.3。
- 与 T2.6e 的边界：T1.6 负责通用 session 删除级联、TTL/prune 执行器、失败重试和数据不可再访问的产品语义；T2.6e 负责 LangGraph 特有的 graph-version mismatch 策略、把 workflow thread 接入该通用删除器以及故障注入验证。任何会写持久 checkpoint 的 T2.6b–d 代码，在最小 checkpoint 删除与 TTL 路径就绪前只能用于无真实用户数据的测试/开发环境，不得部署到保留真实用户数据的环境。
- 涉及：`src/persistence/`、`src/server.ts` 上传入口、文件存储 adapter、删除/清理命令。
- 完成标准：上传图片只在 DB 留引用；删除 session 后当前数据目录中的消息与短期附件不可再由应用访问，去标识化用量仍可汇总；重复执行删除/清理不会报错或产生孤儿记录。
- 依赖：T1.5；可与阶段 2 并行，不阻塞 T2.1。对外生产标准由 TX.1 + TX.3 完成。
- 依据：`AI_USAGE_AUDIT_DESIGN.md` §5.7、§9。

### [x] T1.7 稳定错误码与日志脱敏
- 完成于 2026-07-22。新增 `error-policy.ts` 作为唯一公开错误策略：HTTP 错误统一返回 `error/errorCode/stage/message/requestId/traceId`（保留 `error` 仅供现有编辑器兼容，`errorCode` 为权威字段），未知异常只返回固定可公开提示；请求错误日志改为结构化的 requestId/traceId + 稳定 code/stage/type，不打印原异常对象。模型 4xx/5xx、网络失败、无效 JSON/结构化输出均改抛 `SafeServiceError`，原始供应商 body/statusText/解析片段不再进入 Error、telemetry 或客户端；供应商 code 只接受有限标识符。MCP 文本错误在进入 agent 前统一限长并脱敏，worker 终态保留模型稳定错误码。普通请求日志不再记录用户可控 sessionId。
- 验证：对抗测试覆盖 Authorization、Cookie、API key、Base64、prompt/reply/content，以及供应商 400/500 body 同时携带敏感正文；断言公开 Error、attempt telemetry、MCP 错误文本与 HTTP envelope 均不含秘密。真实 HTTP 集成测试验证 malformed JSON/413/template gate 均带稳定 errorCode、stage 和权威身份头，现有 `error` 字段仍可供旧 UI 展示。
- 内容：建立统一错误 envelope（requestId、稳定 errorCode、stage、可公开 message），供应商错误体只转成脱敏错误码/限长摘要；本阶段默认不保存原始错误体，只有 TX.3 的短期加密 artifact 能力就绪后才允许按策略留存。结构化日志统一注入 traceId/requestId，增加对 Authorization/Cookie/Base64/Prompt/回复的 redaction 测试。
- 涉及：`src/server.ts`、`src/openai-compatible.ts`、`src/agent.ts`、代理路由、日志工具。
- 完成标准：模拟供应商返回带敏感内容的 4xx/5xx，客户端和普通日志都看不到原始响应体或凭据，但能凭 requestId/errorCode 定位阶段；现有错误 UI 仍能展示可操作提示。
- 依赖：T1.3；可与 T1.5 并行。
- 依据：`AI_USAGE_AUDIT_DESIGN.md` §9.2、§13.1。

---

## 阶段 2：长任务可靠性（评估 §9 Phase 2）

阶段目标 / 验收：AI 或代理重启后请求、步骤和会话状态不丢；重复提交同一 idempotency key 不重复扣费/施工。T2.1–T2.3 已完成“状态可查与安全失败”，T2.6 进一步承担纯计算/读取节点的执行游标恢复；受 T2.4 能力限制的外部场景写入仍不得自动重放。

### [x] T2.1 /chat 改为异步任务：202 + requestId
- 完成于 2026-07-21。migration v3 把 `ai_requests` 升级为 DB 真相源的 durable queue（queued/running/succeeded/failed/cancelled、input/result、owner、lease、heartbeat、attempt）；`POST /chat` 持久入队后立即返回 202/Location，`GET /requests/:id` 查询状态和终态结果。worker 以 `BEGIN IMMEDIATE` 原子 claim，续租 heartbeat，按 session/scene 排他，cancel 优先；取消入队会在同一事务中把该 session 尚未领取的旧任务标为 `cancelled_by_user`，已领取任务走 Abort 路径，不会出现“先取消、旧生成随后又执行”。默认全局并发 1、队深 100，普通请求超限返回 429/Retry-After；取消仅在 session 或 active request 确实存在时绕过背压，无目标 cancel 返回 404，不能借最高优先级泛洪队列。queued 在重启后继续领取；过期 running 统一 `failed/process_interrupted` 且不整单重放，等 T2.2 有 workflow step 幂等语义后再扩展恢复。
- 数据边界：请求文本只在 queued/running 期间存在 `input_json`，终态清除；图片解码为私有 0600 临时文件，请求 DB payload 只存 artifact id，MIME/size/SHA-256/TTL/删除状态由 `ai_artifacts` 单一持有，worker 临时还原 data URL 后终态删除，Base64 入库有 repository 硬拒绝。结果表保存异步客户端领取所需的 reply/sessionVersion 摘要，删除 session 时 scrub input/result 并清短期附件但保留去标识化请求审计。删除有 active queue job 的 session 返回 409，避免 worker 随后重建已删除会话。
- HTTP/前端：移除 Bun 无限 request timeout 与 Next 代理全量响应缓冲 workaround；代理流式转发，编辑器以 requestId 轮询终态，原 POST 断开不影响任务。前端成功/失败/取消关联日志均保留 clientRequestId→requestId/traceId。阶段级实时进度仍归 T2.3。
- 生命周期与已知边界：过期 lease 的启动清扫不受模板门影响；生产模板门不 ready 时仅 worker 领取被禁用，既有 queued 保持不动，expired running 仍会降级。heartbeat 为 lease/3，续租丢失或异常会主动 Abort 本地执行；配置 lease 必须高于最长预期 event-loop stall。协作退出先停止领取再 drain。当前 server 是唯一常驻 writer，CLI/eval 仍走同步 direct audit 路径；worker 排他只针对 worker-owned 任务，因此 CLI 与 server 同 session 并发只靠 CAS 响亮失败，不能避免已发生的模型花费，且崩溃的 direct 行没有 lease、会永久保持 running——有多写者需求时必须让 direct 也进入 lease 协议。当前 MCP 连接面向单一 active scene，故默认并发 1；提升并发前须先完成 scene 隔离能力。无法确认是否执行过场景写入的过期 running 不会自动重试，这是安全选择而非断点续跑。
- 验证：覆盖队列深度/取消绕过、Base64 拒绝、cancel 优先、session/scene 排他、lease 过期、DB 重开与双连接仅认领一次、图片 artifact 还原/清理；真实 server 集成覆盖 202→轮询终态、重启隔离、production 模板门不领取预存 queued 任务。AI typecheck 干净，完整测试集全过且测试数不减少。
- 内容：`POST /chat` 立即创建 `ai_requests` 行（status=queued）返回 `202 {requestId}`；实际执行移入单进程 worker，但队列真相源必须是 DB，不能使用“内存队列 + 仅写状态”作为可靠方案。worker 通过 lease/locked_until/heartbeat 领取任务，启动时扫描 queued 与过期 lease；设置全局并发上限、每 session/scene 并发限制、最大队列深度和 429/503 backpressure。新增 `GET /requests/:id` 查询状态与结果。移除 `bunServer.timeout(request, 0)` 和 Next.js 代理的全量缓冲 workaround（§14-1 所指的两个补丁一并清理，LangGraph checkpointer 注释见 T2.6）。
- 涉及：`src/server.ts`、`src/agent.ts`（入口拆分）、`apps/editor/app/api/ai/[...path]/route.ts`。
- 完成标准：数分钟的生成不再依赖一条长 HTTP 连接；请求中断/代理重启后客户端凭 requestId 查到最终结果；服务在“任务已入库但尚未领取”时被 kill，重启后会继续领取；过期 running lease 不会永久变成幽灵任务；压测超过并发/队列阈值时明确拒绝而非拖垮进程。正在执行步骤的安全续跑由 T2.2 的幂等/步骤语义决定。
- 依赖：T1.3、T1.5。
- 依据：§5.2。
- T2.6 演进说明（2026-07-22）：`ai_requests` 继续是排队、认领、lease/heartbeat、取消、背压和终态的唯一真相源；LangGraph checkpointer 不取代 worker，也不得自行认领或重放请求。worker 认领 request 后启动/恢复其 `workflowRunId`，只有持有有效 lease 的 owner 可以推进 graph；lease 丢失仍先中止执行，再由新 owner 按节点恢复策略决定是否恢复。

### [x] T2.2 幂等键与 workflow_steps
- 完成于 2026-07-21。migration v4 为 `ai_requests` 增加 `idempotency_key/input_hash/idempotency_subject` 及信任主体 + session + action + scene 的条件唯一索引；`POST /chat` 接受受限格式的 `idempotencyKey`，同作用域同输入返回原 request/trace 并标注 `reused:true`，同 key 改变输入返回 409。图片哈希只包含 MIME/size/SHA-256，不把 artifact id 或 Base64 纳入幂等真相源；重复上传的新临时 artifact 会立即删除。浏览器只提供 key，不能提供 `idempotency_subject`；当前 local-only composition root 使用 `local`，仓储契约与测试已支持不同可信主体隔离，TX.1 接入认证后由服务端换成用户/组织主体。
- `workflow_steps` 按 request + stable operation + attempt 记录 running/succeeded/failed/cancelled/failed_recoverable；`GET /requests/:id` 同时返回步骤列表。当前稳定步骤为 `plan`（意图提取 + 分区 + plan validation 的同一确定性边界）、`scaffold`、`structure-openings`（执行器当前的单一写入边界）、`furniture`、`gates`、`verification`、`repair:N`、`modify`/`modify-plan`。文档不把 `intent` 或 `openings` 伪装成独立可恢复点；要进一步拆分，必须先有独立持久化输出与安全重放语义。
- 恢复语义保守收口：queued 任务重启后可继续领取；过期 running request 标记 `failed/process_interrupted`，其 running step 同时标记 `failed_recoverable`；正常终态前也会清理遗留 running step。已完成 request 始终可用原 requestId 查询，但任何无法证明幂等的场景写入都不会自动整单重放；通用断点续跑仍不在本任务承诺内。
- 验证：repository 单测覆盖同作用域重用/改入参冲突/不同 scene 隔离/不同可信主体隔离；真实 server 集成覆盖重复 key 只产生一条业务 request 与 409 冲突；workflow repository 覆盖 attempt 递增、终态、高基数 operation 拒绝，worker 覆盖 expired request + running step 联动恢复。当前完整测试集全过且测试数不减，`check-types` 干净。
- Claude 复审收口（2026-07-21）：① worker 启动与每轮扫描新增终态 request + running step 的兜底对账，即使进程崩在 request 恢复提交与 step 恢复之间，下次启动也会收敛为 `failed_recoverable`；②前端将幂等键与逻辑提交而非单次 HTTP attempt 绑定，网络/轮询结果不明时恢复原输入并复用 key，已得到明确 HTTP 拒绝或终态后才清除；③补真实双进程同 key 并发测试、reused HTTP attempt→原业务 request 关联日志和 workflow operation 有限词表。`workflowSteps.start` 保持 fail-closed 是有意设计：开始记录失败时尚未施工，不应在缺失恢复边界的情况下继续写场景；finish 失败时施工已发生，才采用 fail-open + 后续对账。
- 性能与边界收口（2026-07-21）：migration v5 为 running workflow step 增加部分索引；孤儿步骤对账改为启动强制执行、运行中至多每 60 秒执行，lease 过期清扫仍按 worker poll 频率运行。CLI/eval 的 direct request 在转终态的同一事务内先把遗留 running step 标为 `failed_recoverable`，不再依赖下次 server 启动修复；`AI_MAX_REPAIR_ROUNDS` 上限固定为 99，与 `repair:N` 有限 operation 词表一致。T2.3 尚未开始。
- 内容：① `/chat` 接受 `idempotencyKey`，按可信主体 + action/session/scene 范围建立唯一约束，同 key 重复提交返回原 request；② 建 `workflow_steps` 表，生成/修改的每个阶段（intent、plan、structure、openings、furniture、gates、repair-N）记录开始/成功/失败/取消和补偿结果；③每步有稳定 operation key，读步骤可安全重试，写步骤必须先通过 scene version/工具幂等能力证明才能重放。进程崩溃重启后，已 completed 的请求直接可查；无法证明安全的 in-flight 写步骤标记为 failed-recoverable，不能自动重放整次施工。本任务不承诺通用断点续跑。
- 涉及：`src/agent.ts`、`src/persistence/`。
- 完成标准：模拟中途 kill 进程，重启后 request/step 状态正确、无永久幽灵"进行中"；同一作用域的同 key 双击发送只创建一个 request、只扣一次模型费用；不同用户/scene 的相同 key 不互相串单。
- 依赖：T2.1。
- 依据：§5.2。
- T2.6 演进说明（2026-07-22）：本任务“不承诺通用断点续跑”的历史结论保持有效；T2.6 将 checkpoint 节点边界与现有 stable operation 对齐，并只对已有独立持久化输出、可证明安全的纯计算/读取节点开放自动恢复。`workflow_steps` 继续作为用户进度和审计投影，不由原始 checkpoint 替代；graph 事件通过 repository 更新它。任何无法证明幂等的 `structure-openings`、`furniture`、`modify` 等场景写节点仍落 `failed_recoverable`。

### [x] T2.3 前端进度事件
- 完成于 2026-07-21。采用现有 `GET /requests/:id` 的可恢复快照轮询，而非新增 SSE 长连接：响应在 request 状态和 `workflow_steps` 之外补当前持久化 `sessionPhase`，前端每 750ms 拉取一次，把 queued、plan、scaffold、structure-openings、furniture、gates、verification、repair:N、modify/modify-plan 映射为用户可读的实时阶段和逐步状态；重复 operation 只展示最新 attempt，失败/取消/可恢复失败有不同图标。最终 `session.executionSteps` 仍作为完成后的结果摘要，两者不形成第二套任务真相源。
- 断线恢复：轮询遇到网络错误、429 或 5xx 不结束任务，显示“正在重连”并以 750ms→5s 有界退避自动续查；明确 4xx 才停止。收到 202 后把当前 `requestId/traceId/clientRequestId/sessionId/kind` 写入按 session 隔离的 localStorage 引用，刷新页面后自动恢复轮询、追到终态并从服务端 session 重建消息；引用不保存问题、回答或图片。终态或明确 request 不存在时删除引用，模糊网络失败继续保留。Next 代理沿用无缓冲 GET 转发，不新增长连接与内存队列。
- 复审收口：request 状态查询只读 SQLite session 快照，不触发 stale recovery 写入；已有 queued request 也会阻止启动期 stale recovery，避免待续跑 session 被提前降级；取消请求进入同一套断线重试和刷新续查链路，但以独立 `cancelling` 状态展示，避免与主请求轮询争抢步骤进度造成界面闪烁；effect 切换时显式清理 busy/progress 状态；服务端消息重建时仅在当前页面内保留图片文件名标注，不把文件名写入 session 或 localStorage。
- 验证：真实 server 集成测试预置 running confirm request + generating session + running structure-openings step，断言 `/requests/:id` 同时返回 request 状态、`sessionPhase` 与步骤快照；编辑器组件通过 TypeScript（该文件零错误）、Biome format/lint，AI 端 `check-types` 干净。完整回归测试保持全绿。
- 内容：`GET /requests/:id/events`（SSE）或前端轮询 `GET /requests/:id`，替换现在"发出后干等 + 空响应再读 session 猜结果"的交互；phase 变化实时反映到 AI 气泡（可复用 workflow_steps 数据）。
- 涉及：`src/server.ts`、`apps/editor/components/ai-assistant-bubble.tsx`、代理路由。
- 完成标准：生成过程中 UI 按阶段更新；断网重连后状态自动追上。
- 依赖：T2.1、T2.2。
- 依据：§5.2。
- 顺带解决：既有备忘中的"运行中无进度流"。
- T2.6 演进说明（2026-07-22）：前端契约保持不变，只读取 `ai_requests + workflow_steps + sessionPhase`；checkpoint 是内部恢复实现，不能成为 UI 的第二套进度协议。将来若采用 LangGraph stream/event，也必须先投影到现有持久化契约，刷新与断线恢复不得依赖进程内事件。

### [ ] T2.4 场景写入的版本边界与失败清理
- 进展（2026-07-21，MCP 约束内安全部分已完成）：能力矩阵见 `SCENE_WRITE_SAFETY.md`。migration v6 新增 `scene_builds`，fresh build 在创建前登记 request/trace/session，拿到 sceneId 后立即记录，并持续刷新权威 version + graphHash；失败、取消及父 request 已终态的崩溃残留统一标记 abandoned，`GET /requests/:id` 返回脱敏的 sceneBuild 状态/sceneId/清理次数。`bun run scenes:cleanup -- --execute` 仅在 version 与 graphHash 同时未变化时带 `expectedVersion` 删除，场景已不存在视为幂等成功，已保存边界变化、边界缺失、CAS 冲突或 MCP 错误均保留为 cleanup_failed，绝不强删；命令默认仅 dry-run，执行前必须停正常流量并确认场景无人编辑，因为未保存的浏览器草稿不受 store version CAS 保护。
- 原场景的 plan-first 结构重建一旦开始删除节点，后续失败/取消会明确提示“可能部分修改、当前无法 checkpoint restore”，并清除 pending 操作、禁用确认式自动重试；此前“可恢复旧版本”“未保存所以原场景不变”的误导文案已移除。队列 worker 对同 session/scene 的排他继续由 `ai_requests` DB claim/lease 提供，CLI/eval 直连路径仍不在该保证内。
- **尚未完成/阻塞**：现有 MCP 没有 restore-to-version、隐藏 staging/publish-swap 或幂等 scene creation key；semantic 写入直接影响 browser-visible draft。因此不能满足“原 scene 权威恢复”或“fresh scene 构建期间未发布”的完整验收，也无法消除 MCP 创建成功与 AI DB 写入 sceneId 之间的跨库崩溃缝隙。按本任务禁令保持 `[ ]`，需先确认解除 `packages/mcp` 约束并补正式能力，禁止用 `get_scene + delete_node` 补偿冒充完成。
- 内容：①先形成 scene capability matrix：当前是否支持权威 scene version、compare-and-swap、checkpoint/restore、批量原子写、幂等 operation key；②有正式能力时，施工前记录 scene version/checkpoint，失败时回滚或标记；③能力不足时，fresh build 优先采用“新 scene 构建成功后再发布/切换”，失败 scene 作为 abandoned 记录到 DB 并由幂等清理命令处理；对原 scene 的 destructive rebuild 必须显式标为不可原子回滚并要求用户确认/禁用自动重试；④同 scene 并发请求用 DB 锁/租约取代进程内 `sessionLocks`。**禁止把 `get_scene + delete_node` 当作通用回滚方案**：它不能恢复原 ID、引用、metadata 和并发期间的第三方改动。若缺必要能力，本任务先停在设计/约束结论，再申请解除 ⚠️MCP 约束，不能用危险补偿假装完成。
- 涉及：`src/agent.ts`（rebuildScenePlanFirst、clearLevelChildren 一带）、`src/persistence/`。
- 完成标准：注入一次施工中途失败，原 scene 要么通过权威 checkpoint 回到施工前版本，要么保持未发布状态；新建半成品被持久标记并可幂等清理。系统不得把部分 delete/recreate 宣称为成功回滚，用户能看到明确状态和下一步。
- 依赖：T2.2。
- 依据：§5.2、§8.2。
- 顺带解决：既有备忘中的"生成中断的半成品场景不回滚"。
- T2.6 约束（2026-07-22）：LangGraph checkpoint 只能恢复 AI 进程内的执行状态，不能恢复或撤销 MCP 已提交的外部场景副作用，也不能填平 MCP 创建成功与 AI DB 记录之间的跨库缝隙。在“不修改 `packages/mcp`”约束下，T2.6 不会让本任务变为完成；跨越场景写入的 graph 节点必须继续使用现有 fencing/scene_builds，并在边界不明确时失败为 `failed_recoverable`，禁止根据 checkpoint 盲目重放。

### [x] T2.5 健康检查与运行生命周期
- 完成于 2026-07-22。`GET /health` 保持无认证、最小化 liveness；新增受 `AI_MCP_READINESS_TOKEN` Bearer 鉴权保护的 `GET /ready`，逐项报告 SQLite 写事务、模板库、MCP、计量 recorder 与模型配置状态。DB、模板、MCP 或最近一次计量写入异常会返回 503；模型 API key 缺失只作为 degraded 信息，不阻断 ready。readiness 不返回原始异常、主机名、凭据或 provider 响应。
- AI 侧 `PascalMcpClient` 增加连接状态、连接代次、有上限指数退避和 circuit cooldown。启动时 MCP 不可用不会拖垮 HTTP liveness；旧连接关闭或请求失败后立即退休，旧代次的迟到回调不能污染新连接。只读健康探测可在冷却后重连；失败的写工具调用绝不在新连接上自动重放，由原请求失败并交给现有 workflow/scene-build 恢复边界处理。全程未修改 `packages/mcp`。
- 队列只在 MCP ready 时领取普通工作；MCP 故障前已经接收的请求保留 queued，取消请求仍可优先领取和执行，恢复 ready 后主动唤醒 worker。产品决策（2026-07-22）：MCP 已明确不可用时，新 chat/confirm 不继续接单，快速返回 503 + `Retry-After`，由前端保留幂等键后重试；持久队列保障“已接收任务不丢失”，不用于在依赖长期不可用时无限积压新任务。关闭顺序保持“停止领取 → 停 HTTP 并等待在途请求 → drain 已领取任务（期间 lease heartbeat 继续）→ 关闭 MCP → 关闭 SQLite”；超时非零退出，遗留 running request 由既有 lease 恢复为 `process_interrupted`，不会成为永久幽灵状态。
- 验证：MCP client 单测覆盖初次重试上限、启动降级后恢复、运行中连接关闭后换代、旧回调隔离和写调用不重放；真实 server 子进程测试覆盖 MCP 子进程退出时 `/ready` 503、重新拉起后恢复 200 且 generation 增长；worker 测试覆盖依赖不可用时暂停普通任务但允许取消，以及 stopAccepting 后 drain 到持久化终态；数据库测试覆盖 readiness 写事务。完整测试与 `check-types` 全绿，`packages/mcp` diff 为空。
- 后续优化（不阻塞 T2.5）：①按观测数据决定是否给 `/chat` 的 MCP ping 增加短期健康缓存，减少正常热路径往返；②按 readiness 探测频率决定是否给 SQLite 写探测增加短 TTL，避免高频 no-op 写；③部署清单必须把 `AI_MCP_READINESS_TOKEN` 标为必配项，未配置时 `/ready` 有意始终返回 401，避免内部状态被匿名暴露。
- 内容：`/health` 拆 liveness（进程活着、响应最小化）与内部/受保护 readiness（DB 可写、模板库加载有效、MCP 可调用，并消费 T1.2 `SqliteModelAttemptRecorder.status()`：最近一次计量落库失败时 readiness=false，后续成功写恢复；模型供应商状态仅作 degraded 信息不挡 ready）；AI 侧 MCP client 增加有上限的 reconnect/circuit-breaker 与连接代次管理，旧 transport 失败后不能继续被复用，本项不要求修改 `packages/mcp` 服务端。graceful shutdown 扩展 T0.4：停止接新请求和领取新任务 → drain/续租在跑任务或标记 recoverable → flush → 关 MCP。
- 涉及：`src/server.ts`、`src/mcp.ts`（连接状态暴露）。
- 完成标准：MCP 子进程被 kill 时 readiness 变 false 且有明确脱敏错误；子进程恢复后 AI client 可在上限内重新建立连接并恢复 ready；SIGTERM 下在跑请求不产生幽灵状态。
- 依赖：T2.1、T2.2。
- 依据：§7.5。
- T2.6 演进说明（2026-07-22）：接入持久化 checkpointer 后，受保护 `/ready` 增加 checkpoint store 的最小读写探测；shutdown 在 worker drain 后关闭 checkpointer，再关闭 MCP/共享数据库。checkpoint 不健康时不得接收会产生不可恢复 graph 状态的新业务请求，liveness 仍保持最小可用。

### [x] T2.6 LangGraph 持久化工作流（决定采用方案 A）
- 决策（2026-07-22）：保留 LangGraph/StateGraph，采用持久化 checkpointer，为后续多阶段生成、人工确认、暂停恢复、分支调试和新 workflow 提供统一执行框架；不采用“仅因当前 graph 较薄而移除依赖”的方案 B。当前代码仍是“每回合携带完整 session、ingest 后只运行一个大节点”的单 super-step 路由，**在完成以下拆分前不能仅添加 `compile({checkpointer})` 并宣称完成**，否则只会复制业务状态且没有安全恢复价值。
- 状态所有权：①`ai_requests` 唯一负责请求队列、lease、取消、背压和终态；②`workflow_steps` 唯一负责稳定 operation 的进度/审计投影；③`ai_sessions`/`ai_messages` 唯一负责业务会话、用户消息与当前方案；④LangGraph checkpoint 只负责执行游标、interrupt、待执行 task、最小节点输出引用与 session version。checkpointer 不是队列、会话库或审计表，原始 checkpoint 不直接暴露给前端。
- 标识模型：新增服务端 `workflowRunId` 并作为 LangGraph `thread_id`。一个 session 可先后拥有多个 workflow run；一个 workflow run 可跨最初 chat、澄清/confirm、后续继续执行等多个 request。`ai_requests` 需要持久关联 nullable `workflow_run_id`；不在 `ai_sessions` 增加可变的“当前 workflow”字段，也不使用进程内 map 作为真相源。新 chat/modify 在非等待确认阶段创建新 workflowRunId；confirm 仅在权威 session phase 为对应 awaiting 状态时，从该 session 最新的受信 `ai_requests.workflow_run_id` 派生并恢复原 run。浏览器不能指定/劫持 workflowRunId，关联不唯一、缺失或 phase 不匹配时明确拒绝而非猜测。graph/config 另带 `checkpoint_ns`/`graph_version`，避免不同拓扑版本误读旧 checkpoint。
- 恢复边界：先把 graph 拆到与 T2.2 对齐且有独立输出的节点（至少 route/plan，以及后续可安全拆出的 validation/gates）；节点从 repository 按 sessionId/version 加载业务状态并提交结果，checkpoint 不内嵌完整 WorkflowSession。纯计算和只读节点可在崩溃后自动恢复；模型节点恢复前必须用 request/step 幂等记录防止重复扣费；任何 MCP 场景写节点在 T2.4 缺少正式幂等/restore 能力时不得自动重放，状态不明确就 `failed_recoverable`。
- 人工确认：`awaiting_confirmation` / `awaiting_modification_confirmation` 可逐步迁移为 LangGraph `interrupt()`；恢复使用同一 workflowRunId，但 confirm 本身仍是新的 requestId、经过 durable queue/lease 后才可 `Command({resume: ...})`。interrupt 成功持久化后，当前 request 正常转终态并释放 lease，workflow run 进入“合法停泊”而不是 running；既有 stale-session recovery 必须识别 awaiting phase + 可读 checkpoint，不能把它误判成崩溃残留。长期未确认的停泊 run 使用 T1.6 的 TTL/清理机制收敛，checkpoint 缺失或过期时返回稳定的不可恢复状态。cancel 终结 request/workflow 并中止 owner，是否立即删除 checkpoint 按 T1.6 的留存策略执行。
- 持久化适配器：先做小型技术验证再决定使用官方 SQLite saver 还是基于现有 `AppDatabase` 的 adapter；必须明确 migration 所有权、同库/跨库事务缝隙、Bun 兼容、多进程锁和关闭顺序，不能把另一套 SQLite 文件当成天然原子事务。当前本机阶段可用 SQLite，未来对外生产部署不得把本地 SQLite saver 写成不可替换的 application 依赖。
- 隐私与生命周期：checkpoint 只存 ID、版本、节点状态及必要的小型结构化输出；禁止保存 Base64、完整 Prompt/回复、供应商原始响应或完整 scene。必须有按 workflowRunId/session 删除、终态 TTL/批量 prune、graph version 不兼容的 fail-closed/人工处理策略；普通日志只记录 workflowRunId/checkpointId 的脱敏关联。
- 分步交付：
  - [x] T2.6a 决策与 ADR 级边界写入本清单（本次文档修订）。
  - [x] T2.6b `workflowRunId` 数据模型、graph version、持久化 checkpointer adapter 与生命周期/readiness。
  - [x] T2.6c 精简 graph state，并把 route/plan 等安全边界拆成可持久恢复节点；现有 session/request/workflow_steps 契约保持单一真相源。
  - [x] T2.6d confirmation interrupt/resume、取消和进程重启恢复；场景写入仍遵守 T2.4 的 fail-recoverable 边界。
  - [x] T2.6e 把 workflow thread 接入 T1.6 通用删除/TTL，补 graph-version mismatch 运维路径及完整故障注入测试。
- T2.6b 完成于 2026-07-22：migration v7 为 `ai_requests` 增加 nullable `workflow_run_id/graph_version`，并在同一 `AppDatabase` 中建立 checkpoint、pending writes、健康探针与过期索引；服务端按权威 session phase + 历史 request 派生 workflowRunId，澄清/确认链路复用旧 run，新工作流新建 run，phase 不匹配或缺少既有关联的 confirm 明确返回 409，浏览器不能指定该 ID。新增 `SqliteCheckpointSaver` adapter，覆盖 graph version fail-closed、LangGraph 子图 namespace、整 thread 滑动 TTL/prune、按 session 删除 checkpoint 且保留 request 审计、readiness 与 shutdown；真实最小 StateGraph 已验证跨数据库重开恢复。该阶段尚未把旧的完整 WorkflowSession graph 接入 saver，后由 T2.6c 以精简 state 替换，避免制造第二套业务真相源。
- T2.6c–e 完成于 2026-07-22：生产 graph 改为只持久化 `sessionId/sessionVersion/requestId/phase/next` 的精简状态，业务消息、方案、Prompt、回复、图片与场景仍只从既有 repository 读取；route/plan/construct 成为明确节点，稳定 operation 继续投影到 `workflow_steps`。clarification/confirmation 使用真实 `interrupt()`/`Command(resume)`，数据库重开后以同一 workflowRunId 恢复；checkpoint 缺失、session/version 不一致或 graph version 不兼容均返回稳定错误，不猜测关联。worker 对过期 lease 只在“plan 已成功、checkpoint 唯一待执行 construct、尚无非安全 step 或 scene_build”时保留 payload 并重新入队；若 session 已提交终态则只补齐 request 终态，避免重复执行；任何已进入或无法排除 MCP 场景写入的情况仍标为 `process_interrupted/failed_recoverable`，绝不依 checkpoint 重放施工。
- 生命周期与验证：session 删除通过数据库级关联删除整个 workflow thread 及 pending writes，同时保留 request 审计；`data:cleanup` 默认只报告，`--execute` 才清理过期 thread，graph-version 不兼容还需显式 `--delete-incompatible`。自动化覆盖真实 StateGraph 跨数据库重开、interrupt/resume、plan 后 construct 故障重试、checkpoint 内容不含消息原文、删除/TTL/version mismatch、缺 checkpoint 稳定失败、过期 lease 的安全 requeue/终态补齐/不安全失败。这里完成的是 T1.6 的 checkpoint 接线与最小清理入口；附件登记、失败重试等 T1.6 其余内容仍保持未完成。
- 限制保持不变：T2.6 只恢复 AI 进程内的安全执行边界，并未获得 MCP checkpoint/restore、幂等 creation key 或 publish-swap 能力，因此 T2.4 继续未完成；`structure-openings`、`furniture`、`modify` 等外部写入不自动续跑。本轮没有修改 `packages/mcp`。
- 涉及：`src/agent.ts#createWorkflowGraph`、`src/workflow-state.ts`、`src/persistence/`、`src/request-worker.ts`、`src/server.ts`、`src/config.ts`；不修改 `packages/mcp`。T3.3 应把具体 LangGraph saver/runtime 放在 adapter，application 只依赖 workflow runtime/checkpoint port。
- 完成标准：①进程在安全节点之间被 kill，重启后由原 workflowRunId 继续且不重复模型计费/步骤/施工；②确认 interrupt 跨重启可恢复，新的 confirm request 与原 workflow run 可追踪关联；③状态所有权与删除/TTL/graph-version 策略有自动化测试；④在场景写入边界 kill 时明确停为 `failed_recoverable`，不盲目重放 MCP 调用；⑤当前完整测试集全过且测试数不减少，`packages/mcp` diff 为空。
- 依赖：T2.2 已完成；T2.6b/c 可开始。涉及外部场景副作用的自动恢复依赖 T2.4 正式能力，在“不修改 MCP”期间有意不做。
- 参考：LangGraph 官方 persistence、interrupts 与 checkpointer 接口文档；具体版本 API 在实现时以锁文件版本为准，不能照搬其他版本示例。
- 依据：§5.2、§14-1。

### [x] T2.7 工具调用、场景变更与验证审计
- 内容：补齐 `ai_tool_calls`、`ai_scene_changes`、`ai_validation_results` 的最小表与写入链路。每次写工具调用记录 request/step/operation key、工具名、脱敏参数摘要、状态、错误码和耗时；场景变更记录 before/after scene version、变更类型、节点数量和大型 diff artifact 引用；validator/gates 记录被验证版本、结果、问题摘要和 repair round。普通读工具默认只记摘要，不把完整场景或工具返回塞入日志/数据库文本列。审计从 SceneGateway/工具调用 adapter 统一产生，业务工作流不各自拼 SQL。
- 涉及：`src/persistence/`、SceneGateway/工具调用 adapter、validator/gates 接线。
- 完成标准：给定 requestId，可按顺序还原“模型调用 → 工具写入 → scene version 变化 → 验证/修复”的摘要链；失败和取消同样有记录；大型场景数据仅通过 artifact 引用，审计写入失败有明确处理策略。
- 依赖：T1.5、T2.2、T2.4 的 scene version/capability 决策。
- 排序：属于阶段 2 末尾的审计完备性增强，不阻塞 T2.3 前端进度流、T2.5 生命周期治理或可靠性主线验收。
- 依据：评估 §6.1、§8.1；`AI_USAGE_AUDIT_DESIGN.md` §5.4–§5.8。
- T2.6 关联：checkpoint 用于恢复而不是审计，不能替代本任务。审计表可增加 `workflow_run_id`、graph node/step 和 checkpoint_id 作为关联字段，但稳定查询仍以 requestId/operation/scene version 为主，避免绑定 LangGraph 内部序列化格式。
- 完成于 2026-07-22：migration v8 建立 `ai_tool_calls`、`ai_scene_changes`、`ai_validation_results` 及 request/scene 查询索引；`AiOperationAuditor` 包住 agent 唯一 MCP 调用入口，统一关联 requestId、workflowRunId、workflow step、operation 与 scene。读写工具都只保存参数字段名、数组长度和对象键数量，不保存参数值、完整 scene 或工具原始响应；成功写调用额外记录变更类型、节点数量和可观测到的 before/after version，版本不可得时保持 NULL 而不猜测。completion gates 与集中 diagnostics 出口记录验证状态、数量型问题摘要和 repair round；`artifact_ref` 仅为将来外置大型 diff 预留，当前实现不把大型 diff 落入数据库。
- 审计失败策略：工具调用前的 start 记录 fail-closed，保证无法建立审计起点时不执行外部工具；工具已经返回后的 finish/scene-change 与验证摘要写入 fail-open，只记录脱敏错误类别，避免事后簿记失败反向改变已发生的业务结果。进程中断留下的 `running` 工具行表示结果未知，不自动伪造成功或重放写工具。自动化覆盖成功读写、失败、取消、版本链、验证/repair 关联、参数与响应不泄漏，以及 start/finish 两侧的失败策略。本轮未修改 `packages/mcp`。
- 已知边界：scene version 只从既有工具响应机会性捕获，不为审计额外发起 MCP 查询；进程重启或跨进程接手后的早期变更因此可能保持 NULL，直到 status/save 等响应重新建立版本基线。版本与 session→scene 的内存提示采用 1024 项有界 LRU，淘汰只降低审计完整度，不改变业务执行。验证摘要在 adapter 内再次限制为有限的计数、布尔值和安全枚举，避免未来调用方误传用户文本。

---

## 阶段 3：领域数据与模块边界（评估 §9 Phase 3）

当前 AI-only 阶段目标 / 验收：空间分类不再只依赖 session 或可变房名；删除 AI session 后，AI 服务仍可通过自己持久化的 scene/zone 语义投影完成只依赖房间分类的判断；domain 单测不需要模型/MCP/DB/React。**直接打开场景的非 AI 消费方读取正式空间语义，仍属于公共 scene schema 能力，当前不承诺。**

### [ ] T3.1 AI 侧空间语义投影（当前范围内方案）
- 内容：先在 `pascal-ai-mcp/docs/` 写并评审空间语义 ADR，再建立 AI application DB 的 `ai_scene_spaces`（名称可由 ADR 最终确定）投影。当前 `ZoneNode` 同时用于室内房间和 `Back garden` 等外部区域，不能直接把 AI `RoomType` 当成所有 Zone 的类型。ADR 至少决定：①AI 领域自己的 `SpaceUsage`/分类模型（室内、室外、交通、服务等）和 `RoomType → SpaceUsage` 显式映射；②未知/自定义用途的开放字符串兼容；③sceneId、zoneId、来源、置信度、templateId/planRoomId/planVersion/sceneVersion 的契约；④session 删除后的保留语义与旧场景一次性低置信推断策略。新生成房间在既有 `create_room` 返回 zoneId 后写入 AI DB 投影；不修改 Zone、MCP 参数或场景 metadata。旧场景只在明确的导入/inspect 路径按 room-vocab 推断一次并持久化低置信结果，正常运行不反复猜。
- 涉及：仅 `pascal-ai-mcp/src/domain/`、`src/persistence/`、`src/scene-executor.ts`、测试与本目录文档。
- 完成标准：ADR 获得确认；新生成的室内空间有稳定的 AI 侧用途记录，花园等外部 Zone 不会被误标成室内房间；用户重命名 Zone 后记录不漂移；删除 session 后非内容型语义投影仍可按 sceneId/zoneId 查询；未知用途不会导致读取整条记录失败。数据库与日志不得保存完整 Prompt、回复或场景快照。
- 依据：§6.3、§8.1。

### [ ] T3.2 AI 侧消费空间语义投影，session 降级为缓存
- 内容：`scene-executor.executeLayoutPlan` 施工时写入 T3.1 的 AI DB 投影；gates/metrics/modify 中依赖房间分类的逻辑优先按 sceneId/zoneId 读取该投影，`zoneRoomTypes` 与名字正则降级为旧场景一次性导入兜底（保留命中指标和未来删除条件）。LayoutIntent/LayoutPlan 仍由 AI application DB 持有，并通过来源引用关联；不能把用途投影误当成完整 LayoutPlan，也不能宣称非 AI Editor 已获得该语义。
- 涉及：`src/scene-executor.ts`、`src/agent.ts`（gateTargetsForSession、collectDiagnostics 一带）、`src/layout-metrics.ts`。
- 完成标准：删掉 AI session 后，AI inspect、校验、家具清单以及 modify 中仅依赖房间分类的判断结果不变；用户重命名房间不再影响类型判定。需要完整 LayoutPlan 的重建/拓扑修改必须从 AI DB 的 scene/plan 关联读取，缺失时明确降级或拒绝，不能静默假装可恢复。
- 依赖：T3.1。
- 依据：§6.3。

### [ ] T3.1-FUTURE 正式空间语义进入公共场景 ⚠️跨目录
- 当前状态：因实施范围固定为 `pascal-ai-mcp/**`，本任务只保留需求，不实施。T3.1 的 AI DB 投影不是它的替代完成品。
- 内容：在单独 ADR/分支中决定公共场景领域的空间语义能力，而不是直接复用 AI `RoomType`。正式方案需覆盖室内/室外/交通/服务、未知用途前向兼容、来源与置信度、schema version、旧场景迁移，以及创建/更新工具的一致契约。
- 涉及：`packages/core/src/schema/nodes/zone.ts`（或新的正式空间能力）、`packages/mcp`、迁移逻辑和架构文档。
- 完成标准：新场景的正式语义可被非 AI 入口读取；花园等外部 Zone 不被误标成房间；旧场景继续解析；未知新用途不会让整场景加载失败。
- 解锁条件：项目负责人明确允许修改对应 `packages/**` 目录，并按仓库架构流程单独评审。

### [ ] T3.3 agent.ts 拆分（application/domain/ports/adapters）
- 内容：按评估 §6.4 的目录结构分批拆：第一批 ports（model-client、scene-gateway、workflow-store、workflow-runtime/checkpointer）+ adapters 提取，具体 LangGraph StateGraph/saver 只存在于 adapter/composition root，application 只依赖可替换的 workflow runtime port；第二批 generate/modify/inspect 三条工作流拆成独立 application service；第三批房名/面积/动线等辅助算法沉入 domain。每批独立提交、测试全过再下一批，不做一次性大爆炸重构。
- 涉及：`src/agent.ts`（行数下降作为趋势指标，不把 `<800` 当架构验收门槛）、新 `src/domain|application|ports|adapters/`。
- 完成标准：domain 目录零依赖 HTTP/MCP/DB/LangGraph；application 只依赖 ports，不直接依赖具体 adapter；依赖边界测试纳入 `pascal-ai-mcp` 的常规 `bun test`（由既有 CI 自动执行，不修改 `.github/**`）；`bun test` 全过且 eval 抽查 2–3 个 case 结果不变。
- 依赖：建议在 T2.x 落定后做（异步化会改 agent 入口，先拆会白拆一部分）。
- 依据：§6.4。

### [ ] T3.4 面积/房型 policy 收口
- 内容：把 `areaBoundFor`、`TYPE_TO_KIND`、房型分类、窗/动线/最小门边、必需空间、DK/LDK 市场规则从 `plan-validator.ts` 等处抽到 `domain/policy/`（或并入 norms/），validator、strategy、modify-ops、template matcher 统一从 policy 导入，消除"策略层反向依赖校验器"。
- 涉及：`src/plan-validator.ts`、`src/strategy.ts`、`src/modify-ops.ts`、`src/norms/`。
- 完成标准：`grep "from './plan-validator'" src/strategy.ts src/modify-ops.ts` 为空；行为零变化（现有单测全过）。
- 依赖：可独立做，也可作为 T3.3 第三批的一部分。
- 依据：§7.2。

### [ ] T3.5 core 纯边界决策与执行 ⚠️SCHEMA
- 当前状态：⚠️跨目录，冻结期间不实施、不修改仓库级 ADR/CI；保留为未来独立项目。
- 内容：先决策（评估 §7.1 方案 A：core 提纯 / 方案 B：新增纯 `@pascal-app/scene-model`），同时处理当前架构文档与代码中对 Three/R3F/NodeDefinition 所有权的矛盾，把决策和理由记录到 `wiki/architecture/`；执行前列出 `@pascal-app/*` 公共 API、registry/plugin authoring、npm 消费方和 private-editor submodule 的兼容/semver 影响。然后分阶段迁移并加 dependency boundary 检查（lint rule 或测试：core 禁 import three/R3F —— 若选 A）。这是 editor 仓库层面的大改动，单独开分支/PR，与 AI 侧任务解耦，并使用 `review-architecture` 流程审阅。
- 涉及：`packages/core/**`、`wiki/architecture/`、`AGENTS.md`、CI。
- 完成标准：文档与代码一致；边界检查进 CI 会拦截违规 import；公共包和插件迁移有明确兼容策略/major version 决策，不能只让仓库内构建通过。
- 依据：§7.1、§7.4。

### [ ] T3.6 反向代理去数据库直读
- 当前状态：⚠️跨目录，冻结期间不实施；不能从 AI 目录修改 proxy/Editor API 来绕开。
- 内容：`/proxy/scenes` 的项目列表改为调用 Editor/Scene API 而非直接 `SELECT ... FROM scenes`；封面与展示元数据保留在 proxy.db（它是这些数据的正当主人）；`Program.cs`（825 行）拆 routes/auth/catalog/cover/db/proxy-config 模块。
- 涉及：`pascal-reverse-proxy/Program.cs`、可能需要 Editor 暴露场景列表 API（确认 `apps/editor` 是否已有）。
- 完成标准：SceneStore 表结构变化不再可能悄悄弄坏代理；代理进程不再打开 pascal.db。
- 依据：§6.7。

### [ ] T3.7 防护栏前移
- 内容：在 requirement extraction 之前加低成本 scope 判定：确定性规则只拦截高置信、明确越界内容；不确定时 fail-open 到 fast model 或 extraction，避免关键词 allowlist 误伤自然语言。带户型图片/DXF 的请求默认视为有建筑上下文，除非有明确安全原因。被拦截请求写独立 `ai_guardrail_events`（reason_code、policy_version、decision、latency），并关联 ai_requests；现有 extraction 内的 `relevant:false` 保留为第二道。若 fast model 参与分类，它的调用照常进入 ai_model_calls，不能宣称模型用量为 0。
- 涉及：`src/agent.ts`（ingest 前）、`src/lang/`。
- 完成标准："今天天气怎么样"被确定性规则拦截且 `ai_model_calls` 里该请求零调用；中文/日文/英文正常户型语料和带图短文本的回归集无明显误拦截；所有决策有稳定 reason_code/policy_version 可统计。
- 依赖：T1.2（验证零调用需要计量在位）。
- 依据：§7.3。

---

## 阶段 4：真正的 template-first 与质量闭环（评估 §9 Phase 4）

### [ ] T4.1 模板候选前置到模型 Intent 之前
- 内容：按评估 §6.5 流程图改造 `plan-builder`：确认 brief 后先用确定性事实（roomProgram、面积、market、kitchenPreference——`briefFactsFor` 已有）构造模板查询；唯一高置信命中 → 直接 adapt+validate 零模型调用；多候选/缺字段 → 才调用模型补 Intent 再 rerank；无模板 → partitioner。现有 `findTemplateSeed` 的匹配规则可复用为查询谓词。
- 涉及：`src/plan-builder.ts`、`src/template-seed.ts`、`src/agent.ts`（generate 入口）。
- 完成标准：标准房型（如"2LDK 55㎡"）在模板命中时 `ai_model_calls` 为 0 次 Intent 调用；eval 全量回归通过。
- 依赖：T1.2（用计量数据验证）；建议 T1.4 之后（schema 稳定）。
- 依据：§6.5。

### [ ] T4.2 模板可伸缩表达
- 内容：模板从"整图等比缩放"升级为"拓扑 + 比例约束 + 可伸缩区域"，命中后由 solver 局部调整而非缩放失败即全回退。设计文档必须区分面积比例窗口与线性缩放比例（例如面积 0.8–1.25 对应边长约 0.894–1.118，不等同于面积 ±10%），并定义共享墙、门窗宿主、最小尺寸和非矩形 footprint 的约束。这是算法项，先写设计文档和固定 fixtures 再动码。
- 涉及：`src/template-seed.ts`、`templates/` schema（schemaVersion+1）、新设计文档。
- 完成标准：在明确的面积段 fixture 中，同一模板服务范围较基线显著扩大；fatal=0 比例、soft warning 分布、几何一致性和人工修改量均不劣于基线。不要用含义不明确的“validator 满分率”作为唯一指标。
- 依赖：T1.4、T4.1。
- 依据：§6.5、§14-5。

### [ ] T4.3a 模板命中与拒因闭环
- 内容：落库记录每次生成的 template direct hit / after enrichment / partitioner fallback、候选集合与模板拒绝原因（seedTrace 已有，落库即可），形成 §11 指标中不依赖前端事件的最小集。
- 涉及：`src/persistence/`、`src/template-seed.ts` trace 接线。
- 完成标准：能用 SQL 回答"哪个模板命中率最高、哪个最常被拒、拒因分布"，且统计可按 roomProgram/面积段/market 分组。
- 依赖：T1.2、T4.1。
- 依据：§9 Phase 4、§11。

### [ ] T4.3b 生成后人工修改量闭环
- 当前状态：⚠️跨目录。当前可在 `pascal-ai-mcp/docs/` 定义事件草案，但不能修改 Editor/BFF 采集端，也不能把仅靠 AI 请求日志的近似统计宣称为人工修改量闭环。
- 内容：定义“AI 完成后人工结构修改”的稳定事件契约与观察窗口，记录 scene/version、AI request/template、修改类型和匿名/可信主体；不要仅用固定“5 分钟内”且不区分撤销、自动修复与用户编辑。前端事件采集必须有项目/场景授权，服务端校验关联关系。
- 涉及：Editor 事件出口、BFF/AI telemetry、`src/persistence/`。
- 完成标准：能比较各模板生成后的人均结构修改量、撤销率和主要修改类型；同一修改不会因重连重复计数。
- 依赖：T4.3a、TX.1（或先完成匿名但不可跨用户归因的受限版本）。
- 依据：§9 Phase 4、§11。

### [ ] T4.4 eval 分层：PR gate + nightly
- 内容：当前范围内先完成 `eval/` 的 deterministic/真实供应商命令分层、固定报告格式和本地回归；修改 `.github/**` 接入 PR gate/nightly 属于 ⚠️跨目录，冻结期间不实施。
- 涉及：当前仅 `pascal-ai-mcp/eval/`、`package.json` 和本目录文档；workflow 接入待解锁。
- 完成标准：本地 deterministic 命令零 token 且能拦住规划/模板回归；真实供应商命令显式 opt-in 并输出可比较报告。PR 自动 gate 与 nightly 调度在解除 `.github/**` 约束前不计入当前完成标准。
- 依赖：T0.1。
- 依据：§7.4。

---

## 独立轨道：对外开放前置（P0，何时做取决于对外计划）

当前部署是本机/内网（T0.3 收口后风险可控），以下任务在**任何形式对外暴露之前**必须完成，不阻塞阶段 1–4：

当前 AI-only 边界无法完整实现认证 BFF、Editor 授权事件或正式 KMS/对象存储接入，因此 TX.1/TX.3 只能先做 `pascal-ai-mcp/**` 内的接口与数据模型设计；**在解除跨目录约束并完成这些任务前，部署姿态必须保持本机/受信内网，不能对外开放。**

### [ ] TX.1 身份与授权贯通
- 内容：按评估 §5.1 建议 1–4：浏览器只走认证 BFF；AI 服务绑内网 + 服务间鉴权；session/request/scene 操作绑定 userId/orgId；读取删除 session 校验所有权。前置决策：反向代理走 edge-proxy 还是正式 BFF（关联 T3.6，评估 §6.7 的二选一）。
- 依赖：T1.5 只需预留 nullable `user_id/org_id/project_id` 和正常 migration 能力，完整身份/BFF 归属决策不阻塞建表与阶段 2；本任务的完整实现依赖 T1.5、T2.1，并在任何对外暴露前作为硬门槛完成。

### [ ] TX.2 用户级额度与费用护栏
- 内容：基于 `ai_model_calls` 实现每用户/组织/session 的请求数、并发、token、费用额度与预警；价格表带生效时间和 price_version，历史调用按调用时价格结算；长任务采用额度预占 + 实际 usage 结算/释放，供应商未返回 usage 时进入待核对状态。替换现在"模型 HTTP 尝试次数上限"这一伪限流，但保留它作为单请求熔断上限。
- 依赖：TX.1、T1.2。

### [ ] TX.3 生产级内容隐私与留存治理
- 内容：在 T1.6 最小数据卫生之上补齐对外 SaaS 能力：消息、checkpoint 中不可避免的敏感小型状态和敏感工具参数使用字段/信封加密，密钥进入正式 KMS/轮换流程；附件使用服务端加密和短期签名 URL；查看原文需要权限、理由和访问审计；删除覆盖 checkpoint/checkpoint writes、缓存、索引、对象存储和备份策略；正式留存周期由产品/法务按目标市场与合同确认并版本化。
- 涉及：`src/persistence/`、artifact storage adapter、BFF/权限层、运维与隐私文档。
- 完成标准：越权主体无法读取其他用户内容；密钥轮换与删除任务可测试、失败可重试并告警；普通日志/APM/Sentry 不含敏感原文；留存策略有负责人和版本记录。
- 依赖：TX.1、T1.6。任何形式对外开放前必须完成，不阻塞当前本机/内网可靠性主线。
- 依据：`AI_USAGE_AUDIT_DESIGN.md` §9。

---

## 建议的执行顺序（主线起步）

评估 §13 的主线，落到任务号：

```text
T0.1 → T0.2 → T0.3 → T0.4   （一周内可全部完成的小任务）
→ T1.1 → T1.3                （先定义调用事件和权威 ID）
          ├→ T1.2            （模型调用计量，共享 persistence 基础）
          └→ T1.5            （session/request 持久化，可与 T1.2 并行）
T0.2 ──────→ T1.4            （模板 schema，可并行）
T1.5 → T2.1 → T2.2 → T2.3 → T2.5
                 └────────→ T2.6a（已决策 A）→ T2.6b → T2.6c → T2.6d → T2.6e
```

T2.6a 只依赖 T2.2；图中 T2.3/T2.5 先完成是当前实施顺序便利，不是技术阻塞关系。T1.6、T1.7 可在 T1.5/T1.3 后并行；T1.6 的删除/TTL 实现必须覆盖 T2.6 checkpoint，且写 checkpoint 的能力不得早于最小删除/TTL 一起进入真实数据环境。T2.7 排在 T2.6 之后做关联审计补全，不阻塞 T2.3/T2.5。当前下一段可执行主线是 `T1.6 → T1.7 → T3.4/T3.7 → T3.1/T3.2（AI 侧投影）→ T3.3 → T4.1 → T4.2 → T4.3a → T4.4 本地部分`。T2.4、T3.1-FUTURE、T3.5、T3.6、T4.3b、T4.4 workflow 接入及 TX 跨目录部分保持阻塞；不得为追求勾选而越过 `pascal-ai-mcp/**`。

## 变更记录

- 2026-07-17：初版，依据 ARCHITECTURE_ASSESSMENT.md（含复核）拆分。
- 2026-07-17：Codex 复核修订：纠正 requestId 归属与 T1.2/T1.3 依赖；补齐失败 attempt 计量、隐私留存、错误脱敏、持久队列租约/容量保护；移除危险的 delete-node 回滚建议；把空间语义改为 ADR 先行；拆分模板命中与人工修改量闭环。
- 2026-07-17：Claude/Codex 交叉复核修订：收窄阶段 1 验收到模型 operation/attempt；T1.6 降为本地最小数据卫生，生产隐私治理移至 TX.3；解除 T1.5 对 T1.2 和身份架构的隐性阻塞；明确 T2.7 不挡可靠性与进度主线。
- 2026-07-22：T2.6 选择方案 A（保留 LangGraph 并接入持久化工作流），拆为状态所有权/标识、checkpointer、节点拆分、interrupt 恢复和留存五段；补充 T1.3/T1.5/T1.6、T2.1–T2.5/T2.7、T3.3/TX.3 的演进关系，并明确不修改 `packages/mcp` 时场景写入不可自动重放。
- 2026-07-22：依据交叉审核收口 T2.6a：T1.6 拥有通用删除/TTL、T2.6e 拥有 graph 接线/version mismatch/故障验证；明确 checkpoint 写入与删除能力的部署时序、session→workflowRunId 从权威 phase + `ai_requests` 派生，以及 interrupt 无 lease 停泊的 stale/TTL 语义。
- 2026-07-22：完成 T2.6b–e：精简持久 graph state、route/plan/construct 节点、跨重启 interrupt/resume、仅安全 plan 边界自动 requeue、终态补齐、checkpoint 删除/TTL/version mismatch 运维与故障注入；外部场景写入继续 fail-recoverable，`packages/mcp` 保持零改动。
- 2026-07-22：后续实施范围收紧为 `pascal-ai-mcp/**`。T3.1/T3.2 改为诚实的 AI DB 空间语义投影；正式公共 scene schema/MCP 能力保留为 T3.1-FUTURE 并阻塞。同步标记 core、proxy、Editor 事件、GitHub workflow 和对外 BFF/KMS 等跨目录任务，禁止用旁路实现冒充完成。
