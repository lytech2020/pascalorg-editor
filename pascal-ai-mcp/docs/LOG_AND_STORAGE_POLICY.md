# Pascal AI 日志与存储增长策略

## 日志

三个服务继续只写 stdout/stderr，由部署进程管理器负责收集。内部部署默认策略：

- 单文件达到 50 MiB 轮转；
- 最多保留 10 个文件；
- 最长保留 14 天，先到者生效；
- 压缩已轮转文件；
- 不记录 API Key、Token、Prompt、用户原文、完整模型响应、图片 Base64 或完整场景。

应用不自行创建第二套日志文件。进程管理器必须保留时间、服务名、级别、requestId/traceId 和稳定错误码。

## 磁盘

每 5 分钟执行：

```bash
bun run storage:check
```

默认阈值：

- 已用空间低于 70%：healthy，退出码 0；
- 已用空间达到 70%：warning，退出码 1；
- 已用空间达到 85%：critical，退出码 2。

可通过 `AI_MCP_DISK_WARNING_PERCENT` 和 `AI_MCP_DISK_CRITICAL_PERCENT` 调整，但 warning 必须低于 critical。

检查只读取文件系统、数据库 schema 和审计行数，不修改请求、Session、checkpoint、artifact 或审计数据，也不输出绝对数据路径。

## 处理顺序

1. warning 时确认增长来源、备份状态和剩余天数；
2. 先按 Runbook 停止无必要的测试流量；
3. artifact/checkpoint 只通过 `bun run data:cleanup` 的 dry-run 和明确 `--execute` 清理；
4. 废弃场景只通过 `bun run scenes:cleanup` 的 dry-run 和明确 `--execute` 清理；
5. stdout 日志按进程管理器策略轮转；
6. 审计表仅监控行数与数据库大小，在没有批准的保留策略前不得删除、truncate 或重建；
7. critical 时暂停新流量，完成备份后扩容或迁移数据目录。

SQLite、artifact 和场景数据必须按同一部署版本备份；不得通过删除审计来临时掩盖容量问题。
