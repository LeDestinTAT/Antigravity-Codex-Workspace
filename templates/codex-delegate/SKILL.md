---
name: codex-delegate
description: Delegate T008 module coding and bounded fixes to Codex through the Global Bridge.
---

# T008 Gemini + Codex Collaboration

- **Roles**:
  - **Gemini (PM & System Test Lead)**: Plans modules, delegates coding/fixes to Codex, runs integration/E2E tests, and verifies results. If Codex exits `7` (`FALLBACK_TO_GEMINI` on quota/rate-limit/unavailability), Gemini immediately takes over full coding, fixing, and testing so work never stalls.
  - **Codex (Tech Lead & Core Implementer)**: Owns coding, refactoring, unit tests, architecture, and final technical decisions (`Codex-Discretion Escalation`: max 2 rounds; auto-fix: max 3 retries).
- **Workflow**: Stage A (Plan) -> Stage B (Codex Implement + Unit Test) -> Stage C (Gemini System/E2E Test) -> Stage D (Codex Fix, max 3) -> Verify. Read and update `AI_HANDOFF.md` concisely without history bloat.

## Token & Effort Scaling (`--effort low|medium|high|xhigh|max|ultra`)

- `low`: `VERIFY`, `REVIEW`, syntax/lint checks, small config/doc/typo/rename edits (auto-detected).
- `medium`: standard single-module `IMPLEMENT` and initial `FIX_REQUEST` (`retryCount <= 1`).
- `high`: multi-module/concurrency/security work (auto-detected), `TECHNICAL_ESCALATION` (`round == 1`), or `retryCount == 2`.
- `xhigh`: core architecture decisions (`TECHNICAL_DECISION`), `escalationRound >= 2`, or `retryCount >= 3`.
- `max` / `ultra`: explicit override only for extreme algorithmic/deadlock tasks.
- Keep prompts incremental (file paths + diffs + concise failure logs). Require a brief 5-point report: `1. Status`, `2. Modified Files`, `3. Tests & Results`, `4. Technical Decisions`, `5. Remaining Issues`.

## Global Bridge CLI (`~/.dual-agent/client.cjs`)

Never invoke `codex.cmd` directly or silently auto-register projects (`trustedRoots: []`).
1. **Check project first**: `node ~/.dual-agent/client.cjs check-project --project <dir> [--mode read|write]`
   - Exit `2` (unregistered): ask user once; once approved, run `authorize-write --project <dir>` (write) or `register --project <dir>` (read).
   - Exit `4` (`WRITE_NOT_AUTHORIZED`): ask user before running `authorize-write --project <dir>`.
2. **Run / Submit**: `node ~/.dual-agent/client.cjs run --project <dir> --mode write --task-type IMPLEMENT [--effort <tier>] [--model <name>] [--reuse-session] --prompt "<task>"`
   - `--task-type`: `IMPLEMENT|FIX_REQUEST|TECHNICAL_ESCALATION|TECHNICAL_DECISION|VERIFY|REVIEW`
   - `--retry-count <0..3>` (exceeded exits `5` `RETRY_LIMIT_EXCEEDED`); `--escalation-round <0..2>` (exceeded exits `6` `ESCALATION_LIMIT_EXCEEDED`).
   - `--reuse-session` / `--session-id <id>`: reuses project-scoped session context (max 1200 chars).
   - Exit `7` (`FALLBACK_TO_GEMINI`): Codex hit quota/rate limits; Gemini takes over coding directly. Reset later via `clear-fallback`.
   - Statuses: `IMPLEMENTATION_COMPLETE`, `TEST_FAILED`, `FIX_REQUEST`, `TECHNICAL_ESCALATION`, `TECHNICAL_DECISION`, `ACCEPTED`, `BLOCKED`, `FALLBACK_TO_GEMINI`.
