import { Button } from '@/components/ui/button'
import { Minus } from 'lucide-react'

interface WindowTitleBarProps {
  pageTitle: string
  projectName: string | null
  isMaximized: boolean
  onMinimize: () => void
  onToggleMaximize: () => void
  onClose: () => void
}

export function WindowTitleBar({ pageTitle, projectName, isMaximized, onMinimize, onToggleMaximize, onClose }: WindowTitleBarProps): React.JSX.Element {
  return <div className="window-titlebar">
    <div className="window-titlebar-drag" onDoubleClick={onToggleMaximize}>
      <div className="window-brand">
        <img className="window-app-mark" src="./icons/app-icon.png" alt="" draggable={false} />
        <span className="window-app-name">Pi Runner · 行动派</span>
      </div>
      <div className="window-context-title" title={projectName ? `${pageTitle} · ${projectName}` : pageTitle}>
        <span className="window-page-title">{pageTitle}</span>
        {projectName && <span className="window-project-title"> · {projectName}</span>}
      </div>
    </div>
    <div className="window-controls">
      <Button aria-label="最小化" onClick={onMinimize}><Minus size={15} /></Button>
      <Button aria-label={isMaximized ? '还原' : '最大化'} onClick={onToggleMaximize}><svg aria-hidden="true" viewBox="0 0 10 10">{isMaximized ? <path d="M2.5 2.5V.5h7v7h-2M.5 2.5h7v7h-7z" /> : <path d="M.5.5h9v9h-9z" />}</svg></Button>
      <Button className="window-close" aria-label="关闭" onClick={onClose}><svg aria-hidden="true" viewBox="0 0 10 10"><path d="M.5.5l9 9m0-9l-9 9" /></svg></Button>
    </div>
  </div>
}
