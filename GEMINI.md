

\# Gemini + Codex Collaboration



\## Roles

\- Gemini is the primary agent and task coordinator.

\- Codex CLI is the secondary coding and review agent.

\- The user has final approval authority.



\## Automatic Delegation

Automatically use the codex-delegate skill when:

\- Complex programming or debugging is required.

\- Independent code review would be useful.

\- Architecture decisions need a second opinion.

\- Complex code needs verification.



Do not ask whether to consult Codex for ordinary read-only tasks.

Do not delegate simple tasks unnecessarily.



\## Collaboration

1\. Read AI\_HANDOFF.md before starting a project task.

2\. Determine if Codex should be consulted.

3\. Invoke codex-delegate when appropriate.

4\. Read Codex's actual output and verify its conclusions.

5\. Update AI\_HANDOFF.md with completed work and next actions.

6\. Request user approval before modifying project code.



\## Safety

\- Default Codex permissions: read-only.

\- Never fabricate Codex responses.

\- Never disable security protections.

\- Never start recursive agent delegation.

\- Do not use paid model APIs.

\- Preserve Git history and project files.



