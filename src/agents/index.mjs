import { readSettings } from "../home.mjs";
import { resolveCommand } from "../spawn.mjs";
import { CLOUD_AGENTS } from "./cloud.mjs";
import { LOCAL_AGENTS } from "./local.mjs";

/**
 * Your own agents, from ~/.connect-anything/settings.json:
 *   "custom": [{ "id": "aider", "name": "Aider", "command": "aider",
 *                "args": ["--message", "{prompt}", "--yes-always"], "readOnly": "none",
 *                "goodFor": "..." }]
 * `{prompt}` is replaced by the prompt; `"stdin": true` sends it on stdin instead.
 * `{promptFile}` is replaced by a file holding the prompt. Output is taken as plain text.
 */
function customAgents() {
  const list = readSettings().custom;
  if (!Array.isArray(list)) return [];
  return list
    .filter((c) => c && /^[a-z0-9-]+$/i.test(c.id || "") && c.command)
    .map((c) => {
      const a = {
        id: c.id,
        name: c.name || c.id,
        kind: "local",
        custom: true,
        goodFor: c.goodFor || "Your own agent.",
        readOnly: c.readOnly === "enforced" ? "enforced" : "none",
        command: () => resolveCommand(c.command),
        build: ({ prompt, promptFile, write }) => ({
          args: (write && c.writeArgs ? c.writeArgs : c.args || []).map((s) => String(s).replace("{prompt}", prompt).replace("{promptFile}", promptFile)),
          stdin: !!c.stdin,
        }),
        parse: (stdout) => ({ text: stdout.trim() }),
      };
      a.detect = async () => ({ installed: !!a.command(), ready: !!a.command(), readOnly: a.readOnly, note: "custom" });
      return a;
    });
}

export const AGENTS_BUILTIN = [...LOCAL_AGENTS, ...CLOUD_AGENTS];

export function allAgents() {
  return [...AGENTS_BUILTIN, ...customAgents()];
}

export function getAgent(id) {
  const k = String(id || "").toLowerCase().trim();
  const alias = { "claude-code": "claude", "cursor-agent": "cursor", "codex-cli": "codex", devin_cloud: "devin-cloud", codex_cloud: "codex-cloud", claude_cloud: "claude-cloud" };
  return allAgents().find((a) => a.id === (alias[k] || k));
}
