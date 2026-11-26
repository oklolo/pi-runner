import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

const staleLockMs = 60_000

function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
}

/** 新锁按持有进程判断，不抢夺仍在执行网络刷新或安全存储操作的实例。 */
async function clearStaleLock(lock: string): Promise<boolean> {
  try {
    const info = await stat(lock)
    const text = await readFile(lock, 'utf8')
    let pid: unknown
    try { pid = JSON.parse(text).pid }
    catch {
      // 兼容旧版提示词锁的 pid:token 格式；空锁仍采用过期保护。
      if (/^\d+:[\w-]+$/.test(text)) pid = Number(text.split(':')[0])
    }
    if (typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0) {
      if (processIsAlive(pid)) return false
    } else if (Date.now() - info.mtimeMs < staleLockMs) return false
    // 检查期间原持有者可能已经释放，不能删除另一个实例新建的锁。
    const current = await stat(lock)
    if (current.ino !== info.ino || current.birthtimeMs !== info.birthtimeMs || await readFile(lock, 'utf8') !== text) return false
    await unlink(lock)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
  }
}

/** 锁住整个读取—修改—替换操作，包括 OAuth 网络刷新。 */
export async function withSharedFileLock<T>(file: string, action: () => Promise<T>): Promise<T> {
  await mkdir(path.dirname(file), { recursive: true })
  const lock = `${file}.lock`
  const owner = JSON.stringify({ pid: process.pid, token: randomUUID() })
  const deadline = Date.now() + 30_000
  let handle
  while (!handle) {
    try { handle = await open(lock, 'wx', 0o600) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (await clearStaleLock(lock)) continue
      if (Date.now() >= deadline) throw new Error('共享模型配置或授权正在使用中，请稍后重试；若问题持续，请重启应用')
      await delay(50)
    }
  }
  try {
    await handle.writeFile(owner, 'utf8')
    return await action()
  } finally {
    await handle.close()
    if (await readFile(lock, 'utf8').catch(() => undefined) === owner) await unlink(lock).catch(() => undefined)
  }
}
