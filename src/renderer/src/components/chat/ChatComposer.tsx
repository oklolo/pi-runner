import { memoWithStableCallbacks } from '../../lib/memo-with-callbacks'
import { useEffect, useId, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ArrowUp, Check, LoaderCircle, Square } from 'lucide-react'
import { ComposerAddMenu, ComposerSkillTags, useLocalSkills } from './ComposerAddMenu'
import { useSlashSkillPicker } from './SlashSkillPicker'
import { MessageQueue, type MessageQueueProps } from './MessageQueue'
import { IntentModePicker } from './IntentModePicker'
import { PermissionModePicker } from './PermissionModePicker'
import type { PermissionMode, IntentMode } from '../../../../shared/models'
import { MAX_ATTACHMENT_BYTES, MAX_MESSAGE_ATTACHMENTS, type ChatImage, type ModelProfileView, type ModelProviderConnection } from '../../../../shared/models'
import { attachmentMime } from '../../../../shared/attachments'
import { ChatImages } from './ChatImages'
import { ConversationModelPicker } from './ConversationModelPicker'

const TEXT_ATTACHMENT_MIN_CHARACTERS = 2000
const TEXT_ATTACHMENT_MIN_LINES = 20

interface ChatComposerProps extends MessageQueueProps {
  active?: boolean
  onCancelEdit?: () => void
  intentMode?: IntentMode
  onIntentChange?(mode: IntentMode): void
  permissionMode?: PermissionMode
  onPermissionChange?: (mode: PermissionMode) => Promise<void>
  profile: ModelProfileView | undefined
  profiles?: ModelProfileView[]
  providers?: ModelProviderConnection[]
  onSelectModel?: (id: string) => void
  /** 快捷面板内修改当前模型的推理档位。 */
  onThinkingChange?: (profile: ModelProfileView, value: boolean | string | null) => Promise<void> | void
  prompt: string
  images: ChatImage[]
  skillIds?: string[]
  onSkillsChange?: (ids: string[]) => void
  isBusy: boolean
  stopping?: boolean
  hasMessages: boolean
  settingsDisabled?: boolean
  sendWithCtrlEnter: boolean
  onPromptChange: (prompt: string) => void
  onReadingChange?(reading: boolean): void
  onImagesChange: (images: ChatImage[]) => void
  onOpenSettings: (section?: 'models' | 'skills') => void
  onSend: () => void
  onCancel: () => void
}

function ChatComposerView({ onReadingChange, active = true, queue = [], editingId, queuePaused, onResumeQueue, onEditQueued, onDeleteQueued, onReorderQueued, onCancelEdit, intentMode = 'execute', onIntentChange, permissionMode = 'default', onPermissionChange, profile, profiles, providers, onSelectModel, onThinkingChange, prompt, images, skillIds = [], onSkillsChange = () => {}, isBusy, stopping = false, hasMessages, settingsDisabled, sendWithCtrlEnter, onPromptChange, onImagesChange, onOpenSettings, onSend, onCancel }: ChatComposerProps): React.JSX.Element {
  const localSkills = useLocalSkills()
  const promptId = useId()
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const readingRef = useRef(false)
  const [reading, setReading] = useState(false)
  const [imageError, setImageError] = useState('')
  const [composerFocused, setComposerFocused] = useState(false)
  const focusVersion = useRef(0)
  const hasContent = Boolean(prompt.trim() || images.length)
  const canSubmit = hasContent && !reading && Boolean(editingId || (profile && !settingsDisabled))
  const slashSkills = useSlashSkillPicker({ prompt, textareaRef, available: localSkills, skillIds, onSkillsChange, onPromptChange, disabled: reading || !active })
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform) || navigator.userAgent.includes('Macintosh')
  const sendShortcut = isMac ? '⌘ + Enter' : 'Ctrl + Enter'

  useEffect(() => { if (editingId && active) textareaRef.current?.focus() }, [editingId, active])

  const addImages = async (files: File[]): Promise<void> => {
    if (readingRef.current || !files.length) return
    setImageError('')
    if (files.some(file => file.size > MAX_ATTACHMENT_BYTES)) { setImageError('每个附件不能超过 32 MB。'); return }
    readingRef.current = true; setReading(true); onReadingChange?.(true)
    try {
      const added = await Promise.all(files.map(file => new Promise<ChatImage>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => {
          const data = String(reader.result).split(',')[1] ?? ''
          const mime = attachmentMime(file.name, file.type)
          resolve({ id: crypto.randomUUID(), name: file.name.slice(0, 255) || '粘贴的附件', dataUrl: `data:${mime};base64,${data}` })
        }
        reader.onerror = () => reject(new Error('附件读取失败，请重试。'))
        reader.onabort = () => reject(new Error('附件读取已取消，请重试。'))
        reader.readAsDataURL(file)
      })))
      const unique = [...images]
      for (const file of added) {
        if (!unique.some(existing => existing.name === file.name && existing.dataUrl === file.dataUrl)) unique.push(file)
      }
      if (unique.length > MAX_MESSAGE_ATTACHMENTS) { setImageError(`最多添加 ${MAX_MESSAGE_ATTACHMENTS} 个附件。`); return }
      if (unique.length !== images.length) onImagesChange(unique)
    } catch (error) { setImageError(error instanceof Error ? error.message : '附件读取失败，请重试。') }
    finally { readingRef.current = false; setReading(false); onReadingChange?.(false) }
  }

  return <form className="composer" onFocusCapture={() => {
    focusVersion.current++
    setComposerFocused(true)
  }} onBlurCapture={() => {
    const version = focusVersion.current
    // React Portal 内的菜单也属于输入区域，等其焦点事件完成再判断是否离开。
    queueMicrotask(() => { if (focusVersion.current === version) setComposerFocused(false) })
  }} onClick={event => {
    const target = event.target
    if (!(target instanceof HTMLElement) || !event.currentTarget.contains(target)) return
    if (target.closest('button, a, input, textarea, select, label, [role="button"], [role="combobox"], [role="menuitem"], [contenteditable="true"], [tabindex], .chat-image')) return
    textareaRef.current?.focus({ preventScroll: true })
  }} onSubmit={event => { event.preventDefault(); if (canSubmit && !readingRef.current && !slashSkills.isComposing()) onSend() }} onDragOver={event => {
    if (event.dataTransfer.types.includes('Files')) event.preventDefault()
  }} onDrop={event => {
    if (!event.dataTransfer.files.length) return
    event.preventDefault(); void addImages(Array.from(event.dataTransfer.files))
  }}>
    <MessageQueue queue={queue} editingId={editingId} queuePaused={queuePaused} onResumeQueue={onResumeQueue} onEditQueued={reading ? undefined : onEditQueued} onDeleteQueued={reading ? undefined : onDeleteQueued} onReorderQueued={onReorderQueued} />
    {editingId && <div className="queue-edit-status"><span>{queuePaused ? '编辑队列消息中，保存后队列仍暂停' : '编辑队列消息中，保存后恢复执行'}</span><Button type="button" variant="ghost" size="sm" disabled={reading} onClick={onCancelEdit}>取消编辑</Button></div>}
    {active && <div className={`composer-attachments${images.length ? ' is-expanded' : ''}`} aria-hidden={!images.length}>
      <div className="composer-attachments-inner">
        <ChatImages images={images} disabled={reading} onRemove={id => onImagesChange(images.filter(image => image.id !== id))} />
      </div>
    </div>}
    <ComposerSkillTags ids={skillIds} skills={localSkills.skills} disabled={reading} onChange={onSkillsChange} />
    {imageError && <p className="composer-image-error" role="alert">{imageError}</p>}
    <input ref={fileRef} type="file" multiple hidden aria-label="选择文件附件" onChange={event => {
      void addImages(Array.from(event.target.files ?? [])); event.target.value = ''
    }} />
    <Label className="sr-only" htmlFor={promptId}>消息</Label>
    {slashSkills.popup}
    <Textarea {...slashSkills.inputProps} ref={textareaRef} rows={1} id={promptId} aria-label="消息" value={prompt} maxLength={32000} placeholder={hasMessages ? '继续聊一聊…' : '描述你想完成的任务…'} onChange={event => { onPromptChange(event.target.value); slashSkills.onChange() }} onPaste={event => {
      const files = Array.from(event.clipboardData.items).filter(item => item.kind === 'file').map(item => item.getAsFile()).filter((file): file is File => Boolean(file))
      if (files.length) { event.preventDefault(); void addImages(files); return }
      const text = event.clipboardData.getData('text/plain')
      if (text.length >= TEXT_ATTACHMENT_MIN_CHARACTERS || text.split(/\r\n|\r|\n/).length >= TEXT_ATTACHMENT_MIN_LINES) {
        event.preventDefault()
        let name = '粘贴内容'
        for (let index = 2; images.some(file => file.name === name); index++) name = `粘贴内容-${index}`
        void addImages([new File([text], name, { type: 'text/plain' })])
      }
    }} onKeyDown={event => {
      // 以组合输入生命周期为准，不仅依赖部分输入法可能遗漏的键盘事件标记。
      if (slashSkills.isComposing() || event.nativeEvent.isComposing || event.keyCode === 229) return
      if (slashSkills.onKeyDown(event)) return
      if (event.key !== 'Enter') return
      const shouldSend = sendWithCtrlEnter ? (isMac ? event.metaKey : event.ctrlKey) : !event.shiftKey
      if (shouldSend) { event.preventDefault(); if (canSubmit && !readingRef.current) onSend() }
    }} />
    {active && <ComposerActions available={localSkills} skillIds={skillIds} onSkillsChange={onSkillsChange} reading={reading} filesDisabled={reading || images.length >= MAX_MESSAGE_ATTACHMENTS} onAddFiles={() => fileRef.current?.click()}
      intentMode={intentMode} onIntentChange={onIntentChange} permissionMode={permissionMode} onPermissionChange={onPermissionChange} profile={profile} profiles={profiles} providers={providers} onSelectModel={onSelectModel} onThinkingChange={onThinkingChange}
      isBusy={isBusy} stopping={stopping} settingsDisabled={settingsDisabled} editingId={editingId} hasContent={hasContent} composerFocused={composerFocused} sendWithCtrlEnter={sendWithCtrlEnter} sendShortcut={sendShortcut} onOpenSettings={onOpenSettings} onCancel={onCancel} />}
  </form>
}

interface ComposerActionsProps extends Pick<ChatComposerProps, 'intentMode' | 'onIntentChange' | 'permissionMode' | 'onPermissionChange' | 'profile' | 'profiles' | 'providers' | 'onSelectModel' | 'onThinkingChange' | 'isBusy' | 'stopping' | 'settingsDisabled' | 'editingId' | 'sendWithCtrlEnter' | 'onOpenSettings' | 'onCancel'> {
  available: ReturnType<typeof useLocalSkills>
  skillIds: string[]
  onSkillsChange(ids: string[]): void
  reading: boolean
  filesDisabled: boolean
  onAddFiles(): void
  hasContent: boolean
  composerFocused: boolean
  sendShortcut: string
}

/** 工具栏只关心是否有内容，不随每个字符重建模型选择器、技能菜单和 Tooltip。 */
const ComposerActions = memoWithStableCallbacks(function ComposerActions({ available, skillIds, onSkillsChange, reading, filesDisabled, onAddFiles, intentMode = 'execute', onIntentChange, permissionMode = 'default', onPermissionChange, profile, profiles, providers, onSelectModel, onThinkingChange, isBusy, stopping, settingsDisabled, editingId, hasContent, composerFocused, sendWithCtrlEnter, sendShortcut, onOpenSettings, onCancel }: ComposerActionsProps): React.JSX.Element {
  const [retainQueueAction, setRetainQueueAction] = useState(false)
  const stopAllowedAt = useRef(Number.POSITIVE_INFINITY)
  useEffect(() => {
    // 原位切换后短暂屏蔽停止操作，防止发送时的连续点击误停新任务。
    stopAllowedAt.current = isBusy ? performance.now() + 500 : Number.POSITIVE_INFINITY
  }, [isBusy])
  useEffect(() => {
    if (!isBusy || !composerFocused) setRetainQueueAction(false)
    else if (hasContent || editingId) setRetainQueueAction(true)
  }, [isBusy, composerFocused, hasContent, editingId])
  const showSubmit = isBusy && (Boolean(editingId) || hasContent || (composerFocused && retainQueueAction))
  const submitLabel = editingId ? '保存队列消息' : isBusy ? '加入队列' : '发送消息'
  return <div className="composer-actions">
      <div className="composer-tools">
        <ComposerAddMenu available={available} ids={skillIds} onChange={onSkillsChange} disabled={reading} filesDisabled={filesDisabled} onConfigureSkills={() => onOpenSettings('skills')} onAddFiles={onAddFiles} />
        <IntentModePicker mode={intentMode} onChange={onIntentChange} disabled={isBusy || settingsDisabled} />
        {reading ? <span className="composer-mode">正在添加附件…</span> : <PermissionModePicker mode={permissionMode} disabled={settingsDisabled || !onPermissionChange} onChange={onPermissionChange ?? (async () => {})} />}
      </div>
      <div>
        <ConversationModelPicker profile={profile} profiles={profiles ?? (profile ? [profile] : [])} providers={providers} disabled={isBusy || settingsDisabled} onSelect={onSelectModel ?? (() => undefined)} onThinkingChange={onThinkingChange} onOpenSettings={onOpenSettings} />
        <div className={`composer-submit-actions${isBusy ? ' is-busy' : ''}`}>
          <div className={`composer-submit-slot${showSubmit ? ' is-visible' : ''}`} aria-hidden={!showSubmit}>
            <Tooltip><TooltipTrigger asChild><Button type="submit" className="send-button" aria-label={submitLabel} tabIndex={showSubmit ? 0 : -1} disabled={!showSubmit || (!editingId && (!profile || settingsDisabled)) || reading || !hasContent}>{editingId ? <Check size={19} aria-hidden="true" /> : <ArrowUp size={19} aria-hidden="true" />}</Button></TooltipTrigger><TooltipContent side="top">{`${submitLabel}（${sendWithCtrlEnter ? sendShortcut : 'Enter'}）`}</TooltipContent></Tooltip>
          </div>
          {!isBusy ? <Tooltip><TooltipTrigger asChild><Button type="submit" className="send-button" aria-label={submitLabel} disabled={(!editingId && (!profile || settingsDisabled)) || reading || !hasContent}>{editingId ? <Check size={19} aria-hidden="true" /> : <ArrowUp size={19} aria-hidden="true" />}</Button></TooltipTrigger><TooltipContent side="top">{`${submitLabel}（${sendWithCtrlEnter ? sendShortcut : 'Enter'}）`}</TooltipContent></Tooltip> : <>
            {stopping && <span className="sr-only" role="status">正在停止任务…</span>}
            <Tooltip><TooltipTrigger asChild><Button type="button" className="send-button stop-button" aria-label={stopping ? '正在停止任务' : '停止任务'} disabled={stopping} onClick={event => {
              if (performance.now() < stopAllowedAt.current || event.detail > 1) return
              onCancel()
            }}>{stopping ? <LoaderCircle size={14} className="animate-spin" aria-hidden="true" /> : <Square size={14} aria-hidden="true" />}</Button></TooltipTrigger><TooltipContent side="top">{stopping ? '正在停止任务…' : '停止任务'}</TooltipContent></Tooltip>
          </>}
        </div>
      </div>
    </div>
})

export const ChatComposer = memoWithStableCallbacks(ChatComposerView)
