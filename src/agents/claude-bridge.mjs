// Claude Code's cloud (claude.ai/code) through Claude Code's own built-in RemoteTrigger tool.
//
// RemoteTrigger calls the claude.ai routines API with Claude Code's own sign-in. A headless
// `claude -p` turn on a small model can use it, so connect-anything starts and reads cloud
// sessions without a terminal window and without ever touching a token: Claude Code does the call.
//
// The tool's result is read from Claude Code's stream-json output (never retyped by the model).
// Each call is one short local turn on a small model, capped at $0.25 of plan usage.

import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { home } from "../home.mjs";
import { resolveCommand, run } from "../spawn.mjs";

const BRIDGE_MODEL = process.env.CONNECT_ANYTHING_CLAUDE_BRIDGE_MODEL || "haiku";

/** A neutral empty folder, so no project instructions load into the bridge turn. */
function bridgeDir() {
  const d = path.join(home(), "claude-bridge");
  mkdirSync(d, { recursive: true });
  return d;
}

/** Claude Code's environment without the calling session's routing (a parent Claude Code sets these). */
function cleanEnv(configDir) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(CLAUDECODE|CLAUDE_CODE_ENTRYPOINT|CLAUDE_CODE_SSE_PORT|CLAUDE_AGENT_SDK|ANTHROPIC_BASE_URL)$/i.test(k)) continue;
    if (configDir && /^CLAUDE_CODE_OAUTH_TOKEN$/i.test(k)) continue; // a named account uses its own folder's sign-in
    env[k] = v;
  }
  if (configDir) env.CLAUDE_CONFIG_DIR = configDir;
  return env;
}

/**
 * Call RemoteTrigger once with `input` ({action, trigger_id?, session_id?, body?, cursor?}).
 * Returns { status, json } where status is the HTTP status the tool reported.
 */
export async function remoteTrigger(input, { configDir, timeoutMs = 180_000 } = {}) {
  const c = resolveCommand("claude");
  if (!c) throw new Error("Claude Code is not installed.");
  const want = JSON.stringify(input);
  const msg =
    `Call the RemoteTrigger tool exactly once, with exactly this input JSON (copy it unchanged, every character):\n${want}\n` +
    `Do not call any other tool except ToolSearch if you need it to load RemoteTrigger. After the call, reply with one word: done`;
  const r = await run(
    c.command,
    [...c.prefix, "-p", "--model", BRIDGE_MODEL, "--allowedTools", "RemoteTrigger,ToolSearch", "--max-budget-usd", "0.25", "--output-format", "stream-json", "--verbose", "--strict-mcp-config"],
    { input: msg, cwd: bridgeDir(), env: cleanEnv(configDir), replaceEnv: true, timeoutMs },
  );
  if (r.timedOut) throw new Error("Claude Code did not finish the cloud call within 3 minutes.");
  const calls = new Map();
  let result = null;
  let usedInput = null;
  for (const line of r.stdout.split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) continue;
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    for (const part of m.message?.content || []) {
      if (part.type === "tool_use" && part.name === "RemoteTrigger") calls.set(part.id, part.input);
      if (part.type === "tool_result" && calls.has(part.tool_use_id)) {
        usedInput = calls.get(part.tool_use_id);
        result = typeof part.content === "string" ? part.content : (part.content || []).map((x) => x.text || "").join("");
      }
    }
    if (m.type === "result" && m.is_error && !result) throw new Error(`Claude Code: ${String(m.result || m.subtype).slice(0, 400)}`);
  }
  if (result == null) {
    const why = (r.stderr || r.stdout).trim().split(/\r?\n/).slice(-3).join(" ").slice(0, 400);
    throw new Error(`Claude Code did not make the cloud call${why ? `: ${why}` : ""}. Is it signed in (\`claude auth login\`)?`);
  }
  if (JSON.stringify(sortKeys(usedInput)) !== JSON.stringify(sortKeys(input))) {
    throw new Error("Claude Code changed the request before sending it, so connect-anything stopped. Try again.");
  }
  // A large result is saved to a file and the tool returns its path instead.
  const saved = result.match(/<persisted-output>[\s\S]*?saved to:\s*(\S+)/i);
  if (saved) result = readFileSync(saved[1].replace(/[)\].,]+$/, ""), "utf8");
  const status = Number(result.match(/HTTP\s+(\d{3})/)?.[1] || 0);
  const i = result.indexOf("{");
  let json = null;
  if (i >= 0) {
    try {
      json = JSON.parse(result.slice(i));
    } catch {
      const j = result.lastIndexOf("}");
      try {
        json = JSON.parse(result.slice(i, j + 1));
      } catch {}
    }
  }
  if (!status && !json) throw new Error(`RemoteTrigger: ${result.trim().slice(0, 400)}`);
  return { status: status || 200, json, text: result };
}

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}

const ok = (r) => r.status >= 200 && r.status < 300;
const LIMIT = /rate.?limit|usage.?limit|quota|too many requests|limit (reached|exceeded)|out of (usage|credits)/i;

export function failure(step, r) {
  const body = (r.text || "").replace(/\s+/g, " ").trim().slice(0, 400);
  const e = new Error(`Claude cloud ${step} failed (HTTP ${r.status}): ${body}`);
  e.limit = r.status === 429 || LIMIT.test(body);
  return e;
}

/** The account's cloud environment: the one its existing routines use, else none (the API picks). */
export async function findEnvironment(opts) {
  const r = await remoteTrigger({ action: "list" }, opts);
  if (!ok(r)) throw failure("list", r);
  const count = {};
  for (const t of r.json?.data || []) {
    const e = t.job_config?.ccr?.environment_id;
    if (e) count[e] = (count[e] || 0) + 1;
  }
  return Object.entries(count).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}

export { ok };
