# 模板局部适配设计（schema v2）

## 目标与边界

模板命中后优先保留真实参照的拓扑、水回り核心和动线，只在模板作者明确声明的带状区域内调整尺寸。适配器不新增、删除或移动连接，不改变房间身份，也不代替 validator。没有 `adaptation` 的模板继续使用 v1 的整图等比缩放。

面积比例与线性比例是两个不同量。目标面积比例 `r = targetArea / templateArea`；整图等比时两轴线性比例均为 `sqrt(r)`。例如面积范围 `0.8–1.25` 对应线性比例约 `0.894–1.118`，不能写成“边长 ±20%”。

## schema

```jsonc
{
  "schemaVersion": 2,
  "adaptation": {
    "areaRatio": { "min": 0.72, "max": 1.4 },
    "xBands": [{ "from": 2.0, "to": 6.0, "weight": 1 }],
    "zBands": [{ "from": 2.6, "to": 6.4, "weight": 1 }]
  }
}
```

- `areaRatio` 是该模板经固定 fixture 验证过的面积窗口，必须包含 1；它不是通用承诺。
- `xBands` / `zBands` 至少存在一个；区间按坐标递增、不得重叠、不得越过 footprint。
- `weight` 只决定同一轴上多个带分担增量的比例，不表示面积或绝对长度。
- schema 会在 `areaRatio.min` 对每个带验证分段斜率严格大于 0；过大的权重不能在收缩时造成坐标反转。最大比例只会增加斜率，因此无需重复检查。

## 几何映射

同一轴上的映射是一个全局、单调、分段线性函数。带外坐标只整体平移，带内长度按 `区间长度 × weight` 分担轴向增量。房间 polygon、非矩形 footprint polygon 和 footprint 边界必须调用同一个映射函数；因此相同输入坐标得到相同厘米取整结果，共享墙仍共线且端点一致。

设轴长为 `L`、该轴目标长度变化为 `delta`、所有伸缩带容量之和为 `capacity = Σ((to-from)×weight)`，某带内部的映射斜率为 `1 + delta×weight/capacity`。schema 在允许的最小面积比例处验证该值严格为正，保证厘米取整前的映射不折返；厘米取整后的实际房间尺寸仍交由 validator 判断。

只声明一个轴时，该轴承担全部面积变化；两个轴都有伸缩带时，线性比例按 `sqrt(r)` 分配。映射后统一经过现有 `roundCm`，随后由同一个 `validateLayoutPlan` 检查：

- footprint 覆盖、重叠和非矩形边界；
- 房间最小面积、最小宽度和长宽比；
- 连接房间的共享墙长度；
- 外窗宿主边与入户边；
- requiredRooms 和总面积容差。

任何 fatal 都拒绝该候选并继续下一个模板或回落 partitioner。soft warning 保留在结果中用于比较，不能用“validator 满分率”掩盖房间比例恶化。

## 固定验收 fixture

`tpl-jp-2ldk-57` 只允许拉伸 `z=2.6–6.4` 的居住带，水回り与横向廊下核心保持原深度。75㎡ fixture 的面积比例约 1.33，超过 v1 上限 1.25；适配后必须满足 fatal=0，并验证 LDK 与洋室2 的共享坐标完全一致。原面积模板的 validator 结果不得变化。

新增可伸缩模板时，必须同时提交：原面积基线、窗口边界内至少一个扩展 fixture、共享墙/footprint 一致性断言，以及 warning 分布说明。
