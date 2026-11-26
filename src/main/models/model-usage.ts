import type { ModelCallDetail } from '../../shared/models'

export interface ObservedUsage {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  finalCacheRead?: boolean
  finalCacheWrite?: boolean
  thoughts?: number
  inputExcludesCache?: boolean
}

type SdkUsage = Partial<Record<'input' | 'output' | 'cacheRead' | 'cacheWrite', number>>
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
export const tokenCount = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
const firstCount = (...values: unknown[]): number | undefined => values.map(tokenCount).find(value => value !== undefined)
// 部分兼容网关会在一个别名中填零，在另一个字段中返回实际缓存用量。
const cacheCount = (...values: unknown[]): number | undefined => {
  const counts = values.map(tokenCount)
  return counts.find(value => value !== undefined && value > 0) ?? counts.find(value => value === 0)
}
const sum = (...values: (number | undefined)[]): number | undefined => tokenCount(values.reduce<number>((total, value) => total + (value ?? 0), 0))

/** 流式用量是累计快照；只有明确的最终用量才能用零覆盖已知的缓存正值。 */
export function observeUsage(event: unknown, observed: ObservedUsage, protocol: 'compatible' | 'anthropic' | 'google' | 'ollama' = 'compatible'): void {
  const root = record(event)
  const responseUsage = record(root.response).usage
  const final = protocol === 'compatible' && responseUsage != null &&
    (root.type === 'response.completed' || root.type === 'response.done' || root.type === 'response.incomplete')
  const usage = record(protocol === 'ollama' ? root : responseUsage ?? root.usage ?? record(root.message).usage ?? root.usageMetadata)
  const prompt = record(usage.prompt_tokens_details), inputDetails = record(usage.input_tokens_details)
  const creation = record(usage.cache_creation)
  const short = tokenCount(creation.ephemeral_5m_input_tokens), long = tokenCount(creation.ephemeral_1h_input_tokens)
  const hit = tokenCount(usage.prompt_cache_hit_tokens), miss = tokenCount(usage.prompt_cache_miss_tokens)
  const input = firstCount(usage.input_tokens, usage.prompt_tokens, usage.promptTokenCount, usage.prompt_eval_count,
    hit !== undefined && miss !== undefined ? sum(hit, miss) : undefined)
  const output = firstCount(usage.output_tokens, usage.completion_tokens, usage.candidatesTokenCount, usage.eval_count)
  const cacheRead = cacheCount(inputDetails.cached_tokens, prompt.cached_tokens, usage.cache_read_input_tokens,
    hit, usage.cached_tokens, usage.cachedContentTokenCount)
  const cacheWrite = cacheCount(inputDetails.cache_write_tokens, prompt.cache_write_tokens, usage.cache_creation_input_tokens,
    usage.prompt_cache_write_tokens, usage.cache_write_tokens, short === undefined && long === undefined ? undefined : sum(short, long))
  const thoughts = protocol === 'google' ? tokenCount(usage.thoughtsTokenCount) : undefined
  if (input !== undefined) {
    observed.input = input
    observed.inputExcludesCache = protocol === 'anthropic'
  }
  if (output !== undefined) observed.output = output
  if (cacheRead !== undefined && (final || !observed.finalCacheRead)) {
    observed.cacheRead = final ? cacheRead : cacheCount(cacheRead, observed.cacheRead)
    observed.finalCacheRead = final
  }
  if (cacheWrite !== undefined && (final || !observed.finalCacheWrite)) {
    observed.cacheWrite = final ? cacheWrite : cacheCount(cacheWrite, observed.cacheWrite)
    observed.finalCacheWrite = final
  }
  if (thoughts !== undefined) observed.thoughts = thoughts
}

/** 保留实际缓存正值，不让原始占位零或 SDK 补零遮蔽；有明确零且无正值时仍显示零。 */
export function modelUsageDetails(observed: ObservedUsage = {}, sdk: SdkUsage = {}): Pick<ModelCallDetail, 'usage' | 'usageFields'> & { usageFields: NonNullable<ModelCallDetail['usageFields']> } {
  const positive = (value: unknown): number | undefined => tokenCount(value) || undefined
  const cacheRead = observed.finalCacheRead ? observed.cacheRead : cacheCount(observed.cacheRead, positive(sdk.cacheRead))
  const cacheWrite = observed.finalCacheWrite ? observed.cacheWrite : cacheCount(observed.cacheWrite, positive(sdk.cacheWrite))
  const input = observed.input !== undefined
    ? observed.inputExcludesCache ? sum(observed.input, cacheRead, cacheWrite) : observed.input
    : tokenCount(sdk.input) !== undefined && [sdk.input, sdk.cacheRead, sdk.cacheWrite].some(positive)
      ? sum(sdk.input, tokenCount(sdk.cacheRead), tokenCount(sdk.cacheWrite)) : undefined
  const output = observed.output !== undefined ? sum(observed.output, observed.thoughts) : positive(sdk.output) ?? observed.thoughts
  const usageFields = { input: input !== undefined, output: output !== undefined, cacheRead: cacheRead !== undefined, cacheWrite: cacheWrite !== undefined }
  return { usageFields, ...(Object.values(usageFields).some(Boolean) ? { usage: { inputTokens: input ?? 0, outputTokens: output ?? 0,
    ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}), ...(cacheWrite !== undefined ? { cacheWriteTokens: cacheWrite } : {}) } } : {}) }
}
