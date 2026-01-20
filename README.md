# Vibecraft for Windows

![Vibecraft Screenshot](public/og-image.png)

**A Windows-compatible fork of [Vibecraft](https://github.com/Nearcyan/vibecraft)** — visualize Claude Code's activity in real-time as a 3D workshop.

> This fork adds Windows support with Git Bash compatibility. All credit for the original project goes to [@Nearcyan](https://github.com/Nearcyan).

![Three.js](https://img.shields.io/badge/Three.js-black?logo=threedotjs) ![TypeScript](https://img.shields.io/badge/TypeScript-blue?logo=typescript&logoColor=white) ![Windows](https://img.shields.io/badge/Windows-0078D6?logo=windows&logoColor=white)

## What's Different from Original?

| Feature | Original | This Fork |
|---------|----------|-----------|
| **Platform** | macOS / Linux only | **Windows + macOS + Linux** |
| **Shell** | Bash required | Git Bash on Windows |
| **Hooks** | Unix paths | Windows path compatibility |

## Requirements (Windows)

- **Windows 10/11**
- **Git Bash** (comes with [Git for Windows](https://git-scm.com/download/win))
- **Node.js** 18+ ([Download](https://nodejs.org/))
- **jq** - for hook scripts
- **tmux** (optional, for browser control)

### Installing jq on Windows

```bash
# Option 1: Using Chocolatey
choco install jq

# Option 2: Using Scoop
scoop install jq

# Option 3: Manual download
# Download from https://jqlang.github.io/jq/download/
# Add to PATH
```

### Installing tmux on Windows (Optional)

tmux is only needed if you want to send prompts from the browser.

```bash
# Using MSYS2 (recommended)
pacman -S tmux

# Or use Git Bash's built-in terminal multiplexer
```

## Quick Start

### Option 1: From npm (Recommended)

```bash
# 1. Configure hooks (one time)
npx vibecraft setup

# 2. Start server
npx vibecraft
```

### Option 2: From Source

```bash
# Clone this repo
git clone https://github.com/Arxchibobo/vibeCraft-matrix
cd vibeCraft-matrix

# Install dependencies
npm install

# Configure hooks
npm run setup

# Start development server
npm run dev
```

Open http://localhost:4003 (or http://localhost:4002 for dev) and use Claude Code normally. You'll see Claude move around the workshop as it uses tools.

**To uninstall:** `npx vibecraft uninstall` (removes hooks, keeps your data)

## Browser Control (Optional)

Run Claude in tmux to send prompts from browser:

```bash
# In Git Bash or MSYS2
tmux new -s claude
claude
```

Then use the input field in the visualization with "Send to tmux" checked.

## Features

- **Real-time visualization** - Watch Claude move between workstations as it uses tools
- **Multi-session support** - Run multiple Claude instances with separate zones
- **Sound effects** - Synthesized audio feedback for tools and events
- **Draw mode** - Paint hex tiles with colors and 3D stacking (press `D`)
- **Voice input** - Speak prompts with real-time transcription
- **Subagent visualization** - Mini-Claudes spawn at portal for parallel tasks

## Stations

| Station | Tools | Details |
|---------|-------|---------|
| Bookshelf | Read | Books on shelves |
| Desk | Write | Paper, pencil, ink pot |
| Workbench | Edit | Wrench, gears, bolts |
| Terminal | Bash | Glowing screen |
| Scanner | Grep, Glob | Telescope with lens |
| Antenna | WebFetch, WebSearch | Satellite dish |
| Portal | Task (subagents) | Glowing ring portal |
| Taskboard | TodoWrite | Board with sticky notes |

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Tab` / `Esc` | Switch focus between Workshop and Feed |
| `1-6` | Switch to session |
| `Alt+N` | New session |
| `Alt+R` | Toggle voice input |
| `F` | Toggle follow mode |
| `P` | Toggle station panels |
| `D` | Toggle draw mode |

## Troubleshooting (Windows)

### Hook not working

1. Make sure Git Bash is installed and in PATH
2. Check that jq is accessible: `jq --version`
3. Verify hooks are configured: `cat ~/.claude/settings.json`

### Path issues

The hook script uses `~/.vibecraft/data/` which expands correctly in Git Bash. If you see path errors, ensure you're running commands from Git Bash, not CMD or PowerShell.

### tmux not found

If you don't need browser prompt control, tmux is optional. The visualization will still work without it.

## Original Project

This is a fork of the original **[Vibecraft](https://github.com/Nearcyan/vibecraft)** by [@Nearcyan](https://github.com/Nearcyan).

- **Original repo:** https://github.com/Nearcyan/vibecraft
- **Original website:** https://vibecraft.sh

All core functionality and design credit goes to the original author. This fork only adds Windows compatibility.

## License

MIT (same as original)
