const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

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

const MAX_FIX_RETRIES = 3;
const MAX_ESCALATION_ROUNDS = 2;
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
  for (const dir of [
    HOME_DIR,
    QUEUE_DIR,
    PENDING_DIR,
    TASKS_DIR,
    path.join(HOME_DIR, "logs"),
    path.join(HOME_DIR, "logs", "projects")
  ]) {
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

function acquireSubmitLock(timeoutMs = 10000) {
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
    throw new Error(`Refusing to use filesystem root as project or trusted directory: ${realPathStr}`);
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
      throw new Error(`Refusing to register or access protected system directory: ${realPathStr}`);
    }
  }

  // Forbid user home directory itself (e.g. C:\Users\Rin) and any ancestor of it (e.g. C:\Users)
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

  // Forbid the Dual-Agent state directory itself
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
        // Ensure the detected Git root is not a protected directory (such as user home or filesystem root)
        assertNotProtectedDirectory(realCand);
        validCandidates.push({ realPath: realCand, normKey: normCand });
      }
    } catch (_) {}
  }

  if (validCandidates.length === 0) {
    return null;
  }

  // Select deepest verified Git root (properly handles nested Git repositories)
  validCandidates.sort((a, b) => b.normKey.length - a.normKey.length);
  return validCandidates[0].realPath;
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
  const real = resolveNativeRealpath(resolved);
  assertNotProtectedDirectory(real);

  const gitRoot = findGitRoot(real);
  const effectiveRoot = useGitRoot && gitRoot ? gitRoot : real;
  assertNotProtectedDirectory(effectiveRoot);

  const normalizedKey = normalizePathKey(effectiveRoot);
  const requestedNormalizedKey = normalizePathKey(real);
  const gitRootNormalizedKey = gitRoot ? normalizePathKey(gitRoot) : null;

  return {
    requestedPath: real,
    requestedNormalizedKey,
    gitRoot,
    gitRootNormalizedKey,
    projectRoot: effectiveRoot,
    normalizedKey
  };
}

function validateTrustedRootPath(inputPath) {
  if (typeof inputPath !== "string" || !inputPath.trim() || inputPath.includes("\0")) {
    throw new Error("Invalid trusted root path");
  }
  const resolved = path.resolve(inputPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Trusted root path does not exist: ${resolved}`);
  }
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    throw new Error(`Trusted root path is not a directory: ${resolved}`);
  }
  const real = resolveNativeRealpath(resolved);
  assertNotProtectedDirectory(real);
  const normalizedKey = normalizePathKey(real);
  return {
    rootPath: real,
    normalizedKey
  };
}

function loadProjectsRegistry() {
  ensureDirs();
  if (!fs.existsSync(PROJECTS_FILE)) {
    return { version: 2, trustedRoots: [], projects: [] };
  }
  const res = readJsonStrictSync(PROJECTS_FILE, 3);
  if (!res.ok || !res.data || !Array.isArray(res.data.projects)) {
    throw new Error(`Corrupted projects.json: ${res.error || "invalid structure"}`);
  }
  if (!Array.isArray(res.data.trustedRoots)) {
    res.data.trustedRoots = [];
  }
  if (!res.data.version || res.data.version < 2) {
    res.data.version = 2;
  }
  return res.data;
}

function findMatchingTrustedRootInRegistry(candidateRealPath, registry) {
  const candidateNorm = normalizePathKey(candidateRealPath);
  const matches = [];

  for (const entry of registry.trustedRoots || []) {
    if (!entry || typeof entry.rootPath !== "string") continue;
    try {
      const validated = validateTrustedRootPath(entry.rootPath);
      if (isSubPathOrEqual(validated.normalizedKey, candidateNorm)) {
        matches.push({
          entry,
          rootPath: validated.rootPath,
          normalizedKey: validated.normalizedKey,
          keyLength: validated.normalizedKey.length
        });
      }
    } catch (_) {}
  }

  if (matches.length === 0) {
    return null;
  }
  matches.sort((a, b) => b.keyLength - a.keyLength);
  return matches[0];
}

function inspectProjectAuthorization(candidatePath, existingRegistry = null) {
  const norm = validateAndNormalizeProjectPath(candidatePath, false);
  const registry = existingRegistry || loadProjectsRegistry();

  // Check if requestedPath is inside any trustedRoot
  const requestedTrustedMatch = findMatchingTrustedRootInRegistry(norm.requestedPath, registry);

  // If a gitRoot was detected, verify whether gitRoot is actually valid for this workspace:
  // If requestedPath is inside a trustedRoot, gitRoot must ALSO be inside that trustedRoot
  // (prevents an accidental .git in an ancestor above trustedRoot from masquerading a plain folder as a Git project).
  let effectiveGitRoot = norm.gitRoot;
  let effectiveGitRootNorm = norm.gitRootNormalizedKey;
  if (
    requestedTrustedMatch &&
    effectiveGitRootNorm &&
    !isSubPathOrEqual(requestedTrustedMatch.normalizedKey, effectiveGitRootNorm)
  ) {
    effectiveGitRoot = null;
    effectiveGitRootNorm = null;
  }

  const regMatches = [];
  for (const entry of registry.projects) {
    if (!entry || typeof entry.projectRoot !== "string") continue;
    try {
      const regNorm = validateAndNormalizeProjectPath(entry.projectRoot, false);
      if (isSubPathOrEqual(regNorm.normalizedKey, norm.requestedNormalizedKey)) {
        regMatches.push({
          entry,
          regNorm,
          keyLength: regNorm.normalizedKey.length
        });
      }
    } catch (_) {}
  }

  if (regMatches.length > 0) {
    regMatches.sort((a, b) => b.keyLength - a.keyLength);
    const best = regMatches[0];

    // Check if candidatePath is inside a deeper, unregistered nested Git repository
    const isUnregisteredNestedGitRepo =
      Boolean(effectiveGitRootNorm) &&
      effectiveGitRootNorm !== best.regNorm.normalizedKey &&
      isSubPathOrEqual(best.regNorm.normalizedKey, effectiveGitRootNorm);

    if (!isUnregisteredNestedGitRepo) {
      return {
        authorized: true,
        registered: true,
        autoRegisterEligible: false,
        status: "REGISTERED",
        entry: best.entry,
        writeAuthorized: Boolean(best.entry && best.entry.writeAuthorized === true),
        projectRoot: best.regNorm.projectRoot,
        requestedPath: norm.requestedPath,
        gitRoot: effectiveGitRoot
      };
    }
  }

  // Project (or nested Git repo) is NOT currently registered in projects.json
  if (!effectiveGitRoot) {
    return {
      writeAuthorized: false,
      authorized: false,
      registered: false,
      autoRegisterEligible: false,
      status: "NEEDS_AUTHORIZATION",
      reason: "NOT_GIT_REPO",
      requestedPath: norm.requestedPath,
      gitRoot: null,
      suggestedRoot: norm.requestedPath
    };
  }

  // Verify both the canonical gitRoot and canonical requestedPath reside inside a trustedRoot
  const gitRootTrustedMatch = findMatchingTrustedRootInRegistry(effectiveGitRoot, registry);
  if (
    gitRootTrustedMatch &&
    requestedTrustedMatch &&
    isSubPathOrEqual(gitRootTrustedMatch.normalizedKey, norm.requestedNormalizedKey)
  ) {
    return {
      authorized: true,
      registered: false,
      autoRegisterEligible: true,
      status: "AUTO_REGISTER_ELIGIBLE",
      writeAuthorized: false,
      reason: "WITHIN_TRUSTED_ROOT",
      trustedRoot: gitRootTrustedMatch.entry,
      projectRoot: effectiveGitRoot,
      requestedPath: norm.requestedPath,
      gitRoot: effectiveGitRoot,
      suggestedRoot: effectiveGitRoot
    };
  }

  return {
    writeAuthorized: false,
    authorized: false,
    registered: false,
    autoRegisterEligible: false,
    status: "NEEDS_AUTHORIZATION",
    reason: "OUTSIDE_TRUSTED_ROOTS",
    requestedPath: norm.requestedPath,
    gitRoot: effectiveGitRoot,
    suggestedRoot: effectiveGitRoot
  };
}

function findMatchingRegisteredProject(candidatePath) {
  return inspectProjectAuthorization(candidatePath);
}

function createProjectRecord(projectRoot, normalizedRoot, gitRoot, customName = null, extra = {}) {
  const baseSlug =
    path
      .basename(projectRoot)
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "project";
  const shortHash = crypto.createHash("sha256").update(normalizedRoot).digest("hex").slice(0, 8);
  const projectId = `${baseSlug}-${shortHash}`;
  const writeAuthorized = !extra.autoRegistered && extra.writeAuthorized === true;

  return {
    projectId,
    name: customName || path.basename(projectRoot),
    projectRoot,
    normalizedRoot,
    gitRoot,
    sandbox: writeAuthorized ? "workspace-write" : "read-only",
    writeAuthorized,
    lastSessionId: extra.lastSessionId || null,
    autoRegistered: Boolean(extra.autoRegistered),
    trustedRoot: extra.trustedRoot || null,
    registeredAt: new Date().toISOString()
  };
}

function registerProject(projectPath, customName = null, exactPath = false, allowWrite = false) {
  const norm = validateAndNormalizeProjectPath(projectPath, !exactPath);
  const lockFd = acquireSubmitLock();
  try {
    const registry = loadProjectsRegistry();
    const existing = registry.projects.find(
      p => p && typeof p.normalizedRoot === "string" && p.normalizedRoot === norm.normalizedKey
    );
    if (existing) {
      if (allowWrite) existing.writeAuthorized = true;
      existing.sandbox = existing.writeAuthorized === true ? "workspace-write" : "read-only";
      existing.lastSessionId = existing.lastSessionId || null;
      writeJsonAtomicSync(PROJECTS_FILE, registry);
      return { status: "ALREADY_REGISTERED", project: existing };
    }

    const newEntry = createProjectRecord(norm.projectRoot, norm.normalizedKey, norm.gitRoot, customName, {
      autoRegistered: false,
      writeAuthorized: allowWrite,
      trustedRoot: null
    });

    registry.projects.push(newEntry);
    writeJsonAtomicSync(PROJECTS_FILE, registry);
    return { status: "REGISTERED", project: newEntry };
  } finally {
    releaseSubmitLock(lockFd);
  }
}

function setProjectWrite(projectPath, authorized) {
  const lockFd = acquireSubmitLock();
  try {
    const registry = loadProjectsRegistry();
    const inspection = inspectProjectAuthorization(projectPath, registry);
    let project = inspection.registered ? inspection.entry : null;
    if (!project) {
      if (!authorized) throw new Error("Project is not registered");
      const norm = validateAndNormalizeProjectPath(projectPath);
      project = createProjectRecord(norm.projectRoot, norm.normalizedKey, norm.gitRoot);
      registry.projects.push(project);
    }
    project.writeAuthorized = authorized;
    project.sandbox = project.writeAuthorized === true ? "workspace-write" : "read-only";
    project.lastSessionId = project.lastSessionId || null;
    writeJsonAtomicSync(PROJECTS_FILE, registry);
    return { status: authorized ? "WRITE_AUTHORIZED" : "WRITE_REVOKED", project };
  } finally { releaseSubmitLock(lockFd); }
}
function authorizeProjectWrite(projectPath) { return setProjectWrite(projectPath, true); }
function revokeProjectWrite(projectPath) { return setProjectWrite(projectPath, false); }

function resolveDefaultEffort(taskType, retryCount = 0, escalationRound = 0) {
  if (["VERIFY", "REVIEW"].includes(taskType)) return "low";
  if (["TECHNICAL_ESCALATION", "TECHNICAL_DECISION"].includes(taskType) || retryCount >= 2 || escalationRound >= 1) return "high";
  return "medium";
}

function workflowOptions({ mode = "read", taskType = mode === "write" ? "IMPLEMENT" : "REVIEW",
  retryCount = 0, maxRetries = MAX_FIX_RETRIES, escalationRound = 0,
  maxEscalationRounds = MAX_ESCALATION_ROUNDS, sessionId = null, effort = undefined, model = null } = {}) {
  if (!["read", "write"].includes(mode)) throw new Error("Invalid mode: expected read or write");
  if (!["IMPLEMENT", "FIX_REQUEST", "TECHNICAL_ESCALATION", "TECHNICAL_DECISION", "VERIFY", "REVIEW"].includes(taskType)) throw new Error("Invalid task type");
  for (const [count, limit, code] of [[retryCount, maxRetries, "RETRY_LIMIT_EXCEEDED"], [escalationRound, maxEscalationRounds, "ESCALATION_LIMIT_EXCEEDED"]]) {
    if (!Number.isInteger(count) || !Number.isInteger(limit) || limit < 0 || count < 0 || count > limit) {
      const err = new Error(code); err.code = code; throw err;
    }
  }
  if (sessionId !== null && (typeof sessionId !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(sessionId))) throw new Error("Invalid session ID");
  const resolvedEffort = effort === undefined || effort === null ? resolveDefaultEffort(taskType, retryCount, escalationRound) : effort;
  if (!["low", "medium", "high"].includes(resolvedEffort)) throw new Error("Invalid effort: expected low, medium, or high");
  if (model !== null && (typeof model !== "string" || !/^[A-Za-z0-9._:-]{1,64}$/.test(model))) throw new Error("Invalid model name");
  return { mode, taskType, retryCount, maxRetries, escalationRound, maxEscalationRounds, sessionId, effort: resolvedEffort, model };
}

function trustRoot(rootPathInput, customName = null) {
  const validated = validateTrustedRootPath(rootPathInput);
  const lockFd = acquireSubmitLock();
  try {
    const registry = loadProjectsRegistry();
    const existing = registry.trustedRoots.find(
      r => r && typeof r.normalizedRoot === "string" && r.normalizedRoot === validated.normalizedKey
    );
    if (existing) {
      return { status: "ALREADY_TRUSTED", trustedRoot: existing };
    }

    const baseSlug =
      path
        .basename(validated.rootPath)
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "") || "workspace";
    const shortHash = crypto.createHash("sha256").update(validated.normalizedKey).digest("hex").slice(0, 8);
    const rootId = `trust-${baseSlug}-${shortHash}`;

    const newRoot = {
      rootId,
      name: customName || path.basename(validated.rootPath),
      rootPath: validated.rootPath,
      normalizedRoot: validated.normalizedKey,
      trustedAt: new Date().toISOString()
    };

    registry.trustedRoots.push(newRoot);
    writeJsonAtomicSync(PROJECTS_FILE, registry);
    return { status: "TRUSTED", trustedRoot: newRoot };
  } finally {
    releaseSubmitLock(lockFd);
  }
}

function listTrustedRoots() {
  const registry = loadProjectsRegistry();
  return {
    version: registry.version,
    trustedRoots: registry.trustedRoots
  };
}

function untrustRoot(rootPathInput, removeExistingProjects = false) {
  if (typeof rootPathInput !== "string" || !rootPathInput.trim() || rootPathInput.includes("\0")) {
    throw new Error("Invalid trusted root path");
  }
  const resolved = path.resolve(rootPathInput);
  let targetNormKey = normalizePathKey(resolved);
  let targetRealPath = resolved;
  if (fs.existsSync(resolved)) {
    try {
      targetRealPath = resolveNativeRealpath(resolved);
      targetNormKey = normalizePathKey(targetRealPath);
    } catch (_) {}
  }

  const lockFd = acquireSubmitLock();
  try {
    const registry = loadProjectsRegistry();
    const idx = registry.trustedRoots.findIndex(
      r => r && typeof r.normalizedRoot === "string" && r.normalizedRoot === targetNormKey
    );
    if (idx === -1) {
      return {
        status: "NOT_FOUND",
        requestedPath: targetRealPath,
        removedTrustedRoot: null,
        removedProjects: [],
        retainedProjects: []
      };
    }

    const [removedRoot] = registry.trustedRoots.splice(idx, 1);
    const removedProjects = [];
    const retainedProjects = [];

    if (removeExistingProjects) {
      registry.projects = registry.projects.filter(proj => {
        if (!proj || typeof proj.normalizedRoot !== "string") return true;
        if (isSubPathOrEqual(targetNormKey, proj.normalizedRoot)) {
          removedProjects.push(proj);
          return false;
        }
        return true;
      });
    } else {
      for (const proj of registry.projects) {
        if (proj && typeof proj.normalizedRoot === "string" && isSubPathOrEqual(targetNormKey, proj.normalizedRoot)) {
          retainedProjects.push(proj);
        }
      }
    }

    writeJsonAtomicSync(PROJECTS_FILE, registry);
    return {
      status: "UNTRUSTED",
      removedTrustedRoot: removedRoot,
      removedProjects,
      retainedProjects,
      existingProjectsPolicy: removeExistingProjects
        ? "All registered projects under the revoked trusted root were also removed (--remove-projects)."
        : "Future auto-registration under this root is disabled. Already-registered projects remain authorized unless removed via --remove-projects."
    };
  } finally {
    releaseSubmitLock(lockFd);
  }
}

function submitTask({ projectPath, promptText, customTaskId = null, reuseSession = false, ...options }) {
  const workflow = workflowOptions(options);
  if (typeof promptText !== "string" || !promptText.trim()) {
    throw new Error("Task prompt cannot be empty");
  }

  const lockFd = acquireSubmitLock();
  try {
    const registry = loadProjectsRegistry();
    const inspection = inspectProjectAuthorization(projectPath, registry);

    if (!inspection.authorized) {
      const reasonDetail =
        inspection.reason === "NOT_GIT_REPO"
          ? `Path "${inspection.requestedPath}" is not a Git repository and cannot be auto-registered. Initialize Git or ask the user for manual registration approval.`
          : `Git project "${inspection.suggestedRoot}" (requested "${inspection.requestedPath}") is not registered in ${PROJECTS_FILE} and is outside all trusted roots. Ask user for approval before registering "${inspection.suggestedRoot}" or trusting its parent workspace.`;
      const err = new Error(`PROJECT_NOT_REGISTERED (${inspection.reason || "UNAUTHORIZED"}): ${reasonDetail}`);
      err.code = "PROJECT_NOT_REGISTERED";
      err.reason = inspection.reason || "UNAUTHORIZED";
      throw err;
    }

    const globalSt = readJsonStrictSync(GLOBAL_STATUS, 3);
    if (globalSt.exists && !globalSt.ok) {
      throw new Error(`Global status.json is corrupted: ${globalSt.error}`);
    }
    if (globalSt.data && globalSt.data.state === "BLOCKED") {
      const err = new Error(`BRIDGE_BLOCKED: Global Bridge is in BLOCKED state: ${globalSt.data.error}`);
      err.code = "BRIDGE_BLOCKED";
      throw err;
    }

    let projectEntry = inspection.entry || null;
    let autoRegisteredNow = false;

    if (!inspection.registered && inspection.autoRegisterEligible) {
      const normRootKey = normalizePathKey(inspection.projectRoot);
      const existingEntry = registry.projects.find(
        p => p && typeof p.normalizedRoot === "string" && p.normalizedRoot === normRootKey
      );
      if (existingEntry) {
        projectEntry = existingEntry;
      } else {
        projectEntry = createProjectRecord(
          inspection.projectRoot,
          normRootKey,
          inspection.gitRoot,
          path.basename(inspection.projectRoot),
          {
            autoRegistered: true,
            trustedRoot: inspection.trustedRoot ? inspection.trustedRoot.rootPath : null
          }
        );
        registry.projects.push(projectEntry);
        writeJsonAtomicSync(PROJECTS_FILE, registry);
        autoRegisteredNow = true;
      }
    }

    if (workflow.mode === "write" && projectEntry.writeAuthorized !== true) {
      const err = new Error("WRITE_NOT_AUTHORIZED"); err.code = "WRITE_NOT_AUTHORIZED"; throw err;
    }
    const taskId = customTaskId || `task-${Date.now()}-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const taskDir = resolveSafeTaskDir(taskId);
    if (fs.existsSync(taskDir)) {
      throw new Error(`Task ID collision or duplicate submission: ${taskId} already exists`);
    }

    if (reuseSession && workflow.sessionId === null) {
      workflow.sessionId = projectEntry.lastSessionId || `${projectEntry.projectId}-s-${Date.now()}`;
      workflowOptions(workflow); // Validate persisted IDs before publishing a task.
    }
    if (workflow.sessionId !== null) {
      projectEntry.lastSessionId = workflow.sessionId;
      writeJsonAtomicSync(PROJECTS_FILE, registry);
    }

    // Exclusive directory creation (no recursive: true) guarantees no task overwrite
    fs.mkdirSync(taskDir);
    const requestFile = path.join(taskDir, "request.md");
    const statusFile = path.join(taskDir, "status.json");
    const metaFile = path.join(taskDir, "meta.json");

    const nowIso = new Date().toISOString();
    const manifest = {
      taskId,
      projectId: projectEntry.projectId,
      projectRoot: inspection.projectRoot,
      requestedPath: inspection.requestedPath,
      autoRegistered: autoRegisteredNow || Boolean(projectEntry.autoRegistered),
      ...workflow,
      submittedAt: nowIso
    };

    writeTextAtomicSync(requestFile, promptText);
    writeJsonAtomicSync(metaFile, manifest);
    writeJsonAtomicSync(statusFile, {
      ...workflow,
      state: "QUEUED",
      taskId,
      projectRoot: inspection.projectRoot,
      timestamp: nowIso
    });

    const pendingFile = path.join(PENDING_DIR, `${Date.now()}-${++tmpSeq}-${taskId}.json`);
    writeJsonAtomicSync(pendingFile, manifest);

    return {
      status: "SUBMITTED",
      taskId,
      projectId: projectEntry.projectId,
      projectRoot: inspection.projectRoot,
      autoRegistered: autoRegisteredNow,
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
            const isQuotaOrUnavailable =
              st.fallbackToGemini === true ||
              st.protocolStatus === "FALLBACK_TO_GEMINI" ||
              /usage limit|rate limit|quota|too many requests|\b429\b|try again at|purchase more credits|service unavailable|connection refused/i.test(
                `${st.error || ""}\n${logTail}`
              );
            const prefix = isQuotaOrUnavailable ? "[STATUS: FALLBACK_TO_GEMINI] " : "";
            const err = new Error(
              `${prefix}Codex task (${taskId}) FAILED: ${st.error}${logTail ? `\n--- Task Log Tail ---\n${logTail}` : ""}`
            );
            err.code = isQuotaOrUnavailable ? "FALLBACK_TO_GEMINI" : "TASK_FAILED";
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

function clearFallbackStatus() {
  const lockFd = acquireSubmitLock();
  try {
    const globalRes = readJsonStrictSync(GLOBAL_STATUS, 2);
    if (globalRes.exists && globalRes.ok && globalRes.data) {
      const updated = {
        ...globalRes.data,
        fallbackToGemini: false,
        fallbackReason: null,
        timestamp: new Date().toISOString()
      };
      writeJsonAtomicSync(GLOBAL_STATUS, updated);
      return { status: "FALLBACK_CLEARED", globalStatus: updated };
    }
    return { status: "FALLBACK_CLEARED", globalStatus: null };
  } finally {
    releaseSubmitLock(lockFd);
  }
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
    if (cmd === "trust-root") {
      const rootPath = args.path || args.project || args._[1];
      if (!rootPath || typeof rootPath !== "string") {
        throw new Error("Usage: node client.cjs trust-root --path <directory>");
      }
      const res = trustRoot(rootPath, args.name || null);
      console.log(JSON.stringify(res, null, 2));
      return;
    }

    if (cmd === "list-trusted-roots") {
      const res = listTrustedRoots();
      console.log(JSON.stringify(res, null, 2));
      return;
    }

    if (cmd === "untrust-root") {
      const rootPath = args.path || args.project || args._[1];
      if (!rootPath || typeof rootPath !== "string") {
        throw new Error("Usage: node client.cjs untrust-root --path <directory> [--remove-projects]");
      }
      const res = untrustRoot(rootPath, Boolean(args["remove-projects"]));
      console.log(JSON.stringify(res, null, 2));
      return;
    }

    if (cmd === "authorize-write" || cmd === "revoke-write") {
      const projectPath = args.project || args.path || process.cwd();
      console.log(JSON.stringify(cmd === "authorize-write" ? authorizeProjectWrite(projectPath) : revokeProjectWrite(projectPath), null, 2));
      return;
    }
    if (cmd === "register") {
      const projectPath = args.project || args.path || process.cwd();
      const res = registerProject(projectPath, args.name || null, Boolean(args.exact), Boolean(args["allow-write"]));
      console.log(JSON.stringify(res, null, 2));
      return;
    }

    if (cmd === "list") {
      const reg = loadProjectsRegistry();
      console.log(JSON.stringify(reg, null, 2));
      return;
    }

    if (cmd === "check-project") {
      const projectPath = args.project || args.path || process.cwd();
      const mode = args.mode === undefined ? "read" : args.mode;
      workflowOptions({ mode });
      const res = inspectProjectAuthorization(projectPath);
      res.writeAuthorized = Boolean(res.entry && res.entry.writeAuthorized === true);
      console.log(JSON.stringify(res, null, 2));
      if (mode === "write" && !res.writeAuthorized) process.exit(4);
      if (!res.authorized) {
        process.exit(2);
      }
      return;
    }

    if (cmd === "submit") {
      const projectPath = args.project || args.path || process.cwd();
      const promptText = readPromptFromArgs(args);
      const res = submitTask({
        projectPath,
        promptText,
        mode: args.mode,
        taskType: args["task-type"],
        retryCount: args["retry-count"] === undefined ? 0 : Number(args["retry-count"]),
        maxRetries: args["max-retries"] === undefined ? MAX_FIX_RETRIES : Number(args["max-retries"]),
        escalationRound: args["escalation-round"] === undefined ? 0 : Number(args["escalation-round"]),
        maxEscalationRounds: args["max-escalation-rounds"] === undefined ? MAX_ESCALATION_ROUNDS : Number(args["max-escalation-rounds"]),
        sessionId: args["session-id"] === undefined ? null : args["session-id"],
        effort: typeof args.effort === "string" ? args.effort : undefined,
        model: typeof args.model === "string" ? args.model : null,
        reuseSession: Boolean(args["reuse-session"]),
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
      const projectPath = args.project || args.path || process.cwd();
      const promptText = readPromptFromArgs(args);
      const timeoutMs = args["timeout-ms"] ? Number.parseInt(args["timeout-ms"], 10) : 320000;
      const intervalMs = args["interval-ms"] ? Number.parseInt(args["interval-ms"], 10) : 1000;
      const sub = submitTask({
        projectPath,
        promptText,
        mode: args.mode,
        taskType: args["task-type"],
        retryCount: args["retry-count"] === undefined ? 0 : Number(args["retry-count"]),
        maxRetries: args["max-retries"] === undefined ? MAX_FIX_RETRIES : Number(args["max-retries"]),
        escalationRound: args["escalation-round"] === undefined ? 0 : Number(args["escalation-round"]),
        maxEscalationRounds: args["max-escalation-rounds"] === undefined ? MAX_ESCALATION_ROUNDS : Number(args["max-escalation-rounds"]),
        sessionId: args["session-id"] === undefined ? null : args["session-id"],
        effort: typeof args.effort === "string" ? args.effort : undefined,
        model: typeof args.model === "string" ? args.model : null,
        reuseSession: Boolean(args["reuse-session"]),
        customTaskId: typeof args["task-id"] === "string" ? args["task-id"] : null
      });
      console.error(
        `SUBMITTED_TASK_ID=${sub.taskId} PROJECT_ROOT=${sub.projectRoot} AUTO_REGISTERED=${Boolean(sub.autoRegistered)}`
      );
      const res = await pollTask({
        taskId: sub.taskId,
        timeoutMs,
        intervalMs
      });
      process.stdout.write(res.result);
      return;
    }

    if (cmd === "clear-fallback") {
      console.log(JSON.stringify(clearFallbackStatus(), null, 2));
      return;
    }

    if (cmd === "status") {
      const info = getBridgeStatus(typeof args["task-id"] === "string" ? args["task-id"] : null);
      console.log(JSON.stringify(info, null, 2));
      return;
    }

    console.error(
      "Usage: node client.cjs <trust-root|list-trusted-roots|untrust-root|register|authorize-write|revoke-write|list|check-project|submit|poll|run|status|clear-fallback> [--path <dir>|--project <dir>] [--prompt <text>|--prompt-file <file>|--stdin] [--task-id <id>] [--effort low|medium|high] [--model <name>]"
    );
    process.exit(1);
  } catch (err) {
    console.error(err.message);
    if (err.code === "PROJECT_NOT_REGISTERED") process.exit(2);
    if (err.code === "BRIDGE_BLOCKED") process.exit(3);
    if (err.code === "WRITE_NOT_AUTHORIZED") process.exit(4);
    if (err.code === "RETRY_LIMIT_EXCEEDED") process.exit(5);
    if (err.code === "ESCALATION_LIMIT_EXCEEDED") process.exit(6);
    if (err.code === "FALLBACK_TO_GEMINI") process.exit(7);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  authorizeProjectWrite, revokeProjectWrite, clearFallbackStatus, resolveDefaultEffort, MAX_FIX_RETRIES, MAX_ESCALATION_ROUNDS,
  HOME_DIR,
  PROJECTS_FILE,
  isValidTaskId,
  resolveSafeTaskDir,
  validateAndNormalizeProjectPath,
  validateTrustedRootPath,
  inspectProjectAuthorization,
  findMatchingRegisteredProject,
  registerProject,
  trustRoot,
  listTrustedRoots,
  untrustRoot,
  loadProjectsRegistry,
  submitTask,
  pollTask,
  getBridgeStatus
};
