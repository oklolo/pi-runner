import { mkdir, open, readFile, writeFile, rename, unlink, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { MAX_CUSTOM_PROMPT_LENGTH } from '../shared/models'
import { withSharedFileLock } from './models/shared-file-lock'

async function atomicWrite(file: string, content: string, expected?: string): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx', flush: true })
    if (expected !== undefined) {
      let latest = ''
      try { latest = await readPrompt(file) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      if (latest !== expected) throw new Error('提示词文件在保存期间发生变化，请重新加载或确认覆盖')
    }
    await rename(temporary, file)
  } finally { await unlink(temporary).catch(() => {}) }
}

/** 先限制字节数，避免误选超大 AGENTS.md 后在主进程解析整个文件。 */
async function readPrompt(file: string): Promise<string> {
  const handle = await open(file, 'r')
  try {
    if (!(await handle.stat()).isFile()) throw new Error('提示词文件必须是普通文件')
    const buffer = Buffer.alloc(MAX_CUSTOM_PROMPT_LENGTH * 4 + 1)
    let size = 0
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size)
      if (!bytesRead) break
      size += bytesRead
    }
    if (size === buffer.length) throw new Error('提示词文件过大')
    return buffer.subarray(0, size).toString('utf8')
  } finally { await handle.close() }
}

export class PromptFiles {
  private queue: Promise<unknown> = Promise.resolve()
  constructor(private readonly dataDirectory: string) {}

  access(project: unknown, legacy: unknown, save?: unknown, expected?: unknown): Promise<string> {
    // 同一进程排队，多个组件同时初始化不会互相抢锁。
    const result = this.queue.then(() => withSharedFileLock(path.join(this.dataDirectory, 'prompt-files'), () => this.sync(project, legacy, save, expected)))
    this.queue = result.catch(() => undefined)
    return result
  }

  private async sync(project: unknown, legacy: unknown, save?: unknown, expected?: unknown): Promise<string> {
    if (project !== null && (typeof project !== 'string' || !path.isAbsolute(project))) throw new Error('项目目录无效')
    const validate = (value: unknown): string => {
      if (typeof value !== 'string' || value.length > MAX_CUSTOM_PROMPT_LENGTH) throw new Error(`提示词必须为文本且不能超过 ${MAX_CUSTOM_PROMPT_LENGTH} 个字符`)
      return value
    }
    const file = path.join(project === null ? this.dataDirectory : project as string, 'AGENTS.md')
    const key = process.platform === 'win32' ? file.toLowerCase() : file
    const marker = path.join(this.dataDirectory, 'prompt-file-migrations.json')
    try {
      if (project !== null && !(await stat(project as string)).isDirectory()) throw new Error('项目目录不存在')
      let migrated: string[] = []
      try { migrated = JSON.parse(await readFile(marker, 'utf8')) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      if (!Array.isArray(migrated) || !migrated.every(item => typeof item === 'string')) throw new Error('提示词迁移记录无效')
      let content = ''
      let missing = false
      try { content = validate(await readPrompt(file)) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        missing = true
      }
      if (project === null) await mkdir(path.dirname(file), { recursive: true })
      if (save !== undefined) {
        if (typeof expected !== 'string' || content !== expected) throw new Error('提示词文件已变化，请重新加载或确认覆盖')
        content = validate(save)
        await atomicWrite(file, content, expected)
      } else if (missing && !migrated.includes(key)) {
        content = validate(legacy)
        if (content) await atomicWrite(file, content, '')
      }
      if (!migrated.includes(key)) {
        await mkdir(this.dataDirectory, { recursive: true })
        await atomicWrite(marker, JSON.stringify([...migrated, key]))
      }
      return content
    } catch (error) {
      throw new Error(`无法同步提示词文件 ${file}：${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
