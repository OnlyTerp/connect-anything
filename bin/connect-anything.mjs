#!/usr/bin/env node
// connect-anything: let any AI agent call your other agents, on your own subscriptions.

import * as core from "../src/core.mjs";
import { VERSION } from "../src/version.mjs";

const [cmd, ...rest] = process.argv.slice(2);

const BOOLEAN = new Set(["write", "json", "dry-run", "uninstall", "peek", "open", "allow-write"]);

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

const HELP = `connect-anything ${VERSION} — let your AI agents call each other, on your own subscriptions.

  connect-anything setup                 open the setup page (pick agents, connect your harnesses)
  connect-anything agents                who you can call, and whether each is ready
  connect-anything ask <agent> <prompt>  ask an agent; prints the answer (or a job id if it takes long)
      --write        let it edit files and run commands (default: read-only)
      --model M      pick a model    --cwd DIR   folder to work in
      --repo o/n --branch B          cloud agents: which GitHub repo/branch
      --wait S       seconds to wait before giving back a job id (default: until done)
  connect-anything job <id> [--wait S]   status / answer of a job
  connect-anything jobs                  recent jobs
  connect-anything cancel <id>           stop a job
  connect-anything send <to> <text> [--from NAME]   leave a message in an inbox
  connect-anything inbox <name>          read your messages
  connect-anything install [harness...]  add connect-anything to your harnesses (claude, codex, cursor, devin, opencode, grok)
      --dry-run      show what would change    --uninstall   remove it again
  connect-anything mcp                   run the MCP server on stdio (what harnesses launch)
  connect-anything serve [--port 7777]   run the setup page + MCP over HTTP on 127.0.0.1
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
      return console.log(f.json ? JSON.stringify(await core.listAgents(), null, 2) : core.describeAgents(await core.listAgents()));
    case "ask": {
      const [agent, ...words] = f._;
      let prompt = words.join(" ");
      if (!prompt && !process.stdin.isTTY) prompt = await readStdin();
      if (!agent || !prompt) return console.log("Usage: connect-anything ask <agent> <prompt>   (or pipe the prompt on stdin)");
      const wait = f.wait !== undefined ? Number(f.wait) : Infinity;
      let job = await core.ask({ agent, prompt, cwd: f.cwd, model: f.model, write: !!f.write, repo: f.repo, branch: f.branch, wait_s: Math.min(wait, 50) });
      while (wait === Infinity && job && !["done", "failed", "cancelled"].includes(job.status)) {
        if (job.kind === "cloud" && job.remoteId) break; // cloud work can take hours; don't block the terminal
        job = await core.getJob(job.id, 50);
      }
      console.log(core.describeJob(job));
      process.exitCode = job?.status === "failed" ? 1 : 0;
      return;
    }
    case "job": {
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
      for (const r of res) console.log(`${r.ok ? "✓" : "✗"} ${r.harness}: ${r.message}`);
      return;
    }
    case "serve":
    case "setup": {
      const { serveHttp } = await import("../src/http.mjs");
      return serveHttp({ port: Number(f.port) || 7777, open: cmd === "setup" || !!f.open, allowWrite: !!f["allow-write"], publicHost: f["public-host"] });
    }
    case "--version":
    case "-v":
    case "version":
      return console.log(VERSION);
    default:
      console.log(HELP);
  }
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
