#!/usr/bin/env node
/**
 * Vibecraft Hook - Node.js version for cross-platform compatibility
 *
 * This script is called by Claude Code hooks and:
 * 1. Reads the hook input from stdin
 * 2. Transforms it into our event format
 * 3. Appends to the events JSONL file
 * 4. Optionally notifies the WebSocket server
 *
 * Installed to: ~/.vibecraft/hooks/vibecraft-hook.js
 * Run `npx vibecraft setup` to install/update this hook.
 *
 * Cross-platform: Works on Windows, macOS, and Linux without external dependencies.
 */

const fs = require('fs')
const path = require('path')
const http = require('http')
const os = require('os')

// =============================================================================
// Configuration
// =============================================================================

// Use USERPROFILE on Windows, HOME on Unix
const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir()

const VIBECRAFT_DATA_DIR = process.env.VIBECRAFT_DATA_DIR || path.join(HOME, '.vibecraft', 'data')
const EVENTS_FILE = process.env.VIBECRAFT_EVENTS_FILE || path.join(VIBECRAFT_DATA_DIR, 'events.jsonl')
const WS_NOTIFY_URL = process.env.VIBECRAFT_WS_NOTIFY || 'http://localhost:4003/event'
const ENABLE_WS_NOTIFY = process.env.VIBECRAFT_ENABLE_WS_NOTIFY !== 'false'

// =============================================================================
// Utility Functions
// =============================================================================

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true })
  }
}

function generateTimestamp() {
  return Date.now()
}

function generateEventId(sessionId, timestamp) {
  const random = Math.floor(Math.random() * 100000)
  return `${sessionId}-${timestamp}-${random}`
}

// =============================================================================
// Event Type Mapping
// =============================================================================

const EVENT_TYPE_MAP = {
  'PreToolUse': 'pre_tool_use',
  'PostToolUse': 'post_tool_use',
  'Stop': 'stop',
  'SubagentStop': 'subagent_stop',
  'SessionStart': 'session_start',
  'SessionEnd': 'session_end',
  'UserPromptSubmit': 'user_prompt_submit',
  'Notification': 'notification',
  'PreCompact': 'pre_compact',
}

function mapEventType(hookEventName) {
  return EVENT_TYPE_MAP[hookEventName] || 'unknown'
}

// =============================================================================
// Transcript Helpers
// =============================================================================

function extractAssistantTextFromTranscript(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return ''
  }

  try {
    const content = fs.readFileSync(transcriptPath, 'utf8')
    const lines = content.trim().split('\n').slice(-30) // Last 30 lines
    const entries = lines.map(line => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    }).filter(Boolean)

    // Find last user message index
    let lastUserIndex = -1
    entries.forEach((entry, idx) => {
      if (entry.type === 'user') {
        lastUserIndex = idx
      }
    })

    // Extract assistant text after last user message
    const assistantTexts = []
    entries.forEach((entry, idx) => {
      if (idx > lastUserIndex && entry.type === 'assistant') {
        const content = entry.message?.content || []
        content.forEach(item => {
          if (item.type === 'text' && item.text) {
            assistantTexts.push(item.text)
          }
        })
      }
    })

    return assistantTexts.join('\n')
  } catch {
    return ''
  }
}

function extractLatestAssistantResponse(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return ''
  }

  try {
    const content = fs.readFileSync(transcriptPath, 'utf8')
    const lines = content.trim().split('\n').slice(-200) // Last 200 lines
    const entries = lines.map(line => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    }).filter(Boolean)

    // Find last assistant message with text content
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i]
      if (entry.type === 'assistant') {
        const content = entry.message?.content || []
        const texts = content
          .filter(item => item.type === 'text' && item.text)
          .map(item => item.text)
        if (texts.length > 0) {
          return texts.join('\n')
        }
      }
    }

    return ''
  } catch {
    return ''
  }
}

// =============================================================================
// Event Builders
// =============================================================================

function buildPreToolUseEvent(input, id, timestamp, eventType, sessionId, cwd) {
  const toolName = input.tool_name || 'unknown'
  const toolInput = input.tool_input || {}
  const toolUseId = input.tool_use_id || ''
  const transcriptPath = input.transcript_path || ''
  const assistantText = extractAssistantTextFromTranscript(transcriptPath)

  return {
    id,
    timestamp,
    type: eventType,
    sessionId,
    cwd,
    tool: toolName,
    toolInput,
    toolUseId,
    assistantText,
  }
}

function buildPostToolUseEvent(input, id, timestamp, eventType, sessionId, cwd) {
  const toolName = input.tool_name || 'unknown'
  const toolInput = input.tool_input || {}
  const toolResponse = input.tool_response || {}
  const toolUseId = input.tool_use_id || ''
  const success = toolResponse.success !== false // Default to true

  return {
    id,
    timestamp,
    type: eventType,
    sessionId,
    cwd,
    tool: toolName,
    toolInput,
    toolResponse,
    toolUseId,
    success,
  }
}

function buildStopEvent(input, id, timestamp, eventType, sessionId, cwd) {
  const stopHookActive = input.stop_hook_active || false
  const transcriptPath = input.transcript_path || ''
  const response = extractLatestAssistantResponse(transcriptPath)

  return {
    id,
    timestamp,
    type: eventType,
    sessionId,
    cwd,
    stopHookActive,
    response,
  }
}

function buildSessionStartEvent(input, id, timestamp, eventType, sessionId, cwd) {
  const source = input.source || 'startup'

  return {
    id,
    timestamp,
    type: eventType,
    sessionId,
    cwd,
    source,
  }
}

function buildSessionEndEvent(input, id, timestamp, eventType, sessionId, cwd) {
  const reason = input.reason || 'other'

  return {
    id,
    timestamp,
    type: eventType,
    sessionId,
    cwd,
    reason,
  }
}

function buildUserPromptSubmitEvent(input, id, timestamp, eventType, sessionId, cwd) {
  const prompt = input.prompt || ''

  return {
    id,
    timestamp,
    type: eventType,
    sessionId,
    cwd,
    prompt,
  }
}

function buildNotificationEvent(input, id, timestamp, eventType, sessionId, cwd) {
  const message = input.message || ''
  const notificationType = input.notification_type || 'unknown'

  return {
    id,
    timestamp,
    type: eventType,
    sessionId,
    cwd,
    message,
    notificationType,
  }
}

function buildPreCompactEvent(input, id, timestamp, eventType, sessionId, cwd) {
  const trigger = input.trigger || 'manual'
  const customInstructions = input.custom_instructions || ''

  return {
    id,
    timestamp,
    type: eventType,
    sessionId,
    cwd,
    trigger,
    customInstructions,
  }
}

function buildUnknownEvent(input, id, timestamp, sessionId, cwd) {
  return {
    id,
    timestamp,
    type: 'unknown',
    sessionId,
    cwd,
    raw: input,
  }
}

// =============================================================================
// Main Event Builder
// =============================================================================

function buildEvent(input) {
  const hookEventName = input.hook_event_name || 'unknown'
  const sessionId = input.session_id || 'unknown'
  const cwd = input.cwd || ''

  const timestamp = generateTimestamp()
  const eventId = generateEventId(sessionId, timestamp)
  const eventType = mapEventType(hookEventName)

  switch (eventType) {
    case 'pre_tool_use':
      return buildPreToolUseEvent(input, eventId, timestamp, eventType, sessionId, cwd)
    case 'post_tool_use':
      return buildPostToolUseEvent(input, eventId, timestamp, eventType, sessionId, cwd)
    case 'stop':
    case 'subagent_stop':
      return buildStopEvent(input, eventId, timestamp, eventType, sessionId, cwd)
    case 'session_start':
      return buildSessionStartEvent(input, eventId, timestamp, eventType, sessionId, cwd)
    case 'session_end':
      return buildSessionEndEvent(input, eventId, timestamp, eventType, sessionId, cwd)
    case 'user_prompt_submit':
      return buildUserPromptSubmitEvent(input, eventId, timestamp, eventType, sessionId, cwd)
    case 'notification':
      return buildNotificationEvent(input, eventId, timestamp, eventType, sessionId, cwd)
    case 'pre_compact':
      return buildPreCompactEvent(input, eventId, timestamp, eventType, sessionId, cwd)
    default:
      return buildUnknownEvent(input, eventId, timestamp, sessionId, cwd)
  }
}

// =============================================================================
// Output Functions
// =============================================================================

function writeEventToFile(event) {
  ensureDir(path.dirname(EVENTS_FILE))
  const line = JSON.stringify(event) + '\n'
  fs.appendFileSync(EVENTS_FILE, line, 'utf8')
}

function notifyWebSocketServer(event) {
  if (!ENABLE_WS_NOTIFY) return

  const data = JSON.stringify(event)
  const url = new URL(WS_NOTIFY_URL)

  const options = {
    hostname: url.hostname,
    port: url.port || 80,
    path: url.pathname,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data),
    },
    timeout: 2000, // 2 second timeout
  }

  // Fire and forget - don't wait for response
  const req = http.request(options)
  req.on('error', () => {}) // Silently ignore errors
  req.on('timeout', () => req.destroy())
  req.write(data)
  req.end()
}

// =============================================================================
// Main Entry Point
// =============================================================================

async function main() {
  // Read input from stdin
  let inputData = ''

  process.stdin.setEncoding('utf8')

  for await (const chunk of process.stdin) {
    inputData += chunk
  }

  if (!inputData.trim()) {
    process.exit(0)
  }

  let input
  try {
    input = JSON.parse(inputData)
  } catch (err) {
    console.error('vibecraft-hook: ERROR - Invalid JSON input:', err.message)
    process.exit(1)
  }

  // Build event
  const event = buildEvent(input)

  // Write to file
  writeEventToFile(event)

  // Notify WebSocket server (fire and forget)
  notifyWebSocketServer(event)

  process.exit(0)
}

main().catch(err => {
  console.error('vibecraft-hook: ERROR -', err.message)
  process.exit(1)
})
