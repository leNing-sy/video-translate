import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'vitest'
import assert from 'node:assert/strict'
import {
  ensureGuiCommandPath,
  getCommandCandidates,
  getCommonBinaryDirectories,
  resetGuiCommandPathStateForTests,
  resolveBundledMediaCommandPath,
  resolveCommandPath,
} from './command-path'
import { checkSystemDependencies } from './system-check'
import type { SystemCheckProgress } from './system-check'

const originalPath = process.env.PATH
const originalPathExt = process.env.PATHEXT
const originalHomebrewPrefix = process.env.HOMEBREW_PREFIX
const originalLocalAppData = process.env.LOCALAPPDATA
const originalProgramFiles = process.env.ProgramFiles
const originalProgramFilesX86 = process.env['ProgramFiles(x86)']
let testDirectory: string | undefined

function restoreEnvironmentVariable(
  name: string,
  value: string | undefined
): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, name)
  } else {
    process.env[name] = value
  }
}

afterEach(async () => {
  restoreEnvironmentVariable('PATH', originalPath)
  restoreEnvironmentVariable('PATHEXT', originalPathExt)
  restoreEnvironmentVariable('HOMEBREW_PREFIX', originalHomebrewPrefix)
  restoreEnvironmentVariable('LOCALAPPDATA', originalLocalAppData)
  restoreEnvironmentVariable('ProgramFiles', originalProgramFiles)
  restoreEnvironmentVariable('ProgramFiles(x86)', originalProgramFilesX86)
  resetGuiCommandPathStateForTests()

  if (testDirectory) {
    await rm(testDirectory, { recursive: true, force: true })
    testDirectory = undefined
  }
})

test('macOS 图形应用的 PATH 缺少 Homebrew 时仍能识别 keg-only ffmpeg-full', async () => {
  if (process.platform === 'win32') return

  testDirectory = await mkdtemp(path.join(tmpdir(), 'video-translate-'))
  const binDirectory = path.join(testDirectory, 'opt', 'ffmpeg-full', 'bin')
  await mkdir(binDirectory, { recursive: true })

  for (const command of ['ffmpeg', 'ffprobe']) {
    const executablePath = path.join(binDirectory, command)
    await writeFile(
      executablePath,
      `#!/bin/sh\nprintf '${command} version 8.1.2\\n'\n`
    )
    await chmod(executablePath, 0o755)
  }

  process.env.PATH = '/usr/bin:/bin'
  process.env.HOMEBREW_PREFIX = testDirectory

  const results = await checkSystemDependencies({
    autoDownloadAsr: false,
    writeLog: false,
  })
  const mediaTools = results.filter(({ name }) =>
    ['ffmpeg', 'ffprobe'].includes(name)
  )

  assert.deepEqual(
    mediaTools.map(({ name, available, version }) => ({
      name,
      available,
      version,
    })),
    [
      { name: 'ffmpeg', available: true, version: '8.1.2' },
      { name: 'ffprobe', available: true, version: '8.1.2' },
    ]
  )
})

test('Unix GUI 精简 PATH 下仍能解析 ollama 与 node 到常见目录', async () => {
  if (process.platform === 'win32') return

  testDirectory = await mkdtemp(path.join(tmpdir(), 'video-translate-bin-'))
  const binDirectory = path.join(testDirectory, 'bin')
  await mkdir(binDirectory, { recursive: true })

  for (const command of ['ollama', 'node']) {
    const executablePath = path.join(binDirectory, command)
    await writeFile(
      executablePath,
      `#!/bin/sh\nprintf '${command} version 1.2.3\\n'\n`
    )
    await chmod(executablePath, 0o755)
  }

  process.env.PATH = '/usr/bin:/bin'
  process.env.HOMEBREW_PREFIX = testDirectory

  const ollamaPath = resolveCommandPath('ollama')
  assert.equal(ollamaPath, path.join(binDirectory, 'ollama'))

  ensureGuiCommandPath()
  assert.ok(
    (process.env.PATH || '').includes(binDirectory),
    'ensureGuiCommandPath 应把常见 bin 目录补进 PATH'
  )
})

test('Windows 命令会根据 PATHEXT 解析可执行文件后缀', () => {
  assert.deepEqual(
    getCommandCandidates('ffmpeg', 'win32', '.EXE;.CMD'),
    ['ffmpeg', 'ffmpeg.EXE', 'ffmpeg.CMD']
  )
  assert.deepEqual(
    getCommandCandidates('ffmpeg.exe', 'win32', '.EXE;.CMD'),
    ['ffmpeg.exe']
  )
})

test('Windows 会发现 WinGet 包内的 FFmpeg bin 目录', async () => {
  if (process.platform !== 'win32') return

  testDirectory = await mkdtemp(path.join(tmpdir(), 'video-translate-winget-'))
  const packageBin = path.join(
    testDirectory,
    'Microsoft',
    'WinGet',
    'Packages',
    'Gyan.FFmpeg_Test',
    'ffmpeg-build',
    'bin'
  )
  await mkdir(packageBin, { recursive: true })
  await writeFile(path.join(packageBin, 'ffmpeg.exe'), 'test executable')

  process.env.LOCALAPPDATA = testDirectory
  process.env.ProgramFiles = path.join(testDirectory, 'Program Files')
  process.env['ProgramFiles(x86)'] = path.join(
    testDirectory,
    'Program Files (x86)'
  )

  assert.ok(getCommonBinaryDirectories().includes(packageBin))
})

test('Windows PATH 中只有 ffprobe.exe 时仍能解析命令', async () => {
  if (process.platform !== 'win32') return

  testDirectory = await mkdtemp(path.join(tmpdir(), 'video-translate-pathext-'))
  const executablePath = path.join(testDirectory, 'ffprobe.exe')
  await writeFile(executablePath, 'test executable')
  process.env.PATH = testDirectory
  process.env.PATHEXT = '.EXE'
  resetGuiCommandPathStateForTests()

  assert.equal(
    resolveCommandPath('ffprobe').toLowerCase(),
    executablePath.toLowerCase()
  )
})

test('打包资源中的 FFmpeg 优先于系统 PATH', async () => {
  testDirectory = await mkdtemp(
    path.join(tmpdir(), 'video-translate-resource-')
  )
  const bundledDirectory = path.join(testDirectory, 'ffmpeg')
  await mkdir(bundledDirectory, { recursive: true })

  const executablePath = path.join(bundledDirectory, 'ffmpeg.exe')
  await writeFile(executablePath, 'bundled ffmpeg')
  await chmod(executablePath, 0o755)

  assert.equal(
    resolveBundledMediaCommandPath('ffmpeg', testDirectory, 'win32'),
    executablePath
  )
  assert.equal(
    resolveBundledMediaCommandPath('ffprobe', testDirectory, 'win32'),
    undefined
  )
})

test('Node 依赖检查使用 Electron 内置 runtime，不依赖系统 node 二进制', async () => {
  process.env.PATH = '/usr/bin:/bin'

  const results = await checkSystemDependencies({
    autoDownloadAsr: false,
    writeLog: false,
  })
  const nodeResult = results.find(item => item.name === 'node')

  assert.ok(nodeResult)
  assert.equal(nodeResult?.available, true)
  assert.equal(nodeResult?.version, process.versions.node)
})

test('系统依赖检查会按实际阶段持续报告进度', async () => {
  const progressEvents: SystemCheckProgress[] = []

  await checkSystemDependencies({
    autoDownloadAsr: false,
    writeLog: false,
    onProgress: progress => progressEvents.push(progress),
  })

  assert.deepEqual(
    progressEvents.map(({ stage, percent, message }) => ({
      stage,
      percent,
      message,
    })),
    [
      {
        stage: 'checking-tools',
        percent: 10,
        message: '正在检查 FFmpeg、Node.js 和 Ollama...',
      },
      {
        stage: 'checking-asr',
        percent: 30,
        message: '正在检查 SenseVoice 模型...',
      },
      {
        stage: 'done',
        percent: 100,
        message: '系统依赖检查完成',
      },
    ]
  )
})
