import { createReadStream } from 'node:fs'
import { parentPort, workerData } from 'node:worker_threads'
import { SessionManager, type FileEntry } from '@earendil-works/pi-coding-agent'
import { sessionTranscript } from './session-transcript'

async function restore(): Promise<void> {
  const { file, skills } = workerData as { file: string; skills: [string, { name: string }][] }
  const entries: FileEntry[] = []
  const fragments: Buffer[] = []
  let size = 0
  const parse = (line: string, tail = false): void => {
    if (!line.trim()) return
    let entry: FileEntry
    try { entry = JSON.parse(line) }
    catch (error) {
      // 只有最后一个未提交的残行可忽略；不修改原文件，也不跳过损坏的完整行。
      if (tail) return
      throw error
    }
    if (!entry || typeof entry !== 'object' || typeof entry.type !== 'string') throw new Error('代理历史记录无效')
    entries.push(entry)
  }
  for await (const chunk of createReadStream(file, { highWaterMark: 64 * 1024 })) {
    const buffer = chunk as Buffer
    let start = 0
    while (start < buffer.length) {
      const end = buffer.indexOf(10, start)
      const part = buffer.subarray(start, end < 0 ? buffer.length : end)
      fragments.push(part); size += part.length
      if (end < 0) break
      parse(Buffer.concat(fragments, size).toString('utf8'))
      fragments.length = 0; size = 0
      start = end + 1
    }
  }
  if (size) parse(Buffer.concat(fragments, size).toString('utf8'), true)
  const header = entries[0]
  if (!header || header.type !== 'session' || typeof header.id !== 'string') throw new Error('代理历史缺少有效文件头')
  // 只在内存迁移旧格式，恢复窗口不能触发 SDK 对原生历史的同步修复或重写。
  const manager = SessionManager.inMemory(typeof header.cwd === 'string' ? header.cwd : process.cwd(), undefined, entries)
  parentPort?.postMessage({ ok: true, messages: sessionTranscript(manager, new Map(skills)) })
}

void restore().catch(() => parentPort?.postMessage({ ok: false }))
