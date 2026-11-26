const fs = require('node:fs/promises')
const path = require('node:path')
const { createReadStream } = require('node:fs')
const { createHash } = require('node:crypto')

async function digest(file, algorithm, encoding) {
  const hash = createHash(algorithm)
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest(encoding)
}

async function markDistribution(root, channel) {
  const marker = path.join(root, 'resources', 'pi-runner-update.json')
  const repository = process.env.GITHUB_ACTIONS === 'true' ? process.env.GITHUB_REPOSITORY : undefined
  await fs.rm(path.join(root, 'resources', 'app-update.yml'), { force: true })
  const files = Object.create(null)
  const directories = []
  if (channel === 'zip') {
    for (const relative of await fs.readdir(root, { recursive: true })) {
      const file = path.join(root, relative)
      if (file === marker) continue
      const name = relative.split(path.sep).join('/')
      const type = await fs.lstat(file)
      if (type.isDirectory()) directories.push(name)
      else if (type.isFile()) files[name] = await digest(file, 'sha256', 'hex')
      else throw new Error(`便携版存在不支持的文件类型：${name}`)
    }
  }
  await fs.writeFile(marker, JSON.stringify({ channel, repository, files, directories }))
  if (channel === 'nsis') await fs.writeFile(path.join(root, 'resources', 'app-update.yml'), 'updaterCacheDirName: pi-runner-nsis-updater\n')
}

async function writeUpdateMetadata(destination) {
  const { version } = require('../package.json')
  const installer = 'pi-runner-setup.exe'
  const zip = 'pi-runner-portable.zip'
  const info = async (name, algorithm, encoding) => {
    const file = path.join(destination, name)
    return { size: (await fs.stat(file)).size, [algorithm]: await digest(file, algorithm, encoding) }
  }
  const setup = await info(installer, 'sha512', 'base64')
  // JSON 是 YAML 的子集，可由 electron-updater 的 YAML 解析器读取。
  await fs.writeFile(path.join(destination, 'latest.yml'), JSON.stringify({
    version, stagedInstall: true, startupAck: true, path: installer, sha512: setup.sha512,
    files: [{ url: installer, ...setup }],
    portable: { name: zip, ...await info(zip, 'sha256', 'hex') },
  }))
}
const { build, createTargets, Platform } = require('electron-builder')
const { packageWindows, assertX64, getCompiler } = require('./native-windows.cjs')
const { verifyPackagedRuntime } = require('./verify-packaged-runtime.cjs')
const { getSevenZip, compressDirectory } = require('./seven-zip.cjs')
const { generateIcons } = require('./generate-icons.cjs')

const projectDir = path.resolve(__dirname, '..')

function getExportOptions(mode, host = process.platform) {
  const options = {
    win: { host: 'win32', platform: Platform.WINDOWS, target: 'nsis' },
    'win-all': { host: 'win32', platform: Platform.WINDOWS, target: 'dir' },
    'win-release': { host: 'win32', platform: Platform.WINDOWS, target: 'dir' },
    'win-portable': { host: 'win32', platform: Platform.WINDOWS, target: 'portable' },
    'win-zip': { host: 'win32', platform: Platform.WINDOWS, target: 'zip' },
    mac: { host: 'darwin', platform: Platform.MAC, target: 'dmg' },
    dir: { host, platform: Platform.current(), target: 'dir' },
  }
  if (!Object.hasOwn(options, mode)) throw new Error('请选择有效的导出类型：win-release、win-all、win、win-portable、win-zip、mac、dir。')
  const option = options[mode]
  if (option.host !== host) throw new Error('请在对应系统上导出发行包：Windows 使用 win-release / win-all / win / win-portable / win-zip，macOS 使用 mac。')
  return option
}

async function copyArtifacts(artifacts, destination) {
  const releaseFiles = artifacts.filter(artifact => /\.(exe|dmg|zip|pkg)$/i.test(artifact))
  if (releaseFiles.length === 0) throw new Error('未找到可导出的发行文件，请检查打包输出。')
  await fs.mkdir(destination, { recursive: true })
  const exported = []
  for (const artifact of releaseFiles) {
    let output = path.join(destination, path.basename(artifact))
    try {
      await fs.copyFile(artifact, output)
    } catch (error) {
      if (!['EBUSY', 'EPERM', 'EACCES'].includes(error.code)) throw error
      throw new Error(`无法写入发行文件 ${output}，请关闭正在运行的同名程序并确认目录可写后重试。已生成的文件保留在 ${artifact}。`, { cause: error })
    }
    exported.push(output)
  }
  return exported
}

async function exportRelease(mode) {
  const started = performance.now()
  const option = getExportOptions(mode)
  const stagingDir = path.join(projectDir, 'build-work', mode)
  const destination = path.join(projectDir, 'release')
  const windowsRelease = ['win-release', 'win-all', 'win', 'win-portable', 'win-zip'].includes(mode)
  const nativeWindows = windowsRelease && mode !== 'win-zip'
  const config = { directories: { output: stagingDir }, afterPack: verifyPackagedRuntime }
  if (option.platform === Platform.WINDOWS) {
    // 直接使用已安装的 Electron，避免依赖下载缓存或联网获取运行时。
    const electronDist = path.join(path.dirname(require.resolve('electron/package.json')), 'dist')
    await assertX64(path.join(electronDist, 'electron.exe'))
    if (nativeWindows) await getCompiler(projectDir)
    if (windowsRelease) await getSevenZip(projectDir)
    config.electronDist = electronDist
    config.npmRebuild = false
    // 图标与版本信息仍由本地资源编辑器处理，不查询签名证书或下载签名工具。
    config.win = {
      signExecutable: false,
      extraResources: [{ from: 'scripts/apply-windows-update.ps1', to: 'apply-windows-update.ps1' }],
    }
  }
  // 打包前从同一透明源图生成 PNG 和 ICNS，确保 Finder、未启动及运行中的 Dock 图标一致。
  await generateIcons(projectDir)
  let artifacts = await build({
    projectDir,
    targets: createTargets([option.platform], windowsRelease ? 'dir' : option.target, option.platform === Platform.MAC ? process.arch : 'x64'),
    publish: 'never',
    config,
  })

  if (windowsRelease) {
    artifacts = []
    const root = path.join(stagingDir, 'win-unpacked')
    if (nativeWindows) {
      const variants = mode === 'win-all' ? [false, true] : [mode === 'win-portable']
      for (const portable of variants) {
        await markDistribution(root, portable ? 'standalone' : 'nsis')
        const payload = await compressDirectory({ projectDir, stagingDir })
        artifacts.push(await packageWindows({ projectDir, stagingDir, portable, payload }))
      }
    }
    if (['win-release', 'win-all', 'win-zip'].includes(mode)) {
      await markDistribution(root, 'zip')
      artifacts.push(await compressDirectory({ projectDir, stagingDir, zip: true }))
    }
  }

  // release 平铺可下载的发行文件和更新元数据；目录版及调试配置留在 build-work。
  if (mode === 'dir') {
    console.log(`\n免安装目录版已生成到：${stagingDir}`)
    return
  }
  await copyArtifacts(artifacts, destination)
  if (['win-release', 'win-all'].includes(mode)) await writeUpdateMetadata(destination)
  console.log(`\n发行内容已导出到：${destination}`)
  console.log(`打包与导出用时：${((performance.now() - started) / 1000).toFixed(1)} 秒（不含前置编译）`)
}

if (require.main === module) {
  exportRelease(process.argv[2]).catch(error => {
    console.error(`导出失败：${error.message}`)
    // electron-builder 注册了退出回调，显式传入失败码以免失败被报告为成功。
    process.exit(1)
  })
}

module.exports = { getExportOptions, copyArtifacts, exportRelease }
