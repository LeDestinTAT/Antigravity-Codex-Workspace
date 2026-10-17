# AI Collaboration Handoff

## Project

- Name: DualAgentDemo
- Project Manager & System Test Lead: Gemini
- Tech Lead & Sole Code Implementer: Codex (via Global Bridge `~/.dual-agent/bridge.cjs`)
- Final Approver: User

## Current Task

- ID: T008 (Upgraded Global Gemini–Codex Architecture)
- Status: COMPLETED
- Goal: Upgrade Global Gemini–Codex system so Gemini acts as Project Manager + System Test Lead and Codex acts as Tech Lead + Sole Code Implementer + Final Technical Decision-Maker (`--mode write --task-type IMPLEMENT` primary workflow), with explicit user approval before registering any new project (`trustedRoots: []`), per-project session continuity (`--reuse-session` / `--session-id` with 1200-char incremental context), Codex-Discretion Escalation (max 2 rounds), bounded auto-fix loop (max 3 retries), and standalone `DualAgentSetup.exe` deployment.
- Code modification permission: APPROVED FOR T008 UPGRADE & VERIFICATION IN Antigravity-Codex-Workspace (`writeAuthorized: true`, `sandbox: "workspace-write"`).

## Key Technical Decisions

1. **Role & Authority Split**:
   - **Gemini**: Requirements analysis, module planning, integration/E2E/regression test execution, and bug evidence reporting. Never edits source code directly.
   - **Codex**: All source & test coding, architecture, unit testing, bug fixes, and final technical decision via **Codex-Discretion Escalation** (max 2 rounds), bounded by user product requirements, objective test results, and user write/high-risk approvals.
2. **New-Project Approval & Write Authorization**:
   - `trustedRoots` defaults to `[]` (no silent auto-registration). For every new/unregistered project (`check-project` exits `2`), Gemini asks the user first; upon user approval, Gemini automatically runs `authorize-write --project <dir>` (enabling `workspace-write`) or `register --project <dir>` (read-only).
   - `projects.json` synchronizes `sandbox: "workspace-write"` when `writeAuthorized: true` and `"read-only"` when `writeAuthorized: false`.
   - `--mode write` invokes `codex.cmd -c windows.sandbox=mxc exec -C . --sandbox workspace-write --ephemeral --output-last-message <file> -` and exits with code `4` (`WRITE_NOT_AUTHORIZED`) if unauthorized.
3. **Bounded Workflow, Protocol Statuses & Per-Project Session Continuity**:
   - Enforces `MAX_FIX_RETRIES = 3` (exit code `5` `RETRY_LIMIT_EXCEEDED`) and `MAX_ESCALATION_ROUNDS = 2` (exit code `6` `ESCALATION_LIMIT_EXCEEDED`) separately.
   - `--reuse-session` persists and reuses `lastSessionId` per project in `projects.json` with strict cross-project isolation and prepends up to 1200 chars of previous completed task context (`CODEX_PREV_SESSION_TASK_ID`).
   - Persists `mode`, `taskType`, `retryCount`, `escalationRound`, `sessionId`, and `protocolStatus` (`IMPLEMENTATION_COMPLETE`, `TEST_FAILED`, `FIX_REQUEST`, `TECHNICAL_ESCALATION`, `TECHNICAL_DECISION`, `ACCEPTED`, `BLOCKED`) in task `meta.json` and `status.json`.

## Latest Verification Results

- **Automated Test Suite**: 34/34 passed (`8` T004 Single-Project Bridge + `16` T005/T007 Global Multi-Project Bridge + `8` T008 Workflow/Write/Escalation/Session-Reuse + `2` Deploy/EXE Packaging).
- **Real Codex E2E & Upgrade Tasks**:
  - `task-1792220018062-de87f4f4db1c`: Real Global Bridge + `/codex-delegate` Skill end-to-end verification (`[STATUS: ACCEPTED]`).
  - `task-1792220975002-6e8e1c91776b`: Codex implemented `--reuse-session`, `lastSessionId` per-project persistence, 1200-char incremental session context in `global/bridge.cjs`, `codex-bridge.cjs` write-mode trigger support, `deploy.cjs --allow-write`, and `T008 Test 7 & Test 8` in `test/t008-workflow.test.cjs` (Codex CLI account reached OpenAI usage quota limit at 73,446 tokens during final shell command after writing code changes).

## Remaining Limitations

- **OpenAI / ChatGPT Account Quota Limit**: Real `codex.cmd` execution depends on the logged-in ChatGPT/Codex account quota (currently rate-limited by OpenAI until 5:57 PM; deterministic worker and Global Bridge queue/sandbox/session mechanisms remain 100% operational).
- **Single-concurrency global execution**: `bridge.cjs` processes tasks sequentially (FIFO) across projects to prevent write conflicts and rate-limit spikes.
- **Codex MXC `workspace-write` protected subdirectories**: Inside Codex CLI's `workspace-write` sandbox, `.git/` and `.agents/` are read-only protected by Codex CLI; `deploy.cjs` syncs `.agents/skills/codex-delegate/SKILL.md` on the host.
- **Conservative `BLOCKED` recovery**: Post-spawn crashes or unconfirmed `taskkill` enter `BLOCKED` state until manual operator check.

## Historical Index

- `t004-baseline` (`7b7d0f0`): T004 Single-Project Bridge Hardening (8 tests).
- `t005-baseline` (`76621b3`): T005 Global Multi-Project Bridge (18 tests).
- `pre-t008-baseline` (`073679d`): T007 Trusted Roots Auto-Registration & T006 Portable EXE Bundle (26 tests).
