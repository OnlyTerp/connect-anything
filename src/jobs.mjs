// Jobs: every call to another agent is a job with an id, stored as files so the CLI, the MCP
// server and the onboarding page all see the same thing, and a restart loses nothing.
//
//   <home>/jobs/<id>/job.json     what was asked, who runs it, status, result
//   <home>/jobs/<id>/output.txt   the agent's raw output as it arrives
//
// A job runs in its own detached process (`connect-anything _run <id>`), so an MCP client that
// times out, or a harness that exits, does not kill the agent it called.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { home } from "./home.mjs";

const BIN = fileURLToPath(new URL("../bin/connect-anything.mjs", import.meta.url));
const FINAL = new Set(["done", "failed", "cancelled"]);

export function jobsDir() {
  const d = path.join(home(), "jobs");
  mkdirSync(d, { recursive: true });
  return d;
}

export function newId(agent) {
  const t = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return `${agent.replace(/[^a-z0-9]/gi, "")}-${t}-${randomBytes(3).toString("hex")}`;
}

function dir(id) {
  if (!/^[A-Za-z0-9-]+$/.test(id)) throw new Error(`bad job id: ${id}`);
  return path.join(jobsDir(), id);
}

export function readJob(id) {
  const f = path.join(dir(id), "job.json");
  for (let i = 0; ; i++) {
    if (!existsSync(f)) return null;
    try {
      return JSON.parse(readFileSync(f, "utf8"));
    } catch (e) {
      // Caught mid-swap by another process on Windows: try again shortly.
      if (i >= 20) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

export function writeJob(job) {
  const d = dir(job.id);
  mkdirSync(d, { recursive: true });
  job.updatedAt = new Date().toISOString();
  const tmp = path.join(d, `job.json.${process.pid}.${randomBytes(3).toString("hex")}.tmp`);
  writeFileSync(tmp, JSON.stringify(job, null, 2));
  // Windows refuses a rename onto a file another process has open for a moment; retry briefly.
  for (let i = 0; ; i++) {
    try {
      renameSync(tmp, path.join(d, "job.json"));
      break;
    } catch (e) {
      if (i >= 20) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  return job;
}

export function patchJob(id, patch) {
  const job = readJob(id);
  if (!job) return null;
  return writeJob({ ...job, ...patch });
}

export function appendOutput(id, text) {
  appendFileSync(path.join(dir(id), "output.txt"), text);
}

export function readOutput(id, { tail = 20_000 } = {}) {
  const f = path.join(dir(id), "output.txt");
  if (!existsSync(f)) return "";
  const s = readFileSync(f, "utf8");
  return s.length > tail ? "…" + s.slice(-tail) : s;
}

export function listJobs({ limit = 20 } = {}) {
  const ids = readdirSync(jobsDir()).filter((n) => existsSync(path.join(jobsDir(), n, "job.json")));
  return ids
    .map((id) => readJob(id))
    .filter(Boolean)
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""))
    .slice(0, limit);
}

export const isFinal = (job) => FINAL.has(job?.status);

/** Create a job and start its runner in the background. Returns the job. */
export function startJob(spec, { detached = true } = {}) {
  const id = newId(spec.agent);
  const job = writeJob({ id, status: "queued", createdAt: new Date().toISOString(), ...spec });
  if (detached) {
    const child = spawn(process.execPath, [BIN, "_run", id], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: process.env,
    });
    child.unref();
  }
  return job;
}

/** Wait until a job ends or `timeoutS` passes. Returns the job as it is then. */
export async function waitJob(id, timeoutS = 50) {
  const end = Date.now() + Math.max(0, timeoutS) * 1000;
  for (;;) {
    const job = readJob(id);
    if (!job || isFinal(job) || Date.now() >= end) return job;
    await new Promise((r) => setTimeout(r, 1000));
  }
}
