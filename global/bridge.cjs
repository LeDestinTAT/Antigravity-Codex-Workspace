const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");

const HOME_DIR = process.env.DUAL_AGENT_HOME
  ? path.resolve(process.env.DUAL_AGENT_HOME)
  : path.join(os.homedir(), ".dual-agent");

const PROJECTS_FILE = path.join(HOME_DIR, "projects.json");
const QUEUE_DIR = path.join(HOME_DIR, "queue");
const SUBMIT_LOCK_FILE = path.join(QUEUE_DIR, "submit.lock");
const SUBMIT_RECLAIM_FILE = path.join(QUEUE_DIR, "submit.lock.reclaim");
const PENDING_DIR = path.join(QUEUE_DIR, "pending");
const TASKS_DIR = path.join(QUEUE_DIR, "tasks");
const CLAIMED_FILE = path.join(QUEUE_DIR, "claimed.json");
const LOGS_DIR = path.join(HOME_DIR, "logs");
const PROJECT_LOGS_DIR = path.join(LOGS_DIR, "projects");
const GLOBAL_LOG = path.join(LOGS_DIR, "bridge.log");
const GLOBAL_STATUS = path.join(HOME_DIR, "status.json");
const LOCK_FILE = path.join(HOME_DIR, "bridge.lock");
const LOCK_RECLAIM_FILE = path.join(HOME_DIR, "bridge.lock.reclaim");

function parsePositiveInt(envVal, fallback, minVal = 20) {
  if (envVal === undefined || envVal === "") return fallback;
  const parsed = Number.parseInt(envVal, 10);
  if (!Number.isSafeInteger(parsed) || parsed < minVal) {
    throw new Error(`Invalid numeric configuration value: ${envVal}`);
  }
  return parsed;
}

const POLL_MS = parsePositiveInt(process.env.CODEX_BRIDGE_POLL_MS, 1000, 20);
const TIMEOUT_MS = parsePositiveInt(process.env.CODEX_BRIDGE_TIMEOUT_MS, 300000, 100);
const KILL_GRACE_MS = parsePositiveInt(process.env.CODEX_BRIDGE_KILL_GRACE_MS, 5000, 100);

const BRIDGE_INSTANCE_ID = crypto.randomUUID();
// Must start with alphanumeric [A-Za-z0-9] so "." and ".." are strictly rejected
const TASK_ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

for (const dir of [HOME_DIR, QUEUE_DIR, PENDING_DIR, TASKS_DIR, LOGS_DIR, PROJECT_LOGS_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

let busy = false;
let halted = false;
let tmpSeq = 0;
let pollTimer = null;

const SLEEP_ARRAY = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms) {
  Atomics.wait(SLEEP_ARRAY, 0, 0, ms);
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

function safeAppendFile(filePath, message) {
  try {
    const buf = Buffer.isBuffer(message) ? message : Buffer.from(String(message), "utf8");
    fs.appendFileSync(filePath, buf);
  } catch (err) {
    console.error(`[Bridge Log Error: ${filePath}]`, err.message);
  }
}

function safeLogLine(line, extraLogFiles = []) {
  const formatted = `${new Date().toISOString()} [Bridge ${BRIDGE_INSTANCE_ID.slice(0, 8)}] ${line}\n`;
  safeAppendFile(GLOBAL_LOG, formatted);
  for (const file of extraLogFiles) {
    if (file) safeAppendFile(file, formatted);
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
    if (err && err.code === "ESRCH") {
      return "DEAD";
    }
    if (err && err.code === "EPERM") {
      return "ALIVE";
    }
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

function acquireSubmitLock(timeoutMs = 2000) {
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
      throw new Error("Could not acquire submit.lock");
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

function resolveNativeRealpath(targetPath) {
  return fs.realpathSync.native ? fs.realpathSync.native(targetPath) : fs.realpathSync(targetPath);
}

function normalizePathKey(realPathStr) {
  const parsed = path.parse(realPathStr);
  let cleaned = realPathStr;
  if (cleaned.length > parsed.root.length) {
    cleaned = cleaned.replace(/[\\/]+$/, "");
  }
  return process.platform === "win32" ? cleaned.toLowerCase() : cleaned;
}

function isSubPathOrEqual(parentNormalized, childNormalized) {
  if (parentNormalized === childNormalized) return true;
  const parentRoot = path.parse(parentNormalized).root;
  const childRoot = path.parse(childNormalized).root;
  if (parentRoot !== childRoot) return false;
  const rel = path.relative(parentNormalized, childNormalized);
  return Boolean(rel) && rel !== "." && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function assertNotProtectedDirectory(realPathStr) {
  const parsedRoot = path.parse(realPathStr).root;
  const normCandidate = normalizePathKey(realPathStr);
  const normRoot = normalizePathKey(parsedRoot);

  if (normCandidate === normRoot) {
    throw new Error(`Refusing to use filesystem root as project directory: ${realPathStr}`);
  }

  const forbiddenSystemDirs = [
    process.env.SystemRoot || "C:\\Windows",
    process.env.ProgramFiles || "C:\\Program Files",
    process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
    process.env.ProgramData || "C:\\ProgramData"
  ].filter(Boolean);

  for (const sysDir of forbiddenSystemDirs) {
    let normSys = normalizePathKey(path.resolve(sysDir));
    try {
      if (fs.existsSync(sysDir)) {
        normSys = normalizePathKey(resolveNativeRealpath(path.resolve(sysDir)));
      }
    } catch (_) {}
    if (isSubPathOrEqual(normSys, normCandidate) || isSubPathOrEqual(normCandidate, normSys)) {
      throw new Error(`Refusing to access protected system directory: ${realPathStr}`);
    }
  }

  const userHome = os.homedir();
  if (userHome) {
    let normUserHome = normalizePathKey(path.resolve(userHome));
    try {
      if (fs.existsSync(userHome)) {
        normUserHome = normalizePathKey(resolveNativeRealpath(path.resolve(userHome)));
      }
    } catch (_) {}
    if (isSubPathOrEqual(normCandidate, normUserHome)) {
      throw new Error(`Refusing to authorize user home directory or its ancestor: ${realPathStr}`);
    }
  }

  let normServiceHome = normalizePathKey(HOME_DIR);
  try {
    if (fs.existsSync(HOME_DIR)) {
      normServiceHome = normalizePathKey(resolveNativeRealpath(HOME_DIR));
    }
  } catch (_) {}
  if (isSubPathOrEqual(normServiceHome, normCandidate)) {
    throw new Error(`Refusing to authorize internal Dual-Agent service directory: ${realPathStr}`);
  }
}

function findFilesystemGitRoot(startRealDir) {
  let current = startRealDir;
  const root = path.parse(current).root;
  while (current && current !== root) {
    const gitEntry = path.join(current, ".git");
    if (fs.existsSync(gitEntry)) {
      try {
        return resolveNativeRealpath(current);
      } catch (_) {
        return current;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function queryGitRevParseToplevel(startRealDir) {
  try {
    const res = spawnSync("git", ["-C", startRealDir, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      windowsHide: true,
      shell: false,
      timeout: 4000
    });
    if (res.status !== 0 || !res.stdout) {
      return null;
    }
    const candidate = res.stdout.trim();
    if (!candidate || !fs.existsSync(candidate)) {
      return null;
    }
    const stat = fs.statSync(candidate);
    if (!stat.isDirectory()) {
      return null;
    }
    const realToplevel = resolveNativeRealpath(candidate);
    if (!fs.existsSync(path.join(realToplevel, ".git"))) {
      return null;
    }
    return realToplevel;
  } catch (_) {
    return null;
  }
}

function findGitRoot(startDir) {
  const realStart = resolveNativeRealpath(path.resolve(startDir));
  const normStart = normalizePathKey(realStart);

  const fsRoot = findFilesystemGitRoot(realStart);
  const cliRoot = queryGitRevParseToplevel(realStart);

  const validCandidates = [];
  for (const cand of [fsRoot, cliRoot]) {
    if (!cand) continue;
    try {
      const realCand = resolveNativeRealpath(cand);
      const normCand = normalizePathKey(realCand);
      if (isSubPathOrEqual(normCand, normStart) && fs.existsSync(path.join(realCand, ".git"))) {
        assertNotProtectedDirectory(realCand);
        validCandidates.push({ realPath: realCand, normKey: normCand });
      }
    } catch (_) {}
  }

  if (validCandidates.length === 0) {
    return null;
  }

  validCandidates.sort((a, b) => b.normKey.length - a.normKey.length);
  return validCandidates[0].realPath;
}

function normalizeCanonicalPath(inputPath) {
  if (typeof inputPath !== "string" || !inputPath.trim() || inputPath.includes("\0")) {
    throw new Error("Invalid path string");
  }
  const resolved = path.resolve(inputPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Path does not exist: ${resolved}`);
  }
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    throw new Error(`Path is not a directory: ${resolved}`);
  }
  const real = resolveNativeRealpath(resolved);
  assertNotProtectedDirectory(real);
  return {
    realPath: real,
    normalizedKey: normalizePathKey(real)
  };
}

function loadAuthorizedProjects() {
  if (!fs.existsSync(PROJECTS_FILE)) {
    return [];
  }
  const res = readJsonStrictSync(PROJECTS_FILE, 3);
  if (!res.ok || !res.data || !Array.isArray(res.data.projects)) {
    throw new Error(`Corrupted projects.json: ${res.error || "invalid format"}`);
  }
  return res.data.projects;
}

function verifyAuthorizedProject(candidatePath) {
  const { realPath, normalizedKey } = normalizeCanonicalPath(candidatePath);
  const projects = loadAuthorizedProjects();
  const matches = [];

  for (const entry of projects) {
    if (!entry || typeof entry.projectRoot !== "string") continue;
    try {
      const reg = normalizeCanonicalPath(entry.projectRoot);
      if (isSubPathOrEqual(reg.normalizedKey, normalizedKey)) {
        matches.push({
          entry,
          reg,
          keyLength: reg.normalizedKey.length
        });
      }
    } catch (_) {
      // Skip registered project whose directory no longer exists or is invalid
    }
  }

  if (matches.length === 0) {
    return {
      authorized: false,
      requestedPath: realPath
    };
  }

  // Prefer exact match / most specific (deepest) registered project root
  matches.sort((a, b) => b.keyLength - a.keyLength);
  const best = matches[0];

  // Independent nested Git repository verification:
  // If candidatePath resides inside a nested Git repository deeper than best.reg, that nested repo itself must be registered.
  const detectedGitRoot = findGitRoot(realPath);
  if (detectedGitRoot) {
    const normGitRoot = normalizePathKey(detectedGitRoot);
    if (normGitRoot !== best.reg.normalizedKey && isSubPathOrEqual(best.reg.normalizedKey, normGitRoot)) {
      return {
        authorized: false,
        requestedPath: realPath,
        reason: "UNREGISTERED_NESTED_GIT_REPO"
      };
    }
  }

  // If the project was auto-registered, independently verify it is still a valid Git repository
  if (best.entry.autoRegistered) {
    const regGitRoot = findGitRoot(best.reg.realPath);
    if (!regGitRoot || normalizePathKey(regGitRoot) !== best.reg.normalizedKey) {
      return {
        authorized: false,
        requestedPath: realPath,
        reason: "AUTO_REGISTERED_PROJECT_MISSING_GIT_ROOT"
      };
    }
  }

  return {
    authorized: true,
    projectId: best.entry.projectId || path.basename(best.reg.realPath).toLowerCase(),
    writeAuthorized: best.entry.writeAuthorized === true,
    projectName: best.entry.name || path.basename(best.reg.realPath),
    projectRoot: best.reg.realPath,
    requestedPath: realPath,
    sandbox: best.entry.sandbox || "read-only"
  };
}

function deriveVerifiedLegacyCodexDir(authorizedProjectRoot, mirrorLegacyFlag) {
  if (!mirrorLegacyFlag || !authorizedProjectRoot) return null;
  return path.join(authorizedProjectRoot, ".agents", "codex");
}

function updateGlobalStatus(state, extra = {}) {
  const payload = {
    state,
    timestamp: new Date().toISOString(),
    bridgeInstanceId: BRIDGE_INSTANCE_ID,
    bridgePid: process.pid,
    homeDir: HOME_DIR,
    ...extra
  };
  writeJsonAtomicSync(GLOBAL_STATUS, payload);
  return payload;
}

function resolveDefaultEffort(taskType, retryCount = 0, escalationRound = 0, promptText = "") {
  if (["VERIFY", "REVIEW"].includes(taskType)) return "low";
  if (taskType === "TECHNICAL_DECISION" || retryCount >= 3 || escalationRound >= 2) return "xhigh";
  if (taskType === "TECHNICAL_ESCALATION" || retryCount >= 2 || escalationRound >= 1) return "high";
  const text = typeof promptText === "string" ? promptText.trim() : "";
  if (text && retryCount === 0 && escalationRound === 0) {
    if (/\b(architect\w*|refactor\w*|concurren\w*|deadlock|race\s+condition|security|sandbox|multi-module|migration)\b|架构|重构|并发|死锁|跨模块|安全边界/i.test(text)) return "high";
    if (text.length <= 240 && /\b(typo|comment|doc|docs|readme|format|lint|rename|version|config|gitignore|license)\b|注释|文档|格式|重命名|配置|拼写/i.test(text)) return "low";
  }
  return "medium";
}

function isQuotaOrUnavailableFailure(errorMessage, taskLogFile) {
  let logText = "";
  try {
    if (taskLogFile && fs.existsSync(taskLogFile)) {
      logText = fs.readFileSync(taskLogFile, "utf8").slice(-4000);
    }
  } catch (_) {}
  return /usage limit|rate limit|quota|too many requests|\b429\b|try again at|purchase more credits|service unavailable|connection refused|not logged in|authentication failed/i.test(
    `${errorMessage || ""}\n${logText}`
  );
}

function updateTaskStatus(taskDir, state, extra = {}, verifiedLegacyCodexDir = null, legacyTaskId = null) {
  const meta = readJsonStrictSync(path.join(taskDir, "meta.json"), 2);
  const workflow = {};
  for (const key of ["mode", "taskType", "retryCount", "maxRetries", "escalationRound", "maxEscalationRounds", "sessionId", "effort", "model"]) {
    if (meta.ok && meta.data && Object.prototype.hasOwnProperty.call(meta.data, key)) workflow[key] = meta.data[key];
  }
  extra = { ...workflow, ...extra };
  fs.mkdirSync(taskDir, { recursive: true });
  const statusFile = path.join(taskDir, "status.json");
  const payload = {
    state,
    timestamp: new Date().toISOString(),
    bridgeInstanceId: BRIDGE_INSTANCE_ID,
    bridgePid: process.pid,
    ...extra
  };
  writeJsonAtomicSync(statusFile, payload);

  if (verifiedLegacyCodexDir && fs.existsSync(verifiedLegacyCodexDir)) {
    try {
      const legacyPayload = {
        ...payload,
        taskId: legacyTaskId || payload.taskId
      };
      writeJsonAtomicSync(path.join(verifiedLegacyCodexDir, "status.json"), legacyPayload);
    } catch (_) {}
  }
  return payload;
}

function enterBlockedState(reason, extra = {}) {
  halted = true;
  safeLogLine(`BLOCKED: ${reason}`);
  console.error(`Global Codex Bridge entering BLOCKED state: ${reason}`);
  try {
    updateGlobalStatus("BLOCKED", {
      error: reason,
      ...extra
    });
  } catch (err) {
    safeLogLine(`Failed to write global BLOCKED status: ${err.message}`);
  }
  if (extra && extra.taskId && isValidTaskId(extra.taskId)) {
    try {
      const taskDir = resolveSafeTaskDir(extra.taskId);
      updateTaskStatus(
        taskDir,
        "BLOCKED",
        {
          error: reason,
          ...extra
        },
        extra.verifiedLegacyCodexDir || null,
        extra.legacyTaskId || null
      );
    } catch (_) {}
  }
}

function acquireBridgeLock() {
  const lockPayload = {
    pid: process.pid,
    bridgeInstanceId: BRIDGE_INSTANCE_ID,
    homeDir: HOME_DIR,
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString()
  };

  try {
    writeExclusiveLockFile(LOCK_FILE, lockPayload);
    return;
  } catch (err) {
    if (!err || err.code !== "EEXIST") {
      throw err;
    }
  }

  const existing = readJsonStrictSync(LOCK_FILE, 5);
  if (!existing.exists) {
    writeExclusiveLockFile(LOCK_FILE, lockPayload);
    return;
  }
  if (!existing.ok || !existing.data || !Number.isSafeInteger(existing.data.pid) || !existing.data.bridgeInstanceId) {
    throw new Error("Existing bridge.lock is malformed or unreadable; failing closed.");
  }

  const pidState = checkPidState(existing.data.pid);
  if (pidState !== "DEAD") {
    throw new Error(
      `Another Global Codex Bridge instance is active or indeterminate (pid=${existing.data.pid}, state=${pidState}, instance=${existing.data.bridgeInstanceId}).`
    );
  }

  try {
    writeExclusiveLockFile(LOCK_RECLAIM_FILE, {
      reclaimerPid: process.pid,
      reclaimerInstanceId: BRIDGE_INSTANCE_ID,
      timestamp: new Date().toISOString()
    });
  } catch (reclaimErr) {
    throw new Error(`Concurrent bridge.lock reclaim in progress: ${reclaimErr.message}`);
  }

  try {
    const recheck = readJsonStrictSync(LOCK_FILE, 3);
    if (
      recheck.exists &&
      (!recheck.ok ||
        !recheck.data ||
        recheck.data.pid !== existing.data.pid ||
        recheck.data.bridgeInstanceId !== existing.data.bridgeInstanceId)
    ) {
      throw new Error("bridge.lock changed during reclaim; aborting takeover.");
    }
    if (recheck.exists) {
      fs.unlinkSync(LOCK_FILE);
    }
    writeExclusiveLockFile(LOCK_FILE, lockPayload);
    safeLogLine(`Reclaimed stale bridge.lock from dead PID ${existing.data.pid} (instance ${existing.data.bridgeInstanceId})`);
  } finally {
    try {
      if (fs.existsSync(LOCK_RECLAIM_FILE)) fs.unlinkSync(LOCK_RECLAIM_FILE);
    } catch (_) {}
  }
}

function verifyBridgeLockOwnership() {
  const lockRes = readJsonStrictSync(LOCK_FILE, 3);
  if (!lockRes.exists || !lockRes.ok || !lockRes.data) {
    return false;
  }
  return (
    lockRes.data.pid === process.pid &&
    lockRes.data.bridgeInstanceId === BRIDGE_INSTANCE_ID
  );
}

function releaseBridgeLock() {
  try {
    if (verifyBridgeLockOwnership()) {
      fs.unlinkSync(LOCK_FILE);
    }
  } catch (_) {}
}

function reconcileOnStartup() {
  const globalRes = readJsonStrictSync(GLOBAL_STATUS, 3);
  const claimRes = readJsonStrictSync(CLAIMED_FILE, 3);

  if (globalRes.exists && !globalRes.ok) {
    enterBlockedState(`Startup recovery found corrupted global status.json: ${globalRes.error}`);
    return;
  }

  if (claimRes.exists && !claimRes.ok) {
    enterBlockedState(`Startup recovery found corrupted claimed.json: ${claimRes.error}`);
    return;
  }

  const globalData = globalRes.data;
  const claimData = claimRes.data;

  if (globalData && globalData.state === "BLOCKED") {
    halted = true;
    safeLogLine(`Startup detected existing BLOCKED state: ${globalData.error || "unspecified"}`);
    console.error(`Global Bridge remains BLOCKED: ${globalData.error || "unspecified"}`);
    return;
  }

  if (!claimRes.exists && (!globalData || globalData.state !== "RUNNING")) {
    updateGlobalStatus("IDLE", {
      lastTaskId: globalData ? globalData.lastTaskId || null : null,
      lastState: globalData ? globalData.lastState || null : null
    });
    return;
  }

  const rawTaskId = (claimData && claimData.taskId) || (globalData && globalData.activeTaskId) || null;
  if (!isValidTaskId(rawTaskId)) {
    enterBlockedState(`Startup recovery found invalid or missing taskId in active state: ${String(rawTaskId)}`);
    return;
  }

  const taskId = rawTaskId;
  const taskDir = resolveSafeTaskDir(taskId);
  const taskStatusRes = readJsonStrictSync(path.join(taskDir, "status.json"), 3);

  if (taskStatusRes.exists && !taskStatusRes.ok) {
    enterBlockedState(`Startup recovery found corrupted task status.json for ${taskId}: ${taskStatusRes.error}`, { taskId });
    return;
  }

  const taskStatus = taskStatusRes.data;

  let verifiedLegacyDir = null;
  if (claimData && claimData.mirrorLegacy && claimData.projectRoot) {
    try {
      const auth = verifyAuthorizedProject(claimData.projectRoot);
      if (auth.authorized) {
        verifiedLegacyDir = deriveVerifiedLegacyCodexDir(auth.projectRoot, true);
      }
    } catch (_) {}
  }

  // Case 1: claimed.json exists, and task status is already terminal (DONE or FAILED)
  if (claimRes.exists && taskStatus && (taskStatus.state === "DONE" || taskStatus.state === "FAILED")) {
    if (claimData && claimData.taskId && taskStatus.taskId === claimData.taskId) {
      try {
        fs.unlinkSync(CLAIMED_FILE);
        if (verifiedLegacyDir) {
          const legClaim = path.join(verifiedLegacyDir, "claimed.flag");
          if (fs.existsSync(legClaim)) fs.unlinkSync(legClaim);
        }
        updateGlobalStatus("IDLE", {
          lastTaskId: claimData.taskId,
          lastState: taskStatus.state
        });
        safeLogLine(`Startup recovery finished removing claimed.json for completed task ${claimData.taskId} (${taskStatus.state})`);
        return;
      } catch (err) {
        enterBlockedState(`Failed to remove claimed.json during terminal reconciliation: ${err.message}`, {
          taskId: claimData.taskId
        });
        return;
      }
    } else {
      enterBlockedState("Startup recovery found claimed.json whose taskId does not match terminal task status.json", {
        taskId
      });
      return;
    }
  }

  // Case 2: Interrupted during PREPARING before child process was ever spawned
  const claimPreSpawn =
    claimRes.exists &&
    claimData &&
    claimData.taskId === taskId &&
    claimData.phase === "PREPARING" &&
    claimData.childSpawned === false;

  const taskPreSpawn =
    !taskStatusRes.exists ||
    (taskStatus &&
      taskStatus.state === "RUNNING" &&
      taskStatus.phase === "PREPARING" &&
      taskStatus.childSpawned === false &&
      !taskStatus.childPid);

  if (claimPreSpawn && taskPreSpawn) {
    try {
      updateTaskStatus(
        taskDir,
        "FAILED",
        {
          taskId,
          projectRoot: claimData.projectRoot || null,
          error: "Interrupted before child process spawn during previous Bridge run"
        },
        verifiedLegacyDir,
        claimData.legacyTaskId || null
      );
      fs.unlinkSync(CLAIMED_FILE);
      if (verifiedLegacyDir) {
        const legClaim = path.join(verifiedLegacyDir, "claimed.flag");
        if (fs.existsSync(legClaim)) fs.unlinkSync(legClaim);
      }
      updateGlobalStatus("IDLE", {
        lastTaskId: taskId,
        lastState: "FAILED"
      });
      safeLogLine(`Startup recovery marked pre-spawn task ${taskId} as FAILED.`);
      return;
    } catch (err) {
      enterBlockedState(`Startup recovery failed to mark pre-spawn task ${taskId} as FAILED: ${err.message}`, {
        taskId
      });
      return;
    }
  }

  // Case 3: Conservative policy — interrupted in SPAWNING / EXECUTING or ambiguous RUNNING state
  enterBlockedState(
    "Conservative crash recovery: previous task was interrupted after entering spawn/execution phase and child process tree termination cannot be confirmed",
    {
      taskId,
      projectRoot: (claimData && claimData.projectRoot) || (globalData && globalData.activeProjectRoot) || null,
      previousChildPid: (claimData && claimData.childPid) || (taskStatus && taskStatus.childPid) || null,
      verifiedLegacyCodexDir: verifiedLegacyDir,
      legacyTaskId: claimData ? claimData.legacyTaskId || null : null
    }
  );
}

function terminateChildTreeBounded(child, graceMs) {
  return new Promise(resolve => {
    const pid = child && child.pid;
    if (!pid) {
      resolve({ confirmedDead: true, detail: "No child PID spawned" });
      return;
    }

    let settled = false;
    let childClosed = child.exitCode !== null || child.signalCode !== null;
    let killerDone = false;
    let killerExitCode = null;
    let killerError = null;
    let killerTimedOut = false;
    let killerProc = null;
    let killerTimer = null;

    const finalize = () => {
      if (settled) return;
      settled = true;
      child.removeListener("close", onChildClose);
      if (killerTimer) clearTimeout(killerTimer);

      const pidNowDead = checkPidState(pid) === "DEAD";
      const treeKillSucceeded =
        !killerTimedOut &&
        !killerError &&
        killerExitCode === 0;

      if (treeKillSucceeded && childClosed && pidNowDead) {
        resolve({
          confirmedDead: true,
          detail: `Process tree for PID ${pid} terminated (taskkill exit=${killerExitCode})`
        });
      } else {
        resolve({
          confirmedDead: false,
          detail: `Unconfirmed tree termination for PID ${pid} (taskkillExit=${killerExitCode}, timedOut=${killerTimedOut}, childClosed=${childClosed}, pidDead=${pidNowDead}, err=${killerError ? killerError.message : "none"})`
        });
      }
    };

    const onChildClose = () => {
      childClosed = true;
      if (killerDone) {
        finalize();
      }
    };
    child.once("close", onChildClose);

    try {
      const customTaskkillCmd = process.env.CODEX_BRIDGE_TASKKILL_CMD;
      if (customTaskkillCmd) {
        killerProc = spawn("cmd.exe", ["/d", "/s", "/c", `"${customTaskkillCmd} ${pid}"`], {
          stdio: "ignore",
          windowsVerbatimArguments: true,
          windowsHide: true
        });
      } else if (process.platform === "win32") {
        killerProc = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true
        });
      } else {
        child.kill("SIGKILL");
        killerDone = true;
        killerExitCode = 0;
      }

      if (killerProc) {
        killerProc.once("error", err => {
          killerError = err;
          killerDone = true;
          finalize();
        });
        killerProc.once("close", code => {
          killerExitCode = code;
          killerDone = true;
          if (childClosed) {
            finalize();
          }
        });
      }
    } catch (err) {
      killerError = err;
      killerDone = true;
      finalize();
      return;
    }

    killerTimer = setTimeout(() => {
      killerTimedOut = true;
      if (killerProc && killerProc.exitCode === null) {
        try {
          killerProc.kill("SIGKILL");
        } catch (_) {}
      }
      finalize();
    }, graceMs);

    if (childClosed && killerDone) {
      finalize();
    }
  });
}

// Legacy migration compatibility: scan registered projects for `.agents/codex/pending.flag`
// and enqueue them into the global queue safely under submit.lock with exclusive task directory creation.
function ingestLegacyProjectTriggers() {
  let projects = [];
  try {
    projects = loadAuthorizedProjects();
  } catch (_) {
    return;
  }

  for (const proj of projects) {
    if (!proj || typeof proj.projectRoot !== "string") continue;
    let auth;
    try {
      auth = verifyAuthorizedProject(proj.projectRoot);
    } catch (_) {
      continue;
    }
    if (!auth.authorized) continue;

    const legacyDir = path.join(auth.projectRoot, ".agents", "codex");
    const legacyTrigger = path.join(legacyDir, "pending.flag");
    const legacyClaimed = path.join(legacyDir, "claimed.flag");
    const legacyRequest = path.join(legacyDir, "request.md");

    if (!fs.existsSync(legacyTrigger) || fs.existsSync(legacyClaimed)) {
      continue;
    }

    let lockFd = null;
    try {
      lockFd = acquireSubmitLock(500);
      if (!fs.existsSync(legacyTrigger) || fs.existsSync(legacyClaimed)) {
        continue;
      }

      const legacyStat = fs.statSync(legacyTrigger);
      const triggerMtime = Math.trunc(legacyStat.mtimeMs);
      const prompt = fs.existsSync(legacyRequest) ? fs.readFileSync(legacyRequest, "utf8") : "";
      const rawTrigger = fs.readFileSync(legacyTrigger, "utf8").trim();
      let legacyTaskId = null;
      if (rawTrigger === "pending") {
        const promptHash = crypto.createHash("sha256").update(prompt).digest("hex").slice(0, 8);
        legacyTaskId = `pending-${triggerMtime}-${promptHash}`;
      } else {
        let parsed = null;
        try {
          parsed = JSON.parse(rawTrigger);
        } catch (parseErr) {
          fs.unlinkSync(legacyTrigger);
          writeJsonAtomicSync(path.join(legacyDir, "status.json"), {
            state: "FAILED",
            timestamp: new Date().toISOString(),
            error: `Malformed JSON in legacy pending.flag: ${parseErr.message}`
          });
          continue;
        }
        if (parsed && isValidTaskId(parsed.taskId)) {
          legacyTaskId = parsed.taskId;
        } else {
          fs.unlinkSync(legacyTrigger);
          writeJsonAtomicSync(path.join(legacyDir, "status.json"), {
            state: "FAILED",
            timestamp: new Date().toISOString(),
            error: "Invalid or missing taskId in legacy pending.flag"
          });
          continue;
        }
      }

      // Deterministic globalTaskId namespaced with legacy-<projectId>-<rawTaskId>
      const pairHash = crypto
        .createHash("sha256")
        .update(`${auth.projectId}:${legacyTaskId}`)
        .digest("hex")
        .slice(0, 8);
      const cleanBase = `legacy-${auth.projectId}-${legacyTaskId}`
        .replace(/[^A-Za-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "");
      let globalTaskId = cleanBase.length <= 100 ? cleanBase : `${cleanBase.slice(0, 90)}-${pairHash}`;

      // Check if an earlier completed task already used this globalTaskId; if so, deterministically disambiguate by triggerMtime
      const candidateDir = resolveSafeTaskDir(globalTaskId);
      if (fs.existsSync(candidateDir)) {
        const existingSt = readJsonStrictSync(path.join(candidateDir, "status.json"), 2);
        if (existingSt.exists) {
          globalTaskId = `${cleanBase.slice(0, 75)}-${triggerMtime}-${pairHash}`;
        }
      }

      const taskDir = resolveSafeTaskDir(globalTaskId);
      const pendingManifestPath = path.join(
        PENDING_DIR,
        `${String(triggerMtime).padStart(13, "0")}-${globalTaskId}.json`
      );

      // Crash-idempotency check:
      // 1) If a previous Bridge crashed AFTER publishing pendingManifestPath (or claiming it) but BEFORE renaming pending.flag -> claimed.flag,
      //    complete the rename without creating a duplicate task.
      const pendingAlreadyPublished = fs.existsSync(pendingManifestPath);
      const claimedNow = readJsonStrictSync(CLAIMED_FILE, 2);
      const alreadyClaimedByGlobal =
        claimedNow.exists && claimedNow.ok && claimedNow.data && claimedNow.data.taskId === globalTaskId;
      if (pendingAlreadyPublished || alreadyClaimedByGlobal) {
        fs.renameSync(legacyTrigger, legacyClaimed);
        continue;
      }

      // 2) If a previous Bridge crashed AFTER creating taskDir but BEFORE publishing pendingManifestPath, remove the incomplete taskDir.
      if (fs.existsSync(taskDir)) {
        const partialSt = readJsonStrictSync(path.join(taskDir, "status.json"), 2);
        if (!partialSt.exists) {
          fs.rmSync(taskDir, { recursive: true, force: true });
        }
      }

      let createdTaskDir = false;
      let createdPendingManifest = false;
      try {
        fs.mkdirSync(taskDir); // Exclusive creation (no recursive: true) prevents any collision/overwrite
        createdTaskDir = true;

        writeTextAtomicSync(path.join(taskDir, "request.md"), prompt);

        const manifest = {
          taskId: globalTaskId,
          legacyTaskId,
          projectId: auth.projectId,
          projectRoot: auth.projectRoot,
          submittedAt: new Date().toISOString(),
          mirrorLegacy: true
        };
        writeJsonAtomicSync(path.join(taskDir, "meta.json"), manifest);

        if (process.env.CODEX_TEST_FAIL_LEGACY_INGEST_ONCE === "1" && !global.__codexFailedLegacyIngestOnce) {
          global.__codexFailedLegacyIngestOnce = true;
          throw new Error("Simulated write failure before publishing pending manifest");
        }

        writeJsonAtomicSync(pendingManifestPath, manifest);
        createdPendingManifest = true;

        // Only claim the legacy trigger AFTER the global task and pending manifest are durably written
        fs.renameSync(legacyTrigger, legacyClaimed);
      } catch (ingestWriteErr) {
        if (createdPendingManifest) {
          try {
            if (fs.existsSync(pendingManifestPath)) fs.unlinkSync(pendingManifestPath);
          } catch (_) {}
        }
        if (createdTaskDir) {
          try {
            fs.rmSync(taskDir, { recursive: true, force: true });
          } catch (_) {}
        }
        throw ingestWriteErr;
      }
    } catch (err) {
      safeLogLine(`Failed to ingest legacy trigger from ${legacyDir}: ${err.message}`);
    } finally {
      releaseSubmitLock(lockFd);
    }
  }
}

function getNextPendingFile() {
  if (!fs.existsSync(PENDING_DIR)) return null;
  const files = fs
    .readdirSync(PENDING_DIR)
    .filter(name => name.endsWith(".json") && !name.includes(".tmp."))
    .sort();
  if (files.length === 0) return null;
  return path.join(PENDING_DIR, files[0]);
}

function findPreviousSessionTask(projectRoot, projectId, sessionId, currentTaskId) {
  if (!sessionId) return null;
  const candidates = [];
  for (const entry of fs.readdirSync(TASKS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === currentTaskId || !isValidTaskId(entry.name)) continue;
    const dir = path.join(TASKS_DIR, entry.name);
    const meta = readJsonStrictSync(path.join(dir, "meta.json"), 1);
    const status = readJsonStrictSync(path.join(dir, "status.json"), 1);
    if (!meta.ok || !meta.data || !status.ok || !status.data || status.data.state !== "DONE") continue;
    const previous = meta.data;
    // Session strings alone are not identities: both project fields must match.
    if (previous.taskId !== entry.name || previous.projectId !== projectId ||
        typeof previous.projectRoot !== "string" ||
        normalizePathKey(previous.projectRoot) !== normalizePathKey(projectRoot) ||
        previous.sessionId !== sessionId) continue;
    candidates.push({
      taskId: entry.name,
      taskType: previous.taskType || "REVIEW",
      completedAt: Date.parse(status.data.timestamp) || 0,
      resultFile: path.join(dir, "result.md")
    });
  }
  candidates.sort((a, b) => b.completedAt - a.completedAt || b.taskId.localeCompare(a.taskId));
  for (const candidate of candidates) {
    try {
      return { ...candidate, result: fs.readFileSync(candidate.resultFile, "utf8") };
    } catch (_) {
      // Missing or unreadable historical results do not prevent a new task.
    }
  }
  return null;
}

async function checkTask() {
  if (busy || halted) return;

  ingestLegacyProjectTriggers();

  const nextPendingPath = getNextPendingFile();
  if (!nextPendingPath) return;

  if (!verifyBridgeLockOwnership()) {
    enterBlockedState("Lost ownership of bridge.lock; refusing to claim task");
    return;
  }

  if (fs.existsSync(CLAIMED_FILE)) {
    enterBlockedState("Unexpected claimed.json present while Global Bridge was idle");
    return;
  }

  busy = true;

  let workflow = {};
  let taskId = null;
  let legacyTaskId = null;
  let taskDir = null;
  let projectRoot = null;
  let projectId = "unknown";
  let verifiedLegacyCodexDir = null;
  let childConfirmedStopped = true;
  let statusPublished = false;
  let tempResultFile = null;
  let activeChild = null;
  let taskLogFile = null;
  let projectLogFile = null;

  try {
    let rawManifest = "";
    try {
      rawManifest = fs.readFileSync(nextPendingPath, "utf8");
    } catch (err) {
      if (err && err.code === "ENOENT") {
        busy = false;
        return;
      }
      throw err;
    }

    try {
      fs.renameSync(nextPendingPath, CLAIMED_FILE);
    } catch (err) {
      if (err && err.code === "ENOENT") {
        busy = false;
        return;
      }
      throw new Error(`Failed to atomically claim pending manifest: ${err.message}`);
    }

    let manifest;
    try {
      manifest = JSON.parse(rawManifest);
    } catch (err) {
      throw new Error(`Malformed JSON in pending manifest: ${err.message}`);
    }

    if (!manifest || !isValidTaskId(manifest.taskId)) {
      throw new Error("Invalid or missing taskId in pending manifest");
    }

    taskId = manifest.taskId;
    legacyTaskId = isValidTaskId(manifest.legacyTaskId) ? manifest.legacyTaskId : taskId;
    taskDir = resolveSafeTaskDir(taskId);
    taskLogFile = path.join(taskDir, "task.log");
    fs.mkdirSync(taskDir, { recursive: true });

    const claimRecord = {
      taskId,
      legacyTaskId,
      projectRoot: manifest.projectRoot || null,
      mirrorLegacy: Boolean(manifest.mirrorLegacy),
      bridgeInstanceId: BRIDGE_INSTANCE_ID,
      bridgePid: process.pid,
      phase: "PREPARING",
      childSpawned: false,
      childPid: null,
      claimedAt: new Date().toISOString()
    };
    writeJsonAtomicSync(CLAIMED_FILE, claimRecord);

    updateGlobalStatus("RUNNING", {
      activeTaskId: taskId,
      activeProjectRoot: manifest.projectRoot || null,
      phase: "PREPARING"
    });

    // Note: verifiedLegacyCodexDir is intentionally NOT passed here before projectRoot authorization!
    updateTaskStatus(
      taskDir,
      "RUNNING",
      {
        taskId,
        projectRoot: manifest.projectRoot || null,
        phase: "PREPARING",
        childSpawned: false,
        childPid: null,
        logFile: taskLogFile
      },
      null,
      legacyTaskId
    );

    if (typeof manifest.projectRoot !== "string" || !manifest.projectRoot.trim()) {
      throw new Error("Missing projectRoot in task manifest");
    }

    const authCheck = verifyAuthorizedProject(manifest.projectRoot);
    if (!authCheck.authorized) {
      throw new Error(`Unauthorized or unregistered project path: ${manifest.projectRoot}`);
    }

    const taskMode = manifest.mode === undefined ? "read" : manifest.mode;
    if (!["read", "write"].includes(taskMode)) throw new Error("Invalid task mode");
    if (taskMode === "write" && !authCheck.writeAuthorized) throw new Error(`Write mode is not authorized for project: ${manifest.projectRoot}`);
    const taskType = manifest.taskType || (taskMode === "write" ? "IMPLEMENT" : "REVIEW");
    const retryCount = manifest.retryCount === undefined ? 0 : manifest.retryCount;
    const escalationRound = manifest.escalationRound === undefined ? 0 : manifest.escalationRound;
    const maxRetries = manifest.maxRetries === undefined ? 3 : manifest.maxRetries;
    const maxEscalationRounds = manifest.maxEscalationRounds === undefined ? 2 : manifest.maxEscalationRounds;
    if (!Number.isInteger(retryCount) || !Number.isInteger(maxRetries) || maxRetries < 0 || retryCount < 0 || retryCount > maxRetries) throw new Error("RETRY_LIMIT_EXCEEDED");
    if (!Number.isInteger(escalationRound) || !Number.isInteger(maxEscalationRounds) || maxEscalationRounds < 0 || escalationRound < 0 || escalationRound > maxEscalationRounds) throw new Error("ESCALATION_LIMIT_EXCEEDED");
    if (!["IMPLEMENT", "FIX_REQUEST", "TECHNICAL_ESCALATION", "TECHNICAL_DECISION", "VERIFY", "REVIEW"].includes(taskType)) throw new Error("Invalid task type");
    if (manifest.sessionId != null && (typeof manifest.sessionId !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(manifest.sessionId))) throw new Error("Invalid session ID");
    const reqPreviewPath = path.join(taskDir, "request.md");
    const reqPreview = manifest.effort == null && fs.existsSync(reqPreviewPath) ? fs.readFileSync(reqPreviewPath, "utf8") : "";
    const effort = manifest.effort == null ? resolveDefaultEffort(taskType, retryCount, escalationRound, reqPreview) : manifest.effort;
    if (!["low", "medium", "high", "xhigh", "max", "ultra"].includes(effort)) throw new Error("Invalid effort");
    const model = manifest.model == null ? null : manifest.model;
    if (model !== null && (typeof model !== "string" || !/^[A-Za-z0-9._:-]{1,64}$/.test(model))) throw new Error("Invalid model name");
    workflow = { mode: taskMode, taskType, retryCount, maxRetries, escalationRound, maxEscalationRounds, sessionId: manifest.sessionId || null, effort, model };
    const sandboxFlag = taskMode === "write" ? "workspace-write" : "read-only";

    projectRoot = authCheck.projectRoot;
    projectId = authCheck.projectId;
    projectLogFile = path.join(PROJECT_LOGS_DIR, `${projectId}.log`);
    verifiedLegacyCodexDir = deriveVerifiedLegacyCodexDir(projectRoot, Boolean(manifest.mirrorLegacy));

    // Now that projectRoot is verified, mirror RUNNING status to verifiedLegacyCodexDir if applicable
    if (verifiedLegacyCodexDir) {
      updateTaskStatus(
        taskDir,
        "RUNNING",
        {
          taskId,
          projectRoot,
          phase: "PREPARING",
          childSpawned: false,
          childPid: null,
          logFile: taskLogFile
        },
        verifiedLegacyCodexDir,
        legacyTaskId
      );
    }

    safeLogLine(
      `=== [TASK ${taskId} START project="${projectRoot}"] ===`,
      [taskLogFile, projectLogFile, verifiedLegacyCodexDir ? path.join(verifiedLegacyCodexDir, "bridge.log") : null]
    );

    const requestFile = path.join(taskDir, "request.md");
    if (!fs.existsSync(requestFile)) {
      throw new Error(`Missing request.md for task ${taskId}`);
    }
    const prompt = fs.readFileSync(requestFile, "utf8").trim();
    if (!prompt) {
      throw new Error(`Empty request.md for task ${taskId}`);
    }

    tempResultFile = path.join(taskDir, `result.${taskId}.tmp.md`);
    fs.rmSync(tempResultFile, { force: true });

    // Record SPAWNING phase before calling spawn()
    childConfirmedStopped = false;
    writeJsonAtomicSync(CLAIMED_FILE, {
      ...claimRecord,
      projectRoot,
      phase: "SPAWNING",
      childSpawned: true
    });
    updateTaskStatus(
      taskDir,
      "RUNNING",
      {
        taskId,
        projectRoot,
        phase: "SPAWNING",
        childSpawned: true,
        childPid: null,
        logFile: taskLogFile
      },
      verifiedLegacyCodexDir,
      legacyTaskId
    );

    console.log(`Starting Codex task (${taskId}) in ${projectRoot}...`);

    const customCmd = process.env.CODEX_BRIDGE_CMD;
    const previous = findPreviousSessionTask(projectRoot, projectId, workflow.sessionId, taskId);
    let codexPrompt = prompt;
    if (!customCmd && previous) {
      const header = `[Session Context: sessionId=${workflow.sessionId}, previousTaskId=${previous.taskId}, taskType=${previous.taskType}]\n`;
      const separator = "\n---\n";
      const context = (header + previous.result).slice(0, 1200 - separator.length);
      codexPrompt = context + separator + prompt;
    }
    const modelArg = model ? `-m "${model}" ` : "";
    const command = customCmd
      ? customCmd
      : `codex.cmd -c windows.sandbox=mxc -c model_reasoning_effort="${effort}" ${modelArg}exec ` +
        "-C . " +
        `--sandbox ${sandboxFlag} ` +
        "--ephemeral " +
        `--output-last-message "${tempResultFile}" -`;

    const child = spawn(
      "cmd.exe",
      ["/d", "/s", "/c", `"${command}"`],
      {
        cwd: projectRoot,
        stdio: ["pipe", "pipe", "pipe"],
        windowsVerbatimArguments: true,
        env: {
          ...process.env,
          CODEX_RESULT_FILE: tempResultFile,
          CODEX_TASK_MODE: taskMode,
          CODEX_TASK_TYPE: taskType,
          CODEX_RETRY_COUNT: String(retryCount),
          CODEX_ESCALATION_ROUND: String(escalationRound),
          CODEX_SESSION_ID: workflow.sessionId || "",
          CODEX_PREV_SESSION_TASK_ID: previous ? previous.taskId : "",
          CODEX_REASONING_EFFORT: effort,
          CODEX_MODEL: model || "",
          CODEX_TASK_ID: taskId,
          CODEX_PROJECT_ROOT: projectRoot
        }
      }
    );
    activeChild = child;

    const extraLogs = [
      taskLogFile,
      projectLogFile,
      verifiedLegacyCodexDir ? path.join(verifiedLegacyCodexDir, "bridge.log") : null
    ];

    child.stdout.on("error", err => {
      safeLogLine(`[Task ${taskId} stdout stream error] ${err.message}`, extraLogs);
    });
    child.stderr.on("error", err => {
      safeLogLine(`[Task ${taskId} stderr stream error] ${err.message}`, extraLogs);
    });
    child.stdin.on("error", err => {
      safeLogLine(`[Task ${taskId} stdin stream error] ${err.message}`, extraLogs);
    });

    child.stdout.on("data", data => {
      safeAppendFile(GLOBAL_LOG, data);
      for (const lf of extraLogs) {
        if (lf) safeAppendFile(lf, data);
      }
    });

    child.stderr.on("data", data => {
      safeAppendFile(GLOBAL_LOG, data);
      for (const lf of extraLogs) {
        if (lf) safeAppendFile(lf, data);
      }
    });

    if (child.pid) {
      writeJsonAtomicSync(CLAIMED_FILE, {
        ...claimRecord,
        projectRoot,
        phase: "EXECUTING",
        childSpawned: true,
        childPid: child.pid
      });
      updateTaskStatus(
        taskDir,
        "RUNNING",
        {
          taskId,
          projectRoot,
          phase: "EXECUTING",
          childSpawned: true,
          childPid: child.pid,
          logFile: taskLogFile
        },
        verifiedLegacyCodexDir,
        legacyTaskId
      );
    }

    try {
      child.stdin.end(codexPrompt + "\n");
    } catch (stdinErr) {
      safeLogLine(`[Task ${taskId} stdin end error] ${stdinErr.message}`, extraLogs);
    }

    let timedOut = false;
    let timeoutHandle = null;
    let killPromise = null;

    const closeOutcome = await new Promise((resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        safeLogLine(`[Task ${taskId}] Execution timed out after ${TIMEOUT_MS}ms; terminating process tree...`, extraLogs);
        killPromise = terminateChildTreeBounded(child, KILL_GRACE_MS).then(killRes => {
          resolve({ code: null, signal: "SIGTERM", timedOut: true, killRes });
        });
      }, TIMEOUT_MS);

      child.once("error", err => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        reject(err);
      });

      child.once("close", (code, signal) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (!timedOut) {
          resolve({ code, signal, timedOut: false, killRes: null });
        }
      });
    });

    if (timedOut) {
      const killRes = closeOutcome.killRes || (await killPromise);
      if (!killRes || !killRes.confirmedDead) {
        childConfirmedStopped = false;
        enterBlockedState(
          `Task ${taskId} timed out after ${TIMEOUT_MS}ms and child process tree termination could not be confirmed (${killRes ? killRes.detail : "unknown"})`,
          { taskId, projectRoot, childPid: child.pid || null, verifiedLegacyCodexDir, legacyTaskId }
        );
        return;
      }
      childConfirmedStopped = true;
      throw new Error(`Codex task timed out after ${TIMEOUT_MS}ms`);
    }

    childConfirmedStopped = true;
    const exitCode = closeOutcome.code;

    if (exitCode !== 0 || !fs.existsSync(tempResultFile)) {
      throw new Error(`Codex failed: exit ${exitCode}`);
    }

    const rawResultContent = fs.readFileSync(tempResultFile, "utf8");
    if (!rawResultContent.trim()) {
      throw new Error("Codex produced an empty result file");
    }

    // Strict publication order:
    // 1. Atomic rename of tempResultFile -> queue/tasks/<taskId>/result.md (and verified legacy dir if applicable)
    // 2. Atomic write of task status.json (DONE) and global status.json (IDLE)
    // 3. Remove claimed.json (and legacy claimed.flag if applicable)
    const finalResultFile = path.join(taskDir, "result.md");
    renameWithRetrySync(tempResultFile, finalResultFile);

    if (verifiedLegacyCodexDir && fs.existsSync(verifiedLegacyCodexDir)) {
      try {
        writeTextAtomicSync(path.join(verifiedLegacyCodexDir, `result.${legacyTaskId}.md`), rawResultContent);
        writeTextAtomicSync(path.join(verifiedLegacyCodexDir, "result.md"), rawResultContent);
      } catch (_) {}
    }

    updateTaskStatus(
      taskDir,
      "DONE",
      {
        taskId,
        projectRoot,
        ...workflow,
        protocolStatus: (rawResultContent.match(/\b(IMPLEMENTATION_COMPLETE|TEST_FAILED|FIX_REQUEST|TECHNICAL_ESCALATION|TECHNICAL_DECISION|ACCEPTED|BLOCKED)\b/) || [null, taskMode === "write" ? "IMPLEMENTATION_COMPLETE" : "ACCEPTED"])[1],
        exitCode,
        resultFile: finalResultFile,
        logFile: taskLogFile
      },
      verifiedLegacyCodexDir,
      legacyTaskId
    );
    updateGlobalStatus("IDLE", {
      lastTaskId: taskId,
      lastProjectRoot: projectRoot,
      lastState: "DONE",
      fallbackToGemini: false,
      fallbackReason: null
    });
    statusPublished = true;

    fs.unlinkSync(CLAIMED_FILE);
    if (verifiedLegacyCodexDir) {
      try {
        const legClaim = path.join(verifiedLegacyCodexDir, "claimed.flag");
        if (fs.existsSync(legClaim)) fs.unlinkSync(legClaim);
      } catch (_) {}
    }

    safeLogLine(`=== [TASK ${taskId} DONE exit=${exitCode} project="${projectRoot}"] ===`, extraLogs);
    console.log(`Codex task (${taskId}) finished.`);
  } catch (error) {
    const extraLogs = [
      taskLogFile,
      projectLogFile,
      verifiedLegacyCodexDir ? path.join(verifiedLegacyCodexDir, "bridge.log") : null
    ];
    safeLogLine(`=== [TASK ${taskId || "unassigned"} FAILED: ${error.message}] ===`, extraLogs);
    console.error(error.message);

    if (tempResultFile) {
      try {
        if (fs.existsSync(tempResultFile)) fs.unlinkSync(tempResultFile);
      } catch (_) {}
    }

    if (!childConfirmedStopped && activeChild) {
      const cleanupRes = await terminateChildTreeBounded(activeChild, KILL_GRACE_MS);
      if (cleanupRes && cleanupRes.confirmedDead) {
        childConfirmedStopped = true;
      }
    }

    if (!childConfirmedStopped) {
      enterBlockedState(
        `Task ${taskId || "unassigned"} failed (${error.message}) while child process termination was unconfirmed`,
        {
          taskId,
          projectRoot,
          childPid: activeChild && activeChild.pid ? activeChild.pid : null,
          verifiedLegacyCodexDir,
          legacyTaskId
        }
      );
      return;
    }

    try {
      const fallbackToGemini = isQuotaOrUnavailableFailure(error.message, taskLogFile);
      if (taskDir) {
        updateTaskStatus(
          taskDir,
          "FAILED",
          {
            taskId,
            projectRoot,
            error: error.message,
            fallbackToGemini,
            ...(fallbackToGemini ? { protocolStatus: "FALLBACK_TO_GEMINI", fallbackReason: "CODEX_QUOTA_OR_UNAVAILABLE" } : {}),
            logFile: taskLogFile
          },
          verifiedLegacyCodexDir,
          legacyTaskId
        );
      }
      updateGlobalStatus("IDLE", {
        lastTaskId: taskId,
        lastProjectRoot: projectRoot,
        lastState: "FAILED",
        lastError: error.message,
        fallbackToGemini,
        fallbackReason: fallbackToGemini ? "CODEX_QUOTA_OR_UNAVAILABLE" : null
      });
      statusPublished = true;
    } catch (statusErr) {
      enterBlockedState(
        `Failed to persist FAILED status for task ${taskId || "unassigned"}: ${statusErr.message} (original error: ${error.message})`,
        { taskId, projectRoot, verifiedLegacyCodexDir, legacyTaskId }
      );
      return;
    }

    if (statusPublished && childConfirmedStopped) {
      try {
        if (fs.existsSync(CLAIMED_FILE)) {
          fs.unlinkSync(CLAIMED_FILE);
        }
        if (verifiedLegacyCodexDir) {
          const legClaim = path.join(verifiedLegacyCodexDir, "claimed.flag");
          if (fs.existsSync(legClaim)) fs.unlinkSync(legClaim);
        }
      } catch (unlinkErr) {
        enterBlockedState(
          `Failed to remove claimed.json after task ${taskId || "unassigned"} failure: ${unlinkErr.message}`,
          { taskId, projectRoot, verifiedLegacyCodexDir, legacyTaskId }
        );
        return;
      }
    }
  } finally {
    if (!halted) {
      busy = false;
    }
  }
}

function startBridge() {
  try {
    acquireBridgeLock();
  } catch (err) {
    console.error(`Failed to acquire Global Bridge lock: ${err.message}`);
    process.exit(1);
  }

  const cleanupAndExit = code => {
    if (pollTimer) clearInterval(pollTimer);
    if (!busy && !halted) {
      releaseBridgeLock();
    }
    process.exit(code);
  };

  process.once("SIGINT", () => cleanupAndExit(0));
  process.once("SIGTERM", () => cleanupAndExit(0));
  process.once("exit", () => {
    if (!busy && !halted) {
      releaseBridgeLock();
    }
  });

  reconcileOnStartup();

  console.log("Global Codex Bridge is running.");
  console.log("Home Dir:", HOME_DIR);
  console.log("Instance ID:", BRIDGE_INSTANCE_ID);

  pollTimer = setInterval(() => {
    checkTask().catch(err => {
      enterBlockedState(`Unhandled error in checkTask interval: ${err.message}`);
    });
  }, POLL_MS);

  checkTask().catch(err => {
    enterBlockedState(`Unhandled error in initial checkTask: ${err.message}`);
  });
}

startBridge();
