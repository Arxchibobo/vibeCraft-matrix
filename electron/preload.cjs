/**
 * Vibecraft Electron Preload Script
 *
 * This script runs in the renderer process before the page loads.
 * It exposes a secure API to the renderer process via contextBridge.
 */

const { contextBridge } = require('electron')

console.log('[Electron Preload] Loading...')

// =============================================================================
// Expose Safe APIs to Renderer
// =============================================================================

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  isPackaged: process.versions.electron !== undefined,
})

console.log('[Electron Preload] API exposed successfully')
