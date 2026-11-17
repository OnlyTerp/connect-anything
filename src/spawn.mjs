// Spawning other agents' CLIs safely on Windows, macOS and Linux.
//
// - Never through a shell: arguments are passed as argv, so prompts can't be shell-injected.
// - npm installs a `.cmd`/`.ps1` shim on Windows that can't be spawned without a shell. We
//   resolve the shim to the real `node <entry.js>` (or `.exe`) behind it.
// - Output is read as UTF-8.

import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const isWin = process.platform === "win32";

/** Find `name` on PATH. Returns an absolute path or null. */
export function which(name, env = process.env) {
  if (path.isAbsolute(name)) return existsSync(name) ? name : null;
  const dirs = (env.PATH || env.Path || "").split(path.delimiter).filter(Boolean);
  const exts = isWin ? ["", ".exe", ".cmd", ".bat", ".ps1"] : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      try {
        if (statSync(p).isFile()) return p;
      } catch {}
    }
  }
  return null;
}

/**
 * Turn a command found on PATH into something spawnable without a shell.
 * Returns { command, prefix } where prefix is argv to put before the caller's args.
 */
export function resolveCommand(name, env = process.env) {
  const found = which(name, env);
  if (!found) return null;
  if (!isWin) return { command: found, prefix: [] };
  const lower = found.toLowerCase();
  if (lower.endsWith(".exe")) return { command: found, prefix: [] };
  // An extensionless file next to a .cmd is the POSIX shim; prefer the .cmd/.ps1 sibling.
  const base = found.replace(/\.(cmd|bat|ps1)$/i, "");
  for (const shim of [base + ".cmd", base + ".ps1", found]) {
    if (!existsSync(shim)) continue;
    const target = shimTarget(shim);
    if (target) return target;
  }
  if (existsSync(base + ".exe")) return { command: base + ".exe", prefix: [] };
  // Last resort: run the .ps1 through PowerShell with -File (still no shell string parsing).
  if (existsSync(base + ".ps1")) {
    return { command: "powershell.exe", prefix: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", base + ".ps1"] };
  }
  return null;
}

/** Read an npm-style shim and find the node script or exe it launches. */
function shimTarget(shim) {
  let text;
  try {
    text = readFileSync(shim, "utf8");
  } catch {
    return null;
  }
  const dir = path.dirname(shim);
  // npm cmd-shim: "%dp0%\node_modules\pkg\bin\cli.js"  /  ps1: "$basedir/node_modules/pkg/cli.js"
  const m =
    text.match(/"%~?dp0%?\\?([^"%]+?\.(?:js|mjs|cjs|exe))"/i) ||
    text.match(/\$basedir[\\/]([^"'\s]+?\.(?:js|mjs|cjs|exe))/i);
  if (m) {
    const target = path.resolve(dir, m[1].replace(/\\/g, path.sep));
    if (existsSync(target)) {
      if (/\.exe$/i.test(target)) return { command: target, prefix: [] };
      return { command: process.execPath, prefix: [target] };
    }
  }
  // Non-npm shims that call an absolute exe ("C:\...\foo.exe" %*)
  const abs = text.match(/["']?([A-Za-z]:\\[^"'\r\n]+?\.exe)["']?/);
  if (abs && existsSync(abs[1])) return { command: abs[1], prefix: [] };
  return null;
}

/**
 * Run a command to completion. Never throws for a non-zero exit; returns
 * { code, stdout, stderr, timedOut }.
 */
export function run(command, args, { input, cwd, env, timeoutMs = 10 * 60_000, onStdout } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env: { ...process.env, ...env, PYTHONIOENCODING: "utf-8" },
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      resolve({ code: -1, stdout: "", stderr: String(e.message || e), timedOut: false });
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => {
      stdout += d;
      onStdout?.(d);
    });
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + String(e.message || e), timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr, timedOut });
    });
    child.stdin.on("error", () => {});
    if (input != null) child.stdin.end(input, "utf8");
    else child.stdin.end();
  });
}

export function killTree(child) {
  if (!child?.pid) return;
  if (isWin) {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      try {
        child.kill("SIGTERM");
      } catch {}
    }
  }
}
