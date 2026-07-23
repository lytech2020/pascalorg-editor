# Pascal AI 内部部署演练

## 1. 自动演练

```bash
bun run internal:check -- --automated-only
```

开发中的未提交批次需要显式增加 `--allow-dirty`；正式证据不允许 dirty worktree。报告写入被 Git 忽略的 `eval/report/deployment/<timestamp>/`。

| 任务 | 自动证据 | 安全边界 |
|---|---|---|
| E3 | checkpoint 中断/恢复、进程重建、lease 过期、安全 plan 边界、queued 重启续跑 | 只重跑尚未发生外部写入的安全节点；结果未知保持 `failed_recoverable` |
| E4 | MCP 退出与重连、模板门控、readiness/ops 降级、模型取消与网络错误 | 写工具不自动重放；错误不转成虚假成功 |
| E5 | 两个真实子进程同键提交、同 Session/Scene 排他、队列深度、取消优先级 | 不提高 worker 并发掩盖排队；已接受请求必须进入终态 |
| E6 | 停机目录校验清单、SHA-256、防覆盖、测试升级、恢复到全新目录 | 不做 schema 降级；旧代码只打开配套旧数据副本 |
| E7 | 70%/85% 磁盘阈值与退出码 | 只读监控；未经批准不删审计 |
| E8 | 房间/家具 CRUD、连续修改、局部范围、未知操作拒绝、deterministic corpus | 直接门窗修改当前为安全拒绝，不冒充已支持 |

## 2. 多测试者演练

内部集中测试首轮固定为 3 名测试者、每人 3 个请求，共 9 个请求，不临时调整默认 `AI_MCP_WORKER_CONCURRENCY=1` 或 `AI_MCP_MAX_QUEUE_DEPTH=100`。

分配：

- 测试者 A：同一 Session 连续提交“查询→重命名→家具替换”；
- 测试者 B：新 Session 提交生成，等待中执行取消后重新提交；
- 测试者 C：新 Session 提交生成，刷新页面后续查，再执行结构修改确认。

记录：

- 每次请求的 requestId、sessionId、sceneId、提交时间、开始时间、终态时间；
- 最大 queued 等待时间；
- 429 数量及 Retry-After；
- succeeded、failed、cancelled、failed_recoverable 分布；
- 是否出现跨 Session、Scene 或 request 结果污染。

完成标准：

- 9 个已接受请求全部进入终态；
- 同 Session 不并发施工；
- 跨 Session 的状态、场景和回复不串写；
- 如主动把测试队列上限降到演练值并制造满队列，超额请求返回既定 429，已接受请求不丢失。

该演练需要真实三层环境，结果进入 `browser.json` 或附属记录，不能由单元测试替代。

## 3. 外部证据

最终 Go/No-Go 需要当前 commit 的四份证据：

- provider：明确付费确认后的 provider 重复抽查；
- browser：浏览器 CRUD、刷新、取消和 3×3 并发演练；
- startup：干净环境三层启动、现有端点探活和 `ops:check`；
- rollback：非唯一测试数据上停机备份、升级、停止新版本、旧 commit + 旧数据恢复。

证据 JSON 格式见 `CRUD_ACCEPTANCE.md`。Notes 只写脱敏结论，不写用户原文、Prompt、响应体、Secret 或完整场景。

## 4. Go/No-Go

```bash
bun run internal:check -- --evidence-dir=/absolute/path/to/evidence
```

判定规则：

- 自动 E3–E8 任一失败：`NO-GO`；
- 四份外部证据任一缺失、失败、损坏或 commit 不一致：`NO-GO`；
- dirty worktree：`NO-GO`；
- 只执行部分自动任务：`NO-GO`；
- 以上全部满足：`GO`。

`--allow-dirty` 和 `--automated-only` 仅用于开发期确认自动部分。它们可以让自动检查以退出码 0 结束，但 dirty worktree 永远加入 `dirty_worktree` blocker，最终判定绝不可能为 `GO`。
