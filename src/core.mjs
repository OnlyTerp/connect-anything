// The one API every surface uses (CLI, MCP over stdio, MCP over HTTP, the onboarding page).

import { AGENTS, getAgent } from "./agents/index.mjs";
import { isFinal, listJobs, patchJob, readJob, readOutput, startJob, waitJob } from "./jobs.mjs";
import * as mailbox from "./mailbox.mjs";
import { killTree } from "./spawn.mjs";
import { readSettings } from "./home.mjs";

/** How deep a chain of agents calling agents may go (A asks B asks C...). */
export const MAX_DEPTH = Number(process.env.CONNECT_ANYTHING_MAX_DEPTH || 2);
/** How many jobs may run at once, across every caller. A runaway loop hits this wall. */
export const MAX_RUNNING = Number(process.env.CONNECT_ANYTHING_MAX_RUNNING || 6);

const clampWait = (s, d) => Math.min(110, Math.max(0, Number.isFinite(s) ? s : d));

export async function listAgents() {
  const disabled = new Set(readSettings().disabled || []);
  const out = [];
  for (const a of AGENTS) {
    let state;
    try {
      state = await a.detect();
    } catch (e) {
      state = { installed: false, ready: false, note: String(e.message || e) };
    }
    out.push({
      id: a.id,
      name: a.name,
      kind: a.kind,
      goodFor: a.goodFor,
      enabled: !disabled.has(a.id),
      ...state,
    });
  }
  return out;
}

export function describeAgents(list) {
  const lines = ["Agents you can call with `ask` (ready = installed and signed in):", ""];
  for (const a of list) {
    const mark = !a.enabled ? "off" : a.ready ? "ready" : a.installed ? "not signed in" : "not installed";
    lines.push(`- ${a.id} (${a.name}, ${a.kind}) — ${mark}. ${a.goodFor}${a.note ? ` [${a.note}]` : ""}`);
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
    throw new Error(
      `Refused: this is already an agent called by an agent (depth ${depth}). connect-anything stops chains at depth ${MAX_DEPTH} so agents can't loop calling each other.`,
    );
  }
  const running = listJobs({ limit: 200 }).filter((j) => !isFinal(j) && !stale(j)).length;
  if (running >= MAX_RUNNING) {
    throw new Error(`Refused: ${running} jobs are already running (limit ${MAX_RUNNING}). Wait for one to finish or cancel one.`);
  }
  const state = await a.detect();
  if (!state.installed) throw new Error(`${a.name} is not installed. ${a.install || ""}`.trim());
  if (!state.ready) throw new Error(`${a.name} is not ready: ${state.note || "sign in first"}. ${a.signIn || ""}`.trim());
  const job = startJob({
    agent: a.id,
    kind: a.kind,
    prompt,
    cwd: cwd || process.cwd(),
    model: model || null,
    write: !!write,
    repo: repo || null,
    branch: branch || null,
    caller: caller || null,
    depth: depth + 1,
  });
  return (await waitJob(job.id, clampWait(wait_s, 45))) || job;
}

/** A job whose runner died without finishing (machine restart, killed process). */
function stale(job) {
  if (job.kind === "cloud") return false;
  if (!job.pid) return Date.now() - Date.parse(job.createdAt) > 120_000 && job.status === "queued";
  try {
    process.kill(job.pid, 0);
    return false;
  } catch {
    return true;
  }
}

export async function getJob(id, wait_s = 0) {
  let job = await waitJob(id, clampWait(wait_s, 0));
  if (job && !isFinal(job) && stale(job)) {
    job = patchJob(id, { status: "failed", error: "The job's runner stopped before it finished (restart or killed)." });
  }
  return job;
}

export function recentJobs(limit = 15) {
  return listJobs({ limit });
}

export function describeJob(job) {
  if (!job) return "No such job.";
  const head = `Job ${job.id} — ${job.agent} — ${job.status}${job.url ? ` — ${job.url}` : ""}`;
  if (job.status === "done") return `${head}\n\n${job.result ?? readOutput(job.id)}`;
  if (job.status === "failed") return `${head}\n\n${job.error || "failed"}\n${tail(readOutput(job.id, { tail: 3000 }))}`;
  if (job.status === "cancelled") return head;
  const progress = job.progress ? `\n${job.progress}` : "";
  return `${head}${progress}\nStill working. Check again with job {"id": "${job.id}", "wait_s": 60}.`;
}

const tail = (s) => (s ? `Last output:\n${s}` : "");

export function describeJobs(jobs) {
  if (!jobs.length) return "No jobs yet.";
  return jobs
    .map((j) => `- ${j.id}  ${j.status.padEnd(9)} ${j.agent.padEnd(12)} ${j.prompt.replace(/\s+/g, " ").slice(0, 70)}`)
    .join("\n");
}

export async function cancel(id) {
  const job = readJob(id);
  if (!job) return `No job ${id}.`;
  if (isFinal(job)) return `Job ${id} already ${job.status}.`;
  const a = getAgent(job.agent);
  let note = "";
  if (job.kind === "cloud" && a?.cancel) note = (await a.cancel(job).catch((e) => String(e.message || e))) || "";
  if (job.pid) killTree({ pid: job.pid });
  patchJob(id, { status: "cancelled", error: note || null });
  return `Cancelled ${id}.${note ? " " + note : ""}`;
}

export const send = (args) => mailbox.send(args);
export const inbox = (args) => mailbox.inbox(args);
