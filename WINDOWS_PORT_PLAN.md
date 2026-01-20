# Vibecraft Windows 适配计划

## 概述

将 Vibecraft 从 Mac/Linux 适配到 Windows，主要改造以下组件：

## 状态: ✅ 已完成

所有 4 个阶段已完成，Vibecraft 现在可以在 Windows 上完整运行。

## 改造清单

### Phase 1: Hook 系统改造 (核心) ✅
- [x] 创建 `hooks/vibecraft-hook.js` - Node.js 版本的 hook 脚本
- [x] 修改 `bin/cli.js setup` - Windows 使用 .js hook
- [x] 更新 `~/.claude/settings.json` 配置逻辑

### Phase 2: 服务器兼容性 ✅
- [x] 修复 `server/index.ts` 中的 PATH 分隔符 (`:` → `;` on Windows)
- [x] 修复 `expandHome()` 函数使用 `USERPROFILE`
- [x] 修复路径遍历检查使用 `path.sep`
- [x] 完善 Windows 会话管理（已有 `sendToWindowsClipboard`）

### Phase 3: CLI 兼容性 ✅
- [x] 修复 `which` 命令检查 → 使用 `where` on Windows
- [x] 修复 spawn `npx` → Windows 需要 `shell: true`
- [x] 修复路径有空格的问题 → 引号包裹路径
- [x] 添加 Windows 特定警告和说明

### Phase 4: 测试验证 ✅
- [x] `npx vibecraft setup` - 成功安装 hook
- [x] `npx vibecraft doctor` - 所有检查通过
- [x] `npx vibecraft` - 服务器正常启动
- [x] Hook 正确写入事件到 `events.jsonl`
- [x] 服务器正确接收 HTTP 事件通知

## 技术决策

### Hook 方案选择
选择 **Node.js hook** 而非 PowerShell：
- Node.js 是项目已有依赖
- 跨平台（同一份代码可在 Mac/Linux/Windows 运行）
- 更容易测试和调试
- JSON 处理无需 jq 依赖

### 会话管理方案
Windows 无 tmux，使用已实现的 `sendToWindowsClipboard()` 方案：
- 剪贴板 + SendKeys 自动化
- 需要 Claude Code 窗口标题匹配

## 文件变更列表

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `hooks/vibecraft-hook.js` | 新建 | Node.js 版 hook |
| `server/index.ts` | 修改 | PATH、HOME、path.sep 兼容性 |
| `bin/cli.js` | 修改 | 依赖检查、setup 逻辑、spawn 修复 |

## 主要修改点

### server/index.ts
1. `expandHome()` - 添加 `USERPROFILE` 回退
2. `HOME` 常量 - 使用 `USERPROFILE` 回退
3. `PATH_SEPARATOR` - Windows 使用 `;`，Unix 使用 `:`
4. `sep` 导入 - 路径遍历检查使用平台特定分隔符

### bin/cli.js
1. `IS_WINDOWS` 检测 - `process.platform === 'win32'`
2. `commandExists()` - 使用 `where` 替代 `which`
3. `checkJq()` - Windows 跳过（Node.js hook 不需要）
4. `checkTmux()` - Windows 返回 false
5. `spawn` 调用 - Windows 使用 `shell: true` 并引号包裹路径

### hooks/vibecraft-hook.js
- 纯 Node.js 实现，无外部依赖
- 使用 `USERPROFILE` 回退
- 使用 Node.js `http` 模块替代 curl

## 使用方法

```bash
# 1. 安装 hook
npx vibecraft setup

# 2. 重启 Claude Code（使 hook 生效）

# 3. 启动服务器
npx vibecraft

# 4. 打开浏览器访问 http://localhost:4003
```

## 验证

```bash
# 检查诊断
npx vibecraft doctor

# 预期输出：
# ✓ Node.js
# ✓ jq (not needed - using Node.js hook)
# ✓ tmux (not needed - using clipboard integration)
# ✓ All 8 hooks configured
```
