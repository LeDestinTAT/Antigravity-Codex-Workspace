const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const ROOT = __dirname;
const DIR = process.env.CODEX_BRIDGE_DIR
  ? path.resolve(process.env.CODEX_BRIDGE_DIR)
  : path.join(ROOT, ".agents", "codex");

const REQUEST = path.join(DIR, "request.md");
const TRIGGER = path.join(DIR, "pending.flag");
const CLAIMED = path.join(DIR, "claimed.flag");
const RESULT = path.join(DIR, "result.md");
const STATUS = path.join(DIR, "status.json");
const LOG = path.join(DIR, "bridge.log");
const LOCK = path.join(DIR, "bridge.lock");
const LOCK_RECLAIM = path.join(DIR, "bridge.lock.reclaim");

function parsePositiveInt(envVal, fallback, minVal = 50) {
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
const TASK_ID_REGEX = /^[A-Za-z0-9._-]{1,128}$/;

fs.mkdirSync(DIR, { recursive: true });

let busy = false;
let halted = false;
let tmpSeq = 0;
let pollTimer = null;

const SLEEP_ARRAY = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms) {
  Atomics.wait(SLEEP_ARRAY, 0, 0, ms);
}

function safeLog(message) {
  try {
    const buf = Buffer.isBuffer(message) ? message : Buffer.from(String(message), "utf8");
    fs.appendFileSync(LOG, buf);
  } catch (err) {
    console.error("[Bridge Log Error]", err.message);
  }
}

function safeLogLine(line) {
  safeLog(`${new Date().toISOString()} [Bridge ${BRIDGE_INSTANCE_ID.slice(0, 8)}] ${line}\n`);
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
  } catch (_) {
    // Ignore cleanup error on failed temp file
  }
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

function pruneOldTaskResults(keepCount = 5) {
  try {
    const entries = fs
      .readdirSync(DIR)
      .filter(name => /^result\..+\.md$/.test(name) && !name.endsWith(".tmp.md"))
      .map(name => {
        const fullPath = path.join(DIR, name);
        const stat = fs.statSync(fullPath);
        return { fullPath, mtimeMs: stat.mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    for (const oldEntry of entries.slice(keepCount)) {
      try {
        fs.unlinkSync(oldEntry.fullPath);
      } catch (_) {}
    }
  } catch (_) {}
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

function updateStatus(state, extra = {}) {
  const payload = {
    state,
    timestamp: new Date().toISOString(),
    bridgeInstanceId: BRIDGE_INSTANCE_ID,
    bridgePid: process.pid,
    ...extra
  };
  writeJsonAtomicSync(STATUS, payload);
  return payload;
}

function enterBlockedState(reason, extra = {}) {
  halted = true;
  safeLogLine(`BLOCKED: ${reason}`);
  console.error(`Bridge entering BLOCKED state: ${reason}`);
  try {
    updateStatus("BLOCKED", {
      error: reason,
      ...extra
    });
  } catch (err) {
    safeLogLine(`Failed to write BLOCKED status: ${err.message}`);
    console.error(`Failed to write BLOCKED status: ${err.message}`);
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

function acquireBridgeLock() {
  const lockPayload = {
    pid: process.pid,
    bridgeInstanceId: BRIDGE_INSTANCE_ID,
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString()
  };

  try {
    writeExclusiveLockFile(LOCK, lockPayload);
    return;
  } catch (err) {
    if (!err || err.code !== "EEXIST") {
      throw err;
    }
  }

  const existing = readJsonStrictSync(LOCK, 5);
  if (!existing.exists) {
    writeExclusiveLockFile(LOCK, lockPayload);
    return;
  }
  if (!existing.ok || !existing.data || !Number.isSafeInteger(existing.data.pid) || !existing.data.bridgeInstanceId) {
    throw new Error("Existing bridge.lock is malformed or unreadable; failing closed.");
  }

  const pidState = checkPidState(existing.data.pid);
  if (pidState !== "DEAD") {
    throw new Error(
      `Another Codex Bridge instance is active or indeterminate (pid=${existing.data.pid}, state=${pidState}, instance=${existing.data.bridgeInstanceId}).`
    );
  }

  // Acquire exclusive reclaim lock so two starters cannot simultaneously reclaim the same stale lock
  try {
    writeExclusiveLockFile(LOCK_RECLAIM, {
      reclaimerPid: process.pid,
      reclaimerInstanceId: BRIDGE_INSTANCE_ID,
      timestamp: new Date().toISOString()
    });
  } catch (reclaimErr) {
    throw new Error(`Concurrent bridge.lock reclaim in progress: ${reclaimErr.message}`);
  }

  try {
    const recheck = readJsonStrictSync(LOCK, 3);
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
      fs.unlinkSync(LOCK);
    }
    writeExclusiveLockFile(LOCK, lockPayload);
    safeLogLine(`Reclaimed stale bridge.lock from dead PID ${existing.data.pid} (instance ${existing.data.bridgeInstanceId})`);
  } finally {
    try {
      if (fs.existsSync(LOCK_RECLAIM)) fs.unlinkSync(LOCK_RECLAIM);
    } catch (_) {}
  }
}

function verifyBridgeLockOwnership() {
  const lockRes = readJsonStrictSync(LOCK, 3);
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
      fs.unlinkSync(LOCK);
    }
  } catch (_) {}
}

function reconcileOnStartup() {
  const statusRes = readJsonStrictSync(STATUS, 3);
  const claimRes = readJsonStrictSync(CLAIMED, 3);

  if (statusRes.exists && !statusRes.ok) {
    enterBlockedState(`Startup recovery found corrupted status.json: ${statusRes.error}`);
    return;
  }

  if (claimRes.exists && !claimRes.ok) {
    enterBlockedState(`Startup recovery found corrupted claimed.flag: ${claimRes.error}`);
    return;
  }

  const statusData = statusRes.data;
  const claimData = claimRes.data;

  if (statusData && statusData.state === "BLOCKED") {
    halted = true;
    safeLogLine(`Startup detected existing BLOCKED state: ${statusData.error || "unspecified"}`);
    console.error(`Bridge remains BLOCKED from previous state: ${statusData.error || "unspecified"}`);
    return;
  }

  if (!claimRes.exists && (!statusData || statusData.state === "DONE" || statusData.state === "FAILED")) {
    return;
  }

  // Case 1: claimed.flag exists, and status.json is already terminal (DONE or FAILED)
  if (claimRes.exists && statusData && (statusData.state === "DONE" || statusData.state === "FAILED")) {
    if (claimData && claimData.taskId && statusData.taskId === claimData.taskId) {
      try {
        fs.unlinkSync(CLAIMED);
        safeLogLine(`Startup recovery finished removing claimed.flag for completed task ${claimData.taskId} (${statusData.state})`);
        return;
      } catch (err) {
        enterBlockedState(`Failed to remove claimed.flag during terminal reconciliation: ${err.message}`, {
          taskId: claimData.taskId
        });
        return;
      }
    } else {
      enterBlockedState(
        "Startup recovery found claimed.flag whose taskId does not match terminal status.json",
        {
          claimedTaskId: claimData ? claimData.taskId : null,
          statusTaskId: statusData ? statusData.taskId : null
        }
      );
      return;
    }
  }

  // Case 2: Interrupted during PREPARING before child process was ever spawned
  const claimPreSpawn =
    claimRes.exists &&
    claimData &&
    claimData.taskId &&
    claimData.phase === "PREPARING" &&
    claimData.childSpawned === false;

  const statusMatchesPreSpawn =
    !statusRes.exists ||
    (statusData &&
      statusData.state === "RUNNING" &&
      statusData.taskId === claimData.taskId &&
      statusData.childSpawned === false &&
      !statusData.childPid);

  const statusOnlyPreSpawn =
    !claimRes.exists &&
    statusData &&
    statusData.state === "RUNNING" &&
    statusData.taskId &&
    statusData.phase === "PREPARING" &&
    statusData.childSpawned === false &&
    !statusData.childPid;

  if ((claimPreSpawn && statusMatchesPreSpawn) || statusOnlyPreSpawn) {
    const recoveredTaskId = claimPreSpawn ? claimData.taskId : statusData.taskId;
    try {
      updateStatus("FAILED", {
        taskId: recoveredTaskId,
        error: "Interrupted before child process spawn during previous Bridge run"
      });
      if (claimRes.exists) {
        fs.unlinkSync(CLAIMED);
      }
      safeLogLine(`Startup recovery marked pre-spawn task ${recoveredTaskId} as FAILED.`);
      return;
    } catch (err) {
      enterBlockedState(`Startup recovery failed to persist FAILED status for pre-spawn task ${recoveredTaskId}: ${err.message}`, {
        taskId: recoveredTaskId
      });
      return;
    }
  }

  // Case 3: Conservative policy — task was in SPAWNING/EXECUTING (or legacy RUNNING / ambiguous state).
  // Cannot deterministically prove old Codex child process and its descendant process tree have exited.
  const orphanTaskId =
    (statusData && statusData.taskId) ||
    (claimData && claimData.taskId) ||
    null;
  const orphanChildPid =
    (statusData && statusData.childPid) ||
    (claimData && claimData.childPid) ||
    null;

  enterBlockedState(
    "Conservative crash recovery: previous task was interrupted after entering spawn/execution phase and child process tree termination cannot be confirmed",
    {
      taskId: orphanTaskId,
      previousChildPid: orphanChildPid,
      previousState: statusData ? statusData.state : "CLAIMED_WITHOUT_STATUS"
    }
  );
}

function parseTriggerPayload(rawTrigger) {
  const trimmed = String(rawTrigger || "").trim();
  if (!trimmed) {
    throw new Error("Empty pending.flag trigger file");
  }
  if (trimmed === "pending") {
    return {
      taskId: `legacy-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
      legacy: true
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(`Malformed JSON in pending.flag: ${err.message}`);
  }
  if (!parsed || typeof parsed !== "object" || typeof parsed.taskId !== "string" || !TASK_ID_REGEX.test(parsed.taskId)) {
    throw new Error("Invalid or missing taskId in pending.flag");
  }
  return {
    taskId: parsed.taskId,
    legacy: false
  };
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
      // Process tree termination requires:
      // 1. taskkill completed without timeout or spawn error
      // 2. taskkill exited with 0 (confirming tree traversal and termination)
      // 3. Root child process closed and its PID is confirmed dead
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

async function checkTask() {
  if (busy || halted) return;
  if (!fs.existsSync(TRIGGER)) return;

  if (!verifyBridgeLockOwnership()) {
    enterBlockedState("Lost ownership of bridge.lock; refusing to claim task");
    return;
  }

  if (fs.existsSync(CLAIMED)) {
    enterBlockedState("Unexpected claimed.flag present while Bridge was idle");
    return;
  }

  busy = true;

  let taskId = null;
  let childConfirmedStopped = true;
  let statusPublished = false;
  let tempResultFile = null;
  let activeChild = null;

  try {
    let rawTrigger = "";
    try {
      rawTrigger = fs.readFileSync(TRIGGER, "utf8");
    } catch (err) {
      if (err && err.code === "ENOENT") {
        busy = false;
        return;
      }
      throw err;
    }

    try {
      fs.renameSync(TRIGGER, CLAIMED);
    } catch (err) {
      if (err && err.code === "ENOENT") {
        busy = false;
        return;
      }
      throw new Error(`Failed to atomically claim pending.flag: ${err.message}`);
    }

    // Parse trigger and immediately persist structured PREPARING state before spawning
    const triggerInfo = parseTriggerPayload(rawTrigger);
    taskId = triggerInfo.taskId;

    const claimRecord = {
      taskId,
      bridgeInstanceId: BRIDGE_INSTANCE_ID,
      bridgePid: process.pid,
      phase: "PREPARING",
      childSpawned: false,
      childPid: null,
      claimedAt: new Date().toISOString()
    };
    writeJsonAtomicSync(CLAIMED, claimRecord);

    updateStatus("RUNNING", {
      taskId,
      phase: "PREPARING",
      childSpawned: false,
      childPid: null
    });

    safeLogLine(`=== [TASK ${taskId} START] ===`);

    if (!fs.existsSync(REQUEST)) {
      throw new Error("Missing request.md");
    }
    const prompt = fs.readFileSync(REQUEST, "utf8").trim();
    if (!prompt) {
      throw new Error("Empty task in request.md");
    }

    tempResultFile = path.join(DIR, `result.${taskId}.tmp.md`);
    fs.rmSync(tempResultFile, { force: true });

    // Record SPAWNING phase before calling spawn() so crash recovery knows a child may exist
    childConfirmedStopped = false;
    writeJsonAtomicSync(CLAIMED, {
      ...claimRecord,
      phase: "SPAWNING",
      childSpawned: true
    });
    updateStatus("RUNNING", {
      taskId,
      phase: "SPAWNING",
      childSpawned: true,
      childPid: null
    });

    console.log(`Starting Codex task (${taskId})...`);

    const customCmd = process.env.CODEX_BRIDGE_CMD;
    const command = customCmd
      ? customCmd
      : "codex.cmd -c windows.sandbox=mxc exec " +
        "-C . " +
        "--sandbox read-only " +
        "--ephemeral " +
        `--output-last-message "${tempResultFile}" -`;

    const child = spawn(
      "cmd.exe",
      ["/d", "/s", "/c", `"${command}"`],
      {
        cwd: ROOT,
        stdio: ["pipe", "pipe", "pipe"],
        windowsVerbatimArguments: true,
        env: {
          ...process.env,
          CODEX_RESULT_FILE: tempResultFile,
          CODEX_TASK_ID: taskId
        }
      }
    );
    activeChild = child;

    // Install stream listeners immediately after spawn() before any disk I/O
    child.stdout.on("error", err => {
      safeLogLine(`[Task ${taskId} stdout stream error] ${err.message}`);
    });
    child.stderr.on("error", err => {
      safeLogLine(`[Task ${taskId} stderr stream error] ${err.message}`);
    });
    child.stdin.on("error", err => {
      safeLogLine(`[Task ${taskId} stdin stream error] ${err.message}`);
    });

    child.stdout.on("data", data => {
      safeLog(data);
    });

    child.stderr.on("data", data => {
      safeLog(data);
    });

    if (child.pid) {
      writeJsonAtomicSync(CLAIMED, {
        ...claimRecord,
        phase: "EXECUTING",
        childSpawned: true,
        childPid: child.pid
      });
      updateStatus("RUNNING", {
        taskId,
        phase: "EXECUTING",
        childSpawned: true,
        childPid: child.pid
      });
    }

    try {
      child.stdin.end(prompt + "\n");
    } catch (stdinErr) {
      safeLogLine(`[Task ${taskId} stdin end error] ${stdinErr.message}`);
    }

    let timedOut = false;
    let timeoutHandle = null;
    let killPromise = null;

    const closeOutcome = await new Promise((resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        safeLogLine(`[Task ${taskId}] Execution timed out after ${TIMEOUT_MS}ms; terminating process tree...`);
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
          { taskId, childPid: child.pid || null }
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
    // 1. Atomic rename of task-scoped temp result -> result.<taskId>.md AND atomic update of result.md
    // 2. Atomic write of terminal status.json (DONE) referencing result.<taskId>.md
    // 3. Remove claimed.flag
    const taskResultFile = path.join(DIR, `result.${taskId}.md`);
    renameWithRetrySync(tempResultFile, taskResultFile);
    writeTextAtomicSync(RESULT, rawResultContent);
    pruneOldTaskResults(20);

    updateStatus("DONE", {
      taskId,
      exitCode,
      resultFile: taskResultFile
    });
    statusPublished = true;

    fs.unlinkSync(CLAIMED);
    safeLogLine(`=== [TASK ${taskId} DONE exit=${exitCode}] ===`);
    console.log(`Codex task (${taskId}) finished.`);
  } catch (error) {
    safeLogLine(`=== [TASK ${taskId || "unassigned"} FAILED: ${error.message}] ===`);
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
        { taskId, childPid: activeChild && activeChild.pid ? activeChild.pid : null }
      );
      return;
    }

    try {
      updateStatus("FAILED", {
        taskId,
        error: error.message
      });
      statusPublished = true;
    } catch (statusErr) {
      enterBlockedState(
        `Failed to persist FAILED status for task ${taskId || "unassigned"}: ${statusErr.message} (original error: ${error.message})`,
        { taskId }
      );
      return;
    }

    if (statusPublished && childConfirmedStopped) {
      try {
        if (fs.existsSync(CLAIMED)) {
          fs.unlinkSync(CLAIMED);
        }
      } catch (unlinkErr) {
        enterBlockedState(
          `Failed to remove claimed.flag after task ${taskId || "unassigned"} failure: ${unlinkErr.message}`,
          { taskId }
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
    console.error(`Failed to acquire Bridge lock: ${err.message}`);
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

  console.log("Codex Bridge is running.");
  console.log("Workspace:", ROOT);
  console.log("Control Dir:", DIR);
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
