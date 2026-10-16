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
- Bridge Script: `codex-bridge.cjs` (runs in an independent external PowerShell window; do NOT modify `codex-bridge.cjs` without user approval and do NOT execute `codex.cmd` directly from Antigravity's terminal)
- Codex Mode: MXC sandbox (`windows.sandbox=mxc`), `read-only` permissions
- Bridge Control Directory: `.agents/codex/`
  - `.agents/codex/bridge.lock`: Single-instance lock file maintained by the active Bridge (`pid`, `bridgeInstanceId`, `startedAt`)
  - `.agents/codex/submit.lock`: Short-lived exclusive lock acquired by submitters while checking status and publishing `request.md` + `pending.flag`
  - `.agents/codex/request.md`: Input task description written by Gemini while holding `submit.lock`
  - `.agents/codex/pending.flag`: JSON trigger file `{"taskId":"..."}` created atomically by Gemini after writing `request.md`
  - `.agents/codex/claimed.flag`: Active task claim record held by Bridge until child process exit and terminal status publication are confirmed
  - `.agents/codex/status.json`: Task execution state (`RUNNING`, `DONE`, `FAILED`, `BLOCKED`) with `taskId`, `bridgeInstanceId`, and `resultFile`, written atomically by Bridge
  - `.agents/codex/result.<taskId>.md` & `.agents/codex/result.md`: Task-correlated response output from Codex (atomically published from `result.<taskId>.tmp.md` before `DONE` status)
  - `.agents/codex/bridge.log`: Task-delimited stdout/stderr and lifecycle logs from Codex Bridge execution

## Procedure

1. **Locate Workspace & Read Handoff**:
   - Locate the current workspace root and read `AI_HANDOFF.md` before starting.
2. **Acquire `submit.lock` & Verify Idle State**:
   - Acquire `.agents/codex/submit.lock` using `[System.IO.FileMode]::CreateNew` **before** checking status or writing `request.md`.
   - Verify `.agents/codex/pending.flag` and `.agents/codex/claimed.flag` do not exist.
   - Check `.agents/codex/status.json` if present:
     - If `state` is `RUNNING` or `BLOCKED`, abort immediately without touching `request.md`.
3. **Write Bounded Task (`request.md`) & Publish `pending.flag` with `$taskId`**:
   - Generate a unique `$taskId = "task-" + [guid]::NewGuid().ToString("N")`.
   - Write `.agents/codex/request.md` (UTF-8 without BOM) with a clear, bounded read-only task description while still holding `submit.lock`.
   - Do **not** delete `status.json` or `result.md` before submission; `$taskId` correlation distinguishes the new task from any previous terminal status.
   - Write `{"taskId": "$taskId"}` to a unique temporary file and move it to `.agents/codex/pending.flag` without overwrite.
   - Release `.agents/codex/submit.lock`.
4. **Poll `status.json` Every ~2 Seconds by `$taskId` & Read Task-Specific Result**:
   - Poll `.agents/codex/status.json` up to 100 times (~200 seconds total, exceeding the Bridge's default 180s execution timeout):
     - If `status.state -eq "BLOCKED"`: stop polling immediately and report the blocked error to the user.
     - When `status.taskId -eq $taskId`:
       - **`DONE`**: Stop polling and read `.agents/codex/result.$taskId.md` (falling back to `.agents/codex/result.md`).
       - **`FAILED`**: Stop polling, inspect `.agents/codex/bridge.log`, and report `$status.error`.
     - **Timeout / Long-running**: If the task does not complete within the polling window, stop waiting, inform the user, and **do NOT automatically resubmit**.
5. **Verify & Update Handoff (`AI_HANDOFF.md`)**:
   - Independently review and verify Codex's conclusions against the actual codebase.
   - Update `AI_HANDOFF.md` with the completed actions, verified findings, and next steps.

## Windows PowerShell Execution

Run from the workspace root to submit a task and poll for results via the Bridge:

### 1. Submit Task to Bridge (Exclusive Lock + Task ID)

```powershell
$ErrorActionPreference = "Stop"
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
$codexDir = Join-Path (Get-Location).Path ".agents\codex"
$submitLockFile = Join-Path $codexDir "submit.lock"
$statusFile = Join-Path $codexDir "status.json"
$requestFile = Join-Path $codexDir "request.md"
$triggerFile = Join-Path $codexDir "pending.flag"
$claimedFile = Join-Path $codexDir "claimed.flag"

New-Item -ItemType Directory -Force -Path $codexDir | Out-Null

$taskId = "task-" + [guid]::NewGuid().ToString("N")
$lockStream = $null

try {
    try {
        $lockStream = [System.IO.File]::Open(
            $submitLockFile,
            [System.IO.FileMode]::CreateNew,
            [System.IO.FileAccess]::Write,
            [System.IO.FileShare]::None
        )
    } catch {
        throw "Another submission is currently in progress (submit.lock exists)."
    }

    if (Test-Path -LiteralPath $triggerFile) {
        throw "A pending.flag already exists. Waiting for Bridge to pick it up."
    }
    if (Test-Path -LiteralPath $claimedFile) {
        throw "A claimed.flag already exists. A task is currently claimed or blocked."
    }

    if (Test-Path -LiteralPath $statusFile) {
        $currentStatus = $null
        for ($i = 0; $i -lt 3; $i++) {
            try {
                $currentStatus = Get-Content -LiteralPath $statusFile -Raw -Encoding UTF8 | ConvertFrom-Json
                break
            } catch {
                if ($i -eq 2) { throw "Failed to parse existing status.json: $($_.Exception.Message)" }
                Start-Sleep -Milliseconds 50
            }
        }
        if ($currentStatus.state -eq "RUNNING") {
            throw "A Codex task ($($currentStatus.taskId)) is already RUNNING. Do not overwrite it."
        }
        if ($currentStatus.state -eq "BLOCKED") {
            throw "Codex Bridge is in BLOCKED state: $($currentStatus.error)"
        }
    }

    # Write request.md (UTF-8 no BOM) inside the submit.lock critical section
    if (-not $promptText -or -not $promptText.Trim()) {
        throw "Task promptText must be defined and non-empty before submitting."
    }
    [System.IO.File]::WriteAllText($requestFile, $promptText, $utf8NoBom)

    # Atomically publish pending.flag without overwrite
    $tmpTrigger = Join-Path $codexDir ("pending." + $taskId + ".tmp")
    $triggerJson = @{ taskId = $taskId } | ConvertTo-Json -Compress
    [System.IO.File]::WriteAllText($tmpTrigger, $triggerJson, $utf8NoBom)
    [System.IO.File]::Move($tmpTrigger, $triggerFile)
} finally {
    if ($null -ne $lockStream) {
        $lockStream.Dispose()
        Remove-Item -LiteralPath $submitLockFile -Force -ErrorAction SilentlyContinue
    }
}
Write-Output "SUBMITTED_TASK_ID=$taskId"
```

### 2. Poll `status.json` by `$taskId` and Read Task-Correlated Result

```powershell
$ErrorActionPreference = "Stop"
$codexDir = Join-Path (Get-Location).Path ".agents\codex"
$statusFile = Join-Path $codexDir "status.json"
$taskResultFile = Join-Path $codexDir ("result." + $taskId + ".md")
$logFile = Join-Path $codexDir "bridge.log"

$maxAttempts = 160 # ~320 seconds total at 2s interval (exceeds 300s Bridge execution timeout)
$attempt = 0
$consecutiveReadErrors = 0
$finalState = $null
$status = $null

while ($attempt -lt $maxAttempts) {
    Start-Sleep -Seconds 2
    $attempt++
    if (Test-Path -LiteralPath $statusFile) {
        $status = $null
        try {
            $status = Get-Content -LiteralPath $statusFile -Raw -Encoding UTF8 | ConvertFrom-Json
            $consecutiveReadErrors = 0
        } catch {
            $consecutiveReadErrors++
            if ($consecutiveReadErrors -ge 5) {
                throw "Persistent failure reading or parsing status.json after $consecutiveReadErrors attempts: $($_.Exception.Message)"
            }
            continue
        }

        if ($status.state -eq "BLOCKED") {
            $finalState = "BLOCKED"
            if (Test-Path -LiteralPath $logFile) {
                Get-Content -LiteralPath $logFile -Tail 50 -Encoding UTF8
            }
            throw "Codex Bridge entered BLOCKED state: $($status.error)"
        }

        if ($status.taskId -eq $taskId) {
            if ($status.state -eq "DONE") {
                $finalState = "DONE"
                break
            } elseif ($status.state -eq "FAILED") {
                $finalState = "FAILED"
                if (Test-Path -LiteralPath $logFile) {
                    Get-Content -LiteralPath $logFile -Tail 50 -Encoding UTF8
                }
                throw "Codex Bridge task ($taskId) FAILED: $($status.error)"
            }
        }
    }
}

if ($finalState -eq "DONE") {
    if (-not (Test-Path -LiteralPath $taskResultFile)) {
        throw "Task $taskId reported DONE, but task-correlated result file ($taskResultFile) is missing."
    }
    Get-Content -LiteralPath $taskResultFile -Raw -Encoding UTF8
} elseif ($null -eq $finalState) {
    Write-Warning "Task $taskId timed out waiting for status.json. Stop waiting, inform the user, and do NOT resubmit the same task."
}
```

## Recovery Procedure for `BLOCKED` or Stale Lock States

If the Bridge reports `BLOCKED` or a stale lock file prevents submission:
1. Verify no `codex-bridge.cjs` or orphaned `codex` process for this workspace is running.
2. Inspect `.agents/codex/status.json` and `.agents/codex/bridge.log` to diagnose why the previous execution was interrupted.
3. After confirming all previous child processes have exited, remove `.agents/codex/claimed.flag`, `.agents/codex/submit.lock`, `.agents/codex/bridge.lock.reclaim`, and `.agents/codex/status.json`, then restart `codex-bridge.cjs`.

## Safety & Requirements

- Do NOT execute `codex.cmd` directly from Antigravity's terminal; always use the `pending.flag` Bridge mechanism.
- Do NOT modify `codex-bridge.cjs` without explicit user approval.
- Do NOT modify source code during read-only reviews.
- Obtain explicit user approval before starting any write-enabled or high-risk task.
- Do not bypass security prompts or sandbox protections.
- Do not use paid model API keys.
- Avoid unnecessary repeat calls or duplicate task submissions.
- Include findings, evidence, uncertainties, and recommendations.
- Report actual errors and check `bridge.log` instead of inventing successful results.
