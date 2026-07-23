import { createHash } from 'node:crypto'
import { ROOM_TYPES } from '../layout-plan'

export type PromptId =
  | 'extract'
  | 'scene-intent'
  | 'plan:intent'
  | 'plan:geometry'
  | 'modify-ops'
  | 'modification-guard'
  | 'inspect'
  | 'scene-agent'
  | 'repair'

type PromptVariables = {
  extract: {
    briefJson: string
    message: string
    inputType: string
  }
  'scene-intent': {
    history: string
    latest: string
  }
  'plan:intent': PlanPromptVariables
  'plan:geometry': PlanPromptVariables
  'modify-ops': {
    roomList: string
    request: string
    errors: string
  }
  'modification-guard': Record<string, never>
  inspect: {
    history: string
    question: string
  }
  'scene-agent': {
    guide: string
    purpose: string
    history: string
    brief: string
  }
  repair: {
    purpose: string
    round: string
    diagnostics: string
  }
}

type PlanPromptVariables = {
  briefSummary: string
  totalArea: string
  requiredRooms: string
  strategy: string
  priorFailures: string
  findings: string
}

type PromptParts = {
  extract: { system: string; user: string; retry: string }
  'scene-intent': { system: string; user: string }
  'plan:intent': { system: string; user: string; correction: string }
  'plan:geometry': { system: string; user: string; correction: string }
  'modify-ops': { system: string; user: string; retryUser: string }
  'modification-guard': { content: string }
  inspect: { system: string; user: string }
  'scene-agent': { system: string; user: string; continuation: string }
  repair: { user: string }
}

type PromptDefinition<I extends PromptId> = {
  id: I
  version: `v${number}`
  variables: readonly (keyof PromptVariables[I] & string)[]
  templates: { readonly [K in keyof PromptParts[I]]: string }
}

export type PromptAuditMetadata = {
  promptVersion: string
  promptHash: string
}

export type RenderedPrompt<I extends PromptId> = PromptAuditMetadata & {
  id: I
  version: `v${number}`
  parts: PromptParts[I]
}

const PLAN_USER_TEMPLATE = `已确认的结构化需求（房间清单、面积和硬性约束以此为准）：
{{briefSummary}}{{#totalArea}}
目标总面积：{{totalArea}}㎡（±10% 内）{{/totalArea}}{{#requiredRooms}}
必须包含的房型：{{requiredRooms}}{{/requiredRooms}}{{#strategy}}
{{strategy}}{{/strategy}}{{#priorFailures}}
上一次按规划建成的场景验收失败，原因如下，这次规划必须规避：
{{priorFailures}}{{/priorFailures}}`

const PLAN_CORRECTION_TEMPLATE = `上一轮的规划存在以下必须修正的问题：
{{findings}}
请重新输出完整修正后的 JSON（只返回 JSON 对象本身），针对每条问题调整房间清单、房型或面积，不要重复同样的错误。`

const definitions = {
  extract: {
    id: 'extract',
    version: 'v1',
    variables: ['briefJson', 'message', 'inputType'],
    templates: {
      system: 'Extract architectural requirements into valid JSON only.',
      user: `你是 Pascal 户型设计输入分析器。请只返回 JSON，不要返回 Markdown。
任务：把最新输入合并到已有结构化需求中。严格区分“图纸/图片中的现状”和“用户希望实现的设计目标”。禁止把推断写成用户事实。

每个信息项格式：
{"key":"稳定的snake_case键","label":"用户语言的名称","value":"值或数组","source":"user|system_recognition|agent_inference|default_assumption|pending_confirmation","confidence":0到1,"confirmationStatus":"unconfirmed|confirmed|rejected","evidence":"简短依据"}

输出字段：existingCondition、designGoals、hardConstraints、assumptions、uncertainties、conflicts、questions、overallConfidence、imageUsable、imageReason、relevant。
relevant 为布尔值：仅当输入（文字和图片都算）与住宅户型、房间布局、室内设计完全无关时才为 false（如问天气、闲聊、常识问答）；只要沾边或含户型图就为 true。relevant 为 false 时其余字段返回空即可。
conflicts 格式：{"key":"...","existingValue":"...","requestedValue":"...","question":"..."}。
常见信息用稳定 key：总面积 "total_area"、房间构成 "room_program"、卧室数 "bedroom_count"（数字）、边界/开间进深 "boundary_dimensions"。用户给出"N室/N卧/NLDK"时必须同时产出数字型 bedroom_count。
用户给出总面积或房间构成时，它们是已确认的设计目标（designGoals，confidence≥0.9），不要因"面积口径未说明"之类的次要歧义把它们降级或列为 uncertainties——按建筑面积理解即可。
questions 每次最多 3 个，只问会改变空间结构的问题；questions 和所有 label 使用用户输入的语言（无法判断时用英语）。
已有需求：{{briefJson}}
最新文字：{{message}}
输入类型：{{inputType}}`,
      retry: '上一次输出不是合法 JSON，这一次必须严格只返回 JSON，不要加任何说明、前后缀或 Markdown 代码块标记。',
    },
  },
  'scene-intent': {
    id: 'scene-intent',
    version: 'v1',
    variables: ['history', 'latest'],
    templates: {
      system: 'Classify a request about an existing architectural scene. Use the recent conversation to resolve references like pronouns, "that one", or "same as before". Return JSON only: {"intent":"query|create|update|delete|ambiguous|off_topic"}. Query must be read-only. Use off_topic only when the message is clearly unrelated to both this scene and architectural/interior design (e.g. weather, small talk, general knowledge). Use ambiguous when the message plausibly concerns the scene but the requested action or target is unclear even with context.',
      user: `{{#history}}Recent conversation:
{{history}}

Latest message to classify: {{/history}}{{latest}}`,
    },
  },
  'plan:intent': {
    id: 'plan:intent',
    version: 'v1',
    variables: ['briefSummary', 'totalArea', 'requiredRooms', 'strategy', 'priorFailures', 'findings'],
    templates: {
      system: `你是户型规划器。只返回一个 JSON 对象，不要任何解释或 Markdown 代码块。
JSON 结构（LayoutIntent，只有语义，没有任何坐标）：
{
  "targetTotalAreaSqm": <目标总面积，数字，㎡>,
  "rooms": [
    {
      "id": "<唯一 id，如 bedroom-1>",
      "name": "<展示名，如 主卧>",
      "type": "<${ROOM_TYPES.join('|')}>",
      "targetAreaSqm": <可选，目标面积>,
      "requiresExteriorWindow": <可选，布尔>
    }
  ],
  "adjacency": [ { "a": "<房间id>", "b": "<房间id>" } ]  // 可选，仅超出常规动线的额外邻接意愿
}

规则：
- 房间清单必须完整覆盖需求里明确要求的房间；需求描述为完整住宅时补齐必要配套（厨房、卫生间、客厅/餐厅、玄关等），只要求 N 间卧室时不要自作主张加配套。
- 需求要求开放式厨房时，输出一间 type 为 living_kitchen 的房间代替独立的 living + kitchen，不要再单独输出厨房。
- 动线空间（走廊/玄关）不需要你规划——分区器会按需自动加，除非需求明确要求。
- targetAreaSqm 缺省时按房型默认值分配，各房间面积之和不必精确等于总面积，分区器会整体缩放。
- 卧室/客厅/书房默认需要外窗，不需要重复声明；只在需求特别要求（或明确不要窗）时设置 requiresExteriorWindow。
- 房间的 name 使用用户需求所用的语言（中文需求用中文名、日本語なら日本語、英语用英语）；id 一律用英文小写。`,
      user: PLAN_USER_TEMPLATE,
      correction: PLAN_CORRECTION_TEMPLATE,
    },
  },
  'plan:geometry': {
    id: 'plan:geometry',
    version: 'v1',
    variables: ['briefSummary', 'totalArea', 'requiredRooms', 'strategy', 'priorFailures', 'findings'],
    templates: {
      system: `你是户型规划器。只返回一个 JSON 对象，不要任何解释或 Markdown 代码块。
JSON 结构（LayoutPlan，含坐标，单位米，原点 (0,0)，轴对齐）：
{
  "footprint": { "width": <宽>, "depth": <深> },
  "entry": { "roomId": "<入户房间 id>" },
  "rooms": [
    {
      "id": "<唯一 id>", "name": "<展示名>",
      "type": "<${ROOM_TYPES.join('|')}>",
      "polygon": [[x,z], ...],  // 轴对齐多边形，全部房间精确铺满 footprint、互不重叠
      "requiresExteriorWindow": <布尔>
    }
  ],
  "connections": [ { "from": "<房间id>", "to": "<房间id>", "type": "door" } ]
}
要求：铺满无缝隙、无重叠；需要外窗的房间至少一条边贴 footprint 边界（≥0.9m）；每条 connection 的两房间共享边 ≥0.9m；全部房间经门从入户房间可达；卧室不得只能穿过厨房/卫生间/其他卧室到达公共空间。`,
      user: PLAN_USER_TEMPLATE,
      correction: PLAN_CORRECTION_TEMPLATE,
    },
  },
  'modify-ops': {
    id: 'modify-ops',
    version: 'v1',
    variables: ['roomList', 'request', 'errors'],
    templates: {
      system: `你是场景修改请求解析器。把用户请求翻译成结构化操作列表，只返回一个 JSON 对象，不要任何解释或 Markdown 代码块。
返回 {"ops":[...]}，每个 op 只能是以下七种：
  {"op":"add_room","room":{"name":"<房间名>","type":"<bedroom|living|living_kitchen|dining|kitchen|bathroom|study|storage|balcony|other>","targetAreaSqm":<可选，数字>},"near":"<可选，希望邻接的房间名>"}
  {"op":"remove_room","room":"<房间名>"}
  {"op":"resize_room","room":"<房间名>","targetAreaSqm":<数字>}
  {"op":"rename_room","room":"<房间名>","name":"<新名称>"}
  {"op":"add_furniture","room":"<房间名>","item":"<家具名>"}
  {"op":"remove_furniture","room":"<房间名>","item":"<家具名>"}
  {"op":"swap_furniture","room":"<房间名>","from":"<现有家具>","to":"<新家具>"}
规则：
- room/near 引用现有房间时必须使用房间清单里的名称原文；
- 用户的称呼与清单不同字面但指向明确时，翻译成清单名再输出：如清单是「卧室1/卧室2」这类编号名，主卧=卧室1、次卧=卧室2、依此类推（master/主人房→主卧，kids room/儿童房→次卧类推）；不要因称呼不同就返回空 ops；
- item/from/to 用简短通用词（如 沙发、书桌、床、衣柜），不要带修饰语；
- 一次请求可以输出多个 op，按用户叙述顺序排列；
- 只描述用户明确要求的改动，不要自作主张补充；
- 若请求超出以上七种操作能表达的范围（如移动某面墙、调整门窗位置、整体换风格），或你无法确定，返回 {"ops":[]}。`,
      user: `当前房间清单：{{roomList}}
用户请求：{{request}}`,
      retryUser: `当前房间清单：{{roomList}}
用户请求：{{request}}
上一次输出解析失败：{{errors}}。请严格按 schema 修正后重新只输出 JSON。`,
    },
  },
  'modification-guard': {
    id: 'modification-guard',
    version: 'v1',
    variables: [],
    templates: {
      content: '结构保护要求：这是对已有场景的增量修改，只做实现本次请求所必需的改动。'
        + '新增房间时优先让新隔墙与既有墙体拼接围合，不要移动、裁剪或删除既有墙体；'
        + '新开的门优先安排在新隔墙上；不要改动与本次请求无关的门窗和家具。'
        + '如果请求给出了新增房间的面积或数值范围，创建后必须用 get_zones 实测确认落在范围内再结束。',
    },
  },
  inspect: {
    id: 'inspect',
    version: 'v1',
    variables: ['history', 'question'],
    templates: {
      system: 'Inspect the active Pascal scene and answer the user accurately. Use read-only tools when needed. Never mutate the scene. State what you verified, identify relevant node ids when useful, and distinguish measured facts from uncertainty. Use the recent conversation to resolve references like "that wall" or "the one I mentioned". If the question is unrelated to the scene and to architectural/interior design (e.g. weather, small talk), do not call any tools — briefly say you can only help with the floor plan. Reply in the language of the user\'s message (default to English if unclear).',
      user: '{{history}}{{question}}',
    },
  },
  'scene-agent': {
    id: 'scene-agent',
    version: 'v1',
    variables: ['guide', 'purpose', 'history', 'brief'],
    templates: {
      system: `You are the Pascal scene generation and repair agent. Work only on the active Pascal scene. For user feedback, make the minimum change requested and never alter unrelated geometry. Prefer semantic room tools and atomic apply_patch. Preserve confirmed requirements, avoid destructive broad changes, inspect before mutation, and validate before finishing. When calling add_door or add_window, only set \`position\` (0..1 along the wall); the \`t\` field is a legacy alias for the same value — never set both, and never set \`t\` alone.

Important limitation of the automated checks: \`check_collisions\` only compares unrotated axis-aligned bounding boxes between pairs of items — it ignores each item's \`rotation\`, and it never checks an item against walls or against its room/zone polygon. \`verify_scene\` and \`validate_scene\` do not inspect item placement at all. Passing all three does NOT mean furniture is placed sensibly. So whenever you place or move an item (place_item, furnish_room, or an apply_patch that touches an item node), you must reason about placement yourself: call get_zones and find_nodes (or get_level_summary) for the target room first to see the room polygon and existing items, account for the item's own rotated footprint, keep it inside the room polygon, keep clearance from doors/walkways, and avoid visually overlapping other furniture even if check_collisions would not flag it.

Only add support spaces (kitchen, living/dining, bathroom(s), entry/hallway, storage/laundry) that the confirmed brief itself calls for — either by naming them directly, or by describing the scope as a full home/apartment/unit. A bedroom count alone is not such a signal: if the user only asked for N bedrooms, do not add a kitchen, living room, or bathroom on your own initiative. When several placements belong to one logical change, bundle them into a single apply_patch call so they share one undo step.{{#guide}}

Additional scene-creation conventions from the Pascal MCP agent guide (project/version/save mechanics in it do not apply here — ignore those):
{{guide}}{{/guide}}`,
      user: `{{purpose}}
{{history}}Confirmed brief (authoritative for dimensions, room list, and hard constraints):
{{brief}}`,
      continuation: `{{purpose}}
上一轮已经达到工具调用轮次上限，任务还没有做完。请先用 get_zones 检查当前场景的真实状态，只继续完成尚未做完的部分，不要重复已经做好的操作。`,
    },
  },
  repair: {
    id: 'repair',
    version: 'v1',
    variables: ['purpose', 'round', 'diagnostics'],
    templates: {
      user: `{{purpose}}
自动修正第 {{round}} 轮。必须先检查相关节点，再用工具修复以下具体问题；不要只解释，也不要推翻已确认需求：{{diagnostics}}`,
    },
  },
} satisfies { [I in PromptId]: PromptDefinition<I> }

export function renderPrompt<I extends PromptId>(
  id: I,
  variables: PromptVariables[I],
): RenderedPrompt<I> {
  const definition = definitions[id] as unknown as PromptDefinition<I>
  const provided = variables as Record<string, unknown>
  const expected = new Set<string>(definition.variables)
  for (const name of expected) {
    if (!Object.hasOwn(provided, name) || typeof provided[name] !== 'string') {
      throw new Error(`prompt ${id}:${definition.version} is missing string variable "${name}"`)
    }
  }
  for (const name of Object.keys(provided)) {
    if (!expected.has(name)) {
      throw new Error(`prompt ${id}:${definition.version} received unknown variable "${name}"`)
    }
  }
  const templates = definition.templates as Record<string, string>
  const parts = Object.fromEntries(
    Object.entries(templates).map(([name, template]) => [
      name,
      interpolate(template, provided as Record<string, string>, id, definition.version),
    ]),
  ) as PromptParts[I]
  const promptHash = hashTemplates(templates)
  return {
    id,
    version: definition.version,
    promptVersion: `${id}:${definition.version}`,
    promptHash,
    parts,
  }
}

export function promptRegistryEntries(): Array<{
  id: PromptId
  version: `v${number}`
  promptVersion: string
  promptHash: string
}> {
  return (Object.keys(definitions) as PromptId[]).map(id => {
    const definition = definitions[id] as PromptDefinition<PromptId>
    return {
      id,
      version: definition.version,
      promptVersion: `${id}:${definition.version}`,
      promptHash: hashTemplates(definition.templates as Record<string, string>),
    }
  })
}

function interpolate(
  template: string,
  variables: Record<string, string>,
  id: PromptId,
  version: string,
): string {
  assertTemplateExpressions(template, variables, id, version)
  let output = template.replace(
    /{{#([a-zA-Z][a-zA-Z0-9]*)}}([\s\S]*?){{\/\1}}/g,
    (_match, name: string, body: string) => variables[name] ? body : '',
  )
  output = output.replace(/{{([a-zA-Z][a-zA-Z0-9]*)}}/g, (_match, name: string) => {
    if (!Object.hasOwn(variables, name)) {
      throw new Error(`prompt ${id}:${version} template references undeclared variable "${name}"`)
    }
    return variables[name]!
  })
  return output
}

function assertTemplateExpressions(
  template: string,
  variables: Record<string, string>,
  id: PromptId,
  version: string,
): void {
  const expression = /{{([#/]?)([a-zA-Z][a-zA-Z0-9]*)}}/g
  const blocks: string[] = []
  for (const match of template.matchAll(expression)) {
    const marker = match[1]
    const name = match[2]!
    if (!Object.hasOwn(variables, name)) {
      throw new Error(`prompt ${id}:${version} template references undeclared variable "${name}"`)
    }
    if (marker === '#') {
      blocks.push(name)
    } else if (marker === '/' && blocks.pop() !== name) {
      throw new Error(`prompt ${id}:${version} contains an unresolved template expression`)
    }
  }
  const staticText = template.replace(expression, '')
  if (blocks.length > 0 || /{{[#/]?[a-zA-Z]/.test(staticText)) {
    throw new Error(`prompt ${id}:${version} contains an unresolved template expression`)
  }
}

function hashTemplates(templates: Record<string, string>): string {
  const canonical = Object.entries(templates)
    .map(([name, template]) => `${name}\u0000${template}`)
    .join('\u0000')
  return createHash('sha256').update(canonical).digest('hex')
}
