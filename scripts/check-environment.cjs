// Reports prerequisites only: does not install software, log in or start the bridge.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const windows = process.platform === 'win32';
function locate(name) {
  const result = spawnSync(windows ? 'where.exe' : 'which', [name], { encoding: 'utf8', windowsHide: true });
  return result.status === 0 ? result.stdout.trim().split(/\r?\n/) : [];
}
const gitPaths = locate('git');
const codexPaths = locate('codex.cmd');
const systemRoot = process.env.SystemRoot || 'C:\\Windows';
const compilers = ['Framework64', 'Framework'].map(dir => path.join(systemRoot, 'Microsoft.NET', dir, 'v4.0.30319', 'csc.exe')).filter(p => fs.existsSync(p));
const report = {
  platform: process.platform,
  node: { version: process.version, supported: Number(process.versions.node.split('.')[0]) >= 22 },
  git: { found: gitPaths.length > 0, paths: gitPaths },
  codexCmd: { found: codexPaths.length > 0, paths: codexPaths },
  optionalExeBuild: { csharpCompilerFound: compilers.length > 0, paths: compilers },
  manualChecks: ['Log in to Codex CLI and Antigravity separately.', 'Run codex.cmd --version; the bridge invokes codex.cmd, not codex.exe.', 'Run deploy.cjs doctor after source installation, then perform a real read-only review task.']
};
console.log(JSON.stringify(report, null, 2));
if (!windows || !report.node.supported || !report.git.found || !report.codexCmd.found) process.exitCode = 1;
