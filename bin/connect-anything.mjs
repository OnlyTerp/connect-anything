#!/usr/bin/env node
// connect-anything: let any AI agent call your other agents, on your own subscriptions.

import * as core from "../src/core.mjs";
import { VERSION } from "../src/version.mjs";
import { HARNESSES } from "../src/install.mjs";

const [cmd, ...rest] = process.argv.slice(2);

const BOOLEAN = new Set(["write", "json", "dry-run", "uninstall", "peek", "open", "allow-write", "allow-cloud", "all", "staged", "diff"]);

function flags(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      out._.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      if (v !== undefined) out[k] = v;
      else if (!BOOLEAN.has(k) && args[i + 1] && !args[i + 1].startsWith("--")) out[k] = args[++i];
      else out[k] = true;
    } else out._.push(a);
  }
  return out;
}

const HELP = () => `connect-anything ${VERSION}: let the coding agent you're in ask your other agents, on your own sign-ins.

  connect-anything doctor [--only a,b]   check which agents answer (one tiny read-only call each, on your plan)
  connect-anything install [harness...]  add it to your apps: ${Object.keys(HARNESSES).join(", ")}
      --dry-run      show what would change    --uninstall   remove it again
  connect-anything agents [--all]        who you can ask, and whether each is ready
  connect-anything ask <agent>[,<agent>...] <prompt>
                                         ask one agent, or up to 3 in parallel (a council)
      --diff         attach your uncommitted git diff     --staged   only the staged diff
      --base BRANCH  attach the diff of BRANCH...HEAD
      --write        let it edit files and run commands (default: read-only)
      --model M      pick a model    --cwd DIR   folder to work in
      --repo o/n --branch B          cloud agents: which GitHub repo/branch
      --wait S       seconds to wait before giving back an id (default: until done)
  connect-anything job [<id>] [--wait S] status / answer of a job or council; no id lists recent jobs
  connect-anything cancel <id>           stop a job or council
  connect-anything send <to> <text> [--from NAME]   leave a message in an inbox
  connect-anything inbox <name>          read your messages
  connect-anything setup                 open the setup page in your browser
  connect-anything mcp                   run the MCP server on stdio (what your apps launch)
  connect-anything serve [--port 7777]   the setup page + MCP over HTTP on 127.0.0.1
      --public-host H  also answer as your tunnel's host H, and print the connector URL to paste
  connect-anything check-url <url>       connect to a connector URL the way an assistant app does

Example:  connect-anything ask codex,devin --staged "Review this diff for bugs."
`;

async function main() {
  const f = flags(rest);
  switch (cmd) {
    case "mcp": {
      const { serveStdio } = await import("../src/mcp.mjs");
      return serveStdio();
    }
    case "_run": {
      const { runJob } = await import("../src/runner.mjs");
      return runJob(f._[0]);
    }
    case "_tty": {
      const { runTty } = await import("../src/runner.mjs");
      return runTty(f._[0]);
    }
    case "agents":
      return console.log(f.json ? JSON.stringify(await core.listAgents(), null, 2) : core.describeAgents(await core.listAgents(), { all: !!f.all }));
    case "doctor": {
      const only = typeof f.only === "string" ? f.only.split(",").map((s) => s.trim()).filter(Boolean) : null;
      console.log('Checking your agents: one tiny read-only call each ("Reply with exactly: OK"), on your own plan.\n');
      const t0 = Date.now();
      const res = await core.doctor({
        only,
        onResult: (a, r) => console.log(`  ${(r.ok ? "ok" : r.skipped ? "--" : "x ").padEnd(3)}${a.id.padEnd(13)}${r.ok ? `answered in ${(r.ms / 1000).toFixed(1)} s` : r.error}`),
      });
      const ok = Object.entries(res).filter(([, r]) => r.ok).map(([id]) => id);
      console.log(`\n${ok.length} agent${ok.length === 1 ? "" : "s"} answered (${((Date.now() - t0) / 1000).toFixed(1)} s total).`);
      if (ok.length) console.log(nextStep(ok));
      else console.log("No agent answered. Install a CLI you have a plan for (Claude Code, Codex, Cursor, Devin), sign in, and run doctor again.");
      process.exitCode = ok.length ? 0 : 1;
      return;
    }
    case "ask": {
      const [who, ...words] = f._;
      let prompt = words.join(" ");
      const diff = f.staged ? "staged" : typeof f.base === "string" ? f.base : f.diff ? "uncommitted" : undefined;
      if (!prompt && !diff && !process.stdin.isTTY) prompt = await readStdin();
      if (!who || (!prompt && !diff)) return console.log("Usage: connect-anything ask <agent>[,<agent>...] <prompt>   (or pipe the prompt on stdin; --diff, --staged or --base B to review a diff)");
      const many = who.includes(",");
      const wait = f.wait !== undefined ? Number(f.wait) : Infinity;
      let job = await core.ask({ ...(many ? { agents: who.split(",") } : { agent: who }), prompt, diff, cwd: f.cwd, model: f.model, write: !!f.write, repo: f.repo, branch: f.branch, wait_s: Math.min(wait, 50), caller: "cli" });
      while (wait === Infinity && job && !["done", "failed", "cancelled"].includes(job.status)) {
        if (job.kind === "cloud" && job.remoteId) break; // cloud work can take hours; don't block the terminal
        job = await core.getJob(job.id, 50);
      }
      console.log(core.describeJob(job));
      process.exitCode = job?.status === "failed" || (job?.kind === "group" && !job.members.some((m) => m.status === "done")) ? 1 : 0;
      return;
    }
    case "job": {
      if (!f._[0]) return console.log(core.describeJobs(core.recentJobs(Number(f.limit) || 15)));
      const job = await core.getJob(f._[0], f.wait ? Number(f.wait) : 0);
      return console.log(f.json ? JSON.stringify(job, null, 2) : core.describeJob(job));
    }
    case "jobs":
      return console.log(core.describeJobs(core.recentJobs(Number(f.limit) || 15)));
    case "cancel":
      return console.log(await core.cancel(f._[0]));
    case "send":
      return console.log(core.send({ to: f._[0], text: f._.slice(1).join(" "), from: f.from || "cli" }));
    case "inbox":
      return console.log(JSON.stringify(core.inbox({ name: f._[0], peek: !!f.peek }), null, 2));
    case "install": {
      const { install } = await import("../src/install.mjs");
      const res = await install({ harnesses: f._, dryRun: !!f["dry-run"], uninstall: !!f.uninstall });
      for (const r of res) console.log(`${r.ok ? "ok" : "x "} ${r.harness}: ${r.message}`);
      if (!res.length) console.log("Found none of the supported apps. Name one, e.g.: connect-anything install claude");
      else if (!f["dry-run"] && !f.uninstall && res.some((r) => r.ok)) console.log("\nRestart those apps so they load connect-anything, then check your agents: connect-anything doctor");
      return;
    }
    case "serve":
    case "setup": {
      const { serveHttp } = await import("../src/http.mjs");
      return serveHttp({ port: Number(f.port) || 7777, fixedPort: !!f.port, open: cmd === "setup" || !!f.open, allowWrite: !!f["allow-write"], allowCloud: !!f["allow-cloud"], publicHost: f["public-host"] });
    }
    case "check-url": {
      const { checkConnector, describeCheck } = await import("../src/connector.mjs");
      const c = await checkConnector(String(rest.find((x) => !x.startsWith("--")) || ""));
      console.log(describeCheck(c));
      process.exitCode = c.ok ? 0 : 1;
      return;
    }
    case "--version":
    case "-v":
    case "version":
      return console.log(VERSION);
    default:
      console.log(HELP());
  }
}

/** After doctor: a first thing to try, using agents that answered. */
function nextStep(ok) {
  const others = ok.filter((id) => id !== "claude");
  const pair = (others.length >= 2 ? others : ok).slice(0, 2);
  return `\nTry it from your coding agent (after \`connect-anything install\` and a restart):\n  "Ask ${pair.join(" and ")} to review my staged diff. Where do they disagree?"\nOr right here:\n  connect-anything ask ${pair.join(",")} --staged "Review this diff for bugs."`;
}

function readStdin() {
  return new Promise((resolve) => {
    let s = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => (s += d));
    process.stdin.on("end", () => resolve(s.trim()));
  });
}

main().catch((e) => {
  console.error(`connect-anything: ${e?.message || e}`);
  process.exitCode = 1;
});
