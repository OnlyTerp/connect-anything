// Check a connector URL the way an assistant app would use it when you press Connect: from outside,
// with a foreign Origin, initialize -> initialized -> GET -> tools/list, plus the OAuth discovery
// probe. Every failure comes back as a plain sentence about what to fix. Nothing here ever prints
// the URL (it holds the key).

const APP_ORIGIN = "https://claude.ai";
const MARK = "x-connect-anything";

async function call(url, { method = "POST", body, headers = {}, timeoutMs }) {
  const r = await fetch(url, {
    method,
    headers: { Origin: APP_ORIGIN, Accept: "application/json, text/event-stream", ...(body ? { "Content-Type": "application/json" } : {}), "MCP-Protocol-Version": "2025-06-18", ...headers },
    body: body ? JSON.stringify(body) : undefined,
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await r.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  return { status: r.status, ours: r.headers.get(MARK) === "1", json, text };
}

/** Why a response isn't what an app needs, as advice. */
function advise(step, r, port) {
  const err = r.json?.error || "";
  if (!r.ours) {
    if (r.status === 404) return `${step}: the tunnel answered 404 without reaching connect-anything. If you have a ~/.cloudflared/config.yml with ingress rules, a quick tunnel follows them: start it with an empty config, \`cloudflared tunnel --config empty.yml --url http://127.0.0.1:${port || 7777}\`.`;
    if ([502, 503, 504, 530].includes(r.status)) return `${step}: the tunnel is up but can't reach connect-anything (HTTP ${r.status}). Is \`connect-anything serve\` running, on the port the tunnel points at${port ? ` (${port})` : ""}?`;
    if (r.status >= 300 && r.status < 400) return `${step}: the address redirects (HTTP ${r.status}). Apps drop the key on redirects to another host; use the final https address.`;
    return `${step}: something other than connect-anything answered (HTTP ${r.status}). Check the tunnel points at http://127.0.0.1:${port || 7777}.`;
  }
  if (r.status === 403 && /host/i.test(err)) return `${step}: ${err}`;
  if (r.status === 404 || r.status === 401) return `${step}: the key in the URL is wrong or old (it changes if ~/.connect-anything/token is deleted). Copy the connector URL that \`connect-anything serve\` prints now.`;
  return `${step}: HTTP ${r.status}${err ? ` (${err})` : ""}.`;
}

/**
 * Run the app-style check against `url` (https://<host>/mcp/<key>). Returns
 * { ok, steps: [{ step, ok, note }], advice } and never throws.
 */
export async function checkConnector(url, { timeoutMs = 10_000, port } = {}) {
  const steps = [];
  const fail = (step, advice) => (steps.push({ step, ok: false }), { ok: false, steps, advice });
  let u;
  try {
    u = new URL(url);
  } catch {
    return fail("url", "That isn't a URL. It should look like https://<your-tunnel-host>/mcp/<key>.");
  }
  if (u.search) return fail("url", "Remove the ?query from the URL: the key goes in the path, /mcp/<key>.");
  if (!/^\/mcp\/[A-Za-z0-9_-]+\/?$/.test(u.pathname)) return fail("url", "The URL should end in /mcp/<key> (the key from `connect-anything serve`), with nothing after it.");
  const step = async (name, fn) => {
    try {
      const note = await fn();
      if (typeof note === "string" && note.startsWith("!")) return fail(name, note.slice(1));
      steps.push({ step: name, ok: true, note });
      return null;
    } catch (e) {
      const why = e?.name === "TimeoutError" ? `no answer within ${timeoutMs / 1000} s` : e?.cause?.code || e?.message || String(e);
      return fail(name, `${name}: can't reach ${u.host} (${why}). Is the tunnel running, and is this its current address? Quick-tunnel addresses change every time cloudflared starts.`);
    }
  };
  let r;
  let bad = await step("initialize", async () => {
    r = await call(u, { body: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "connect-anything-check", version: "1" } } }, timeoutMs });
    if (r.status !== 200 || !r.json?.result?.serverInfo) return "!" + advise("initialize", r, port);
    return `${r.json.result.serverInfo.name} ${r.json.result.serverInfo.version}`;
  });
  if (bad) return bad;
  bad = await step("initialized", async () => {
    r = await call(u, { body: { jsonrpc: "2.0", method: "notifications/initialized" }, timeoutMs });
    return r.status === 202 ? "202" : "!" + advise("initialized", r, port);
  });
  if (bad) return bad;
  bad = await step("GET", async () => {
    r = await call(u, { method: "GET", timeoutMs });
    return r.status === 405 && r.ours ? "405 (no stream, as allowed)" : "!" + advise("GET", r, port);
  });
  if (bad) return bad;
  bad = await step("tools/list", async () => {
    r = await call(u, { body: { jsonrpc: "2.0", id: 2, method: "tools/list" }, timeoutMs });
    const names = (r.json?.result?.tools || []).map((t) => t.name);
    return r.status === 200 && names.includes("ask") ? names.join(", ") : "!" + advise("tools/list", r, port);
  });
  if (bad) return bad;
  // No sign-in: the OAuth discovery address must say "nothing here" (404), never 401, or an app may
  // start a sign-in that can't finish.
  bad = await step("no sign-in", async () => {
    r = await call(new URL("/.well-known/oauth-protected-resource", u), { method: "GET", timeoutMs });
    return r.status === 404 ? "OAuth discovery answers 404" : `!no sign-in: the OAuth discovery address answered HTTP ${r.status}; apps may try to sign in.`;
  });
  if (bad) return bad;
  return { ok: true, steps, advice: "" };
}

/** Lines for a terminal. */
export function describeCheck(c) {
  const lines = c.steps.map((s) => `  ${s.ok ? "ok  " : "FAIL"} ${s.step}${s.note ? `: ${s.note}` : ""}`);
  lines.push(c.ok ? "  The connector answers the way an assistant app needs." : `  Fix: ${c.advice}`);
  return lines.join("\n");
}
