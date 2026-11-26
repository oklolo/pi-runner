import type { SessionManager } from '@earendil-works/pi-coding-agent'

/** SDK 的 getBranch 不检测循环；损坏的父链必须在调用它之前拒绝，不能永久占满主线程。 */
export function assertSessionTree(manager: SessionManager): void {
  const entries = manager.getEntries()
  const byId = new Map(entries.map(entry => [entry.id, entry]))
  if (byId.size !== entries.length || entries.some(entry => typeof entry.id !== 'string' || !entry.id)) throw new Error('代理历史存在重复或无效记录')
  const checked = new Set<string>()
  for (const entry of entries) {
    const visiting = new Set<string>()
    let current: typeof entry | undefined = entry
    while (current && !checked.has(current.id)) {
      if (visiting.has(current.id)) throw new Error('代理历史父链存在循环，原文件已保留')
      visiting.add(current.id)
      current = current.parentId ? byId.get(current.parentId) : undefined
    }
    for (const id of visiting) checked.add(id)
  }
}
