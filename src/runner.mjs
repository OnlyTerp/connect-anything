// The detached process that runs one job: `connect-anything _run <id>`.

import { writeFileSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { getAgent } from "./agents/index.mjs";
import { appendOutput, jobsDir, patchJob, readJob } from "./jobs.mjs";
import { run } from "./spawn.mjs";

const PREAMBLE =
  "[You were called by another AI agent through connect-anything. You have none of its context beyond this message. Do the task and put your complete answer in your final message.]\n\n";

/** Local jobs end after this long unless CONNECT_ANYTHING_TIMEOUT_MIN says otherwise. */
const TIMEOUT_MIN = Number(process.env.CONNECT_ANYTHING_TIMEOUT_MIN || 30);

export async function runJob(id) {
  const job = readJob(id);
  if (!job) return;
  const agent = getAgent(job.agent);
  patchJob(id, { status: "running", pid: process.pid, startedAt: new Date().toISOString() });
  try {
    if (agent.kind === "cloud") {
      const started = await agent.start(job);
      if (!started.runner) {
        patchJob(id, { status: "running", pid: null, ...started, lastPoll: Date.now() });
        return;
      }
    }
    await runLocal(job, agent);
  } catch (e) {
    patchJob(id, { status: "failed", error: String(e?.message || e), pid: null, endedAt: new Date().toISOString() });
  }
}

async function runLocal(job, agent) {
  const promptFile = path.join(jobsDir(), job.id, "prompt.txt");
  const prompt = PREAMBLE + job.prompt;
  writeFileSync(promptFile, prompt);
  const c = agent.command?.() ?? getAgent(agent.id.replace(/-cloud$/, ""))?.command();
  if (!c) throw new Error(`${agent.name} is not installed.`);
  const spec = agent.build({ prompt, promptFile, model: job.model, write: job.write, cwd: job.cwd });
  const env = { ...process.env, CONNECT_ANYTHING_DEPTH: String(job.depth || 1), CONNECT_ANYTHING_CALLER: job.agent };
  for (const k of spec.unsetEnv || []) delete env[k];
  const r = await run(c.command, [...c.prefix, ...spec.args], {
    input: spec.stdin ? prompt : undefined,
    cwd: job.cwd,
    env,
    replaceEnv: true,
    timeoutMs: TIMEOUT_MIN * 60_000,
    onStdout: (d) => appendOutput(job.id, d),
  });
  if (r.stderr) writeFileSync(path.join(jobsDir(), job.id, "stderr.txt"), r.stderr);
  const parsed = agent.parse(r.stdout);
  const ended = new Date().toISOString();
  if (r.timedOut) {
    patchJob(job.id, { status: "failed", error: `Stopped after ${TIMEOUT_MIN} minutes.`, pid: null, endedAt: ended });
  } else if (parsed.error || (r.code !== 0 && !parsed.text)) {
    const why = parsed.error || lastLine(r.stderr) || `exited with code ${r.code}`;
    patchJob(job.id, { status: "failed", error: why, pid: null, endedAt: ended });
  } else if (!String(parsed.text ?? "").trim()) {
    // An empty answer is a failure the caller should see, with whatever the agent printed to stderr.
    const why = lastLine(r.stderr);
    patchJob(job.id, { status: "failed", error: `${agent.name} finished without an answer.${why ? ` It said: ${why}` : ""}`, pid: null, endedAt: ended });
  } else {
    patchJob(job.id, { status: "done", result: parsed.text, meta: parsed.meta || null, pid: null, endedAt: ended });
  }
}

const lastLine = (s) =>
  (s || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-3)
    .join("\n");

/** `connect-anything _tty <id>`: run a cloud CLI that needs a terminal, inside the terminal we opened. */
export async function runTty(id) {
  let job;
  for (let i = 0; i < 30; i++) {
    job = readJob(id);
    if (job?.ttyCommand) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!job?.ttyCommand) {
    console.error("connect-anything: this job has nothing to run in a terminal.");
    return;
  }
  console.log(`connect-anything: starting ${job.agent} for job ${id}\n`);
  const { command, args } = job.ttyCommand;
  const child = spawn(command, args, { cwd: job.cwd, stdio: "inherit", shell: false });
  await new Promise((r) => child.on("close", r));
  // Keep the window readable for a moment before it closes.
  console.log("\nconnect-anything: you can close this window. The cloud session keeps running.");
  await new Promise((r) => setTimeout(r, 15_000));
}

export { run };
