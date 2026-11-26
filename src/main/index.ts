import { app, BrowserWindow, dialog, Menu, net, safeStorage, shell, Tray } from 'electron'
import { registerWindowsUpdate } from './windows-update'
import { dataPaths } from './data-paths'
import { shareWindowsEncryptionKey } from './shared-encryption'
import { flushRendererConversations } from './flush-conversations'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { IPC_CHANNELS } from '../shared/api'
import { ShadowGitManager } from './snapshot/shadow-git-manager'
import { ModelSettingsStore } from './models/model-settings-store'
import { ModelService } from './models/model-service'
import { PiAgentService } from './models/pi-agent-service'
import { registerIpcHandlers } from './ipc-handlers'
import { closeAllNotifications } from './notifications'
import { ChatgptCredentials } from './models/chatgpt-credentials'
import { claudeSubscription } from './models/claude-subscription-service'
import { configureClaudeRelayFetch } from './models/claude-code/turn-relay'
import { ChatgptService } from './models/chatgpt-service'
import { GoogleClient } from './models/google-client'
import { DeepseekClient } from './models/deepseek-client'
import { OpenrouterClient } from './models/openrouter-client'
import { ToolReviewService } from './models/tool-review-service'
import { SleepBlocker } from './sleep-blocker'
import { withTimeout } from './operation-timeout'
import { ModelError } from './models/model-validation'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false
let flushingBeforeQuit = false
let servicesReady = false
let snapshotManager: ShadowGitManager | undefined
let modelSettings: ModelSettingsStore
let modelService: ModelService
let chatgptService: ChatgptService
let piRunnerDirectory: string
const sleepBlocker = new SleepBlocker()
const mainDirectory = path.dirname(fileURLToPath(import.meta.url))
const rendererFile = path.join(mainDirectory, '../renderer/index.html')
const appDataDirectory = app.getPath('appData')
const storagePaths = dataPaths(appDataDirectory, app.getPath('home'), app.isPackaged)
const iconDirectory = app.isPackaged ? path.join(process.resourcesPath, 'icons') : path.join(app.getAppPath(), 'resources', 'icons')
const windowIcon = path.join(iconDirectory, process.platform === 'win32' ? 'icon.ico' : 'icon.png')
// userData 目录：安装版固定为 pi-runner，开发模式使用独立的 pi-runner-dev，避免与已安装的正式版争用缓存导致 0x5 拒绝访问。
// 单实例锁及浏览器缓存隔离；模型配置与授权单独共享。
app.setPath('userData', storagePaths.userData)
// 显式隔离 Chromium 会话缓存，不能让它随应用名或初始化顺序落到共享模型目录。
app.setPath('sessionData', storagePaths.userData)
let hasSingleInstanceLock: boolean
try {
  hasSingleInstanceLock = app.requestSingleInstanceLock()
} catch (error) {
  console.error('无法获取应用单实例锁:', error)
  hasSingleInstanceLock = false
}
if (!hasSingleInstanceLock) {
  // 次实例没有窗口和服务，不能进入保存草稿的退出流程。
  isQuitting = true
  app.quit()
} else {
  app.on('second-instance', () => {
    // 启动初始化尚未完成时，首个实例会在初始化结束后正常显示窗口。
    showMainWindow()
  })
}
// 获得开发版单实例锁后、Chromium 初始化安全存储前，对齐正式版密钥。
let startupError: unknown
if (hasSingleInstanceLock && !app.isPackaged && process.platform === 'win32') {
  try { shareWindowsEncryptionKey(storagePaths.models, storagePaths.userData) }
  catch (error) { startupError = error }
}
const isDevelopment = !app.isPackaged && Boolean(process.env.ELECTRON_RENDERER_URL)
const rendererUrl = isDevelopment ? process.env.ELECTRON_RENDERER_URL! : pathToFileURL(rendererFile).href
function showMainWindow(): void {
  if (isQuitting || !servicesReady) return
  if (!mainWindow) createWindow()
  if (mainWindow?.isMinimized()) mainWindow.restore()
  mainWindow?.setSkipTaskbar(false)
  mainWindow?.show()
  mainWindow?.focus()
}
function prepareToQuit(): void {
  if (isQuitting) return
  isQuitting = true
  closeAllNotifications()
  sleepBlocker.stop()
  tray?.destroy()
  tray = null
  modelService?.cancelAll()
  void chatgptService?.cancel()
  void claudeSubscription.shutdown()
}
// 托盘在应用启动时就创建并常驻，与窗口显示/隐藏无关。
function createTray(): Tray {
  if (tray) return tray
  const created = new Tray(windowIcon)
  created.setToolTip('Pi Runner · 行动派')
  created.setContextMenu(Menu.buildFromTemplate([
    { label: '打开', click: showMainWindow },
    { label: '退出', click: () => app.quit() }
  ]))
  created.on('double-click', showMainWindow)
  tray = created
  return created
}
function hideToTray(): void {
  createTray()
  mainWindow?.setSkipTaskbar(true)
  mainWindow?.hide()
}
function createWindow(): void {
  mainWindow = new BrowserWindow({ width: 1440, height: 920, minWidth: 960, minHeight: 640, backgroundColor: '#f2f2ee', frame: false, thickFrame: true, icon: windowIcon,
    webPreferences: { preload: path.join(mainDirectory, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true }
  })
  const window = mainWindow
  let recoveryPending = false
  const offerRecovery = async (message: string, crashed = false): Promise<void> => {
    if (recoveryPending || isQuitting || window.isDestroyed()) return
    recoveryPending = true
    try {
      window.show()
      const result = await dialog.showMessageBox(window, {
        type: 'warning', title: 'Pi Runner 页面异常', message,
        detail: '重新加载将恢复已保存的会话，尚未保存的输入可能丢失。原会话和供应商数据不会被清除。',
        buttons: crashed ? ['重新加载', '退出程序'] : ['继续等待', '重新加载'],
        defaultId: 0, cancelId: crashed ? 1 : 0, noLink: true
      })
      if (isQuitting || window.isDestroyed()) return
      if (crashed && result.response === 1) { prepareToQuit(); app.quit(); return }
      if (crashed || result.response === 1) {
        modelService.cancelAll()
        sleepBlocker.stop()
        void window.loadURL(rendererUrl).catch(error => console.error('重新加载页面失败:', error))
      }
    } catch (error) { console.error('页面恢复提示失败:', error) }
    finally { recoveryPending = false }
  }
  window.on('unresponsive', () => { void offerRecovery('页面长时间未响应，可以继续等待或重新加载。') })
  window.webContents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) void offerRecovery('页面加载失败，请重新加载；若持续失败，请重新安装应用。', true)
  })
  if (isDevelopment) {
    mainWindow.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') {
        event.preventDefault()
        mainWindow?.webContents.openDevTools({ mode: 'detach' })
      }
    })
  }
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url)
      if (['http:', 'https:', 'mailto:'].includes(parsed.protocol)) {
        void shell.openExternal(parsed.href).catch(error => console.error('打开外部链接失败:', error))
      }
    } catch { /* 忽略无效链接 */ }
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', event => event.preventDefault())
  mainWindow.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  mainWindow.webContents.session.setPermissionCheckHandler(() => false)
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    modelService.cancelAll(); sleepBlocker.stop()
    if (!isQuitting && details.reason !== 'clean-exit') void offerRecovery('页面进程已退出，请重新加载恢复界面。', true)
  })
  // 渲染进程导航（如刷新）后会重新同步休眠开关状态。
  mainWindow.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) { modelService.cancelAll(); sleepBlocker.stop() }
  })
  mainWindow.on('close', event => {
    if (isQuitting) return
    if (isDevelopment) {
      event.preventDefault()
      void saveBeforeClosing(async () => { modelService.cancelAll(); await claudeSubscription.shutdown(); prepareToQuit(); mainWindow?.close() })
      return
    }
    hideToTray()
    event.preventDefault()
  })
  // Windows 注销或关机不会保证触发 before-quit，确认结束系统会话时也要清理后台任务。
  mainWindow.on('query-session-end', () => {
    // 不阻止系统关机；尽早请求保存，最终 session-end 不再等待渲染进程。
    const contents = mainWindow?.webContents
    if (contents && !contents.isDestroyed()) void flushRendererConversations(contents).catch(error => console.error('关机前保存会话未完成:', error))
  })
  mainWindow.on('session-end', prepareToQuit)
  mainWindow.on('closed', () => {
    if (!isQuitting) { modelService.cancelAll(); void chatgptService.cancel() }
    mainWindow = null
    snapshotManager = undefined
  })
  const publishWindowState = (): void => { mainWindow?.webContents.send(IPC_CHANNELS.windowMaximized, mainWindow.isMaximized()) }
  mainWindow.on('maximize', publishWindowState)
  mainWindow.on('unmaximize', publishWindowState)
  mainWindow.webContents.once('did-finish-load', publishWindowState)
  void window.loadURL(rendererUrl).catch(error => {
    if (isQuitting || window.isDestroyed()) return
    console.error('页面加载失败:', error)
    void offerRecovery('页面加载失败，请重新加载；若持续失败，请重新安装应用。', true)
  })
}
if (hasSingleInstanceLock) void app.whenReady().then(() => {
  if (startupError) throw startupError
  if (isQuitting) return
  // Tray 必须在 app ready 之后创建；这里在初始化服务前立即建好，启动即显示托盘图标。
  createTray()
  if (process.platform === 'win32') app.setAppUserModelId('com.pirunner.app')
  if (process.platform === 'darwin') app.dock?.setIcon(path.join(iconDirectory, 'icon.png'))
  piRunnerDirectory = storagePaths.workspace
  const storageTimeout = (): ModelError => new ModelError('系统安全存储响应超时，请解锁系统钥匙串或稍后重试；原授权文件已保留')
  const cipher = {
    // 钥匙串/系统服务无响应时仍可显示配置，不能永久占住共享配置的串行队列。
    isAvailable: async () => await withTimeout(safeStorage.isAsyncEncryptionAvailable(), 8_000, storageTimeout()).catch(() => false) && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'),
    encrypt: (value: string) => withTimeout(safeStorage.encryptStringAsync(value), 15_000, storageTimeout()),
    decrypt: async (value: Buffer) => (await withTimeout(safeStorage.decryptStringAsync(value), 15_000, storageTimeout())).result
  }
  modelSettings = new ModelSettingsStore(path.join(storagePaths.models, 'model-settings.json'), cipher)
  // 订阅网络沿用 Electron 的系统代理；不向授权接口或模型接口发送浏览器 Cookie。
  const subscriptionFetch: typeof fetch = (input, init) => net.fetch(input instanceof URL ? input.href : input, { ...init, credentials: 'omit' })
  const modelFetch: typeof fetch = (input, init) => ['openrouter.ai', 'generativelanguage.googleapis.com', 'api.deepseek.com', 'api.groq.com'].includes(new URL(input instanceof Request ? input.url : String(input)).hostname) ? subscriptionFetch(input, init) : fetch(input, init)
  claudeSubscription.initialize(modelSettings)
  configureClaudeRelayFetch(subscriptionFetch)
  chatgptService = new ChatgptService(new ChatgptCredentials(path.join(storagePaths.models, 'chatgpt-auth.enc'), cipher), modelSettings, subscriptionFetch)
  const reviewService = new ToolReviewService(modelSettings, modelFetch, chatgptService)
  modelService = new ModelService(modelSettings, new PiAgentService({ dataDirectory: piRunnerDirectory, protectedDirectories: [app.getPath('userData'), storagePaths.models, path.join(app.getPath('home'), '.pi-runner'), path.join(app.getPath('home'), '.pi-runner-dev')], chatgpt: chatgptService,
    fetchRequest: modelFetch,
    resolveExecutionModel: id => modelSettings.getForRequest(id),
    // 下载仅发匿名 GET，不继承模型认证头、Cookie 或订阅请求配置。
    review: request => reviewService.reviewWithSource(request),
    getProject: () => snapshotManager?.getRoot(), emit: event => { mainWindow?.webContents.send(IPC_CHANNELS.agentEvent, event) } }), undefined, new OpenrouterClient(subscriptionFetch), new GoogleClient(subscriptionFetch), new DeepseekClient(subscriptionFetch), modelFetch)
  registerIpcHandlers({
    getMainWindow: () => mainWindow,
    getSnapshotManager: () => snapshotManager,
    getModelSettings: () => modelSettings,
    getModelService: () => modelService,
    getChatgptService: () => chatgptService,
    setSnapshotManager: manager => { snapshotManager = manager },
    getSleepBlocker: () => sleepBlocker,
    dataDirectory: piRunnerDirectory,
    rendererUrl,
  })
  servicesReady = true
  registerWindowsUpdate(() => mainWindow, rendererUrl, apply => saveBeforeClosing(async () => {
    modelService.cancelAll()
    await claudeSubscription.shutdown()
    if (!await apply()) return
    prepareToQuit()
    app.quit()
  }))
  createWindow()
  app.on('activate', showMainWindow)
}).catch(error => {
  console.error('应用启动失败:', error)
  dialog.showErrorBox('Pi Runner 启动失败', error instanceof Error ? error.message : String(error))
  prepareToQuit()
  app.quit()
})
app.on('window-all-closed', () => { if (isDevelopment || process.platform !== 'darwin') app.quit() })
async function saveBeforeClosing(close: () => void | Promise<void>): Promise<void> {
  if (flushingBeforeQuit) return
  flushingBeforeQuit = true
  try {
    const contents = mainWindow?.webContents
    if (contents && !contents.isDestroyed()) await flushRendererConversations(contents)
    await close()
  } catch (error) {
    showMainWindow()
    dialog.showErrorBox('会话尚未保存，已取消退出', error instanceof Error ? error.message : '保存失败，请重试退出。')
  } finally { flushingBeforeQuit = false }
}

app.on('before-quit', event => {
  if (isQuitting) return
  if (!servicesReady) { prepareToQuit(); return }
  event.preventDefault()
  void saveBeforeClosing(async () => { modelService.cancelAll(); await claudeSubscription.shutdown(); prepareToQuit(); app.quit() })
})
