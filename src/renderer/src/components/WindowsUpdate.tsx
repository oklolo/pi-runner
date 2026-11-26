import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Download, LoaderCircle, RefreshCw } from 'lucide-react'
import type { UpdateAction, UpdateState } from '../../../shared/windows-update'

export function useWindowsUpdate() {
  const [state, setState] = useState<UpdateState>({ phase: 'unsupported' })
  useEffect(() => {
    let active = true
    let received = false
    const unsubscribe = window.piRunner?.onUpdateState?.(next => { received = true; setState(next) })
    void window.piRunner?.getUpdateState?.().then(next => { if (active && !received) setState(next) }).catch(() => {})
    return () => { active = false; unsubscribe?.() }
  }, [])
  return state
}

export function runUpdateAction(action: UpdateAction) {
  void window.piRunner.updateAction(action).catch(console.error)
}

export function UpdateToastAction() {
  const { phase, percent } = useWindowsUpdate()
  return <Button size="sm" variant="outline" disabled={phase !== 'available' && phase !== 'ready'} onClick={() => runUpdateAction(phase === 'ready' ? 'install' : 'download')}>
    {phase === 'downloading' ? <UpdateProgress percent={percent} /> :
      phase === 'installing' ? <><LoaderCircle size={14} aria-hidden="true" className="motion-safe:animate-spin" />正在更新…</> :
      phase === 'ready' ? <><RefreshCw size={14} aria-hidden="true" />立即更新</> : <><Download size={14} aria-hidden="true" />下载更新</>}
  </Button>
}

export function UpdateDot() {
  return <span className="pointer-events-none absolute -top-1 -right-2 size-1.5 rounded-full bg-[var(--error)]" aria-hidden="true" />
}

export function UpdateProgress({ percent = 0 }: { percent?: number }) {
  return <span className="inline-flex items-center gap-1 tabular-nums" aria-label={`下载进度 ${percent}%`}>
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" className="-rotate-90">
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" opacity=".25" />
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" pathLength="100" strokeDasharray={`${percent} 100`} />
    </svg>{percent}%
  </span>
}
