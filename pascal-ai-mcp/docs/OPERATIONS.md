# Pascal AI 内部运行检查与告警

## 1. 状态来源

`GET /ready` 与内部告警共用 `ReadinessService`。SQLite、checkpoint、模板、MCP 和 telemetry 不存在第二套 readiness 判断。`ops:check` 通过受保护的 `/ready` 获取这些结果，再用只读 SQLite 查询补充：

- queued 请求数量与最长等待时间；
- 已过期的 worker running lease；
- 近期终态请求数、失败率和稳定错误码分布。

`ai_requests.execution_source` 持久区分 Server worker、CLI/eval direct 和迁移前 legacy 请求。直接运行的 CLI/eval 请求不计入“过期 running lease”或服务失败率；无法可靠判断来源的迁移前历史记录标为 `legacy`，同样不进入服务失败率，避免猜测造成误报。

## 2. 一次性检查

AI 服务运行且配置 `AI_MCP_READINESS_TOKEN` 后执行：

```bash
bun run ops:check
```

若检查其他地址，设置 `AI_MCP_OPS_READY_URL`。输出为单个 JSON：

- `exitCode=0`：无告警；
- `exitCode=1`：至少一个 warning；
- `exitCode=2`：至少一个 critical。

命令不会修改请求、Session、workflow step 或场景。它只读取队列指标；`/ready` 仍执行既有 SQLite/checkpoint 可写探针。

## 3. 主动告警

服务进程按 `AI_MCP_OPS_CHECK_INTERVAL_MS` 定期运行同一检查，并输出结构化 `ops_alert` 日志。事件级别为：

- `warning`
- `critical`
- `recovered`

相同 reason code 在 `AI_MCP_OPS_ALERT_COOLDOWN_MS` 内不重复输出；超过冷却时间仍未恢复时可以再次提醒。故障消失时只输出一次 `recovered`。进程重启会重置内存中的冷却状态，因此持续故障会在新进程中重新报告一次。

## 4. 默认阈值

| 环境变量 | 默认值 | 含义 |
|---|---:|---|
| `AI_MCP_OPS_CHECK_INTERVAL_MS` | 60000 | 服务内检查周期 |
| `AI_MCP_OPS_ALERT_COOLDOWN_MS` | 300000 | 同 reason code 冷却时间 |
| `AI_MCP_OPS_QUEUE_WARNING_MS` | 30000 | 最老 queued 请求 warning |
| `AI_MCP_OPS_QUEUE_CRITICAL_MS` | 120000 | 最老 queued 请求 critical |
| `AI_MCP_OPS_FAILURE_WINDOW_MS` | 300000 | 失败率统计窗口 |
| `AI_MCP_OPS_FAILURE_MIN_SAMPLES` | 5 | 启用失败率告警的最小终态样本 |
| `AI_MCP_OPS_FAILURE_WARNING_RATE` | 0.20 | warning 失败率 |
| `AI_MCP_OPS_FAILURE_CRITICAL_RATE` | 0.50 | critical 失败率 |

critical 阈值不会低于 warning 阈值；非法配置回退到默认值。

## 5. 稳定 reason code

当前检查可能产生：

- `database_unavailable`
- `checkpoints_unavailable`
- `template_library_unavailable`
- `mcp_unavailable`
- `telemetry_degraded`
- `model_provider_unconfigured`
- `queue_wait_high`
- `queue_wait_critical`
- `running_lease_expired`
- `request_failure_rate_high`
- `request_failure_rate_critical`
- `ops_metrics_unavailable`
- `readiness_token_missing`
- `readiness_endpoint_unreachable`
- `readiness_unauthorized`
- `readiness_http_error`
- `readiness_invalid_response`
- `readiness_check_failed`
- `ops_monitor_failed`

告警只包含 reason code、计数、时长、比例和 MCP 稳定状态；不输出 API Key、Token、Prompt、用户原文、原始错误、完整响应或场景内容。

## 6. 故障验证

自动测试覆盖：

- SQLite/checkpoint 不可写；
- 模板库阻断流量；
- MCP 子进程退出、readiness 降级和新连接恢复；
- telemetry degraded；
- queued 等待超阈值；
- worker lease 过期；
- 近期失败率超阈值；
- 首次告警、冷却、恢复和再次故障；
- `ops:check` 对真实 HTTP readiness 与只读 SQLite 指标的接线。

任何检查和恢复都不会自动重放 MCP 写工具。
