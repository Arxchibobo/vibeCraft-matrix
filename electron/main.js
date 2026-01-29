/**
 * Vibecraft Electron Main Process
 *
 * This file handles the Electron main process:
 * - Creates the main window
 * - Loads the built web app
 * - Manages system tray (optional)
 * - Handles auto-updates (optional)
 */

const { app, BrowserWindow, shell } = require('electron')
const path = require('path')
const { spawn } = require('child_process')

let mainWindow = null
let serverProcess = null

// =============================================================================
// Path Configuration
// =============================================================================

// Determine if we're in development or production
const isDev = !app.isPackaged

// Path to the built client files
const clientPath = isDev
  ? 'http://localhost:5173' // Vite dev server
  : `file://${path.join(__dirname, '../dist/index.html')}`

// Path to the server entry point
const serverEntry = isDev
  ? path.join(__dirname, '../dist/server/server/index.js')
  : path.join(__dirname, '../dist/server/server/index.js')

// =============================================================================
// Server Management
// =============================================================================

function startServer() {
  if (serverProcess) {
    console.log('[Electron] Server already running')
    return
  }

  console.log('[Electron] Starting Vibecraft server...')

  serverProcess = spawn('node', [serverEntry], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      VIBECRAFT_PORT: '4003',
      VIBECRAFT_CLIENT_PORT: isDev ? '5173' : '4003',
    },
    stdio: 'inherit',
  })

  serverProcess.on('error', (err) => {
    console.error('[Electron] Failed to start server:', err.message)
  })

  serverProcess.on('close', (code) => {
    console.log(`[Electron] Server exited with code ${code}`)
    serverProcess = null
  })

  // Wait a bit for the server to start
  return new Promise((resolve) => setTimeout(resolve, 1000))
}

function stopServer() {
  if (serverProcess) {
    console.log('[Electron] Stopping server...')
    serverProcess.kill('SIGTERM')
    serverProcess = null
  }
}

// =============================================================================
// Window Management
// =============================================================================

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 768,
    backgroundColor: '#0a0a0a',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    title: 'Vibecraft - Claude Code Visualization',
    icon: path.join(__dirname, '../assets/icon.png'),
  })

  mainWindow.loadURL(clientPath)

  // Open DevTools in development
  if (isDev) {
    mainWindow.webContents.openDevTools()
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // Handle external links
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
}

// =============================================================================
// App Lifecycle
// =============================================================================

app.whenReady().then(async () => {
  // Start the backend server
  await startServer()

  // Create the main window
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    stopServer()
    app.quit()
  }
})

app.on('before-quit', () => {
  stopServer()
})

// =============================================================================
// IPC Handlers
// =============================================================================

// We can add IPC handlers here for future features
// Example: Open external links, show notifications, etc.
