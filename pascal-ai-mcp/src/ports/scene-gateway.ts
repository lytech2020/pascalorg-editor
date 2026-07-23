import type { OpenAiTool } from '../types'

export interface SceneGateway {
  callTool(
    name: string,
    args: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<unknown>
  listOpenAiTools(): Promise<OpenAiTool[]>
  readResourceText(uri: string): Promise<string | undefined>
}
