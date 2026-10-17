# Antigravity-Codex-Workspace

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform: Windows](https://img.shields.io/badge/Platform-Windows%2010%2F11-0078D6.svg)](#环境要求)
[![Node.js: >=22](https://img.shields.io/badge/Node.js-%3E%3D22-339933.svg)](#环境要求)

让 **Antigravity (Gemini)** 和 **Codex CLI** 在 Windows 下顺畅配合干活的全局桥接工具。

相关文档：[跨设备迁移说明](RESTORE.zh-CN.md) · [环境依赖清单](DEPENDENCIES.zh-CN.md) · [配置示例](config/environment.example.ps1) · [MIT License](LICENSE)

---

## 为什么做这个项目

在 Windows 上同时用 Antigravity (Gemini) 和 Codex CLI 写代码时，有几个很烦人的实际问题：

1. **终端与沙箱冲突**：直接在 Antigravity 的内置终端里调 `codex`，经常遇到嵌套沙箱限制、进程挂起或输出截断。
2. **多项目配置繁琐**：每次新建或克隆一个仓库，都要重新拷一遍 Skill 和配置文件。
3. **双模型定位混乱**：如果只拿 Codex 当只读 Reviewer，改代码还得靠 Gemini 自己贴文件，既慢又费 Token；反过来如果两边都在改同一份代码，很容易互相覆盖。
4. **额度浪费与限流断档**：改一行配置也用 `high` 推理强度纯属浪费额度；而一旦 ChatGPT / Codex 触发用量限制（Rate Limit / Quota），整个开发流程就会卡死。

这个仓库的做法很简单：在用户目录（`~/.dual-agent/`）跑一个常驻的轻量级本地 Bridge 服务，配合全局 `codex-delegate` Skill，把两边的工作流直接理顺。

---

## 核心工作方式

日常开发时的分工很明确：

- **Gemini 管拆解与验收**：负责跟进需求、拆任务、维护上下文，以及跑跨模块的集成测试和端到端验证。平时不直接手改业务代码。
- **Codex 管写代码与技术实现**：通过 Bridge 在授权目录内直接开启 `workspace-write` 落盘改代码、跑局部单测。具体的代码实现细节和技术选型由 Codex 拍板，不需要每改几行就停下来请示。
- **遇到分歧不死循环**：只有在需求冲突或改动影响整体结构时，Codex 才会发起协商（同一问题最多来回 2 轮）；集成测试没过时由 Gemini 把报错丢回给 Codex 修（最多自动重试 3 次）。

### 几个实用功能

1. **新项目“先询问、后自动注册”**  
   安装一次全局 Skill 后，所有项目直接通用。默认不静默扫描硬盘；进入未登记的新项目时，Gemini 会先询问你，确认后自动执行 `authorize-write`（读写）或 `register`（只读）。

2. **按任务难度动态调 Codex 推理强度 (`--effort`)**  
   支持全部 6 档推理强度（`low` / `medium` / `high` / `xhigh` / `max` / `ultra`），不再所有任务一把梭。跑单测、查语法或简单核对时用 `low`；日常单模块开发和首次修 Bug 用 `medium`；多模块改动、二次修复或第一轮技术分歧用 `high`；涉及核心架构裁决或第 3 次修复攻关自动升到 `xhigh`（`max`/`ultra` 仅在极难问题或手动指定时启用）。

3. **Codex 限流时自动由 Gemini 接手 (`FALLBACK_TO_GEMINI`)**  
   当 Bridge 检测到 Codex 返回 `usage limit`、`rate limit`、`quota` 或 `429` 时，`client.cjs` 会直接返回退出码 `7`。Gemini 收到后会立刻接手后续的代码编写和测试，不会卡在半路等额度恢复。额度恢复后跑一次 `clear-fallback` 就能切回双模型模式。

4. **同项目上下文续接 (`--reuse-session`)**  
   按项目记录最近一次完成的 `lastSessionId`。加上 `--reuse-session` 后会自动带上同一项目上一次任务的简短摘要（上限 1200 字），不用每次从头交代背景，也不会串到别的项目去。

5. **路径安全边界与开机自启**  
   使用 `fs.realpathSync.native` 校验真实路径，拦截 `..` 越界、软链接逃逸，并禁止直接把系统盘根目录（`C:\`）、系统文件夹或用户主目录（`%USERPROFILE%`）注册为可写工作区。自带免管理员权限的开机无窗口自启（`dual-agent-launcher.exe`）。

---

## 环境要求

- **系统**：Windows 10 / Windows 11
- **Node.js**：`v22+`（`v18+` 也可运行，需在 `PATH` 中）
- **Codex CLI**：已安装并完成登录（`codex.cmd` 在 `PATH` 或 `%APPDATA%\npm\codex.cmd`）
- **Git**：已安装并在 `PATH` 中

可以先跑一下环境自检：
```powershell
npm run check:environment
```

---

## 安装与使用

### 方式一：直接用打包好的 `DualAgentSetup.exe`

```powershell
# 1. 安装全局 Bridge 服务、全局 Skill 并配置开机自启：
.\DualAgentSetup.exe install

# 2. 检查后台服务状态：
.\DualAgentSetup.exe doctor

# 3. （可选）初始化指定项目并开启 Codex 写入权限：
.\DualAgentSetup.exe init-project --project "D:\Projects\MyApp" --allow-write
```

### 方式二：从源码安装

```powershell
git clone https://github.com/LeDestinTAT/Antigravity-Codex-Workspace.git
cd Antigravity-Codex-Workspace

# 安装全局服务与 Skill：
.\install.ps1 install

# （可选）重新编译生成 dist\DualAgentSetup.exe：
powershell -ExecutionPolicy Bypass -File .\build-exe.ps1
```

---

## 常用命令 (`~/.dual-agent/client.cjs`)

```powershell
$client = Join-Path $HOME ".dual-agent\client.cjs"

# 查看项目是否已注册及是否有写入权限（退出码 0=已注册，2=未注册）
node $client check-project --project "D:\Projects\MyApp"

# 授权项目允许 Codex 直接修改代码（若未注册会自动注册）
node $client authorize-write --project "D:\Projects\MyApp"

# 撤回写入权限（降级为 read-only）
node $client revoke-write --project "D:\Projects\MyApp"

# 仅以只读模式注册项目
node $client register --project "D:\Projects\MyApp"
```

### 调用 Codex 执行任务

```powershell
# 常规开发任务（读写模式 + 中等推理强度 + 续接同项目上次会话）
node $client run --project "D:\Projects\MyApp" `
  --mode write --task-type IMPLEMENT --effort medium --reuse-session `
  --prompt "实现 JWT 鉴权中间件，补齐单元测试并跑通。"

# 简单验证任务（使用 low 强度省额度）
node $client run --project "D:\Projects\MyApp" `
  --mode write --task-type VERIFY --effort low --reuse-session `
  --prompt "运行鉴权相关单测并返回结果。"

# 额度恢复后，手动清除 Fallback 状态
node $client clear-fallback --project "D:\Projects\MyApp"
```

**常用退出码**：
- `0`：执行完成
- `1`：普通执行报错或参数错误
- `2`：当前项目未注册（提示用户确认后再注册）
- `7`：触发 `FALLBACK_TO_GEMINI`（Codex 限流或不可用，转交 Gemini 直接处理）

---

## 更新记录

### `v1.1.0` (2026-10-17)
- 默认工作流从只读 Review 改为授权目录直接读写（`workspace-write`），由 Codex 负责写代码和局部测试，Gemini 负责整体协调与集成验证。
- 新增 `--effort low|medium|high|xhigh|max|ultra` 与 `--model` 参数，默认推理强度下调为 `medium`，按任务复杂度自动分档。
- 新增 Codex 额度受限/不可用时的 `FALLBACK_TO_GEMINI`（退出码 `7`）自动接管机制与 `clear-fallback` 恢复命令。
- 新增同项目 `--reuse-session` 增量上下文续接，严格隔离跨项目会话。
- 新项目默认采用“先询问、确认后自动注册”流程（`trustedRoots: []`）。
- 修复 Windows 下后台进程退出终端后被父进程 Job Object 误杀的问题（改用 WMI 独立拉起）。

### `v1.0.0`
- 初始版本：本地单实例 Bridge 服务（`127.0.0.1:43115`）、路径安全校验、`dual-agent-launcher.exe` 无窗口自启及 `DualAgentSetup.exe` 一键打包。

---

## 运行测试

仓库包含 35 项单元与集成测试（覆盖路径越界拦截、权限切换、任务委派、会话复用、动态强度、Fallback 退出码 `7` 及 `.exe` 打包测试）：

```powershell
npm test
```

---

## 共同开发者 (Contributors)

本项目由以下开发者共同完成代码编写、测试与维护：

- **[@LeDestinTAT](https://github.com/LeDestinTAT)** — 项目作者与维护者
- **Gemini (Antigravity)** — 共同开发（流程协调、集成测试与文档整理）
- **Codex / GPT (OpenAI)** — 共同开发（Bridge 核心实现、沙箱校验与自动化脚本）

---

## License

[MIT License](LICENSE) © 2026 LeDestinTAT, Gemini & Codex/GPT
