import createHistoryWorker from './session-history-worker?nodeWorker'
import type { ChatMessage } from '../../shared/models'

let queue: Promise<unknown> = Promise.resolve()
const pending = new Map<string, Promise<ChatMessage[]>>()

/** 原生历史的解析、索引与展示转换均放在可终止的线程，不阻塞 Electron 主线程。 */
export function restoreSessionHistory(file: string, skills: [string, { name: string }][]): Promise<ChatMessage[]> {
  const existing = pending.get(file)
  if (existing) return existing
  const result = queue.then(() => new Promise<ChatMessage[]>((resolve, reject) => {
    const worker = createHistoryWorker({ workerData: { file, skills }, resourceLimits: { maxOldGenerationSizeMb: 512 } })
    let finished = false
    const finish = (messages?: ChatMessage[]): void => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      void worker.terminate().catch(() => {})
      if (messages) resolve(messages)
      else reject(new Error('代理会话恢复失败或超时，原文件已保留'))
    }
    const timer = setTimeout(() => finish(), 30_000)
    worker.once('message', (reply: { ok: boolean; messages?: ChatMessage[] }) => finish(reply.ok && Array.isArray(reply.messages) ? reply.messages : undefined))
    worker.once('error', () => finish())
    worker.once('exit', () => finish())
  }))
  pending.set(file, result)
  queue = result.catch(() => undefined)
  void result.then(() => pending.delete(file), () => pending.delete(file))
  return result
}
