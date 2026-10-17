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

// This worker obeys mode/cwd. Tests cover authorization and dispatch, not an
// OS sandbox for hostile custom commands (CODEX_BRIDGE_CMD bypasses Codex).
function createWorkflowWorker(dir) {
  const worker = path.join(dir, 'worker.cjs');
  fs.writeFileSync(worker, `
    const fs = require('node:fs');
    const { spawnSync } = require('node:child_process');
    let prompt = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => prompt += chunk);
    process.stdin.on('end', () => {
      const e = process.env;
      if (prompt.trim() === 'simulate-quota-limit') {
        console.error('ERROR: You have hit your usage limit. Try again at 5:57 PM.');
        process.exit(1);
      }
      let unitTests = null;
      if (e.CODEX_TASK_MODE === 'write') {
        fs.mkdirSync('src', { recursive: true });
        fs.writeFileSync('src/add.cjs', prompt.trim() === 'introduce-bug'
          ? 'module.exports = (a, b) => a - b;'
          : 'module.exports = (a, b) => a + b;');
        fs.writeFileSync('unit.test.cjs', "const test = require('node:test'); const assert = require('node:assert/strict'); test('adds', () => assert.equal(require('./src/add.cjs')(2, 3), 5));");
        // Start an independent test runner instead of inheriting the outer runner context.
        unitTests = spawnSync(process.execPath, ['--test', 'unit.test.cjs'], {
          env: { ...process.env, NODE_TEST_CONTEXT: undefined }, encoding: 'utf8'
        }).status;
        if (prompt.trim() !== 'introduce-bug' && unitTests !== 0) process.exit(9);
      }
      fs.writeFileSync(e.CODEX_RESULT_FILE, JSON.stringify({
        protocolStatus: ['TECHNICAL_ESCALATION', 'TECHNICAL_DECISION'].includes(e.CODEX_TASK_TYPE)
          ? 'TECHNICAL_DECISION' : e.CODEX_TASK_MODE === 'write' ? 'IMPLEMENTATION_COMPLETE' : 'ACCEPTED',
        cwd: process.cwd(), projectRoot: e.CODEX_PROJECT_ROOT,
        mode: e.CODEX_TASK_MODE, taskType: e.CODEX_TASK_TYPE,
        effort: e.CODEX_REASONING_EFFORT, model: e.CODEX_MODEL,
        sessionId: e.CODEX_SESSION_ID, previousTaskId: e.CODEX_PREV_SESSION_TASK_ID, prompt: prompt.trim(),
        retryCount: Number(e.CODEX_RETRY_COUNT), escalationRound: Number(e.CODEX_ESCALATION_ROUND), unitTests
      }));
    });
  `);
  return worker;
}

async function fixture(t, defaultCommand = false) {
  const root = createTempDir('dual-agent-t008-');
  const home = path.join(root, 'home');
  const a = createMockProject(root, 'ProjectA');
  const b = createMockProject(root, 'ProjectB');
  const worker = createWorkflowWorker(root);
  fs.writeFileSync(path.join(root, 'codex.cmd'), `@"${process.execPath}" "${worker}" %*\r\n`);
  const bridge = startGlobalBridge(home, {
    CODEX_BRIDGE_CMD: defaultCommand ? '' : `"${process.execPath}" "${worker}"`,
    PATH: `${root}${path.delimiter}${process.env.PATH}`, CODEX_BRIDGE_TIMEOUT_MS: '8000'
  });
  t.after(async () => { await bridge.stop(); cleanupDir(root); });
  await waitForCondition(() => fs.existsSync(path.join(home, 'bridge.lock')));
  const client = (args, code = 0) => {
    const r = runClientSync(home, args);
    assert.equal(r.error, undefined);
    assert.equal(r.status, code, `${args.join(' ')}\n${r.stderr}\n${r.stdout}`);
    return r;
  };
  const json = args => JSON.parse(client(args).stdout);
  const status = id => readJsonIfExists(path.join(home, 'queue', 'tasks', id, 'status.json'));
  const submit = (project, options = [], prompt = 'implement') => json([
    'submit', '--project', project, '--prompt', prompt, ...options
  ]);
  const complete = async sub => {
    const st = await waitForCondition(() => {
      const s = status(sub.taskId);
      return s && ['DONE', 'FAILED'].includes(s.state) ? s : null;
    }, 12000);
    assert.equal(st.state, 'DONE', JSON.stringify(st));
    const result = JSON.parse(client(['poll', '--task-id', sub.taskId, '--timeout-ms', '2000']).stdout);
    return { st, result };
  };
  const forge = async (id, project, fields, error) => {
    const dir = path.join(home, 'queue', 'tasks', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'request.md'), 'implement');
    fs.writeFileSync(path.join(home, 'queue', 'pending', `0000-${id}.json`),
      JSON.stringify({ taskId: id, projectRoot: project, ...fields }));
    const st = await waitForCondition(() => { const s = status(id); return s && s.state === 'FAILED' ? s : null; });
    assert.match(st.error, error);
    assert.equal(fs.existsSync(path.join(dir, 'result.md')), false);
    assert.equal(fs.existsSync(path.join(project, 'src')), false);
  };
  return { root, home, a, b, client, json, submit, complete, forge };
}

test('T008 Test 1: authorize, check, execute source changes and unit tests, revoke', async t => {
  const f = await fixture(t);
  const registered = f.json(['register', '--project', f.a]).project;
  assert.equal(registered.sandbox, 'read-only');
  assert.equal(registered.lastSessionId, null);
  const authorized = f.json(['authorize-write', '--project', f.a]).project;
  assert.equal(authorized.writeAuthorized, true);
  assert.equal(authorized.sandbox, 'workspace-write');
  assert.equal(f.json(['register', '--project', f.a]).project.sandbox, 'workspace-write');
  assert.equal(f.json(['check-project', '--project', f.a, '--mode', 'write']).writeAuthorized, true);
  const source = path.join(f.a, 'src', 'add.cjs');
  const first = await f.complete(f.submit(f.a, ['--mode', 'write']));
  assert.equal(first.result.unitTests, 0);
  assert.equal(first.result.mode, 'write');
  assert.match(fs.readFileSync(source, 'utf8'), /a \+ b/);
  fs.writeFileSync(source, 'module.exports = () => 0;');
  const second = await f.complete(f.submit(f.a, ['--mode', 'write']));
  assert.equal(second.result.unitTests, 0);
  assert.match(fs.readFileSync(source, 'utf8'), /a \+ b/);
  const revoked = f.json(['revoke-write', '--project', f.a]).project;
  assert.equal(revoked.writeAuthorized, false);
  assert.equal(revoked.sandbox, 'read-only');
  f.client(['check-project', '--project', f.a, '--mode', 'write'], 4);
  assert.match(f.client(['submit', '--project', f.a, '--mode', 'write', '--prompt', 'denied'], 4).stderr, /WRITE_NOT_AUTHORIZED/);
});

test('T008 Test 2: client and forged queue denial; Trusted Roots default to read-only', async t => {
  const f = await fixture(t);
  f.json(['register', '--project', f.a]);
  assert.match(f.client(['submit', '--project', f.a, '--mode', 'write', '--prompt', 'denied'], 4).stderr, /WRITE_NOT_AUTHORIZED/);
  await f.forge('task-forged-write', f.a, { mode: 'write' }, /Write mode is not authorized/);
  f.json(['trust-root', '--path', f.root]);
  const read = f.submit(f.b);
  assert.equal(read.autoRegistered, true);
  await f.complete(read);
  const entry = readJsonIfExists(path.join(f.home, 'projects.json')).projects.find(p => p.projectId === read.projectId);
  assert.equal(entry.autoRegistered, true);
  assert.equal(entry.writeAuthorized, false);
  f.client(['check-project', '--project', f.b, '--mode', 'write'], 4);
  assert.match(f.client(['submit', '--project', f.b, '--mode', 'write', '--prompt', 'denied'], 4).stderr, /WRITE_NOT_AUTHORIZED/);
  await f.forge('task-forged-auto-write', f.b, { mode: 'write' }, /Write mode is not authorized/);
  f.json(['authorize-write', '--project', f.b]);
  assert.equal((await f.complete(f.submit(f.b, ['--mode', 'write']))).result.unitTests, 0);
});

test('T008 Test 3: write permission and read execution are isolated across projects', async t => {
  const f = await fixture(t);
  for (const p of [f.a, f.b]) f.json(['register', '--project', p]);
  f.json(['authorize-write', '--project', f.a]);
  assert.equal(f.json(['check-project', '--project', f.a]).writeAuthorized, true);
  assert.equal(f.json(['check-project', '--project', f.b]).writeAuthorized, false);
  const sentinel = path.join(f.b, 'sentinel.txt');
  fs.writeFileSync(sentinel, 'unchanged');
  assert.match(f.client(['submit', '--project', f.b, '--mode', 'write', '--prompt', 'denied'], 4).stderr, /WRITE_NOT_AUTHORIZED/);
  const write = await f.complete(f.submit(f.a, ['--mode', 'write']));
  assert.equal(write.result.cwd.toLowerCase(), f.a.toLowerCase());
  assert.equal(write.result.projectRoot.toLowerCase(), f.a.toLowerCase());
  assert.equal(fs.existsSync(path.join(f.a, 'src', 'add.cjs')), true);
  assert.equal(fs.existsSync(path.join(f.b, 'src')), false);
  for (const p of [f.a, f.b]) {
    const read = await f.complete(f.submit(p));
    assert.equal(read.result.mode, 'read');
    assert.equal(read.result.cwd.toLowerCase(), p.toLowerCase());
  }
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'unchanged');
  assert.equal(fs.existsSync(path.join(f.b, 'unit.test.cjs')), false);
});

test('T008 Test 4: Stage A implement -> B detect -> C fix request -> D verify', async t => {
  const f = await fixture(t);
  f.json(['authorize-write', '--project', f.a]);
  const session = ['--session-id', 't008-closed-loop'];
  const initial = await f.complete(f.submit(f.a, ['--mode', 'write', '--task-type', 'IMPLEMENT', ...session], 'introduce-bug'));
  assert.equal(initial.st.protocolStatus, 'IMPLEMENTATION_COMPLETE');
  assert.equal(initial.st.taskType, 'IMPLEMENT');
  // Deterministic stand-in for Gemini's independent host verification.
  const verify = () => spawnSync(process.execPath, ['--test', 'unit.test.cjs'], {
    cwd: f.a, env: { ...process.env, NODE_TEST_CONTEXT: undefined }, encoding: 'utf8'
  });
  assert.equal(verify().status, 1);
  const fix = await f.complete(f.submit(f.a, ['--mode', 'write', '--task-type', 'FIX_REQUEST', '--retry-count', '1', ...session], 'fix addition: expected 5, got -1'));
  assert.equal(fix.st.taskType, 'FIX_REQUEST');
  assert.equal(fix.st.retryCount, 1);
  assert.equal(fix.result.retryCount, 1);
  assert.equal(fix.st.protocolStatus, 'IMPLEMENTATION_COMPLETE');
  assert.equal(fix.st.sessionId, 't008-closed-loop');
  assert.equal(fix.st.sessionId, initial.st.sessionId);
  assert.equal(verify().status, 0);
});

test('T008 Test 5: bounded retries accepted at 0..3, rejected outside bounds by client and bridge', async t => {
  const f = await fixture(t);
  f.json(['authorize-write', '--project', f.a]);
  await f.forge('task-forged-retry', f.a, { mode: 'write', taskType: 'FIX_REQUEST', retryCount: 4 }, /RETRY_LIMIT_EXCEEDED/);
  for (const count of [0, 1, 2, 3]) {
    const done = await f.complete(f.submit(f.a, ['--mode', 'write', '--task-type', 'FIX_REQUEST', '--retry-count', String(count)]));
    assert.equal(done.st.retryCount, count);
    assert.equal(done.result.retryCount, count);
  }
  for (const count of ['4', '-1']) {
    assert.match(f.client(['submit', '--project', f.a, '--mode', 'write', '--prompt', 'fix', '--retry-count', count], 5).stderr, /RETRY_LIMIT_EXCEEDED/);
  }
});

test('T008 Test 6: escalation rounds 1..2 and technical decisions persist; round 3 rejected', async t => {
  const f = await fixture(t);
  f.json(['register', '--project', f.a]);
  for (const round of [1, 2]) {
    for (const type of ['TECHNICAL_ESCALATION', 'TECHNICAL_DECISION']) {
      const done = await f.complete(f.submit(f.a, ['--task-type', type, '--escalation-round', String(round)]));
      assert.equal(done.st.protocolStatus, 'TECHNICAL_DECISION');
      assert.equal(done.st.taskType, type);
      assert.equal(done.st.escalationRound, round);
      assert.equal(done.result.escalationRound, round);
    }
  }
  assert.match(f.client(['submit', '--project', f.a, '--prompt', 'escalate', '--task-type', 'TECHNICAL_ESCALATION', '--escalation-round', '3'], 6).stderr, /ESCALATION_LIMIT_EXCEEDED/);
});

test('T008 Test 7: per-project session reuse (--reuse-session) and cross-project session isolation', async t => {
  const f = await fixture(t);
  for (const p of [f.a, f.b]) f.json(['register', '--project', p]);
  const entry = id => readJsonIfExists(path.join(f.home, 'projects.json')).projects.find(p => p.projectId === id);
  const firstA = f.submit(f.a, ['--reuse-session']);
  const a1 = await f.complete(firstA);
  assert.ok(a1.st.sessionId.startsWith(`${firstA.projectId}-s-`));
  assert.match(a1.st.sessionId, /-s-\d+$/);
  assert.equal(a1.result.sessionId, a1.st.sessionId);
  assert.equal(a1.result.previousTaskId, '');
  assert.equal(entry(firstA.projectId).lastSessionId, a1.st.sessionId);
  const secondA = f.submit(f.a, ['--reuse-session']);
  const a2 = await f.complete(secondA);
  assert.equal(a2.st.sessionId, a1.st.sessionId);
  assert.equal(a2.result.previousTaskId, firstA.taskId);
  assert.equal(a2.result.prompt, 'implement'); // Custom workers receive the unchanged prompt.

  const firstB = f.submit(f.b, ['--reuse-session']);
  const b1 = await f.complete(firstB);
  assert.ok(b1.st.sessionId.startsWith(`${firstB.projectId}-s-`));
  assert.notEqual(b1.st.sessionId, a1.st.sessionId);
  assert.equal(b1.result.previousTaskId, '');
  assert.equal(entry(firstB.projectId).lastSessionId, b1.st.sessionId);
  const b2 = await f.complete(f.submit(f.b, ['--reuse-session']));
  assert.equal(b2.st.sessionId, b1.st.sessionId);
  assert.equal(b2.result.previousTaskId, firstB.taskId);

  // Explicit equal strings must not bridge project boundaries; explicit wins over reuse.
  const sharedA = f.submit(f.a, ['--session-id', 'explicit-shared', '--reuse-session']);
  const sharedAResult = await f.complete(sharedA);
  assert.equal(sharedAResult.result.sessionId, 'explicit-shared');
  assert.equal(sharedAResult.result.previousTaskId, '');
  const sharedB = f.submit(f.b, ['--session-id', 'explicit-shared']);
  assert.equal((await f.complete(sharedB)).result.previousTaskId, '');
  assert.equal(entry(firstA.projectId).lastSessionId, 'explicit-shared');
  assert.equal(entry(firstB.projectId).lastSessionId, 'explicit-shared');

  // Newer failed/incomplete tasks, missing results, and mismatched identities are ineligible.
  const seed = (id, metaPatch = {}, statusPatch = {}, result = true) => {
    const dir = path.join(f.home, 'queue', 'tasks', id);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
      taskId: id, projectRoot: f.a, projectId: firstA.projectId,
      sessionId: 'explicit-shared', taskType: 'REVIEW', ...metaPatch
    }));
    fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({
      taskId: id, state: 'DONE', timestamp: '2099-01-01T00:00:00.000Z', ...statusPatch
    }));
    if (result) fs.writeFileSync(path.join(dir, 'result.md'), 'MUST NOT LEAK');
  };
  seed('failed-history', {}, { state: 'FAILED' });
  seed('running-history', {}, { state: 'RUNNING' });
  seed('missing-result-history', {}, {}, false);
  seed('wrong-id-history', { projectId: firstB.projectId });
  seed('wrong-root-history', { projectRoot: f.b });
  seed('wrong-session-history', { sessionId: 'unrelated' });
  const run = f.json(['run', '--project', f.a, '--reuse-session', '--prompt', 'exact prompt', '--interval-ms', '40']);
  assert.equal(run.sessionId, 'explicit-shared');
  assert.equal(run.previousTaskId, sharedA.taskId);
  assert.equal(run.prompt, 'exact prompt');

  const sessionless = await f.complete(f.submit(f.a));
  assert.equal(sessionless.st.sessionId, null);
  assert.equal(sessionless.result.sessionId, '');
  assert.equal(sessionless.result.previousTaskId, '');
  assert.equal(sessionless.result.mode, 'read');
  assert.equal(entry(firstA.projectId).lastSessionId, 'explicit-shared');
});

test('T008 Test 8: default Codex command prepends at most 1200 characters of completed session context', async t => {
  const f = await fixture(t, true);
  f.json(['register', '--project', f.a]);
  const first = f.submit(f.a, ['--reuse-session'], 'x'.repeat(2000));
  const previous = await f.complete(first);
  assert.equal(previous.result.prompt, 'x'.repeat(2000));
  const current = await f.complete(f.submit(f.a, ['--reuse-session'], 'current prompt'));
  const header = `[Session Context: sessionId=${previous.st.sessionId}, previousTaskId=${first.taskId}, taskType=REVIEW]\n`;
  const separator = '\n---\n';
  const raw = fs.readFileSync(path.join(f.home, 'queue', 'tasks', first.taskId, 'result.md'), 'utf8');
  assert.equal(current.result.prompt, header + raw.slice(0, 1200 - header.length - separator.length) + separator + 'current prompt');
  assert.equal(current.result.previousTaskId, first.taskId);
});

test('T008 Test 9: dynamic effort/model selection and FALLBACK_TO_GEMINI (exit 7) on quota/rate limits', async t => {
  const f = await fixture(t);
  f.json(['authorize-write', '--project', f.a]);

  // 1. Default effort scaling by task complexity
  const verifyTask = await f.complete(f.submit(f.a, ['--mode', 'read', '--task-type', 'VERIFY']));
  assert.equal(verifyTask.st.effort, 'low');
  assert.equal(verifyTask.result.effort, 'low');

  const implTask = await f.complete(f.submit(f.a, ['--mode', 'write', '--task-type', 'IMPLEMENT']));
  assert.equal(implTask.st.effort, 'medium');
  assert.equal(implTask.result.effort, 'medium');

  const escTask = await f.complete(f.submit(f.a, ['--mode', 'read', '--task-type', 'TECHNICAL_ESCALATION', '--escalation-round', '1']));
  assert.equal(escTask.st.effort, 'high');
  assert.equal(escTask.result.effort, 'high');

  // 2. Explicit --effort and --model overrides
  const customEffort = await f.complete(f.submit(f.a, ['--mode', 'write', '--task-type', 'IMPLEMENT', '--effort', 'low', '--model', 'gpt-6-astra']));
  assert.equal(customEffort.st.effort, 'low');
  assert.equal(customEffort.result.effort, 'low');
  assert.equal(customEffort.st.model, 'gpt-6-astra');
  assert.equal(customEffort.result.model, 'gpt-6-astra');

  // 3. Quota / rate-limit failure triggers FALLBACK_TO_GEMINI and exits with code 7
  const quotaSub = f.submit(f.a, ['--mode', 'write', '--task-type', 'IMPLEMENT'], 'simulate-quota-limit');
  const pollQuota = f.client(['poll', '--task-id', quotaSub.taskId, '--timeout-ms', '5000', '--interval-ms', '40'], 7);
  assert.match(pollQuota.stderr, /\[STATUS: FALLBACK_TO_GEMINI\]/);
  const quotaStatus = f.json(['status', '--task-id', quotaSub.taskId]);
  assert.equal(quotaStatus.taskStatus.fallbackToGemini, true);
  assert.equal(quotaStatus.taskStatus.protocolStatus, 'FALLBACK_TO_GEMINI');
  assert.equal(quotaStatus.globalStatus.fallbackToGemini, true);

  // 4. clear-fallback resets global fallback flag
  const cleared = f.json(['clear-fallback']);
  assert.equal(cleared.status, 'FALLBACK_CLEARED');
  assert.equal(cleared.globalStatus.fallbackToGemini, false);
});


