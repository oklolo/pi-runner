import { open, readdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import { normalizeCodeRanges, type CodePreview } from '../shared/code-preview'

const MAX_BYTES = 2 * 1024 * 1024
function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file)
  return !!relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

const SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules', '.tmp'])

/** 模型省略目录时仅接受项目内唯一的同名文件，不跟随目录符号链接。 */
async function resolvePreviewFile(project: string, filename: string): Promise<string> {
  const resolved = path.resolve(project, filename)
  try { return await realpath(resolved) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('文件无法访问，请检查访问权限后重试')
  }
  if (path.isAbsolute(filename) || /[\\/]/.test(filename)) throw new Error('文件不存在，请确认报告中的文件路径后重试')
  const matches: string[] = []
  const directories = [project]
  let scanned = 0
  while (directories.length) {
    const directory = directories.pop()!
    let entries
    try { entries = await readdir(directory, { withFileTypes: true }) }
    catch { throw new Error('无法完整查找项目文件，请在报告中使用相对项目的完整路径') }
    for (const entry of entries) {
      if (++scanned > 20000) throw new Error('项目文件过多，请在报告中使用相对项目的完整路径')
      if (entry.isDirectory() && !SKIPPED_DIRECTORIES.has(entry.name)) directories.push(path.join(directory, entry.name))
      else if (entry.isFile() && entry.name === filename) {
        matches.push(path.join(directory, entry.name))
        if (matches.length > 1) throw new Error('项目中存在多个同名文件，请在报告中使用相对项目的完整路径')
      }
    }
  }
  if (!matches.length) throw new Error('文件不存在或无法访问，请确认文件路径后重试')
  return realpath(matches[0])
}

/** 只读取项目内的当前文本文件；真实路径校验阻止符号链接越界。 */
export async function readCodePreview(project: string, filename: string, input: unknown): Promise<CodePreview> {
  const ranges = normalizeCodeRanges(input)
  if (!path.isAbsolute(project) || !filename || filename.includes('\0')) throw new Error('文件路径无效')
  const resolved = path.resolve(project, filename)
  if (!inside(project, resolved)) throw new Error('只能预览当前项目内的代码文件')
  const root = await realpath(project).catch(() => { throw new Error('项目不存在或无法访问') })
  const file = await resolvePreviewFile(project, filename)
  if (!inside(root, file)) throw new Error('只能预览当前项目内的代码文件')
  const handle = await open(file, 'r').catch(() => { throw new Error('无法读取文件，请检查访问权限后重试') })
  let content: string
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error('所选路径不是代码文件')
    if (info.size > MAX_BYTES) throw new Error('文件超过 2 MB，无法预览')
    const buffer = Buffer.alloc(MAX_BYTES + 1)
    let bytes = 0
    while (bytes < buffer.length) {
      const read = await handle.read(buffer, bytes, buffer.length - bytes, null)
      if (!read.bytesRead) break
      bytes += read.bytesRead
    }
    if (bytes > MAX_BYTES) throw new Error('文件超过 2 MB，无法预览')
    if (buffer.subarray(0, bytes).includes(0)) throw new Error('二进制文件不支持代码预览')
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytes)) }
    catch { throw new Error('文件不是有效的 UTF-8 文本，无法预览') }
  } finally { await handle.close() }
  const lines = content.split(/\r\n|\n|\r/)
  if (lines.length > 1 && lines.at(-1) === '') lines.pop()
  if (ranges.some(range => range.end > lines.length)) throw new Error(`指定行号超出文件范围，当前文件共 ${lines.length} 行；请核对报告与当前文件版本`)
  const context = normalizeCodeRanges(ranges.map(range => ({ start: Math.max(1, range.start - 10), end: Math.min(lines.length, range.end + 10) })))
  if (context.reduce((sum, range) => sum + range.end - range.start + 1, 0) > 20000) throw new Error('指定代码超过 20000 行，请缩小定位范围')
  return { path: path.relative(root, file), totalLines: lines.length, content, sections: context.map(range => ({ start: range.start, lines: lines.slice(range.start - 1, range.end) })) }
}
