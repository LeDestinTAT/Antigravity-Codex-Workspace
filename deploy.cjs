const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const BUNDLE_ROOT = __dirname;
const CLIENT_MODULE = require(path.join(BUNDLE_ROOT, "global", "client.cjs"));

function getHomeDir() {
  return process.env.DUAL_AGENT_HOME
    ? path.resolve(process.env.DUAL_AGENT_HOME)
    : path.join(os.homedir(), ".dual-agent");
}

function getGlobalSkillPath() {
  if (process.env.DUAL_AGENT_SKILL_PATH) {
    return path.resolve(process.env.DUAL_AGENT_SKILL_PATH);
  }
  return path.join(os.homedir(), ".gemini", "config", "skills", "codex-delegate", "SKILL.md");
}

function writeUtf8NoBomSync(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const normalized = content.replace(/^\uFEFF/, "");
  const buf = Buffer.from(normalized, "utf8");
  fs.writeFileSync(filePath, buf);
  return buf;
}

function verifySkillNoBom(filePath) {
  if (!fs.existsSync(filePath)) {
    return { ok: false, error: `Missing skill file: ${filePath}` };
  }
  const buf = fs.readFileSync(filePath);
  if (buf.length < 3 || buf[0] !== 45 || buf[1] !== 45 || buf[2] !== 45) {
    return {
      ok: false,
      error: `Invalid SKILL.md header bytes at ${filePath} (expected 45,45,45 '---', got ${buf.slice(0, 3).join(",")})`
    };
  }
  return { ok: true, first3Bytes: [buf[0], buf[1], buf[2]] };
}

function detectCommandPath(cmdName, fallbackCandidates = []) {
  const whereCmd = process.platform === "win32" ? "where.exe" : "which";
  const res = spawnSync(whereCmd, [cmdName], {
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    timeout: 3000
  });
  if (res.status === 0 && res.stdout) {
    const firstLine = res.stdout
      .split(/\r?\n/)
      .map(s => s.trim())
      .find(Boolean);
    if (firstLine && fs.existsSync(firstLine)) {
      return firstLine;
    }
  }
  for (const cand of fallbackCandidates) {
    if (cand && fs.existsSync(cand)) {
      return cand;
    }
  }
  return null;
}

function runPreflight() {
  const nodePath = process.execPath;
  const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  const codexPath = detectCommandPath("codex.cmd", [
    path.join(appData, "npm", "codex.cmd"),
    path.join(os.homedir(), ".npm-global", "codex.cmd")
  ]);
  const gitPath = detectCommandPath("git", [
    "C:\\Program Files\\Git\\cmd\\git.exe",
    "C:\\Program Files\\Git\\bin\\git.exe"
  ]);

  return {
    platform: process.platform,
    nodeVersion: process.version,
    nodePath,
    codexPath,
    gitPath,
    homeDir: getHomeDir(),
    globalSkillPath: getGlobalSkillPath()
  };
}

function configureWindowsAutoStart(homeDir, launcherExePath, bridgeScriptPath, disableAutoStart = false) {
  if (disableAutoStart || process.env.DUAL_AGENT_NO_AUTOSTART === "1" || process.platform !== "win32") {
    return { enabled: false, reason: "Skipped by configuration or non-Windows platform" };
  }

  const results = {
    enabled: false,
    registryRunKey: null,
    scheduledTask: null
  };

  // 1. Register per-user Registry Run key (zero elevation required, runs windowless launcher at user logon)
  const runCmd =
    launcherExePath && fs.existsSync(launcherExePath)
      ? `"${launcherExePath}"`
      : `"${process.execPath}" "${bridgeScriptPath}"`;

  const regRes = spawnSync(
    "reg.exe",
    [
      "add",
      "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
      "/v",
      "DualAgentGlobalBridge",
      "/t",
      "REG_SZ",
      "/d",
      runCmd,
      "/f"
    ],
    { encoding: "utf8", windowsHide: true, shell: false }
  );
  if (regRes.status === 0) {
    results.enabled = true;
    results.registryRunKey = {
      key: "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\\DualAgentGlobalBridge",
      command: runCmd
    };
  }

  // 2. Also update/register per-user Scheduled Task DualAgentGlobalBridge if schtasks permits current user
  const taskTr =
    launcherExePath && fs.existsSync(launcherExePath)
      ? `"${launcherExePath}"`
      : `"${process.execPath}" "${bridgeScriptPath}"`;
  const schRes = spawnSync(
    "schtasks.exe",
    ["/Create", "/TN", "DualAgentGlobalBridge", "/TR", taskTr, "/SC", "ONLOGON", "/F"],
    { encoding: "utf8", windowsHide: true, shell: false }
  );
  if (schRes.status === 0) {
    results.enabled = true;
    results.scheduledTask = "DualAgentGlobalBridge";
  }

  return results;
}

function removeWindowsAutoStart(disableAutoStart = false) {
  if (disableAutoStart || process.env.DUAL_AGENT_NO_AUTOSTART === "1" || process.platform !== "win32") {
    return { removedRegistryKey: false, removedScheduledTask: false };
  }
  const regDel = spawnSync(
    "reg.exe",
    ["delete", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", "/v", "DualAgentGlobalBridge", "/f"],
    { encoding: "utf8", windowsHide: true, shell: false }
  );
  const schDel = spawnSync("schtasks.exe", ["/Delete", "/TN", "DualAgentGlobalBridge", "/F"], {
    encoding: "utf8",
    windowsHide: true,
    shell: false
  });
  return {
    removedRegistryKey: regDel.status === 0,
    removedScheduledTask: schDel.status === 0
  };
}

async function startGlobalBridgeService(homeDir) {
  const statusBefore = CLIENT_MODULE.getBridgeStatus();
  if (statusBefore.bridgeRunning) {
    return {
      status: "ALREADY_RUNNING",
      pid: statusBefore.lock.pid,
      homeDir
    };
  }

  const bridgeScript = path.join(homeDir, "bridge.cjs");
  if (!fs.existsSync(bridgeScript)) {
    throw new Error(`Global Bridge script not found at ${bridgeScript}. Run 'install' first.`);
  }

  if (process.platform === "win32") {
    // Start-Process creates a fresh process without the caller's anonymous pipes.
    const psQuote = value => "'" + value.replace(/'/g, "''") + "'";
    const command = `Start-Process -FilePath ${psQuote(process.execPath)} -ArgumentList ${psQuote('"' + bridgeScript + '"')} -WorkingDirectory ${psQuote(homeDir)} -WindowStyle Hidden -ErrorAction Stop`;
    const launched = spawnSync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden",
      "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")
    ], {
      env: { ...process.env, DUAL_AGENT_HOME: homeDir },
      windowsHide: true,
      stdio: "ignore",
      timeout: 10000
    });
    if (launched.error || launched.status !== 0) {
      throw new Error(`Failed to launch Global Bridge: ${launched.error || launched.status}`);
    }
  } else {
    const child = spawn(process.execPath, [bridgeScript], {
      cwd: homeDir,
      env: {
        ...process.env,
        DUAL_AGENT_HOME: homeDir
      },
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    child.unref();
  }

  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    const st = CLIENT_MODULE.getBridgeStatus();
    if (st.bridgeRunning && st.globalStatus && (st.globalStatus.state === "IDLE" || st.globalStatus.state === "RUNNING")) {
      return {
        status: "STARTED",
        pid: st.lock.pid,
        homeDir
      };
    }
    await new Promise(r => setTimeout(r, 100));
  }

  throw new Error(`Timed out waiting for Global Bridge to start in ${homeDir}`);
}

function stopGlobalBridgeService(homeDir, force = false) {
  const st = CLIENT_MODULE.getBridgeStatus();
  if (!st.bridgeRunning || !st.lock || !st.lock.pid) {
    const lockPath = path.join(homeDir, "bridge.lock");
    if (fs.existsSync(lockPath)) {
      try {
        fs.unlinkSync(lockPath);
      } catch (_) {}
    }
    return { status: "NOT_RUNNING", homeDir };
  }

  if (!force && st.globalStatus && st.globalStatus.state === "RUNNING") {
    throw new Error(
      `Global Bridge (PID ${st.lock.pid}) is currently executing a task. Wait for IDLE or pass --force.`
    );
  }

  const targetPid = st.lock.pid;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(targetPid), "/T", "/F"], {
      windowsHide: true, stdio: "ignore", timeout: 5000
    });
  } else {
  try {
    process.kill(targetPid, "SIGTERM");
  } catch (_) {}
  }

  const deadline = Date.now() + 2000;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  let alive = true;
  while (alive) {
    try { process.kill(targetPid, 0); } catch (error) {
      if (error.code === "ESRCH") alive = false;
      else throw error;
    }
    if (!alive || Date.now() >= deadline) break;
    Atomics.wait(pause, 0, 0, 50);
  }
  if (alive) throw new Error(`Global Bridge (PID ${targetPid}) did not stop within 2 seconds.`);

  const lockPath = path.join(homeDir, "bridge.lock");
  try {
    if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
  } catch (_) {}

  return { status: "STOPPED", stoppedPid: targetPid, homeDir };
}

function loadTemplateText(relPath) {
  const candidateTemplate = path.join(BUNDLE_ROOT, "templates", relPath);
  if (fs.existsSync(candidateTemplate)) {
    return fs.readFileSync(candidateTemplate, "utf8");
  }
  const fallbackMap = {
    "GEMINI.md": path.join(BUNDLE_ROOT, "GEMINI.md"),
    "codex-delegate/SKILL.md": path.join(BUNDLE_ROOT, ".agents", "skills", "codex-delegate", "SKILL.md")
  };
  if (fallbackMap[relPath] && fs.existsSync(fallbackMap[relPath])) {
    return fs.readFileSync(fallbackMap[relPath], "utf8");
  }
  throw new Error(`Template not found: ${relPath}`);
}

function initProject({ projectPath, register = false, force = false }) {
  const resolvedProject = path.resolve(projectPath || process.cwd());
  fs.mkdirSync(resolvedProject, { recursive: true });
  const projectName = path.basename(resolvedProject);

  const geminiTarget = path.join(resolvedProject, "GEMINI.md");
  const handoffTarget = path.join(resolvedProject, "AI_HANDOFF.md");
  const skillTarget = path.join(resolvedProject, ".agents", "skills", "codex-delegate", "SKILL.md");

  const createdFiles = [];
  const skippedFiles = [];

  const geminiTemplate = loadTemplateText("GEMINI.md");
  if (force || !fs.existsSync(geminiTarget)) {
    writeUtf8NoBomSync(geminiTarget, geminiTemplate);
    createdFiles.push(geminiTarget);
  } else {
    skippedFiles.push(geminiTarget);
  }

  const handoffTemplate = loadTemplateText("AI_HANDOFF.md").replace(/\{\{PROJECT_NAME\}\}/g, projectName);
  if (force || !fs.existsSync(handoffTarget)) {
    writeUtf8NoBomSync(handoffTarget, handoffTemplate);
    createdFiles.push(handoffTarget);
  } else {
    skippedFiles.push(handoffTarget);
  }

  const skillTemplate = loadTemplateText("codex-delegate/SKILL.md");
  if (force || !fs.existsSync(skillTarget)) {
    writeUtf8NoBomSync(skillTarget, skillTemplate);
    createdFiles.push(skillTarget);
  } else {
    skippedFiles.push(skillTarget);
  }

  const skillCheck = verifySkillNoBom(skillTarget);
  if (!skillCheck.ok) {
    throw new Error(skillCheck.error);
  }

  let registration = null;
  if (register) {
    registration = CLIENT_MODULE.registerProject(resolvedProject);
  }

  return {
    status: "INITIALIZED",
    projectRoot: resolvedProject,
    createdFiles,
    skippedFiles,
    skillVerified: skillCheck,
    registration
  };
}

async function installEnvironment(options = {}) {
  const preflight = runPreflight();
  const homeDir = preflight.homeDir;
  const globalSkillPath = preflight.globalSkillPath;

  for (const dir of [
    homeDir,
    path.join(homeDir, "bin"),
    path.join(homeDir, "queue"),
    path.join(homeDir, "queue", "pending"),
    path.join(homeDir, "queue", "tasks"),
    path.join(homeDir, "logs"),
    path.join(homeDir, "logs", "projects")
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const srcBridge = path.join(BUNDLE_ROOT, "global", "bridge.cjs");
  const srcClient = path.join(BUNDLE_ROOT, "global", "client.cjs");
  const destBridge = path.join(homeDir, "bridge.cjs");
  const destClient = path.join(homeDir, "client.cjs");

  // If Bridge is already running and IDLE, restart it only if files are being updated
  const statusBefore = CLIENT_MODULE.getBridgeStatus();
  let stoppedForUpgrade = false;
  if (statusBefore.bridgeRunning && statusBefore.globalStatus && statusBefore.globalStatus.state === "IDLE") {
    stopGlobalBridgeService(homeDir, false);
    stoppedForUpgrade = true;
  }

  fs.copyFileSync(srcBridge, destBridge);
  fs.copyFileSync(srcClient, destClient);

  const srcLauncher = path.join(BUNDLE_ROOT, "bin", "dual-agent-launcher.exe");
  const destLauncher = path.join(homeDir, "bin", "dual-agent-launcher.exe");
  if (fs.existsSync(srcLauncher)) {
    try {
      fs.copyFileSync(srcLauncher, destLauncher);
    } catch (_) {}
  }

  // Install global SKILL.md (UTF-8 without BOM)
  const skillTemplate = loadTemplateText("codex-delegate/SKILL.md");
  writeUtf8NoBomSync(globalSkillPath, skillTemplate);
  const skillCheck = verifySkillNoBom(globalSkillPath);
  if (!skillCheck.ok) {
    throw new Error(skillCheck.error);
  }

  // Ensure projects.json exists (preserving any existing registrations & trustedRoots)
  const registry = CLIENT_MODULE.loadProjectsRegistry();
  if (!fs.existsSync(path.join(homeDir, "projects.json"))) {
    fs.writeFileSync(path.join(homeDir, "projects.json"), JSON.stringify(registry, null, 2), "utf8");
  }

  let trustedRootResult = null;
  if (options.trustRoot && typeof options.trustRoot === "string") {
    trustedRootResult = CLIENT_MODULE.trustRoot(options.trustRoot);
  }

  let projectInitResult = null;
  if (options.project && typeof options.project === "string") {
    projectInitResult = initProject({
      projectPath: options.project,
      register: Boolean(options.register),
      force: Boolean(options.force)
    });
  }

  const autoStart = configureWindowsAutoStart(
    homeDir,
    fs.existsSync(destLauncher) ? destLauncher : null,
    destBridge,
    Boolean(options.noAutoStart)
  );

  const serviceStart = options.noStart
    ? { status: "SKIPPED_START", homeDir }
    : await startGlobalBridgeService(homeDir);

  return {
    status: "INSTALLED",
    preflight,
    deployedFiles: {
      bridge: destBridge,
      client: destClient,
      launcher: fs.existsSync(destLauncher) ? destLauncher : null,
      globalSkill: globalSkillPath
    },
    skillVerified: skillCheck,
    autoStart,
    service: serviceStart,
    restartedIdleBridge: stoppedForUpgrade,
    trustedRoot: trustedRootResult,
    projectInit: projectInitResult
  };
}

function runDoctor() {
  const preflight = runPreflight();
  const homeDir = preflight.homeDir;
  const bridgeExists = fs.existsSync(path.join(homeDir, "bridge.cjs"));
  const clientExists = fs.existsSync(path.join(homeDir, "client.cjs"));
  const skillVerify = verifySkillNoBom(preflight.globalSkillPath);
  const bridgeStatus = CLIENT_MODULE.getBridgeStatus();
  const registry = CLIENT_MODULE.loadProjectsRegistry();

  const healthy =
    bridgeExists &&
    clientExists &&
    skillVerify.ok &&
    bridgeStatus.bridgeRunning &&
    (!bridgeStatus.globalStatus || bridgeStatus.globalStatus.state !== "BLOCKED");

  return {
    healthy,
    preflight,
    files: {
      bridgeExists,
      clientExists,
      skillVerify
    },
    bridgeStatus,
    trustedRootsCount: registry.trustedRoots.length,
    registeredProjectsCount: registry.projects.length
  };
}

function parseCliArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    } else {
      args._.push(token);
    }
  }
  return args;
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const cmd = args._[0] || "install";

  try {
    if (cmd === "install") {
      const res = await installEnvironment({
        trustRoot: args["trust-root"] || null,
        project: args.project || null,
        register: Boolean(args.register),
        force: Boolean(args.force),
        noAutoStart: Boolean(args["no-autostart"]),
        noStart: Boolean(args["no-start"])
      });
      console.log(JSON.stringify(res, null, 2));
      return;
    }

    if (cmd === "init-project") {
      const res = initProject({
        projectPath: args.project || args.path || process.cwd(),
        register: Boolean(args.register),
        force: Boolean(args.force)
      });
      console.log(JSON.stringify(res, null, 2));
      return;
    }

    if (cmd === "start") {
      const res = await startGlobalBridgeService(getHomeDir());
      console.log(JSON.stringify(res, null, 2));
      return;
    }

    if (cmd === "stop") {
      const res = stopGlobalBridgeService(getHomeDir(), Boolean(args.force));
      console.log(JSON.stringify(res, null, 2));
      return;
    }

    if (cmd === "status") {
      const st = CLIENT_MODULE.getBridgeStatus();
      const reg = CLIENT_MODULE.loadProjectsRegistry();
      console.log(
        JSON.stringify(
          {
            ...st,
            trustedRoots: reg.trustedRoots,
            projects: reg.projects
          },
          null,
          2
        )
      );
      return;
    }

    if (cmd === "doctor") {
      const doc = runDoctor();
      console.log(JSON.stringify(doc, null, 2));
      if (!doc.healthy) {
        process.exit(1);
      }
      return;
    }

    if (cmd === "uninstall") {
      const homeDir = getHomeDir();
      const stopRes = stopGlobalBridgeService(homeDir, true);
      const autoStartRes = removeWindowsAutoStart(Boolean(args["no-autostart"]));
      console.log(
        JSON.stringify(
          {
            status: "UNINSTALLED",
            stoppedBridge: stopRes,
            removedAutoStart: autoStartRes,
            homeDir
          },
          null,
          2
        )
      );
      return;
    }

    // Forward any client.cjs commands (such as trust-root, list-trusted-roots, untrust-root, register, check-project)
    const clientPath = path.join(getHomeDir(), "client.cjs");
    const targetClient = fs.existsSync(clientPath) ? clientPath : path.join(BUNDLE_ROOT, "global", "client.cjs");
    const forwarded = spawnSync(process.execPath, [targetClient, ...process.argv.slice(2)], {
      stdio: "inherit",
      env: process.env
    });
    process.exit(forwarded.status ?? 1);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  installEnvironment,
  initProject,
  startGlobalBridgeService,
  stopGlobalBridgeService,
  runDoctor,
  verifySkillNoBom
};
