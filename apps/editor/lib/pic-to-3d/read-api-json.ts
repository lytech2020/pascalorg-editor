export async function readApiJson<T>(response: Response): Promise<T> {
  const text = await response.text()
  if (!text.trim()) {
    throw new Error(`Empty response (${response.status} ${response.statusText}).`)
  }

  try {
    return JSON.parse(text) as T
  } catch {
    const snippet = text.replace(/\s+/g, ' ').slice(0, 200)
    throw new Error(
      `Expected JSON but received ${response.status} ${response.statusText}: ${snippet}`,
    )
  }
}
