
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const ROOT = __dirname;
const DIR = path.join(ROOT, ".agents", "codex");

const REQUEST = path.join(DIR, "request.md");
const TRIGGER = path.join(DIR, "pending.flag");
const RESULT = path.join(DIR, "result.md");
const STATUS = path.join(DIR, "status.json");
const LOG = path.join(DIR, "bridge.log");

fs.mkdirSync(DIR, { recursive: true });

let busy = false;

function updateStatus(state, extra = {}) {
  fs.writeFileSync(
    STATUS,
    JSON.stringify({
      state,
      timestamp: new Date().toISOString(),
      ...extra
    }, null, 2),
    "utf8"
  );
}

async function checkTask() {
  if (busy || !fs.existsSync(TRIGGER)) return;
  busy = true;

  try {
    fs.unlinkSync(TRIGGER);

    const prompt = fs.readFileSync(REQUEST, "utf8").trim();
    if (!prompt) throw new Error("Empty task");

    fs.rmSync(RESULT, { force: true });
    updateStatus("RUNNING");

    console.log("Starting Codex task...");

    const command =
      "codex.cmd -c windows.sandbox=mxc exec " +
      "-C . " +
      "--sandbox read-only " +
      "--ephemeral " +
      "--output-last-message .agents/codex/result.md -";

    const child = spawn(
      "cmd.exe",
      ["/d", "/c", command],
      {
        cwd: ROOT,
        stdio: ["pipe", "pipe", "pipe"],
        windowsVerbatimArguments: true
      }
    );

    child.stdout.on("data", data => {
      fs.appendFileSync(LOG, data);
    });

    child.stderr.on("data", data => {
      fs.appendFileSync(LOG, data);
    });

    child.stdin.end(prompt + "\n");

    const exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });

    if (exitCode !== 0 || !fs.existsSync(RESULT)) {
      throw new Error(`Codex failed: exit ${exitCode}`);
    }

    updateStatus("DONE", { exitCode });
    console.log("Codex task finished.");

  } catch (error) {
    updateStatus("FAILED", { error: error.message });
    console.error(error.message);
  } finally {
    busy = false;
  }
}

console.log("Codex Bridge is running.");
console.log("Workspace:", ROOT);

setInterval(checkTask, 1000);
checkTask();
