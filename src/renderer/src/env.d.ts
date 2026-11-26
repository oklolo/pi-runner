import type { PiRunnerApi } from '../../shared/api'
declare global {
  const __APP_VERSION__: string
  const __APP_GITHUB_URL__: string
  interface Window { piRunner: PiRunnerApi }
}
