/**
 * Vibecraft WebSocket Server
 *
 * This server:
 * 1. Watches the events JSONL file for changes
 * 2. Accepts HTTP POST /event for real-time hook notifications
 * 3. Broadcasts events to connected WebSocket clients
 * 4. Tracks tool durations by matching pre/post events
 * 5. Proxies voice input to Deepgram for transcription
 */

// 加载环境变量 - 必须在所有其他导入之前
import 'dotenv/config'

import { createServer, IncomingMessage, ServerResponse } from 'http'
import { WebSocketServer, WebSocket, RawData } from 'ws'
import { watch } from 'chokidar'
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync, unlinkSync, statSync } from 'fs'
import { exec, execFile, spawn } from 'child_process'
import { dirname, resolve, join, extname, sep } from 'path'
import { hostname } from 'os'
import { randomUUID, randomBytes } from 'crypto'
import { createClient, LiveTranscriptionEvents } from '@deepgram/sdk'
import type { LiveClient } from '@deepgram/sdk'
import type {
  ClaudeEvent,
  ServerMessage,
  ClientMessage,
  PreToolUseEvent,
  PostToolUseEvent,
  UserPromptSubmitEvent,
  ManagedSession,
  CreateSessionRequest,
  UpdateSessionRequest,
  SessionPromptRequest,
  GitStatus,
  TextTile,
  CreateTextTileRequest,
  UpdateTextTileRequest,
} from '../shared/types.js'
import { DEFAULTS } from '../shared/defaults.js'
import { GitStatusManager } from './GitStatusManager.js'
import { ProjectsManager } from './ProjectsManager.js'
import { fileURLToPath } from 'url'

// ============================================================================
// Version (read from package.json)
// ============================================================================

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

function getPackageVersion(): string {
  try {
    // Try multiple locations (dev vs compiled)
    const locations = [
      resolve(__dirname, '../package.json'),      // dev: server/ -> package.json
      resolve(__dirname, '../../package.json'),   // compiled: dist/server/ -> package.json
    ]
    for (const loc of locations) {
      if (existsSync(loc)) {
        const pkg = JSON.parse(readFileSync(loc, 'utf-8'))
        return pkg.version || 'unknown'
      }
    }
  } catch {
    // Ignore errors
  }
  return 'unknown'
}

const VERSION = getPackageVersion()

// ============================================================================
// Configuration (env vars override DEFAULTS from shared/defaults.ts)
// ============================================================================

/** Expand ~ to home directory in paths (cross-platform) */
function expandHome(path: string): string {
  if (path.startsWith('~/') || path === '~') {
    const home = process.env.HOME || process.env.USERPROFILE || ''
    return path.replace('~', home)
  }
  return path
}

const PORT = parseInt(process.env.VIBECRAFT_PORT ?? String(DEFAULTS.SERVER_PORT), 10)
const EVENTS_FILE = resolve(expandHome(process.env.VIBECRAFT_EVENTS_FILE ?? DEFAULTS.EVENTS_FILE))
const PENDING_PROMPT_FILE = resolve(expandHome(process.env.VIBECRAFT_PROMPT_FILE ?? '~/.vibecraft/data/pending-prompt.txt'))
const MAX_EVENTS = parseInt(process.env.VIBECRAFT_MAX_EVENTS ?? String(DEFAULTS.MAX_EVENTS), 10)
const DEBUG = process.env.VIBECRAFT_DEBUG === 'true'
const TMUX_SESSION = process.env.VIBECRAFT_TMUX_SESSION ?? DEFAULTS.TMUX_SESSION
const SESSIONS_FILE = resolve(expandHome(process.env.VIBECRAFT_SESSIONS_FILE ?? DEFAULTS.SESSIONS_FILE))
const TILES_FILE = resolve(expandHome(process.env.VIBECRAFT_TILES_FILE ?? '~/.vibecraft/data/tiles.json'))
const DATA_DIR = resolve(expandHome(process.env.VIBECRAFT_DATA_DIR ?? '~/.vibecraft/data'))

/** Time before a "working" session auto-transitions to idle (failsafe for missed events) */
const WORKING_TIMEOUT_MS = 120_000 // 2 minutes

/** Maximum request body size (1MB) - prevents DoS via memory exhaustion */
const MAX_BODY_SIZE = 1024 * 1024

/** How often to check for stale "working" sessions */
const WORKING_CHECK_INTERVAL_MS = 10_000 // 10 seconds

/** Extended PATH for exec() - includes Homebrew and user paths for macOS/Linux */
const HOME = process.env.HOME || process.env.USERPROFILE || ''

/** Platform-specific PATH separator */
const PATH_SEPARATOR = process.platform === 'win32' ? ';' : ':'

const EXEC_PATH = [
  `${HOME}/.local/bin`,     // User local bin (Claude CLI default location)
  '/opt/homebrew/bin',      // macOS Apple Silicon Homebrew
  '/usr/local/bin',         // macOS Intel Homebrew / Linux local
  process.env.PATH || '',
].join(PATH_SEPARATOR)

/** Options for exec() with extended PATH */
const EXEC_OPTIONS = { env: { ...process.env, PATH: EXEC_PATH } }

/** Platform detection */
const IS_WINDOWS = process.platform === 'win32'

/** Windows target window title pattern for Claude Code */
const WINDOWS_TARGET_PATTERN = process.env.VIBECRAFT_WINDOWS_TARGET || 'Claude'

/** Deepgram API key from environment */
const DEEPGRAM_API_KEY_ENV = 'DEEPGRAM_API_KEY'

/** Deepgram transcription settings */
const DEEPGRAM_MODEL = 'nova-2'
const DEEPGRAM_LANGUAGE = 'en'

/**
 * Validate WebSocket origin header to prevent CSRF attacks.
 * Only browser clients should connect, so we require a valid origin.
 */
function isOriginAllowed(origin: string | undefined): boolean {
  // Require origin header - only browsers send this
  if (!origin) return false

  try {
    const url = new URL(origin)

    // Allow any port on localhost/127.0.0.1 (local development)
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
      return true
    }

    // Production: exact hostname match with HTTPS required
    if (url.hostname === 'vibecraft.sh' && url.protocol === 'https:') {
      return true
    }

    return false
  } catch {
    return false // Invalid URL format
  }
}

/**
 * Validate and sanitize a directory path for use in shell commands.
 * Returns the resolved path if valid, throws if invalid.
 */
function validateDirectoryPath(inputPath: string): string {
  // Resolve to absolute path (handles ~, .., etc.)
  const resolved = resolve(expandHome(inputPath))

  // Check path exists and is a directory
  if (!existsSync(resolved)) {
    throw new Error(`Directory does not exist: ${inputPath}`)
  }

  const stat = statSync(resolved)
  if (!stat.isDirectory()) {
    throw new Error(`Path is not a directory: ${inputPath}`)
  }

  // Reject paths with shell metacharacters that could enable injection
  // On Windows: Allow ' (valid in paths) and \ (path separator), properly escaped in PowerShell
  // On Unix: Strict validation since tmux passes commands to a shell
  const dangerousChars = IS_WINDOWS
    ? /[;&|`$(){}[\]<>"!#*?]/     // Allow ' and \ on Windows (path separators + apostrophes)
    : /[;&|`$(){}[\]<>\\'"!#*?]/  // Strict for Unix/tmux
  if (dangerousChars.test(resolved)) {
    throw new Error(`Directory path contains invalid characters: ${inputPath}`)
  }

  return resolved
}

/**
 * Validate a tmux session name.
 * tmux session names should only contain alphanumeric, underscore, hyphen.
 */
function validateTmuxSession(name: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error(`Invalid tmux session name: ${name}`)
  }
  return name
}

/**
 * Promisified execFile helper
 */
function execFileAsync(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, EXEC_OPTIONS, (error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

/**
 * Safely collect request body with size limit to prevent DoS.
 * Returns a promise that resolves with the body string or rejects on error/oversized.
 */
function collectRequestBody(req: IncomingMessage, maxSize: number = MAX_BODY_SIZE): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    let size = 0

    req.on('data', (chunk: Buffer | string) => {
      size += chunk.length
      if (size > maxSize) {
        req.destroy()
        reject(new Error('Request body too large'))
        return
      }
      body += chunk
    })

    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

/**
 * 根据项目路径生成 Claude 窗口标题
 * 格式: "Claude - 项目名"
 *
 * @param cwd - 项目工作目录
 * @returns 窗口标题字符串
 */
function getProjectWindowTitle(cwd: string): string {
  const projectName = cwd.split(/[/\\]/).filter(Boolean).pop() || 'Unknown'
  return `Claude - ${projectName}`
}

/**
 * 启动新的 Claude 窗口（使用 Windows Terminal）
 * 自动设置窗口标题为 "Claude - 项目名"
 *
 * @param cwd - 项目工作目录
 * @param claudeArgs - Claude CLI 参数
 * @returns Promise<{success: boolean; windowTitle?: string; error?: string}>
 */
async function launchClaudeWindow(cwd: string, claudeArgs: string[]): Promise<{
  success: boolean
  windowTitle?: string
  error?: string
}> {
  const windowTitle = getProjectWindowTitle(cwd)
  const projectName = cwd.split(/[/\\]/).filter(Boolean).pop() || 'Unknown'

  return new Promise((resolve) => {
    // 构建 Claude 命令
    // 默认添加 -c 参数尝试继续之前的对话（如果没有历史对话，Claude 会自动开始新对话）
    const allArgs = ['-c', ...claudeArgs]
    const claudeCmd = `claude ${allArgs.join(' ')}`

    // 安全转义路径和参数（PowerShell 单引号字符串中，单引号需要用两个单引号转义）
    const escapedCwd = cwd.replace(/\\/g, '\\\\').replace(/'/g, "''")
    const escapedWindowTitle = windowTitle.replace(/'/g, "''")
    const escapedClaudeCmd = claudeCmd.replace(/'/g, "''")
    const escapedProjectName = projectName.replace(/'/g, "''")

    // 使用 Windows Terminal 启动新窗口
    // wt.exe 参数说明:
    // -w 0: 在新窗口中打开（而非新标签页）
    // nt: new-tab 命令
    // -d: 指定工作目录
    // --title: 设置窗口/标签页标题
    // cmd /k: 运行命令后保持窗口打开
    log(`[launchClaudeWindow] 启动 Windows Terminal: cwd=${cwd}, title=${windowTitle}`)

    // 使用 PowerShell 的 Start-Process 启动 Windows Terminal
    const psScript = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

try {
    # 启动 Windows Terminal
    Start-Process "wt.exe" -ArgumentList @('-w', '0', 'nt', '-d', '${escapedCwd}', '--title', '${escapedWindowTitle}', 'cmd', '/k', '${escapedClaudeCmd}')

    # 等待窗口启动
    Start-Sleep -Milliseconds 2000

    # 验证窗口是否已启动（查找包含项目名的终端窗口）
    $maxAttempts = 10
    $attempt = 0
    $found = $false

    while ($attempt -lt $maxAttempts -and -not $found) {
        $attempt++
        Start-Sleep -Milliseconds 500

        $windows = Get-Process | Where-Object {
            ($_.ProcessName -eq "WindowsTerminal" -or $_.ProcessName -eq "cmd") -and
            $_.MainWindowHandle -ne 0 -and
            ($_.MainWindowTitle -like "*${escapedProjectName}*" -or
             $_.MainWindowTitle -like "*claude*" -or
             $_.MainWindowTitle -like "*Claude*")
        }

        if ($windows) {
            $found = $true
            $actualTitle = $windows[0].MainWindowTitle
            Write-Output "SUCCESS|$actualTitle"
        }
    }

    if (-not $found) {
        # 即使没找到精确匹配，也认为启动成功（Claude 可能修改了窗口标题）
        Write-Output "SUCCESS|${escapedWindowTitle}"
    }
} catch {
    Write-Output "ERROR|$($_.Exception.Message)"
}
`

    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', psScript],
      { ...EXEC_OPTIONS, timeout: 20000 },
      (error, stdout, stderr) => {
        if (error) {
          log(`[launchClaudeWindow] PowerShell 错误: ${stderr || error.message}`)
          resolve({ success: false, error: stderr || error.message })
          return
        }

        const output = stdout.trim()
        if (output.startsWith('SUCCESS|')) {
          const actualTitle = output.split('|')[1] || windowTitle
          log(`[launchClaudeWindow] 成功启动 Claude 窗口: ${actualTitle}`)
          resolve({ success: true, windowTitle: actualTitle })
        } else if (output.startsWith('ERROR|')) {
          const errorMsg = output.split('|')[1] || '未知错误'
          log(`[launchClaudeWindow] 启动失败: ${errorMsg}`)
          resolve({ success: false, error: errorMsg })
        } else {
          // 假设启动成功
          log(`[launchClaudeWindow] 启动完成（无明确状态）: ${output}`)
          resolve({ success: true, windowTitle })
        }
      }
    )
  })
}

/**
 * 检测是否存在 Claude 窗口（单主窗口模式）
 * 用于 createSession() 检测已有的 Claude 实例
 *
 * 检测策略（按优先级）：
 * 1. 精确匹配: 标题为 "Claude - 项目名"（如果提供 projectName）
 * 2. 标题包含 "claude" / "Claude" / "CLAUDE"
 * 3. 标题包含 "✳" 符号（Claude Code 特有的任务标识符）
 * 4. 如果只有一个 cmd.exe 窗口，假定它是 Claude 窗口
 * 5. 如果只有一个终端窗口（任意类型），使用它
 *
 * @param projectName - 可选，项目名称用于精确匹配
 * @returns Promise<{found: boolean; windowTitle?: string; processName?: string}>
 */
async function detectClaudeWindow(projectName?: string): Promise<{ found: boolean; windowTitle?: string; processName?: string }> {
  return new Promise((resolve) => {
    // 安全转义项目名称（用于 PowerShell 字符串）
    const safeProjectName = projectName ? projectName.replace(/'/g, "''") : ''

    // PowerShell 脚本：查找 Claude 相关的终端窗口
    const psScript = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$projectName = '${safeProjectName}'

# 查找所有可能的终端进程
$allTerminals = Get-Process | Where-Object {
    ($_.ProcessName -eq "WindowsTerminal" -or
     $_.ProcessName -eq "powershell" -or
     $_.ProcessName -eq "pwsh" -or
     $_.ProcessName -eq "cmd") -and
    $_.MainWindowHandle -ne 0 -and
    $_.MainWindowTitle -ne ""
}

$targetWindow = $null
$strategy = ""

# 策略 0：精确匹配 "Claude - 项目名"（VibeCraft 创建的窗口）
if ($projectName) {
    $expectedTitle = "Claude - $projectName"
    $match = $allTerminals | Where-Object {
        $_.MainWindowTitle -eq $expectedTitle
    } | Select-Object -First 1
    if ($match) {
        $targetWindow = $match
        $strategy = "策略0:精确匹配项目窗口"
    }
}

# 策略 1：标题包含 "claude"（最明确的标识）
if (-not $targetWindow) {
    $match = $allTerminals | Where-Object {
        $_.MainWindowTitle -like "*claude*" -or
        $_.MainWindowTitle -like "*Claude*" -or
        $_.MainWindowTitle -like "*CLAUDE*"
    } | Select-Object -First 1

    if ($match) {
        $targetWindow = $match
        $strategy = "策略1:claude关键字"
    }
}

# 策略 2：标题包含 ✳ 符号（Claude Code 任务标识符）
if (-not $targetWindow) {
    $match = $allTerminals | Where-Object {
        $_.MainWindowTitle -match [char]0x2733  # ✳ 符号的 Unicode
    } | Select-Object -First 1
    if ($match) {
        $targetWindow = $match
        $strategy = "策略2:✳符号"
    }
}

# 策略 3：如果只有一个 cmd.exe 窗口，假定它是 Claude 窗口
if (-not $targetWindow) {
    $cmdWindows = $allTerminals | Where-Object { $_.ProcessName -eq "cmd" }
    if ($cmdWindows -and @($cmdWindows).Count -eq 1) {
        $targetWindow = $cmdWindows
        $strategy = "策略3:唯一cmd窗口"
    }
}

# 策略 4：如果只有一个终端窗口（任意类型），使用它
if (-not $targetWindow) {
    if ($allTerminals -and @($allTerminals).Count -eq 1) {
        $targetWindow = $allTerminals
        $strategy = "策略4:唯一终端窗口"
    }
}

if ($targetWindow) {
    Write-Output "FOUND|$($targetWindow.ProcessName)|$($targetWindow.MainWindowTitle)|$strategy"
} else {
    Write-Output "NOT_FOUND|终端窗口数:$(@($allTerminals).Count)"
}
`

    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', psScript],
      { ...EXEC_OPTIONS, timeout: 5000 },
      (error, stdout, stderr) => {
        if (error) {
          log(`[detectClaudeWindow] PowerShell 错误: ${stderr || error.message}`)
          resolve({ found: false })
          return
        }

        const output = stdout.trim()
        if (output.startsWith('FOUND|')) {
          const parts = output.split('|')
          const processName = parts[1] || ''
          const windowTitle = parts[2] || ''
          const strategy = parts[3] || ''
          log(`[detectClaudeWindow] 找到 Claude 窗口 (${strategy}): ${processName} - ${windowTitle}`)
          resolve({ found: true, processName, windowTitle })
        } else {
          // 输出格式: NOT_FOUND|终端窗口数:X
          log(`[detectClaudeWindow] 未找到 Claude 窗口 (${output})`)
          resolve({ found: false })
        }
      }
    )
  })
}

/**
 * Send text to Windows clipboard and paste to target window using PowerShell.
 * Uses clipboard + SendKeys as Windows doesn't have tmux.
 *
 * 搜索策略（单主窗口模式，按优先级）：
 * 0. 精确匹配: 标题为 "Claude - 项目名"（VibeCraft 创建的窗口）
 * 1. 查找标题包含项目名称 + Claude 关键字的窗口
 * 2. 查找标题包含 "claude" 关键字的窗口
 * 3. 查找标题包含 ✳ 符号的窗口（Claude Code 特征）
 * 4. 如果只有一个 cmd.exe 窗口，假定它是 Claude 窗口
 * 5. 如果只有一个终端窗口，使用它
 * 6. 如果都找不到，返回错误
 *
 * @param text - 要发送的文本
 * @param projectPath - 可选，项目路径用于精确匹配窗口
 */
async function sendToWindowsClipboard(text: string, projectPath?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // 写入临时文件，使用 UTF-8 编码避免编码问题
    const tempFile = join(DATA_DIR, `prompt-${Date.now()}-${randomBytes(8).toString('hex')}.txt`)

    try {
      writeFileSync(tempFile, text, 'utf8')
    } catch (err) {
      reject(new Error(`Failed to write temp file: ${err}`))
      return
    }

    // 提取项目文件夹名称用于匹配
    const projectName = projectPath ? projectPath.split(/[/\\]/).filter(Boolean).pop() || '' : ''
    // 安全转义项目名称（用于 PowerShell 字符串）
    const safeProjectName = projectName.replace(/'/g, "''")

    // PowerShell 脚本功能：
    // 1. 从 UTF-8 文件读取文本
    // 2. 设置剪贴板内容
    // 3. 通过窗口标题查找 Claude 窗口
    // 4. 发送 Ctrl+V 粘贴 + Enter 提交
    const psScript = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms

# 从临时文件读取文本 (UTF-8)
$text = Get-Content -Path '${tempFile.replace(/\\/g, '\\\\')}' -Raw -Encoding UTF8
if ($text) { $text = $text.TrimEnd() }

# 设置剪贴板
[System.Windows.Forms.Clipboard]::SetText($text)

# 参数
$projectName = '${safeProjectName}'

$targetWindow = $null

# 查找所有可能的终端窗口（Windows Terminal、PowerShell、cmd）
$allTerminals = Get-Process | Where-Object {
    ($_.ProcessName -eq "WindowsTerminal" -or
     $_.ProcessName -eq "powershell" -or
     $_.ProcessName -eq "pwsh" -or
     $_.ProcessName -eq "cmd") -and
    $_.MainWindowHandle -ne 0 -and
    $_.MainWindowTitle -ne ""
}

Write-Output "找到 $(@($allTerminals).Count) 个终端窗口"

# 策略 0：精确匹配 "Claude - 项目名"（VibeCraft 创建的窗口）
if ($projectName -and @($allTerminals).Count -gt 0) {
    $expectedTitle = "Claude - $projectName"
    $match = $allTerminals | Where-Object {
        $_.MainWindowTitle -eq $expectedTitle
    } | Select-Object -First 1
    if ($match) {
        $targetWindow = $match
        Write-Output "策略0: 精确匹配项目窗口: $expectedTitle"
    }
}

# 策略 1：查找标题包含项目名称 + Claude 关键字的窗口
if (-not $targetWindow -and $projectName -and @($allTerminals).Count -gt 0) {
    $match = $allTerminals | Where-Object {
        $_.MainWindowTitle -like "*$projectName*" -and
        ($_.MainWindowTitle -like "*claude*" -or
         $_.MainWindowTitle -like "*Claude*" -or
         $_.MainWindowTitle -like "*CLAUDE*" -or
         $_.MainWindowTitle -match [char]0x2733)  # ✳ 符号
    } | Select-Object -First 1
    if ($match) {
        $targetWindow = $match
        Write-Output "策略1: 匹配项目名称 + Claude: $projectName"
    }
}

# 策略 2：查找标题包含 "claude" 的窗口
if (-not $targetWindow -and @($allTerminals).Count -gt 0) {
    $match = $allTerminals | Where-Object {
        $_.MainWindowTitle -like "*claude*" -or
        $_.MainWindowTitle -like "*Claude*" -or
        $_.MainWindowTitle -like "*CLAUDE*"
    } | Select-Object -First 1
    if ($match) {
        $targetWindow = $match
        Write-Output "策略2: 匹配 claude 关键字"
    }
}

# 策略 3：查找标题包含 ✳ 符号的窗口（Claude Code 特征）
if (-not $targetWindow -and @($allTerminals).Count -gt 0) {
    $match = $allTerminals | Where-Object {
        $_.MainWindowTitle -match [char]0x2733  # ✳ 符号
    } | Select-Object -First 1
    if ($match) {
        $targetWindow = $match
        Write-Output "策略3: 匹配 Claude Code 特征符号"
    }
}

# 策略 4：如果只有一个 cmd.exe 窗口，假定它是 Claude 窗口
if (-not $targetWindow) {
    $cmdWindows = $allTerminals | Where-Object { $_.ProcessName -eq "cmd" }
    if ($cmdWindows -and @($cmdWindows).Count -eq 1) {
        $targetWindow = $cmdWindows
        Write-Output "策略4: 唯一 cmd.exe 窗口"
    }
}

# 策略 5：如果只有一个终端窗口（任意类型），使用它
if (-not $targetWindow) {
    if ($allTerminals -and @($allTerminals).Count -eq 1) {
        $targetWindow = $allTerminals
        Write-Output "策略5: 唯一终端窗口"
    }
}

if ($targetWindow) {
    Write-Output "目标窗口: $($targetWindow.ProcessName) - $($targetWindow.MainWindowTitle)"

    # 激活窗口
    $hwnd = $targetWindow.MainWindowHandle
    Add-Type @"
    using System;
    using System.Runtime.InteropServices;
    public class Win32 {
        [DllImport("user32.dll")]
        public static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("user32.dll")]
        public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    }
"@
    [Win32]::ShowWindow($hwnd, 9)  # SW_RESTORE
    [Win32]::SetForegroundWindow($hwnd)

    Start-Sleep -Milliseconds 300

    # 粘贴剪贴板内容
    [System.Windows.Forms.SendKeys]::SendWait('^v')
    Start-Sleep -Milliseconds 150

    # 发送 Enter 提交
    [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')

    Write-Output "OK - 已发送到 Claude 窗口"
} else {
    Write-Error "未找到 Claude 窗口。请确保 Claude CLI 正在运行（窗口标题包含 'claude' 或 ✳ 符号）。"
    exit 1
}
`

    // 运行 PowerShell 脚本
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', psScript],
      { ...EXEC_OPTIONS, timeout: 10000 },
      (error, stdout, stderr) => {
        // 清理临时文件
        try { unlinkSync(tempFile) } catch {}

        if (error) {
          log(`[Windows] PowerShell 错误: ${stderr || error.message}`)
          reject(new Error(`PowerShell error: ${stderr || error.message}`))
        } else {
          log(`[Windows] 窗口查找结果: ${stdout.trim()}`)
          resolve()
        }
      }
    )
  })
}

/**
 * 激活 Windows Terminal 窗口（不发送任何文本）
 * 用于自动唤醒功能 - 当用户选择一个 session 时激活对应的 Claude 窗口
 *
 * @param projectPath - 项目路径用于精确匹配窗口
 */
async function activateWindowsTerminal(projectPath?: string): Promise<{ success: boolean; windowTitle?: string; error?: string }> {
  return new Promise((resolve) => {
    const projectName = projectPath ? projectPath.split(/[/\\]/).filter(Boolean).pop() || '' : ''

    const psScript = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$projectName = '${projectName}'

# 查找所有终端窗口（Windows Terminal、PowerShell、cmd）
$terminalWindows = Get-Process | Where-Object {
    ($_.ProcessName -eq "WindowsTerminal" -or
     $_.ProcessName -eq "powershell" -or
     $_.ProcessName -eq "pwsh" -or
     $_.ProcessName -eq "cmd") -and
    $_.MainWindowHandle -ne 0 -and
    $_.MainWindowTitle -ne ""
}

$targetWindow = $null

# 策略 1：查找 VibeCraft 创建的窗口（标题以 "Claude - " 开头）
if ($terminalWindows.Count -gt 0) {
    $match = $terminalWindows | Where-Object { $_.MainWindowTitle -like "Claude - *" } | Select-Object -First 1
    if ($match) { $targetWindow = $match }
}

# 策略 2：查找标题包含项目名称 + Claude 的窗口
if (-not $targetWindow -and $projectName -and $terminalWindows.Count -gt 0) {
    $match = $terminalWindows | Where-Object {
        $_.MainWindowTitle -like "*$projectName*" -and
        ($_.MainWindowTitle -like "*claude*" -or $_.MainWindowTitle -like "*Claude*")
    } | Select-Object -First 1
    if ($match) { $targetWindow = $match }
}

# 策略 3：查找标题包含 claude 的窗口
if (-not $targetWindow -and $terminalWindows.Count -gt 0) {
    $match = $terminalWindows | Where-Object {
        $_.MainWindowTitle -like "*claude*" -or
        $_.MainWindowTitle -like "*Claude*" -or
        $_.MainWindowTitle -like "*CLAUDE*"
    } | Select-Object -First 1
    if ($match) { $targetWindow = $match }
}

# 策略 4：查找标题包含 ✳ 符号的窗口（Claude Code 特征）
if (-not $targetWindow -and $terminalWindows.Count -gt 0) {
    $match = $terminalWindows | Where-Object {
        $_.MainWindowTitle -match [char]0x2733  # ✳ 符号
    } | Select-Object -First 1
    if ($match) { $targetWindow = $match }
}

if ($targetWindow) {
    # 激活窗口
    $hwnd = $targetWindow.MainWindowHandle
    Add-Type @"
    using System;
    using System.Runtime.InteropServices;
    public class Win32Activate {
        [DllImport("user32.dll")]
        public static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("user32.dll")]
        public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    }
"@
    [Win32Activate]::ShowWindow($hwnd, 9)  # SW_RESTORE
    [Win32Activate]::SetForegroundWindow($hwnd)

    Write-Output "ACTIVATED:$($targetWindow.MainWindowTitle)"
} else {
    Write-Output "NOT_FOUND"
}
`

    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', psScript],
      { ...EXEC_OPTIONS, timeout: 5000 },
      (error, stdout, stderr) => {
        if (error) {
          log(`[Windows] 激活窗口失败: ${stderr || error.message}`)
          resolve({ success: false, error: stderr || error.message })
        } else {
          const output = stdout.trim()
          if (output.startsWith('ACTIVATED:')) {
            const windowTitle = output.substring('ACTIVATED:'.length)
            log(`[Windows] 已激活窗口: ${windowTitle}`)
            resolve({ success: true, windowTitle })
          } else {
            log(`[Windows] 未找到匹配窗口 (项目: ${projectName})`)
            resolve({ success: false, error: '未找到匹配的 Windows Terminal 窗口' })
          }
        }
      }
    )
  })
}

/**
 * Safely send text to a tmux session using load-buffer + paste-buffer.
 * Uses execFile with proper arguments to prevent shell injection.
 * On Windows, uses clipboard + SendKeys instead.
 *
 * @param tmuxSession - tmux session 名称（Unix）或忽略（Windows）
 * @param text - 要发送的文本
 * @param projectPath - 可选，项目路径用于 Windows 精确匹配窗口
 */
async function sendToTmuxSafe(tmuxSession: string, text: string, projectPath?: string): Promise<void> {
  // On Windows, use clipboard + SendKeys approach
  if (IS_WINDOWS) {
    await sendToWindowsClipboard(text, projectPath)
    return
  }

  // Validate session name (Unix only)
  validateTmuxSession(tmuxSession)

  // Create temp file with cryptographically secure random name
  const tempFile = `/tmp/vibecraft-prompt-${Date.now()}-${randomBytes(16).toString('hex')}.txt`
  writeFileSync(tempFile, text)

  try {
    // Load text into tmux buffer
    await execFileAsync('tmux', ['load-buffer', tempFile])
    // Paste buffer into session
    await execFileAsync('tmux', ['paste-buffer', '-t', tmuxSession])
    // Send Enter to submit
    await new Promise(r => setTimeout(r, 100)) // Small delay like original
    await execFileAsync('tmux', ['send-keys', '-t', tmuxSession, 'Enter'])
  } finally {
    // Clean up temp file
    try {
      unlinkSync(tempFile)
    } catch {
      // Ignore cleanup errors
    }
  }
}

// ============================================================================
// State
// ============================================================================

/** All events in memory */
const events: ClaudeEvent[] = []

/** Track seen event IDs to prevent duplicates (from file watcher + POST) */
const seenEventIds = new Set<string>()

/** Track in-flight tool uses for duration calculation */
const pendingToolUses = new Map<string, PreToolUseEvent>()

/** Connected WebSocket clients */
const clients = new Set<WebSocket>()

/** Last read position in file */
let lastFileSize = 0

/** Token tracking per session */
interface SessionTokens {
  lastSeen: number  // Last token count seen in output
  cumulative: number  // Running total (estimated)
  lastUpdate: number  // Timestamp
}
const sessionTokens = new Map<string, SessionTokens>()

/** Last parsed tmux output (to detect changes) */
let lastTmuxHash = ''

/** Track pending permission prompts per session */
interface PermissionOption {
  number: string     // "1", "2", "3"
  label: string      // "Yes", "Yes, and always allow...", "No"
}

interface PermissionPrompt {
  tool: string
  context: string       // The full prompt text
  options: PermissionOption[]  // Available choices
  detectedAt: number
}
const pendingPermissions = new Map<string, PermissionPrompt>()

/** Track sessions that have had the bypass permissions warning handled */
const bypassWarningHandled = new Set<string>()

/** Managed sessions registry */
const managedSessions = new Map<string, ManagedSession>()

/** Text tiles (grid labels) */
const textTiles = new Map<string, TextTile>()

/** Git status tracker for managed sessions */
const gitStatusManager = new GitStatusManager()

/** Project directories manager */
const projectsManager = new ProjectsManager()

/** Active voice transcription sessions (WebSocket client → Deepgram connection) */
const voiceSessions = new Map<WebSocket, LiveClient>()

/** Deepgram API key (loaded on startup) */
let deepgramApiKey: string | null = null

/** Load Deepgram API key from environment */
function loadDeepgramKey(): string | null {
  const key = process.env[DEEPGRAM_API_KEY_ENV]?.trim()
  if (key) {
    log('Deepgram API key loaded from environment')
    return key
  }
  log(`${DEEPGRAM_API_KEY_ENV} not set - voice input disabled`)
  return null
}

/** Map Claude Code session IDs to our managed session IDs */
const claudeToManagedMap = new Map<string, string>()

/** Counter for generating session names */
let sessionCounter = 0

// ============================================================================
// Logging
// ============================================================================

function log(...args: unknown[]) {
  console.log(`[${new Date().toISOString()}]`, ...args)
}

function debug(...args: unknown[]) {
  if (DEBUG) {
    console.log(`[DEBUG ${new Date().toISOString()}]`, ...args)
  }
}

// ============================================================================
// Token Tracking
// ============================================================================

/**
 * Parse token count from Claude Code output
 * Patterns:
 *   ↓ 879 tokens
 *   ↓ 1,234 tokens
 *   ↓ 12.5k tokens
 *   ↓ 12k tokens
 */
function parseTokensFromOutput(output: string): number | null {
  // Match patterns like: ↓ 879 tokens, ↓ 1,234 tokens, ↓ 12.5k tokens
  const patterns = [
    /↓\s*([0-9,]+)\s*tokens?/gi,           // ↓ 879 tokens, ↓ 1,234 tokens
    /↓\s*([0-9.]+)k\s*tokens?/gi,          // ↓ 12.5k tokens, ↓ 12k tokens
  ]

  let maxTokens = 0

  // Pattern 1: plain numbers (possibly with commas)
  const plainMatches = output.matchAll(patterns[0])
  for (const match of plainMatches) {
    const num = parseInt(match[1].replace(/,/g, ''), 10)
    if (num > maxTokens) maxTokens = num
  }

  // Pattern 2: k suffix (thousands)
  const kMatches = output.matchAll(patterns[1])
  for (const match of kMatches) {
    const num = Math.round(parseFloat(match[1]) * 1000)
    if (num > maxTokens) maxTokens = num
  }

  return maxTokens > 0 ? maxTokens : null
}

/**
 * Poll tmux output for token counts
 */
function pollTokens(tmuxSession: string): void {
  try {
    validateTmuxSession(tmuxSession)
  } catch {
    debug(`Invalid tmux session for token polling: ${tmuxSession}`)
    return
  }

  execFile('tmux', ['capture-pane', '-t', tmuxSession, '-p', '-S', '-50'], { ...EXEC_OPTIONS, maxBuffer: 1024 * 1024 }, (error, stdout) => {
    if (error) {
      debug(`Token poll failed: ${error.message}`)
      return
    }

    // Simple hash to detect changes
    const hash = stdout.slice(-500)
    if (hash === lastTmuxHash) return
    lastTmuxHash = hash

    const tokens = parseTokensFromOutput(stdout)
    if (tokens === null) return

    // Update session tokens (use TMUX_SESSION as session ID for now)
    let session = sessionTokens.get(tmuxSession)
    if (!session) {
      session = { lastSeen: 0, cumulative: 0, lastUpdate: Date.now() }
      sessionTokens.set(tmuxSession, session)
    }

    // If we see a higher token count, update cumulative
    if (tokens > session.lastSeen) {
      const delta = tokens - session.lastSeen
      session.cumulative += delta
      session.lastSeen = tokens
      session.lastUpdate = Date.now()

      debug(`Tokens updated: ${tokens} (cumulative: ${session.cumulative})`)

      // Broadcast token update
      broadcast({
        type: 'tokens',
        payload: {
          session: tmuxSession,
          current: tokens,
          cumulative: session.cumulative,
        },
      } as ServerMessage)
    } else if (tokens < session.lastSeen && tokens > 0) {
      // Token count dropped - likely new conversation, reset tracking
      session.lastSeen = tokens
      session.lastUpdate = Date.now()
      debug(`Token count reset detected: ${tokens}`)
    }
  })
}

// ============================================================================
// Cross-Platform Token Tracking
// ============================================================================

/**
 * Token tracking state for event-based estimation.
 * Used on Windows (primary) and as fallback on Unix.
 * More accurate than simple character counting - uses Claude's tokenization approximation.
 */
const tokenEstimates = new Map<string, {
  input: number      // Tokens from user input
  output: number     // Tokens from tool outputs
  toolCalls: number  // Tokens from tool invocations
  cumulative: number // Running total
  lastUpdate: number // Timestamp of last update
}>()

/**
 * Estimate tokens using Claude's approximate tokenization rules:
 * - ~4 characters per token for English text
 * - ~2-3 characters per token for code
 * - JSON/structured data varies
 */
function estimateTokenCount(text: string): number {
  if (!text) return 0

  // Detect content type and adjust ratio
  const isCode = /[{}\[\]();=<>]/.test(text) && text.includes('\n')
  const isJson = text.trim().startsWith('{') || text.trim().startsWith('[')

  let charsPerToken = 4 // Default for English text
  if (isCode) charsPerToken = 3
  if (isJson) charsPerToken = 3.5

  return Math.ceil(text.length / charsPerToken)
}

/**
 * Track tokens from event data.
 * Works cross-platform - used on Windows and as supplement on Unix.
 */
function trackEventTokens(event: ClaudeEvent, sessionId: string): void {
  let estimate = tokenEstimates.get(sessionId)
  if (!estimate) {
    estimate = { input: 0, output: 0, toolCalls: 0, cumulative: 0, lastUpdate: Date.now() }
    tokenEstimates.set(sessionId, estimate)
  }

  let tokensAdded = 0

  // Track input from user prompts
  if (event.type === 'user_prompt_submit') {
    const promptEvent = event as UserPromptSubmitEvent
    if (promptEvent.prompt) {
      const inputTokens = estimateTokenCount(promptEvent.prompt)
      estimate.input += inputTokens
      tokensAdded += inputTokens
      debug(`[Tokens] +${inputTokens} from user prompt`)
    }
  }

  // Track tool inputs (pre_tool_use)
  if (event.type === 'pre_tool_use') {
    const toolEvent = event as PreToolUseEvent
    if (toolEvent.toolInput) {
      const inputStr = typeof toolEvent.toolInput === 'string'
        ? toolEvent.toolInput
        : JSON.stringify(toolEvent.toolInput)
      // Cap at 10K chars to avoid huge estimates from large inputs
      const toolInputTokens = estimateTokenCount(inputStr.slice(0, 10000))
      estimate.toolCalls += toolInputTokens
      tokensAdded += toolInputTokens
      debug(`[Tokens] +${toolInputTokens} from ${toolEvent.tool} input`)
    }
  }

  // Track tool outputs (post_tool_use)
  if (event.type === 'post_tool_use') {
    const toolEvent = event as PostToolUseEvent
    if (toolEvent.toolResponse) {
      const outputStr = typeof toolEvent.toolResponse === 'string'
        ? toolEvent.toolResponse
        : JSON.stringify(toolEvent.toolResponse)
      // Cap at 50K chars to avoid huge estimates from large file reads
      const outputTokens = estimateTokenCount(outputStr.slice(0, 50000))
      estimate.output += outputTokens
      tokensAdded += outputTokens
      debug(`[Tokens] +${outputTokens} from ${toolEvent.tool} output`)
    }
  }

  if (tokensAdded > 0) {
    estimate.cumulative += tokensAdded
    estimate.lastUpdate = Date.now()

    // Update managed session
    const managedSession = findManagedSession(sessionId)
    if (managedSession) {
      const currentTokens = estimate.input + estimate.output + estimate.toolCalls
      managedSession.tokens = {
        current: currentTokens,
        cumulative: estimate.cumulative,
      }

      // Broadcast token update
      broadcast({
        type: 'tokens',
        payload: {
          session: managedSession.tmuxSession,
          current: currentTokens,
          cumulative: estimate.cumulative,
        },
      } as ServerMessage)
    }
  }
}

/**
 * Reset token tracking for a session
 */
function resetTokenTracking(claudeSessionId: string): void {
  tokenEstimates.delete(claudeSessionId)
  debug(`[Tokens] Reset tracking for session ${claudeSessionId}`)
}

/**
 * Start polling for tokens (Unix tmux-based polling + event tracking)
 */
function startTokenPolling(): void {
  // Event-based token tracking is always active (cross-platform)
  log(`Token tracking enabled`)

  // On Windows, we rely entirely on event-based tracking
  if (IS_WINDOWS) {
    return
  }

  // Poll every 2 seconds - poll all managed sessions
  setInterval(() => {
    for (const session of managedSessions.values()) {
      if (session.status !== 'offline') {
        pollTokens(session.tmuxSession)
      }
    }
    // Also poll the default session for backwards compatibility
    if (!managedSessions.size) {
      pollTokens(TMUX_SESSION)
    }
  }, 2000)
  log(`Token polling started`)
}

// ============================================================================
// Permission Prompt Detection
// ============================================================================

/**
 * Parse tmux output to detect Claude Code permission prompts.
 *
 * Claude Code prompts look like:
 *   ● Bash(rm /tmp/test.txt)
 *   ⎿  Running PreToolUse hook…
 *   ─────────────────────────────
 *   Bash command
 *
 *      rm /tmp/test.txt
 *
 *   Do you want to proceed?
 *   ❯ 1. Yes
 *     2. Yes, and always allow access to tmp/ from this project
 *     3. No
 *
 *   Esc to cancel · Tab to add additional instructions
 *
 * OR (plan mode):
 *   · Bash(prompt: run TypeScript compiler)
 *   Would you like to proceed?
 *
 *     1. Yes, and bypass permissions
 *   ❯ 2. Yes, and manually approve edits
 *     3. Type here to tell Claude what to change
 *
 *   ctrl-g to edit in Vim · ~/.claude/plans/...
 */
function detectPermissionPrompt(output: string): { tool: string; context: string; options: PermissionOption[] } | null {
  const lines = output.split('\n')

  // Look for "Do you want to proceed?" OR "Would you like to proceed?" in recent output
  let proceedLineIdx = -1
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 30); i--) {
    if (/(Do you want|Would you like) to proceed\?/i.test(lines[i])) {
      proceedLineIdx = i
      break
    }
  }

  if (proceedLineIdx === -1) return null

  // CRITICAL: Verify this is a real Claude Code prompt by checking for the footer
  // "Esc to cancel · Tab to add additional instructions" OR "ctrl-g to edit in Vim"
  let hasFooter = false
  let hasSelector = false
  for (let i = proceedLineIdx + 1; i < Math.min(lines.length, proceedLineIdx + 15); i++) {
    if (/Esc to cancel|ctrl-g to edit/i.test(lines[i])) {
      hasFooter = true
      break
    }
    // Also check for the ❯ selector arrow which indicates the interactive menu
    if (/^\s*❯/.test(lines[i])) {
      hasSelector = true
    }
  }

  // Must have either the footer or the selector arrow to be a real prompt
  if (!hasFooter && !hasSelector) {
    debug('Skipping false positive: no "Esc to cancel"/"ctrl-g" footer or ❯ selector found')
    return null
  }

  // Parse numbered options below the "Do you want to proceed?" line
  const options: PermissionOption[] = []
  for (let i = proceedLineIdx + 1; i < Math.min(lines.length, proceedLineIdx + 10); i++) {
    const line = lines[i]

    // Stop if we hit the footer
    if (/Esc to cancel/i.test(line)) break

    // Match options like "❯ 1. Yes" or "  2. Yes, and always..."
    // The arrow (❯) indicates current selection, but we want all options
    const optionMatch = line.match(/^\s*[❯>]?\s*(\d+)\.\s+(.+)$/)
    if (optionMatch) {
      options.push({
        number: optionMatch[1],
        label: optionMatch[2].trim()
      })
    }
  }

  // Need at least 2 options to be valid
  if (options.length < 2) return null

  // Find the tool name - look backwards for "● ToolName(...)" or "Bash command" header
  let tool = 'Unknown'
  for (let i = proceedLineIdx; i >= Math.max(0, proceedLineIdx - 20); i--) {
    // Match tool header like "● Bash(rm /tmp/test.txt)" or "· Bash(prompt: ...)"
    // ● = bullet, ◐ = half-filled circle, · = middle dot (plan mode)
    const toolMatch = lines[i].match(/[●◐·]\s*(\w+)\s*\(/)
    if (toolMatch) {
      tool = toolMatch[1]
      break
    }
    // Also match standalone tool type like "Bash command" or "Read file"
    const cmdMatch = lines[i].match(/^\s*(Bash|Read|Write|Edit|Grep|Glob|Task|WebFetch|WebSearch)\s+\w+/i)
    if (cmdMatch) {
      tool = cmdMatch[1]
      break
    }
  }

  // Build context from the prompt area (between tool header and options)
  const contextStart = Math.max(0, proceedLineIdx - 10)
  const contextEnd = proceedLineIdx + 1 + options.length
  const context = lines.slice(contextStart, contextEnd).join('\n').trim()

  debug(`Detected permission prompt: tool=${tool}, options=${options.map(o => o.number + ':' + o.label).join(', ')}`)

  return { tool, context, options }
}

/**
 * Detect the bypass permissions warning that appears on first use of --dangerously-skip-permissions.
 * Returns true if the warning is detected and needs to be accepted.
 *
 * The warning looks like:
 *   ╭──────────────────────────────────────────────────────────────────────────────╮
 *   │                                  WARNING                                     │
 *   │                                                                              │
 *   │  You are entering Bypass Permissions mode. In this mode:                     │
 *   │   • All tool calls will be auto-approved                                     │
 *   │   ...                                                                        │
 *   │                                                                              │
 *   │  Are you sure you want to continue?                                          │
 *   │                                                                              │
 *   │      1. No, exit Claude Code                                                 │
 *   │    ❯ 2. Yes, I understand and accept the risks                               │
 *   ╰──────────────────────────────────────────────────────────────────────────────╯
 */
function detectBypassWarning(output: string): boolean {
  // Must have both WARNING and Bypass Permissions mode
  return output.includes('WARNING') && output.includes('Bypass Permissions mode')
}

/**
 * Poll a session for permission prompts
 */
function pollPermissions(sessionId: string, tmuxSession: string): void {
  try {
    validateTmuxSession(tmuxSession)
  } catch {
    debug(`Invalid tmux session for permission polling: ${tmuxSession}`)
    return
  }

  execFile('tmux', ['capture-pane', '-t', tmuxSession, '-p', '-S', '-50'], { ...EXEC_OPTIONS, maxBuffer: 1024 * 1024 }, (error, stdout) => {
    if (error) {
      debug(`Permission poll failed for ${tmuxSession}: ${error.message}`)
      return
    }

    // Check for bypass permissions warning (first-time use of --dangerously-skip-permissions)
    if (detectBypassWarning(stdout) && !bypassWarningHandled.has(sessionId)) {
      log(`Bypass permissions warning detected for session ${sessionId}, auto-accepting...`)
      bypassWarningHandled.add(sessionId)
      // Send "2" to accept the warning
      execFile('tmux', ['send-keys', '-t', tmuxSession, '2'], EXEC_OPTIONS, (err) => {
        if (err) {
          log(`Failed to auto-accept bypass warning: ${err.message}`)
        } else {
          log(`Bypass permissions warning accepted for session ${sessionId}`)
        }
      })
      return // Don't process further this poll cycle
    }

    const prompt = detectPermissionPrompt(stdout)
    const existing = pendingPermissions.get(sessionId)

    if (prompt && !existing) {
      // New permission prompt detected
      pendingPermissions.set(sessionId, {
        tool: prompt.tool,
        context: prompt.context,
        options: prompt.options,
        detectedAt: Date.now(),
      })

      log(`Permission prompt detected for session ${sessionId}: ${prompt.tool} (${prompt.options.length} options)`)

      // Broadcast to clients with options
      broadcast({
        type: 'permission_prompt',
        payload: {
          sessionId,
          tool: prompt.tool,
          context: prompt.context,
          options: prompt.options,
        },
      } as ServerMessage)

      // Update session status
      const session = managedSessions.get(sessionId)
      if (session) {
        session.status = 'waiting'
        session.currentTool = prompt.tool
        broadcastSessions()
      }
    } else if (!prompt && existing) {
      // Permission prompt was resolved (user responded in terminal or elsewhere)
      pendingPermissions.delete(sessionId)
      log(`Permission prompt resolved for session ${sessionId}`)

      // Broadcast resolution
      broadcast({
        type: 'permission_resolved',
        payload: { sessionId },
      } as ServerMessage)

      // Reset session status
      const session = managedSessions.get(sessionId)
      if (session && session.status === 'waiting') {
        session.status = 'working'
        session.currentTool = undefined
        broadcastSessions()
      }
    }
  })
}

/**
 * Start polling for permission prompts
 */
function startPermissionPolling(): void {
  // On Windows, managed sessions use --dangerously-skip-permissions mode
  // This is the recommended mode for development and automated use
  if (IS_WINDOWS) {
    log(`Permission handling: auto-approve mode (Windows)`)
    return
  }

  // Poll every 1 second (more frequent than tokens since permissions are time-sensitive)
  setInterval(() => {
    for (const session of managedSessions.values()) {
      if (session.status !== 'offline') {
        pollPermissions(session.id, session.tmuxSession)
      }
    }
  }, 1000)
  log(`Permission polling started`)
}

/**
 * Send a permission response to a session.
 * The response should be the option number ("1", "2", "3", etc.)
 */
function sendPermissionResponse(sessionId: string, optionNumber: string): boolean {
  const session = managedSessions.get(sessionId)
  if (!session) {
    log(`Cannot send permission response: session ${sessionId} not found`)
    return false
  }

  // Validate it's a number
  if (!/^\d+$/.test(optionNumber)) {
    log(`Invalid permission response: ${optionNumber} (expected number)`)
    return false
  }

  // Validate tmux session name
  try {
    validateTmuxSession(session.tmuxSession)
  } catch {
    log(`Invalid tmux session name: ${session.tmuxSession}`)
    return false
  }

  // Send the option number to tmux - Claude Code expects just the number
  execFile('tmux', ['send-keys', '-t', session.tmuxSession, optionNumber], EXEC_OPTIONS, (error) => {
    if (error) {
      log(`Failed to send permission response: ${error.message}`)
      return
    }

    log(`Sent permission response to ${session.name}: option ${optionNumber}`)

    // Clear the pending permission
    pendingPermissions.delete(sessionId)

    // Update session status
    session.status = 'working'
    session.currentTool = undefined
    broadcastSessions()
  })

  return true
}

// ============================================================================
// Session Management
// ============================================================================

/**
 * Generate a short ID for tmux session names
 */
function shortId(): string {
  return randomUUID().slice(0, 8)
}

/**
 * Create a new managed session
 */
function createSession(options: CreateSessionRequest = {}): Promise<ManagedSession> {
  return new Promise((resolve, reject) => {
    const id = randomUUID()
    sessionCounter++
    const name = options.name || `Claude ${sessionCounter}`
    const tmuxSession = `vibecraft-${shortId()}`

    // Validate cwd to prevent command injection
    let cwd: string
    try {
      cwd = validateDirectoryPath(options.cwd || process.cwd())
    } catch (err) {
      reject(err)
      return
    }

    // 构建 claude 命令参数
    const flags = options.flags || {}
    const claudeArgs: string[] = []

    // 注意：不默认添加 -c (continue) 参数
    // 因为新项目目录可能没有之前的对话，会导致 "No conversation found to continue" 错误
    // 只有明确指定 continue=true 时才添加 -c
    if (flags.continue === true) {
      claudeArgs.push('-c')
    }
    if (flags.skipPermissions !== false) {
      // --permission-mode=bypassPermissions 跳过工作区信任对话框
      // --dangerously-skip-permissions 跳过工具权限提示
      claudeArgs.push('--permission-mode=bypassPermissions')
      claudeArgs.push('--dangerously-skip-permissions')
    }
    if (flags.chrome) {
      claudeArgs.push('--chrome')
    }

    const claudeCmd = claudeArgs.length > 0 ? `claude ${claudeArgs.join(' ')}` : 'claude'

    // Platform-specific session spawning
    if (IS_WINDOWS) {
      // Windows: 自动启动模式
      // 1. 首先检测是否有匹配项目的 Claude 窗口
      // 2. 如果没有，自动启动新的 Claude 窗口
      // 3. 使用 Windows Terminal (wt.exe) 启动，设置窗口标题

      const projectName = cwd.split(/[/\\]/).filter(Boolean).pop() || 'Unknown'
      log(`[Windows] 自动启动模式 - 项目: ${projectName}`)
      log(`[Windows] Session 目录: ${cwd}`)

      // 步骤 1: 使用 detectClaudeWindow() 检测已有的 Claude 窗口
      detectClaudeWindow(projectName).then(async (detection) => {
        let windowTitle: string | undefined = detection.windowTitle

        // 步骤 2: 如果没有找到窗口，自动启动新窗口
        if (!detection.found) {
          log(`[Windows] 未检测到 Claude 窗口，自动启动新窗口...`)

          // 使用 launchClaudeWindow 启动新窗口
          const launchResult = await launchClaudeWindow(cwd, claudeArgs)

          if (!launchResult.success) {
            log(`[Windows] 自动启动 Claude 窗口失败: ${launchResult.error}`)
            reject(new Error(
              `自动启动 Claude 窗口失败: ${launchResult.error}\n\n` +
              '请确保已安装 Windows Terminal (wt.exe)。\n' +
              '或手动启动 Claude CLI：\n' +
              `  1. 打开终端（Windows Terminal 或 cmd）\n` +
              `  2. cd "${cwd}"\n` +
              `  3. ${claudeCmd}\n` +
              '然后重新创建 session。'
            ))
            return
          }

          windowTitle = launchResult.windowTitle
          log(`[Windows] 成功启动 Claude 窗口: ${windowTitle}`)
        } else {
          log(`[Windows] 检测到 Claude 窗口: ${detection.processName} - ${detection.windowTitle}`)
        }

        const session: ManagedSession = {
          id,
          name,
          tmuxSession, // 保留兼容性（Unix 用）
          status: 'idle',
          createdAt: Date.now(),
          lastActivity: Date.now(),
          cwd,
          windowTitle, // 保存窗口标题（检测到的或新启动的）
        }

        managedSessions.set(id, session)
        log(`[Windows] 创建 session: ${name} (${id.slice(0, 8)}) -> 窗口: "${windowTitle}"`)

        // 跟踪此 session 的 git 状态
        if (cwd) {
          gitStatusManager.track(id, cwd)
          projectsManager.addProject(cwd, name)
        }

        // 广播并持久化
        broadcastSessions()
        saveSessions()

        resolve(session)
      }).catch((err) => {
        log(`[Windows] 检测 Claude 窗口失败: ${err.message}`)
        reject(new Error(`检测 Claude 窗口失败: ${err.message}`))
      })
    } else {
      // Unix: Spawn tmux session with claude using execFile to prevent shell injection
      // Arguments are passed as array, not interpolated into a shell string
      execFile('tmux', [
        'new-session',
        '-d',
        '-s', tmuxSession,
        '-c', cwd,
        `PATH=${EXEC_PATH} ${claudeCmd}`
      ], EXEC_OPTIONS, (error) => {
        if (error) {
          log(`Failed to spawn session: ${error.message}`)
          reject(new Error(`Failed to spawn session: ${error.message}`))
          return
        }

        const session: ManagedSession = {
          id,
          name,
          tmuxSession,
          status: 'idle',
          createdAt: Date.now(),
          lastActivity: Date.now(),
          cwd,
        }

        managedSessions.set(id, session)
        log(`Created session: ${name} (${id.slice(0, 8)}) -> tmux:${tmuxSession} cmd:'${claudeCmd}'`)

        // Track git status for this session
        if (cwd) {
          gitStatusManager.track(id, cwd)
          // Remember this directory for future autocomplete
          projectsManager.addProject(cwd, name)
        }

        // Broadcast and persist
        broadcastSessions()
        saveSessions()

        resolve(session)
      })
    }
  })
}

/**
 * Get all managed sessions
 */
function getSessions(): ManagedSession[] {
  return Array.from(managedSessions.values()).map(session => ({
    ...session,
    gitStatus: gitStatusManager.getStatus(session.id) ?? undefined,
  }))
}

/**
 * Get a session by ID
 */
function getSession(id: string): ManagedSession | undefined {
  return managedSessions.get(id)
}

/**
 * Update a session
 */
function updateSession(id: string, updates: UpdateSessionRequest): ManagedSession | null {
  const session = managedSessions.get(id)
  if (!session) return null

  if (updates.name) {
    session.name = updates.name
  }
  if (updates.zonePosition) {
    session.zonePosition = updates.zonePosition
  }

  log(`Updated session: ${session.name} (${id.slice(0, 8)})`)
  broadcastSessions()
  saveSessions()
  return session
}

/**
 * Delete/kill a session
 */
function deleteSession(id: string): Promise<boolean> {
  return new Promise((resolve) => {
    const session = managedSessions.get(id)
    if (!session) {
      resolve(false)
      return
    }

    // Kill the tmux session using execFile to prevent shell injection
    try {
      validateTmuxSession(session.tmuxSession)
    } catch {
      log(`Invalid tmux session name: ${session.tmuxSession}`)
      resolve(false)
      return
    }

    execFile('tmux', ['kill-session', '-t', session.tmuxSession], EXEC_OPTIONS, (error) => {
      if (error) {
        log(`Warning: Failed to kill tmux session: ${error.message}`)
      }

      managedSessions.delete(id)
      gitStatusManager.untrack(id)
      // Clean up mapping
      for (const [claudeId, managedId] of claudeToManagedMap) {
        if (managedId === id) {
          claudeToManagedMap.delete(claudeId)
        }
      }

      log(`Deleted session: ${session.name} (${id.slice(0, 8)})`)
      broadcastSessions()
      saveSessions()
      resolve(true)
    })
  })
}

/**
 * Send a prompt to a specific session
 * Windows: 发送 prompt 到 Windows Terminal 中运行的 Claude CLI
 * 优先匹配包含项目路径或 claude 关键字的窗口
 */
async function sendPromptToSession(id: string, prompt: string): Promise<{ ok: boolean; error?: string }> {
  const session = managedSessions.get(id)
  if (!session) {
    return { ok: false, error: 'Session not found' }
  }

  try {
    if (IS_WINDOWS) {
      log(`[Windows] 发送 prompt 到 Terminal (session: ${session.name}, cwd: ${session.cwd})`)
    }

    // 传递项目路径用于精确匹配 Windows Terminal 窗口
    await sendToTmuxSafe(session.tmuxSession, prompt, session.cwd)
    session.lastActivity = Date.now()
    log(`Prompt sent to ${session.name}: ${prompt.slice(0, 50)}...`)
    return { ok: true }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    log(`Failed to send prompt to ${session.name}: ${msg}`)
    return { ok: false, error: msg }
  }
}

/**
 * Check if tmux sessions are still alive and update status
 */
function checkSessionHealth(): void {
  // Skip on Windows - tmux not available
  if (IS_WINDOWS) {
    return
  }

  exec('tmux list-sessions -F "#{session_name}"', EXEC_OPTIONS, (error, stdout) => {
    if (error) {
      // tmux might not be running
      for (const session of managedSessions.values()) {
        if (session.status !== 'offline') {
          session.status = 'offline'
        }
      }
      return
    }

    const activeSessions = new Set(stdout.trim().split('\n'))
    let changed = false

    for (const session of managedSessions.values()) {
      const isAlive = activeSessions.has(session.tmuxSession)
      const newStatus = isAlive ? (session.status === 'offline' ? 'idle' : session.status) : 'offline'

      if (session.status !== newStatus) {
        session.status = newStatus
        changed = true
      }
    }

    if (changed) {
      broadcastSessions()
      saveSessions() // Persist state changes
    }
  })
}

/**
 * Check for stale "working" sessions and transition them to idle
 * This is a failsafe for missed stop events
 */
function checkWorkingTimeout(): void {
  const now = Date.now()
  let changed = false

  for (const session of managedSessions.values()) {
    if (session.status === 'working') {
      const timeSinceActivity = now - session.lastActivity
      if (timeSinceActivity > WORKING_TIMEOUT_MS) {
        log(`Session "${session.name}" timed out after ${Math.round(timeSinceActivity / 1000)}s of no activity`)
        session.status = 'idle'
        session.currentTool = undefined
        changed = true
      }
    }
  }

  if (changed) {
    broadcastSessions()
    saveSessions()
  }
}

/**
 * Save sessions to disk for persistence across restarts
 */
function saveSessions(): void {
  try {
    const data = {
      sessions: Array.from(managedSessions.values()),
      claudeToManagedMap: Array.from(claudeToManagedMap.entries()),
      sessionCounter,
    }
    writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2))
    debug(`Saved ${managedSessions.size} sessions to ${SESSIONS_FILE}`)
  } catch (e) {
    console.error('Failed to save sessions:', e)
  }
}

/**
 * Load sessions from disk on startup
 */
function loadSessions(): void {
  if (!existsSync(SESSIONS_FILE)) {
    debug('No saved sessions file found')
    return
  }

  try {
    const content = readFileSync(SESSIONS_FILE, 'utf-8')
    const data = JSON.parse(content)

    // Restore sessions
    if (Array.isArray(data.sessions)) {
      for (const session of data.sessions) {
        // Mark all as offline initially - health check will update
        session.status = 'offline'
        session.currentTool = undefined
        managedSessions.set(session.id, session)
        // Track git status if session has a cwd
        if (session.cwd) {
          gitStatusManager.track(session.id, session.cwd)
        }
      }
    }

    // Restore linking map
    if (Array.isArray(data.claudeToManagedMap)) {
      for (const [claudeId, managedId] of data.claudeToManagedMap) {
        claudeToManagedMap.set(claudeId, managedId)
      }
    }

    // Restore counter
    if (typeof data.sessionCounter === 'number') {
      sessionCounter = data.sessionCounter
    }

    log(`Loaded ${managedSessions.size} sessions from ${SESSIONS_FILE}`)
  } catch (e) {
    console.error('Failed to load sessions:', e)
  }
}

/**
 * Broadcast current sessions to all clients
 */
function broadcastSessions(): void {
  broadcast({
    type: 'sessions',
    payload: getSessions(),
  })
}

// ============================================================================
// Text Tiles (Grid Labels)
// ============================================================================

/**
 * Get all text tiles
 */
function getTiles(): TextTile[] {
  return Array.from(textTiles.values())
}

/**
 * Save text tiles to disk
 */
function saveTiles(): void {
  try {
    const data = Array.from(textTiles.values())
    writeFileSync(TILES_FILE, JSON.stringify(data, null, 2))
    debug(`Saved ${textTiles.size} tiles to ${TILES_FILE}`)
  } catch (e) {
    console.error('Failed to save tiles:', e)
  }
}

/**
 * Load text tiles from disk
 */
function loadTiles(): void {
  if (!existsSync(TILES_FILE)) {
    debug('No saved tiles file found')
    return
  }

  try {
    const content = readFileSync(TILES_FILE, 'utf-8')
    const data = JSON.parse(content) as TextTile[]

    for (const tile of data) {
      textTiles.set(tile.id, tile)
    }

    log(`Loaded ${textTiles.size} tiles from ${TILES_FILE}`)
  } catch (e) {
    console.error('Failed to load tiles:', e)
  }
}

/**
 * Broadcast text tiles to all clients
 */
function broadcastTiles(): void {
  broadcast({
    type: 'text_tiles',
    payload: getTiles(),
  })
}

// ============================================================================
// Voice Transcription (Deepgram)
// ============================================================================

/**
 * Start a voice transcription session for a WebSocket client
 */
function startVoiceSession(ws: WebSocket): boolean {
  if (!deepgramApiKey) {
    ws.send(JSON.stringify({ type: 'voice_error', payload: { error: 'Voice input not configured' } }))
    return false
  }

  // Clean up any existing session
  stopVoiceSession(ws)

  try {
    const deepgram = createClient(deepgramApiKey)
    const connection = deepgram.listen.live({
      model: DEEPGRAM_MODEL,
      language: DEEPGRAM_LANGUAGE,
      smart_format: true,
      interim_results: true,
      utterance_end_ms: 1000,
      vad_events: true,
      encoding: 'linear16',
      sample_rate: 16000,
    })

    connection.on(LiveTranscriptionEvents.Open, () => {
      ws.send(JSON.stringify({ type: 'voice_ready', payload: {} }))
    })

    connection.on(LiveTranscriptionEvents.Transcript, (data) => {
      const transcript = data.channel?.alternatives?.[0]?.transcript
      if (transcript) {
        ws.send(JSON.stringify({
          type: 'voice_transcript',
          payload: { transcript, isFinal: data.is_final }
        }))
      }
    })

    connection.on(LiveTranscriptionEvents.UtteranceEnd, () => {
      ws.send(JSON.stringify({ type: 'voice_utterance_end', payload: {} }))
    })

    connection.on(LiveTranscriptionEvents.Error, (error) => {
      log(`Deepgram error: ${error}`)
      ws.send(JSON.stringify({ type: 'voice_error', payload: { error: String(error) } }))
    })

    connection.on(LiveTranscriptionEvents.Close, () => {
      voiceSessions.delete(ws)
    })

    voiceSessions.set(ws, connection)
    debug('Voice session started')
    return true
  } catch (e) {
    log(`Failed to start voice session: ${e}`)
    ws.send(JSON.stringify({ type: 'voice_error', payload: { error: String(e) } }))
    return false
  }
}

/**
 * Stop a voice transcription session
 */
function stopVoiceSession(ws: WebSocket): void {
  const connection = voiceSessions.get(ws)
  if (connection) {
    try {
      connection.requestClose()
    } catch (e) {
      // Ignore close errors
    }
    voiceSessions.delete(ws)
    debug('Voice session stopped')
  }
}

/**
 * Send audio data to Deepgram for transcription
 */
function sendVoiceAudio(ws: WebSocket, audioData: Buffer): void {
  const connection = voiceSessions.get(ws)
  if (!connection) return

  try {
    // Convert Node.js Buffer to ArrayBuffer for Deepgram SDK
    const arrayBuffer = audioData.buffer.slice(
      audioData.byteOffset,
      audioData.byteOffset + audioData.byteLength
    )
    connection.send(arrayBuffer)
  } catch (e) {
    debug(`Error sending audio: ${e}`)
  }
}

/**
 * Link a Claude Code session ID to a managed session
 */
function linkClaudeSession(claudeSessionId: string, managedSessionId: string): void {
  claudeToManagedMap.set(claudeSessionId, managedSessionId)
}

/**
 * Find managed session by Claude Code session ID
 */
function findManagedSession(claudeSessionId: string): ManagedSession | undefined {
  const managedId = claudeToManagedMap.get(claudeSessionId)
  if (managedId) {
    return managedSessions.get(managedId)
  }
  return undefined
}

/**
 * 根据 cwd（工作目录）查找 managed session
 * 用于自动链接重启后的新 Claude session
 */
function findManagedSessionByCwd(cwd: string): ManagedSession | undefined {
  if (!cwd) return undefined

  // 规范化路径以便比较（处理 Windows/Unix 路径差异）
  const normalizePath = (p: string) => p.toLowerCase().replace(/\\/g, '/')

  const normalizedCwd = normalizePath(cwd)

  for (const session of managedSessions.values()) {
    if (session.cwd && normalizePath(session.cwd) === normalizedCwd) {
      return session
    }
  }
  return undefined
}

/**
 * 尝试自动链接 Claude session 到 managed session
 * 当收到事件但找不到对应的 managed session 时调用
 *
 * 场景：
 * 1. VibeCraft 重启后，旧的 claudeSessionId 可能已无效
 * 2. 用户在 Claude CLI 中继续对话，产生新的 session ID
 * 3. 需要根据 cwd 重新建立链接
 *
 * 重要：如果 session 已有活跃链接且最近有活动，不要切换到另一个 Claude 实例
 */
function tryAutoLinkSession(claudeSessionId: string, cwd: string): ManagedSession | undefined {
  // 首先检查是否已经链接
  const existingSession = findManagedSession(claudeSessionId)
  if (existingSession) {
    return existingSession
  }

  // 根据 cwd 查找 managed session
  const sessionByCwd = findManagedSessionByCwd(cwd)
  if (sessionByCwd) {
    const oldClaudeId = sessionByCwd.claudeSessionId

    if (oldClaudeId === claudeSessionId) {
      // 已经是同一个，直接返回
      return sessionByCwd
    }

    // 如果已有链接，检查是否应该切换
    if (oldClaudeId) {
      const timeSinceLastActivity = Date.now() - sessionByCwd.lastActivity
      const LINK_SWITCH_TIMEOUT_MS = 30000 // 30秒内有活动则不切换

      // 如果最近有活动，说明旧链接仍然有效，不要切换
      // 这防止了多个 Claude 窗口导致的链接不断切换
      if (timeSinceLastActivity < LINK_SWITCH_TIMEOUT_MS && sessionByCwd.status !== 'offline') {
        debug(`[Auto-link] 跳过切换：${sessionByCwd.name} 最近 ${Math.round(timeSinceLastActivity / 1000)}s 有活动`)
        return undefined
      }

      // 旧链接已经不活跃，可以切换
      claudeToManagedMap.delete(oldClaudeId)
      debug(`[Auto-link] 清除旧链接: ${oldClaudeId.slice(0, 8)}`)
    }

    // 建立新链接
    linkClaudeSession(claudeSessionId, sessionByCwd.id)
    sessionByCwd.claudeSessionId = claudeSessionId

    // 更新状态（因为收到了新事件）
    if (sessionByCwd.status === 'offline') {
      sessionByCwd.status = 'idle'
    }

    log(`[Auto-link] 自动链接 Claude session ${claudeSessionId.slice(0, 8)} 到 ${sessionByCwd.name}`)
    broadcastSessions()
    saveSessions()
    return sessionByCwd
  }

  return undefined
}

// ============================================================================
// Event Processing
// ============================================================================

function processEvent(event: ClaudeEvent): ClaudeEvent {
  // Track pre_tool_use for duration calculation
  if (event.type === 'pre_tool_use') {
    const preEvent = event as PreToolUseEvent
    pendingToolUses.set(preEvent.toolUseId, preEvent)
    debug(`Tracking tool use: ${preEvent.tool} (${preEvent.toolUseId})`)
  }

  // Calculate duration for post_tool_use
  if (event.type === 'post_tool_use') {
    const postEvent = event as PostToolUseEvent
    const preEvent = pendingToolUses.get(postEvent.toolUseId)
    if (preEvent) {
      postEvent.duration = postEvent.timestamp - preEvent.timestamp
      pendingToolUses.delete(postEvent.toolUseId)
      debug(`Tool ${postEvent.tool} took ${postEvent.duration}ms`)
    }
  }

  return event
}

function addEvent(event: ClaudeEvent) {
  // Skip duplicates (hook writes to file AND posts to server)
  if (seenEventIds.has(event.id)) {
    debug(`Skipping duplicate event: ${event.id}`)
    return
  }
  seenEventIds.add(event.id)

  // Trim old IDs to prevent memory leak (keep last 2x MAX_EVENTS)
  if (seenEventIds.size > MAX_EVENTS * 2) {
    const idsToKeep = [...seenEventIds].slice(-MAX_EVENTS)
    seenEventIds.clear()
    idsToKeep.forEach(id => seenEventIds.add(id))
  }

  const processed = processEvent(event)
  events.push(processed)

  // Trim old events if over limit
  if (events.length > MAX_EVENTS) {
    events.splice(0, events.length - MAX_EVENTS)
  }

  // Track tokens from event data (cross-platform)
  if (event.sessionId) {
    trackEventTokens(event, event.sessionId)
  }

  // Update managed session status based on event
  // 首先尝试常规查找，如果找不到则尝试自动链接
  let managedSession = findManagedSession(event.sessionId)
  if (!managedSession && event.sessionId && event.cwd) {
    managedSession = tryAutoLinkSession(event.sessionId, event.cwd)
  }

  if (managedSession) {
    const prevStatus = managedSession.status
    managedSession.lastActivity = Date.now() // Use current time for accurate timeout tracking
    managedSession.cwd = event.cwd

    // Update status based on event type
    switch (event.type) {
      case 'pre_tool_use':
        managedSession.status = 'working'
        managedSession.currentTool = (event as PreToolUseEvent).tool
        break

      case 'post_tool_use':
        // Tool completed - update activity time but stay "working"
        // (Claude might be using more tools, stop event marks idle)
        managedSession.currentTool = undefined
        break

      case 'user_prompt_submit':
        // User submitted prompt - Claude is now processing
        managedSession.status = 'working'
        managedSession.currentTool = undefined
        break

      case 'stop':
      case 'session_end':
        managedSession.status = 'idle'
        managedSession.currentTool = undefined
        break
    }

    // Broadcast and persist if status changed
    if (managedSession.status !== prevStatus) {
      broadcastSessions()
      saveSessions()
    }
  }

  // Broadcast to all clients
  broadcast({ type: 'event', payload: processed })
}

// ============================================================================
// File Watching
// ============================================================================

function loadEventsFromFile() {
  if (!existsSync(EVENTS_FILE)) {
    debug(`Events file not found: ${EVENTS_FILE}`)
    return
  }

  const content = readFileSync(EVENTS_FILE, 'utf-8')
  const lines = content.trim().split('\n').filter(Boolean)

  for (const line of lines) {
    try {
      const event = JSON.parse(line) as ClaudeEvent
      processEvent(event)
      events.push(event)
    } catch (e) {
      debug(`Failed to parse event line: ${line}`)
    }
  }

  lastFileSize = content.length
  log(`Loaded ${events.length} events from file`)
}

function watchEventsFile() {
  // Ensure directory exists
  const dir = dirname(EVENTS_FILE)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  // Create file if it doesn't exist
  if (!existsSync(EVENTS_FILE)) {
    appendFileSync(EVENTS_FILE, '')
  }

  const watcher = watch(EVENTS_FILE, {
    persistent: true,
    usePolling: true,
    interval: 100,
  })

  watcher.on('change', () => {
    try {
      const content = readFileSync(EVENTS_FILE, 'utf-8')

      // Only process new content
      if (content.length > lastFileSize) {
        const newContent = content.slice(lastFileSize)
        const newLines = newContent.trim().split('\n').filter(Boolean)

        for (const line of newLines) {
          try {
            const event = JSON.parse(line) as ClaudeEvent
            addEvent(event)
            debug(`New event from file: ${event.type}`)
          } catch (e) {
            debug(`Failed to parse new event: ${line}`)
          }
        }

        lastFileSize = content.length
      }
    } catch (e) {
      debug(`Error reading events file: ${e}`)
    }
  })

  log(`Watching events file: ${EVENTS_FILE}`)
}

// ============================================================================
// WebSocket
// ============================================================================

function broadcast(message: ServerMessage) {
  const data = JSON.stringify(message)
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data)
    }
  }
}

function handleClientMessage(ws: WebSocket, message: ClientMessage) {
  switch (message.type) {
    case 'subscribe':
      debug('Client subscribed')
      break

    case 'get_history': {
      const limit = message.payload?.limit ?? 100
      const history = events.slice(-limit)
      const response: ServerMessage = { type: 'history', payload: history }
      ws.send(JSON.stringify(response))
      debug(`Sent ${history.length} historical events`)
      break
    }

    case 'ping':
      // Just acknowledge, no response needed
      break

    case 'voice_start':
      startVoiceSession(ws)
      break

    case 'voice_stop':
      stopVoiceSession(ws)
      break

    case 'permission_response': {
      const { sessionId, response } = message.payload
      sendPermissionResponse(sessionId, response)
      break
    }

    default:
      debug(`Unknown message type: ${(message as { type: string }).type}`)
  }
}

// ============================================================================
// HTTP Server (for hook notifications)
// ============================================================================

function handleHttpRequest(req: IncomingMessage, res: ServerResponse) {
  const origin = req.headers.origin

  // CORS headers - only allow specific origins
  if (origin && isOriginAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  }

  if (req.method === 'OPTIONS') {
    // Preflight: reject if origin not allowed
    if (!origin || !isOriginAllowed(origin)) {
      res.writeHead(403)
      res.end()
      return
    }
    res.writeHead(204)
    res.end()
    return
  }

  if (req.method === 'POST' && req.url === '/event') {
    collectRequestBody(req).then(body => {
      try {
        const event = JSON.parse(body) as ClaudeEvent
        addEvent(event)
        debug(`Received event via HTTP: ${event.type}`)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      } catch (e) {
        debug(`Failed to parse HTTP event: ${e}`)
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Invalid JSON' }))
      }
    }).catch(() => {
      res.writeHead(413, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Request body too large' }))
    })
    return
  }

  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      ok: true,
      version: VERSION,
      clients: clients.size,
      events: events.length,
      voiceEnabled: !!deepgramApiKey,
    }))
    return
  }

  // Config (username, etc)
  if (req.method === 'GET' && req.url === '/config') {
    const username = process.env.USER || process.env.USERNAME || 'claude-user'
    const host = hostname()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      username,
      hostname: host,
      tmuxSession: TMUX_SESSION,
    }))
    return
  }

  // Stats
  if (req.method === 'GET' && req.url === '/stats') {
    const toolCounts: Record<string, number> = {}
    const toolDurations: Record<string, number[]> = {}

    for (const event of events) {
      if (event.type === 'post_tool_use') {
        const e = event as PostToolUseEvent
        toolCounts[e.tool] = (toolCounts[e.tool] ?? 0) + 1
        if (e.duration !== undefined) {
          toolDurations[e.tool] = toolDurations[e.tool] ?? []
          toolDurations[e.tool].push(e.duration)
        }
      }
    }

    const avgDurations: Record<string, number> = {}
    for (const [tool, durations] of Object.entries(toolDurations)) {
      avgDurations[tool] = Math.round(
        durations.reduce((a, b) => a + b, 0) / durations.length
      )
    }

    // Collect token data
    const tokens: Record<string, { current: number; cumulative: number }> = {}
    for (const [session, data] of sessionTokens) {
      tokens[session] = { current: data.lastSeen, cumulative: data.cumulative }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      totalEvents: events.length,
      toolCounts,
      avgDurations,
      tokens,
    }))
    return
  }

  // Submit prompt from browser
  if (req.method === 'POST' && req.url === '/prompt') {
    collectRequestBody(req).then(body => {
      try {
        const { prompt, send } = JSON.parse(body) as { prompt: string; send?: boolean }
        if (!prompt || typeof prompt !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Prompt is required' }))
          return
        }

        // Write prompt to file
        const dir = dirname(PENDING_PROMPT_FILE)
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true })
        }
        writeFileSync(PENDING_PROMPT_FILE, prompt, 'utf-8')
        log(`Prompt saved: ${prompt.slice(0, 50)}...`)

        // If send=true, inject into tmux session
        if (send) {
          // Use safe helper to prevent command injection
          sendToTmuxSafe(TMUX_SESSION, prompt)
            .then(() => {
              log(`Prompt sent to tmux session: ${TMUX_SESSION}`)
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ ok: true, saved: PENDING_PROMPT_FILE, sent: true }))
            })
            .catch((error) => {
              log(`tmux send failed: ${error.message}`)
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({
                ok: true,
                saved: PENDING_PROMPT_FILE,
                sent: false,
                tmuxError: error.message
              }))
            })
          return
        }

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, saved: PENDING_PROMPT_FILE }))
      } catch (e) {
        debug(`Failed to save prompt: ${e}`)
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Invalid JSON' }))
      }
    }).catch(() => {
      res.writeHead(413, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Request body too large' }))
    })
    return
  }

  // Get pending prompt
  if (req.method === 'GET' && req.url === '/prompt') {
    if (existsSync(PENDING_PROMPT_FILE)) {
      const prompt = readFileSync(PENDING_PROMPT_FILE, 'utf-8')
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ prompt, file: PENDING_PROMPT_FILE }))
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ prompt: null }))
    }
    return
  }

  // Clear pending prompt
  if (req.method === 'DELETE' && req.url === '/prompt') {
    if (existsSync(PENDING_PROMPT_FILE)) {
      unlinkSync(PENDING_PROMPT_FILE)
      log('Pending prompt cleared')
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
    return
  }

  // Get tmux output (Claude's responses)
  if (req.method === 'GET' && req.url === '/tmux-output') {
    try {
      validateTmuxSession(TMUX_SESSION)
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'Invalid tmux session name', output: '' }))
      return
    }

    // Capture last 100 lines from tmux pane
    execFile('tmux', ['capture-pane', '-t', TMUX_SESSION, '-p', '-S', '-100'], { ...EXEC_OPTIONS, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: error.message, output: '' }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, output: stdout }))
    })
    return
  }

  // Cancel - send Ctrl+C to tmux (legacy, for backwards compat)
  if (req.method === 'POST' && req.url === '/cancel') {
    try {
      validateTmuxSession(TMUX_SESSION)
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'Invalid tmux session name' }))
      return
    }

    execFile('tmux', ['send-keys', '-t', TMUX_SESSION, 'C-c'], EXEC_OPTIONS, (error) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      if (error) {
        log(`Cancel failed: ${error.message}`)
        res.end(JSON.stringify({ ok: false, error: error.message }))
      } else {
        log(`Sent Ctrl+C to tmux session: ${TMUX_SESSION}`)
        res.end(JSON.stringify({ ok: true }))
      }
    })
    return
  }

  // ============================================================================
  // Session Management Endpoints
  // ============================================================================

  // Get server info (cwd, etc.)
  if (req.method === 'GET' && req.url === '/info') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, cwd: process.cwd() }))
    return
  }

  // List all sessions
  if (req.method === 'GET' && req.url === '/sessions') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, sessions: getSessions() }))
    return
  }

  // Force refresh sessions (trigger health check)
  if (req.method === 'POST' && req.url === '/sessions/refresh') {
    log('Manual session refresh requested')
    checkSessionHealth()
    // Return current sessions (health check updates async, but we give immediate response)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, sessions: getSessions() }))
    return
  }

  // Create a new session
  if (req.method === 'POST' && req.url === '/sessions') {
    collectRequestBody(req).then(async body => {
      try {
        const options = body ? JSON.parse(body) as CreateSessionRequest : {}
        const session = await createSession(options)
        res.writeHead(201, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, session }))
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: (e as Error).message }))
      }
    }).catch(() => {
      res.writeHead(413, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Request body too large' }))
    })
    return
  }

  // ============================================================================
  // Projects API (known directories for autocomplete)
  // ============================================================================

  // List all known projects
  if (req.method === 'GET' && req.url === '/projects') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, projects: projectsManager.getProjects() }))
    return
  }

  // Autocomplete path
  if (req.method === 'GET' && req.url?.startsWith('/projects/autocomplete')) {
    const url = new URL(req.url, `http://localhost:${PORT}`)
    const query = url.searchParams.get('q') || ''
    const results = projectsManager.autocomplete(query)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, results }))
    return
  }

  // Remove a project from the list
  if (req.method === 'DELETE' && req.url?.startsWith('/projects/')) {
    const path = decodeURIComponent(req.url.slice('/projects/'.length))
    projectsManager.removeProject(path)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
    return
  }

  // Session-specific endpoints: /sessions/:id
  const sessionMatch = req.url?.match(/^\/sessions\/([a-f0-9-]+)(?:\/(.+))?$/)
  if (sessionMatch) {
    const sessionId = sessionMatch[1]
    const action = sessionMatch[2] // e.g., "prompt", "cancel"

    // GET /sessions/:id - Get session details
    if (req.method === 'GET' && !action) {
      const session = getSession(sessionId)
      if (session) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, session }))
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'Session not found' }))
      }
      return
    }

    // PATCH /sessions/:id - Update session (rename)
    if (req.method === 'PATCH' && !action) {
      collectRequestBody(req).then(body => {
        try {
          const updates = JSON.parse(body) as UpdateSessionRequest
          const session = updateSession(sessionId, updates)
          if (session) {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: true, session }))
          } else {
            res.writeHead(404, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: 'Session not found' }))
          }
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }))
        }
      }).catch(() => {
        res.writeHead(413, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Request body too large' }))
      })
      return
    }

    // DELETE /sessions/:id - Kill session
    if (req.method === 'DELETE' && !action) {
      deleteSession(sessionId).then((deleted) => {
        if (deleted) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true }))
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'Session not found' }))
        }
      })
      return
    }

    // POST /sessions/:id/prompt - Send prompt to specific session
    if (req.method === 'POST' && action === 'prompt') {
      collectRequestBody(req).then(async body => {
        try {
          const { prompt } = JSON.parse(body) as SessionPromptRequest
          if (!prompt) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: 'Prompt is required' }))
            return
          }
          const result = await sendPromptToSession(sessionId, prompt)
          res.writeHead(result.ok ? 200 : 404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(result))
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }))
        }
      }).catch(() => {
        res.writeHead(413, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Request body too large' }))
      })
      return
    }

    // POST /sessions/:id/activate - 激活 session 对应的 Claude 窗口（Windows）
    if (req.method === 'POST' && action === 'activate') {
      const session = getSession(sessionId)
      if (!session) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'Session not found' }))
        return
      }

      if (IS_WINDOWS) {
        // Windows: 激活对应的 Terminal 窗口
        activateWindowsTerminal(session.cwd).then(result => {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            ok: result.success,
            windowTitle: result.windowTitle,
            error: result.error
          }))
        })
      } else {
        // Unix: tmux 窗口不需要特殊激活
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, message: 'Unix - tmux session already active' }))
      }
      return
    }

    // POST /sessions/:id/cancel - Send Ctrl+C to specific session
    if (req.method === 'POST' && action === 'cancel') {
      const session = getSession(sessionId)
      if (!session) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'Session not found' }))
        return
      }

      try {
        validateTmuxSession(session.tmuxSession)
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'Invalid tmux session name' }))
        return
      }

      execFile('tmux', ['send-keys', '-t', session.tmuxSession, 'C-c'], EXEC_OPTIONS, (error) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        if (error) {
          res.end(JSON.stringify({ ok: false, error: error.message }))
        } else {
          log(`Sent Ctrl+C to ${session.name}`)
          res.end(JSON.stringify({ ok: true }))
        }
      })
      return
    }

    // POST /sessions/:id/permission - Respond to a permission prompt
    if (req.method === 'POST' && action === 'permission') {
      const session = getSession(sessionId)
      if (!session) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'Session not found' }))
        return
      }

      collectRequestBody(req).then(body => {
        try {
          const { response } = JSON.parse(body) as { response: string }
          if (!response) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: 'Missing response field' }))
            return
          }

          sendPermissionResponse(sessionId, response)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true }))
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }))
        }
      }).catch(() => {
        res.writeHead(413, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Request body too large' }))
      })
      return
    }

    // POST /sessions/:id/restart - Restart an offline session
    if (req.method === 'POST' && action === 'restart') {
      const session = getSession(sessionId)
      if (!session) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'Session not found' }))
        return
      }

      let cwd: string
      try {
        cwd = validateDirectoryPath(session.cwd || process.cwd())
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: `Invalid directory: ${err instanceof Error ? err.message : err}` }))
        return
      }

      // Helper to update session state after restart
      const onRestartSuccess = () => {
        session.status = 'idle'
        session.lastActivity = Date.now()
        session.claudeSessionId = undefined // Will be re-linked when events come in
        session.currentTool = undefined

        // Clear old linking
        for (const [claudeId, managedId] of claudeToManagedMap) {
          if (managedId === session.id) {
            claudeToManagedMap.delete(claudeId)
          }
        }

        log(`Restarted session: ${session.name} (${session.id.slice(0, 8)})`)
        broadcastSessions()
        saveSessions()

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, session }))
      }

      if (IS_WINDOWS) {
        // Windows 多窗口模式：为此 session 重新启动 Claude
        log(`[Windows] 重启 session: ${session.name}`)
        log(`[Windows] 工作目录: ${cwd}`)

        // 注意：不使用 -c 参数，避免 "No conversation found to continue" 错误
        const claudeCmd = 'claude --permission-mode=bypassPermissions --dangerously-skip-permissions'

        // 检查 Windows Terminal 是否存在
        const wtPath = join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'wt.exe')
        const useWT = existsSync(wtPath)

        if (useWT) {
          const wtArgs = ['-d', cwd, '--title', session.name, '--', 'cmd', '/k', claudeCmd]
          execFile(wtPath, wtArgs, { ...EXEC_OPTIONS, cwd }, (error) => {
            if (error) {
              log(`[Windows] Windows Terminal 启动失败: ${error.message}`)
              launchWithPowerShell()
              return
            }
            onRestartSuccess()
          })
        } else {
          launchWithPowerShell()
        }

        function launchWithPowerShell() {
          // 检查session是否存在（TypeScript安全检查）
          if (!session) {
            res.writeHead(404, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: 'Session not found' }))
            return
          }

          // 使用 PowerShell 启动新窗口，确保环境变量正确
          const psScript = `
            $host.UI.RawUI.WindowTitle = '${session.name.replace(/'/g, "''")}'
            Set-Location -Path '${cwd.replace(/'/g, "''")}'
            & ${claudeCmd}
          `
          const psCmd = `Start-Process powershell -ArgumentList '-NoExit', '-Command', '${psScript.replace(/'/g, "''").replace(/\n/g, '; ')}'`

          exec(`powershell -Command "${psCmd}"`, { ...EXEC_OPTIONS }, (psError) => {
            if (psError) {
              res.writeHead(500, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ ok: false, error: `无法重启 Claude: ${psError.message}` }))
              return
            }
            onRestartSuccess()
          })
        }
      } else {
        // Unix: Validate tmux session name
        try {
          validateTmuxSession(session.tmuxSession)
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'Invalid tmux session name' }))
          return
        }

        // 终止现有 tmux session（忽略错误）
        execFile('tmux', ['kill-session', '-t', session.tmuxSession], EXEC_OPTIONS, () => {
          // 重新创建 tmux session 并启动 claude
          // 注意：不使用 -c 参数，避免 "No conversation found to continue" 错误
          execFile('tmux', [
            'new-session',
            '-d',
            '-s', session.tmuxSession,
            '-c', cwd,
            `PATH=${EXEC_PATH} claude --permission-mode=bypassPermissions --dangerously-skip-permissions`
          ], EXEC_OPTIONS, (error) => {
            if (error) {
              res.writeHead(500, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ ok: false, error: `Failed to restart: ${error.message}` }))
              return
            }
            onRestartSuccess()
          })
        })
      }
      return
    }

    // POST /sessions/:id/link - Link Claude session ID to managed session
    if (req.method === 'POST' && action === 'link') {
      collectRequestBody(req).then(body => {
        try {
          const { claudeSessionId } = JSON.parse(body) as { claudeSessionId: string }
          if (!claudeSessionId) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: 'claudeSessionId is required' }))
            return
          }
          const session = getSession(sessionId)
          if (!session) {
            res.writeHead(404, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: 'Session not found' }))
            return
          }
          linkClaudeSession(claudeSessionId, sessionId)
          session.claudeSessionId = claudeSessionId
          log(`Linked Claude session ${claudeSessionId.slice(0, 8)} to ${session.name}`)
          broadcastSessions()
          saveSessions()
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true, session }))
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }))
        }
      }).catch(() => {
        res.writeHead(413, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Request body too large' }))
      })
      return
    }
  }

  // -------------------------------------------------------------------------
  // Text Tiles API
  // -------------------------------------------------------------------------

  // GET /tiles - List all text tiles
  if (req.method === 'GET' && req.url === '/tiles') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, tiles: getTiles() }))
    return
  }

  // POST /tiles - Create a new text tile
  if (req.method === 'POST' && req.url === '/tiles') {
    collectRequestBody(req).then(body => {
      try {
        const data = JSON.parse(body) as CreateTextTileRequest

        if (!data.text || !data.position) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'Missing text or position' }))
          return
        }

        const tile: TextTile = {
          id: crypto.randomUUID(),
          text: data.text,
          position: data.position,
          color: data.color,
          createdAt: Date.now(),
        }

        textTiles.set(tile.id, tile)
        saveTiles()
        broadcastTiles()

        log(`Created text tile: "${tile.text}" at (${tile.position.q}, ${tile.position.r})`)
        res.writeHead(201, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, tile }))
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }))
      }
    }).catch(() => {
      res.writeHead(413, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Request body too large' }))
    })
    return
  }

  // Handle /tiles/:id routes
  const tilesIdMatch = req.url?.match(/^\/tiles\/([^/?]+)/)
  if (tilesIdMatch) {
    const tileId = tilesIdMatch[1]
    const tile = textTiles.get(tileId)

    // PUT /tiles/:id - Update a text tile
    if (req.method === 'PUT') {
      if (!tile) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'Tile not found' }))
        return
      }

      collectRequestBody(req).then(body => {
        try {
          const data = JSON.parse(body) as UpdateTextTileRequest

          if (data.text !== undefined) tile.text = data.text
          if (data.position !== undefined) tile.position = data.position
          if (data.color !== undefined) tile.color = data.color

          saveTiles()
          broadcastTiles()

          log(`Updated text tile: "${tile.text}"`)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true, tile }))
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }))
        }
      }).catch(() => {
        res.writeHead(413, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Request body too large' }))
      })
      return
    }

    // DELETE /tiles/:id - Delete a text tile
    if (req.method === 'DELETE') {
      if (!tile) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'Tile not found' }))
        return
      }

      textTiles.delete(tileId)
      saveTiles()
      broadcastTiles()

      log(`Deleted text tile: "${tile.text}"`)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }
  }

  // Static file serving for frontend (production mode)
  serveStaticFile(req, res)
}

/** MIME types for static files */
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

/** Serve static files from dist/ directory */
function serveStaticFile(req: IncomingMessage, res: ServerResponse): void {
  // Determine the dist directory (relative to this file when compiled)
  // Compiled server is at: dist/server/server/index.js
  // So ../../ gets us to dist/
  const distDir = resolve(dirname(new URL(import.meta.url).pathname), '../..')

  // Parse the URL path
  let urlPath = req.url?.split('?')[0] ?? '/'
  if (urlPath === '/') urlPath = '/index.html'

  // Security: prevent directory traversal
  // 1. Decode URL-encoded characters to catch %2e%2e (encoded ..)
  // 2. Resolve to absolute path
  // 3. Verify result is within distDir
  let decodedPath: string
  try {
    decodedPath = decodeURIComponent(urlPath)
  } catch {
    // Invalid URL encoding
    res.writeHead(400)
    res.end('Bad request')
    return
  }

  const filePath = resolve(distDir, '.' + decodedPath)

  // Check for path traversal: resolved path must start with distDir
  if (!filePath.startsWith(distDir + sep) && filePath !== distDir) {
    res.writeHead(403)
    res.end('Forbidden')
    return
  }

  // Check if file exists
  if (!existsSync(filePath)) {
    // For SPA, serve index.html for non-API routes
    const indexPath = join(distDir, 'index.html')
    if (existsSync(indexPath) && !decodedPath.startsWith('/api')) {
      const content = readFileSync(indexPath)
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(content)
      return
    }
    res.writeHead(404)
    res.end('Not found')
    return
  }

  // Serve the file
  const ext = extname(filePath).toLowerCase()
  const contentType = MIME_TYPES[ext] || 'application/octet-stream'
  const content = readFileSync(filePath)
  res.writeHead(200, { 'Content-Type': contentType })
  res.end(content)
}

// ============================================================================
// Main
// ============================================================================

function main() {
  log('Starting Vibecraft server...')

  // Load Deepgram API key for voice transcription
  deepgramApiKey = loadDeepgramKey()

  // Load existing events
  loadEventsFromFile()

  // Load saved sessions (for persistence across restarts)
  loadSessions()

  // Load saved text tiles
  loadTiles()

  // Start git status tracking
  gitStatusManager.setUpdateHandler(({ sessionId, status }) => {
    const session = managedSessions.get(sessionId)
    if (session) {
      debug(`Git status updated for ${session.name}: ${status.branch} +${status.linesAdded}/-${status.linesRemoved}`)
      // Broadcast updated sessions to all clients
      broadcastSessions()
    }
  })
  gitStatusManager.start()

  // Watch for new events
  watchEventsFile()

  // Create HTTP server
  const httpServer = createServer(handleHttpRequest)

  // Create WebSocket server
  const wss = new WebSocketServer({ server: httpServer })

  wss.on('connection', (ws, req) => {
    // CSRF protection: validate Origin header
    const origin = req.headers.origin
    if (!isOriginAllowed(origin)) {
      log(`Rejected WebSocket connection from origin: ${origin}`)
      ws.close(1008, 'Origin not allowed')
      return
    }

    clients.add(ws)
    log(`Client connected (${clients.size} total)${origin ? ` from ${origin}` : ''}`)

    // Send connection confirmation
    const connectMsg: ServerMessage = {
      type: 'connected',
      payload: { sessionId: events[events.length - 1]?.sessionId ?? 'unknown' },
    }
    ws.send(JSON.stringify(connectMsg))

    // IMPORTANT: Send sessions BEFORE history so client can link events to sessions
    const sessionsMsg: ServerMessage = {
      type: 'sessions',
      payload: getSessions(),
    }
    ws.send(JSON.stringify(sessionsMsg))

    // Send text tiles
    const tilesMsg: ServerMessage = {
      type: 'text_tiles',
      payload: getTiles(),
    }
    ws.send(JSON.stringify(tilesMsg))

    // Send recent history - filtered to only include events from current managed sessions
    const activeClaudeSessionIds = new Set(
      Array.from(managedSessions.values())
        .map(s => s.claudeSessionId)
        .filter(Boolean)
    )
    const filteredHistory = events
      .filter(e => activeClaudeSessionIds.has(e.sessionId))
      .slice(-50)
    const historyMsg: ServerMessage = {
      type: 'history',
      payload: filteredHistory,
    }
    ws.send(JSON.stringify(historyMsg))

    ws.on('message', (data: RawData, isBinary: boolean) => {
      // Handle binary audio data for voice transcription
      if (isBinary) {
        const audioBuffer = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)
        sendVoiceAudio(ws, audioBuffer)
        return
      }

      // Handle JSON messages
      try {
        const message = JSON.parse(data.toString()) as ClientMessage
        handleClientMessage(ws, message)
      } catch (e) {
        debug(`Failed to parse client message: ${e}`)
      }
    })

    ws.on('close', () => {
      stopVoiceSession(ws) // Clean up any voice session
      clients.delete(ws)
      log(`Client disconnected (${clients.size} total)`)
    })

    ws.on('error', (error) => {
      debug(`WebSocket error: ${error}`)
      stopVoiceSession(ws) // Clean up any voice session
      clients.delete(ws)
    })
  })

  httpServer.listen(PORT, () => {
    log(`Server running on port ${PORT}`)
    log(``)
    log(`Open https://vibecraft.sh to view your workshop`)
    log(``)
    log(`Local API endpoints:`)
    log(`  WebSocket: ws://localhost:${PORT}`)
    log(`  Events: http://localhost:${PORT}/event`)
    log(`  Prompt: http://localhost:${PORT}/prompt`)
    log(`  Health: http://localhost:${PORT}/health`)
    log(`  Stats: http://localhost:${PORT}/stats`)
    log(`  Sessions: http://localhost:${PORT}/sessions`)

    // Start token polling after server is ready
    startTokenPolling()

    // Start permission prompt polling
    startPermissionPolling()

    // Start session health checking (every 5 seconds)
    setInterval(checkSessionHealth, 5000)

    // Start working timeout checking (every 10 seconds)
    setInterval(checkWorkingTimeout, WORKING_CHECK_INTERVAL_MS)

    // Run initial health check to update session statuses
    checkSessionHealth()
  })
}

main()
