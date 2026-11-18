// The setup page and MCP over HTTP, on 127.0.0.1 only.
//
// Security:
// - Binds 127.0.0.1. Requests whose Host isn't this machine (or the --public-host you chose for a
//   tunnel) are refused, which blocks DNS-rebinding pages.
// - Every API call and every MCP call needs the token from <home>/token (a page from another site
//   can't read it). The setup page never contains it: `setup` opens the page with the token in
//   the URL fragment (#t=...), which browsers keep to themselves.
// - Over HTTP, agents run read-only unless the server was started with --allow-write, only in folders
//   listed in settings.httpRoots (default: the folder the server started in), and never start
//   cloud agents (they spend your plan) unless started with --allow-cloud.

import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as core from "./core.mjs";
import { handle } from "./mcp.mjs";
import { getAgent } from "./agents/index.mjs";
import { home, readSettings, writeSettings } from "./home.mjs";
import { HARNESSES, install, manualConfig } from "./install.mjs";
import { VERSION } from "./version.mjs";
import { checkConnector, describeCheck } from "./connector.mjs";

const UI = fileURLToPath(new URL("../ui/index.html", import.meta.url));

export function token() {
  const f = path.join(home(), "token");
  if (!existsSync(f)) writeFileSync(f, randomBytes(24).toString("base64url"), { mode: 0o600 });
  return readFileSync(f, "utf8").trim();
}

const same = (a, b) => {
  const x = Buffer.from(String(a || ""));
  const y = Buffer.from(String(b || ""));
  return x.length === y.length && timingSafeEqual(x, y);
};

/** The first free port from `start` (tries 20). */
function freePort(start) {
  return new Promise((resolve, reject) => {
    const tryPort = (p) => {
      if (p >= start + 20) return reject(new Error(`No free port between ${start} and ${start + 19}. Pass --port.`));
      const s = createServer();
      s.once("error", () => tryPort(p + 1));
      s.listen(p, "127.0.0.1", () => s.close(() => resolve(p)));
    };
    tryPort(start);
  });
}

export async function serveHttp({ port = 7777, fixedPort = false, open = false, allowWrite = false, allowCloud = false, publicHost = process.env.CONNECT_ANYTHING_PUBLIC_HOST, selfCheck = !process.env.CONNECT_ANYTHING_NO_SELFCHECK } = {}) {
  if (!fixedPort) port = await freePort(port);
  publicHost = publicHost ? String(publicHost).replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase() : publicHost;
  const warnedHosts = new Set();
  const tok = token();
  const startDir = process.cwd();
  const okHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, ...(publicHost ? [publicHost.toLowerCase()] : [])]);

  const server = createServer(async (req, res) => {
    const send = (code, body, type = "application/json") => {
      res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Connect-Anything": "1" });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    try {
      const host = String(req.headers.host || "").toLowerCase();
      if (!okHosts.has(host)) {
        const shown = host.replace(/[^a-z0-9.:-]/g, "").slice(0, 100);
        if (shown && !warnedHosts.has(shown) && warnedHosts.size < 5) {
          warnedHosts.add(shown);
          console.log(`  Refused a request for host ${shown}. If that is your tunnel, restart with: connect-anything serve --public-host ${shown}`);
        }
        return send(403, { error: `Unknown host${shown ? ` ${shown}` : ""}. If this is your tunnel, restart connect-anything with --public-host ${shown || "<your-tunnel-host>"} (a quick tunnel gets a new address every time it starts).` });
      }
      const local = host.startsWith("127.0.0.1:") || host.startsWith("localhost:");
      // Pages in your browser may not call this server (Origin check). Assistant apps call a tunnel
      // from their own servers and some send their Origin; the public host serves only /mcp/<key>
      // (everything else is 404 there), so there the key is the check.
      const origin = req.headers.origin;
      const sameOrigin = !origin || okHosts.has(origin.replace(/^https?:\/\//, "").toLowerCase());
      const url = new URL(req.url, `http://${host}`);
      const mcpPath = url.pathname.match(/^\/mcp(?:\/([A-Za-z0-9_-]+))?\/?$/);
      if (!sameOrigin && local) return send(403, { error: "Cross-site request refused." });

      // The setup page. It holds no token: the token travels in the URL fragment.
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        if (!local) return send(404, { error: "Not found" });
        const html = readFileSync(UI, "utf8").replace("__CA_VERSION__", VERSION);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:", "X-Frame-Options": "DENY" });
        return res.end(html);
      }

      // MCP over HTTP: POST /mcp/<token> (what apps should use: no header to get right, no sign-in),
      // or POST /mcp with the token in Authorization (with or without "Bearer"), X-API-Key or X-Auth-Token.
      // No OAuth: a wrong key in the path answers 404, not 401, so an app never starts a sign-in it can't finish.
      if (mcpPath) {
        if (mcpPath[1]) {
          if (!same(mcpPath[1], tok)) return send(404, { error: "No connector at this address. The key in the URL is wrong or old: copy the connector URL that `connect-anything serve` prints." });
        } else {
          const given = [String(req.headers.authorization || "").replace(/^Bearer\s+/i, ""), req.headers["x-api-key"], req.headers["x-auth-token"]].map((v) => String(v || "").trim());
          if (!given.some((g) => same(g, tok))) return send(401, { error: "Missing or wrong key. Easiest: use the connector URL that ends in /mcp/<key> and set the app's authentication to none (no sign-in, no headers)." });
        }
        if (req.method === "GET") return send(405, { error: "This server answers POST only (no SSE stream)." });
        if (req.method === "DELETE") return send(200, {});
        if (req.method !== "POST") return send(405, { error: "POST only." });
        const msg = await body(req);
        const guard = { remote: true, allowWrite, allowCloud, roots: roots(startDir) };
        const msgs = Array.isArray(msg) ? msg : [msg];
        const out = [];
        for (const m of msgs) {
          let r;
          try {
            r = await handle(restrict(m, guard), { caller: "http", onlyCaller: "http" });
          } catch (e) {
            r = { jsonrpc: "2.0", id: m?.id ?? null, result: { content: [{ type: "text", text: String(e?.message || e) }], isError: true } };
          }
          if (r) out.push(r);
        }
        if (!out.length) {
          res.writeHead(202, { "X-Connect-Anything": "1" });
          return res.end();
        }
        const ver = msgs.find((m) => m?.method === "initialize") ? { "Mcp-Session-Id": randomBytes(8).toString("hex") } : {};
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Connect-Anything": "1", ...ver });
        return res.end(JSON.stringify(Array.isArray(msg) ? out : out[0]));
      }

      // The setup page's API.
      if (url.pathname.startsWith("/api/")) {
        if (!local) return send(404, { error: "Not found" });
        if (!same(req.headers["x-ca-token"], tok)) return send(401, { error: "Missing or wrong token." });
        if (req.method === "GET" && url.pathname === "/api/state") {
          const s = readSettings();
          return send(200, {
            version: VERSION,
            agents: (await core.listAgents()).map((a) => ({ ...a, group: core.groupOf(a) })),
            harnesses: Object.entries(HARNESSES).map(([id, h]) => ({ id, name: h.name, detected: !!h.detect(), installed: (s.installed || []).includes(id) })),
            jobs: core.recentJobs(10),
            manual: manualConfig(),
            mcpUrl: `http://127.0.0.1:${port}/mcp`,
            allowWrite,
          });
        }
        if (req.method === "POST" && url.pathname === "/api/install") {
          const b = await body(req);
          const ids = (b.harnesses || []).filter((h) => HARNESSES[h]);
          const result = await install({ harnesses: ids, uninstall: !!b.uninstall });
          const s = readSettings();
          const set = new Set(s.installed || []);
          for (const r of result) if (r.ok && HARNESSES[r.harness]) (b.uninstall ? set.delete(r.harness) : set.add(r.harness));
          writeSettings({ ...s, installed: [...set] });
          return send(200, { result });
        }
        if (req.method === "POST" && url.pathname === "/api/agents") {
          const b = await body(req);
          const s = readSettings();
          const disabled = new Set(s.disabled || []);
          if (b.enabled) disabled.delete(b.id);
          else disabled.add(b.id);
          writeSettings({ ...s, disabled: [...disabled] });
          return send(200, { ok: true });
        }
        if (req.method === "POST" && url.pathname === "/api/doctor") {
          return send(200, { results: await core.doctor() });
        }
        if (req.method === "POST" && url.pathname === "/api/ask") {
          const b = await body(req);
          // The page only tries local agents; it never starts paid cloud work.
          if (getAgent(b.agent)?.kind !== "local") return send(400, { error: "The setup page can only try local agents." });
          const job = await core.ask({ agent: b.agent, prompt: String(b.prompt || ""), cwd: startDir, wait_s: 0, write: false, caller: "setup-page" });
          return send(200, { job });
        }
        const jm = url.pathname.match(/^\/api\/job\/([A-Za-z0-9-]+)$/);
        if (req.method === "GET" && jm) return send(200, { job: await core.getJob(jm[1], 0), text: core.describeJob(await core.getJob(jm[1], 0)) });
        return send(404, { error: "Not found" });
      }
      return send(404, { error: "Not found" });
    } catch (e) {
      return send(400, { error: String(e?.message || e) });
    }
  });

  server.listen(port, "127.0.0.1", () => {
    const u = `http://127.0.0.1:${port}/`;
    console.log(`connect-anything ${VERSION}`);
    const page = `${u}#t=${tok}`;
    console.log(`  setup page:  ${page}`);
    console.log(`  MCP (HTTP):  ${u}mcp/<key>   (key in ${path.join(home(), "token")})`);
    if (publicHost) {
      const connector = `https://${publicHost}/mcp/${tok}`;
      console.log("");
      console.log("  Connector URL. Paste it whole into your assistant's custom connector; it is a password:");
      console.log(`    ${connector}`);
      console.log("  Authentication: none. In Claude pick \"No sign-in\", in ChatGPT \"No authentication\". Leave request headers empty.");
      console.log("");
      if (selfCheck) selfCheckLoop(connector, port);
    }
    if (!allowWrite) console.log("  HTTP callers are read-only (start with --allow-write to change that).");
    if (!allowCloud) console.log("  HTTP callers can't start cloud agents (start with --allow-cloud to change that).");
    if (open) openBrowser(page);
  });
  return server;
}

/** Check the public URL as an app would, retrying for a minute while the tunnel comes up. */
async function selfCheckLoop(connector, port) {
  const end = Date.now() + 60_000;
  let c;
  for (;;) {
    c = await checkConnector(connector, { port, timeoutMs: 8_000 });
    const unreachable = !c.ok && /can't reach|tunnel is up but/.test(c.advice);
    if (c.ok || !unreachable || Date.now() > end) break;
    await new Promise((r) => setTimeout(r, 5_000));
  }
  console.log(`  Connector check (from outside, as an app would connect):
${describeCheck(c)}`);
  if (!c.ok) console.log("  Check again any time: connect-anything check-url <connector URL>");
}

/** The folders HTTP callers may point agents at. */
function roots(startDir) {
  const r = readSettings().httpRoots;
  return (Array.isArray(r) && r.length ? r : [startDir]).map((p) => path.resolve(p));
}

/** Enforce the HTTP rules on an MCP tool call before it reaches the core. */
function restrict(m, { allowWrite, allowCloud, roots: rs }) {
  if (m?.method !== "tools/call" || !["ask", "spawn"].includes(m.params?.name)) return m;
  const a = { ...(m.params.arguments || {}) };
  if (m.params.name === "spawn" && !allowCloud) {
    throw new Error("Over HTTP, cloud agents are off (they spend your plan and push branches). Restart `connect-anything serve` with --allow-cloud to allow them.");
  }
  if (getAgent(a.agent)?.kind === "cloud" && !allowCloud) {
    throw new Error("Over HTTP, cloud agents are off (they spend your plan and push branches). Restart `connect-anything serve` with --allow-cloud to allow them.");
  }
  if (a.write && !allowWrite) throw new Error("Over HTTP, agents are read-only. Restart connect-anything serve with --allow-write to allow changes.");
  a.cwd = path.resolve(a.cwd || rs[0]);
  const inside = rs.some((r) => a.cwd === r || a.cwd.startsWith(r + path.sep));
  if (!inside) throw new Error(`Over HTTP, agents may only work in: ${rs.join(", ")} (settings.httpRoots).`);
  return { ...m, params: { ...m.params, arguments: a } };
}

function body(req) {
  return new Promise((resolve, reject) => {
    let s = "";
    req.setEncoding("utf8");
    req.on("data", (d) => {
      s += d;
      if (s.length > 1_000_000) {
        reject(new Error("Request too large."));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(s ? JSON.parse(s) : {});
      } catch {
        reject(new Error("Body is not JSON."));
      }
    });
  });
}

function openBrowser(u) {
  const [cmd, args] = process.platform === "win32" ? ["explorer.exe", [u]] : process.platform === "darwin" ? ["open", [u]] : ["xdg-open", [u]];
  spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
}
