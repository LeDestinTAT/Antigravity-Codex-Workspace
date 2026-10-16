const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const HOME_DIR = process.env.DUAL_AGENT_HOME
  ? path.resolve(process.env.DUAL_AGENT_HOME)
  : path.join(os.homedir(), ".dual-agent");

const PROJECTS_FILE = path.join(HOME_DIR, "projects.json");
const QUEUE_DIR = path.join(HOME_DIR, "queue");
const SUBMIT_LOCK_FILE = path.join(QUEUE_DIR, "submit.lock");
const SUBMIT_RECLAIM_FILE = path.join(QUEUE_DIR, "submit.lock.reclaim");
const PENDING_DIR = path.join(QUEUE_DIR, "pending");
const TASKS_DIR = path.join(QUEUE_DIR, "tasks");
const GLOBAL_STATUS = path.join(HOME_DIR, "status.json");
const LOCK_FILE = path.join(HOME_DIR, "bridge.lock");

// Must start with alphanumeric [A-Za-z0-9] so "." and ".." are strictly rejected
const TASK_ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

let tmpSeq = 0;
const SLEEP_ARRAY = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms) {
  Atomics.wait(SLEEP_ARRAY, 0, 0, ms);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isValidTaskId(taskId) {
  return typeof taskId === "string" && TASK_ID_REGEX.test(taskId) && !taskId.includes("..");
}

function resolveSafeTaskDir(taskId) {
  if (!isValidTaskId(taskId)) {
    throw new Error(`Invalid taskId: ${String(taskId)}`);
  }
  const resolved = path.resolve(TASKS_DIR, taskId);
  if (path.dirname(resolved) !== TASKS_DIR || path.basename(resolved) !== taskId) {
    throw new Error(`Task directory escape detected for taskId: ${taskId}`);
  }
  return resolved;
}

function ensureDirs() {
  for (const dir of [HOME_DIR, QUEUE_DIR, PENDING_DIR, TASKS_DIR, path.join(HOME_DIR, "logs"), path.join(HOME_DIR, "logs", "projects")]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function renameWithRetrySync(srcPath, destPath, maxAttempts = 12) {
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      fs.renameSync(srcPath, destPath);
      return;
    } catch (err) {
      lastErr = err;
      const retryable = err && (err.code === "EPERM" || err.code === "EACCES" || err.code === "EBUSY");
      if (!retryable || attempt === maxAttempts) {
        break;
      }
      sleepSync(15 * attempt);
    }
  }
  try {
    if (fs.existsSync(srcPath)) fs.unlinkSync(srcPath);
  } catch (_) {}
  throw lastErr;
}

function writeTextAtomicSync(targetPath, content) {
  const tmpPath = `${targetPath}.tmp.${process.pid}.${++tmpSeq}`;
  let fd = null;
  try {
    fd = fs.openSync(tmpPath, "wx");
    fs.writeFileSync(fd, content, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
  } catch (err) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch (_) {}
    }
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch (_) {}
    throw err;
  }
  renameWithRetrySync(tmpPath, targetPath);
}

function writeJsonAtomicSync(targetPath, payload) {
  writeTextAtomicSync(targetPath, JSON.stringify(payload, null, 2));
}

function readJsonStrictSync(filePath, retries = 4) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    if (!fs.existsSync(filePath)) {
      return { exists: false, ok: true, data: null };
    }
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      if (!raw.trim()) {
        throw new Error("Empty JSON file");
      }
      return { exists: true, ok: true, data: JSON.parse(raw), raw };
    } catch (err) {
      if (attempt < retries) {
        sleepSync(20 * attempt);
        continue;
      }
      return { exists: true, ok: false, error: err.message };
    }
  }
  return { exists: false, ok: true, data: null };
}

function checkPidState(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return "INVALID";
  try {
    process.kill(pid, 0);
    return "ALIVE";
  } catch (err) {
    if (err && err.code === "ESRCH") return "DEAD";
    if (err && err.code === "EPERM") return "ALIVE";
    return "UNKNOWN";
  }
}

function writeExclusiveLockFile(filePath, payload) {
  const fd = fs.openSync(filePath, "wx");
  try {
    fs.writeFileSync(fd, JSON.stringify(payload, null, 2), "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function tryReclaimDeadLockFile(lockFile, reclaimFile) {
  const existing = readJsonStrictSync(lockFile, 3);
  if (!existing.exists) return true;
  if (!existing.ok || !existing.data || !Number.isSafeInteger(existing.data.pid)) {
    return false;
  }
  if (checkPidState(existing.data.pid) !== "DEAD") {
    return false;
  }
  try {
    writeExclusiveLockFile(reclaimFile, {
      reclaimerPid: process.pid,
      timestamp: new Date().toISOString()
    });
  } catch (_) {
    return false;
  }
  try {
    const recheck = readJsonStrictSync(lockFile, 2);
    if (recheck.exists && recheck.ok && recheck.data && recheck.data.pid === existing.data.pid) {
      fs.unlinkSync(lockFile);
      return true;
    }
    return false;
  } catch (_) {
    return false;
  } finally {
    try {
      if (fs.existsSync(reclaimFile)) fs.unlinkSync(reclaimFile);
    } catch (_) {}
  }
}

function acquireSubmitLock(timeoutMs = 3000) {
  ensureDirs();
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      const fd = fs.openSync(SUBMIT_LOCK_FILE, "wx");
      fs.writeFileSync(
        fd,
        JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }),
        "utf8"
      );
      fs.fsyncSync(fd);
      return fd;
    } catch (err) {
      if (err && err.code === "EEXIST") {
        if (tryReclaimDeadLockFile(SUBMIT_LOCK_FILE, SUBMIT_RECLAIM_FILE)) {
          continue;
        }
        if (Date.now() < deadline) {
          sleepSync(25);
          continue;
        }
      }
      throw new Error("Could not acquire submit.lock (another submission is active or stale submit.lock exists).");
    }
  }
}

function releaseSubmitLock(fd) {
  if (fd === null || fd === undefined) {
    return;
  }
  try {
    fs.closeSync(fd);
  } catch (_) {}
  try {
    const current = readJsonStrictSync(SUBMIT_LOCK_FILE, 2);
    if (current.exists && current.ok && current.data && current.data.pid === process.pid) {
      fs.unlinkSync(SUBMIT_LOCK_FILE);
    }
  } catch (_) {}
}

function findGitRoot(startDir) {
  let current = startDir;
  const root = path.parse(current).root;
  while (current && current !== root) {
    const gitEntry = path.join(current, ".git");
    if (fs.existsSync(gitEntry)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function validateAndNormalizeProjectPath(inputPath, useGitRoot = true) {
  if (typeof inputPath !== "string" || !inputPath.trim() || inputPath.includes("\0")) {
    throw new Error("Invalid project path");
  }
  const resolved = path.resolve(inputPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Project path does not exist: ${resolved}`);
  }
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    throw new Error(`Project path is not a directory: ${resolved}`);
  }
  const real = fs.realpathSync.native ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved);
  const parsedRoot = path.parse(real).root;
  if (real === parsedRoot) {
    throw new Error(`Refusing to use filesystem root as project directory: ${real}`);
  }

  const forbiddenPrefixes = [
    process.env.SystemRoot || "C:\\Windows",
    process.env.ProgramFiles || "C:\\Program Files",
    process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
    process.env.ProgramData || "C:\\ProgramData"
  ]
    .filter(Boolean)
    .map(p => p.toLowerCase());

  const lowerReal = real.toLowerCase();
  for (const forbidden of forbiddenPrefixes) {
    if (lowerReal === forbidden || lowerReal.startsWith(forbidden + "\\")) {
      throw new Error(`Refusing to register or access protected system directory: ${real}`);
    }
  }

  const gitRoot = findGitRoot(real);
  const effectiveRoot = useGitRoot && gitRoot ? gitRoot : real;
  const normalizedKey = process.platform === "win32" ? effectiveRoot.toLowerCase() : effectiveRoot;

  return {
    requestedPath: real,
    gitRoot,
    projectRoot: effectiveRoot,
    normalizedKey
  };
}

function isSubPathOrEqual(parentNormalized, childNormalized) {
  if (parentNormalized === childNormalized) return true;
  const rel = path.relative(parentNormalized, childNormalized);
  return Boolean(rel) && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function loadProjectsRegistry() {
  ensureDirs();
  if (!fs.existsSync(PROJECTS_FILE)) {
    return { version: 1, projects: [] };
  }
  const res = readJsonStrictSync(PROJECTS_FILE, 3);
  if (!res.ok || !res.data || !Array.isArray(res.data.projects)) {
    throw new Error(`Corrupted projects.json: ${res.error || "invalid structure"}`);
  }
  return res.data;
}

function findMatchingRegisteredProject(candidatePath) {
  const norm = validateAndNormalizeProjectPath(candidatePath, false);
  const registry = loadProjectsRegistry();
  const matches = [];

  for (const entry of registry.projects) {
    if (!entry || typeof entry.projectRoot !== "string") continue;
    try {
      const regNorm = validateAndNormalizeProjectPath(entry.projectRoot, false);
      if (isSubPathOrEqual(regNorm.normalizedKey, norm.normalizedKey)) {
        matches.push({
          entry,
          regNorm,
          keyLength: regNorm.normalizedKey.length
        });
      }
    } catch (_) {}
  }

  if (matches.length === 0) {
    return {
      authorized: false,
      requestedPath: norm.requestedPath,
      gitRoot: norm.gitRoot,
      suggestedRoot: norm.gitRoot || norm.requestedPath
    };
  }

  // Prefer exact match / most specific (deepest) registered project root
  matches.sort((a, b) => b.keyLength - a.keyLength);
  const best = matches[0];

  return {
    authorized: true,
    entry: best.entry,
    projectRoot: best.regNorm.projectRoot,
    requestedPath: norm.requestedPath,
    gitRoot: norm.gitRoot
  };
}

function registerProject(projectPath, customName = null, exactPath = false) {
  const norm = validateAndNormalizeProjectPath(projectPath, !exactPath);
  const lockFd = acquireSubmitLock();
  try {
    const registry = loadProjectsRegistry();
    const existing = registry.projects.find(
      p => p && typeof p.normalizedRoot === "string" && p.normalizedRoot === norm.normalizedKey
    );
    if (existing) {
      return { status: "ALREADY_REGISTERED", project: existing };
    }

    const baseSlug = path
      .basename(norm.projectRoot)
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "project";
    const shortHash = crypto.createHash("sha256").update(norm.normalizedKey).digest("hex").slice(0, 8);
    const projectId = `${baseSlug}-${shortHash}`;

    const newEntry = {
      projectId,
      name: customName || path.basename(norm.projectRoot),
      projectRoot: norm.projectRoot,
      normalizedRoot: norm.normalizedKey,
      gitRoot: norm.gitRoot,
      sandbox: "read-only",
      registeredAt: new Date().toISOString()
    };

    registry.projects.push(newEntry);
    writeJsonAtomicSync(PROJECTS_FILE, registry);
    return { status: "REGISTERED", project: newEntry };
  } finally {
    releaseSubmitLock(lockFd);
  }
}

function submitTask({ projectPath, promptText, customTaskId = null }) {
  if (typeof promptText !== "string" || !promptText.trim()) {
    throw new Error("Task prompt cannot be empty");
  }

  const match = findMatchingRegisteredProject(projectPath);
  if (!match.authorized) {
    const err = new Error(
      `PROJECT_NOT_REGISTERED: Project path "${match.requestedPath}" is not registered in ${PROJECTS_FILE}. Ask user for approval before registering "${match.suggestedRoot}".`
    );
    err.code = "PROJECT_NOT_REGISTERED";
    throw err;
  }

  const lockFd = acquireSubmitLock();
  try {
    const globalSt = readJsonStrictSync(GLOBAL_STATUS, 3);
    if (globalSt.exists && !globalSt.ok) {
      throw new Error(`Global status.json is corrupted: ${globalSt.error}`);
    }
    if (globalSt.data && globalSt.data.state === "BLOCKED") {
      const err = new Error(`BRIDGE_BLOCKED: Global Bridge is in BLOCKED state: ${globalSt.data.error}`);
      err.code = "BRIDGE_BLOCKED";
      throw err;
    }

    const taskId = customTaskId || `task-${Date.now()}-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const taskDir = resolveSafeTaskDir(taskId);
    if (fs.existsSync(taskDir)) {
      throw new Error(`Task ID collision or duplicate submission: ${taskId} already exists`);
    }

    // Exclusive directory creation (no recursive: true) guarantees no task overwrite
    fs.mkdirSync(taskDir);
    const requestFile = path.join(taskDir, "request.md");
    const statusFile = path.join(taskDir, "status.json");
    const metaFile = path.join(taskDir, "meta.json");

    const nowIso = new Date().toISOString();
    const manifest = {
      taskId,
      projectId: match.entry.projectId,
      projectRoot: match.projectRoot,
      requestedPath: match.requestedPath,
      submittedAt: nowIso
    };

    writeTextAtomicSync(requestFile, promptText);
    writeJsonAtomicSync(metaFile, manifest);
    writeJsonAtomicSync(statusFile, {
      state: "QUEUED",
      taskId,
      projectRoot: match.projectRoot,
      timestamp: nowIso
    });

    const pendingFile = path.join(PENDING_DIR, `${Date.now()}-${++tmpSeq}-${taskId}.json`);
    writeJsonAtomicSync(pendingFile, manifest);

    return {
      status: "SUBMITTED",
      taskId,
      projectId: match.entry.projectId,
      projectRoot: match.projectRoot,
      taskDir
    };
  } finally {
    releaseSubmitLock(lockFd);
  }
}

async function pollTask({ taskId, timeoutMs = 320000, intervalMs = 1000 }) {
  const taskDir = resolveSafeTaskDir(taskId);
  const statusFile = path.join(taskDir, "status.json");
  const resultFile = path.join(taskDir, "result.md");
  const logFile = path.join(taskDir, "task.log");

  const deadline = Date.now() + timeoutMs;
  let consecutiveReadErrors = 0;

  while (Date.now() < deadline) {
    const globalRes = readJsonStrictSync(GLOBAL_STATUS, 2);
    if (globalRes.exists && globalRes.ok && globalRes.data && globalRes.data.state === "BLOCKED") {
      const err = new Error(`Global Codex Bridge entered BLOCKED state: ${globalRes.data.error}`);
      err.code = "BRIDGE_BLOCKED";
      throw err;
    }

    if (fs.existsSync(statusFile)) {
      const stRes = readJsonStrictSync(statusFile, 2);
      if (!stRes.ok) {
        consecutiveReadErrors++;
        if (consecutiveReadErrors >= 5) {
          throw new Error(`Persistent failure reading task status.json: ${stRes.error}`);
        }
      } else {
        consecutiveReadErrors = 0;
        const st = stRes.data;
        if (st.state === "BLOCKED") {
          const err = new Error(`Task ${taskId} entered BLOCKED state: ${st.error}`);
          err.code = "BRIDGE_BLOCKED";
          throw err;
        }
        if (st.taskId === taskId) {
          if (st.state === "DONE") {
            if (!fs.existsSync(resultFile)) {
              throw new Error(`Task ${taskId} reported DONE, but result.md is missing at ${resultFile}`);
            }
            const resultContent = fs.readFileSync(resultFile, "utf8");
            return {
              state: "DONE",
              taskId,
              projectRoot: st.projectRoot,
              resultFile,
              result: resultContent
            };
          }
          if (st.state === "FAILED") {
            let logTail = "";
            if (fs.existsSync(logFile)) {
              const lines = fs.readFileSync(logFile, "utf8").split(/\r?\n/);
              logTail = lines.slice(-50).join("\n");
            }
            const err = new Error(
              `Codex task (${taskId}) FAILED: ${st.error}${logTail ? `\n--- Task Log Tail ---\n${logTail}` : ""}`
            );
            err.code = "TASK_FAILED";
            throw err;
          }
        }
      }
    }

    await sleep(intervalMs);
  }

  const err = new Error(`Timed out after ${timeoutMs}ms waiting for task ${taskId}. Do NOT automatically resubmit.`);
  err.code = "POLL_TIMEOUT";
  throw err;
}

function getBridgeStatus(taskId = null) {
  ensureDirs();
  const lockRes = readJsonStrictSync(LOCK_FILE, 2);
  const globalRes = readJsonStrictSync(GLOBAL_STATUS, 2);
  let bridgeAlive = false;
  if (lockRes.exists && lockRes.ok && lockRes.data && lockRes.data.pid) {
    bridgeAlive = checkPidState(lockRes.data.pid) === "ALIVE";
  }

  const info = {
    homeDir: HOME_DIR,
    bridgeRunning: bridgeAlive,
    lock: lockRes.ok ? lockRes.data : { error: lockRes.error },
    globalStatus: globalRes.ok ? globalRes.data : { error: globalRes.error }
  };

  if (taskId) {
    const taskDir = resolveSafeTaskDir(taskId);
    const taskStatusRes = readJsonStrictSync(path.join(taskDir, "status.json"), 2);
    info.taskStatus = taskStatusRes.exists ? (taskStatusRes.ok ? taskStatusRes.data : { error: taskStatusRes.error }) : null;
  }
  return info;
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

function readPromptFromArgs(args) {
  if (typeof args.prompt === "string") {
    return args.prompt;
  }
  if (typeof args["prompt-file"] === "string") {
    return fs.readFileSync(path.resolve(args["prompt-file"]), "utf8");
  }
  if (args.stdin) {
    return fs.readFileSync(0, "utf8");
  }
  throw new Error("Provide task prompt via --prompt <text>, --prompt-file <path>, or --stdin");
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const cmd = args._[0];

  try {
    if (cmd === "register") {
      const projectPath = args.project || process.cwd();
      const res = registerProject(projectPath, args.name || null, Boolean(args.exact));
      console.log(JSON.stringify(res, null, 2));
      return;
    }

    if (cmd === "list") {
      const reg = loadProjectsRegistry();
      console.log(JSON.stringify(reg, null, 2));
      return;
    }

    if (cmd === "check-project") {
      const projectPath = args.project || process.cwd();
      const res = findMatchingRegisteredProject(projectPath);
      console.log(JSON.stringify(res, null, 2));
      if (!res.authorized) {
        process.exit(2);
      }
      return;
    }

    if (cmd === "submit") {
      const projectPath = args.project || process.cwd();
      const promptText = readPromptFromArgs(args);
      const res = submitTask({
        projectPath,
        promptText,
        customTaskId: typeof args["task-id"] === "string" ? args["task-id"] : null
      });
      console.log(JSON.stringify(res, null, 2));
      return;
    }

    if (cmd === "poll" || cmd === "wait") {
      const taskId = args["task-id"];
      const timeoutMs = args["timeout-ms"] ? Number.parseInt(args["timeout-ms"], 10) : 320000;
      const intervalMs = args["interval-ms"] ? Number.parseInt(args["interval-ms"], 10) : 1000;
      const res = await pollTask({ taskId, timeoutMs, intervalMs });
      process.stdout.write(res.result);
      return;
    }

    if (cmd === "run") {
      const projectPath = args.project || process.cwd();
      const promptText = readPromptFromArgs(args);
      const timeoutMs = args["timeout-ms"] ? Number.parseInt(args["timeout-ms"], 10) : 320000;
      const intervalMs = args["interval-ms"] ? Number.parseInt(args["interval-ms"], 10) : 1000;
      const sub = submitTask({
        projectPath,
        promptText,
        customTaskId: typeof args["task-id"] === "string" ? args["task-id"] : null
      });
      console.error(`SUBMITTED_TASK_ID=${sub.taskId} PROJECT_ROOT=${sub.projectRoot}`);
      const res = await pollTask({
        taskId: sub.taskId,
        timeoutMs,
        intervalMs
      });
      process.stdout.write(res.result);
      return;
    }

    if (cmd === "status") {
      const info = getBridgeStatus(typeof args["task-id"] === "string" ? args["task-id"] : null);
      console.log(JSON.stringify(info, null, 2));
      return;
    }

    console.error(
      "Usage: node client.cjs <register|list|check-project|submit|poll|run|status> [--project <dir>] [--prompt <text>|--prompt-file <file>|--stdin] [--task-id <id>]"
    );
    process.exit(1);
  } catch (err) {
    console.error(err.message);
    if (err.code === "PROJECT_NOT_REGISTERED") process.exit(2);
    if (err.code === "BRIDGE_BLOCKED") process.exit(3);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  HOME_DIR,
  PROJECTS_FILE,
  isValidTaskId,
  resolveSafeTaskDir,
  validateAndNormalizeProjectPath,
  findMatchingRegisteredProject,
  registerProject,
  loadProjectsRegistry,
  submitTask,
  pollTask,
  getBridgeStatus
};
