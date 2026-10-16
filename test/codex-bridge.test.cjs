const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const BRIDGE_SCRIPT = path.resolve(__dirname, "..", "codex-bridge.cjs");

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function createTempControlDir(prefix = "codex-bridge-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanupDir(dirPath) {
  try {
    fs.rmSync(dirPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch (_) {}
}

async function waitForCondition(predicate, timeoutMs = 8000, intervalMs = 40) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const val = await predicate();
      if (val) return val;
    } catch (_) {}
    await sleep(intervalMs);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

function startBridgeProcess(controlDir, envOverrides = {}) {
  const child = spawn(process.execPath, [BRIDGE_SCRIPT], {
    cwd: path.dirname(BRIDGE_SCRIPT),
    env: {
      ...process.env,
      CODEX_BRIDGE_DIR: controlDir,
      CODEX_BRIDGE_POLL_MS: "50",
      CODEX_BRIDGE_TIMEOUT_MS: "3000",
      CODEX_BRIDGE_KILL_GRACE_MS: "1500",
      ...envOverrides
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", chunk => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", chunk => {
    stderr += chunk.toString("utf8");
  });

  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    await Promise.race([
      new Promise(resolve => child.once("close", resolve)),
      sleep(1500).then(() => {
        try {
          child.kill("SIGKILL");
        } catch (_) {}
      })
    ]);
  };

  return {
    child,
    getStdout: () => stdout,
    getStderr: () => stderr,
    stop
  };
}

function submitTaskWithLock(controlDir, taskId, promptText) {
  const submitLockFile = path.join(controlDir, "submit.lock");
  const statusFile = path.join(controlDir, "status.json");
  const requestFile = path.join(controlDir, "request.md");
  const triggerFile = path.join(controlDir, "pending.flag");
  const claimedFile = path.join(controlDir, "claimed.flag");

  let lockFd = null;
  try {
    try {
      lockFd = fs.openSync(submitLockFile, "wx");
    } catch (_) {
      throw new Error("submit.lock already held");
    }

    if (fs.existsSync(triggerFile)) {
      throw new Error("pending.flag already exists");
    }
    if (fs.existsSync(claimedFile)) {
      throw new Error("claimed.flag already exists");
    }
    if (fs.existsSync(statusFile)) {
      const status = JSON.parse(fs.readFileSync(statusFile, "utf8"));
      if (status.state === "RUNNING") {
        throw new Error(`Task ${status.taskId} is already RUNNING`);
      }
      if (status.state === "BLOCKED") {
        throw new Error(`Bridge is BLOCKED: ${status.error}`);
      }
    }

    fs.writeFileSync(requestFile, promptText, "utf8");
    const tmpTrigger = path.join(controlDir, `pending.${taskId}.tmp`);
    fs.writeFileSync(tmpTrigger, JSON.stringify({ taskId }), "utf8");
    fs.renameSync(tmpTrigger, triggerFile);
  } finally {
    if (lockFd !== null) {
      try {
        fs.closeSync(lockFd);
      } catch (_) {}
      try {
        fs.unlinkSync(submitLockFile);
      } catch (_) {}
    }
  }
}

test("1. Normal task execution, taskId correlation, atomic result/status publication, and task log boundaries", async () => {
  const controlDir = createTempControlDir();
  const mockWorker = path.join(controlDir, "mock-worker.cjs");
  fs.writeFileSync(
    mockWorker,
    `
      const fs = require("node:fs");
      let input = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", d => input += d);
      process.stdin.on("end", () => {
        console.log("worker stdout for " + process.env.CODEX_TASK_ID);
        fs.writeFileSync(process.env.CODEX_RESULT_FILE, "Verified response: " + input.trim(), "utf8");
        process.exit(0);
      });
    `,
    "utf8"
  );

  const bridge = startBridgeProcess(controlDir, {
    CODEX_BRIDGE_CMD: `"${process.execPath}" "${mockWorker}"`
  });

  try {
    await waitForCondition(() => fs.existsSync(path.join(controlDir, "bridge.lock")));

    submitTaskWithLock(controlDir, "task-001", "Hello from test 1");

    const doneStatus = await waitForCondition(() => {
      const st = readJsonIfExists(path.join(controlDir, "status.json"));
      return st && st.taskId === "task-001" && st.state === "DONE" ? st : null;
    });

    assert.equal(doneStatus.state, "DONE");
    assert.equal(doneStatus.taskId, "task-001");
    assert.equal(doneStatus.exitCode, 0);
    assert.ok(doneStatus.bridgeInstanceId);

    const resultText = fs.readFileSync(path.join(controlDir, "result.md"), "utf8");
    assert.equal(resultText, "Verified response: Hello from test 1");
    assert.equal(fs.existsSync(path.join(controlDir, "pending.flag")), false);
    assert.equal(fs.existsSync(path.join(controlDir, "claimed.flag")), false);

    const logText = fs.readFileSync(path.join(controlDir, "bridge.log"), "utf8");
    assert.match(logText, /=== \[TASK task-001 START\] ===/);
    assert.match(logText, /worker stdout for task-001/);
    assert.match(logText, /=== \[TASK task-001 DONE exit=0\] ===/);
  } finally {
    await bridge.stop();
    cleanupDir(controlDir);
  }
});

test("2. Duplicate and concurrent submissions are rejected without overwriting active request.md", async () => {
  const controlDir = createTempControlDir();
  const mockWorker = path.join(controlDir, "slow-worker.cjs");
  fs.writeFileSync(
    mockWorker,
    `
      const fs = require("node:fs");
      setTimeout(() => {
        fs.writeFileSync(process.env.CODEX_RESULT_FILE, "Completed first task", "utf8");
        process.exit(0);
      }, 600);
    `,
    "utf8"
  );

  const bridge = startBridgeProcess(controlDir, {
    CODEX_BRIDGE_CMD: `"${process.execPath}" "${mockWorker}"`
  });

  try {
    await waitForCondition(() => fs.existsSync(path.join(controlDir, "bridge.lock")));

    submitTaskWithLock(controlDir, "task-active", "Original protected request");

    // Wait until Bridge claims the task and enters RUNNING state
    await waitForCondition(() => {
      const st = readJsonIfExists(path.join(controlDir, "status.json"));
      return st && st.state === "RUNNING" && st.taskId === "task-active";
    });

    // Attempt a second submission while the first task is RUNNING
    assert.throws(
      () => submitTaskWithLock(controlDir, "task-intruder", "Intruder overwrite attempt"),
      /claimed\.flag already exists|already RUNNING/
    );

    // Verify request.md was NOT overwritten
    const currentRequest = fs.readFileSync(path.join(controlDir, "request.md"), "utf8");
    assert.equal(currentRequest, "Original protected request");

    // Wait for first task to complete normally
    const finalStatus = await waitForCondition(() => {
      const st = readJsonIfExists(path.join(controlDir, "status.json"));
      return st && st.state === "DONE" && st.taskId === "task-active" ? st : null;
    });
    assert.equal(finalStatus.state, "DONE");

    // Also test submit.lock contention directly
    const lockPath = path.join(controlDir, "submit.lock");
    const heldFd = fs.openSync(lockPath, "wx");
    try {
      assert.throws(
        () => submitTaskWithLock(controlDir, "task-locked", "Should fail on submit.lock"),
        /submit\.lock already held/
      );
    } finally {
      fs.closeSync(heldFd);
      fs.unlinkSync(lockPath);
    }
  } finally {
    await bridge.stop();
    cleanupDir(controlDir);
  }
});

test("3. Multiple Bridge instances: second instance fails closed with exit code 1 without disturbing active instance", async () => {
  const controlDir = createTempControlDir();
  const mockWorker = path.join(controlDir, "worker.cjs");
  fs.writeFileSync(
    mockWorker,
    `
      const fs = require("node:fs");
      fs.writeFileSync(process.env.CODEX_RESULT_FILE, "Single owner output", "utf8");
      process.exit(0);
    `,
    "utf8"
  );

  const bridgeA = startBridgeProcess(controlDir, {
    CODEX_BRIDGE_CMD: `"${process.execPath}" "${mockWorker}"`
  });

  try {
    const lockBefore = await waitForCondition(() => readJsonIfExists(path.join(controlDir, "bridge.lock")));
    assert.equal(lockBefore.pid, bridgeA.child.pid);

    // Attempt to start a second Bridge instance against the same control directory
    const secondRun = spawnSync(process.execPath, [BRIDGE_SCRIPT], {
      cwd: path.dirname(BRIDGE_SCRIPT),
      env: {
        ...process.env,
        CODEX_BRIDGE_DIR: controlDir
      },
      encoding: "utf8"
    });

    assert.equal(secondRun.status, 1);
    assert.match(secondRun.stderr, /Failed to acquire Bridge lock/);

    // Verify bridgeA still owns bridge.lock and can execute tasks normally
    const lockAfter = readJsonIfExists(path.join(controlDir, "bridge.lock"));
    assert.equal(lockAfter.bridgeInstanceId, lockBefore.bridgeInstanceId);

    submitTaskWithLock(controlDir, "task-after-duplicate-bridge", "Verify Bridge A still works");
    const st = await waitForCondition(() => {
      const s = readJsonIfExists(path.join(controlDir, "status.json"));
      return s && s.taskId === "task-after-duplicate-bridge" && s.state === "DONE" ? s : null;
    });
    assert.equal(st.state, "DONE");
  } finally {
    await bridgeA.stop();
    cleanupDir(controlDir);
  }
});

test("4. Child process timeout kills descendant process tree and recovers for subsequent tasks", async () => {
  const controlDir = createTempControlDir();
  const grandchildPidFile = path.join(controlDir, "grandchild.pid");
  const hungWorker = path.join(controlDir, "hung-worker.cjs");
  const fastWorker = path.join(controlDir, "fast-worker.cjs");

  fs.writeFileSync(
    hungWorker,
    `
      const fs = require("node:fs");
      const { spawn } = require("node:child_process");
      const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: "ignore"
      });
      fs.writeFileSync(${JSON.stringify(grandchildPidFile)}, String(grandchild.pid), "utf8");
      setInterval(() => {}, 1000);
    `,
    "utf8"
  );

  fs.writeFileSync(
    fastWorker,
    `
      const fs = require("node:fs");
      const modeFile = ${JSON.stringify(path.join(controlDir, "mode.txt"))};
      const mode = fs.existsSync(modeFile) ? fs.readFileSync(modeFile, "utf8").trim() : "hang";
      if (mode === "hang") {
        require(${JSON.stringify(hungWorker)});
      } else {
        fs.writeFileSync(process.env.CODEX_RESULT_FILE, "Recovered after timeout", "utf8");
        process.exit(0);
      }
    `,
    "utf8"
  );

  const bridge = startBridgeProcess(controlDir, {
    CODEX_BRIDGE_CMD: `"${process.execPath}" "${fastWorker}"`,
    CODEX_BRIDGE_TIMEOUT_MS: "700",
    CODEX_BRIDGE_KILL_GRACE_MS: "2000"
  });

  try {
    await waitForCondition(() => fs.existsSync(path.join(controlDir, "bridge.lock")));

    fs.writeFileSync(path.join(controlDir, "mode.txt"), "hang", "utf8");
    submitTaskWithLock(controlDir, "task-timeout-1", "This task will hang");

    const gPid = Number.parseInt(
      await waitForCondition(() =>
        fs.existsSync(grandchildPidFile) ? fs.readFileSync(grandchildPidFile, "utf8").trim() : null
      ),
      10
    );
    assert.ok(Number.isSafeInteger(gPid) && gPid > 0);

    const failedStatus = await waitForCondition(() => {
      const st = readJsonIfExists(path.join(controlDir, "status.json"));
      return st && st.taskId === "task-timeout-1" && st.state === "FAILED" ? st : null;
    });

    assert.equal(failedStatus.state, "FAILED");
    assert.match(failedStatus.error, /timed out/i);
    assert.equal(fs.existsSync(path.join(controlDir, "claimed.flag")), false);

    // Verify grandchild process was also terminated by taskkill /T /F
    await waitForCondition(() => {
      try {
        process.kill(gPid, 0);
        return false;
      } catch (err) {
        return err && err.code === "ESRCH";
      }
    }, 4000);

    // Verify Bridge can immediately run a normal task afterwards
    fs.writeFileSync(path.join(controlDir, "mode.txt"), "fast", "utf8");
    submitTaskWithLock(controlDir, "task-after-timeout", "Should succeed now");

    const recoveredStatus = await waitForCondition(() => {
      const st = readJsonIfExists(path.join(controlDir, "status.json"));
      return st && st.taskId === "task-after-timeout" && st.state === "DONE" ? st : null;
    });
    assert.equal(recoveredStatus.state, "DONE");
  } finally {
    await bridge.stop();
    cleanupDir(controlDir);
  }
});

test("5. Abnormal child exit, empty result, malformed trigger, and stdin EPIPE error handling", async () => {
  const controlDir = createTempControlDir();
  const modeFile = path.join(controlDir, "worker-mode.txt");
  const workerScript = path.join(controlDir, "mode-worker.cjs");

  fs.writeFileSync(
    workerScript,
    `
      const fs = require("node:fs");
      const mode = fs.readFileSync(${JSON.stringify(modeFile)}, "utf8").trim();
      if (mode === "exit-nonzero") {
        console.error("Simulated failure output");
        process.exit(2);
      } else if (mode === "empty-result") {
        fs.writeFileSync(process.env.CODEX_RESULT_FILE, "   ", "utf8");
        process.exit(0);
      } else if (mode === "close-stdin-early") {
        process.stdin.destroy();
        fs.writeFileSync(process.env.CODEX_RESULT_FILE, "Survived early stdin close", "utf8");
        process.exit(0);
      }
    `,
    "utf8"
  );

  const bridge = startBridgeProcess(controlDir, {
    CODEX_BRIDGE_CMD: `"${process.execPath}" "${workerScript}"`
  });

  try {
    await waitForCondition(() => fs.existsSync(path.join(controlDir, "bridge.lock")));

    // 5a: Non-zero exit code
    fs.writeFileSync(modeFile, "exit-nonzero", "utf8");
    submitTaskWithLock(controlDir, "task-nonzero", "Trigger exit 2");
    const st1 = await waitForCondition(() => {
      const s = readJsonIfExists(path.join(controlDir, "status.json"));
      return s && s.taskId === "task-nonzero" && s.state === "FAILED" ? s : null;
    });
    assert.match(st1.error, /Codex failed: exit 2/);
    assert.equal(fs.existsSync(path.join(controlDir, "claimed.flag")), false);

    // 5b: Empty result file
    fs.writeFileSync(modeFile, "empty-result", "utf8");
    submitTaskWithLock(controlDir, "task-empty-res", "Trigger empty result");
    const st2 = await waitForCondition(() => {
      const s = readJsonIfExists(path.join(controlDir, "status.json"));
      return s && s.taskId === "task-empty-res" && s.state === "FAILED" ? s : null;
    });
    assert.match(st2.error, /empty result file/);
    assert.equal(fs.existsSync(path.join(controlDir, "claimed.flag")), false);

    // 5c: Malformed JSON in pending.flag
    fs.writeFileSync(path.join(controlDir, "request.md"), "Valid request", "utf8");
    fs.writeFileSync(path.join(controlDir, "pending.flag"), "{not-valid-json", "utf8");
    const st3 = await waitForCondition(() => {
      const s = readJsonIfExists(path.join(controlDir, "status.json"));
      return s && s.state === "FAILED" && /Malformed JSON in pending\.flag/.test(s.error || "") ? s : null;
    });
    assert.equal(st3.state, "FAILED");
    assert.equal(fs.existsSync(path.join(controlDir, "claimed.flag")), false);

    // 5d: Early stdin close with large prompt does not crash Bridge
    fs.writeFileSync(modeFile, "close-stdin-early", "utf8");
    submitTaskWithLock(controlDir, "task-stdin-early", "X".repeat(128 * 1024));
    const st4 = await waitForCondition(() => {
      const s = readJsonIfExists(path.join(controlDir, "status.json"));
      return s && s.taskId === "task-stdin-early" && (s.state === "DONE" || s.state === "FAILED") ? s : null;
    });
    assert.equal(st4.state, "DONE");
  } finally {
    await bridge.stop();
    cleanupDir(controlDir);
  }
});

test("6. Startup crash recovery: pre-spawn interrupted tasks recover to FAILED, while post-spawn RUNNING tasks enter conservative BLOCKED state", async () => {
  // 6a: Pre-spawn interrupted task (childSpawned: false) + stale bridge.lock (dead PID) -> recovers to FAILED and accepts new tasks
  const dirPreSpawn = createTempControlDir("codex-recovery-prespawn-");
  const workerScript = path.join(dirPreSpawn, "ok-worker.cjs");
  fs.writeFileSync(
    workerScript,
    `
      const fs = require("node:fs");
      fs.writeFileSync(process.env.CODEX_RESULT_FILE, "Recovered and ran new task", "utf8");
      process.exit(0);
    `,
    "utf8"
  );

  fs.writeFileSync(
    path.join(dirPreSpawn, "bridge.lock"),
    JSON.stringify({ pid: 999999, bridgeInstanceId: "dead-bridge-1", startedAt: new Date().toISOString() }),
    "utf8"
  );
  fs.writeFileSync(
    path.join(dirPreSpawn, "claimed.flag"),
    JSON.stringify({
      taskId: "task-prespawn-crash",
      bridgeInstanceId: "dead-bridge-1",
      bridgePid: 999999,
      phase: "PREPARING",
      childSpawned: false,
      childPid: null
    }),
    "utf8"
  );
  fs.writeFileSync(
    path.join(dirPreSpawn, "status.json"),
    JSON.stringify({
      state: "RUNNING",
      taskId: "task-prespawn-crash",
      phase: "PREPARING",
      childSpawned: false,
      childPid: null
    }),
    "utf8"
  );

  const bridge1 = startBridgeProcess(dirPreSpawn, {
    CODEX_BRIDGE_CMD: `"${process.execPath}" "${workerScript}"`
  });

  try {
    const reconciled = await waitForCondition(() => {
      const st = readJsonIfExists(path.join(dirPreSpawn, "status.json"));
      return st && st.taskId === "task-prespawn-crash" && st.state === "FAILED" ? st : null;
    });
    assert.equal(reconciled.state, "FAILED");
    assert.match(reconciled.error, /Interrupted before child process spawn/);
    assert.equal(fs.existsSync(path.join(dirPreSpawn, "claimed.flag")), false);

    // Submit a new task and verify Bridge executes it
    submitTaskWithLock(dirPreSpawn, "task-post-recovery", "Run after pre-spawn recovery");
    const doneSt = await waitForCondition(() => {
      const st = readJsonIfExists(path.join(dirPreSpawn, "status.json"));
      return st && st.taskId === "task-post-recovery" && st.state === "DONE" ? st : null;
    });
    assert.equal(doneSt.state, "DONE");
  } finally {
    await bridge1.stop();
    cleanupDir(dirPreSpawn);
  }

  // 6b: Post-spawn interrupted task (childSpawned: true / phase: EXECUTING) -> MUST enter conservative BLOCKED state and refuse new tasks
  const dirPostSpawn = createTempControlDir("codex-recovery-blocked-");
  fs.writeFileSync(
    path.join(dirPostSpawn, "claimed.flag"),
    JSON.stringify({
      taskId: "task-postspawn-crash",
      bridgeInstanceId: "dead-bridge-2",
      bridgePid: 999998,
      phase: "EXECUTING",
      childSpawned: true,
      childPid: 888888
    }),
    "utf8"
  );
  fs.writeFileSync(
    path.join(dirPostSpawn, "status.json"),
    JSON.stringify({
      state: "RUNNING",
      taskId: "task-postspawn-crash",
      phase: "EXECUTING",
      childSpawned: true,
      childPid: 888888
    }),
    "utf8"
  );

  const bridge2 = startBridgeProcess(dirPostSpawn, {
    CODEX_BRIDGE_CMD: `"${process.execPath}" -e "process.exit(0)"`
  });

  try {
    const blockedStatus = await waitForCondition(() => {
      const st = readJsonIfExists(path.join(dirPostSpawn, "status.json"));
      return st && st.state === "BLOCKED" ? st : null;
    });

    assert.equal(blockedStatus.state, "BLOCKED");
    assert.equal(blockedStatus.taskId, "task-postspawn-crash");
    assert.match(blockedStatus.error, /Conservative crash recovery/);

    // Verify submitter refuses submission when Bridge is BLOCKED
    assert.throws(
      () => submitTaskWithLock(dirPostSpawn, "task-should-be-blocked", "Should not submit"),
      /claimed\.flag already exists|Bridge is BLOCKED/
    );

    // Even if a pending.flag is manually dropped into the directory, Bridge must NOT claim it while BLOCKED
    const manualTrigger = path.join(dirPostSpawn, "pending.flag");
    fs.writeFileSync(manualTrigger, JSON.stringify({ taskId: "task-manual" }), "utf8");
    await sleep(250);
    assert.equal(fs.existsSync(manualTrigger), true);
  } finally {
    await bridge2.stop();
    cleanupDir(dirPostSpawn);
  }
});

test("7. Filesystem anomalies: corrupted status.json enters BLOCKED, terminal status with residual claimed.flag reconciles cleanly, and missing request.md fails gracefully", async () => {
  // 7a: Corrupted status.json on startup enters BLOCKED
  const dirCorrupt = createTempControlDir("codex-fs-corrupt-");
  fs.writeFileSync(path.join(dirCorrupt, "status.json"), "{corrupted-json", "utf8");

  const bridgeCorrupt = startBridgeProcess(dirCorrupt, {
    CODEX_BRIDGE_CMD: `"${process.execPath}" -e "process.exit(0)"`
  });

  try {
    const st = await waitForCondition(() => {
      const s = readJsonIfExists(path.join(dirCorrupt, "status.json"));
      return s && s.state === "BLOCKED" ? s : null;
    });
    assert.equal(st.state, "BLOCKED");
    assert.match(st.error, /corrupted status\.json/);
  } finally {
    await bridgeCorrupt.stop();
    cleanupDir(dirCorrupt);
  }

  // 7b: Residual claimed.flag matching terminal DONE status.json is cleaned up on startup, and missing request.md fails cleanly
  const dirReconcile = createTempControlDir("codex-fs-reconcile-");
  const okWorker = path.join(dirReconcile, "ok-worker.cjs");
  fs.writeFileSync(
    okWorker,
    `
      const fs = require("node:fs");
      fs.writeFileSync(process.env.CODEX_RESULT_FILE, "OK", "utf8");
      process.exit(0);
    `,
    "utf8"
  );

  fs.writeFileSync(
    path.join(dirReconcile, "claimed.flag"),
    JSON.stringify({ taskId: "task-already-done", phase: "EXECUTING", childSpawned: true }),
    "utf8"
  );
  fs.writeFileSync(
    path.join(dirReconcile, "status.json"),
    JSON.stringify({ state: "DONE", taskId: "task-already-done", exitCode: 0 }),
    "utf8"
  );

  const bridgeReconcile = startBridgeProcess(dirReconcile, {
    CODEX_BRIDGE_CMD: `"${process.execPath}" "${okWorker}"`
  });

  try {
    await waitForCondition(() => !fs.existsSync(path.join(dirReconcile, "claimed.flag")));
    const preserved = readJsonIfExists(path.join(dirReconcile, "status.json"));
    assert.equal(preserved.state, "DONE");
    assert.equal(preserved.taskId, "task-already-done");

    // Trigger a task when request.md is missing -> fails cleanly without blocking Bridge
    fs.writeFileSync(path.join(dirReconcile, "pending.flag"), JSON.stringify({ taskId: "task-missing-req" }), "utf8");
    const failedSt = await waitForCondition(() => {
      const s = readJsonIfExists(path.join(dirReconcile, "status.json"));
      return s && s.taskId === "task-missing-req" && s.state === "FAILED" ? s : null;
    });
    assert.match(failedSt.error, /Missing request\.md/);
    assert.equal(fs.existsSync(path.join(dirReconcile, "claimed.flag")), false);
  } finally {
    await bridgeReconcile.stop();
    cleanupDir(dirReconcile);
  }
});

test("8. Task-specific result.<taskId>.md correlation, failed taskkill entering BLOCKED, and concurrent stale lock reclaim", async () => {
  // 8a: Task-specific result.<taskId>.md is preserved when a subsequent task completes
  const dirCorr = createTempControlDir("codex-corr-");
  const echoWorker = path.join(dirCorr, "echo-worker.cjs");
  fs.writeFileSync(
    echoWorker,
    `
      const fs = require("node:fs");
      let input = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", d => input += d);
      process.stdin.on("end", () => {
        fs.writeFileSync(process.env.CODEX_RESULT_FILE, "Output for " + process.env.CODEX_TASK_ID + ": " + input.trim(), "utf8");
        process.exit(0);
      });
    `,
    "utf8"
  );

  const bridgeCorr = startBridgeProcess(dirCorr, {
    CODEX_BRIDGE_CMD: `"${process.execPath}" "${echoWorker}"`
  });

  try {
    await waitForCondition(() => fs.existsSync(path.join(dirCorr, "bridge.lock")));

    submitTaskWithLock(dirCorr, "task-first", "Payload A");
    await waitForCondition(() => {
      const st = readJsonIfExists(path.join(dirCorr, "status.json"));
      return st && st.taskId === "task-first" && st.state === "DONE";
    });

    submitTaskWithLock(dirCorr, "task-second", "Payload B");
    await waitForCondition(() => {
      const st = readJsonIfExists(path.join(dirCorr, "status.json"));
      return st && st.taskId === "task-second" && st.state === "DONE";
    });

    // Even after task-second overwrites result.md, result.task-first.md still preserves task-first's exact result
    assert.equal(
      fs.readFileSync(path.join(dirCorr, "result.task-first.md"), "utf8").trim(),
      "Output for task-first: Payload A"
    );
    assert.equal(
      fs.readFileSync(path.join(dirCorr, "result.task-second.md"), "utf8").trim(),
      "Output for task-second: Payload B"
    );
  } finally {
    await bridgeCorr.stop();
    cleanupDir(dirCorr);
  }

  // 8b: If taskkill fails (exits non-zero) on timeout, Bridge refuses to assume tree termination and enters BLOCKED
  const dirFailKill = createTempControlDir("codex-failkill-");
  const hangScript = path.join(dirFailKill, "hang.cjs");
  const fakeKiller = path.join(dirFailKill, "fake-killer.cjs");
  fs.writeFileSync(hangScript, `setInterval(() => {}, 1000);`, "utf8");
  fs.writeFileSync(fakeKiller, `process.exit(1);`, "utf8");

  const bridgeFailKill = startBridgeProcess(dirFailKill, {
    CODEX_BRIDGE_CMD: `"${process.execPath}" "${hangScript}"`,
    CODEX_BRIDGE_TASKKILL_CMD: `"${process.execPath}" "${fakeKiller}"`,
    CODEX_BRIDGE_TIMEOUT_MS: "400",
    CODEX_BRIDGE_KILL_GRACE_MS: "500"
  });

  try {
    await waitForCondition(() => fs.existsSync(path.join(dirFailKill, "bridge.lock")));
    submitTaskWithLock(dirFailKill, "task-unconfirmed-kill", "Will fail taskkill");

    const blockedSt = await waitForCondition(() => {
      const s = readJsonIfExists(path.join(dirFailKill, "status.json"));
      return s && s.state === "BLOCKED" ? s : null;
    });
    assert.equal(blockedSt.state, "BLOCKED");
    assert.equal(blockedSt.taskId, "task-unconfirmed-kill");
    assert.match(blockedSt.error, /termination could not be confirmed/);
    assert.equal(fs.existsSync(path.join(dirFailKill, "claimed.flag")), true);

    // Clean up the hung child process tree for test hygiene
    if (blockedSt.childPid) {
      spawnSync("taskkill", ["/PID", String(blockedSt.childPid), "/T", "/F"]);
    }
  } finally {
    await bridgeFailKill.stop();
    cleanupDir(dirFailKill);
  }
});


