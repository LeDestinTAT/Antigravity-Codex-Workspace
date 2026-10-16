---
name: codex-delegate
description: Delegate coding tasks, debugging and code reviews to the local Codex CLI.
---

# Codex Delegate (Global Multi-Project Service)

Use this skill when Gemini needs independent assistance from Codex via the Windows user-level Global Codex Bridge (`C:\Users\Rin\.dual-agent\bridge.cjs` and `C:\Users\Rin\.dual-agent\client.cjs`).

## Automatic Delegation Rules

- Automatically delegate to Codex (without asking the user each time) when:
  - Complex programming or debugging is required.
  - Independent code review would be useful.
  - Architecture decisions need a second opinion.
  - Complex code needs verification.
- Do not ask whether to consult Codex for ordinary read-only tasks in an already-registered project.
- Do not delegate simple tasks unnecessarily.
- **Unregistered Project Approval**: If the current project is NOT yet registered in `C:\Users\Rin\.dual-agent\projects.json` (i.e. `client.cjs check-project` exits with code `2`), **STOP and ask the user for approval** before running `node "C:\Users\Rin\.dual-agent\client.cjs" register --project "<projectRoot>"`. Never auto-register a new project without user approval.
- **Write & High-Risk Approval**: Code modifications or high-risk operations MUST always obtain explicit user approval beforehand. Never assume write permission is granted merely because the read-only Bridge is running.

## Global Service Architecture & Files

- Global Service Home: `C:\Users\Rin\.dual-agent\` (overrideable via `DUAL_AGENT_HOME` for isolated testing)
  - `C:\Users\Rin\.dual-agent\bridge.cjs`: Single-instance global Bridge service (`windows.sandbox=mxc`, `read-only` by default)
  - `C:\Users\Rin\.dual-agent\client.cjs`: CLI for project registration, authorization checks, task submission, polling, and status queries
  - `C:\Users\Rin\.dual-agent\projects.json`: Registry of user-authorized project roots
  - `C:\Users\Rin\.dual-agent\bridge.lock`: Global single-instance lock (`pid`, `bridgeInstanceId`, `startedAt`)
  - `C:\Users\Rin\.dual-agent\status.json`: Global Bridge runtime status (`IDLE`, `RUNNING`, `BLOCKED`)
  - `C:\Users\Rin\.dual-agent\queue\submit.lock`: Exclusive submission lock preventing concurrent submission races
  - `C:\Users\Rin\.dual-agent\queue\pending\`: Queued task manifests (`<timestamp>-<seq>-<taskId>.json`)
  - `C:\Users\Rin\.dual-agent\queue\claimed.json`: Active task claim record held until child process-tree exit and terminal status persistence are confirmed
  - `C:\Users\Rin\.dual-agent\queue\tasks\<taskId>\`: Isolated per-task directory (`request.md`, `meta.json`, `status.json`, `result.md`, `task.log`)
  - `C:\Users\Rin\.dual-agent\logs\`: Global `bridge.log` and per-project logs under `logs\projects\<projectId>.log`

## Procedure

1. **Locate Project Root & Read Handoff**:
   - Identify the current workspace root and read `AI_HANDOFF.md` (if present in the project) before starting.
2. **Verify Global Bridge Status & Project Authorization**:
   - Run `node "C:\Users\Rin\.dual-agent\client.cjs" check-project --project "<projectRoot>"`.
   - If exit code is `2` (`PROJECT_NOT_REGISTERED`), **ask the user for permission** to register the project before proceeding.
   - Verify the Global Bridge is running and not `BLOCKED` via `node "C:\Users\Rin\.dual-agent\client.cjs" status`.
3. **Submit Bounded Task with Explicit `taskId` & Wait for Correlated Result**:
   - Pass the bounded read-only prompt to `client.cjs run` (or `submit` followed by `poll --task-id <taskId>`).
   - `client.cjs` automatically acquires `submit.lock`, validates the normalized Git/project root against `projects.json`, generates a unique `taskId`, writes `queue\tasks\<taskId>\request.md` (UTF-8 without BOM), enqueues the task, and polls `queue\tasks\<taskId>\status.json` until `DONE` or `FAILED`.
   - **Never** invoke `codex.cmd` directly from Antigravity's terminal and **never** start a duplicate per-project `codex-bridge.cjs`.
4. **Independently Verify & Update `AI_HANDOFF.md`**:
   - Independently verify Codex's output against the actual project files.
   - Update the current project's `AI_HANDOFF.md` with completed actions, verified findings, and next steps.

## Windows PowerShell Execution

### 1. Check Project Authorization & Global Bridge Status

```powershell
$ErrorActionPreference = "Stop"
$clientScript = "C:\Users\Rin\.dual-agent\client.cjs"
$projectDir = (Get-Location).Path

node $clientScript check-project --project $projectDir
if ($LASTEXITCODE -eq 2) {
    throw "Current project ($projectDir) is NOT registered in C:\Users\Rin\.dual-agent\projects.json. Ask the user for approval before registering."
} elseif ($LASTEXITCODE -ne 0) {
    throw "Project check failed with exit code $LASTEXITCODE"
}

node $clientScript status
```

### 2. Submit Task & Read Strictly Correlated Result by `taskId`

```powershell
$ErrorActionPreference = "Stop"
$clientScript = "C:\Users\Rin\.dual-agent\client.cjs"
$projectDir = (Get-Location).Path

$promptText = @"
<Insert bounded, read-only review/verification task here>
"@

# Submit task and get JSON descriptor with unique taskId
$submitJson = $promptText | node $clientScript submit --project $projectDir --stdin
if ($LASTEXITCODE -ne 0) {
    throw "Failed to submit task to Global Codex Bridge (exit $LASTEXITCODE)"
}
$submission = $submitJson | ConvertFrom-Json
$taskId = $submission.taskId
Write-Output "SUBMITTED_TASK_ID=$taskId (projectRoot=$($submission.projectRoot))"

# Poll strictly by $taskId and print correlated queue/tasks/$taskId/result.md
node $clientScript poll --task-id $taskId --timeout-ms 320000 --interval-ms 2000
if ($LASTEXITCODE -ne 0) {
    throw "Codex task $taskId failed or Bridge entered BLOCKED state (exit $LASTEXITCODE)"
}
```

### 3. Register a New Project (Only After Explicit User Approval)

```powershell
node "C:\Users\Rin\.dual-agent\client.cjs" register --project "<ProjectPath>"
```

## Legacy Migration Compatibility

- Both project-level (`.agents/skills/codex-delegate/SKILL.md`) and global (`C:\Users\Rin\.gemini\config\skills\codex-delegate\SKILL.md`) skills use the unified `C:\Users\Rin\.dual-agent\client.cjs` protocol.
- For backward compatibility with legacy T004 callers, `C:\Users\Rin\.dual-agent\bridge.cjs` also monitors `<projectRoot>\.agents\codex\pending.flag` in all registered projects, automatically ingests legacy triggers into the global queue, and mirrors `status.json` and `result.<taskId>.md` back to `<projectRoot>\.agents\codex\`. Do NOT run the legacy per-project `codex-bridge.cjs` alongside the Global Bridge.

## Safety & Requirements

- Do NOT execute `codex.cmd` directly from Antigravity's terminal; always use `C:\Users\Rin\.dual-agent\client.cjs`.
- Do NOT auto-register new projects without asking the user first.
- Do NOT modify source code during read-only reviews.
- Obtain explicit user approval before starting any write-enabled or high-risk task.
- Do not bypass security prompts or sandbox protections (`windows.sandbox=mxc`, `read-only`).
- Do not use paid model API keys.
- Avoid unnecessary repeat calls or duplicate task submissions.
- Report actual errors and inspect `queue\tasks\<taskId>\task.log` instead of inventing successful results.
