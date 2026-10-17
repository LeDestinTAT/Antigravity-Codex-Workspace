# Optional process-local configuration. Review before dot-sourcing this file.
# No credentials are required here. The bridge does not automatically load .env files.
$env:DUAL_AGENT_HOME = Join-Path $HOME '.dual-agent'
$env:DUAL_AGENT_SKILL_PATH = Join-Path $HOME '.gemini\config\skills\codex-delegate\SKILL.md'
$env:CODEX_BRIDGE_POLL_MS = '1000'
$env:CODEX_BRIDGE_TIMEOUT_MS = '300000'
$env:CODEX_BRIDGE_KILL_GRACE_MS = '5000'
# Disable auto-start registration for a source-only/manual installation.
$env:DUAL_AGENT_NO_AUTOSTART = '1'
# Keep this shell open for install/start commands so child processes inherit these values.
# Custom paths require consistent configuration for every future invocation.
