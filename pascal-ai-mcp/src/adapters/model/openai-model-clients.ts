import type { AppConfig } from '../../config'
import { OpenAiCompatibleClient } from '../../openai-compatible'
import type { ModelClients } from '../../ports/model-client'

export function createOpenAiModelClients(config: AppConfig): ModelClients {
  const main = config.aiApiKey ? client(config, {
    apiKey: config.aiApiKey,
    model: config.aiModel,
    title: config.aiTitle,
    azureDeployment: config.azureDeployment,
  }) : undefined
  const fallback = config.aiFallbackModel && (config.aiFallbackApiKey || config.aiApiKey)
    ? client(config, {
        apiKey: config.aiFallbackApiKey ?? config.aiApiKey!,
        model: config.aiFallbackModel,
        title: `${config.aiTitle} fallback`,
        azureDeployment: config.azureDeployment,
      })
    : undefined
  const fast = config.aiApiKey && config.aiFastModel !== config.aiModel
    ? client(config, {
        apiKey: config.aiApiKey,
        model: config.aiFastModel,
        title: `${config.aiTitle} fast`,
        azureDeployment: config.aiProvider === 'azure-openai'
          ? config.aiFastModel
          : config.azureDeployment,
      })
    : undefined
  return { ...(main ? { main } : {}), ...(fallback ? { fallback } : {}), ...(fast ? { fast } : {}) }
}

function client(
  config: AppConfig,
  options: { apiKey: string; model: string; title: string; azureDeployment?: string },
): OpenAiCompatibleClient {
  return new OpenAiCompatibleClient({
    provider: config.aiProvider,
    apiKey: options.apiKey,
    baseUrl: config.aiBaseUrl,
    model: options.model,
    referer: config.aiReferer,
    title: options.title,
    temperature: config.aiTemperature,
    azureDeployment: options.azureDeployment,
    azureApiVersion: config.azureApiVersion,
    requestTimeoutMs: config.aiRequestTimeoutMs,
  })
}
