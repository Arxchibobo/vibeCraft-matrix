/**
 * Vibecraft Electron Main Process
 *
 * Simplified version to ensure app starts
 */

const { app, BrowserWindow, shell } = require('electron')
const path = require('path')

console.log('[Electron] Starting...')
console.log('[Electron] __dirname:', __dirname)
console.log('[Electron] process.env:', process.env)

let mainWindow = null

// =============================================================================
// Path Configuration
// =============================================================================

const isDev = !app.isPackaged
console.log('[Electron] isDev:', isDev)

// Use development server or local file
const clientPath = isDev
  ? 'http://localhost:5173'  // Vite dev server
  : `file://${path.join(__dirname, '../dist/index.html')}`

console.log('[Electron] clientPath:', clientPath)

// =============================================================================
// Window Management
// =============================================================================

function createWindow() {
  console.log('[Electron] Creating window...')
  
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 768,
    backgroundColor: '#0a0a0a',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
      webSecurity: false,  // Allow loading local files
    },
    show: false,  // Don't show until ready
    title: 'Vibecraft - Claude Code Visualization',
    icon: path.join(__dirname, '../assets/icon.png'),
  })

  console.log('[Electron] Loading URL:', clientPath)
  
  mainWindow.loadURL(clientPath)
    .then(() => {
      console.log('[Electron] Page loaded successfully')
    })
    .catch(err => {
      console.error('[Electron] Failed to load URL:', err)
      // Try fallback
      if (!clientPath.startsWith('file://')) {
        const fallbackPath = `file://${path.join(__dirname, '../dist/index.html')}`
        console.log('[Electron] Trying fallback path:', fallbackPath)
        mainWindow.loadURL(fallbackPath).catch(e => {
          console.error('[Electron] Fallback also failed:', e)
        })
      }
    })

  mainWindow.once('ready-to-show', () => {
    console.log('[Electron] Window ready to show')
    mainWindow.show()
  })

  // Open DevTools in development
  if (isDev) {
    mainWindow.webContents.openDevTools()
  }

  mainWindow.on('closed', () => {
    console.log('[Electron] Window closed')
    mainWindow = null
  })

  // Handle external links
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    console.log('[Electron] External link blocked:', url)
    shell.openExternal(url)
    return { action: 'deny' }
  })
  
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    console.error('[Electron] did-fail-load:', errorCode, errorDescription, validatedURL)
  })
  
  console.log('[Electron] Window created successfully')
}

// =============================================================================
// App Lifecycle
// =============================================================================

app.whenReady().then(() => {
  console.log('[Electron] App ready')
  createWindow()
})

app.on('activate', () => {
  console.log('[Electron] App activated')
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

app.on('window-all-closed', () => {
  console.log('[Electron] All windows closed')
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  console.log('[Electron] App about to quit')
})

// =============================================================================
// Error Handling
// =============================================================================

process.on('uncaughtException', (err) => {
  console.error('[Electron] Uncaught Exception:', err)
})

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Electron] Unhandled Rejection at:', promise, 'reason:', reason)
})
