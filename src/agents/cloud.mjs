// Cloud agents: they run on the provider's machines against a GitHub repo, billed to your plan.
// They see what is pushed to GitHub, not your local files.
//
// A cloud job is started once (never retried: a start is billed and not idempotent) and its
// status is read when someone asks (`job`), so no process has to stay alive for hours.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { run } from "../spawn.mjs";
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
  async start(job) {
    const c = local("codex").command();
    const t = await gitHubTarget(job.cwd, job.repo, job.branch);
    const env = job.env || t.slug;
    const r = await run(c.command, [...c.prefix, "cloud", "exec", "--env", env, "--branch", t.branch, job.prompt + handBack(job)], { cwd: job.cwd, timeoutMs: 5 * 60_000 });
    const all = r.stdout + "\n" + r.stderr;
    const url = all.match(/https:\/\/\S+/)?.[0];
    const id = all.match(/\btask_[A-Za-z0-9_]+/)?.[0] || url?.split("/").pop();
    if (r.code !== 0 || !id) throw new Error((r.stderr || r.stdout).trim().slice(0, 2000) || "Codex Cloud did not start a task.");
    return { remoteId: id, url, progress: [t.note, `Started on ${t.slug}@${t.branch}.`].filter(Boolean).join(" ") };
  },
  async poll(job) {
    const c = local("codex").command();
    const r = await run(c.command, [...c.prefix, "cloud", "status", job.remoteId], { timeoutMs: 60_000 });
    const s = (r.stdout + r.stderr).toLowerCase();
    if (/\b(ready|completed|succeeded)\b/.test(s)) {
      const d = await run(c.command, [...c.prefix, "cloud", "diff", job.remoteId], { timeoutMs: 60_000 });
      return { status: "done", result: `Codex Cloud task finished. Apply it with: codex cloud apply ${job.remoteId}\n\n${d.stdout.slice(0, 30_000)}` };
    }
    if (/\b(error|failed|cancelled)\b/.test(s)) return { status: "failed", error: (r.stdout + r.stderr).trim().slice(0, 2000) };
    return { status: "running", progress: (r.stdout || r.stderr).trim().split("\n").slice(-3).join(" ") };
  },
};

// ---------------------------------------------------------------------------------------------
// Devin Cloud: the Devin CLI's `--cloud -p` when your CLI has it, else Devin's v3 API with a key.
const devinCloud = {
  id: "devin-cloud",
  name: "Devin Cloud",
  kind: "cloud",
  goodFor: "Devin on its own cloud VM (shell, browser, repo clones); good for long tasks and PRs.",
  verified: false,
  install: "Update the Devin CLI (`devin update`) for `devin --cloud`, or set DEVIN_API_KEY and DEVIN_ORG_ID (Settings → Devin API).",
  signIn: "Run `devin auth login`, or set DEVIN_API_KEY and DEVIN_ORG_ID.",
  async mode() {
    const c = local("devin").command();
    if (c) {
      const h = await run(c.command, [...c.prefix, "--help"], { timeoutMs: 20_000 });
      if (/--cloud\b/.test(h.stdout + h.stderr)) return "cli";
    }
    if (process.env.DEVIN_API_KEY && process.env.DEVIN_ORG_ID) return "api";
    return c ? "cli-too-old" : null;
  },
  async detect() {
    const m = await this.mode();
    if (m === "cli") return { installed: true, ready: true, readOnly: "cloud sandbox", note: "via devin --cloud" };
    if (m === "api") return { installed: true, ready: true, readOnly: "cloud sandbox", note: "via Devin API key, unverified" };
    if (m === "cli-too-old") return { installed: true, ready: false, readOnly: "cloud sandbox", note: "your Devin CLI has no --cloud yet: run `devin update`, or set DEVIN_API_KEY and DEVIN_ORG_ID" };
    return { installed: false, ready: false, readOnly: "cloud sandbox" };
  },
  async start(job) {
    const m = await this.mode();
    if (m === "cli") return { runner: true }; // runs like a local job: `devin --cloud -p` waits and prints the answer
    if (m !== "api") throw new Error(this.install);
    const t = job.repo || job.cwd ? await gitHubTarget(job.cwd, job.repo, job.branch).catch(() => null) : null;
    const res = await devinApi("POST", "/sessions", {
      prompt: job.prompt + handBack(job),
      ...(t ? { repos: [t.slug] } : {}),
      title: `connect-anything ${job.id}`,
    });
    return { remoteId: res.session_id, url: res.url, progress: t?.note || "" };
  },
  build: ({ model, promptFile }) => ({
    args: ["--cloud", "-p", ...(model ? ["--model", model] : []), "--prompt-file", promptFile],
    stdin: false,
  }),
  parse: (stdout) => ({ text: stdout.trim() }),
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
// Claude Code cloud: `claude --cloud` only starts from a real terminal, so we open one for you.
// The agent hands back on a `cloud/<job>` branch, which is how we know it is done.
const claudeCloud = {
  id: "claude-cloud",
  name: "Claude Code (cloud)",
  kind: "cloud",
  goodFor: "Claude Code on Anthropic's cloud on your Pro/Max plan; hands back a branch.",
  verified: false,
  install: local("claude").install,
  signIn: "Run `claude auth login` and connect GitHub at claude.ai/code.",
  async detect() {
    const d = await local("claude").detect();
    return { ...d, readOnly: "cloud sandbox", note: [d.note, "opens a terminal window (claude --cloud needs one)"].filter(Boolean).join(", ") };
  },
  async start(job) {
    const c = local("claude").command();
    const t = await gitHubTarget(job.cwd, job.repo, job.branch);
    const prompt =
      job.prompt +
      `\n\n---\nWhen you finish, push a new branch named \`cloud/${job.id}\` (never an existing branch) containing your changes, if any, plus a file CLOUD_REPORT.md with a short report of what you did and found. Do not merge anything.`;
    if (!c) throw new Error("Claude Code is not installed.");
    // The terminal runs `connect-anything _tty <job>`, which starts `claude --cloud <prompt>` with
    // the terminal's own TTY. Only the job id crosses the shell; the prompt never does.
    openTerminal(job.id, job.cwd);
    return {
      ttyCommand: { command: c.command, args: [...c.prefix, "--cloud", prompt] },
      remoteId: `cloud/${job.id}`,
      url: "https://claude.ai/code",
      progress: [t.note, `A terminal window opened running \`claude --cloud\` on ${t.slug}@${t.branch}. Results arrive on branch cloud/${job.id}.`].filter(Boolean).join(" "),
      meta: { slug: t.slug },
    };
  },
  async poll(job) {
    // Use the folder's own origin when it is that repo, so private repos use your git credentials.
    const o = await run("git", ["-C", job.cwd, "remote", "get-url", "origin"], { timeoutMs: 10_000 });
    const remote = o.stdout.toLowerCase().includes(String(job.meta?.slug).toLowerCase()) ? "origin" : `https://github.com/${job.meta?.slug}.git`;
    const r = await run("git", ["-C", job.cwd, "ls-remote", remote, `refs/heads/${job.remoteId}`], { timeoutMs: 30_000 });
    if (r.stdout.trim()) {
      return {
        status: "done",
        result: `Claude Code pushed branch ${job.remoteId} to ${job.meta?.slug}. Read its CLOUD_REPORT.md:\n  git fetch origin ${job.remoteId} && git show FETCH_HEAD:CLOUD_REPORT.md`,
      };
    }
    return { status: "running", progress: `Waiting for branch ${job.remoteId}. Watch it at https://claude.ai/code` };
  },
};

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

export const CLOUD_AGENTS = [claudeCloud, codexCloud, devinCloud];
