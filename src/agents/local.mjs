// Local agent CLIs, each called in its own official headless mode with its own sign-in.
// Every flag here was read from that CLI's --help, and every parser from a real reply.
//
// readOnly: "enforced"  -> the CLI has a real read-only/plan mode and we use it unless write: true
//           "none"      -> the CLI has no such mode, so connect-anything refuses unless write: true

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveCommand } from "../spawn.mjs";

const isWin = process.platform === "win32";
const LOCAL = process.env.LOCALAPPDATA || "";
const HOME = os.homedir();

/** First existing absolute path, else the PATH lookup of `name`. Honors CONNECT_ANYTHING_<ID>_BIN. */
function locate(id, name, candidates = []) {
  const override = process.env[`CONNECT_ANYTHING_${id.toUpperCase().replace(/-/g, "_")}_BIN`];
  if (override) return existsSync(override) ? { command: override, prefix: [] } : null;
  for (const c of candidates) if (c && existsSync(c)) return { command: c, prefix: [] };
  return resolveCommand(name);
}

/** Pull plain text out of JSON lines, trying each extractor on each line; keep the last hit. */
function lastFromJsonl(stdout, pick) {
  let found = null;
  let error = null;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith("{")) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const r = pick(o);
    if (r?.text != null) found = r.text;
    if (r?.error) error = r.error;
  }
  return { text: found, error };
}

const textOf = (content) =>
  Array.isArray(content)
    ? content
        .filter((c) => c?.type === "text" && typeof c.text === "string")
        .map((c) => c.text)
        .join("")
    : typeof content === "string"
      ? content
      : null;

export const LOCAL_AGENTS = [
  {
    id: "claude",
    name: "Claude Code",
    goodFor: "Careful coding, reviews, refactors, long reasoning.",
    readOnly: "enforced",
    install: "Install: npm i -g @anthropic-ai/claude-code",
    signIn: "Run `claude` once and sign in.",
    locate: () => locate("claude", "claude", [isWin ? path.join(process.env.APPDATA || "", "npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe") : null]),
    signedIn: () =>
      process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN || existsSync(path.join(process.env.CLAUDE_CONFIG_DIR || path.join(HOME, ".claude"), ".credentials.json"))
        ? true
        : null, // macOS keeps it in the keychain: unknown, not "no"
    build: ({ model, write }) => ({
      args: [
        "-p",
        "--output-format",
        "json",
        "--permission-mode",
        write ? "acceptEdits" : "plan",
        // Children start without MCP servers: no tool loops back into connect-anything.
        "--strict-mcp-config",
        ...(model ? ["--model", model] : []),
      ],
      stdin: true,
      // Child of a Claude Code session: drop the markers that tie it to the parent session.
      unsetEnv: ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_HOST_SESSION_ID", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_PID"],
    }),
    parse: (stdout) => {
      const i = stdout.indexOf("{");
      try {
        const o = JSON.parse(stdout.slice(i));
        if (o.is_error) return { error: o.result || o.subtype || "Claude Code reported an error" };
        return { text: o.result ?? "", meta: { cost_usd: o.total_cost_usd, session: o.session_id } };
      } catch {
        return { text: stdout.trim() };
      }
    },
  },
  {
    id: "codex",
    name: "Codex",
    goodFor: "Fast coding and debugging with OpenAI models; strong at running and fixing tests.",
    readOnly: "enforced",
    install: "Install: npm i -g @openai/codex",
    signIn: "Run `codex login`.",
    locate: () => locate("codex", "codex", [isWin ? path.join(LOCAL, "Programs/OpenAI/Codex/bin/codex.exe") : null]),
    signedIn: () => (process.env.OPENAI_API_KEY || existsSync(path.join(process.env.CODEX_HOME || path.join(HOME, ".codex"), "auth.json")) ? true : false),
    build: ({ model, write, cwd }) => ({
      // Codex passes only an allowlist of env vars to its MCP servers, so the depth guard can't
      // reach a connect-anything server it starts. Switch that server off for this run instead
      // (only when it is configured: the override breaks Codex's config load otherwise).
      args: ["exec", ...(codexHasUs() ? ["-c", "mcp_servers.connect-anything.enabled=false"] : []), "--json", "--skip-git-repo-check", "-s", write ? "workspace-write" : "read-only", "-C", cwd, ...(model ? ["-m", model] : []), "-"],
      stdin: true,
    }),
    parse: (stdout) => {
      const r = lastFromJsonl(stdout, (o) => {
        if (o.type === "item.completed" && o.item?.type === "agent_message") return { text: o.item.text };
        if (o.type === "turn.failed") return { error: o.error?.message || "Codex turn failed" };
        return null;
      });
      return r.text != null ? { text: r.text } : { error: r.error || "Codex gave no answer" };
    },
  },
  {
    id: "devin",
    name: "Devin (local CLI)",
    goodFor: "General coding agent; SWE-2 (--model swe-2) is Devin's own fast model.",
    readOnly: "enforced",
    install: "Install the Devin CLI: https://docs.devin.ai/cli",
    signIn: "Run `devin auth login`.",
    locate: () =>
      locate("devin", "devin", [isWin ? path.join(LOCAL, "devin/cli/bin/devin.exe") : path.join(HOME, ".local/bin/devin")]),
    signedIn: () => null,
    build: ({ model, write, promptFile }) => ({
      args: ["-p", "--permission-mode", write ? "accept-edits" : "auto", "--respect-workspace-trust", "false", ...(model ? ["--model", model] : []), "--prompt-file", promptFile],
      stdin: false,
    }),
    parse: (stdout) => ({ text: stdout.trim() }),
  },
  {
    id: "cursor",
    name: "Cursor Agent",
    goodFor: "Coding with any model on your Cursor plan.",
    readOnly: "enforced",
    install: "Install: https://cursor.com/cli",
    signIn: "Run `cursor-agent login`.",
    locate: () => locate("cursor", "cursor-agent", [cursorNode()].filter(Boolean)) ,
    signedIn: () => null,
    build: ({ model, write, prompt }) => ({
      // No --approve-mcps: a called Cursor can't use MCP servers, so it can't call back in here.
      args: ["-p", ...(write ? ["--force"] : ["--mode", "ask"]), "--output-format", "json", "--trust", ...(model ? ["--model", model] : []), prompt],
      stdin: false,
    }),
    parse: (stdout) => {
      const r = lastFromJsonl(stdout, (o) => (o.type === "result" ? (o.is_error ? { error: o.result || "error" } : { text: o.result }) : null));
      return r.text != null ? { text: r.text } : { error: r.error || stdout.trim() || "Cursor gave no answer" };
    },
  },
  {
    id: "opencode",
    name: "OpenCode",
    goodFor: "Open-source agent that runs any provider/model you configured.",
    readOnly: "none",
    install: "Install: npm i -g opencode-ai",
    signIn: "Run `opencode auth login`.",
    locate: () => locate("opencode", "opencode"),
    signedIn: () => null,
    build: ({ model, prompt }) => ({ args: ["run", "--format", "json", ...(model ? ["-m", model] : []), prompt], stdin: false }),
    parse: (stdout) => {
      let text = "";
      const r = lastFromJsonl(stdout, (o) => {
        if (o.type === "text" && typeof o.part?.text === "string") text += o.part.text;
        if (o.type === "error") return { error: o.error?.data?.message || o.error?.name || "OpenCode error" };
        return null;
      });
      return text ? { text } : { error: r.error || "OpenCode gave no answer" };
    },
  },
  {
    id: "omp",
    name: "OMP (oh-my-pi)",
    goodFor: "Multi-provider agent harness; uses whatever accounts you signed into it.",
    readOnly: "none",
    install: "Install OMP from its project page.",
    signIn: "Sign in inside `omp`.",
    locate: () => locate("omp", "omp"),
    signedIn: () => null,
    build: ({ model, prompt }) => ({ args: ["-p", "--mode", "json", ...(model ? ["--model", model] : []), prompt], stdin: false }),
    parse: (stdout) => {
      const r = lastFromJsonl(stdout, (o) => {
        if (o.type === "turn_end" && o.message?.role === "assistant") return { text: textOf(o.message.content) };
        if (o.type === "error") return { error: o.message || o.error || "OMP error" };
        return null;
      });
      return r.text != null ? { text: r.text } : { error: r.error || "OMP gave no answer" };
    },
  },
  {
    id: "hermes",
    name: "Hermes Agent",
    goodFor: "Nous Research's agent; any provider you configured.",
    readOnly: "none",
    experimental: true,
    install: "Install Hermes Agent from its project page.",
    signIn: "Run `hermes setup`.",
    locate: () => locate("hermes", "hermes", [isWin ? path.join(LOCAL, "hermes/hermes-agent/venv/Scripts/hermes.exe") : null]),
    signedIn: () => null,
    build: ({ model, prompt }) => ({ args: ["-z", prompt, ...(model ? ["-m", model] : [])], stdin: false }),
    parse: (stdout) => ({ text: stdout.trim() }),
  },
  {
    id: "grok",
    name: "Grok CLI",
    goodFor: "xAI's Grok models.",
    readOnly: "enforced",
    experimental: true,
    install: "Install the Grok CLI from xAI.",
    signIn: "Run `grok` once and sign in.",
    locate: () => locate("grok", "grok", [path.join(HOME, ".grok/bin", isWin ? "grok.exe" : "grok")]),
    signedIn: () => null,
    build: ({ model, write, promptFile }) => ({
      args: ["--prompt-file", promptFile, "--output-format", "json", "--permission-mode", write ? "acceptEdits" : "plan", ...(model ? ["-m", model] : [])],
      stdin: false,
    }),
    parse: (stdout) => {
      const i = stdout.indexOf("{");
      try {
        const o = JSON.parse(stdout.slice(i));
        return { text: o.result ?? o.text ?? stdout.trim() };
      } catch {
        return { text: stdout.trim() };
      }
    },
  },
];

/** Is connect-anything one of Codex's configured MCP servers? (Reads config.toml, never auth.json.) */
function codexHasUs() {
  try {
    const cfg = readFileSync(path.join(process.env.CODEX_HOME || path.join(HOME, ".codex"), "config.toml"), "utf8");
    return /^\s*\[mcp_servers\.["']?connect-anything["']?\]/m.test(cfg);
  } catch {
    return false;
  }
}

/** Cursor's Windows launcher is a .ps1 that runs the newest versions/<date>/node.exe index.js. */
function cursorNode() {
  if (!isWin) return null;
  const root = path.join(LOCAL, "cursor-agent", "versions");
  try {
    const latest = readdirSync(root)
      .filter((d) => statSync(path.join(root, d)).isDirectory())
      .sort()
      .pop();
    if (!latest) return null;
    return path.join(root, latest, "node.exe");
  } catch {
    return null;
  }
}

/** Wire up the common shape: detect() and the cursor special case. */
for (const a of LOCAL_AGENTS) {
  a.kind = "local";
  a.detect = async () => {
    const loc = a.locate();
    if (!loc) return { installed: false, ready: false, readOnly: a.readOnly };
    const signed = a.signedIn();
    return {
      installed: true,
      ready: signed !== false,
      signedIn: signed,
      experimental: !!a.experimental,
      readOnly: a.readOnly,
      note: [signed === false ? "not signed in" : null, a.experimental ? "experimental" : null].filter(Boolean).join(", ") || undefined,
    };
  };
  a.command = () => {
    const loc = a.locate();
    if (!loc) return null;
    // Cursor's node.exe needs its index.js next to it.
    if (a.id === "cursor" && /node\.exe$/i.test(loc.command)) return { command: loc.command, prefix: [path.join(path.dirname(loc.command), "index.js")] };
    return loc;
  };
}
