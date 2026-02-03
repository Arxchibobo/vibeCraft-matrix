/**
 * Server Utility Functions
 */

/**
 * Estimate tokens using Claude's approximate tokenization rules:
 * - ~4 characters per token for English text
 * - ~2-3 characters per token for code
 * - JSON/structured data varies
 */
export function estimateTokenCount(text: string): number {
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
 * Parse token count from Claude Code output
 */
export function parseTokensFromOutput(output: string): number | null {
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

export interface PermissionOption {
  number: string
  label: string
}

/**
 * Parse tmux/terminal output to detect Claude Code permission prompts.
 */
export function detectPermissionPrompt(output: string): { tool: string; context: string; options: PermissionOption[] } | null {
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
  let hasFooter = false
  let hasSelector = false
  for (let i = proceedLineIdx + 1; i < Math.min(lines.length, proceedLineIdx + 15); i++) {
    if (/Esc to cancel|ctrl-g to edit/i.test(lines[i])) {
      hasFooter = true
      break
    }
    if (/^\s*❯/.test(lines[i])) {
      hasSelector = true
    }
  }

  if (!hasFooter && !hasSelector) {
    return null
  }

  // Parse numbered options
  const options: PermissionOption[] = []
  for (let i = proceedLineIdx + 1; i < Math.min(lines.length, proceedLineIdx + 10); i++) {
    const line = lines[i]
    if (/Esc to cancel/i.test(line)) break

    const optionMatch = line.match(/^\s*[❯>]?\s*(\d+)\.\s+(.+)$/)
    if (optionMatch) {
      options.push({
        number: optionMatch[1],
        label: optionMatch[2].trim()
      })
    }
  }

  if (options.length < 2) return null

  // Find tool name
  let tool = 'Unknown'
  for (let i = proceedLineIdx; i >= Math.max(0, proceedLineIdx - 20); i--) {
    const toolMatch = lines[i].match(/[●◐·]\s*(\w+)\s*\(/)
    if (toolMatch) {
      tool = toolMatch[1]
      break
    }
    const cmdMatch = lines[i].match(/^\s*(Bash|Read|Write|Edit|Grep|Glob|Task|WebFetch|WebSearch)\s+\w+/i)
    if (cmdMatch) {
      tool = cmdMatch[1]
      break
    }
  }

  const contextStart = Math.max(0, proceedLineIdx - 10)
  const contextEnd = proceedLineIdx + 1 + options.length
  const context = lines.slice(contextStart, contextEnd).join('\n').trim()

  return { tool, context, options }
}
