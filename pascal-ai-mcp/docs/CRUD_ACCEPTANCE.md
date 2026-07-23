# Pascal AI 增删改查验收

## 1. 范围与结论口径

机器可读覆盖矩阵位于 `eval/crud-matrix.json`。每项只能有三种结论：

- `supported`：当前有确定性执行与验证边界；
- `safe_rejection`：当前能力不支持，必须在场景写入前明确拒绝；
- `failed_recoverable`：外部副作用结果不明确，保留审计并禁止盲目重放。

验收不把“安全拒绝”伪装为功能支持。当前结构生成会创建门窗，但已有场景的直接门窗增删移动尚未进入 `ModifyOp` 契约；带明确目标位置的 `move_furniture` 也尚无确定性位置契约与执行器。这两类请求必须稳定拒绝，不能转入自由 MCP 写入。

## 2. 三层测试

### 2.1 零费用 deterministic

```bash
bun run internal:check -- --allow-dirty --automated-only --only=E8
```

该检查覆盖房间增删改、家具增删换、连续修改、局部范围保护、结果未知恢复边界和 eval corpus 结构。它不调用模型供应商。

### 2.2 Provider 稳定性抽查

Provider 抽查会产生真实费用，必须先由用户确认。推荐用例为：

```text
case-03-two-bed-standard
case-18-modify-swap-furniture
case-23-modify-chained
```

运行入口：

```bash
bun run release:check -- \
  --with-provider-eval \
  --provider-only=case-03-two-bed-standard,case-18-modify-swap-furniture,case-23-modify-chained \
  --provider-repeat=2
```

抽查评估重复稳定性，不以一次成功代替稳定性结论。

### 2.3 浏览器端到端

在三层服务就绪后，用一个专用测试场景按顺序执行：

1. 生成 2LDK；
2. 查询房间、面积、家具和请求状态，确认没有场景写审计；
3. 把一间卧室重命名；
4. 增加家具；
5. 替换或删除该家具；
6. 执行一次结构修改并确认；
7. 刷新页面，确认 Session、请求进度和最终场景仍可查询；
8. 输入直接移动门、删除窗或把家具移动到指定坐标的请求，确认在施工前被安全拒绝；
9. 对比每步场景 diff，确认局部修改未触碰无关节点。

## 3. 失败记录

每个失败至少记录：

- commit、caseId、repeat；
- requestId、sessionId、sceneId；
- 预期与实际 disposition；
- 修改前后场景 diff；
- 是否发生 MCP 写入；
- 是否为 `failed_recoverable`；
- 修复对应的自动回归或人工复验步骤。

不得在报告中粘贴 Prompt、模型原始响应、图片 Base64、Secret 或完整私有场景。

## 4. 外部证据

`bun run internal:check` 的最终 Go/No-Go 只接受与当前 commit 完全一致的证据文件。证据目录需要包含：

```text
provider.json
browser.json
startup.json
rollback.json
```

每个文件格式：

```json
{
  "schemaVersion": 1,
  "kind": "provider",
  "commit": "<git commit>",
  "executedAt": "2026-07-23T10:00:00.000Z",
  "ok": true,
  "notes": "不含用户原文和 Secret 的结论"
}
```

`kind` 分别为 `provider`、`browser`、`startup`、`rollback`。缺失、失败、格式错误或 commit 不一致均保持 `NO-GO`。
