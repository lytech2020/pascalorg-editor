# Pascal AI 内部测试追踪矩阵

## 1. 原则

本矩阵区分“系统已自动记录”“需要测试人员人工记录”和“当前明确不记录”。AI 请求审计只能证明 AI 服务、模型、MCP 工具和持久工作流发生过什么，不能反向推断用户在 Editor 中进行了哪些手工操作。

排障以服务端权威 ID 为关联键：

- requestId：一次 chat、confirm 或 cancel 请求；
- traceId：代理与 AI 服务日志关联；
- sessionId：一段 AI 会话；
- workflowRunId：可跨澄清/确认请求的持久工作流；
- sceneId：持久场景；
- clientRequestId：浏览器本次提交的界面关联值，不是服务端主键。

## 2. 自动记录

| 数据 | 真相源 | 保留范围 | 查询方式 | 能证明什么 |
|---|---|---|---|---|
| 请求状态、action、scene/session 关联、幂等、lease、终态、稳定错误码 | `ai_requests` | 活跃 payload 在终态清除；去标识化请求审计保留 | 浏览器进度区、`GET /requests/:id`；维护者必要时按 requestId 查库 | 请求是否接收、排队、执行、取消或失败 |
| Session phase、当前方案和版本 | `ai_sessions` | 删除 Session 时删除业务态 | `GET /sessions/:id` | AI 会话当前业务状态 |
| 用户可见的 AI 会话消息 | `ai_messages` | 删除 Session 时级联删除 | `GET /sessions/:id` | AI 面板消息；不含 Editor 手工操作 |
| 稳定步骤、attempt、修改模式和 disposition | `workflow_steps` | 请求审计保留 | `GET /requests/:id` | 请求在哪个 workflow step 失败或中断 |
| LangGraph 执行游标、interrupt、graph version | checkpoint 表 | 默认 TTL 30 天；Session 删除或明确 cleanup 清理 | `/ready` 健康摘要；不直接暴露原始 checkpoint | AI 进程内可恢复节点，不证明 MCP 写入可回滚 |
| 模型 attempt、provider/model、Token、耗时、Prompt version/hash、失败码 | `ai_model_calls` | 去标识化审计保留；当前未批准自动删除 | 维护者按 requestId 提取脱敏摘要 | 模型是否调用、重试、取消、耗时和 Token；不保存 Prompt/回答正文 |
| MCP 工具名、参数形状、状态、耗时 | `ai_tool_calls` | 去标识化审计保留 | 按 requestId/step 查询脱敏摘要 | 哪个工具被调用；不保存参数值和原始响应 |
| 可观测场景版本变化 | `ai_scene_changes` | 去标识化审计保留 | 按 requestId/sceneId 查询 | AI 工具调用前后可观测的 scene version；NULL 表示不可观测 |
| validator、状态、计数和稳定 failure kind | `ai_validation_results` | 去标识化审计保留 | 按 requestId 顺序查询 | 验证通过、失败或 unavailable；不保存完整场景 |
| fresh build、边界、abandoned/cleanup 状态 | `scene_builds` | 构建审计保留 | `GET /requests/:id` 的 sceneBuild 摘要 | 新建场景是否完成、废弃或等待安全清理 |
| 私有附件引用、hash、大小、删除状态 | `ai_artifacts` + 私有目录 | 正常终态删除；崩溃残留默认 TTL 24 小时 | `data:cleanup` dry-run | 附件生命周期；不保存 Base64 或公开 URL |
| scope guardrail 决策 | `ai_guardrail_events` | 去标识化审计保留 | 按 requestId 查 policy version、decision、reason | 是否在模型调用前被拦截；不保存问题原文 |
| 模板命中、候选与稳定拒绝原因 | `ai_template_decisions`、`ai_template_candidates`、`ai_template_rejections` | 去标识化审计保留 | 按 requestId 查询 | 是否命中模板及拒绝类别；不保存用户原文 |
| readiness、队列、lease、失败率和磁盘状态 | `/ready`、`ops:check`、`storage:check`、stdout | 日志最长 14 天；数据库指标按真相源保留 | 运维命令和结构化日志 | 部署依赖、积压与容量状态 |
| 刷新续查引用 | 浏览器 ActiveRequestReference | 终态或明确不存在时删除 | 页面自动恢复；不作为服务端真相源 | 只保存 IDs，不保存问题、回答或图片 |

## 3. 人工记录

| 行为或证据 | 为什么需要人工记录 | 记录位置 |
|---|---|---|
| Editor 中手工移动墙、门窗或家具 | 当前冻结范围不采集 Editor 操作事件 | 问题单的“AI 后人工操作”时间线 |
| Editor undo/redo | AI 服务看不到撤销栈 | 问题单步骤、必要的脱敏录屏 |
| AI 完成后人工修改的节点和幅度 | scene version 不能证明操作者和意图 | 修改前后截图、场景 review、人工节点清单 |
| 关闭面板、切换场景、刷新页面 | 纯前端行为没有服务端事件 | 带时间的复现步骤 |
| 浏览器错误、按钮状态、进度闪烁 | AI 日志不能证明 UI 渲染 | 截图、控制台脱敏错误、浏览器版本 |
| Provider 输出质量与视觉合理性 | 几何正确不等于设计质量 | 版本化 eval review 和人工评分 |
| 无 requestId 的启动/代理故障 | 请求尚未到达 AI 服务 | 时间、commit、访问地址、HTTP 状态 |

人工记录不得覆盖服务端权威终态。若人工观察与审计冲突，问题保持未解释状态并升级排查。

## 4. 明确不记录

当前普通日志、审计数据库和问题单禁止收集：

- API Key、readiness token、Cookie、Authorization header；
- 完整 Prompt、模型原始响应或供应商错误体；
- 用户私密原文、完整会话导出；
- 图片 Base64、原始户型图片或永久公开附件 URL；
- 完整私有场景 JSON；
- 没有排障必要性的个人身份信息；
- Editor 键盘、鼠标、停留时长等通用行为分析；
- 根据 AI 请求日志推测出的手工编辑、undo/redo 或用户意图。

未来若采集 Editor 行为，必须作为跨目录任务单独设计事件契约、告知、权限和保留策略；不得在 `pascal-ai-mcp` 中用场景差异冒充用户行为追踪。

## 5. 删除与保留边界

- Session 删除会删除业务会话、消息、关联 checkpoint 和短期附件，并 scrub 请求 payload/result；
- request、workflow step、模型/工具/验证和场景变更等去标识化审计当前保留；
- artifact/checkpoint 按既有 TTL 与显式 cleanup 处理；
- stdout/stderr 按 `LOG_AND_STORAGE_POLICY.md` 轮转；
- 审计表尚无批准的自动删除周期，只监控增长；
- 对外 SaaS 的加密、KMS、备份级删除和法务留存仍属于未来 TX.3。

## 6. 测试人员最小取证

测试人员无需读数据库。出现问题时优先保留：

1. 页面显示的 requestId、sessionId、sceneId；
2. commit 和发生时间（含时区）；
3. 从空闲状态开始的最短复现步骤；
4. 预期与实际结果；
5. 是否做过手工编辑、undo/redo、刷新或切换场景；
6. 已脱敏截图。

维护者再凭这些 ID 关联服务端审计。
