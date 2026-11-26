import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

const { version, repository } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string
  repository: { url: string }
}
const actionsRepository = process.env.GITHUB_ACTIONS === 'true' ? process.env.GITHUB_REPOSITORY : undefined
const githubUrl = actionsRepository && /^[\w.-]+\/[\w.-]+$/.test(actionsRepository)
  ? `https://github.com/${actionsRepository}`
  : repository.url.replace(/^git\+/, '').replace(/\.git$/, '')

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()], build: { rollupOptions: { output: { format: 'es', entryFileNames: 'index.mjs' } } } },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: {
    define: {
      __APP_VERSION__: JSON.stringify(version),
      __APP_GITHUB_URL__: JSON.stringify(githubUrl)
    },
    resolve: { alias: { '@': fileURLToPath(new URL('./src/renderer/src', import.meta.url)) } },
    plugins: [react(), tailwindcss(), {
      name: 'development-refresh-csp',
      apply: 'serve',
      transformIndexHtml: html => html.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
    }]
  }
})
