import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Where connect-anything keeps its jobs, mailbox and settings. */
export function home() {
  const d = process.env.CONNECT_ANYTHING_HOME || path.join(os.homedir(), ".connect-anything");
  mkdirSync(d, { recursive: true });
  return d;
}

/** User settings: enabled agents, API keys come from env only (never stored here). */
export function readSettings() {
  const f = path.join(home(), "settings.json");
  if (!existsSync(f)) return {};
  try {
    return JSON.parse(readFileSync(f, "utf8"));
  } catch {
    return {};
  }
}

export function writeSettings(s) {
  writeFileSync(path.join(home(), "settings.json"), JSON.stringify(s, null, 2));
}
