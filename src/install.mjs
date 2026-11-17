// Add connect-anything to the harnesses you use, through each harness's own `mcp add` command
// where it has one, or by editing its MCP config file (a .bak copy is kept first).
// Also installs the connect-anything skill where skills are read.

import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LOCAL_AGENTS } from "./agents/local.mjs";
import { run } from "./spawn.mjs";
import { home as caHome } from "./home.mjs";
import { VERSION } from "./version.mjs";

const NAME = "connect-anything";
const BIN = fileURLToPath(new URL("../bin/connect-anything.mjs", import.meta.url));
const SKILL_DIR = fileURLToPath(new URL("../skills/connect-anything", import.meta.url));
const PKG_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * The script your apps will launch. Run through npx, this package lives in npm's cache, which npm
 * may prune; so it is copied once to <home>/app/<version>/ and that copy is registered. No network
 * at app start, no silent updates: run `install` again after upgrading.
 */
let previewOnly = false;
function stableBin() {
  if (!/[\\/]_npx[\\/]/.test(PKG_ROOT)) return BIN;
  const dest = path.join(caHome(), "app", VERSION);
  if (!previewOnly && !existsSync(path.join(dest, "bin", "connect-anything.mjs"))) {
    for (const d of ["bin", "src", "ui", "skills", "package.json", "LICENSE"]) {
      if (existsSync(path.join(PKG_ROOT, d))) cpSync(path.join(PKG_ROOT, d), path.join(dest, d), { recursive: true });
    }
  }
  return path.join(dest, "bin", "connect-anything.mjs");
}

/** How every harness launches the server: this Node, an absolute script path. No PATH lookups at run time. */
export const SERVER = {
  command: process.execPath,
  get args() {
    return [stableBin(), "mcp"];
  },
};

const home = () => process.env.CONNECT_ANYTHING_INSTALL_HOME || os.homedir();
const appData = () => (process.env.CONNECT_ANYTHING_INSTALL_HOME ? path.join(home(), "AppData/Roaming") : process.env.APPDATA || path.join(home(), "Library/Application Support"));
const cliEnv = () =>
  process.env.CONNECT_ANYTHING_INSTALL_HOME
    ? { HOME: home(), USERPROFILE: home(), CLAUDE_CONFIG_DIR: path.join(home(), ".claude"), CODEX_HOME: path.join(home(), ".codex") }
    : {};

const cmdOf = (id) => LOCAL_AGENTS.find((a) => a.id === id)?.command();

async function viaCli(id, addArgs, removeArgs, { dryRun, uninstall }) {
  const c = cmdOf(id);
  if (!c) return { ok: false, message: "not installed" };
  const args = uninstall ? removeArgs : addArgs;
  if (dryRun) return { ok: true, message: `would run: ${path.basename(c.command)} ${args.join(" ")}` };
  if (!uninstall) await run(c.command, [...c.prefix, ...removeArgs], { env: cliEnv(), timeoutMs: 60_000 }); // replace an old entry
  const r = await run(c.command, [...c.prefix, ...args], { env: cliEnv(), timeoutMs: 60_000 });
  const out = (r.stdout + r.stderr).trim().split("\n").pop();
  return r.code === 0 ? { ok: true, message: uninstall ? "removed" : "added (user scope)" } : { ok: false, message: out || `exit ${r.code}` };
}

/** Merge into a JSON config file: `set(obj)` mutates it. Keeps a .bak of the original. */
function editJson(file, set, { dryRun }) {
  let obj = {};
  if (existsSync(file)) {
    const text = readFileSync(file, "utf8");
    try {
      obj = text.trim() ? JSON.parse(text) : {};
    } catch {
      return { ok: false, message: `${file} is not plain JSON (comments?). Add it by hand: ${JSON.stringify(SERVER)}` };
    }
  }
  const before = JSON.stringify(obj);
  set(obj);
  if (JSON.stringify(obj) === before) return { ok: true, message: `no change needed (${file})` };
  if (dryRun) return { ok: true, message: `would update ${file}` };
  mkdirSync(path.dirname(file), { recursive: true });
  if (existsSync(file)) copyFileSync(file, file + ".bak");
  writeFileSync(file, JSON.stringify(obj, null, 2) + "\n");
  return { ok: true, message: `updated ${file}${existsSync(file + ".bak") ? " (backup: .bak)" : ""}` };
}

const mcpServersEntry = (uninstall) => (o) => {
  o.mcpServers ||= {};
  if (uninstall) delete o.mcpServers[NAME];
  else o.mcpServers[NAME] = { command: SERVER.command, args: SERVER.args };
};

export const HARNESSES = {
  claude: {
    name: "Claude Code",
    detect: () => !!cmdOf("claude"),
    install: (o) => viaCli("claude", ["mcp", "add", "-s", "user", NAME, "--", SERVER.command, ...SERVER.args], ["mcp", "remove", "-s", "user", NAME], o),
    skills: () => path.join(process.env.CONNECT_ANYTHING_INSTALL_HOME ? path.join(home(), ".claude") : process.env.CLAUDE_CONFIG_DIR || path.join(home(), ".claude"), "skills"),
  },
  codex: {
    name: "Codex",
    detect: () => !!cmdOf("codex"),
    install: (o) => viaCli("codex", ["mcp", "add", NAME, "--", SERVER.command, ...SERVER.args], ["mcp", "remove", NAME], o),
    skills: () => path.join(home(), ".agents", "skills"),
  },
  devin: {
    name: "Devin CLI",
    detect: () => !!cmdOf("devin"),
    install: (o) => viaCli("devin", ["mcp", "add", "-s", "user", NAME, "--", SERVER.command, ...SERVER.args], ["mcp", "remove", "-s", "user", NAME], o),
    skills: () => path.join(home(), ".agents", "skills"),
  },
  grok: {
    name: "Grok CLI",
    detect: () => !!cmdOf("grok"),
    install: (o) => viaCli("grok", ["mcp", "add", "-s", "user", NAME, "--", SERVER.command, ...SERVER.args], ["mcp", "remove", "-s", "user", NAME], o),
  },
  hermes: {
    name: "Hermes Agent",
    detect: () => !!cmdOf("hermes"),
    install: (o) => viaCli("hermes", ["mcp", "add", NAME, "--command", SERVER.command, "--args", ...SERVER.args], ["mcp", "remove", NAME], o),
  },
  cursor: {
    name: "Cursor (editor + cursor-agent)",
    detect: () => !!cmdOf("cursor") || existsSync(path.join(home(), ".cursor")),
    install: (o) => editJson(path.join(home(), ".cursor", "mcp.json"), mcpServersEntry(o.uninstall), o),
  },
  opencode: {
    name: "OpenCode",
    detect: () => !!cmdOf("opencode"),
    install: (o) =>
      editJson(
        path.join(home(), ".config", "opencode", "opencode.json"),
        (c) => {
          c.mcp ||= {};
          if (o.uninstall) delete c.mcp[NAME];
          else c.mcp[NAME] = { type: "local", command: [SERVER.command, ...SERVER.args], enabled: true };
        },
        o,
      ),
  },
  "claude-desktop": {
    name: "Claude Desktop (chat app)",
    detect: () => existsSync(path.join(appData(), "Claude")),
    install: (o) => editJson(path.join(appData(), "Claude", "claude_desktop_config.json"), mcpServersEntry(o.uninstall), o),
  },
};

function installSkill(dir, { dryRun, uninstall }) {
  const dest = path.join(dir, NAME);
  if (dryRun) return `would ${uninstall ? "remove" : "copy"} skill ${dest}`;
  if (uninstall) {
    rmSync(dest, { recursive: true, force: true });
    return `removed skill ${dest}`;
  }
  mkdirSync(dir, { recursive: true });
  cpSync(SKILL_DIR, dest, { recursive: true });
  return `skill → ${dest}`;
}

/** Install into the named harnesses, or every detected one. */
export async function install({ harnesses = [], dryRun = false, uninstall = false } = {}) {
  previewOnly = dryRun;
  const ids = harnesses.length ? harnesses : Object.keys(HARNESSES).filter((h) => HARNESSES[h].detect());
  const out = [];
  const skillDirs = new Set();
  for (const id of ids) {
    const h = HARNESSES[id];
    if (!h) {
      out.push({ harness: id, ok: false, message: `unknown harness; known: ${Object.keys(HARNESSES).join(", ")}` });
      continue;
    }
    let r;
    try {
      r = await h.install({ dryRun, uninstall });
    } catch (e) {
      r = { ok: false, message: String(e?.message || e) };
    }
    if (r.ok && h.skills) skillDirs.add(h.skills());
    out.push({ harness: id, ...r });
  }
  for (const d of skillDirs) out.push({ harness: "skill", ok: true, message: installSkill(d, { dryRun, uninstall }) });
  return out;
}

/** What to paste into any other MCP client (stdio). */
export const manualConfig = () => ({ mcpServers: { [NAME]: { command: SERVER.command, args: SERVER.args } } });
