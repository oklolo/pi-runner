import type { SessionManager } from '@earendil-works/pi-coding-agent'
import type { ChatExecution, ChatMessage } from '../../shared/models'
import { thinkingText } from './pi-thinking'
import { assertSessionTree } from './session-tree'

export function sessionTranscript(manager: SessionManager, skills: ReadonlyMap<string, { name: string }> = new Map(), visibleIds?: string[]): ChatMessage[] {
  assertSessionTree(manager)
  const attachments = new Map<string, ChatMessage>()
  const executions = new Map<string, ChatExecution>()
  const skillNotices = new Map<string, string>()
  const durations = new Map<string, number>()
  const skillCallNames = new Map<string, string>()
  const aiReviews = new Map<string, import('../../shared/models').AiReviewDetail[]>()
  const results = new Map<string, { content: string; isError: boolean }>()
  const branch = manager.getBranch()
  const entries = manager.getEntries()
  for (const entry of branch) {
    if (entry.type === 'custom' && entry.customType === 'pi-runner-ai-review') {
      const data = entry.data as { toolCallId: string } & import('../../shared/models').AiReviewDetail
      if (['allow', 'ask', 'deny'].includes(data.decision)) {
        const details = aiReviews.get(data.toolCallId) ?? []
        details.push({ decision: data.decision, ...(data.reason ? { reason: data.reason } : {}), ...(data.target ? { target: data.target } : {}), ...(data.model ? { model: data.model } : {}), ...(data.provider ? { provider: data.provider } : {}) })
        aiReviews.set(data.toolCallId, details)
      }
    }
    if (entry.type === 'custom' && entry.customType === 'pi-runner-skill-call') {
      const data = entry.data as { toolCallId: string; name: string }
      skillCallNames.set(data.toolCallId, data.name)
    }
    if (entry.type === 'custom' && entry.customType === 'pi-runner-skill-usage') {
      const data = entry.data as { entryId: string; notice: string }
      skillNotices.set(data.entryId, data.notice)
    }
    if (entry.type === 'message' && entry.message.role === 'toolResult') results.set(entry.message.toolCallId, {
      content: entry.message.content.map(block => block.type === 'text' ? block.text : '[图片结果]').join('\n'), isError: entry.message.isError
    })
    if (entry.type === 'custom' && entry.customType === 'pi-runner-call-duration') {
      const data = entry.data as { messageTimestamp: number; elapsedMs: number }; durations.set(String(data.messageTimestamp), data.elapsedMs)
    }
  }
  const snapshotHashes = new Map<string, string>()
  const codeSnapshots = new Map<string, string>()
  let lastMessageId: string | undefined
  for (const entry of branch) {
    if (entry.type === 'custom' && entry.customType === 'pi-runner-code-preview') {
      const data = entry.data as { entryId: string; snapshotId: string }
      codeSnapshots.set(data.entryId, data.snapshotId)
    }
    if (entry.type === 'message' && (entry.message.role === 'user' || entry.message.role === 'assistant')) {
      const content = entry.message.content
      if (typeof content === 'string' ? content.trim() : content.some(block => block.type === 'text' && block.text.trim())) lastMessageId = entry.id
    }
    if (entry.type === 'custom' && entry.customType === 'pi-runner-snapshot' && lastMessageId) {
      const data = entry.data as import('../../shared/models').AgentSnapshot
      snapshotHashes.set(lastMessageId, data.after.hash)
    }
  }
  for (const entry of entries) if (entry.type === 'custom' && entry.customType === 'pi-runner-execution') {
    const data = entry.data as { entryIds: string[]; execution: ChatExecution }
    for (const id of data.entryIds) executions.set(id, data.execution)
  }
  for (const entry of entries) if (entry.type === 'custom' && entry.customType === 'pi-runner-files') {
    const data = entry.data as { id: string; message: ChatMessage }; attachments.set(data.id, data.message)
  }
  return branch.flatMap(entry => {
    if (entry.type !== 'message' || (entry.message.role !== 'user' && entry.message.role !== 'assistant')) return []
    const message = entry.message
    const content = typeof message.content === 'string' ? message.content : message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
    const original = attachments.get(/\[pi-runner-files:([\w-]+)\]/.exec(content)?.[1] ?? '')
    const execution = executions.get(entry.id)
    const call = message.role === 'assistant' ? {
      elapsedMs: durations.get(String(message.timestamp)),
      ...(message.stopReason !== 'error' && message.stopReason !== 'aborted' && message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite > 0 ? {
        usage: { inputTokens: message.usage.input + message.usage.cacheRead + message.usage.cacheWrite, outputTokens: message.usage.output }
      } : {}),
      work: message.content.flatMap((block, index): import('../../shared/models').ChatWorkItem[] => {
        if (block.type === 'thinking') return [{ id: `${entry.id}-${index}`, kind: 'thinking', content: thinkingText(block), completed: true }]
        if (block.type !== 'toolCall') return []
        const result = results.get(block.id)
        const skillName = skills.get(String(block.arguments.skillId ?? ''))?.name ?? skillCallNames.get(block.id)
        const details = aiReviews.get(block.id)
        const aiReview = details?.some(item => item.decision === 'deny') ? 'deny' : details?.some(item => item.decision === 'ask') ? 'ask' : details?.length ? 'allow' : undefined
        return [{ id: block.id, kind: 'tool', name: block.name, ...(skillName ? { skillName } : {}), ...(aiReview ? { aiReview, aiReviewDetails: details } : {}), args: block.arguments, content: result?.content ?? '', completed: Boolean(result), isError: result?.isError }]
      })
    } : undefined
    if (original || content.trim() || call?.work.length) visibleIds?.push(entry.id)
    return original ? [{ ...original, historyId: entry.id, ...(snapshotHashes.has(entry.id) ? { snapshotHash: snapshotHashes.get(entry.id) } : {}) }] : content.trim() || call?.work.length ? [{ role: message.role as 'user' | 'assistant', content: content + (skillNotices.get(entry.id) ?? ''), historyId: entry.id,
      ...(call ? { call } : {}),
      ...(codeSnapshots.has(entry.id) ? { codeSnapshotId: codeSnapshots.get(entry.id) } : {}),
      ...(snapshotHashes.has(entry.id) ? { snapshotHash: snapshotHashes.get(entry.id) } : {}),
      ...(execution ? { execution } : message.role === 'assistant' ? { execution: { model: message.model } } : {}) }] : []
  })
}
