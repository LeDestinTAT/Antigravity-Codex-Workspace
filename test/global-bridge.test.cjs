const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const GLOBAL_BRIDGE_SCRIPT = path.resolve(__dirname, "..", "global", "bridge.cjs");
const GLOBAL_CLIENT_SCRIPT = path.resolve(__dirname, "..", "global", "client.cjs");

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function createTempDir(prefix = "dual-agent-global-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanupDir(dirPath) {
  try {
    fs.rmSync(dirPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch (_) {}
}

function createMockProject(baseDir, name, withGit = true) {
  const projDir = path.join(baseDir, name);
  fs.mkdirSync(projDir, { recursive: true });
  if (withGit) {
    fs.mkdirSync(path.join(projDir, ".git"), { recursive: true });
  }
  return projDir;
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
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

function startGlobalBridge(homeDir, envOverrides = {}) {
  const child = spawn(process.execPath, [GLOBAL_BRIDGE_SCRIPT], {
    cwd: path.dirname(GLOBAL_BRIDGE_SCRIPT),
    env: {
      ...process.env,
      DUAL_AGENT_HOME: homeDir,
      CODEX_BRIDGE_POLL_MS: "40",
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

  return { child, getStdout: () => stdout, getStderr: () => stderr, stop };
}

function runClientSync(homeDir, args, input = undefined) {
  return spawnSync(process.execPath, [GLOBAL_CLIENT_SCRIPT, ...args], {
    env: {
      ...process.env,
      DUAL_AGENT_HOME: homeDir
    },
    input,
    encoding: "utf8"
  });
}

function createEchoWorkerScript(dirPath) {
  const workerPath = path.join(dirPath, "echo-worker.cjs");
  fs.writeFileSync(
    workerPath,
    `
      const fs = require("node:fs");
      let prompt = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", chunk => prompt += chunk);
      process.stdin.on("end", () => {
        const out = JSON.stringify({
          taskId: process.env.CODEX_TASK_ID,
          cwd: process.cwd(),
          projectRoot: process.env.CODEX_PROJECT_ROOT,
          prompt: prompt.trim()
        });
        console.log("Worker executed for " + process.env.CODEX_TASK_ID + " in " + process.cwd());
        fs.writeFileSync(process.env.CODEX_RESULT_FILE, out, "utf8");
        process.exit(0);
      });
    `,
    "utf8"
  );
  return workerPath;
}

test("1. Single project normal execution and automatic Git root detection from subdirectory", async () => {
  const rootDir = createTempDir();
  const homeDir = path.join(rootDir, "home");
  const projA = createMockProject(rootDir, "ProjectA", true);
  const subDirA = path.join(projA, "src", "components");
  fs.mkdirSync(subDirA, { recursive: true });
  const workerPath = createEchoWorkerScript(rootDir);

  const bridge = startGlobalBridge(homeDir, {
    CODEX_BRIDGE_CMD: `"${process.execPath}" "${workerPath}"`
  });

  try {
    await waitForCondition(() => fs.existsSync(path.join(homeDir, "bridge.lock")));

    const regRes = runClientSync(homeDir, ["register", "--project", subDirA]);
    assert.equal(regRes.status, 0);
    const regJson = JSON.parse(regRes.stdout);
    assert.equal(regJson.status, "REGISTERED");
    assert.equal(regJson.project.projectRoot.toLowerCase(), projA.toLowerCase());

    const subRes = runClientSync(homeDir, ["submit", "--project", subDirA, "--prompt", "Review ProjectA"]);
    assert.equal(subRes.status, 0);
    const subJson = JSON.parse(subRes.stdout);
    assert.equal(subJson.status, "SUBMITTED");

    const pollRes = runClientSync(homeDir, ["poll", "--task-id", subJson.taskId, "--timeout-ms", "5000", "--interval-ms", "50"]);
    assert.equal(pollRes.status, 0);
    const resultPayload = JSON.parse(pollRes.stdout);
    assert.equal(resultPayload.taskId, subJson.taskId);
    assert.equal(resultPayload.cwd.toLowerCase(), projA.toLowerCase());
    assert.equal(resultPayload.prompt, "Review ProjectA");
  } finally {
    await bridge.stop();
    cleanupDir(rootDir);
  }
});

test("2. Two projects sequential task submissions execute in their respective project directories", async () => {
  const rootDir = createTempDir();
  const homeDir = path.join(rootDir, "home");
  const projA = createMockProject(rootDir, "SeqAlpha", true);
  const projB = createMockProject(rootDir, "SeqBeta", true);
  const workerPath = createEchoWorkerScript(rootDir);

  const bridge = startGlobalBridge(homeDir, {
    CODEX_BRIDGE_CMD: `"${process.execPath}" "${workerPath}"`
  });

  try {
    await waitForCondition(() => fs.existsSync(path.join(homeDir, "bridge.lock")));
    runClientSync(homeDir, ["register", "--project", projA]);
    runClientSync(homeDir, ["register", "--project", projB]);

    const subA = JSON.parse(runClientSync(homeDir, ["submit", "--project", projA, "--prompt", "Task for Alpha"]).stdout);
    const outA = JSON.parse(
      runClientSync(homeDir, ["poll", "--task-id", subA.taskId, "--timeout-ms", "5000", "--interval-ms", "50"]).stdout
    );
    assert.equal(outA.cwd.toLowerCase(), projA.toLowerCase());
    assert.equal(outA.prompt, "Task for Alpha");

    const subB = JSON.parse(runClientSync(homeDir, ["submit", "--project", projB, "--prompt", "Task for Beta"]).stdout);
    const outB = JSON.parse(
      runClientSync(homeDir, ["poll", "--task-id", subB.taskId, "--timeout-ms", "5000", "--interval-ms", "50"]).stdout
    );
    assert.equal(outB.cwd.toLowerCase(), projB.toLowerCase());
    assert.equal(outB.prompt, "Task for Beta");
  } finally {
    await bridge.stop();
    cleanupDir(rootDir);
  }
});

test("3. Two projects tasks, requests, results, statuses, and logs are strictly isolated", async () => {
  const rootDir = createTempDir();
  const homeDir = path.join(rootDir, "home");
  const projA = createMockProject(rootDir, "IsoAlpha", true);
  const projB = createMockProject(rootDir, "IsoBeta", true);
  const workerPath = createEchoWorkerScript(rootDir);

  const bridge = startGlobalBridge(homeDir, {
    CODEX_BRIDGE_CMD: `"${process.execPath}" "${workerPath}"`
  });

  try {
    await waitForCondition(() => fs.existsSync(path.join(homeDir, "bridge.lock")));

    const regA = JSON.parse(runClientSync(homeDir, ["register", "--project", projA]).stdout).project;
    const regB = JSON.parse(runClientSync(homeDir, ["register", "--project", projB]).stdout).project;

    const subA = JSON.parse(
      runClientSync(homeDir, ["submit", "--project", projA, "--prompt", "Alpha secret task"]).stdout
    );
    const subB = JSON.parse(
      runClientSync(homeDir, ["submit", "--project", projB, "--prompt", "Beta secret task"]).stdout
    );

    runClientSync(homeDir, ["poll", "--task-id", subA.taskId, "--timeout-ms", "5000", "--interval-ms", "50"]);
    runClientSync(homeDir, ["poll", "--task-id", subB.taskId, "--timeout-ms", "5000", "--interval-ms", "50"]);

    const reqFileA = fs.readFileSync(path.join(homeDir, "queue", "tasks", subA.taskId, "request.md"), "utf8");
    const reqFileB = fs.readFileSync(path.join(homeDir, "queue", "tasks", subB.taskId, "request.md"), "utf8");
    assert.equal(reqFileA, "Alpha secret task");
    assert.equal(reqFileB, "Beta secret task");

    const resFileA = JSON.parse(fs.readFileSync(path.join(homeDir, "queue", "tasks", subA.taskId, "result.md"), "utf8"));
    const resFileB = JSON.parse(fs.readFileSync(path.join(homeDir, "queue", "tasks", subB.taskId, "result.md"), "utf8"));
    assert.equal(resFileA.taskId, subA.taskId);
    assert.equal(resFileB.taskId, subB.taskId);

    const logA = fs.readFileSync(path.join(homeDir, "logs", "projects", `${regA.projectId}.log`), "utf8");
    const logB = fs.readFileSync(path.join(homeDir, "logs", "projects", `${regB.projectId}.log`), "utf8");
    assert.match(logA, new RegExp(subA.taskId));
    assert.doesNotMatch(logA, new RegExp(subB.taskId));
    assert.match(logB, new RegExp(subB.taskId));
    assert.doesNotMatch(logB, new RegExp(subA.taskId));
  } finally {
    await bridge.stop();
    cleanupDir(rootDir);
  }
});

test("4. Concurrent submissions across projects do not overwrite files or lose tasks", async () => {
  const rootDir = createTempDir();
  const homeDir = path.join(rootDir, "home");
  const projA = createMockProject(rootDir, "ConcurrentA", true);
  const projB = createMockProject(rootDir, "ConcurrentB", true);
  const workerPath = createEchoWorkerScript(rootDir);

  const bridge = startGlobalBridge(homeDir, {
    CODEX_BRIDGE_CMD: `"${process.execPath}" "${workerPath}"`
  });

  try {
    await waitForCondition(() => fs.existsSync(path.join(homeDir, "bridge.lock")));
    runClientSync(homeDir, ["register", "--project", projA]);
    runClientSync(homeDir, ["register", "--project", projB]);

    const submitPromises = Array.from({ length: 6 }, (_, idx) => {
      const targetProj = idx % 2 === 0 ? projA : projB;
      const prompt = `Concurrent payload #${idx}`;
      return new Promise((resolve, reject) => {
        const p = spawn(
          process.execPath,
          [GLOBAL_CLIENT_SCRIPT, "submit", "--project", targetProj, "--prompt", prompt],
          {
            env: { ...process.env, DUAL_AGENT_HOME: homeDir },
            stdio: ["ignore", "pipe", "pipe"]
          }
        );
        let out = "";
        let err = "";
        p.stdout.on("data", d => (out += d));
        p.stderr.on("data", d => (err += d));
        p.once("close", code => {
          if (code !== 0) return reject(new Error(`Submit #${idx} failed: ${err}`));
          resolve({ idx, targetProj, prompt, sub: JSON.parse(out) });
        });
      });
    });

    const submissions = await Promise.all(submitPromises);
    const taskIds = new Set(submissions.map(s => s.sub.taskId));
    assert.equal(taskIds.size, 6);

    for (const item of submissions) {
      const pollRes = runClientSync(homeDir, [
        "poll",
        "--task-id",
        item.sub.taskId,
        "--timeout-ms",
        "8000",
        "--interval-ms",
        "40"
      ]);
      assert.equal(pollRes.status, 0);
      const parsed = JSON.parse(pollRes.stdout);
      assert.equal(parsed.prompt, item.prompt);
      assert.equal(parsed.cwd.toLowerCase(), item.targetProj.toLowerCase());
    }
  } finally {
    await bridge.stop();
    cleanupDir(rootDir);
  }
});

test("5. Unregistered project submissions and forged queue manifests are rejected", async () => {
  const rootDir = createTempDir();
  const homeDir = path.join(rootDir, "home");
  const registeredProj = createMockProject(rootDir, "RegisteredProj", true);
  const unregisteredProj = createMockProject(rootDir, "UnregisteredProj", true);
  const workerPath = createEchoWorkerScript(rootDir);

  const bridge = startGlobalBridge(homeDir, {
    CODEX_BRIDGE_CMD: `"${process.execPath}" "${workerPath}"`
  });

  try {
    await waitForCondition(() => fs.existsSync(path.join(homeDir, "bridge.lock")));
    runClientSync(homeDir, ["register", "--project", registeredProj]);

    const chkUnreg = runClientSync(homeDir, ["check-project", "--project", unregisteredProj]);
    assert.equal(chkUnreg.status, 2);

    const subUnreg = runClientSync(homeDir, [
      "submit",
      "--project",
      unregisteredProj,
      "--prompt",
      "Should be rejected"
    ]);
    assert.equal(subUnreg.status, 2);
    assert.match(subUnreg.stderr, /PROJECT_NOT_REGISTERED/);

    // Tampered pending manifest injected directly into queue/pending/ for unregistered project is rejected by Bridge
    const forgedTaskId = "task-forged-unauth";
    const forgedTaskDir = path.join(homeDir, "queue", "tasks", forgedTaskId);
    fs.mkdirSync(forgedTaskDir, { recursive: true });
    fs.writeFileSync(path.join(forgedTaskDir, "request.md"), "Forged prompt", "utf8");
    fs.writeFileSync(
      path.join(homeDir, "queue", "pending", `0000-${forgedTaskId}.json`),
      JSON.stringify({ taskId: forgedTaskId, projectRoot: unregisteredProj }),
      "utf8"
    );

    const forgedStatus = await waitForCondition(() => {
      const st = readJsonIfExists(path.join(forgedTaskDir, "status.json"));
      return st && st.state === "FAILED" ? st : null;
    });
    assert.match(forgedStatus.error, /Unauthorized or unregistered project path/);
  } finally {
    await bridge.stop();
    cleanupDir(rootDir);
  }
});

test("6. Invalid paths, filesystem root, protected system directories, and workspace escape attempts are rejected", async () => {
  const rootDir = createTempDir();
  const homeDir = path.join(rootDir, "home");
  const registeredProj = createMockProject(rootDir, "SafeProj", true);
  createMockProject(rootDir, "OutsideProj", true);

  runClientSync(homeDir, ["register", "--project", registeredProj]);

  // Relative path traversal escaping registeredProj -> OutsideProj is rejected
  const escapedPath = path.join(registeredProj, "..", "OutsideProj");
  const subEscape = runClientSync(homeDir, [
    "submit",
    "--project",
    escapedPath,
    "--prompt",
    "Escape attempt"
  ]);
  assert.equal(subEscape.status, 2);

  // Registering non-existent path, file path, filesystem root, or C:\Windows is rejected
  const regNonExistent = runClientSync(homeDir, ["register", "--project", path.join(rootDir, "DoesNotExist")]);
  assert.notEqual(regNonExistent.status, 0);

  const filePath = path.join(rootDir, "somefile.txt");
  fs.writeFileSync(filePath, "hello", "utf8");
  const regFile = runClientSync(homeDir, ["register", "--project", filePath]);
  assert.notEqual(regFile.status, 0);

  const regRoot = runClientSync(homeDir, ["register", "--project", path.parse(rootDir).root]);
  assert.notEqual(regRoot.status, 0);
  assert.match(regRoot.stderr, /filesystem root/);

  const winDir = process.env.SystemRoot || "C:\\Windows";
  if (fs.existsSync(winDir)) {
    const regWin = runClientSync(homeDir, ["register", "--project", winDir]);
    assert.notEqual(regWin.status, 0);
    assert.match(regWin.stderr, /protected system directory/);
  }

  cleanupDir(rootDir);
});

test("7. Global Bridge crash & restart recovery (pre-spawn FAILED recovery and post-spawn conservative BLOCKED state)", async () => {
  // 7a: Pre-spawn interrupted task + dead PID lock -> recovers to FAILED and returns to IDLE
  const rootDir1 = createTempDir();
  const homeDir1 = path.join(rootDir1, "home");
  const proj1 = createMockProject(rootDir1, "ProjRecover", true);
  const workerPath1 = createEchoWorkerScript(rootDir1);

  runClientSync(homeDir1, ["register", "--project", proj1]);
  fs.writeFileSync(
    path.join(homeDir1, "bridge.lock"),
    JSON.stringify({ pid: 999999, bridgeInstanceId: "dead-global-1", startedAt: new Date().toISOString() }),
    "utf8"
  );
  const preTaskDir = path.join(homeDir1, "queue", "tasks", "task-prespawn-1");
  fs.mkdirSync(preTaskDir, { recursive: true });
  fs.writeFileSync(
    path.join(homeDir1, "queue", "claimed.json"),
    JSON.stringify({
      taskId: "task-prespawn-1",
      projectRoot: proj1,
      phase: "PREPARING",
      childSpawned: false,
      childPid: null
    }),
    "utf8"
  );
  fs.writeFileSync(
    path.join(preTaskDir, "status.json"),
    JSON.stringify({
      state: "RUNNING",
      taskId: "task-prespawn-1",
      phase: "PREPARING",
      childSpawned: false,
      childPid: null
    }),
    "utf8"
  );

  const bridge1 = startGlobalBridge(homeDir1, {
    CODEX_BRIDGE_CMD: `"${process.execPath}" "${workerPath1}"`
  });

  try {
    const recoveredTaskSt = await waitForCondition(() => {
      const s = readJsonIfExists(path.join(preTaskDir, "status.json"));
      return s && s.state === "FAILED" ? s : null;
    });
    assert.match(recoveredTaskSt.error, /Interrupted before child process spawn/);
    assert.equal(fs.existsSync(path.join(homeDir1, "queue", "claimed.json")), false);

    const subNew = JSON.parse(
      runClientSync(homeDir1, ["submit", "--project", proj1, "--prompt", "After recovery"]).stdout
    );
    const pollNew = runClientSync(homeDir1, ["poll", "--task-id", subNew.taskId, "--timeout-ms", "5000", "--interval-ms", "40"]);
    assert.equal(pollNew.status, 0);
  } finally {
    await bridge1.stop();
    cleanupDir(rootDir1);
  }

  // 7b: Post-spawn interrupted task (childSpawned: true) -> enters conservative BLOCKED state
  const rootDir2 = createTempDir();
  const homeDir2 = path.join(rootDir2, "home");
  const proj2 = createMockProject(rootDir2, "ProjBlocked", true);
  runClientSync(homeDir2, ["register", "--project", proj2]);

  const postTaskDir = path.join(homeDir2, "queue", "tasks", "task-postspawn-2");
  fs.mkdirSync(postTaskDir, { recursive: true });
  fs.writeFileSync(
    path.join(homeDir2, "queue", "claimed.json"),
    JSON.stringify({
      taskId: "task-postspawn-2",
      projectRoot: proj2,
      phase: "EXECUTING",
      childSpawned: true,
      childPid: 888888
    }),
    "utf8"
  );

  const bridge2 = startGlobalBridge(homeDir2, {
    CODEX_BRIDGE_CMD: `"${process.execPath}" -e "process.exit(0)"`
  });

  try {
    const globalBlocked = await waitForCondition(() => {
      const s = readJsonIfExists(path.join(homeDir2, "status.json"));
      return s && s.state === "BLOCKED" ? s : null;
    });
    assert.equal(globalBlocked.state, "BLOCKED");
    assert.match(globalBlocked.error, /Conservative crash recovery/);

    const subWhileBlocked = runClientSync(homeDir2, ["submit", "--project", proj2, "--prompt", "Blocked submit"]);
    assert.equal(subWhileBlocked.status, 3);
    assert.match(subWhileBlocked.stderr, /BRIDGE_BLOCKED/);
  } finally {
    await bridge2.stop();
    cleanupDir(rootDir2);
  }
});

test("8. Child process timeout terminates descendant process tree and recovers for subsequent tasks", async () => {
  const rootDir = createTempDir();
  const homeDir = path.join(rootDir, "home");
  const proj = createMockProject(rootDir, "TimeoutProj", true);
  const grandchildPidFile = path.join(rootDir, "grandchild.pid");
  const modeFile = path.join(rootDir, "mode.txt");
  const workerScript = path.join(rootDir, "timeout-worker.cjs");

  fs.writeFileSync(
    workerScript,
    `
      const fs = require("node:fs");
      const { spawn } = require("node:child_process");
      const mode = fs.readFileSync(${JSON.stringify(modeFile)}, "utf8").trim();
      if (mode === "hang") {
        const gc = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
        fs.writeFileSync(${JSON.stringify(grandchildPidFile)}, String(gc.pid), "utf8");
        setInterval(() => {}, 1000);
      } else {
        fs.writeFileSync(process.env.CODEX_RESULT_FILE, "OK after timeout", "utf8");
        process.exit(0);
      }
    `,
    "utf8"
  );

  runClientSync(homeDir, ["register", "--project", proj]);

  const bridge = startGlobalBridge(homeDir, {
    CODEX_BRIDGE_CMD: `"${process.execPath}" "${workerScript}"`,
    CODEX_BRIDGE_TIMEOUT_MS: "700",
    CODEX_BRIDGE_KILL_GRACE_MS: "2000"
  });

  try {
    await waitForCondition(() => fs.existsSync(path.join(homeDir, "bridge.lock")));

    fs.writeFileSync(modeFile, "hang", "utf8");
    const subHang = JSON.parse(
      runClientSync(homeDir, ["submit", "--project", proj, "--prompt", "Hang test"]).stdout
    );

    const gPid = Number.parseInt(
      await waitForCondition(() =>
        fs.existsSync(grandchildPidFile) ? fs.readFileSync(grandchildPidFile, "utf8").trim() : null
      ),
      10
    );
    assert.ok(gPid > 0);

    const pollHang = runClientSync(homeDir, ["poll", "--task-id", subHang.taskId, "--timeout-ms", "5000", "--interval-ms", "50"]);
    assert.equal(pollHang.status, 1);
    assert.match(pollHang.stderr, /timed out/i);

    await waitForCondition(() => {
      try {
        process.kill(gPid, 0);
        return false;
      } catch (err) {
        return err && err.code === "ESRCH";
      }
    }, 4000);

    fs.writeFileSync(modeFile, "fast", "utf8");
    const subOk = JSON.parse(
      runClientSync(homeDir, ["submit", "--project", proj, "--prompt", "Recover test"]).stdout
    );
    const pollOk = runClientSync(homeDir, ["poll", "--task-id", subOk.taskId, "--timeout-ms", "5000", "--interval-ms", "50"]);
    assert.equal(pollOk.status, 0);
    assert.equal(pollOk.stdout.trim(), "OK after timeout");
  } finally {
    await bridge.stop();
    cleanupDir(rootDir);
  }
});

test("9. Multiple Global Bridge instances mutual exclusion fails closed with exit code 1", async () => {
  const rootDir = createTempDir();
  const homeDir = path.join(rootDir, "home");
  const bridgeA = startGlobalBridge(homeDir);

  try {
    const lockBefore = await waitForCondition(() => readJsonIfExists(path.join(homeDir, "bridge.lock")));
    assert.equal(lockBefore.pid, bridgeA.child.pid);

    const secondBridge = spawnSync(process.execPath, [GLOBAL_BRIDGE_SCRIPT], {
      env: { ...process.env, DUAL_AGENT_HOME: homeDir },
      encoding: "utf8"
    });
    assert.equal(secondBridge.status, 1);
    assert.match(secondBridge.stderr, /Failed to acquire Global Bridge lock/);

    const lockAfter = readJsonIfExists(path.join(homeDir, "bridge.lock"));
    assert.equal(lockAfter.bridgeInstanceId, lockBefore.bridgeInstanceId);
  } finally {
    await bridgeA.stop();
    cleanupDir(rootDir);
  }
});

test("10. Legacy project migration compatibility, cross-project legacy ID isolation, nested roots, and dead submit.lock reclaim", async () => {
  const rootDir = createTempDir();
  const homeDir = path.join(rootDir, "home");
  const legacyProjA = createMockProject(rootDir, "LegacyProjA", true);
  const legacyProjB = createMockProject(rootDir, "LegacyProjB", true);
  const nestedProj = createMockProject(path.join(legacyProjA, "packages"), "NestedRepo", true);
  const outsideTarget = createMockProject(rootDir, "OutsideTarget", false);
  const workerPath = createEchoWorkerScript(rootDir);

  runClientSync(homeDir, ["register", "--project", legacyProjA]);
  runClientSync(homeDir, ["register", "--project", legacyProjB]);
  runClientSync(homeDir, ["register", "--project", nestedProj]);

  // Verify nested registered project selects deepest root (nestedProj rather than legacyProjA)
  const checkNested = JSON.parse(runClientSync(homeDir, ["check-project", "--project", nestedProj]).stdout);
  assert.equal(checkNested.projectRoot.toLowerCase(), nestedProj.toLowerCase());

  // Verify stale submit.lock from a dead PID (999999) is automatically reclaimed on submit
  fs.writeFileSync(
    path.join(homeDir, "queue", "submit.lock"),
    JSON.stringify({ pid: 999999, acquiredAt: new Date().toISOString() }),
    "utf8"
  );
  const subReclaimed = runClientSync(homeDir, ["submit", "--project", nestedProj, "--prompt", "Reclaimed submit.lock"]);
  assert.equal(subReclaimed.status, 0);

  // Verify invalid taskIds "." and ".." are rejected by client
  const badSubDot = runClientSync(homeDir, ["submit", "--project", nestedProj, "--task-id", ".", "--prompt", "Bad ID dot"]);
  assert.notEqual(badSubDot.status, 0);
  const badSub = runClientSync(homeDir, ["submit", "--project", nestedProj, "--task-id", "..", "--prompt", "Bad ID"]);
  assert.notEqual(badSub.status, 0);

  const bridge = startGlobalBridge(homeDir, {
    CODEX_BRIDGE_CMD: `"${process.execPath}" "${workerPath}"`,
    CODEX_TEST_FAIL_LEGACY_INGEST_ONCE: "1"
  });

  try {
    await waitForCondition(() => fs.existsSync(path.join(homeDir, "bridge.lock")));

    // Wait for the reclaimed submission on nestedProj
    const subReclaimedJson = JSON.parse(subReclaimed.stdout);
    const nestedRes = JSON.parse(
      runClientSync(homeDir, ["poll", "--task-id", subReclaimedJson.taskId, "--timeout-ms", "5000", "--interval-ms", "40"]).stdout
    );
    assert.equal(nestedRes.cwd.toLowerCase(), nestedProj.toLowerCase());

    // Forged manifest with external legacyCodexDir and unregistered project must NOT write status.json to outsideTarget
    fs.writeFileSync(
      path.join(homeDir, "queue", "pending", "0001-forged-legacy.json"),
      JSON.stringify({
        taskId: "task-forged-legacy",
        projectRoot: outsideTarget,
        legacyCodexDir: outsideTarget,
        mirrorLegacy: true
      }),
      "utf8"
    );
    await waitForCondition(() => {
      const st = readJsonIfExists(path.join(homeDir, "queue", "tasks", "task-forged-legacy", "status.json"));
      return st && st.state === "FAILED";
    });
    assert.equal(fs.existsSync(path.join(outsideTarget, "status.json")), false);

    // Two registered projects both trigger legacy pending.flag with the SAME legacy taskId ("task-shared-legacy")
    const legacyDirA = path.join(legacyProjA, ".agents", "codex");
    const legacyDirB = path.join(legacyProjB, ".agents", "codex");
    fs.mkdirSync(legacyDirA, { recursive: true });
    fs.mkdirSync(legacyDirB, { recursive: true });

    // Live submit.lock contention test: hold submit.lock with LIVE process.pid beyond bridge's 500ms timeout.
    // Bridge must NOT unlink a live submitter's submit.lock when acquireSubmitLock(500) times out!
    const submitLockPath = path.join(homeDir, "queue", "submit.lock");
    const bridgeLogPath = path.join(homeDir, "logs", "bridge.log");
    fs.writeFileSync(
      submitLockPath,
      JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }),
      "utf8"
    );
    fs.writeFileSync(path.join(legacyDirA, "request.md"), "Legacy A prompt", "utf8");
    fs.writeFileSync(path.join(legacyDirB, "request.md"), "Legacy B prompt", "utf8");
    fs.writeFileSync(path.join(legacyDirA, "pending.flag"), JSON.stringify({ taskId: "task-shared-legacy" }), "utf8");
    fs.writeFileSync(path.join(legacyDirB, "pending.flag"), JSON.stringify({ taskId: "task-shared-legacy" }), "utf8");

    // Deterministically wait until bridge.log records the acquireSubmitLock(500) timeout
    await waitForCondition(() => {
      if (!fs.existsSync(bridgeLogPath)) return false;
      return fs.readFileSync(bridgeLogPath, "utf8").includes("Could not acquire submit.lock");
    }, 4000);
    assert.equal(fs.existsSync(submitLockPath), true, "Live submit.lock must not be unlinked on ingestion timeout");
    assert.equal(readJsonIfExists(submitLockPath).pid, process.pid);
    assert.equal(fs.existsSync(path.join(legacyDirA, "pending.flag")), true);

    // Now simulate dead submitter PID in submit.lock so Bridge reclaims it and ingests both legacy tasks
    // Note: CODEX_TEST_FAIL_LEGACY_INGEST_ONCE="1" will cause the first ingestion write attempt to fail,
    // roll back its created taskDir, keep pending.flag intact, and succeed on the next tick.
    fs.writeFileSync(
      submitLockPath,
      JSON.stringify({ pid: 999999, acquiredAt: new Date().toISOString() }),
      "utf8"
    );

    const doneA = await waitForCondition(() => {
      const st = readJsonIfExists(path.join(legacyDirA, "status.json"));
      return st && st.taskId === "task-shared-legacy" && st.state === "DONE" ? st : null;
    });
    const doneB = await waitForCondition(() => {
      const st = readJsonIfExists(path.join(legacyDirB, "status.json"));
      return st && st.taskId === "task-shared-legacy" && st.state === "DONE" ? st : null;
    });
    assert.equal(doneA.state, "DONE");
    assert.equal(doneB.state, "DONE");
    assert.match(fs.readFileSync(bridgeLogPath, "utf8"), /Simulated write failure before publishing pending manifest/);

    const resA = JSON.parse(fs.readFileSync(path.join(legacyDirA, "result.task-shared-legacy.md"), "utf8"));
    const resB = JSON.parse(fs.readFileSync(path.join(legacyDirB, "result.task-shared-legacy.md"), "utf8"));
    assert.equal(resA.cwd.toLowerCase(), legacyProjA.toLowerCase());
    assert.equal(resA.prompt, "Legacy A prompt");
    assert.equal(resB.cwd.toLowerCase(), legacyProjB.toLowerCase());
    assert.equal(resB.prompt, "Legacy B prompt");
    assert.match(resA.taskId, /^legacy-/);
    assert.match(resB.taskId, /^legacy-/);
    assert.notEqual(resA.taskId, resB.taskId); // Distinct namespaced global taskIds!
    assert.equal(fs.existsSync(path.join(legacyDirA, "claimed.flag")), false);
    assert.equal(fs.existsSync(path.join(legacyDirB, "claimed.flag")), false);

    // Crash-window idempotency test: simulate a crash right after publishing pendingManifestPath
    // and BEFORE renaming pending.flag -> claimed.flag.
    fs.writeFileSync(
      submitLockPath,
      JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }),
      "utf8"
    );
    const checkA = JSON.parse(runClientSync(homeDir, ["check-project", "--project", legacyProjA]).stdout);
    const crashLegacyId = "task-crash-window";
    const crashGlobalId = `legacy-${checkA.entry.projectId}-${crashLegacyId}`;
    const crashFlagPath = path.join(legacyDirA, "pending.flag");
    fs.writeFileSync(path.join(legacyDirA, "request.md"), "Crash window prompt", "utf8");
    fs.writeFileSync(crashFlagPath, JSON.stringify({ taskId: crashLegacyId }), "utf8");
    const crashMtime = Math.trunc(fs.statSync(crashFlagPath).mtimeMs);
    const crashTaskDir = path.join(homeDir, "queue", "tasks", crashGlobalId);
    const crashPendingManifest = path.join(
      homeDir,
      "queue",
      "pending",
      `${String(crashMtime).padStart(13, "0")}-${crashGlobalId}.json`
    );
    fs.mkdirSync(crashTaskDir, { recursive: true });
    fs.writeFileSync(path.join(crashTaskDir, "request.md"), "Crash window prompt", "utf8");
    const crashManifestObj = {
      taskId: crashGlobalId,
      legacyTaskId: crashLegacyId,
      projectId: checkA.entry.projectId,
      projectRoot: checkA.projectRoot,
      submittedAt: new Date().toISOString(),
      mirrorLegacy: true
    };
    fs.writeFileSync(path.join(crashTaskDir, "meta.json"), JSON.stringify(crashManifestObj, null, 2), "utf8");
    fs.writeFileSync(crashPendingManifest, JSON.stringify(crashManifestObj, null, 2), "utf8");
    fs.unlinkSync(submitLockPath);

    const doneCrash = await waitForCondition(() => {
      const st = readJsonIfExists(path.join(legacyDirA, "status.json"));
      return st && st.taskId === crashLegacyId && st.state === "DONE" ? st : null;
    });
    assert.equal(doneCrash.state, "DONE");
    const allCrashTaskDirs = fs
      .readdirSync(path.join(homeDir, "queue", "tasks"))
      .filter(name => name.includes("task-crash-window"));
    assert.deepEqual(allCrashTaskDirs, [crashGlobalId], "Must not create a duplicate fallback task on crash-window recovery");
  } finally {
    await bridge.stop();
    cleanupDir(rootDir);
  }
});

