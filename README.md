# DualAgent Global Codex Bridge (Gemini + Codex Collaboration)

中文迁移说明：[在另一台 Windows 电脑重建工作区](RESTORE.zh-CN.md)。

依赖与配置：[完整清单](DEPENDENCIES.zh-CN.md) · [配置示例](config/environment.example.ps1)。支持直接运行源码安装，无需使用发布的 EXE。运行 `npm run check:environment` 检查环境，`npm test` 执行完整测试。

Windows user-level Global Multi-Project Codex Bridge for seamless **Gemini (Antigravity) + Codex CLI** collaboration, featuring **controlled `workspace-write` execution**, **per-project session continuity (`--reuse-session`)**, **dynamic reasoning effort scaling (`--effort low|medium|high`)**, **automatic Gemini Global Control fallback (`FALLBACK_TO_GEMINI`)**, **per-user Windows logon auto-start**, and **one-click `.exe` deployment**.

---

## 最新版本更新说明 (Latest Release & Architecture Upgrade Notes)

1. **Gemini + Codex 团队角色与最终技术裁决 (`Codex-Discretion Escalation`)**：
   - **Gemini（项目经理 + 系统测试负责人）**：负责需求分析、模块拆分、跨模块/E2E 综合测试与验收；不再将独立 `REVIEW` 作为主要工作流，授权项目默认以 `--mode write --task-type IMPLEMENT` 委派编码。
   - **Codex（技术负责人 + 核心程序员）**：负责所有代码编写、重构、调试、单元测试与技术架构设计，拥有最终技术裁决权（技术分歧协商上限 2 轮，自动 Bug 修复重试上限 3 次，分别独立计数）。
2. **新项目“先询问、后自动注册”安全机制**：
   - 默认保持 `trustedRoots: []`（不静默注册未知项目）。遇到未注册的新项目时（`check-project` 退出码 `2`），由 Gemini 先询问用户，用户通过后自动执行 `authorize-write --project <dir>`（读写）或 `register --project <dir>`（只读），无需手动复制或注册 Skill。
3. **动态调整 Codex 模型与推理强度（节省简单任务 Token）**：
   - 新增 `--effort low|medium|high` 与 `--model <模型名>` 参数（调用 `codex.cmd` 时动态注入 `-c model_reasoning_effort="<effort>"`）。
   - 未显式指定时按任务复杂度自动分档：`VERIFY`/`REVIEW` 自动使用 `low`；常规 `IMPLEMENT`/`FIX_REQUEST`（`retryCount <= 1`）自动使用 `medium`；重大技术升级（`TECHNICAL_ESCALATION`/`TECHNICAL_DECISION`）或多次修复（`retryCount >= 2`）自动使用 `high`。
4. **GPT/Codex 限流或不可用时自动切换为 Gemini 全局接管 (`FALLBACK_TO_GEMINI`)**：
   - 当检测到 OpenAI/ChatGPT 账号触发 `usage limit`、`rate limit`、`quota`、`429` 或服务不可用时，Bridge 自动标记 `protocolStatus: "FALLBACK_TO_GEMINI"`，`client.cjs poll/run` 以**退出码 `7`** 立即返回，由 **Gemini 自动接管全局控制权**（直接完成编码、修复与测试），保障开发不中断；配额恢复后可通过 `clear-fallback` 或任意成功任务自动恢复双 Agent 模式。
5. **同项目会话复用与增量上下文 (`--reuse-session`)**：
   - 按项目持久化 `lastSessionId`，支持通过 `--reuse-session` 自动续接同项目上一次完成任务的增量摘要（最多 1200 字符），严格隔离不同项目的上下文。

---

## Key Features

- **Global Single-Instance Service (`~/.dual-agent/`)**: One background Bridge service serves all your local projects cleanly outside Antigravity's nested terminal.
- **Explicit Read vs. Write Project Authorization**: Supports user-approved `authorize-write` (`--sandbox workspace-write`) and `revoke-write` (`--sandbox read-only`), plus optional Trusted Roots (`trust-root`) if desired.
- **Hardened Security Guardrails**:
  - Runs Codex under `windows.sandbox=mxc` with explicit per-project `read-only` or `workspace-write` sandboxing.
  - Canonical path resolution (`fs.realpathSync.native`) + `path.relative` boundary enforcement blocking `..` traversal, prefix collisions, and symlink/junction escapes.
  - Deepest-root detection for nested Git repositories.
  - Blocks filesystem roots (`C:\`), Windows system directories, and the user home directory itself (`%USERPROFILE%`) from being authorized.
- **Silent Windows Logon Auto-Start**: Includes a windowless native launcher (`dual-agent-launcher.exe`) registered in `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` and Scheduled Task `DualAgentGlobalBridge` (no administrator elevation required).
- **One-Click Standalone Installer (`DualAgentSetup.exe`)**: Self-extracting executable that deploys the service, syncs the global `codex-delegate` Skill (UTF-8 without BOM), configures auto-start, and starts the Bridge.

---

## Prerequisites

- **OS**: Windows 10 / Windows 11
- **Node.js**: v18+ (`node` available in `PATH`)
- **Codex CLI**: Installed and authenticated (`codex.cmd` available in `PATH` or `%APPDATA%\npm\codex.cmd`)
- **Git**: Installed (`git` available in `PATH`)

---

## Quick Start (One-Click Deployment)

### Option A: Using `DualAgentSetup.exe` (From GitHub Releases or `dist\`)

```powershell
# 1. One-click install Global Bridge, global Skill, and Windows logon auto-start:
.\DualAgentSetup.exe install --trust-root "$HOME\Projects"

# 2. Check service health:
.\DualAgentSetup.exe doctor

# 3. (Optional) Bootstrap collaboration files (GEMINI.md, AI_HANDOFF.md, SKILL.md) into a project:
.\DualAgentSetup.exe init-project --project "$HOME\Projects\MyApp"
```

*(You can also double-click `DualAgentSetup.exe` in Windows Explorer to run the default installation.)*

### Option B: From Source Repository

```powershell
# 1. One-click install & authorize your Projects workspace:
.\install.ps1 install -TrustRoot "$HOME\Projects"

# 2. Build standalone DualAgentSetup.exe and portable zip bundle in .\dist\ :
powershell -ExecutionPolicy Bypass -File .\build-exe.ps1
```

---

## Trusted Roots & Project Authorization Commands

```powershell
$client = Join-Path $HOME ".dual-agent\client.cjs"

# Authorize a trusted workspace directory (all Git repos inside will auto-register on demand):
node $client trust-root --path "$HOME\Projects"

# List authorized trusted workspaces:
node $client list-trusted-roots

# Revoke a trusted workspace (stops future auto-registration; retains already-registered projects by default):
node $client untrust-root --path "$HOME\Projects"

# Revoke a trusted workspace AND remove all registered projects under it:
node $client untrust-root --path "$HOME\Projects" --remove-projects

# Check a project's authorization status (read-only; never mutates projects.json):
node $client check-project --project "$HOME\Projects\MyRepo"

# Manually register a single project outside Trusted Roots:
node $client register --project "D:\Work\SpecialRepo"
```

---

## Running Automated Tests

```powershell
node --test test/codex-bridge.test.cjs test/global-bridge.test.cjs test/deploy.test.cjs test/t008-workflow.test.cjs
```
