import { openSync, readSync, closeSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

/** Windows Chromium safeStorage 的 AES 密钥由 Local State 中的 DPAPI 密文保存。
 * 必须在 app ready / 首次 safeStorage 调用前同步，不能复制整个浏览器状态。
 * 不接触明文密钥或授权文件，也不回写正式版。
 */
export function shareWindowsEncryptionKey(source: string, destination: string): void {
  const read = (directory: string): Record<string, unknown> | undefined => {
    let fd: number | undefined
    try {
      fd = openSync(path.join(directory, 'Local State'), 'r')
      const buffer = Buffer.alloc(4 * 1024 * 1024 + 1)
      let size = 0
      while (size < buffer.length) {
        const count = readSync(fd, buffer, size, buffer.length - size, size)
        if (!count) break
        size += count
      }
      if (size === buffer.length) throw new Error('浏览器 Local State 文件异常过大，已停止同步安全存储密钥；原文件已保留')
      const value: unknown = JSON.parse(buffer.subarray(0, size).toString('utf8'))
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('浏览器 Local State 格式无效，原文件已保留')
      return value as Record<string, unknown>
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
    finally { if (fd !== undefined) closeSync(fd) }
  }
  const production = read(source)
  const crypto = production?.os_crypt as Record<string, unknown> | undefined
  if (typeof crypto?.encrypted_key !== 'string' || !crypto.encrypted_key) return
  const development = read(destination) ?? {}
  const existing = development.os_crypt as Record<string, unknown> | undefined
  if (existing?.encrypted_key === crypto.encrypted_key) return
  development.os_crypt = { ...existing, encrypted_key: crypto.encrypted_key }
  mkdirSync(destination, { recursive: true })
  const temporary = path.join(destination, `Local State.${randomUUID()}.tmp`)
  writeFileSync(temporary, JSON.stringify(development), { flag: 'wx', mode: 0o600 })
  renameSync(temporary, path.join(destination, 'Local State'))
}
