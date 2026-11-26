import { app, BrowserWindow, dialog, ipcMain, net } from 'electron'
import updater from 'electron-updater'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import * as fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { isTrustedRendererUrl } from './ipc-handlers'
import unzipper from 'unzipper'
import { UPDATE_CHANNELS, type UpdateState } from '../shared/windows-update'

const markerName = 'resources/pi-runner-update.json'
const installer = 'pi-runner-setup.exe'
const zipName = 'pi-runner-portable.zip'
const maxBytes = 2 ** 31
const checkInterval = 6 * 60 * 60 * 1000
const stable = /^(0|[1-9]\d{0,14})\.(0|[1-9]\d{0,14})\.(0|[1-9]\d{0,14})$/
type Channel = 'nsis' | 'zip'
type Marker = { channel: Channel; repository: string; files: Record<string, string>; directories?: string[] }
type Release = { version: string; channel: Channel; hash: string; size: number; stagedInstall?: true; startupAck?: boolean }

function takeStartupAckDirectory() {
  const supplied = process.env.PI_RUNNER_UPDATE_STARTUP_DIR
  delete process.env.PI_RUNNER_UPDATE_STARTUP_DIR
  if (!supplied || !app.isPackaged || process.platform !== 'win32' || !path.isAbsolute(supplied)) return
  const directory = path.resolve(supplied)
  const parent = path.dirname(path.dirname(process.execPath))
  if (path.dirname(directory).toLowerCase() === parent.toLowerCase() && /^\.pi-runner-update-[a-z0-9]+$/i.test(path.basename(directory))) return directory
}

function newer(version: string, current: string): boolean {
  if (!stable.test(version) || !stable.test(current.split('-')[0])) return false
  const candidate = version.split('.').map(Number)
  const installed = current.split('-')[0].split('.').map(Number)
  const first = candidate.findIndex((n, i) => n !== installed[i])
  return first < 0 ? current.includes('-') : candidate[first] > installed[first]
}

async function digest(file: string, channel: Channel, encoding: 'hex' | 'base64') {
  const hash = createHash(channel === 'zip' ? 'sha256' : 'sha512')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest(encoding)
}

function validate(release: Release, channel: Channel) {
  return release?.channel === channel && typeof release.version === 'string' && newer(release.version, app.getVersion()) &&
    (channel === 'zip' || release.stagedInstall === true) &&
    Number.isSafeInteger(release.size) && release.size > 0 && release.size <= maxBytes &&
    typeof release.hash === 'string' && (channel === 'zip' ? /^[a-f0-9]{64}$/ : /^[A-Za-z0-9+/]{86}==$/).test(release.hash)
}

async function response(url: string, timeout = 20000) {
  const result = await net.fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(timeout) })
  if (!result.ok) throw new Error(`GitHub HTTP ${result.status}`)
  return result
}

async function extract(file: string, root: string) {
  // 暂存目录中的 app.asar 是待写入的普通文件，不能交给 Electron 的 ASAR 虚拟文件系统处理。
  const diskFs: typeof import('node:fs') = createRequire(import.meta.url)('original-fs')
  const archive = await unzipper.Open.file(file)
  if (archive.files.length > 20000) throw new Error('更新包包含过多文件')
  let total = 0
  const seen = new Set<string>()
  for (const entry of archive.files) {
    const relative = entry.path.replace(/\/$/, '')
    const parts = relative.split('/')
    if (seen.has(relative.toLowerCase()) || parts.some(part => !part || /[\\:*?"<>|\x00-\x1f]|[. ]$/.test(part) || /^(?:CON|CONIN\$|CONOUT\$|PRN|AUX|NUL|COM[0-9¹²³]|LPT[0-9¹²³]) *(?:\.|$)/i.test(part))) {
      throw new Error('更新包包含不安全或重复的路径')
    }
    seen.add(relative.toLowerCase())
    const target = path.join(root, ...parts)
    if (entry.type === 'Directory') await diskFs.promises.mkdir(target, { recursive: true })
    else if (entry.type === 'File') {
      await diskFs.promises.mkdir(path.dirname(target), { recursive: true })
      await pipeline(entry.stream(), new Transform({ transform(chunk: Buffer, _, callback) {
        total += chunk.length
        callback(total > 4 * maxBytes ? new Error('解压大小超出限制') : null, chunk)
      } }), diskFs.createWriteStream(target, { flags: 'wx' }))
    } else throw new Error('更新包包含不支持的项目')
  }
}

export function registerWindowsUpdate(getWindow: () => BrowserWindow | null | undefined, rendererUrl: string, saveAndQuit: (apply: () => Promise<boolean>) => Promise<void>) {
  let state: UpdateState = { phase: 'unsupported' }
  let marker: Marker | undefined
  let release: Release | undefined
  let feed: InstanceType<typeof updater.NsisUpdater> | undefined
  let base = ''
  let confirmedDialog = false
  let startupAckDirectory = takeStartupAckDirectory()
  const set = (next: UpdateState) => {
    state = next
    const window = getWindow()
    if (!window || window.isDestroyed()) return
    const contents = window.webContents
    if (!contents.isDestroyed()) contents.send(UPDATE_CHANNELS.changed, state)
  }
  const cache = () => path.join(app.getPath('userData'), 'windows-update', marker!.channel)
  const packagePath = () => path.join(cache(), marker!.channel === 'zip' ? zipName : installer)
  const readyPath = () => path.join(cache(), 'ready.json')
  async function clearCache() {
    await Promise.allSettled([readyPath(), readyPath() + '.partial', packagePath(), packagePath() + '.partial'].map(file => fs.rm(file, { force: true })))
  }
  async function verify(info: Release, file = packagePath()) {
    if (!validate(info, marker!.channel)) throw new Error('更新版本或渠道无效')
    const stat = await fs.lstat(file)
    if (!stat.isFile() || stat.size !== info.size ||
      await digest(file, info.channel, info.channel === 'zip' ? 'hex' : 'base64') !== info.hash) throw new Error('更新包校验失败')
  }
  async function restore() {
    try {
      const info = JSON.parse(await fs.readFile(readyPath(), 'utf8')) as Release
      await verify(info)
      release = info
      set({ phase: 'ready', version: info.version })
      return true
    } catch { await clearCache(); return false }
  }
  const message = (error: unknown) => error instanceof Error ? error.message : String(error)
  const progress = (percent: number) => {
    if (!Number.isFinite(percent)) return
    percent = Math.min(99, Math.max(0, Math.floor(percent)))
    if (state.phase === 'downloading' && (state.percent ?? 0) < percent) set({ ...state, percent })
  }
  async function check(manual: boolean) {
    if (!marker || confirmedDialog || !['idle', 'available', 'ready'].includes(state.phase)) return
    const previousState = state
    const previous = state.phase === 'available' || state.phase === 'ready' ? release : undefined
    const clearRelease = (message?: string) => {
      release = undefined
      feed = undefined
      base = ''
      set({ phase: 'idle', message })
    }
    set({ phase: 'checking' })
    try {
      const result = await net.fetch(`https://api.github.com/repos/${marker.repository}/releases/latest`, { credentials: 'omit', signal: AbortSignal.timeout(20000) })
      if (result.status === 404) {
        const notice = manual ? '未找到公开的稳定版。' : undefined
        if (previousState.phase === 'ready') set({ ...previousState, message: notice })
        else clearRelease(notice)
        return
      }
      if (!result.ok) throw new Error(`GitHub HTTP ${result.status}`)
      const latest = await result.json() as { tag_name?: string; prerelease?: boolean; draft?: boolean }
      const version = typeof latest.tag_name === 'string' && latest.tag_name.startsWith('v') ? latest.tag_name.slice(1) : ''
      if (!stable.test(version) || latest.prerelease || latest.draft) throw new Error('GitHub 返回的稳定版标签无效')
      if (previousState.phase === 'ready' && previous && !newer(version, previous.version)) {
        set({ ...previousState, message: manual ? '已下载的版本可安装，未发现更高版本。' : previousState.message })
        return
      }
      if (!newer(version, app.getVersion())) {
        clearRelease(manual ? '当前已是最新稳定版。' : undefined)
        return
      }
      const nextBase = `https://github.com/${marker.repository}/releases/download/v${version}/`
      let nextRelease: Release
      let nextFeed: typeof feed
      if (marker.channel === 'zip') {
        const manifest = await (await response(nextBase + 'latest.yml')).json() as {
          version: string; startupAck?: boolean; portable: { name: string; size: number; sha256: string }
        }
        const info = manifest.portable
        if (info?.name !== zipName || manifest.version !== version) throw new Error('便携版更新元数据不匹配')
        nextRelease = { channel: 'zip', version, size: info.size, hash: info.sha256, startupAck: manifest.startupAck === true }
      } else {
        nextFeed = new updater.NsisUpdater({ provider: 'generic', url: nextBase, useMultipleRangeRequest: false })
        nextFeed.autoDownload = false
        nextFeed.autoInstallOnAppQuit = false
        nextFeed.allowPrerelease = false
        nextFeed.disableDifferentialDownload = true
        nextFeed.on('error', () => {}) // 操作失败由对应的 Promise 报告。
        nextFeed.on('download-progress', info => progress(info.percent))
        const result = await nextFeed.checkForUpdates()
        const info = result?.updateInfo
        const file = info?.files?.[0]
        if (info?.version !== version || info.files.length !== 1 || file?.url !== installer || 'packages' in info) throw new Error('安装版更新元数据不匹配')
        if (!('stagedInstall' in info) || info.stagedInstall !== true) throw new Error('此安装包不支持安全更新，请手动安装')
        nextRelease = { channel: 'nsis', version, size: file.size!, hash: file.sha512, stagedInstall: true, startupAck: 'startupAck' in info && info.startupAck === true }
      }
      if (!validate(nextRelease, marker.channel)) throw new Error('更新元数据无效')
      if (previousState.phase === 'ready') await clearCache()
      release = nextRelease
      base = nextBase
      feed = nextFeed
      set({ phase: 'available', version })
    } catch (error) {
      const failure = `检查更新失败：${message(error)}`
      if (previous) set(manual ? { ...previousState, message: failure } : previousState)
      else clearRelease(manual ? failure : undefined)
    }
  }
  async function download() {
    if (state.phase !== 'available' || !release) return
    const info = release
    set({ phase: 'downloading', version: info.version, percent: 0 })
    const temporary = packagePath() + '.partial'
    try {
      await fs.mkdir(cache(), { recursive: true })
      await fs.rm(temporary, { force: true })
      if (info.channel === 'nsis') {
        const [file] = await feed!.downloadUpdate()
        await fs.copyFile(file, temporary)
      } else {
        const result = await response(base + zipName, 30 * 60 * 1000)
        let received = 0
        const reader = result.body?.getReader()
        if (!reader) throw new Error('没有收到更新文件')
        async function* chunks() {
          try {
            for (;;) {
              const { done, value } = await reader!.read()
              if (done) return
              yield value
            }
          } finally { await reader!.cancel().catch(() => {}); reader!.releaseLock() }
        }
        await pipeline(Readable.from(chunks()), new Transform({ transform(chunk: Buffer, _, callback) {
          received += chunk.length
          progress(received / info.size * 100)
          callback(received > info.size ? new Error('更新包大小不匹配') : null, chunk)
        } }), createWriteStream(temporary, { flags: 'wx' }))
      }
      await verify(info, temporary)
      await fs.rename(temporary, packagePath())
      await fs.writeFile(readyPath() + '.partial', JSON.stringify(info))
      await fs.rename(readyPath() + '.partial', readyPath())
      set({ phase: 'ready', version: info.version })
    } catch (error) {
      await clearCache()
      set({ phase: 'available', version: info.version, message: `下载更新失败：${message(error)}` })
      return
    }
    await confirm()
  }
  async function apply(info: Release) {
    const root = path.dirname(process.execPath)
    // 暂存、备份及当前目录必须在同一卷，切换时只需重命名目录。
    const work = await fs.mkdtemp(path.join(path.dirname(root), '.pi-runner-update-'))
    try {
      const job: Record<string, unknown> = { pid: process.pid, root, exe: path.basename(process.execPath), version: info.version, startupAck: info.startupAck === true }
      if (info.channel === 'zip') {
        const next = path.join(work, 'next')
        await fs.mkdir(next)
        await extract(packagePath(), next)
        const nextMarker = JSON.parse(await fs.readFile(path.join(next, markerName), 'utf8')) as Marker
        const exe = path.basename(process.execPath)
        if (nextMarker?.channel !== 'zip' || nextMarker.repository !== marker!.repository || !nextMarker.files || !Object.hasOwn(nextMarker.files, exe) || !Object.hasOwn(nextMarker.files, 'resources/app.asar')) {
          throw new Error('更新包不是匹配的便携版，或缺少应用文件')
        }
        const [markerHash, nextMarkerHash] = await Promise.all([
          digest(path.join(root, markerName), 'zip', 'hex'),
          digest(path.join(next, markerName), 'zip', 'hex'),
        ])
        Object.assign(job, {
          currentInventory: { directories: marker!.directories, files: { ...marker!.files, [markerName]: markerHash } },
          nextInventory: { directories: nextMarker.directories, files: { ...nextMarker.files, [markerName]: nextMarkerHash } },
        })
      } else Object.assign(job, { installer: packagePath(), hash: Buffer.from(info.hash, 'base64').toString('hex') })
      await fs.writeFile(path.join(work, 'job.json'), JSON.stringify(job))
      const script = path.join(work, 'apply.ps1')
      await fs.copyFile(path.join(process.resourcesPath, 'apply-windows-update.ps1'), script)
      const systemRoot = process.env.SystemRoot || 'C:\\Windows'
      const cmd = path.join(systemRoot, 'System32', 'cmd.exe')
      // PowerShell 直接以 detached 启动时可能在执行脚本前就退出。
      // 让独立的 cmd 同步运行 PowerShell，既能取得退出状态，也不受 Electron 退出影响。
      // 命令中只使用 mkdtemp 生成的目录名；完整路径通过 cwd 传递，不交给 cmd 解析。
      const command = `""%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File ".\\${path.basename(work)}\\apply.ps1""`
      const child = spawn(cmd, ['/d', '/v:off', '/s', '/c', command], {
        detached: true,
        windowsHide: true,
        windowsVerbatimArguments: true,
        stdio: 'ignore',
        cwd: path.dirname(work),
        env: { ...process.env, SystemRoot: systemRoot },
      })
      let spawnError: Error | undefined
      child.on('error', error => { spawnError = error })
      try {
        // 便携版需扫描两份文件清单，机械硬盘和杀毒扫描可能显著放慢校验。
        const deadline = Date.now() + 5 * 60_000
        while (Date.now() < deadline) {
          if (spawnError) throw spawnError
          // 先记录退出状态，再读脚本错误，避免进程在读取期间退出时丢失具体原因。
          const termination = child.exitCode ?? child.signalCode
          const failure = await fs.readFile(path.join(work, 'error.txt'), 'utf8').then(text => text.trim(), () => '')
          if (failure) throw new Error(failure)
          if (termination !== null) throw new Error(`Windows 更新助手提前退出（退出状态：${termination}）`)
          if (await fs.stat(path.join(work, 'ready')).then(() => true, () => false)) {
            await fs.writeFile(path.join(work, 'commit'), '')
            child.unref()
            return
          }
          await delay(100)
        }
        throw new Error('Windows 更新助手准备超时')
      } catch (error) {
        child.kill()
        throw error
      }
    } catch (error) {
      await fs.rm(work, { recursive: true, force: true }).catch(() => {})
      throw error
    }
  }
  async function confirm() {
    if (state.phase !== 'ready' || !release || confirmedDialog) return
    confirmedDialog = true
    const info = release
    try {
      const options = { type: 'question' as const, title: '安装更新', message: `更新到 v${info.version}？`, detail: 'Pi Runner 将退出并开始更新。选择“稍后”后，可在“关于”页面点击“立即更新”。', buttons: ['稍后', '立即更新'], defaultId: 0, cancelId: 0, noLink: true }
      const window = getWindow()
      const result = await (window && !window.isDestroyed() ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options))
      if (result.response !== 1) return
      set({ phase: 'installing', version: info.version })
      try { await verify(info) } catch {
        await clearCache()
        set({ phase: 'idle', message: '已下载的更新包无法通过校验。请重新检查并下载。' })
        return
      }
      let started = false
      let failure: string | undefined
      await saveAndQuit(async () => {
        try { await apply(info); started = true } catch (error) { failure = message(error) }
        return started
      })
      if (!started) {
        if (failure) throw new Error(failure)
        set({ phase: 'ready', version: info.version, message: '更新未开始，请重试。' })
      }
    } catch (error) {
      const failure = `未能开始更新：${message(error)}。请重试，或手动更新。`
      set({ phase: 'ready', version: info.version, message: failure })
      dialog.showErrorBox('更新未开始', failure)
    } finally { confirmedDialog = false }
  }
  const authorized = (event: Electron.IpcMainInvokeEvent) => {
    const frame = event.senderFrame
    const window = getWindow()
    if (!frame || !window || window.isDestroyed() || event.sender.isDestroyed() || event.sender !== window.webContents) return false
    const main = event.sender.mainFrame
    return frame.processId === main.processId && frame.routingId === main.routingId && isTrustedRendererUrl(frame.url, rendererUrl)
  }
  ipcMain.handle(UPDATE_CHANNELS.state, async event => {
    if (!authorized(event)) return { phase: 'unsupported' }
    if (startupAckDirectory) {
      // 仅在可信主界面已挂载并读取更新状态后，确认新版本可用。
      const directory = startupAckDirectory
      startupAckDirectory = undefined
      try {
        if (!(await fs.lstat(directory)).isDirectory() || !(await fs.lstat(path.join(directory, 'commit'))).isFile()) throw new Error('更新工作目录无效')
        await fs.writeFile(path.join(directory, 'app-ready'), '', { flag: 'wx' })
      } catch (error) { console.warn('无法确认更新后启动状态:', error) }
    }
    return state
  })
  ipcMain.handle(UPDATE_CHANNELS.action, async (event, action: unknown) => {
    if (!authorized(event)) return
    if (action === 'check') await check(true)
    else if (action === 'download') await download()
    else if (action === 'install') await confirm()
  })
  if (!app.isPackaged || process.platform !== 'win32' || process.arch !== 'x64') return
  void (async () => {
    const candidate = JSON.parse(await fs.readFile(path.join(process.resourcesPath, path.basename(markerName)), 'utf8')) as Marker
    if (!['zip', 'nsis'].includes(candidate.channel) || !/^[\w.-]+\/[\w.-]+$/.test(candidate.repository)) return
    if (candidate.channel === 'zip' && (!candidate.files || typeof candidate.files !== 'object')) return
    marker = candidate
    if (!await restore()) set({ phase: 'idle' })
    await check(false)
    setInterval(() => { void check(false) }, checkInterval).unref()
  })().catch(error => console.warn('初始化自动更新失败:', error))
}
