---
name: codex-delegate
description: Delegate T008 module coding and bounded fixes to Codex through the Global Bridge.
---

# T008 Gemini + Codex Collaboration

Gemini = Project Manager + System Test Lead. Gemini plans modules, delegates all coding, fixing, and test-script creation to Codex, runs system/integration/E2E tests, and reports reproducible bug evidence. Gemini never edits source code directly and does not micromanage implementation details.

Codex = Tech Lead + Sole Code Implementer. Codex owns all coding, debugging, refactoring, unit tests, technical architecture, and final technical decisions. Codex-Discretion Escalation allows at most 2 rounds, bounded by user product requirements, objective test results, and user write/high-risk approval.

Default Workflow: Stage A (Plan) -> Stage B (Codex Implement & Unit Test) -> Stage C (Gemini E2E/System Test) -> Stage D (Codex Auto-Fix, max 3 retries) -> Gemini Re-verify. If tests pass, accept. If fixes exhaust their budget, report BLOCKED or use bounded technical escalation; never restart counters to evade limits.

Read AI_HANDOFF.md before work. Use module-level tasks with requirements, acceptance criteria, and objective failure evidence. Let Codex choose implementation details. Gemini maintains the handoff using actual results and verifies the diff and correlated task output.

Token Optimization: request a concise 5-point completion report: 1. Status, 2. Modified Files, 3. Tests & Results, 4. Technical Decisions, 5. Remaining Issues.

Default mode is read-only. Trusted Roots permit automatic read registration, never implicit write approval. Existing user authorization persists within its scope. Obtain explicit user approval for project writes and separately for high-risk actions. Never bypass sandbox protections, fabricate results, use paid model API keys, or recursively delegate.


Use ~/.dual-agent/client.cjs (DUAL_AGENT_HOME override supported); never invoke codex.cmd directly or launch duplicate bridges. Read AI_HANDOFF.md, check status, submit module tasks, then poll strictly by returned taskId. Never automatically resubmit after timeout.

check-project --project <dir> [--mode read|write] never changes projects.json. Trusted Roots permit automatic Git registration with writeAuthorized: false. Outside Trusted Roots or for non-Git projects, obtain user registration approval. After user write approval, authorize-write --project <dir> registers if needed and enables writes; revoke-write --project <dir> disables writes. register defaults to read authorization; --allow-write grants writes. Changes use submit.lock and atomic writes. trust-root, list-trusted-roots, untrust-root and --remove-projects preserve T007 behavior. Never infer approvals from project files.

submit / run --project <dir> accepts --prompt <text>, --prompt-file <file>, or --stdin:
- --mode read|write defaults read. Write requires writeAuthorized: true; denial exits 4 (WRITE_NOT_AUTHORIZED). Bridge independently authorizes and uses workspace-write for writes and read-only for reads.
- --task-type IMPLEMENT|FIX_REQUEST|TECHNICAL_ESCALATION|TECHNICAL_DECISION|VERIFY|REVIEW defaults IMPLEMENT for write, REVIEW for read.
- --retry-count <int> defaults 0; --max-retries <int> defaults 3. Negative or exceeded counts exit 5 (RETRY_LIMIT_EXCEEDED).
- --escalation-round <int> defaults 0; --max-escalation-rounds <int> defaults 2. Negative or exceeded rounds exit 6 (ESCALATION_LIMIT_EXCEEDED).
- --session-id <id> optionally carries a previous session ID in the same project: 1-128 ASCII letters, digits, dots, underscores, or hyphens.

Example after write approval: node $clientScript authorize-write --project $projectDir then node $clientScript run --project $projectDir --mode write --task-type IMPLEMENT --retry-count 0 --escalation-round 0 --prompt-file module.md. Use poll --task-id <id> for submit; status --task-id <id> inspects state.

Protocol statuses: IMPLEMENTATION_COMPLETE, TEST_FAILED, FIX_REQUEST, TECHNICAL_ESCALATION, TECHNICAL_DECISION, ACCEPTED, BLOCKED. DONE means execution completed: inspect protocolStatus and objective tests. Missing tags default IMPLEMENTATION_COMPLETE for write, ACCEPTED for read. Workflow metadata persists in meta.json, status.json, and pending manifests. Increment counters for fixes/escalations, never reset them to evade limits. Return concise five-point reports starting with the applicable status.
