// Cloud agents: they run on the provider's machines against a GitHub repo, billed to your plan.
// They see what is pushed to GitHub, not your local files.
//
// A cloud job is started once (never retried: a start is billed and not idempotent) and its
// status is read when someone asks (`job`), so no process has to stay alive for hours.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { home, readSettings } from "../home.mjs";
import { resolveCommand, run } from "../spawn.mjs";
import { failure, findEnvironment, ok, remoteTrigger } from "./claude-bridge.mjs";
import { LOCAL_AGENTS } from "./local.mjs";

const BIN = fileURLToPath(new URL("../../bin/connect-anything.mjs", import.meta.url));
const local = (id) => LOCAL_AGENTS.find((a) => a.id === id);

/** owner/name and branch of a folder's GitHub origin. */
export async function gitHubTarget(cwd, repo, branch) {
  let slug = repo ? repo.replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/, "").replace(/\/$/, "") : null;
  if (!slug) {
    const r = await run("git", ["-C", cwd, "remote", "get-url", "origin"], { timeoutMs: 10_000 });
    const m = r.stdout.trim().match(/github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?$/i);
    if (!m) throw new Error(`Cloud agents work on GitHub repos. ${cwd} has no GitHub origin; pass repo: "owner/name".`);
    slug = m[1];
  }
  let br = branch;
  let note = "";
  if (!br) {
    const r = await run("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], { timeoutMs: 10_000 });
    br = r.stdout.trim() || "main";
    const s = await run("git", ["-C", cwd, "status", "--porcelain", "-b"], { timeoutMs: 10_000 });
    if (/\[ahead \d+/.test(s.stdout) || s.stdout.split("\n").slice(1).some(Boolean)) {
      note = "Note: this folder has unpushed or uncommitted changes. The cloud agent only sees what is on GitHub.";
    }
  }
  return { slug, branch: br, note };
}

/** The line every cloud agent gets so its work comes back somewhere we can find it. */
const handBack = (job) =>
  `\n\n---\nWhen you finish: if you changed files, push them to a new branch named \`cloud/${job.id}\` (never to an existing branch) and do not merge anything. End with a short report of what you did and found.`;

// ---------------------------------------------------------------------------------------------
// Codex Cloud: `codex cloud exec` (experimental in the Codex CLI), your ChatGPT plan.
// `account` is a CODEX_HOME folder, for a second ChatGPT login.
const codexEnv = (account) => (account ? { CODEX_HOME: account } : undefined);
const codexCloud = {
  id: "codex-cloud",
  name: "Codex Cloud",
  kind: "cloud",
  goodFor: "Long or parallel coding tasks on OpenAI's cloud; returns a diff you can apply.",
  verified: false,
  install: local("codex").install,
  signIn: "Run `codex login`, then create a Codex Cloud environment for the repo at chatgpt.com/codex.",
  async detect() {
    const d = await local("codex").detect();
    return { ...d, readOnly: "cloud sandbox", note: [d.note, "unverified: needs a Codex Cloud environment per repo"].filter(Boolean).join(", ") };
  },
  start(job) {
    return eachAccount(job, "codex-cloud", (account) => this.startOn(job, account));
  },
  async startOn(job, account) {
    const c = local("codex").command();
    const t = await gitHubTarget(job.cwd, job.repo, job.branch);
    const env = job.env || t.slug;
    const r = await run(c.command, [...c.prefix, "cloud", "exec", "--env", env, "--branch", t.branch, job.prompt + handBack(job)], { cwd: job.cwd, env: codexEnv(account), timeoutMs: 5 * 60_000 });
    const all = r.stdout + "\n" + r.stderr;
    const url = all.match(/https:\/\/\S+/)?.[0];
    const id = all.match(/\btask_[A-Za-z0-9_]+/)?.[0] || url?.split("/").pop();
    if (/no cloud environments|environment.*not found|not found.*environment/i.test(all)) {
      throw new Error(`Codex Cloud has no environment for ${t.slug} on this ChatGPT account. Make one (once per repo) at https://chatgpt.com/codex/settings/environments, then ask again.`);
    }
    if (r.code !== 0 || !id) throw new Error((r.stderr || r.stdout).trim().slice(0, 2000) || "Codex Cloud did not start a task.");
    return { remoteId: id, url, progress: [t.note, `Started on ${t.slug}@${t.branch}.`].filter(Boolean).join(" "), meta: { account: account || null } };
  },
  async poll(job) {
    const c = local("codex").command();
    const r = await run(c.command, [...c.prefix, "cloud", "status", job.remoteId], { env: codexEnv(job.meta?.account), timeoutMs: 60_000 });
    const s = (r.stdout + r.stderr).toLowerCase();
    if (/\b(ready|completed|succeeded)\b/.test(s)) {
      const d = await run(c.command, [...c.prefix, "cloud", "diff", job.remoteId], { env: codexEnv(job.meta?.account), timeoutMs: 60_000 });
      return { status: "done", result: `Codex Cloud task finished. Apply it with: codex cloud apply ${job.remoteId}\n\n${d.stdout.slice(0, 30_000)}` };
    }
    if (/\b(error|failed|cancelled)\b/.test(s)) return { status: "failed", error: (r.stdout + r.stderr).trim().slice(0, 2000) };
    return { status: "running", progress: (r.stdout || r.stderr).trim().split("\n").slice(-3).join(" ") };
  },
};

// ---------------------------------------------------------------------------------------------
// Devin Cloud: Devin's official v3 API with a service-user key. (The Devin CLI has no cloud mode.)
const devinCloud = {
  id: "devin-cloud",
  name: "Devin Cloud",
  kind: "cloud",
  goodFor: "Devin on its own cloud VM (shell, browser, repo clones); good for long tasks and PRs.",
  verified: false,
  install: "Set DEVIN_API_KEY and DEVIN_ORG_ID (a service-user key from Devin's settings).",
  signIn: "Set DEVIN_API_KEY and DEVIN_ORG_ID.",
  async detect() {
    if (process.env.DEVIN_API_KEY && process.env.DEVIN_ORG_ID) return { installed: true, ready: true, readOnly: "cloud sandbox", note: "via the Devin API, not verified end to end" };
    return { installed: false, ready: false, readOnly: "cloud sandbox", note: "needs DEVIN_API_KEY and DEVIN_ORG_ID" };
  },
  async start(job) {
    if (!(process.env.DEVIN_API_KEY && process.env.DEVIN_ORG_ID)) throw new Error(this.install);
    const t = job.repo || job.cwd ? await gitHubTarget(job.cwd, job.repo, job.branch).catch(() => null) : null;
    const res = await devinApi("POST", "/sessions", {
      prompt: job.prompt + handBack(job),
      ...(t ? { repos: [t.slug] } : {}),
      title: `connect-anything ${job.id}`,
    });
    return { remoteId: res.session_id, url: res.url, progress: t?.note || "" };
  },
  async poll(job) {
    const s = await devinApi("GET", `/sessions/${job.remoteId}`);
    const detail = s.status_detail || "";
    const prs = (s.pull_requests || []).map((p) => p.pr_url).filter(Boolean);
    const finished = ["exit", "error", "suspended"].includes(s.status) || ["finished", "waiting_for_user"].includes(detail);
    if (!finished) return { status: "running", progress: `${s.status}${detail ? " / " + detail : ""}` };
    let last = "";
    try {
      const msgs = await devinApi("GET", `/sessions/${job.remoteId}/messages`);
      const items = msgs.items || msgs.messages || msgs;
      const fromDevin = (Array.isArray(items) ? items : []).filter((m) => !/user/i.test(m.type || m.role || m.source || ""));
      last = fromDevin.at(-1)?.message || fromDevin.at(-1)?.content || "";
    } catch {}
    const body = [last, prs.length ? `Pull requests: ${prs.join(" ")}` : "", s.structured_output ? JSON.stringify(s.structured_output, null, 2) : ""].filter(Boolean).join("\n\n");
    if (s.status === "error") return { status: "failed", error: `Devin session ended with an error (${detail}). ${s.url}` };
    return { status: "done", result: body || `Devin finished (${detail || s.status}). See ${s.url}` };
  },
  async cancel(job) {
    if (!job.remoteId) return "";
    // v3 has no documented hard stop; archiving ends the session.
    await devinApi("POST", `/sessions/${job.remoteId}/archive`, {}).catch(() => {});
    return "Asked Devin to archive the session.";
  },
};

async function devinApi(method, p, body) {
  const base = `https://api.devin.ai/v3/organizations/${encodeURIComponent(process.env.DEVIN_ORG_ID || "")}`;
  const r = await fetch(base + p, {
    method,
    headers: { Authorization: `Bearer ${process.env.DEVIN_API_KEY}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Devin API ${r.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : {};
}

// ---------------------------------------------------------------------------------------------
// Claude Code cloud (claude.ai/code): started through Claude Code's own RemoteTrigger tool in a
// headless turn (claude-bridge.mjs). No terminal window, no token handling, your Pro/Max plan.
// Each task is a one-off routine fired at once; its session's final message is the answer.
const CLAUDE_MODELS = { opus: "claude-opus-5-5", sonnet: "claude-sonnet-5-5", haiku: "claude-haiku-5-5", fable: "claude-fable-5-2" };
const sessionLink = (sid) => (sid ? `https://claude.ai/code/${String(sid).replace(/^cse_/, "session_")}` : "https://claude.ai/code");

const claudeCloud = {
  id: "claude-cloud",
  name: "Claude Code (cloud)",
  kind: "cloud",
  goodFor: "Claude Code on Anthropic's cloud on your Pro/Max plan: works on the GitHub repo, can push a branch or open a PR.",
  verified: true, // spawn, status and answer passed for real on 2026-11-17
  install: local("claude").install,
  signIn: "Run `claude auth login`, and connect GitHub once at claude.ai/code.",
  async detect() {
    const d = await local("claude").detect();
    return { ...d, readOnly: "cloud sandbox", note: d.note };
  },
  start(job) {
    return eachAccount(job, "claude-cloud", (account) => this.startOn(job, account));
  },
  async startOn(job, account) {
    const t = await gitHubTarget(job.cwd, job.repo, job.branch);
    const opts = { configDir: account || undefined };
    const envId = await cachedEnvironment(opts);
    if (!envId)
      throw new Error(
        "Claude cloud: this account has no cloud environment that connect-anything can find yet. Make one routine once (in Claude Code, run /schedule and create any one-off task, or at claude.ai/code/routines), or set \"claudeEnvironment\" in ~/.connect-anything/settings.json, then ask again.",
      );
    const model = job.model ? CLAUDE_MODELS[job.model.toLowerCase()] || job.model : undefined;
    const text = `Work on branch \`${t.branch}\` of https://github.com/${t.slug}.\n\n${job.prompt}` + handBack(job);
    const body = {
      name: `connect-anything ${job.id}`,
      run_once_at: new Date(Date.now() + 5 * 365 * 86400_000).toISOString().replace(/\.\d+Z$/, "Z"), // never fires on its own
      enabled: true,
      clear_mcp_connections: true,
      job_config: {
        ccr: {
          environment_id: envId,
          session_context: { ...(model ? { model } : {}), sources: [{ git_repository: { url: `https://github.com/${t.slug}`, revision: t.branch } }] },
          events: [{ data: { uuid: randomUUID(), session_id: "", type: "user", parent_tool_use_id: null, message: { role: "user", content: text } } }],
        },
      },
    };
    const c = await remoteTrigger({ action: "create", body }, opts);
    if (!ok(c)) throw failure("create", c);
    const trigger = c.json?.id || c.json?.trigger_id || c.json?.trigger?.id;
    if (!trigger) throw new Error(`Claude cloud: created a routine but got no id back: ${c.text.slice(0, 300)}`);
    const r = await remoteTrigger({ action: "run", trigger_id: trigger }, opts);
    if (!ok(r)) throw failure("run", r);
    const sid = [r.json?.session_id, r.json?.session?.id, r.json?.id].find((x) => /^(cse_|session_)/.test(String(x || "")));
    // Turn the routine off so its far-future schedule never fires a second, billed run.
    await remoteTrigger({ action: "update", trigger_id: trigger, body: { enabled: false } }, opts).catch(() => null);
    return {
      remoteId: sid || trigger,
      url: sessionLink(sid),
      progress: [t.note, `Started on ${t.slug}@${t.branch}.`].filter(Boolean).join(" "),
      meta: { trigger, session: sid || null, account: account || null },
    };
  },
  pollEveryMs: 60_000,
  async poll(job) {
    const opts = { configDir: job.meta?.account || undefined };
    let sid = job.meta?.session;
    if (!sid) {
      const runs = await remoteTrigger({ action: "list_runs", trigger_id: job.meta.trigger }, opts);
      sid = runs.json?.data?.[0]?.id;
      if (!sid) return { status: "running", progress: "Waiting for the cloud session to start." };
    }
    // The tool returns a condensed transcript: one "[time] kind: text" line per event, in pages.
    const lines = [];
    let cursor;
    for (let page = 0; page < 10; page++) {
      const log = await remoteTrigger({ action: "get_run_log", session_id: sid, ...(cursor ? { cursor } : {}) }, opts);
      if (!ok(log)) throw failure("get_run_log", log);
      lines.push(...log.text.split(/\r?\n/).filter((l) => /^\[\d{4}-\d\d-\d\dT/.test(l)));
      cursor = log.text.match(/"next_cursor"\s*:\s*"([^"]+)"/)?.[1];
      if (!cursor) break;
    }
    const body = (l) => l.replace(/^\[[^\]]+\]\s*/, "");
    const final = lines.map(body).reverse().find((l) => /^result:/.test(l));
    const meta = { ...job.meta, session: sid };
    if (!final) {
      const last = lines.map(body).reverse().find((l) => /^assistant:/.test(l));
      return { status: "running", url: sessionLink(sid), meta, progress: last ? `Latest: ${last.slice(11, 211)}` : `${lines.length} events so far.` };
    }
    const m = final.match(/^result:\s*(\S+)\s+is_error=(\w+)[^—]*—\s*([\s\S]*)$/);
    const answer = (m?.[3] || final.replace(/^result:\s*/, "")).trim();
    if (m?.[2] === "true" || (m && m[1] !== "success")) return { status: "failed", url: sessionLink(sid), meta, error: `Claude cloud session ended with ${m[1]}. ${answer.slice(0, 1500)}` };
    return { status: "done", url: sessionLink(sid), meta, result: answer || "(no final message)" };
  },
  async cancel(job) {
    return `Stop it at ${job.url || "https://claude.ai/code"} (the routines API has no stop call). Routines can be cleaned up at https://claude.ai/code/routines.`;
  },
};

// ---------------------------------------------------------------------------------------------
// GitHub Copilot coding agent: `gh agent-task` (GitHub CLI 2.80+), your Copilot plan. It works on
// the repo on GitHub and always answers with a pull request.
const copilotCloud = {
  id: "copilot-cloud",
  name: "GitHub Copilot (cloud)",
  kind: "cloud",
  goodFor: "Copilot's coding agent on GitHub's cloud, on your Copilot plan: opens a pull request with its work.",
  verified: false,
  install: "Install the GitHub CLI (https://cli.github.com), version 2.80 or later.",
  signIn: "Run `gh auth login`. Needs a Copilot plan with the coding agent turned on.",
  async detect() {
    const c = resolveCommand("gh");
    if (!c) return { installed: false, ready: false, readOnly: "cloud sandbox", note: "GitHub CLI not installed" };
    const r = await run(c.command, [...c.prefix, "agent-task", "list", "-L", "1"], { timeoutMs: 30_000 });
    if (r.code !== 0) {
      const why = (r.stderr || r.stdout).trim().split(/\r?\n/)[0] || "gh agent-task failed";
      return { installed: true, ready: false, readOnly: "cloud sandbox", note: /unknown command/i.test(why) ? "update the GitHub CLI to 2.80+" : why.slice(0, 160) };
    }
    return { installed: true, ready: true, readOnly: "cloud sandbox" };
  },
  async start(job) {
    const c = resolveCommand("gh");
    const t = await gitHubTarget(job.cwd, job.repo, job.branch);
    const r = await run(c.command, [...c.prefix, "agent-task", "create", "-F", "-", "-R", t.slug, "-b", t.branch], { input: job.prompt, cwd: job.cwd, timeoutMs: 120_000 });
    const all = `${r.stdout}\n${r.stderr}`;
    const url = all.match(/https:\/\/github\.com\/\S+/)?.[0];
    const sid = all.match(/[0-9a-f]{8}-[0-9a-f]{4,5}-[0-9a-f]{4,5}-[0-9a-f]{4,5}-[0-9a-f]{12}/i)?.[0] || url?.match(/agent-sessions\/([\w-]+)/)?.[1] || url?.match(/\/pull\/(\d+)/)?.[1];
    if (/403|forbidden/i.test(all) && !sid) throw new Error(`GitHub refused the Copilot task on ${t.slug} (403). This GitHub account needs a Copilot plan with the coding agent turned on, and the agent allowed on this repo.`);
    if (r.code !== 0 || !sid) throw new Error(all.trim().slice(0, 1500) || "Copilot did not start a task.");
    return { remoteId: sid, url, progress: [t.note, `Started on ${t.slug}@${t.branch}.`].filter(Boolean).join(" "), meta: { slug: t.slug } };
  },
  async poll(job) {
    const c = resolveCommand("gh");
    const r = await run(c.command, [...c.prefix, "agent-task", "view", job.remoteId, "-R", job.meta.slug, "--json", "state,pullRequestUrl,pullRequestTitle,completedAt"], { timeoutMs: 60_000 });
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().slice(0, 400));
    const s = JSON.parse(r.stdout);
    const state = String(s.state || "").toLowerCase();
    const pr = s.pullRequestUrl ? `${s.pullRequestTitle || "Pull request"}: ${s.pullRequestUrl}` : "";
    if (/fail|error|cancel/.test(state)) return { status: "failed", url: s.pullRequestUrl || job.url, error: `Copilot task ${state}. ${pr}` };
    if (s.completedAt || /complete|done|success|idle/.test(state)) return { status: "done", url: s.pullRequestUrl || job.url, result: `Copilot finished. ${pr}\nRead it with: gh pr view ${s.pullRequestUrl || ""}`.trim() };
    return { status: "running", progress: `${state || "running"}${pr ? ` - ${pr}` : ""}` };
  },
};

/** A usage-limit refusal, in any provider's words. */
const LIMITED = /rate.?limit|usage.?limit|quota|too many requests|limit (reached|exceeded)|out of (usage|credits)|\b429\b/i;

/**
 * Run `start` on the job's account, or on each of your accounts for this agent in turn (the
 * default sign-in first, then `accounts` in settings.json) while each one says it is at its limit.
 */
async function eachAccount(job, id, start) {
  const extra = (readSettings().accounts?.[id] || []).map(expandHome);
  if (job.account && !extra.includes(expandHome(job.account)))
    throw new Error(`Account "${job.account}" is not listed for ${id}. Add it to "accounts" in ~/.connect-anything/settings.json first.`);
  const list = job.account ? [expandHome(job.account)] : [null, ...extra];
  let last;
  for (const account of list) {
    try {
      return await start(account);
    } catch (e) {
      last = e;
      if (!(e.limit || LIMITED.test(String(e.message)))) throw e;
    }
  }
  throw new Error(`${last.message}${list.length > 1 ? ` (tried ${list.length} accounts; all are at their limit)` : ""}`);
}

const expandHome = (p) => path.resolve(String(p).replace(/^~(?=[\\/]|$)/, os.homedir()));

/** One environment lookup per account, kept in ~/.connect-anything/cloud.json. */
async function cachedEnvironment(opts) {
  const set = readSettings().claudeEnvironment;
  if (set && !opts.configDir) return set;
  const f = path.join(home(), "cloud.json");
  let s = {};
  try {
    s = JSON.parse(readFileSync(f, "utf8"));
  } catch {}
  const key = `claude:${opts.configDir || "default"}`;
  if (s[key]?.environment) return s[key].environment;
  const env = await findEnvironment(opts);
  if (env) writeFileSync(f, JSON.stringify({ ...s, [key]: { environment: env, foundAt: new Date().toISOString() } }, null, 2));
  return env;
}

/** Open a visible terminal running `connect-anything _tty <jobId>` (a CLI that needs a TTY gets one). */
export function openTerminal(jobId, cwd) {
  if (!/^[A-Za-z0-9-]+$/.test(jobId)) throw new Error("bad job id");
  const argv = [process.execPath, BIN, "_tty", jobId];
  if (process.platform === "win32") {
    const q = (s) => `"${s}"`; // paths and a checked job id: no quotes or % inside
    // Only fixed paths and a checked job id reach cmd.exe; `_tty` sets the working folder itself.
    for (const a of argv) if (/["%^&|<>]/.test(a)) throw new Error(`Can't open a terminal: unsafe characters in ${a}`);
    spawn("cmd.exe", ["/d", "/c", "start", '"connect-anything"', ...argv.map(q)], { detached: true, stdio: "ignore", windowsVerbatimArguments: true, windowsHide: false }).unref();
  } else if (process.platform === "darwin") {
    const line = argv.map((s) => `'${s.replace(/'/g, `'\\''`)}'`).join(" ");
    const cd = `cd '${cwd.replace(/'/g, `'\\''`)}'`;
    spawn("osascript", ["-e", `tell application "Terminal" to do script ${JSON.stringify(cd + " && " + line)}`], { detached: true, stdio: "ignore" }).unref();
  } else {
    spawn("x-terminal-emulator", ["-e", ...argv], { cwd, detached: true, stdio: "ignore" }).unref();
  }
}

export const CLOUD_AGENTS = [claudeCloud, codexCloud, copilotCloud, devinCloud];
