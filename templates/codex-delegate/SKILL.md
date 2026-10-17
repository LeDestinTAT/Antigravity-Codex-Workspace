---
name: codex-delegate
description: Delegate T008 module coding and bounded fixes to Codex through the Global Bridge.
---

# T008 Gemini + Codex Collaboration

Gemini = Project Manager + System Test Lead (Default); assumes **Global Full-Stack Control** (including direct coding, fixing, and unit testing) whenever GPT/Codex hits usage/rate limits or is unavailable (`FALLBACK_TO_GEMINI`, exit code `7`). Normally, Gemini plans modules, delegates coding/fixing to Codex, runs system/integration/E2E tests, and reports reproducible bug evidence.

Codex = Tech Lead + Sole Code Implementer (when available). Codex owns coding, debugging, refactoring, unit tests, technical architecture, and final technical decisions (`Codex-Discretion Escalation`, max 2 rounds, bounded by user product requirements, objective test results, and user approvals).

Default Workflow: Stage A (Plan) -> Stage B (Codex Implement & Unit Test) -> Stage C (Gemini E2E/System Test) -> Stage D (Codex Auto-Fix, max 3 retries) -> Gemini Re-verify. If Codex returns `FALLBACK_TO_GEMINI` (exit `7`), Gemini immediately takes over Stage B/D coding and completes verification directly without blocking the user.

Read AI_HANDOFF.md before work. Use module-level tasks with requirements, acceptance criteria, and objective failure evidence. Let Codex choose implementation details. Gemini maintains the handoff using actual results and verifies the diff and correlated task output.

Token & Effort Optimization:
- Dynamically adjust Codex reasoning effort via `--effort low|medium|high|xhigh|max|ultra` (and optional `--model <name>`) based on task complexity so simple tasks never waste tokens:
  - `low`: simple checks, syntax/lint verification, small config/doc edits, `VERIFY`, `REVIEW` (auto-default for `VERIFY`/`REVIEW`).
  - `medium`: standard single-module implementation and initial bug fixes (auto-default for `IMPLEMENT` and `FIX_REQUEST` with `retryCount <= 1`).
  - `high`: multi-module features, complex state/concurrency logic, `TECHNICAL_ESCALATION` (`escalationRound == 1`), or second fix retry (`retryCount == 2`).
  - `xhigh`: core architecture refactoring, `TECHNICAL_DECISION`, final escalation (`escalationRound >= 2`), or final fix retry (`retryCount >= 3`).
  - `max` / `ultra`: reserved for extreme algorithmic/deadlock problems or when explicitly requested by the user.
- Request a concise 5-point completion report: 1. Status, 2. Modified Files, 3. Tests & Results, 4. Technical Decisions, 5. Remaining Issues.

Primary workflow after user write approval is `--mode write --task-type IMPLEMENT`. Never silently auto-register new projects (`trustedRoots` defaults to `[]`). For every new/unregistered project (`check-project` returns `registered: false`), always ask the user for approval first; once approved, automatically execute `authorize-write --project <dir>` (for coding) or `register --project <dir>` (for read-only) on the user's behalf. Existing user authorization persists within its scope. Obtain explicit user approval for high-risk actions. Never bypass sandbox protections, fabricate results, use paid model API keys, or recursively delegate.

Use ~/.dual-agent/client.cjs (DUAL_AGENT_HOME override supported); never invoke codex.cmd directly or launch duplicate bridges. Read AI_HANDOFF.md, check status, submit module tasks, then poll strictly by returned taskId. Never automatically resubmit after timeout.

check-project --project <dir> [--mode read|write] never changes projects.json. Always run check-project first: if unregistered, ask the user for approval and then automatically run `authorize-write --project <dir>` (registers if needed and enables `workspace-write`) or `register --project <dir>`; `revoke-write --project <dir>` disables writes. Changes use submit.lock and atomic writes. Never infer approvals from project files.

submit / run --project <dir> accepts --prompt <text>, --prompt-file <file>, or --stdin:
- --mode read|write. Write requires writeAuthorized: true; denial exits 4 (WRITE_NOT_AUTHORIZED). Bridge independently authorizes and uses workspace-write for writes and read-only for reads.
- --task-type IMPLEMENT|FIX_REQUEST|TECHNICAL_ESCALATION|TECHNICAL_DECISION|VERIFY|REVIEW defaults IMPLEMENT for write, REVIEW for read.
- --effort low|medium|high|xhigh|max|ultra dynamically sets Codex `model_reasoning_effort` (auto-defaults by task complexity if omitted). --model <name> optionally overrides the Codex model.
- --retry-count <int> defaults 0; --max-retries <int> defaults 3. Negative or exceeded counts exit 5 (RETRY_LIMIT_EXCEEDED).
- --escalation-round <int> defaults 0; --max-escalation-rounds <int> defaults 2. Negative or exceeded rounds exit 6 (ESCALATION_LIMIT_EXCEEDED).
- --session-id <id> or --reuse-session reuses a project-scoped session ID (1-128 ASCII letters, digits, dots, underscores, or hyphens) with compact incremental context and strict cross-project isolation.
- Quota / unavailability fallback: if Codex fails due to usage/rate limits or service unavailability, poll/run exits 7 (`FALLBACK_TO_GEMINI`) and sets `globalStatus.fallbackToGemini = true`. Gemini then assumes full control to complete coding and testing directly. Run `clear-fallback` (or complete a subsequent Codex task) to reset.

Protocol statuses: IMPLEMENTATION_COMPLETE, TEST_FAILED, FIX_REQUEST, TECHNICAL_ESCALATION, TECHNICAL_DECISION, ACCEPTED, BLOCKED, FALLBACK_TO_GEMINI. DONE means execution completed: inspect protocolStatus and objective tests. Missing tags default IMPLEMENTATION_COMPLETE for write, ACCEPTED for read. Workflow metadata persists in meta.json, status.json, and pending manifests. Increment counters for fixes/escalations, never reset them to evade limits. Return concise five-point reports starting with the applicable status.
