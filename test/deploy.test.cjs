const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const REPO_ROOT = path.resolve(__dirname, "..");
const DEPLOY_SCRIPT = path.join(REPO_ROOT, "deploy.cjs");
const BUILD_EXE_SCRIPT = path.join(REPO_ROOT, "build-exe.ps1");

function createTempDir(prefix = "dual-agent-deploy-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanupDir(dirPath) {
  try {
    fs.rmSync(dirPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch (_) {}
}

test("1. deploy.cjs install, doctor, init-project, and stop in an isolated environment", () => {
  const rootDir = createTempDir();
  const homeDir = path.join(rootDir, "isolated home's");
  const skillPath = path.join(rootDir, "config", "skills", "codex-delegate", "SKILL.md");
  const trustedDir = path.join(rootDir, "WorkspaceProjects");
  const targetProject = path.join(trustedDir, "SampleRepo");
  fs.mkdirSync(path.join(targetProject, ".git"), { recursive: true });

  const env = {
    ...process.env,
    DUAL_AGENT_HOME: homeDir,
    DUAL_AGENT_SKILL_PATH: skillPath,
    DUAL_AGENT_NO_AUTOSTART: "1"
  };

  try {
    const installRes = spawnSync(
      process.execPath,
      [
        DEPLOY_SCRIPT,
        "install",
        "--no-autostart",
        "--trust-root",
        trustedDir,
        "--project",
        targetProject
      ],
      { env, encoding: "utf8", timeout: 30000, windowsHide: true }
    );
    assert.ifError(installRes.error);
    assert.equal(installRes.status, 0, `Install failed: ${installRes.stderr}`);
    const installJson = JSON.parse(installRes.stdout);
    assert.equal(installJson.status, "INSTALLED");
    assert.deepEqual(installJson.skillVerified.first3Bytes, [45, 45, 45]);
    assert.equal(installJson.trustedRoot.status, "TRUSTED");
    assert.equal(installJson.projectInit.status, "INITIALIZED");

    // Verify initialized project files have no personal paths and SKILL.md starts with 45,45,45
    const projHandoff = fs.readFileSync(path.join(targetProject, "AI_HANDOFF.md"), "utf8");
    assert.match(projHandoff, /Project: SampleRepo/);
    assert.doesNotMatch(projHandoff, /C:\\Users\\Rin/i);

    const projSkillBytes = fs.readFileSync(path.join(targetProject, ".agents", "skills", "codex-delegate", "SKILL.md"));
    assert.equal(projSkillBytes[0], 45);
    assert.equal(projSkillBytes[1], 45);
    assert.equal(projSkillBytes[2], 45);

    // Run doctor
    const docRes = spawnSync(process.execPath, [DEPLOY_SCRIPT, "doctor"], { env, encoding: "utf8", timeout: 30000, windowsHide: true });
    assert.equal(docRes.status, 0, `Doctor failed: ${docRes.stderr}`);
    const docJson = JSON.parse(docRes.stdout);
    assert.equal(docJson.healthy, true);
    assert.equal(docJson.trustedRootsCount, 1);

    // Stop isolated Bridge
    const stopRes = spawnSync(process.execPath, [DEPLOY_SCRIPT, "stop"], { env, encoding: "utf8", timeout: 30000, windowsHide: true });
    assert.equal(stopRes.status, 0);
    const stopped = JSON.parse(stopRes.stdout);
    assert.equal(stopped.status, "STOPPED");
    assert.throws(() => process.kill(stopped.stoppedPid, 0), { code: "ESRCH" });
  } finally {
    spawnSync(process.execPath, [DEPLOY_SCRIPT, "stop", "--force"], { env, encoding: "utf8", timeout: 30000, windowsHide: true });
    cleanupDir(rootDir);
  }
});

test("2. build-exe.ps1 compiles DualAgentSetup.exe and dual-agent-launcher.exe and executes one-click install cleanly", () => {
  const rootDir = createTempDir();
  const outRelDir = path.join("dist");
  const distDir = path.join(REPO_ROOT, outRelDir);

  const buildRes = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", BUILD_EXE_SCRIPT, "-OutDir", outRelDir],
    { cwd: REPO_ROOT, encoding: "utf8", timeout: 120000, windowsHide: true }
  );
  assert.equal(buildRes.status, 0, `build-exe.ps1 failed: ${buildRes.stderr}\n${buildRes.stdout}`);

  const setupExe = path.join(distDir, "DualAgentSetup.exe");
  const launcherExe = path.join(distDir, "dual-agent-launcher.exe");
  const bundleZip = path.join(distDir, "dual-agent-bundle.zip");
  const sumsFile = path.join(distDir, "SHA256SUMS.txt");

  assert.equal(fs.existsSync(setupExe), true);
  assert.equal(fs.existsSync(launcherExe), true);
  assert.equal(fs.existsSync(bundleZip), true);
  assert.equal(fs.existsSync(sumsFile), true);

  const homeDir = path.join(rootDir, "exe home's");
  const skillPath = path.join(rootDir, "exe-skill", "SKILL.md");
  const trustedDir = path.join(rootDir, "ExeTrustedWorkspace");
  fs.mkdirSync(trustedDir, { recursive: true });

  const env = {
    ...process.env,
    DUAL_AGENT_HOME: homeDir,
    DUAL_AGENT_SKILL_PATH: skillPath,
    DUAL_AGENT_NO_AUTOSTART: "1"
  };

  try {
    const exeInstall = spawnSync(
      setupExe,
      ["install", "--no-autostart", "--trust-root", trustedDir],
      { env, encoding: "utf8", timeout: 30000, windowsHide: true }
    );
    assert.ifError(exeInstall.error);
    assert.equal(exeInstall.status, 0, `DualAgentSetup.exe install failed: ${exeInstall.stderr}`);
    const parsed = JSON.parse(exeInstall.stdout);
    assert.equal(parsed.status, "INSTALLED");
    assert.equal(fs.existsSync(path.join(homeDir, "bin", "dual-agent-launcher.exe")), true);
    assert.equal(fs.existsSync(path.join(homeDir, "bridge.cjs")), true);
    assert.equal(fs.existsSync(path.join(homeDir, "client.cjs")), true);

    // Ensure extracted bundle files contain no hardcoded personal paths
    const extractedSkill = fs.readFileSync(skillPath, "utf8");
    assert.doesNotMatch(extractedSkill, /C:\\Users\\Rin/i);

    const exeDoctor = spawnSync(setupExe, ["doctor"], { env, encoding: "utf8", timeout: 30000, windowsHide: true });
    assert.equal(exeDoctor.status, 0);
    assert.equal(JSON.parse(exeDoctor.stdout).healthy, true);
  } finally {
    spawnSync(setupExe, ["stop", "--force"], { env, encoding: "utf8", timeout: 30000, windowsHide: true });
    cleanupDir(rootDir);
  }
});
