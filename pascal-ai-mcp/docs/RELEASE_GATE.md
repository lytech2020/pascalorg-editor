# Pascal AI 发布前自动 Gate

## 默认无费用 Gate

从 `pascal-ai-mcp` 执行：

```bash
bun run release:check
```

默认依次运行：

1. `bun run check-types`
2. `bun test --max-concurrency=1`
3. `bun run templates:check -- --no-artifacts`
4. `bun run eval:deterministic`

默认路径不调用真实模型或 MCP，不消耗 provider Token。任一检查失败时命令非零退出。

Gate 默认拒绝 dirty worktree，避免把未提交内容错误归因到 HEAD commit。开发阶段验证当前未提交实现时可以显式运行：

```bash
bun run release:check -- --allow-dirty
```

`--allow-dirty` 只用于开发验证，不能作为部署 Go/No-Go 证据。

## 版本摘要

每次运行会输出并保存：

- Git commit 与 dirty 状态；
- 数据库 schema version 和 migration name；
- Prompt ID、显式版本和内容 hash；
- 模板 schema version；
- 每个检查的命令、退出码和耗时。

数据库版本来自临时数据库完成真实 migration 后对 `schema_migrations` 的 `MAX(version)` 查询，不维护第二份手写版本号。报告写入 `eval/report/release/<timestamp>/`，该目录不提交 Git。

## Provider 抽查

Provider eval 会产生真实费用，默认绝不运行。必须显式提供付费开关和 1–3 个 case：

```bash
bun run release:check -- \
  --with-provider-eval \
  --provider-only=case-02-studio,case-03-two-bed-standard \
  --provider-repeat=3
```

`--provider-repeat` 允许 1–5，默认 1。免费 Gate 全部通过后才会进入 provider eval；任何免费检查失败时付费步骤标记为 skipped。

Provider 抽查会使用正常 eval 的数据库、MCP 和模型配置并生成真实场景与报告。运行前必须确认：

- 当前数据目录是测试环境；
- 模型 Key 与额度正确；
- 所选 Case 和重复次数已经由负责人批准；
- 已理解 `--allow-provider-cost` 的费用含义。

## 退出码

- `0`：全部请求的 Gate 通过；
- `1`：worktree 不干净或至少一项检查失败；
- `2`：Gate 参数或版本摘要配置无效。
