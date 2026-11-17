// The one API every surface uses (CLI, MCP over stdio, MCP over HTTP, the onboarding page).

import { allAgents, getAgent } from "./agents/index.mjs";
import { isFinal, listJobs, patchJob, readJob, readOutput, startJob, waitJob } from "./jobs.mjs";
import * as mailbox from "./mailbox.mjs";
import { killTree } from "./spawn.mjs";
import { readSettings } from "./home.mjs";

/** How deep a chain of agents calling agents may go (A asks B asks C...). */
export const MAX_DEPTH = Number(process.env.CONNECT_ANYTHING_MAX_DEPTH || 2);
/** How many jobs may run at once, across every caller. A runaway loop hits this wall. */
export const MAX_RUNNING = Number(process.env.CONNECT_ANYTHING_MAX_RUNNING || 6);
// Many MCP clients give a tool call about 60 s, so never block longer than 50 s.
const clampWait = (s, d) => Math.min(50, Math.max(0, Number.isFinite(Number(s)) && s !== null && s !== undefined ? Number(s) : d));
/** A cloud job nobody has finished tracking after this long stops counting as running. */
const CLOUD_MAX_AGE_MS = 24 * 3600_000;

export async function listAgents() {
  const disabled = new Set(readSettings().disabled || []);
  return Promise.all(
    allAgents().map(async (a) => {
      let state;
      try {
        state = await a.detect();
      } catch (e) {
        state = { installed: false, ready: false, note: String(e.message || e) };
      }
      return { id: a.id, name: a.name, kind: a.kind, goodFor: a.goodFor, enabled: !disabled.has(a.id), readOnly: a.readOnly, ...state };
    }),
  );
}

export function describeAgents(list) {
  const lines = ["Agents you can call with `ask`:", ""];
  for (const a of list) {
    const mark = !a.enabled ? "off" : a.ready ? "ready" : a.installed ? "not ready" : "not installed";
    const ro = a.readOnly === "none" ? " No read-only mode: needs write: true." : "";
    lines.push(`- ${a.id} (${a.name}, ${a.kind}) — ${mark}. ${a.goodFor}${ro}${a.note ? ` [${a.note}]` : ""}`);
  }
  return lines.join("\n");
}

/** Start a job for `agent` and wait up to wait_s for its answer. */
export async function ask({ agent, prompt, cwd, model, write = false, repo, branch, wait_s, caller }) {
  const a = getAgent(agent);
  if (!a) throw new Error(`Unknown agent "${agent}". Call \`agents\` to see the ids.`);
  if (!prompt?.trim()) throw new Error("The prompt is empty.");
  if ((readSettings().disabled || []).includes(a.id)) throw new Error(`${a.name} is turned off in connect-anything settings.`);
  const depth = Number(process.env.CONNECT_ANYTHING_DEPTH || 0);
  if (depth >= MAX_DEPTH) {
    throw new Error(`Refused: this is already an agent called by an agent (depth ${depth}). connect-anything stops chains at depth ${MAX_DEPTH} so agents can't loop calling each other.`);
  }
  const running = listJobs({ limit: 200 }).filter((j) => !isFinal(j) && !stale(j)).length;
  if (running >= MAX_RUNNING) {
    throw new Error(`Refused: ${running} jobs are already running (limit ${MAX_RUNNING}). Wait for one to finish or cancel one.`);
  }
  const dir = cwd || process.cwd();
  if (a.readOnly === "none" && !write) {
    throw new Error(`${a.name} has no read-only mode, so connect-anything won't run it as read-only. Pass write: true only if the user is fine with it changing files and running commands in ${dir}.`);
  }
  const state = await a.detect();
  if (!state.installed) throw new Error(`${a.name} is not installed. ${a.install || ""}`.trim());
  if (!state.ready) throw new Error(`${a.name} is not ready: ${state.note || "sign in first"}. ${a.signIn || ""}`.trim());
  const job = startJob({ agent: a.id, kind: a.kind, prompt, cwd: dir, model: model || null, write: !!write, repo: repo || null, branch: branch || null, caller: caller || null, depth: depth + 1 });
  return (await getJob(job.id, clampWait(wait_s, 45))) || job;
}

/** A job whose runner died without finishing (machine restart, killed process). */
function stale(job) {
  if (job.kind === "cloud" && !job.pid && job.remoteId) return Date.now() - Date.parse(job.createdAt) > CLOUD_MAX_AGE_MS;
  if (!job.pid) return job.status === "queued" && Date.now() - Date.parse(job.createdAt) > 120_000;
  try {
    process.kill(job.pid, 0);
    return false;
  } catch {
    return true;
  }
}

export async function getJob(id, wait_s = 0) {
  const w = clampWait(wait_s, 0);
  let job = await waitJob(id, 0);
  const end = Date.now() + w * 1000;
  // A cloud job that has started remotely is read from its provider; otherwise wait on the runner.
  while (job && !isFinal(job)) {
    if (job.kind === "cloud" && job.remoteId) {
      job = await pollCloud(job);
    } else if (stale(job)) {
      job = patchJob(id, { status: "failed", error: "The job's runner stopped before it finished (restart or killed)." });
    }
    if (isFinal(job) || Date.now() >= end) break;
    await new Promise((r) => setTimeout(r, 1000));
    job = (await waitJob(id, 0)) || job;
  }
  return job;
}

/** Read a cloud job's status from its provider, at most every 20 s. */
async function pollCloud(job) {
  if (job.lastPoll && Date.now() - job.lastPoll < 20_000) return job;
  const a = getAgent(job.agent);
  try {
    const r = await a.poll(job);
    return patchJob(job.id, { ...r, lastPoll: Date.now(), ...(isFinal(r) ? { endedAt: new Date().toISOString() } : {}) });
  } catch (e) {
    return patchJob(job.id, { lastPoll: Date.now(), progress: `Could not read status: ${String(e?.message || e).slice(0, 300)}` });
  }
}

export function recentJobs(limit = 15) {
  return listJobs({ limit });
}

export function describeJob(job) {
  if (!job) return "No such job.";
  const head = `Job ${job.id} — ${job.agent} — ${job.status}${job.url ? ` — ${job.url}` : ""}`;
  if (job.status === "done") return `${head}\n\n${job.result ?? readOutput(job.id)}`;
  if (job.status === "failed") {
    const out = readOutput(job.id, { tail: 2000 });
    return `${head}\n\n${job.error || "failed"}${out && !job.error ? `\nLast output:\n${out}` : ""}`;
  }
  if (job.status === "cancelled") return head;
  const progress = job.progress ? `\n${job.progress}` : "";
  return `${head}${progress}\nStill working. Check again with job {"id": "${job.id}", "wait_s": 45}.`;
}

export function describeJobs(jobs) {
  if (!jobs.length) return "No jobs yet.";
  return jobs.map((j) => `- ${j.id}  ${j.status.padEnd(9)} ${j.agent.padEnd(12)} ${j.prompt.replace(/\s+/g, " ").slice(0, 70)}`).join("\n");
}

export async function cancel(id) {
  const job = readJob(id);
  if (!job) return `No job ${id}.`;
  if (isFinal(job)) return `Job ${id} already ${job.status}.`;
  const a = getAgent(job.agent);
  let note = "";
  if (job.kind === "cloud" && a?.cancel) note = (await a.cancel(job).catch((e) => String(e.message || e))) || "";
  if (job.pid) killTree({ pid: job.pid });
  patchJob(id, { status: "cancelled", error: note || null, pid: null });
  return `Cancelled ${id}.${note ? " " + note : ""}${job.kind === "cloud" && !note ? " The cloud session may keep running; stop it on the provider's site." : ""}`;
}

export const send = (args) => mailbox.send(args);
export const inbox = (args) => mailbox.inbox(args);
