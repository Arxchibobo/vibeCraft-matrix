/**
 * Vibecraft Electron Main Process
 *
 * Fixed version - always use file:// protocol
 * because dist is bundled in app.asar
 */

const { app, BrowserWindow, shell } = require('electron')
const path = require('path')

console.log('[Electron] Starting...')
console.log('[Electron] __dirname:', __dirname)
console.log('[Electron] app.isPackaged:', app.isPackaged)

let mainWindow = null

// =============================================================================
// Path Configuration
// =============================================================================

// Since dist is bundled in app.asar, we always use file:// protocol
const clientPath = `file://${path.join(__dirname, '../dist/index.html')}`

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
    backgroundColor: '#1a1a2e', // Dark background matching app theme
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
      webSecurity: false, // Allow loading local files
    },
    show: false, // Don't show until ready
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
      // Try absolute path
      const absPath = path.resolve(__dirname, '../dist/index.html')
      const absUrl = `file://${absPath}`
      console.log('[Electron] Trying absolute path:', absUrl)
      mainWindow.loadURL(absUrl).catch(e => {
        console.error('[Electron] Absolute path also failed:', e)
      })
    })

  mainWindow.once('ready-to-show', () => {
    console.log('[Electron] Window ready to show')
    mainWindow.show()
  })

  // Open DevTools in production too for debugging
  mainWindow.webContents.openDevTools()

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
