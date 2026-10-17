# DualAgent Global Codex Bridge (Gemini + Codex Collaboration)

中文迁移说明：[在另一台 Windows 电脑重建工作区](RESTORE.zh-CN.md)。

依赖与配置：[完整清单](DEPENDENCIES.zh-CN.md) · [配置示例](config/environment.example.ps1)。支持直接运行源码安装，无需使用发布的 EXE。运行 `npm run check:environment` 检查环境，`npm test` 执行完整测试。

Windows user-level Global Multi-Project Codex Bridge for seamless **Gemini (Antigravity) + Codex CLI** collaboration, featuring **Trusted Roots automatic Git project registration**, **MXC `read-only` sandboxing**, **per-user Windows logon auto-start**, and **one-click `.exe` deployment**.

---

## Key Features

- **Global Single-Instance Service (`~/.dual-agent/`)**: One background Bridge service serves all your local projects cleanly outside Antigravity's nested terminal.
- **Trusted Roots Auto-Registration (T007)**: Authorize a parent workspace directory once (e.g., `~/Projects`); any new or existing Git repository opened under that workspace is automatically verified and registered when Gemini delegates a task to Codex.
- **Hardened Security Guardrails**:
  - Runs Codex under `windows.sandbox=mxc` and `--sandbox read-only` by default.
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
