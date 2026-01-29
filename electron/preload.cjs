/**
 * Vibecraft Electron Preload Script
 *
 * This script runs in the renderer process before the page loads.
 * It exposes a secure API to the renderer process via contextBridge.
 */

const { contextBridge } = require('electron')

// =============================================================================
// Expose Safe APIs to Renderer
// =============================================================================

contextBridge.exposeInMainWorld('electronAPI', {
  // Platform information
  platform: process.platform,
  isPackaged: process.versions.electron !== undefined,

  // We can add more APIs here as needed
  // Example: openFile, saveFile, showNotification, etc.
})

// =============================================================================
// Type Definitions (for TypeScript support in renderer)
// =============================================================================

// Add this to your renderer code's type definitions:
/*
declare global {
  interface Window {
    electronAPI: {
      platform: 'darwin' | 'linux' | 'win32'
      isPackaged: boolean
    }
  }
}
*/
