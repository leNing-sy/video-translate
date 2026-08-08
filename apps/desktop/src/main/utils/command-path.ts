import { execFileSync } from 'node:child_process'
import {
  constants,
  accessSync,
  existsSync,
  readdirSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOMEBREW_MEDIA_COMMANDS = new Set(['ffmpeg', 'ffprobe'])
const BUNDLED_MEDIA_COMMANDS = new Set(['ffmpeg', 'ffprobe'])
const DEFAULT_WINDOWS_PATHEXT = '.COM;.EXE;.BAT;.CMD'

let pathAugmented = false

function isExecutable(
  filePath: string,
  platform = process.platform
): boolean {
  try {
    if (platform === 'win32') {
      return existsSync(filePath)
    }
    accessSync(filePath, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function getCommandCandidates(
  command: string,
  platform = process.platform,
  pathExt = process.env.PATHEXT
): string[] {
  if (platform !== 'win32' || path.extname(command)) return [command]

  const extensions = (pathExt || DEFAULT_WINDOWS_PATHEXT)
    .split(';')
    .map(extension => extension.trim())
    .filter(Boolean)
    .map(extension =>
      extension.startsWith('.') ? extension : `.${extension}`
    )

  const candidates = [command, ...extensions.map(ext => `${command}${ext}`)]
  return [
    ...new Map(
      candidates.map(candidate => [candidate.toLowerCase(), candidate])
    ).values(),
  ]
}

/**
 * 返回打包后随应用分发的 FFmpeg/FFprobe 路径。
 *
 * electron-builder 会把平台对应的二进制放到 resources/ffmpeg。开发环境和
 * 精简包中该目录不存在，因此自然回退到系统 PATH。
 */
export function resolveBundledMediaCommandPath(
  command: string,
  resourcesPath = process.resourcesPath,
  platform = process.platform
): string | undefined {
  if (
    !resourcesPath ||
    !BUNDLED_MEDIA_COMMANDS.has(command) ||
    !['win32', 'darwin', 'linux'].includes(platform)
  ) {
    return undefined
  }

  const executable = platform === 'win32' ? `${command}.exe` : command
  const candidate = path.join(resourcesPath, 'ffmpeg', executable)
  return isExecutable(candidate, platform) ? candidate : undefined
}

function findInPath(
  command: string,
  pathValue = process.env.PATH,
  platform = process.platform,
  pathExt = process.env.PATHEXT
): string | undefined {
  if (!pathValue) return undefined

  const candidates = getCommandCandidates(command, platform, pathExt)
  for (const directory of pathValue.split(path.delimiter)) {
    const normalizedDirectory = directory.trim()
    if (!normalizedDirectory || normalizedDirectory === '%PATH%') continue

    for (const candidateName of candidates) {
      const candidate = path.join(normalizedDirectory, candidateName)
      if (isExecutable(candidate, platform)) return candidate
    }
  }

  return undefined
}

function getHomebrewPrefixes(): string[] {
  const prefixes: string[] = []
  const configuredPrefix = process.env.HOMEBREW_PREFIX
  if (configuredPrefix) prefixes.push(configuredPrefix)

  prefixes.push('/opt/homebrew', '/usr/local')
  return [...new Set(prefixes)]
}

function getHomeDirectory(): string {
  return os.homedir()
}

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>()
  const unique: string[] = []

  for (const value of paths) {
    const normalized = value.trim()
    if (!normalized || normalized === '%PATH%') continue
    const key =
      process.platform === 'win32' ? normalized.toLowerCase() : normalized
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(normalized)
  }

  return unique
}

function getWindowsEnvironmentPaths(): string[] {
  if (process.platform !== 'win32') return []

  try {
    const systemRoot = process.env.SystemRoot || 'C:\\Windows'
    const bundledPowerShell = path.join(
      systemRoot,
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe'
    )
    const powershell = existsSync(bundledPowerShell)
      ? bundledPowerShell
      : 'powershell.exe'
    const script = [
      "[Environment]::GetEnvironmentVariable('Path','Machine')",
      "[Environment]::GetEnvironmentVariable('Path','User')",
    ].join('; ')

    const output = execFileSync(
      powershell,
      ['-NoProfile', '-NonInteractive', '-Command', script],
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 5000,
      }
    )

    return output
      .split(/\r?\n/)
      .flatMap(value => value.split(path.delimiter))
  } catch {
    return []
  }
}

export function getWindowsBinaryDirectoryCandidates(
  env: NodeJS.ProcessEnv = process.env,
  home = getHomeDirectory()
): string[] {
  if (process.platform !== 'win32') return []

  const directories = [
    env.ProgramFiles && path.join(env.ProgramFiles, 'ffmpeg', 'bin'),
    env['ProgramFiles(x86)'] &&
      path.join(env['ProgramFiles(x86)'], 'ffmpeg', 'bin'),
    path.join(home, 'scoop', 'shims'),
    env.LOCALAPPDATA &&
      path.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links'),
    'C:\\ffmpeg\\bin',
    'C:\\tools\\ffmpeg\\bin',
  ]

  return uniquePaths(
    directories.filter((value): value is string => Boolean(value))
  )
}

function getWinGetPackageBinDirectories(): string[] {
  if (process.platform !== 'win32') return []

  const roots = uniquePaths(
    [
      process.env.LOCALAPPDATA &&
        path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages'),
      path.join(
        getHomeDirectory(),
        'AppData',
        'Local',
        'Microsoft',
        'WinGet',
        'Packages'
      ),
      process.env.ProgramFiles &&
        path.join(process.env.ProgramFiles, 'WinGet', 'Packages'),
    ].filter((value): value is string => Boolean(value))
  )
  const directories: string[] = []

  for (const root of roots) {
    if (!existsSync(root)) continue

    try {
      for (const packageEntry of readdirSync(root, { withFileTypes: true })) {
        if (!packageEntry.isDirectory()) continue

        const packageDirectory = path.join(root, packageEntry.name)
        const directBin = path.join(packageDirectory, 'bin')
        if (
          existsSync(path.join(directBin, 'ffmpeg.exe')) ||
          existsSync(path.join(directBin, 'ffprobe.exe'))
        ) {
          directories.push(directBin)
        }

        try {
          for (const childEntry of readdirSync(packageDirectory, {
            withFileTypes: true,
          })) {
            if (!childEntry.isDirectory()) continue
            const nestedBin = path.join(
              packageDirectory,
              childEntry.name,
              'bin'
            )
            if (
              existsSync(path.join(nestedBin, 'ffmpeg.exe')) ||
              existsSync(path.join(nestedBin, 'ffprobe.exe'))
            ) {
              directories.push(nestedBin)
            }
          }
        } catch {
          // 单个 WinGet 包不可读时继续检查其他包。
        }
      }
    } catch {
      // WinGet 根目录不可读时回退到其他候选路径。
    }
  }

  return uniquePaths(directories)
}

/**
 * 图形应用启动时 PATH 往往缺少用户安装目录。
 * 这里返回应补充进 process.env.PATH 的常见可执行目录。
 */
export function getCommonBinaryDirectories(): string[] {
  const home = getHomeDirectory()
  const directories: string[] = []

  if (process.platform === 'win32') {
    directories.push(
      ...getWindowsBinaryDirectoryCandidates(process.env, home),
      ...getWinGetPackageBinDirectories()
    )
  } else {
    for (const prefix of getHomebrewPrefixes()) {
      directories.push(path.join(prefix, 'bin'))
      directories.push(path.join(prefix, 'sbin'))
    }

    directories.push(
      '/usr/local/bin',
      '/usr/local/sbin',
      path.join(home, '.local', 'bin'),
      path.join(home, 'bin'),
      path.join(home, '.volta', 'bin'),
      path.join(home, '.fnm', 'current', 'bin'),
      path.join(home, '.nvm', 'current', 'bin'),
      path.join(home, '.asdf', 'shims'),
      path.join(home, '.local', 'share', 'mise', 'shims'),
      path.join(home, '.bun', 'bin'),
      path.join(home, '.deno', 'bin'),
      path.join(home, 'Library', 'pnpm')
    )

    if (process.platform === 'darwin') {
      directories.push('/Applications/Ollama.app/Contents/Resources')
    }
  }

  return uniquePaths(directories.filter(dir => existsSync(dir)))
}

/**
 * 为打包后的 Electron GUI 进程补齐常见命令搜索路径。
 * 应在 app ready 后尽早调用一次。
 */
export function ensureGuiCommandPath(): string {
  if (pathAugmented) {
    return process.env.PATH || ''
  }

  const currentPaths = (process.env.PATH || '').split(path.delimiter)
  const mergedPaths = uniquePaths([
    ...currentPaths,
    ...getWindowsEnvironmentPaths(),
    ...getCommonBinaryDirectories(),
  ])
  process.env.PATH = mergedPaths.join(path.delimiter)

  pathAugmented = true
  return process.env.PATH
}

/**
 * 解析系统命令路径。除 PATH 外，还会检查平台常见安装位置。
 */
export function resolveCommandPath(command: string): string {
  if (path.isAbsolute(command)) return command

  // 内置版本优先，保证硬字幕烧录使用随包分发的完整构建。
  const bundledCommand = resolveBundledMediaCommandPath(command)
  if (bundledCommand) return bundledCommand

  ensureGuiCommandPath()

  const pathCommand = findInPath(command)
  if (pathCommand) return pathCommand

  for (const directory of getCommonBinaryDirectories()) {
    for (const candidateName of getCommandCandidates(command)) {
      const candidate = path.join(directory, candidateName)
      if (isExecutable(candidate)) return candidate
    }
  }

  if (process.platform === 'darwin' && HOMEBREW_MEDIA_COMMANDS.has(command)) {
    for (const prefix of getHomebrewPrefixes()) {
      for (const formula of ['ffmpeg-full', 'ffmpeg']) {
        const candidate = path.join(prefix, 'opt', formula, 'bin', command)
        if (isExecutable(candidate)) return candidate
      }
    }
  }

  if (command === 'ollama' && process.platform === 'darwin') {
    const appBinary = '/Applications/Ollama.app/Contents/Resources/ollama'
    if (isExecutable(appBinary)) return appBinary
  }

  return command
}

/** 测试辅助：重置 PATH 增强状态 */
export function resetGuiCommandPathStateForTests(): void {
  pathAugmented = false
}
