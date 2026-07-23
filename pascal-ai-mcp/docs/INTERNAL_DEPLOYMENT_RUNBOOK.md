# Pascal AI 内部部署 Runbook

## 1. 适用范围

本 Runbook 用于本机或可信内网的三层 Pascal 内部测试环境：

| 层 | 默认地址 | 职责 |
|---|---|---|
| Editor | `http://127.0.0.1:3002` | Next.js 编辑器、场景 API 与 SSE |
| AI service | `http://127.0.0.1:8788` | AI 请求队列、LangGraph workflow、审计与 MCP 子进程 |
| Reverse proxy | `http://127.0.0.1:8000` | 浏览器入口、首页与 Editor 反向代理 |

浏览器只访问反向代理。AI service 没有用户身份认证，必须保持 loopback 监听；Editor 的 3002 端口也不应直接暴露到不可信网络。身份与授权完成前不得公网部署。

本 Runbook 只使用现有命令、端口和健康端点，不要求修改 `apps/**`、`packages/**`、`pascal-reverse-proxy/**` 或 MCP 契约。

## 2. 前置条件

- Bun 1.3 或更高版本；
- .NET SDK 10；
- Git；
- 运行三个进程的专用系统用户；
- 可持久化且可备份的数据目录；
- 能访问所选模型供应商的网络；
- 内部防火墙只允许预定测试人员访问 8000，阻止外部访问 3002 和 8788。

首次执行：

```bash
cd /absolute/path/to/pascalorg-editor
bun --version
dotnet --version
bun install
dotnet restore pascal-reverse-proxy/pascal-reverse-proxy.csproj
```

部署或升级时应使用锁文件中的依赖，不在启动阶段临时升级依赖。

## 3. 数据目录与权限

建议把源码与数据分开。以下只是路径示例，部署时替换成实际绝对路径：

```text
/var/lib/pascal/
  scenes/
    pascal.db
  ai/
    ai.db
    request-artifacts/
  proxy/
    proxy.db
    covers/
```

创建目录并限制为服务用户可读写：

```bash
install -d -m 700 /var/lib/pascal/scenes
install -d -m 700 /var/lib/pascal/ai/request-artifacts
install -d -m 700 /var/lib/pascal/proxy
```

必须保证 Editor、AI 启动的 MCP 子进程和反向代理读取的是同一个场景库。推荐统一设置 `PASCAL_DATA_DIR=/var/lib/pascal/scenes`，不要让各进程各自落入默认数据目录。

AI 业务数据库和 checkpoint 共用 `AI_MCP_DATABASE_FILE`。请求图片文件位于 `AI_MCP_REQUEST_ARTIFACTS_DIR`。反向代理自身的项目覆盖信息位于 `PASCAL_PROXY_DB_PATH`，其同目录 `covers/` 也属于需要备份的数据。

## 4. 环境配置

Editor 与 AI service 会读取仓库根目录 `.env.local`。反向代理的数据库路径解析也会从该文件读取 `PASCAL_DATA_DIR` 和 `PASCAL_PROXY_DB_PATH`；其他代理配置应由 .NET 部署配置或进程环境提供。机密也可以全部由进程管理器直接注入；不要提交 `.env.local`。

内部部署至少明确配置：

```env
# Editor -> AI
AI_AGENT_URL=http://127.0.0.1:8788

# Shared Pascal scene storage
PASCAL_DATA_DIR=/var/lib/pascal/scenes

# AI persistence
AI_MCP_HOST=127.0.0.1
AI_MCP_PORT=8788
AI_MCP_DATABASE_FILE=/var/lib/pascal/ai/ai.db
AI_MCP_REQUEST_ARTIFACTS_DIR=/var/lib/pascal/ai/request-artifacts
AI_MCP_READINESS_TOKEN=replace-with-a-long-random-secret
PASCAL_MCP_MODE=stdio

# Bundled reference templates currently target the JP profile
PASCAL_NORM_PROFILE=jp

# Reverse proxy persistence
PASCAL_PROXY_DB_PATH=/var/lib/pascal/proxy/proxy.db
```

再配置一种模型供应商。

Azure OpenAI：

```env
AI_PROVIDER=azure-openai
AZURE_OPENAI_ENDPOINT=https://your-resource.cognitiveservices.azure.com
AZURE_OPENAI_API_KEY=replace-me
AZURE_OPENAI_DEPLOYMENT=replace-me
AZURE_OPENAI_API_VERSION=2024-10-21
```

OpenRouter：

```env
OPENROUTER_API_KEY=replace-me
OPENROUTER_MODEL=replace-with-a-tool-capable-model
```

`AI_MCP_READINESS_TOKEN` 是部署必填项。未配置时 `/ready` 有意始终返回 401，不能作为就绪探针。不要在日志、问题单或截图中公开模型 Key、readiness token 或代理 Key。

若反向代理能被多名内网测试者访问，应使用其现有配置能力开启 `ProxyAuth`，并通过 `ProxyAuth__Enabled=true`、`ProxyAuth__ApiKey=...` 等进程环境或部署配置提供非默认 Key。该简单 Key 只适合可信内网，不能替代公网身份系统。

## 5. 发布前检查

记录将要运行的版本：

```bash
cd /absolute/path/to/pascalorg-editor
git status --short
git rev-parse HEAD
```

正式内部部署应使用已审核、无未提交改动的 commit。确认端口没有旧进程：

```bash
lsof -nP -iTCP:3002 -iTCP:8788 -iTCP:8000 -sTCP:LISTEN
```

首次部署或 Editor 代码变化后构建：

```bash
bun run build --filter=editor
```

不要同时运行根 `bun dev` 和下面的三层命令；它们会争用 3002 和 8788。

启动部署版本前运行无费用发布 Gate：

```bash
cd pascal-ai-mcp
bun run release:check
```

默认 Gate 包含类型检查、串行全量测试、无产物模板体检和 deterministic eval，并记录 commit、数据库 schema、Prompt 与模板版本。Provider 抽查需要负责人确认后显式启用，见 `docs/RELEASE_GATE.md`。

## 6. 启动顺序

### 6.1 Editor

从仓库根目录构建后：

```bash
cd apps/editor
bun run start
```

开发调试可以从仓库根目录使用现有命令：

```bash
bun run dev --filter=editor
```

### 6.2 AI service 与 MCP 子进程

```bash
cd pascal-ai-mcp
bun run start
```

默认 `stdio` 模式会自动启动 Pascal MCP，不要再启动第二个 MCP 进程。启动日志应显示 AI 监听地址、SQLite 配置摘要和 MCP stdio 已启动。

### 6.3 Reverse proxy

```bash
cd /absolute/path/to/pascalorg-editor
dotnet run --project pascal-reverse-proxy --no-restore
```

反向代理最后启动，避免在下游尚未就绪时接收测试流量。

## 7. 探活与就绪检查

只使用现有端点或端口，不为部署验收新增接口：

```bash
curl -fsSI http://127.0.0.1:3002/
curl -fsS http://127.0.0.1:8788/health
curl -fsS \
  -H "Authorization: Bearer ${AI_MCP_READINESS_TOKEN:?missing}" \
  http://127.0.0.1:8788/ready
curl -fsS http://127.0.0.1:8000/proxy/health
```

预期：

- Editor 返回 HTTP 200；
- AI `/health` 返回 `{"ok":true}`；
- AI `/ready` 返回 HTTP 200 且 `ready=true`；
- Proxy 返回 `status=ok`。

随后运行主动检查：

```bash
cd pascal-ai-mcp
bun run ops:check
```

退出码 0 才允许开始测试。退出码 1 表示 warning，2 表示 critical；详细 reason code 和阈值见 `docs/OPERATIONS.md`。

最后通过 `http://127.0.0.1:8000/` 打开一个测试场景，确认 Editor 能读取场景、SSE 能更新，并进行一次无费用的健康检查。真实模型 Case 留给带明确费用确认的验收步骤。

## 8. 正常停止

1. 先停止反向代理，阻断新的浏览器流量；
2. 向 AI service 发送 SIGTERM/SIGINT（交互终端使用 `Ctrl+C`）；
3. 等待 AI 停止领取新任务并完成 drain；
4. AI 完全退出后停止 Editor；
5. 确认 3002、8788、8000 均无监听进程；
6. 需要备份或升级时，再复制数据文件。

```bash
lsof -nP -iTCP:3002 -iTCP:8788 -iTCP:8000 -sTCP:LISTEN
```

AI 默认只等待 `AI_MCP_DRAIN_TIMEOUT_MS=5000`。若日志报告 drain timeout 或进程非零退出，说明可能仍有请求需要在下次启动时恢复或标记 `failed_recoverable`。不得因为停机超时而手工把请求改成成功，也不得自动重放场景写工具。

禁止直接 `kill -9` 作为正常停止方式。只有进程无法响应且已记录事故信息时才强制终止。

## 9. 备份

只在三层进程及其 MCP 子进程全部停止后备份。不要只复制仍在 WAL 写入中的单个 `.db` 文件。

每次备份至少包含：

- `PASCAL_DATA_DIR`：场景数据库；
- `AI_MCP_DATABASE_FILE`：请求、Session、消息、Token、审计和 checkpoint；
- `AI_MCP_REQUEST_ARTIFACTS_DIR`：尚未清理的私有请求附件；
- `PASCAL_PROXY_DB_PATH` 及同目录 `covers/`；
- 当前 commit；
- 实际环境变量名和非机密配置摘要，不包含任何 Secret 值。

示例：

```bash
export BACKUP_ROOT=/var/backups/pascal
export BACKUP_ID="$(date +%Y%m%d-%H%M%S)"
install -d -m 700 "$BACKUP_ROOT/$BACKUP_ID"

cp -a /var/lib/pascal/scenes "$BACKUP_ROOT/$BACKUP_ID/scenes"
cp -a /var/lib/pascal/ai "$BACKUP_ROOT/$BACKUP_ID/ai"
cp -a /var/lib/pascal/proxy "$BACKUP_ROOT/$BACKUP_ID/proxy"
git rev-parse HEAD > "$BACKUP_ROOT/$BACKUP_ID/commit.txt"
```

备份完成后验证文件存在、权限未放宽，并在非唯一测试副本上做恢复演练。未经验证的文件复制不算可用备份。

## 10. 升级与回退

升级前：

1. 按第 8 节停止全部进程；
2. 完成第 9 节备份；
3. 记录旧 commit；
4. 部署新 commit；
5. 按第 6、7 节启动并探活；
6. 验证失败则停止全部新进程，再执行回退。

数据库 migration 是向前执行的，不支持 schema 降级。回退必须同时恢复旧数据备份和旧 commit：

1. 停止全部进程；
2. 把当前失败的数据目录改名保留，不在原目录上混合覆盖；
3. 恢复部署前的 scenes、ai、proxy 三组备份；
4. checkout 备份记录的旧 commit；
5. 按旧 commit 的依赖与构建步骤启动；
6. 重新执行全部探活检查。

不得让旧代码直接打开已经被新版本迁移过的数据库。

## 11. 数据清理

AI 数据清理先 dry-run：

```bash
cd pascal-ai-mcp
bun run data:cleanup
```

确认候选项后再执行：

```bash
bun run data:cleanup --execute
```

只有明确处理 graph 版本不兼容且已备份时才使用：

```bash
bun run data:cleanup --execute --delete-incompatible
```

废弃场景清理默认也只报告候选：

```bash
bun run scenes:cleanup
```

执行场景删除前必须停止正常流量，确认候选场景没有被人工继续编辑并完成备份：

```bash
bun run scenes:cleanup --execute
```

不要手工删除 `ai_requests`、`workflow_steps`、模型调用或工具审计行。审计保留策略未批准前只监控其增长。

## 12. 日志与问题定位

当前三个进程都把日志写到 stdout/stderr。内部部署必须由终端复用器或进程管理器收集输出，不能用会丢失日志的裸后台命令。

问题记录至少包含：

- commit；
- 发生时间和时区；
- requestId、traceId、sessionId、sceneId；
- `ops:check` 输出中的稳定 reason code；
- 用户可复现步骤；
- 预期与实际结果；
- 必要截图。

自动追踪与人工取证边界见 `docs/INTERNAL_TEST_TRACKING.md`；统一问题格式见 `docs/INTERNAL_TEST_ISSUE_TEMPLATE.md`；问题分级、去重、回归和关闭规则见 `docs/INTERNAL_TEST_FEEDBACK_PROCESS.md`。AI 请求日志不能证明 Editor 中的手工移动、undo/redo 或切换场景行为，这些必须由测试人员在问题单中明确记录。

不要粘贴完整 Prompt、模型原始响应、用户私密内容、API Key、readiness token、图片 Base64 或完整场景 JSON。日志轮转、磁盘阈值和处置顺序见 `docs/LOG_AND_STORAGE_POLICY.md`。部署定时任务每 5 分钟运行一次：

```bash
cd pascal-ai-mcp
bun run storage:check
```

默认已用空间 70% 为 warning、85% 为 critical；审计表只监控，未经批准不得删除。

## 13. 清洁环境验收清单

- [ ] Bun、.NET、Git 版本符合要求；
- [ ] 依赖安装和 Editor build 成功；
- [ ] `.env.local` 未纳入 Git；
- [ ] 模型供应商配置完整；
- [ ] `AI_MCP_READINESS_TOKEN` 已设置且不是示例值；
- [ ] Editor、MCP 与 Proxy 指向同一个 `PASCAL_DATA_DIR`；
- [ ] AI DB、artifact、Proxy DB 使用明确绝对路径；
- [ ] 数据目录仅服务用户可读写；
- [ ] 3002、8788 未暴露到不可信网络；
- [ ] 8000 仅可信内网可达，必要时已启用现有 ProxyAuth；
- [ ] 三层按顺序启动；
- [ ] 四个现有健康/就绪检查通过；
- [ ] `bun run ops:check` 退出码为 0；
- [ ] 已记录 commit 和数据路径；
- [ ] 已生成并验证一份测试备份；
- [ ] `bun run storage:check` 退出码为 0；
- [ ] stdout/stderr 已按 50 MiB × 10 文件、最长 14 天配置轮转；
- [ ] `bun run internal:check -- --automated-only` 的 E3–E8 自动演练通过；
- [ ] 当前 commit 的 provider、browser、startup、rollback 四份外部证据已归档；
- [ ] 操作人员知道正常停止顺序和禁止盲目重放的边界。

## 14. 内部部署演练与 Go/No-Go

零费用自动演练：

```bash
cd pascal-ai-mcp
bun run internal:check -- --automated-only
```

该命令执行：

- E3 Session、checkpoint、进程重建和安全恢复；
- E4 MCP、模型网络、模板、数据库和 telemetry 降级；
- E5 双进程幂等、同 Session 排他、队列与背压；
- E6 停机数据校验备份、测试升级和恢复到空目录；
- E7 磁盘阈值与审计增长策略；
- E8 增删改查 deterministic 覆盖。

开发工作区可显式增加 `--allow-dirty`，正式验收不得使用。只跑单项可用 `--only=E3,E4`。

自动演练不等于部署放行。最终结论还要求与当前 commit 一致的四份外部证据：

- `provider.json`：经用户确认并付费执行的稳定性抽查；
- `browser.json`：真实浏览器“生成→查询→修改→删除→刷新”；
- `startup.json`：干净环境三层启动与探活；
- `rollback.json`：非唯一测试数据上的旧 commit + 旧数据受控回退。

证据格式与 CRUD 步骤见 `docs/CRUD_ACCEPTANCE.md`。把四份文件放在专用目录后运行：

```bash
bun run internal:check -- --evidence-dir=/absolute/path/to/evidence
```

只有自动检查全绿、四份证据均为当前 commit 且 `ok=true` 时输出 `GO`。缺证据、证据跨版本、未解释失败或只运行部分 E 项时一律输出 `NO-GO`。
