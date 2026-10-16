---
name: codex-delegate
description: Delegate coding tasks, debugging and code reviews to the local Codex CLI.
---

# Codex Delegate

Use this skill when Gemini needs independent assistance from Codex via the local Codex Bridge (`codex-bridge.cjs`).

## Automatic Delegation Rules

- Automatically delegate to Codex (without asking the user each time) when:
  - Complex programming or debugging is required.
  - Independent code review would be useful.
  - Architecture decisions need a second opinion.
  - Complex code needs verification.
- Do not ask whether to consult Codex for ordinary read-only tasks.
- Do not delegate simple tasks unnecessarily.
- **Write & High-Risk Approval**: Code modifications or high-risk operations MUST always obtain explicit user approval beforehand. Never assume write permission is granted merely because the read-only Bridge is running.

## Environment & Bridge Files

- Workspace Root: Current project root (e.g., `C:\Users\Rin\Projects\DualAgentDemo`)
- Bridge Script: `codex-bridge.cjs` (runs in an independent external PowerShell window; do NOT modify `codex-bridge.cjs` and do NOT execute `codex.cmd` directly from Antigravity's terminal)
- Codex Mode: MXC sandbox (`windows.sandbox=mxc`), `read-only` permissions
- Bridge Control Directory: `.agents/codex/`
  - `.agents/codex/request.md`: Input task description written by Gemini
  - `.agents/codex/pending.flag`: Trigger file created by Gemini after preparing `request.md`
  - `.agents/codex/status.json`: Task execution state (`RUNNING`, `DONE`, `FAILED`) written by Bridge
  - `.agents/codex/result.md`: Final response output from Codex
  - `.agents/codex/bridge.log`: stdout/stderr logs from Codex execution

## Procedure

1. **Locate Workspace & Read Handoff**:
   - Locate the current workspace root and read `AI_HANDOFF.md` before starting.
2. **Check Existing Task Status (`status.json`)**:
   - Before submitting a new task, check `.agents/codex/status.json` (and `.agents/codex/pending.flag`).
   - If `.agents/codex/status.json` exists and its `state` is `RUNNING` (or `pending.flag` is still present), **do NOT overwrite** `request.md` or submit a new task. Wait for the active task or inform the user.
3. **Write Bounded Task (`request.md`)**:
   - Create `.agents/codex/request.md` (UTF-8 without BOM) with a clear, bounded read-only task description.
   - Request findings, evidence (file paths and line numbers), uncertainties, and actionable recommendations.
4. **Clean Previous Outputs & Trigger Bridge (`pending.flag`)**:
   - Remove any previous `.agents/codex/result.md` and `.agents/codex/status.json`.
   - Create `.agents/codex/pending.flag` last so the running Bridge detects and starts the task.
   - **Never** invoke `codex.cmd` directly from the Antigravity terminal.
5. **Poll `status.json` Every ~2 Seconds**:
   - Check `.agents/codex/status.json` approximately every 2 seconds:
     - **`DONE`**: Stop polling and read `.agents/codex/result.md`.
     - **`FAILED`**: Stop polling, report the error from `status.json`, and inspect `.agents/codex/bridge.log` for details.
     - **Timeout / Long-running**: If the task does not complete within a reasonable timeout window, stop waiting, inform the user that the task is still running or stuck, and **do NOT resubmit the same task**.
6. **Verify & Update Handoff (`AI_HANDOFF.md`)**:
   - Independently review and verify Codex's conclusions in `.agents/codex/result.md` against the actual codebase.
   - Update `AI_HANDOFF.md` with the completed actions, verified findings, and next steps.

## Windows PowerShell Execution

Run from the workspace root to submit a task and poll for results via the Bridge:

### 1. Submit Task to Bridge

```powershell
$codexDir = ".agents\codex"
$statusFile = Join-Path $codexDir "status.json"
$requestFile = Join-Path $codexDir "request.md"
$resultFile = Join-Path $codexDir "result.md"
$triggerFile = Join-Path $codexDir "pending.flag"

New-Item -ItemType Directory -Force -Path $codexDir | Out-Null

# Step 1: Ensure no task is currently RUNNING
if (Test-Path $statusFile) {
    $currentStatus = Get-Content -Raw -Encoding UTF8 $statusFile | ConvertFrom-Json
    if ($currentStatus.state -eq "RUNNING") {
        throw "A Codex task is already RUNNING. Do not overwrite it."
    }
}
if (Test-Path $triggerFile) {
    throw "A pending.flag already exists. Waiting for Bridge to pick it up."
}

# Step 2: Ensure request.md is written (UTF-8 no BOM) before triggering
if (-not (Test-Path $requestFile)) {
    throw "Missing .agents\codex\request.md"
}

# Step 3: Clear old result.md and status.json, then create pending.flag
Remove-Item $resultFile, $statusFile -Force -ErrorAction SilentlyContinue
[System.IO.File]::WriteAllText((Join-Path (Get-Location) $triggerFile), "pending", [System.Text.UTF8Encoding]::new($false))
```

### 2. Poll `status.json` and Read Result

```powershell
$codexDir = ".agents\codex"
$statusFile = Join-Path $codexDir "status.json"
$resultFile = Join-Path $codexDir "result.md"
$logFile = Join-Path $codexDir "bridge.log"

$maxAttempts = 60 # ~120 seconds total at 2s interval
$attempt = 0
$finalState = $null

while ($attempt -lt $maxAttempts) {
    Start-Sleep -Seconds 2
    $attempt++
    if (Test-Path $statusFile) {
        try {
            $status = Get-Content -Raw -Encoding UTF8 $statusFile | ConvertFrom-Json
            if ($status.state -eq "DONE") {
                $finalState = "DONE"
                break
            } elseif ($status.state -eq "FAILED") {
                $finalState = "FAILED"
                Write-Error "Codex Bridge task FAILED: $($status.error)"
                if (Test-Path $logFile) {
                    Get-Content -Tail 50 -Encoding UTF8 $logFile
                }
                break
            }
        } catch {
            # Ignore transient JSON read race while Bridge writes status.json
        }
    }
}

if ($finalState -eq "DONE") {
    Get-Content -Raw -Encoding UTF8 $resultFile
} elseif ($null -eq $finalState) {
    Write-Warning "Task timed out waiting for status.json. Stop waiting, inform the user, and do NOT resubmit the same task."
}
```

## Safety & Requirements

- Do NOT execute `codex.cmd` directly from Antigravity's terminal; always use the `pending.flag` Bridge mechanism.
- Do NOT modify `codex-bridge.cjs`.
- Do NOT modify source code during read-only reviews.
- Obtain explicit user approval before starting any write-enabled or high-risk task.
- Do not bypass security prompts or sandbox protections.
- Do not use paid model API keys.
- Avoid unnecessary repeat calls or duplicate task submissions.
- Include findings, evidence, uncertainties, and recommendations.
- Report actual errors and check `bridge.log` instead of inventing successful results.
