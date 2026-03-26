# vibeCraft-matrix

![Vibecraft Screenshot](public/og-image.png)

**A cross-platform fork of [Vibecraft](https://github.com/Nearcyan/vibecraft)** — visualize Claude Code's activity in real-time as an interactive 3D workshop.

> Forked and maintained by [@Arxchibobo](https://github.com/Arxchibobo) (Bobo Zhou). Adds Windows support, multi-project session orchestration, and an expanded feature set. All credit for the original concept and core design goes to [@Nearcyan](https://github.com/Nearcyan).

![npm](https://img.shields.io/npm/v/vibecraft) ![Three.js](https://img.shields.io/badge/Three.js-black?logo=threedotjs) ![TypeScript](https://img.shields.io/badge/TypeScript-blue?logo=typescript&logoColor=white) ![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg) ![Windows](https://img.shields.io/badge/Windows-0078D6?logo=windows&logoColor=white)

---

## Overview

vibeCraft-matrix hooks into Claude Code's event system and renders each tool call as physical movement in a 3D workshop scene. When Claude reads a file, it walks to the **Bookshelf**. When it runs a bash command, it walks to the **Terminal**. When it spawns a subagent, a mini-Claude appears at the **Portal**.

The result is a live, spatial view of what Claude is doing — useful for monitoring long-running sessions, coordinating multiple parallel agents, or just enjoying the show.

```
Claude Code  →  Hook Script  →  WebSocket Server  →  Browser (Three.js)
                     ↓
               ~/.vibecraft/data/events.jsonl  (persistent log)
```

---

## What's Different from the Original

| Feature | Original | This Fork |
|---------|----------|-----------|
| Platform | macOS / Linux | **Windows + macOS + Linux** |
| Shell | Bash required | Git Bash on Windows |
| Sessions | Single session | **Multi-session orchestration** |
| Characters | Simple robot | **ClaudeMon** with expressive animations |
| Audio | — | Synthesized sound effects (Tone.js) + spatial audio |
| Draw mode | — | Hex tile painting with 3D stacking |
| Voice input | — | Deepgram speech-to-text |
| Electron | — | Desktop app build support |

---

## Features

- **Real-time 3D visualization** — Claude moves between 8 workstations as it uses tools
- **Multi-session support** — Spawn and manage multiple Claude instances, each with its own hexagonal zone
- **Subagent visualization** — Mini-Claudes appear at the Portal when `Task` tools run in parallel
- **ClaudeMon character** — Animated robot with idle behaviors, walking, working, and thinking states
- **Synthesized sound effects** — Tool-specific audio cues via Tone.js; no audio files needed
- **Spatial audio** — Volume and stereo pan adjust based on zone position relative to the camera
- **Voice input** — Deepgram-powered speech-to-text streams directly into the prompt field
- **Draw mode** — Paint the hex floor with 6 colors, variable brush sizes, and 3D tile stacking
- **Activity feed** — Scrollable panel showing prompts, tool uses, and Claude's responses
- **Zone notifications** — Floating text above zones shows file changes, commands, and completions
- **Session orchestration** — Create, restart, and monitor tmux-backed Claude sessions from the UI
- **Git status per zone** — Branch, ahead/behind, staged/unstaged counts shown in zone info
- **Electron desktop app** — Optional standalone app build for macOS, Windows, and Linux
- **Persistent event log** — All events append to `~/.vibecraft/data/events.jsonl`

---

## Requirements

| Requirement | Notes |
|-------------|-------|
| Node.js 18+ | [nodejs.org](https://nodejs.org/) |
| Claude Code | Hook integration required |
| `jq` | Used by the bash hook script |
| `tmux` | Optional — required only for browser prompt injection |
| Git Bash | Windows only — comes with [Git for Windows](https://git-scm.com/download/win) |

### Installing jq

```bash
# macOS
brew install jq

# Ubuntu / Debian
sudo apt install jq

# Windows (Chocolatey)
choco install jq

# Windows (Scoop)
scoop install jq
```

---

## Quick Start

### Option 1: npx (Recommended)

```bash
# Install hooks into Claude Code (one-time setup)
npx vibecraft setup

# Start the visualization server
npx vibecraft
```

Open `http://localhost:4003` in your browser, then use Claude Code normally.

### Option 2: From Source

```bash
git clone https://github.com/Arxchibobo/vibeCraft-matrix
cd vibeCraft-matrix
npm install

# Configure hooks
npx vibecraft setup   # or: node bin/cli.js setup

# Start dev server (Vite + tsx watch)
npm run dev
```

Dev server runs the frontend at `http://localhost:4002` (proxied to the API at `4003`).

### Uninstall

```bash
npx vibecraft uninstall   # Removes hooks, keeps your data
```

---

## Usage

### Basic Workflow

1. Run `npx vibecraft` to start the server
2. Open the browser UI
3. Use Claude Code as normal — the character moves automatically

### Browser Prompt Injection (Optional)

Run Claude inside a named tmux session to send prompts from the browser:

```bash
tmux new -s claude
claude
```

In the UI, type a prompt and enable **"Send to tmux"** before submitting.

### Session Management

Click empty floor space in the 3D view to open the **New Session** modal. You can:
- Set a working directory
- Name the session
- Pass flags like `--resume`, `--dangerously-skip-permissions`, `--chrome`

Each session gets its own hexagonal zone. Zones glow based on session status:
- Subtle color — idle
- Cyan — working
- Amber — waiting for input
- Red pulse — needs attention
- Dim — offline

---

## Workstations

| Station | Tools | Visual |
|---------|-------|--------|
| Bookshelf | Read | Books on shelves |
| Desk | Write | Paper, pencil, ink pot |
| Workbench | Edit | Wrench, gears, bolts |
| Terminal | Bash | Glowing screen |
| Scanner | Grep, Glob | Telescope with lens |
| Antenna | WebFetch, WebSearch | Satellite dish |
| Portal | Task (subagents) | Glowing ring portal |
| Taskboard | TodoWrite | Board with sticky notes |

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Tab` / `Esc` | Switch focus between Workshop and Activity Feed |
| `1–6` | Switch to session 1–6 |
| `Alt+N` | Open new session modal |
| `Alt+A` | Jump to next session needing attention |
| `Alt+R` | Toggle voice recording |
| `Alt+Space` | Expand most recent "show more" in feed |
| `F` | Toggle follow-active mode |
| `P` | Toggle station panels (tool history) |
| `D` | Toggle draw mode |
| `Alt+D` | Toggle dev panel (test animations) |
| `Ctrl+C` | Copy selected text, or interrupt the active working session |

**Draw mode keys:**

| Key | Action |
|-----|--------|
| `1–6` | Select paint color |
| `0` | Select eraser |
| `Q` / `E` | Decrease / increase brush size |
| `R` | Toggle 3D stacking |
| `X` | Clear all painted tiles |
| `D` or `Esc` | Exit draw mode |

---

## Configuration

All defaults live in `shared/defaults.ts` and can be overridden with environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `VIBECRAFT_PORT` | `4003` | WebSocket / API server port |
| `VIBECRAFT_CLIENT_PORT` | `4002` | Vite dev server port |
| `VIBECRAFT_EVENTS_FILE` | `~/.vibecraft/data/events.jsonl` | Event log path |
| `VIBECRAFT_SESSIONS_FILE` | `~/.vibecraft/data/sessions.json` | Session persistence |
| `VIBECRAFT_DATA_DIR` | `~/.vibecraft/data` | Hook data directory |
| `VIBECRAFT_TMUX_SESSION` | `claude` | Default tmux session name |
| `VIBECRAFT_DEBUG` | `false` | Verbose server logging |
| `DEEPGRAM_API_KEY` | _(none)_ | Required for voice input |

Copy `.env` and edit as needed:

```bash
cp .env .env.local
```

---

## Data & Persistence

All runtime data is stored in `~/.vibecraft/data/`:

| File | Purpose |
|------|---------|
| `events.jsonl` | Append-only event log |
| `sessions.json` | Session state (survives server restarts) |
| `tiles.json` | Text tile labels |

User preferences (volume, keybindings, hex art) are stored in `localStorage`.

---

## Building

```bash
# Build everything (client + server)
npm run build

# Build server only (TypeScript → dist/server/)
npm run build:server

# Build Electron desktop app
npm run electron:build          # current platform
npm run electron:build:mac
npm run electron:build:win
npm run electron:build:linux
```

### Publishing to npm

```bash
npm login
npm publish   # runs build automatically via prepublishOnly
```

---

## CLI Reference

```bash
vibecraft                 # Start server
vibecraft setup           # Install hooks and configure Claude Code
vibecraft --port 4000     # Custom port
vibecraft --hook-path     # Print path to hook script
vibecraft --version       # Show version
vibecraft --help          # Show help
```

---

## Troubleshooting

**Hook not firing**
- Verify setup ran: `cat ~/.claude/settings.json` — should contain vibecraft hook entries
- Check `jq` is on PATH: `jq --version`
- On Windows: run commands from Git Bash, not CMD or PowerShell

**Character not moving / no events**
- Check the event log: `tail -f ~/.vibecraft/data/events.jsonl`
- Enable debug logging: `VIBECRAFT_DEBUG=true npx vibecraft`
- Confirm the server is running and the browser shows "Connected"

**Path issues on Windows**
- The hook uses `~/.vibecraft/data/` which Git Bash expands correctly
- Ensure `VIBECRAFT_DATA_DIR` is not set to a Windows-style path

**tmux not found**
- tmux is only required for browser prompt injection; the visualization works without it

---

## Contributors

**Current Maintainer**
- [@Arxchibobo](https://github.com/Arxchibobo) — Windows support, multi-session orchestration, ClaudeMon character, sound system, draw mode, and ongoing development

**Original Author**
- [@Nearcyan](https://github.com/Nearcyan) — Original Vibecraft concept, core 3D workshop, hook system, and all foundational design

---

## License

MIT — see [LICENSE](LICENSE) for details.
