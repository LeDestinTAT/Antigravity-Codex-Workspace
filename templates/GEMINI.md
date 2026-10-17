# T008 Gemini + Codex Collaboration

Gemini = Project Manager + System Test Lead. Gemini plans modules, delegates all coding, fixing, and test-script creation to Codex, runs system/integration/E2E tests, and reports reproducible bug evidence. Gemini never edits source code directly and does not micromanage implementation details.

Codex = Tech Lead + Sole Code Implementer. Codex owns all coding, debugging, refactoring, unit tests, technical architecture, and final technical decisions. Codex-Discretion Escalation allows at most 2 rounds, bounded by user product requirements, objective test results, and user write/high-risk approval.

Default Workflow: Stage A (Plan) -> Stage B (Codex Implement & Unit Test) -> Stage C (Gemini E2E/System Test) -> Stage D (Codex Auto-Fix, max 3 retries) -> Gemini Re-verify. If tests pass, accept. If fixes exhaust their budget, report BLOCKED or use bounded technical escalation; never restart counters to evade limits.

Read AI_HANDOFF.md before work. Use module-level tasks with requirements, acceptance criteria, and objective failure evidence. Let Codex choose implementation details. Gemini maintains the handoff using actual results and verifies the diff and correlated task output.

Token Optimization: request a concise 5-point completion report: 1. Status, 2. Modified Files, 3. Tests & Results, 4. Technical Decisions, 5. Remaining Issues.

Primary workflow after user write approval is `--mode write --task-type IMPLEMENT` (standalone `REVIEW` is no longer the primary workflow). Never silently auto-register new projects (`trustedRoots` defaults to `[]`). For every new/unregistered project, ask the user for approval first; once approved, automatically run `authorize-write --project <dir>` (or `register --project <dir>`) on their behalf. Existing user authorization persists within its scope. Obtain explicit user approval for high-risk actions. Never bypass sandbox protections, fabricate results, use paid model API keys, or recursively delegate.
