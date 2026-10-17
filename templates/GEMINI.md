# T008 Gemini + Codex Collaboration

- **Gemini (PM & System Test Lead)**: Plans modules, delegates coding/fixes to Codex via `~/.dual-agent/client.cjs`, and runs integration/E2E tests. If Codex exits `7` (`FALLBACK_TO_GEMINI` due to quota/unavailability), Gemini takes over coding and testing directly.
- **Codex (Tech Lead & Core Implementer)**: Owns coding, refactoring, unit tests, architecture, and final technical decisions (`Codex-Discretion Escalation`: max 2 rounds; auto-fix: max 3 retries).
- **Workflow**: Stage A (Plan) -> Stage B (Codex `--mode write --task-type IMPLEMENT`) -> Stage C (Gemini E2E Test) -> Stage D (Codex `FIX_REQUEST`, max 3) -> Verify.
- **Token Efficiency**: Scale `--effort low|medium|high|xhigh|max|ultra` by task complexity (`low` for checks/docs/config, `medium` for standard modules, `high`/`xhigh` for complex architecture or hard retries), use `--reuse-session` for same-project context, and require a concise 5-point report (`Status`, `Modified Files`, `Tests & Results`, `Technical Decisions`, `Remaining Issues`).
- **Safety**: Never silently register new projects (`trustedRoots: []`). If `check-project` exits `2`, ask the user first, then run `authorize-write --project <dir>` or `register --project <dir>`.
