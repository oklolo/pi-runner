import { Fragment } from 'react'
import type { ChatWorkItem } from '../../../../shared/models'
import { ModelIcon } from './ModelIcon'

type Part = { text: string; emphasis?: boolean; review?: NonNullable<ChatWorkItem['aiReviewDetails']>[number] }
const decisions = { allow: '已通过', ask: '需你确认', deny: '已拒绝' }

function summaryParts(item: ChatWorkItem): Part[] {
  if (item.kind === 'thinking') return [{ text: item.content }]
  const args = item.args ?? {}
  const text = (key: string) => typeof args[key] === 'string' ? args[key] as string : ''
  const fallback = text('command') || text('path') || text('file') || JSON.stringify(args)
  const pair = (first: string, second: string): Part[] => [
    { text: first, emphasis: Boolean(first && second) }, { text: second }
  ].filter(part => part.text)
  let parts: Part[]
  if (['read_many', 'write_many', 'edit_many', 'download_many'].includes(item.name ?? '') && Array.isArray(args.items)) {
    const paths = args.items.flatMap(value => value && typeof value === 'object' && 'path' in value && typeof value.path === 'string' ? [value.path] : [])
    parts = [{ text: `${args.items.length} 个文件` }, { text: paths.join('、') }]
  } else if (item.name === 'grep' || item.name === 'find') {
    parts = pair(text('pattern'), text('path') || '.')
    if (args.ignoreCase === true) parts.push({ text: '忽略大小写' })
    if (text('glob')) parts.push({ text: text('glob') })
  } else if (['move', 'copy', 'download'].includes(item.name ?? '')) {
    const source = item.name === 'download' ? text('url') : text('path')
    const target = item.name === 'download' ? text('path') : text('destination')
    parts = [{ text: source + (source && target ? ' → ' : '') }, { text: target, emphasis: Boolean(source && target) }]
  } else if (item.name === 'read_skill_file' || item.name === 'report_skill_usage') {
    parts = pair(item.skillName || text('skillId'), item.name === 'read_skill_file' ? text('file') : text('purpose'))
  } else if (item.name === 'read' && typeof args.offset === 'number') {
    const range = typeof args.limit === 'number' ? `第 ${args.offset}–${args.offset + args.limit - 1} 行` : `从第 ${args.offset} 行开始`
    parts = pair(text('path'), range)
  } else if (item.name === 'rmdir' && args.recursive === true) {
    parts = pair(text('path'), '递归删除')
  } else if (item.name === 'submit_plan') {
    parts = [{ text: text('title') || fallback }]
  } else if (item.name === 'ask_user_question' && Array.isArray(args.questions)) {
    parts = args.questions.flatMap(value => {
      if (!value || typeof value !== 'object') return []
      const question = value as Record<string, unknown>
      return pair(typeof question.header === 'string' ? question.header : '', typeof question.question === 'string' ? question.question : '')
    })
  } else {
    parts = [{ text: fallback }]
  }
  if (item.skillName && item.name !== 'read_skill_file' && item.name !== 'report_skill_usage') {
    parts = [{ text: item.skillName, emphasis: true }, ...parts]
  }
  return parts.filter(part => part.text)
}

export function WorkItemSummary({ item, stateText }: { item: ChatWorkItem; stateText: string }): React.JSX.Element {
  const summary = summaryParts(item)
  const isCommand = item.name === 'bash' || item.name === 'powershell'
  const status: Part[] = []
  if (item.aiReview) {
    status.push({ text: `${Array.isArray(item.args?.items) ? '部分操作最严格结论：' : ''}${decisions[item.aiReview]}`, emphasis: true })
  }
  if (item.aiReview && !isCommand) {
    const models = new Set<string>()
    for (const review of item.aiReviewDetails ?? []) {
      const key = `${review.provider ?? ''}:${review.model ?? ''}`
      if (!review.model || models.has(key)) continue
      models.add(key)
      status.push({ text: review.model, review })
    }
  }
  if (stateText) status.push({ text: stateText, emphasis: true })
  const parts = isCommand ? [...status, ...summary] : [...summary, ...status]
  const title = parts.map(part => part.text).join(' · ').replace(' →  · ', ' → ')
  return <small className="chat-work-preview" title={title}>{parts.map((part, index) => <Fragment key={index}>
    {index > 0 && !parts[index - 1].text.endsWith(' → ') && ' · '}
    <span className={part.emphasis ? 'chat-work-preview-emphasis' : undefined}>{part.review && <ModelIcon model={part.review.model} provider={part.review.provider} size={12} />}{part.review && ' '}{part.text}</span>
  </Fragment>)}</small>
}
