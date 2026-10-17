# AI Collaboration Handoff

## Project

- Name: DualAgentDemo
- Project Manager & System Test Lead: Gemini
- Tech Lead & Sole Code Implementer: Codex (via Global Bridge `~/.dual-agent/bridge.cjs`)
- Final Approver: User

## Current Task

- ID: T008 (including T007 Trusted Roots & T006 Portable EXE Bundle)
- Status: COMPLETED
- Goal: Upgrade Global Gemini–Codex system so Gemini acts as Project Manager + System Test Lead and Codex acts as Tech Lead + Sole Code Implementer with controlled `workspace-write` execution, Trusted Roots read-only auto-registration, Codex-Discretion Escalation (max 2 rounds), bounded auto-fix loop (max 3 retries), and standalone `DualAgentSetup.exe` one-click deployment.
- Code modification permission: APPROVED FOR T008 UPGRADE & VERIFICATION IN DualAgentDemo AND TEMP TEST REPOS (`writeAuthorized: true` on `DualAgentDemo`).

## Key Technical Decisions

1. **Role & Authority Split**:
   - **Gemini**: Requirements analysis, module planning, integration/E2E/regression test execution, and bug evidence reporting. Never edits source code directly.
   - **Codex**: All source & test coding, architecture, unit testing, bug fixes, and final technical decision via **Codex-Discretion Escalation** (max 2 rounds), bounded by user product requirements, objective test results, and user write/high-risk approvals.
2. **Explicit Read vs Write Authorization**:
   - `projects.json` separates read registration (`sandbox: "read-only"`) from write authorization (`writeAuthorized: boolean`, default `false`).
   - Trusted Roots (`C:\Users\Rin\Projects`) automatically register verified Git projects for `read-only` access (`writeAuthorized: false`), never implicitly granting write access.
   - `authorize-write --project <dir>` and `revoke-write --project <dir>` manage per-project write permissions under `submit.lock` and atomic writes.
   - `--mode write` invokes `codex.cmd -c windows.sandbox=mxc exec -C . --sandbox workspace-write --ephemeral --output-last-message <file> -` and exits with code `4` (`WRITE_NOT_AUTHORIZED`) if unauthorized.
3. **Bounded Workflow & Protocol Statuses**:
   - Enforces `MAX_FIX_RETRIES = 3` (exit code `5` `RETRY_LIMIT_EXCEEDED`) and `MAX_ESCALATION_ROUNDS = 2` (exit code `6` `ESCALATION_LIMIT_EXCEEDED`).
   - Persists `mode`, `taskType`, `retryCount`, `escalationRound`, `sessionId`, and `protocolStatus` (`IMPLEMENTATION_COMPLETE`, `TEST_FAILED`, `FIX_REQUEST`, `TECHNICAL_ESCALATION`, `TECHNICAL_DECISION`, `ACCEPTED`, `BLOCKED`) in task `meta.json` and `status.json`.

## Latest Verification Results

- **Automated Test Suite**: 32/32 passed (`8` T004 + `10` T005 + `6` T007 Trusted Roots + `6` T008 Workflow/Write/Escalation + `2` Deploy/EXE Packaging).
- **Real Codex E2E Closed-Loop Tasks**:
  - `task-1792189507136-dc66b26c5b3f`: Real Trusted Root (`C:\Users\Rin\Projects`) zero-touch auto-registration of a new Git repository.
  - `task-1792190778701-123e49bd7999` & `task-1792191067282-2a1f6c654a64`: Codex implemented T008 in `DualAgentDemo` under `--mode write`.
  - `task-1792191297546-9658afd9abcf`: Real Stage C -> Stage D (`FIX_REQUEST`, `retryCount: 1`) -> Stage C re-verification closed loop on `test/t008-workflow.test.cjs`.
  - `task-1792191413449-492c39b7b17a` & `task-1792191457871-a8a0a123b11d`: Real temp Git repo (`_t008-real-e2e`) write-denial check (`exit 4`), `authorize-write`, source creation (`math.cjs` + `unit.test.cjs`), E2E failure injection (`subtract` missing), automatic `FIX_REQUEST` to Codex, and host re-verification (`exit 0`).
  - `task-1792213024244-15969cb65a8e` & `task-1792213170217-bd191e1ef7e6`: Fixed Windows `spawnSync` anonymous pipe handle inheritance when starting detached `bridge.cjs` from `deploy.cjs` and synced `test/deploy.test.cjs` assertion (`2.3s` total runtime).

## Remaining Limitations

- **Single-concurrency global execution**: `bridge.cjs` processes tasks sequentially (FIFO) across projects to prevent write conflicts and rate-limit spikes.
- **Codex MXC `workspace-write` protected subdirectories**: Inside Codex CLI's `workspace-write` sandbox, `.git/` and `.agents/` are read-only protected by Codex CLI; `deploy.cjs` syncs `.agents/skills/codex-delegate/SKILL.md` on the host.
- **Conservative `BLOCKED` recovery**: Post-spawn crashes or unconfirmed `taskkill` enter `BLOCKED` state until manual operator check.

## Historical Index

- `t004-baseline` (`7b7d0f0`): T004 Single-Project Bridge Hardening (8 tests).
- `t005-baseline` (`76621b3`): T005 Global Multi-Project Bridge (18 tests).
- `pre-t008-baseline` (`073679d`): T007 Trusted Roots Auto-Registration & T006 Portable EXE Bundle (26 tests).
