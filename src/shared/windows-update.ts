export type UpdateState = {
  phase: 'unsupported' | 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'installing'
  version?: string
  percent?: number
  message?: string
}

export const UPDATE_CHANNELS = { state: 'update:state', action: 'update:action', changed: 'update:changed' } as const
export type UpdateAction = 'check' | 'download' | 'install'
