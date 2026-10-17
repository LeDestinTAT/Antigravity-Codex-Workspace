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
        retryCount: Number(e.CODEX_RETRY_COUNT), escalationRound: Number(e.CODEX_ESCALATION_ROUND), unitTests
      }));
    });
  `);
  return worker;
}

async function fixture(t) {
  const root = createTempDir('dual-agent-t008-');
  const home = path.join(root, 'home');
  const a = createMockProject(root, 'ProjectA');
  const b = createMockProject(root, 'ProjectB');
  const worker = createWorkflowWorker(root);
  const bridge = startGlobalBridge(home, {
    CODEX_BRIDGE_CMD: `"${process.execPath}" "${worker}"`, CODEX_BRIDGE_TIMEOUT_MS: '8000'
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
  f.json(['register', '--project', f.a]);
  assert.equal(f.json(['authorize-write', '--project', f.a]).project.writeAuthorized, true);
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
  assert.equal(f.json(['revoke-write', '--project', f.a]).project.writeAuthorized, false);
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

