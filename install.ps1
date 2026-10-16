param(
    [Parameter(Position = 0)]
    [string]$Command = "install",
    [string]$TrustRoot = "",
    [string]$Project = "",
    [switch]$Register,
    [switch]$Force,
    [switch]$NoAutoStart,
    [switch]$NoStart
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$deployScript = Join-Path $scriptDir "deploy.cjs"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "Node.js is required but 'node' was not found in PATH."
}

$cliArgs = @($deployScript, $Command)
if ($TrustRoot) {
    $cliArgs += @("--trust-root", $TrustRoot)
}
if ($Project) {
    $cliArgs += @("--project", $Project)
}
if ($Register) {
    $cliArgs += "--register"
}
if ($Force) {
    $cliArgs += "--force"
}
if ($NoAutoStart) {
    $cliArgs += "--no-autostart"
}
if ($NoStart) {
    $cliArgs += "--no-start"
}

& node @cliArgs
exit $LASTEXITCODE
