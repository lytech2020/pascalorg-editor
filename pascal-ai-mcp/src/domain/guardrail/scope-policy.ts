export const SCOPE_POLICY_VERSION = 'scope-v1'

export type ScopeDecision = {
  decision: 'allow' | 'block' | 'defer'
  reasonCode: 'image_context' | 'architecture_context' | 'explicit_weather' | 'uncertain'
}

const ARCHITECTURE_CONTEXT = /(?:户型|房间|卧室|客厅|厨房|卫生间|玄关|走廊|门窗|墙|面积|平米|㎡|間取り|部屋|寝室|リビング|キッチン|浴室|玄関|廊下|窓|壁|floor\s*plan|room|bedroom|living|kitchen|bathroom|hallway|door|window|wall|layout)/i

const EXPLICIT_WEATHER = /^(?:请?问?[，,\s]*)?(?:今(?:天|日)的?天气(?:怎么样|如何|好吗)?|天气(?:怎么样|如何|好吗)?|今日の天気(?:は|どう|を教えて)?|天気(?:は|どう)(?:ですか)?|what(?:'s|\s+is)\s+the\s+weather(?:\s+(?:like\s+)?today)?|how(?:'s|\s+is)\s+the\s+weather(?:\s+today)?)[?？!！。\s]*$/i

export function classifyScopeRequest(input: {
  message?: string
  hasImage: boolean
}): ScopeDecision {
  if (input.hasImage) return { decision: 'allow', reasonCode: 'image_context' }
  const message = input.message?.normalize('NFKC').trim() ?? ''
  if (ARCHITECTURE_CONTEXT.test(message)) {
    return { decision: 'allow', reasonCode: 'architecture_context' }
  }
  if (EXPLICIT_WEATHER.test(message)) {
    return { decision: 'block', reasonCode: 'explicit_weather' }
  }
  return { decision: 'defer', reasonCode: 'uncertain' }
}
