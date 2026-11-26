import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify('0.0.0-test') },
  resolve: { alias: { '@': fileURLToPath(new URL('./src/renderer/src', import.meta.url)) } }
})
