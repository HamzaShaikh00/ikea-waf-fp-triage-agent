/**
 * WAF false-positive triage helpers: security events (GraphQL Analytics API), WAF rules (Rulesets
 * API) and the scoped exception the agent proposes. Needs the CF_API_TOKEN secret with Zone WAF Edit
 * and Analytics Read on the team zone. All demo traffic is synthetic (scripts/demo-blocks.sh).
 */
export const ZONE_ID = "0eaa240d21e275840098fe9871d27d15";
export const ZONE_NAME = "oceanic-wavelength.cftestdrive.com";
export const DEMO_HOST = `agent.${ZONE_NAME}`;
export const REVIEWERS = ["HamzaShaikh00", "ImranPal"];
const API = "https://api.cloudflare.com/client/v4";

type WafEnv = Env & { CF_API_TOKEN?: string };

export interface SecurityEvent {
  rayName: string;
  datetime: string;
  action: string;
  source: string;
  ruleId: string;
  rulesetId: string;
  description: string;
  clientIP: string;
  clientCountryName: string;
  clientRequestHTTPHost: string;
  clientRequestHTTPMethodName: string;
  clientRequestPath: string;
  clientRequestQuery: string;
  userAgent: string;
  edgeResponseStatus: number;
}

export interface Rule {
  id: string;
  action?: string;
  description?: string;
  expression?: string;
  ratelimit?: Record<string, unknown>;
  categories?: string[];
}

export interface RuleInfo {
  phase: string;
  rulesetId: string;
  rulesetName: string;
  managed: boolean;
  rule: Rule | null;
}

export interface FixPlan {
  mode: "patch_rule" | "add_skip";
  phase: string;
  rulesetId: string;
  ruleId: string;
  /** Body for the Rulesets API on approval. Holds the real client secret, so it is never rendered. */
  live: Record<string, unknown>;
  /** Host + path + method (+ secret header) as one expression, for the skip-rule fallback. */
  scoped: string;
  scope: string;
  files: { path: string; diff: string }[];
}

function token(env: WafEnv) {
  if (!env.CF_API_TOKEN) {
    throw new Error(
      "The CF_API_TOKEN secret is not set yet: run scripts/setup-demo.sh (or npx wrangler secret put CF_API_TOKEN)."
    );
  }
  return env.CF_API_TOKEN;
}

async function api<T>(env: WafEnv, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${token(env)}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const json = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    result?: T;
    errors?: { code: number; message: string }[];
  };
  if (!res.ok || json.success === false) {
    const detail = (json.errors ?? []).map((e) => `${e.code}: ${e.message}`).join("; ");
    throw new Error(`Cloudflare API ${method} ${path} failed (${res.status}) ${detail}`);
  }
  return json.result as T;
}

/** "8f3a1c2d4b5e6071-ARN" or "8F3A…" -> "8f3a1c2d4b5e6071", the form the events API stores. */
export function normalizeRayId(rayId: string) {
  return rayId.trim().toLowerCase().split("-")[0].replace(/[^0-9a-f]/g, "");
}

/** Security events on the zone in the last 24 hours, newest first; one Ray ID when given. */
export async function findSecurityEvents(env: WafEnv, rayId?: string, limit = 10): Promise<SecurityEvent[]> {
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const ray = rayId ? normalizeRayId(rayId) : "";
  const filter = ray ? `{ rayName: "${ray}", datetime_geq: "${since}" }` : `{ datetime_geq: "${since}" }`;
  const query = `{ viewer { zones(filter: { zoneTag: "${ZONE_ID}" }) {
    firewallEventsAdaptive(filter: ${filter}, limit: ${limit}, orderBy: [datetime_DESC]) {
      rayName datetime action source ruleId rulesetId description clientIP clientCountryName
      clientRequestHTTPHost clientRequestHTTPMethodName clientRequestPath clientRequestQuery userAgent edgeResponseStatus
    } } } }`;
  const res = await fetch(`${API}/graphql`, {
    method: "POST",
    headers: { authorization: `Bearer ${token(env)}`, "content-type": "application/json" },
    body: JSON.stringify({ query })
  });
  const json = (await res.json()) as {
    data?: { viewer: { zones: { firewallEventsAdaptive: SecurityEvent[] }[] } } | null;
    errors?: { message: string }[] | null;
  };
  if (json.errors?.length) {
    throw new Error(`Security events query failed: ${json.errors.map((e) => e.message).join("; ")}`);
  }
  return json.data?.viewer.zones[0]?.firewallEventsAdaptive ?? [];
}

/** The ruleset and rule behind an event: phase, name, expression (custom rules) or categories (managed). */
export async function getRuleInfo(env: WafEnv, rulesetId: string, ruleId: string): Promise<RuleInfo> {
  const rs = await api<{ id: string; name: string; kind: string; phase: string; rules?: Rule[] }>(
    env,
    "GET",
    `/zones/${ZONE_ID}/rulesets/${rulesetId}`
  );
  const rule = rs.rules?.find((r) => r.id === ruleId) ?? null;
  return {
    phase: rs.phase,
    rulesetId: rs.id,
    rulesetName: rs.name,
    managed: rs.kind === "managed",
    rule: rule && {
      id: rule.id,
      action: rule.action,
      description: rule.description,
      expression: rule.expression,
      ratelimit: rule.ratelimit,
      categories: rule.categories
    }
  };
}

const hcl = (s: string) => JSON.stringify(s);

/**
 * The narrowest exception for one blocked request: host + path + method, plus an x-client-id header
 * secret when the client can send one. Never an IP allowlist. The Terraform diff references the secret
 * as a sensitive variable; only `live` (sent to Cloudflare on approval) holds the real value.
 */
export function buildFix(event: SecurityEvent, info: RuleInfo, secret: string | null, varName: string): FixPlan {
  const host = event.clientRequestHTTPHost;
  const path = event.clientRequestPath;
  const method = event.clientRequestHTTPMethodName;
  const match = (value: string | null) =>
    `http.request.uri.path eq "${path}" and http.request.method eq "${method}"` +
    (value === null ? "" : ` and any(http.request.headers["x-client-id"][*] eq "${value}")`);
  const tfValue = secret ? "${var." + varName + "}" : null;
  const scoped = `(http.host eq "${host}" and ${match(secret)})`;
  const scope = `${method} ${host}${path}${secret ? " + x-client-id header" : " (no header check)"}`;
  const dir = `terraform/${ZONE_NAME}`;
  const files: FixPlan["files"] = [];
  const variable = secret
    ? {
        path: `${dir}/variables.tf`,
        diff: [
          `+variable "${varName}" {`,
          `+  description = ${hcl(`x-client-id for the client in case ${event.rayName}. Lives in the secrets manager, never in git.`)}`,
          `+  type        = string`,
          `+  sensitive   = true`,
          `+}`
        ].join("\n")
      }
    : null;

  if (info.managed) {
    const description = `FP ${event.rayName}: skip "${event.description}" for ${method} ${path}`;
    files.push({
      path: `${dir}/waf_managed_rules.tf`,
      diff: [
        ` resource "cloudflare_ruleset" "managed_waf" {`,
        `   zone_id = var.zone_id`,
        `   phase   = "http_request_firewall_managed"`,
        `   rules = [`,
        `+    {`,
        `+      description = ${hcl(description)}`,
        `+      expression  = ${hcl(`(http.host eq "${host}" and ${match(tfValue)})`)}`,
        `+      action      = "skip"`,
        `+      action_parameters = {`,
        `+        rules = { ${hcl(info.rulesetId)} = [${hcl(event.ruleId)}] }`,
        `+      }`,
        `+      logging = { enabled = true }`,
        `+    },`,
        `     {`,
        `       description = ${hcl(info.rulesetName)}`,
        `       action      = "execute"`
      ].join("\n")
    });
    if (variable) files.push(variable);
    return {
      mode: "add_skip",
      phase: info.phase,
      rulesetId: info.rulesetId,
      ruleId: event.ruleId,
      live: {
        action: "skip",
        description,
        expression: scoped,
        action_parameters: { rules: { [info.rulesetId]: [event.ruleId] } },
        logging: { enabled: true }
      },
      scoped,
      scope,
      files
    };
  }

  const rule = info.rule ?? { id: event.ruleId };
  const original = rule.expression ?? "true";
  const patched = (value: string | null) => `(${original}) and not (${match(value)})`;
  const resource = info.phase === "http_ratelimit" ? "rate_limits" : "custom_rules";
  files.push({
    path: `${dir}/waf_${resource}.tf`,
    diff: [
      ` resource "cloudflare_ruleset" "${resource}" {`,
      `   zone_id = var.zone_id`,
      `   phase   = ${hcl(info.phase)}`,
      `   rules = [`,
      `     {`,
      `       description = ${hcl(rule.description ?? event.description)}`,
      `       action      = ${hcl(rule.action ?? "block")}`,
      `-      expression  = ${hcl(original)}`,
      `+      expression  = ${hcl(patched(tfValue))}`,
      `     },`
    ].join("\n")
  });
  if (variable) files.push(variable);
  return {
    mode: "patch_rule",
    phase: info.phase,
    rulesetId: info.rulesetId,
    ruleId: rule.id,
    live: {
      action: rule.action ?? "block",
      description: rule.description ?? event.description,
      expression: patched(secret),
      ...(rule.ratelimit ? { ratelimit: rule.ratelimit } : {})
    },
    scoped,
    scope,
    files
  };
}

/** Apply an approved fix to the live zone. Returns one line describing the change. */
export async function applyFix(env: WafEnv, plan: FixPlan): Promise<string> {
  if (plan.mode === "add_skip") {
    const ep = await api<{ id: string; rules: Rule[] }>(
      env,
      "GET",
      `/zones/${ZONE_ID}/rulesets/phases/http_request_firewall_managed/entrypoint`
    );
    const execute = ep.rules.find((r) => r.action === "execute");
    await api(env, "POST", `/zones/${ZONE_ID}/rulesets/${ep.id}/rules`, {
      ...plan.live,
      ...(execute ? { position: { before: execute.id } } : {})
    });
    return "Added a skip rule for that one managed rule, ahead of the managed ruleset.";
  }
  try {
    await api(env, "PATCH", `/zones/${ZONE_ID}/rulesets/${plan.rulesetId}/rules/${plan.ruleId}`, plan.live);
    return "Narrowed the rule so the approved client on that path is no longer blocked.";
  } catch (err) {
    if (plan.phase !== "http_ratelimit") throw err;
    // Free-plan rate limiting rules only match on the path: exempt the client with a skip rule instead.
    const custom = await api<{ id: string }>(
      env,
      "GET",
      `/zones/${ZONE_ID}/rulesets/phases/http_request_firewall_custom/entrypoint`
    );
    await api(env, "POST", `/zones/${ZONE_ID}/rulesets/${custom.id}/rules`, {
      action: "skip",
      action_parameters: { phases: ["http_ratelimit"] },
      logging: { enabled: true },
      description: "Exempt the approved client from the stock lookup rate limit",
      expression: plan.scoped,
      position: { index: 1 }
    });
    return "Added a skip rule that exempts the approved client from the rate limit.";
  }
}

/** A block reported by scripts/demo-blocks.sh (used when the token cannot read security events). */
export interface DemoBlock {
  rayId: string;
  datetime: string;
  scenario: "custom" | "ratelimit" | "managed" | "managed-header";
  status: number;
  method: string;
  path: string;
  query: string;
  userAgent: string;
  clientIP: string;
}

const FREE_MANAGED_RULESET = "77454fe2d30c4220b5701f6fdfb893ba";
const LOG4J_URI_RULE = "7dfd111a6bad4b86bf3522cce6c5792f";

/** Turn a reported block into the same shape as a Cloudflare security event, with the real rule IDs. */
export async function toSecurityEvent(env: WafEnv, b: DemoBlock): Promise<SecurityEvent> {
  let rule =
    b.scenario === "managed-header"
      ? { ruleId: "b453c8ace3a54e0ab7c791510b51dc4d", rulesetId: FREE_MANAGED_RULESET, description: "Log4j Headers", source: "firewallManaged" }
      : { ruleId: LOG4J_URI_RULE, rulesetId: FREE_MANAGED_RULESET, description: "Log4j URI", source: "firewallManaged" };
  if (b.scenario === "custom" || b.scenario === "ratelimit") {
    const phase = b.scenario === "ratelimit" ? "http_ratelimit" : "http_request_firewall_custom";
    const prefix = b.scenario === "ratelimit" ? "Shop API: rate limit" : "Shop API: block oversized bodies";
    const ep = await api<{ id: string; rules: Rule[] }>(env, "GET", `/zones/${ZONE_ID}/rulesets/phases/${phase}/entrypoint`);
    const r = ep.rules.find((x) => (x.description ?? "").startsWith(prefix));
    rule = {
      ruleId: r?.id ?? "",
      rulesetId: ep.id,
      description: r?.description ?? prefix,
      source: b.scenario === "ratelimit" ? "ratelimit" : "firewallCustom"
    };
  }
  return {
    rayName: normalizeRayId(b.rayId),
    datetime: b.datetime,
    action: "block",
    ...rule,
    clientIP: b.clientIP,
    clientCountryName: "SE",
    clientRequestHTTPHost: DEMO_HOST,
    clientRequestHTTPMethodName: b.method,
    clientRequestPath: b.path,
    clientRequestQuery: b.query,
    userAgent: b.userAgent,
    edgeResponseStatus: b.status
  };
}
