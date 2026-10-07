/**
 * One-time setup for the WAF false-positive demo: creates the shop-API rules that
 * scripts/demo-blocks.sh trips. Needs CF_API_TOKEN (Zone WAF Edit + Analytics Read on the zone).
 * Safe to run again: rules that already exist are left alone.
 */
const ZONE_ID = "0eaa240d21e275840098fe9871d27d15";
const HOST = "agent.oceanic-wavelength.cftestdrive.com";
const FREE_MANAGED_RULESET = "77454fe2d30c4220b5701f6fdfb893ba";
const SHOP = `starts_with(http.request.uri.path, "/api/shop/")`;
const BOT_LIKE = `http.user_agent contains "python-requests" or http.user_agent contains "Go-http-client" or http.user_agent eq ""`;

const token = process.env.CF_API_TOKEN;
if (!token) {
  console.error("CF_API_TOKEN is not set. Run scripts/setup-demo.sh instead.");
  process.exit(1);
}

async function cf(method, path, body) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.success === false) {
    const err = new Error((json.errors ?? []).map((e) => `${e.code}: ${e.message}`).join("; ") || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return json.result;
}

async function entrypoint(phase) {
  try {
    return await cf("GET", `/zones/${ZONE_ID}/rulesets/phases/${phase}/entrypoint`);
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

/** Add `rule` to the phase entrypoint unless a rule whose description starts with `marker` is there. */
async function ensureRule(phase, marker, rule) {
  const ep = await entrypoint(phase);
  if (ep?.rules?.some((r) => (r.description ?? "").startsWith(marker))) return "already there";
  if (!ep) {
    await cf("PUT", `/zones/${ZONE_ID}/rulesets/phases/${phase}/entrypoint`, { rules: [rule] });
    return "created";
  }
  await cf("POST", `/zones/${ZONE_ID}/rulesets/${ep.id}/rules`, rule);
  return "created";
}

async function firstThatWorks(attempts) {
  let last;
  for (const attempt of attempts) {
    try {
      return await attempt();
    } catch (err) {
      last = err;
    }
  }
  throw last;
}

const steps = [
  [
    "Custom rule: oversized bodies + bot-like clients",
    () =>
      firstThatWorks([
        () =>
          ensureRule("http_request_firewall_custom", "Shop API: block oversized bodies", {
            action: "block",
            description: "Shop API: block oversized bodies (over 128 KB, beyond WAF inspection) and bot-like clients",
            expression: `(http.host eq "${HOST}" and ${SHOP} and (http.request.body.size gt 131072 or ${BOT_LIKE}))`
          }),
        // Body fields are not on every plan: fall back to the Content-Length header (6+ digits = 100 KB+).
        () =>
          ensureRule("http_request_firewall_custom", "Shop API: block oversized bodies", {
            action: "block",
            description: "Shop API: block oversized bodies (100 KB+, beyond WAF inspection) and bot-like clients",
            expression: `(http.host eq "${HOST}" and ${SHOP} and (len(http.request.headers["content-length"][0]) ge 6 or ${BOT_LIKE}))`
          })
      ])
  ],
  [
    "Rate limiting rule: stock lookups",
    () => {
      const rule = (expression) => ({
        action: "block",
        description: "Shop API: rate limit stock lookups (5 requests / 10 s per IP)",
        expression,
        ratelimit: { characteristics: ["cf.colo.id", "ip.src"], period: 10, requests_per_period: 5, mitigation_timeout: 10 }
      });
      return firstThatWorks([
        () => ensureRule("http_ratelimit", "Shop API: rate limit", rule(`(http.host eq "${HOST}" and http.request.uri.path eq "/api/shop/stock")`)),
        () => ensureRule("http_ratelimit", "Shop API: rate limit", rule(`(http.request.uri.path eq "/api/shop/stock")`))
      ]);
    }
  ],
  [
    // Zone-wide, as on a fresh Free zone: an entrypoint scoped to one path would switch it off elsewhere.
    "Managed rules: Cloudflare Free Managed Ruleset (zone-wide)",
    () =>
      ensureRule("http_request_firewall_managed", "Cloudflare Free Managed Ruleset", {
        action: "execute",
        action_parameters: { id: FREE_MANAGED_RULESET },
        description: "Cloudflare Free Managed Ruleset (zone-wide, as before)",
        expression: "true"
      })
  ],
  [
    "Analytics read access (security events)",
    async () => {
      const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          query: `{ viewer { zones(filter: { zoneTag: "${ZONE_ID}" }) { firewallEventsAdaptive(limit: 1, filter: { datetime_geq: "${new Date(Date.now() - 3600_000).toISOString()}" }) { rayName } } } }`
        })
      });
      const json = await res.json();
      if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join("; "));
      return "ok";
    }
  ]
];

let failed = false;
for (const [label, run] of steps) {
  try {
    console.log(`  ✓ ${label}: ${await run()}`);
  } catch (err) {
    failed = true;
    console.log(`  ✗ ${label}: ${err.message}`);
  }
}
if (failed) {
  console.log("\nSome steps failed. Check the token has Zone WAF Edit and Analytics Read on oceanic-wavelength.cftestdrive.com.");
  process.exit(1);
}
