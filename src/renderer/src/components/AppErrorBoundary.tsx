import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { WindowTitleBar } from './WindowTitleBar'

export class AppErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } { return { failed: true } }
  componentDidCatch(error: Error, info: ErrorInfo): void { console.error('界面初始化或渲染失败:', error, info.componentStack) }
  render(): ReactNode {
    if (!this.state.failed) return this.props.children
    return <div className="window-shell">
      <WindowTitleBar pageTitle="界面加载失败" projectName={null} isMaximized={false}
        onMinimize={() => { void window.piRunner?.minimizeWindow() }}
        onToggleMaximize={() => { void window.piRunner?.toggleMaximizeWindow() }}
        onClose={() => { void window.piRunner?.closeWindow() }} />
      <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-4 p-8">
        <h1 className="text-lg font-semibold">界面加载失败</h1>
        <p className="text-sm text-muted-foreground">本地会话与供应商数据已保留。可重新加载恢复已保存的内容，尚未保存的输入可能丢失。</p>
        <Button onClick={() => window.location.reload()}>重新加载</Button>
      </div>
    </div>
  }
}
