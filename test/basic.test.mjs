// Behavior tests against a fake agent (no real model calls). Run: npm test
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../bin/connect-anything.mjs", import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), "ca-test-"));
process.env.CONNECT_ANYTHING_HOME = path.join(tmp, "home");
process.env.CONNECT_ANYTHING_INSTALL_HOME = path.join(tmp, "user");
delete process.env.CONNECT_ANYTHING_DEPTH;

before(() => {
  // A fake agent: echoes the prompt reversed, or fails when asked to.
  const fake = path.join(tmp, "fake-agent.mjs");
  writeFileSync(
    fake,
    `let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{
       if(s.includes("FAIL")){console.error("boom");process.exit(3)}
       if(s.includes("SLOW")){setTimeout(()=>console.log("slow done"),3000);return}
       console.log("echo:"+s.split("\\n").pop().split("").reverse().join(""))});`,
  );
  mkdirSync(process.env.CONNECT_ANYTHING_HOME, { recursive: true });
  writeFileSync(
    path.join(process.env.CONNECT_ANYTHING_HOME, "settings.json"),
    JSON.stringify({
      custom: [
        { id: "fake", name: "Fake", command: process.execPath, args: [fake], stdin: true, readOnly: "enforced" },
        { id: "rw", name: "Writer", command: process.execPath, args: [fake], stdin: true },
        { id: "mute", name: "Mute", command: process.execPath, args: ["-e", "console.error('nothing to say')"], readOnly: "enforced" },
        { id: "argv", name: "Argv", command: process.execPath, args: ["-e", "console.log('arg:'+process.argv.at(-1))", "{prompt}"], readOnly: "enforced" },
      ],
    }),
  );
});

/** Talk MCP over stdio to a fresh server. */
async function mcp(messages, env = {}) {
  const p = spawn(process.execPath, [BIN, "mcp"], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "inherit"] });
  const out = [];
  let buf = "";
  const done = new Promise((res) => {
    p.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        out.push(JSON.parse(buf.slice(0, i)));
        buf = buf.slice(i + 1);
        if (out.length === messages.filter((m) => m.id !== undefined).length) res();
      }
    });
  });
  for (const m of messages) p.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
  await done;
  p.stdin.end();
  return out;
}
const call = (id, name, args) => ({ id, method: "tools/call", params: { name, arguments: args } });
const textOf = (r) => r.result.content[0].text;

test("handshake and tool list", async () => {
  const [init, list] = await mcp([{ id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } }, { method: "notifications/initialized" }, { id: 2, method: "tools/list" }]);
  assert.equal(init.result.protocolVersion, "2025-03-26");
  assert.deepEqual(list.result.tools.map((t) => t.name), ["agents", "ask", "job", "jobs", "cancel", "send", "inbox"]);
});

test("ask a custom agent and get its answer", async () => {
  const [r] = await mcp([call(1, "ask", { agent: "fake", prompt: "hello" })]);
  assert.match(textOf(r), /— done/);
  assert.match(textOf(r), /echo:olleh/);
});

test("a failing agent reports failed with its stderr", async () => {
  const [r] = await mcp([call(1, "ask", { agent: "fake", prompt: "FAIL please" })]);
  assert.match(textOf(r), /— failed/);
  assert.match(textOf(r), /boom/);
});

test("a slow agent returns a job id, then the answer via job", async () => {
  const [r] = await mcp([call(1, "ask", { agent: "fake", prompt: "SLOW", wait_s: 0 })]);
  assert.match(textOf(r), /Still working/);
  const id = textOf(r).match(/Job (\S+)/)[1];
  const [j] = await mcp([call(2, "job", { id, wait_s: 15 })]);
  assert.match(textOf(j), /slow done/);
});

test("agents without read-only mode refuse unless write: true", async () => {
  const [r] = await mcp([call(1, "ask", { agent: "rw", prompt: "hi" })]);
  assert.equal(r.result.isError, true);
  assert.match(textOf(r), /no read-only mode/);
  const [ok] = await mcp([call(2, "ask", { agent: "rw", prompt: "hi", write: true })]);
  assert.match(textOf(ok), /echo:ih/);
});

test("a called agent can't call further agents", async () => {
  const [r] = await mcp([call(1, "ask", { agent: "fake", prompt: "hi" })], { CONNECT_ANYTHING_DEPTH: "1" });
  assert.equal(r.result.isError, true);
  assert.match(textOf(r), /called agents can't call further agents/);
});

test("the called agent is started with depth 1", async () => {
  const [r] = await mcp([call(1, "ask", { agent: "fake", prompt: "x" })]);
  const id = textOf(r).match(/Job (\S+)/)[1];
  const job = JSON.parse(readFileSync(path.join(process.env.CONNECT_ANYTHING_HOME, "jobs", id, "job.json"), "utf8"));
  assert.equal(job.depth, 1);
});

test("a cwd that is not a folder is refused", async () => {
  const [r] = await mcp([call(1, "ask", { agent: "fake", prompt: "x", cwd: path.join(process.env.CONNECT_ANYTHING_HOME, 'no"such&dir') })]);
  assert.equal(r.result.isError, true);
  assert.match(textOf(r), /not a folder/);
});

test("custom agents get the prompt verbatim, even with $& in it", async () => {
  const [r] = await mcp([call(1, "ask", { agent: "argv", prompt: "a$&b$'c" })]);
  assert.match(textOf(r), /arg:\[You were called[^]*\n\na\$&b\$'c$/);
});

test("inbox: send, read once, then empty", async () => {
  const [, first, second] = await mcp([
    call(1, "send", { to: "Codex", from: "claude", text: "please review PR 3" }),
    call(2, "inbox", { name: "codex" }),
    call(3, "inbox", { name: "codex" }),
  ]);
  assert.equal(JSON.parse(textOf(first)).unread[0].text, "please review PR 3");
  assert.equal(JSON.parse(textOf(second)).unread.length, 0);
});

test("unknown agent is refused with a hint", async () => {
  const [r] = await mcp([call(1, "ask", { agent: "nope", prompt: "x" })]);
  assert.match(textOf(r), /Call `agents`/);
});

test("installer edits JSON configs with a backup and removes cleanly", async () => {
  const { install } = await import("../src/install.mjs");
  const user = process.env.CONNECT_ANYTHING_INSTALL_HOME;
  const f = path.join(user, ".cursor", "mcp.json");
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify({ mcpServers: { other: { command: "x" } } }));
  const res = await install({ harnesses: ["cursor", "opencode"] });
  assert.ok(res.every((r) => r.ok), JSON.stringify(res));
  const cfg = JSON.parse(readFileSync(f, "utf8"));
  assert.ok(cfg.mcpServers.other, "keeps other servers");
  assert.deepEqual(cfg.mcpServers["connect-anything"].args.slice(-1), ["mcp"]);
  assert.ok(existsSync(f + ".bak"));
  const oc = JSON.parse(readFileSync(path.join(user, ".config", "opencode", "opencode.json"), "utf8"));
  assert.equal(oc.mcp["connect-anything"].type, "local");
  await install({ harnesses: ["cursor"], uninstall: true });
  assert.equal(JSON.parse(readFileSync(f, "utf8")).mcpServers["connect-anything"], undefined);
});

test("an agent that answers nothing is reported as failed, with its stderr", async () => {
  const [r] = await mcp([call(1, "ask", { agent: "mute", prompt: "x" })]);
  assert.match(textOf(r), /— failed/);
  assert.match(textOf(r), /without an answer.*nothing to say/s);
});

test("jobs record the harness that connected over stdio", async () => {
  const [, r] = await mcp([{ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "test-harness" } } }, call(2, "ask", { agent: "fake", prompt: "x" })]);
  const id = textOf(r).match(/Job (\S+)/)[1];
  const job = JSON.parse(readFileSync(path.join(process.env.CONNECT_ANYTHING_HOME, "jobs", id, "job.json"), "utf8"));
  assert.equal(job.caller, "test-harness");
});

test("over HTTP, cloud agents are refused without --allow-cloud (however the id is spelled)", async () => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const p = spawn(process.execPath, [BIN, "serve", "--port", String(port)], { env: process.env, stdio: ["ignore", "pipe", "inherit"] });
  try {
    await new Promise((res) => p.stdout.on("data", (d) => String(d).includes("setup page") && res()));
    const tok = readFileSync(path.join(process.env.CONNECT_ANYTHING_HOME, "token"), "utf8").trim();
    const page = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    assert.ok(!page.includes(tok), "the setup page must not contain the token");
    for (const agent of ["devin-cloud", "devin-cloud ", "DEVIN_CLOUD", "claude-cloud"]) {
      const r = await fetch(`http://127.0.0.1:${port}/mcp/${tok}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(call(1, "ask", { agent, prompt: "hi" })) });
      const j = await r.json();
      assert.equal(j.result.isError, true, agent);
      assert.match(j.result.content[0].text, /--allow-cloud/, agent);
    }
    const api = await fetch(`http://127.0.0.1:${port}/api/ask`, { method: "POST", headers: { "content-type": "application/json", "x-ca-token": tok }, body: JSON.stringify({ agent: "devin-cloud ", prompt: "hi" }) });
    assert.equal(api.status, 400);
  } finally {
    p.kill();
  }
});
