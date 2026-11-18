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

// Windows caps a whole command line near 32,767 characters. Agents that only take the prompt as an
// argument get long prompts as an attached file where their CLI supports it, or are refused.
export const ARG_PROMPT_MAX = 28_000;
const FILE_TASK = "Your full task is in the attached file. Read all of it, then do it.";

const textOf = (content) =>
  Array.isArray(content)
    ? content
        .filter((c) => c?.type === "text" && typeof c.text === "string")
        .map((c) => c.text)
        .join("")
    : typeof content === "string"
      ? content
      : null;

/** The most recently changed file in `dir` whose name matches `re`, or null. */
function newest(dir, re) {
  try {
    return (
      readdirSync(dir)
        .filter((n) => re.test(n))
        .map((n) => ({ p: path.join(dir, n), m: statSync(path.join(dir, n)).mtimeMs }))
        .sort((x, y) => y.m - x.m)[0]?.p || null
    );
  } catch {
    return null;
  }
}

/** ZCode's CLI runs inside its desktop app's runtime and reads the app's own provider settings. */
function zcodeEnv() {
  const env = { ELECTRON_RUN_AS_NODE: "1" };
  const v2 = path.join(HOME, ".zcode", "v2");
  if (existsSync(path.join(v2, "provider_config.json"))) env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = path.join(v2, "provider_config.json");
  let best = null;
  const walk = (dir, depth) => {
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 4) walk(p, depth + 1);
      else if (e.name === "zcode-builtin.json") {
        const m = statSync(p).mtimeMs;
        if (!best || m > best.m) best = { p, m };
      }
    }
  };
  walk(path.join(v2, "runtime", "provider"), 0);
  if (best) env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = best.p;
  return env;
}

export const LOCAL_AGENTS = [
  {
    id: "claude",
    // Its read-only mode refuses shell commands, so the prompt says so up front.
    refusesCommandsReadOnly: true,
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
    // Its read-only mode refuses shell commands, so the prompt says so up front.
    refusesCommandsReadOnly: true,
    name: "Devin (local CLI)",
    goodFor: "General coding agent. Pass model \"swe-2\" for Devin's own fast model.",
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
    // Its read-only mode refuses shell commands, so the prompt says so up front.
    refusesCommandsReadOnly: true,
    name: "Cursor Agent",
    goodFor: "Coding with any model on your Cursor plan.",
    readOnly: "enforced",
    install: "Install: https://cursor.com/cli",
    signIn: "Run `cursor-agent login`.",
    locate: () => locate("cursor", "cursor-agent", [cursorNode()].filter(Boolean)) ,
    signedIn: () => null,
    maxPromptChars: ARG_PROMPT_MAX,
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
    build: ({ model, prompt, promptFile }) => ({
      args: ["run", "--format", "json", ...(model ? ["-m", model] : []), ...(prompt.length > ARG_PROMPT_MAX ? [FILE_TASK, "-f", promptFile] : [prompt])],
      stdin: false,
    }),
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
    build: ({ model, prompt, promptFile }) => ({
      args: ["-p", "--mode", "json", ...(model ? ["--model", model] : []), ...(prompt.length > ARG_PROMPT_MAX ? [`@${promptFile}`, FILE_TASK] : [prompt])],
      stdin: false,
    }),
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
    maxPromptChars: ARG_PROMPT_MAX,
    install: "Install Hermes Agent from its project page.",
    signIn: "Run `hermes setup`.",
    locate: () => locate("hermes", "hermes", [isWin ? path.join(LOCAL, "hermes/hermes-agent/venv/Scripts/hermes.exe") : null]),
    signedIn: () => null,
    build: ({ model, prompt }) => ({ args: ["-z", prompt, ...(model ? ["-m", model] : [])], stdin: false }),
    parse: (stdout) => ({ text: stdout.trim() }),
  },
  {
    id: "muse",
    name: "Muse Code",
    goodFor: "Meta's Muse Code agent, on your Muse plan.",
    // `muse exec` wrote a file even with --approval-mode untrusted (checked 17 Nov 2026), so it has
    // no read-only mode we can rely on: it needs write: true.
    readOnly: "none",
    install: "Install Muse Code from Meta.",
    signIn: "Run `muse login`.",
    // On Windows `muse` is a PowerShell launcher; run the newest installed binary it would run.
    locate: () => locate("muse", "muse", [isWin ? newest(path.join(LOCAL, "Programs/muse"), /^muse-bin-.*\.exe$/i) : null]),
    signedIn: () => null,
    build: ({ model, promptFile }) => ({ args: ["exec", "--json", ...(model ? ["--model", model] : []), "--prompt-file", promptFile], stdin: false }),
    parse: (stdout) => {
      const r = lastFromJsonl(stdout, (o) => {
        if (o.payload_type !== "run.terminal.completed" && o.payload?.kind !== "run_terminal") return null;
        const p = o.payload || {};
        return p.terminal === "completed" ? { text: p.text ?? "" } : { error: p.reason || `Muse run ended: ${p.terminal}` };
      });
      return r.text != null ? { text: r.text } : { error: r.error || "Muse Code gave no answer" };
    },
  },
  {
    id: "qwen",
    name: "Qwen Code",
    goodFor: "Alibaba's Qwen Code agent, on your Qwen sign-in.",
    readOnly: "enforced",
    experimental: true,
    install: "Install: npm i -g @qwen-code/qwen-code",
    signIn: "Run `qwen` once and sign in.",
    locate: () => locate("qwen", "qwen"),
    signedIn: () => null,
    build: ({ model, write }) => ({
      args: ["--output-format", "json", "--approval-mode", write ? "yolo" : "plan", ...(model ? ["-m", model] : [])],
      stdin: true,
    }),
    parse: (stdout) => {
      const i = stdout.search(/[[{]/);
      let v;
      try {
        v = JSON.parse(stdout.slice(i));
      } catch {
        const r = lastFromJsonl(stdout, (o) => (o.type === "result" ? (o.is_error ? { error: o.result || "error" } : { text: o.result }) : null));
        return r.text != null ? { text: r.text } : { error: r.error || stdout.trim() || "Qwen Code gave no answer" };
      }
      const last = Array.isArray(v) ? [...v].reverse().find((m) => m?.type === "result") : v;
      if (last?.is_error || last?.error) return { error: String(last.result || last.error?.message || last.error) };
      const text = last?.result ?? last?.response;
      return typeof text === "string" ? { text } : { error: "Qwen Code gave no answer" };
    },
  },
  {
    id: "zcode",
    name: "ZCode (Z.ai)",
    goodFor: "Z.ai's ZCode agent with GLM models, on your Z.ai plan.",
    readOnly: "enforced",
    experimental: true,
    install: "Install the ZCode desktop app from Z.ai.",
    signIn: "Open ZCode once and sign in.",
    locate: () => {
      const exe = isWin ? path.join(LOCAL, "Programs/ZCode/ZCode.exe") : null;
      const cjs = isWin ? path.join(LOCAL, "Programs/ZCode/resources/glm/zcode.cjs") : null;
      return exe && existsSync(exe) && existsSync(cjs) ? { command: exe, prefix: [cjs] } : null;
    },
    signedIn: () => null,
    build: ({ prompt, promptFile, write, cwd, model }) => ({
      args: ["--prompt", prompt.length > ARG_PROMPT_MAX ? `Your full task is in the file ${promptFile}. Read all of it, then do it.` : prompt, "--cwd", cwd, "--mode", write ? "yolo" : "plan", "--output-format", "json", ...(model ? ["--model", model] : [])],
      stdin: false,
      env: zcodeEnv(),
    }),
    parse: (stdout) => {
      const i = stdout.indexOf("{");
      try {
        const o = JSON.parse(stdout.slice(i, stdout.lastIndexOf("}") + 1));
        return typeof o.response === "string" ? { text: o.response } : { error: o.error?.message || o.error || "ZCode gave no answer" };
      } catch {
        return { error: stdout.trim().slice(-300) || "ZCode gave no answer" };
      }
    },
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
  {
    id: "antigravity",
    name: "Antigravity (agy)",
    goodFor: "Google's Antigravity agent, on your Antigravity plan.",
    // Plan mode alone is no gate (with "always proceed" permissions it still wrote files), so read-only
    // runs also set the session's tool permission to request-review: edits and commands then need an
    // approval a headless run can't give, and are refused. Reads in the folder are still allowed.
    readOnly: "enforced",
    refusesCommandsReadOnly: true,
    // One refused tool ends a headless agy turn, and that includes MCP tools.
    readOnlyNote:
      "[Read-only run: you can read files, but running commands or tests, editing files and calling MCP tools will be refused, and a refused tool ends your turn. Answer from reading the code with your file-reading tools; do not try to run anything.]\n\n",
    install: "Install Antigravity; its command-line tool is `agy`.",
    signIn: "Open Antigravity (or run `agy`) once and sign in.",
    locate: () => locate("antigravity", "agy", [isWin ? path.join(LOCAL, "agy/bin/agy.exe") : null]),
    signedIn: () => null,
    // agy takes the prompt only as -p's value; a long prompt goes in a file it is allowed to read.
    build: ({ model, write, prompt, promptFile }) => ({
      args: [
        `-p=${prompt.length > ARG_PROMPT_MAX ? `${FILE_TASK} The file is ${promptFile}` : prompt}`,
        ...(write ? ["--mode", "accept-edits"] : ["--mode", "plan", '--settings={"toolPermission":"request-review"}']),
        "--output-format", "json",
        "--print-timeout", "30m",
        ...(prompt.length > ARG_PROMPT_MAX ? ["--add-dir", path.dirname(promptFile)] : []),
        ...(model ? ["--model", model] : []),
      ],
      stdin: false,
    }),
    parse: (stdout) => {
      let o;
      try {
        o = JSON.parse(stdout.slice(stdout.indexOf("{"), stdout.lastIndexOf("}") + 1));
      } catch {
        return { error: stdout.trim().slice(-400) || "Antigravity gave no answer" };
      }
      const denied = (o.denied_actions || []).map((d) => d.display_name || d.action).filter(Boolean);
      if (o.status === "SUCCESS" && o.response?.trim()) return { text: o.response.trim() };
      if (denied.length) return { error: `Antigravity stopped when ${[...new Set(denied)].join(", ")} was refused: that needs an approval a headless run can't give. Read-only runs refuse edits, commands and MCP tools; for a change, ask again with write: true (Antigravity's own permission settings then apply).` };
      return { error: o.error?.message || o.error || `Antigravity ended with status ${o.status || "unknown"}` };
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
