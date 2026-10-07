/**
 * `npm run check:team`: stop before dev/deploy if this folder is not set up for YOUR team account.
 *
 * Every team builds in its own Cloudflare account and every account uses the same names, so only two
 * values are yours: "account_id" and the route hostname (both on your team card on the event site).
 * This check catches the mistakes that cost the most time: a placeholder left in wrangler.jsonc, an
 * old account id or API token still set in your terminal, and the event site's own account or hostname.
 *
 * It is an ERROR-PREVENTION check, not a security boundary: Cloudflare permissions are what decide who
 * can deploy where. It never edits your files and is safe to run again.
 *
 * Set CHECK_TEAM_ALLOW_CUSTOM=1 after the event if you deploy this starter to an account of your own
 * with different names.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Keep in step with the event site (scripts/package-starter.mts fails the packaging if these drift).
export const PLACEHOLDER_ACCOUNT_ID = "TEAM_ACCOUNT_ID";
export const PLACEHOLDER_HOSTNAME = "TEAM_HOSTNAME";
export const COMMON_WORKER_NAME = "agent";
export const COMMON_GATEWAY_ID = "agent-gateway";
// The event site's own account and hostname: never a team build target.
export const BLOCKED_ACCOUNT_IDS = ["b64f231d2cf281672c2f4ddb28ddfeed"];
export const BLOCKED_HOSTNAMES = ["ikea.events-cloudflare.com"];

/** Parse JSON with comments and trailing commas, respecting strings (a "//" inside a string stays). */
export function parseJsonc(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
    } else if (c === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
    } else {
      out += c;
      i += 1;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

/** Read KEY=value lines of a dotenv-style file (no interpolation, quotes stripped). */
function readEnvFile(path) {
  if (!existsSync(path)) return {};
  const values = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (match) values[match[1]] = match[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  return values;
}

const HOSTNAME =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

/**
 * Returns { errors, warnings }. Pure apart from reading the files named in `options`.
 * `options.env` is the process environment, `options.dir` the project folder.
 */
export function checkTeam(config, options = {}) {
  const env = options.env ?? {};
  const dir = options.dir ?? ".";
  const allowCustom = env.CHECK_TEAM_ALLOW_CUSTOM === "1";
  const errors = [];
  const warnings = [];

  const accountId = config.account_id;
  if (typeof accountId !== "string" || !accountId) {
    errors.push(
      'wrangler.jsonc has no "account_id". Add the account id from your team card.'
    );
  } else if (accountId === PLACEHOLDER_ACCOUNT_ID) {
    errors.push(
      `"account_id" is still the placeholder ${PLACEHOLDER_ACCOUNT_ID}. Paste the account id from your team card.`
    );
  } else if (!/^[0-9a-f]{32}$/.test(accountId)) {
    errors.push(
      `"account_id" (${accountId}) is not a Cloudflare account id: it is 32 lowercase hex characters, shown on your team card.`
    );
  } else if (BLOCKED_ACCOUNT_IDS.includes(accountId)) {
    errors.push(
      `"account_id" is the old shared event account (${accountId}). Teams now build in their own account: use the id on your team card.`
    );
  }

  const routes = Array.isArray(config.routes) ? config.routes : [];
  const customDomains = routes.filter(
    (r) => r && typeof r === "object" && r.custom_domain === true
  );
  if (customDomains.length === 0) {
    errors.push(
      `wrangler.jsonc has no Custom Domain route. Set "routes": [{ "pattern": "<your demo hostname>", "custom_domain": true }] with the hostname from your team card.`
    );
  }
  for (const route of customDomains) {
    const host = route.pattern;
    if (host === PLACEHOLDER_HOSTNAME) {
      errors.push(
        `The route "pattern" is still the placeholder ${PLACEHOLDER_HOSTNAME}. Paste the demo hostname from your team card.`
      );
    } else if (typeof host !== "string" || !HOSTNAME.test(host)) {
      errors.push(
        `The route pattern "${String(host)}" is not a plain lowercase hostname (no https://, no path, no wildcard).`
      );
    } else if (BLOCKED_HOSTNAMES.includes(host)) {
      errors.push(
        `The route pattern is ${host}, the event site. That is not your demo hostname: a Custom Domain there would take the event site down. Use the hostname on your team card.`
      );
    }
  }

  if (!allowCustom) {
    if (config.name !== COMMON_WORKER_NAME) {
      errors.push(
        `"name" is "${String(config.name)}". Every team account uses "${COMMON_WORKER_NAME}": the Worker and its Custom Domain are set up under that name.`
      );
    }
    const gateway = config.vars?.AI_GATEWAY_ID;
    if (gateway === "") {
      warnings.push(
        `AI_GATEWAY_ID is empty, so model calls skip your AI Gateway. Set it to "${COMMON_GATEWAY_ID}" to log and control them.`
      );
    } else if (gateway !== COMMON_GATEWAY_ID) {
      errors.push(
        `AI_GATEWAY_ID is "${String(gateway)}". Every team account uses "${COMMON_GATEWAY_ID}".`
      );
    }
  }

  if (config.workers_dev === true || config.preview_urls === true) {
    warnings.push(
      "workers_dev or preview_urls is true, so the agent is also reachable on a public workers.dev address. The starter ships both false; only a host should ask you to change that."
    );
  }

  // Environment values that silently override or fight the config (shell, then .env / .dev.vars).
  const sources = [
    ["your terminal", env],
    [".env", readEnvFile(join(dir, ".env"))],
    [".dev.vars", readEnvFile(join(dir, ".dev.vars"))]
  ];
  for (const [label, values] of sources) {
    const envAccount = values.CLOUDFLARE_ACCOUNT_ID;
    if (
      envAccount &&
      typeof accountId === "string" &&
      envAccount !== accountId
    ) {
      errors.push(
        `CLOUDFLARE_ACCOUNT_ID in ${label} is ${envAccount}, which is not the account in wrangler.jsonc. Remove it (macOS/Linux: unset CLOUDFLARE_ACCOUNT_ID, PowerShell: Remove-Item Env:CLOUDFLARE_ACCOUNT_ID).`
      );
    }
    if (values.CLOUDFLARE_API_TOKEN) {
      warnings.push(
        `CLOUDFLARE_API_TOKEN is set in ${label}. It overrides your wrangler login and only works for the account it was made for. If it is from the old shared account or another project, remove it (macOS/Linux: unset CLOUDFLARE_API_TOKEN, PowerShell: Remove-Item Env:CLOUDFLARE_API_TOKEN).`
      );
    }
  }

  return { errors, warnings };
}

function main() {
  const dir = process.cwd();
  const path = join(dir, "wrangler.jsonc");
  let config;
  try {
    config = parseJsonc(readFileSync(path, "utf8"));
  } catch (err) {
    console.error(
      `Team check failed: cannot read wrangler.jsonc (${err.message}).`
    );
    process.exit(1);
  }
  const { errors, warnings } = checkTeam(config, { env: process.env, dir });
  for (const w of warnings) console.warn(`Warning: ${w}`);
  if (errors.length > 0) {
    console.error("\nTeam check: fix these before you continue.\n");
    for (const e of errors) console.error(` - ${e}`);
    console.error(
      "\nBoth values are on your team card (Workspace page of the event site). Not there yet? Ask a host.\n"
    );
    process.exit(1);
  }
  console.log(
    `Team check OK: account ${config.account_id.slice(0, 6)}..., demo hostname ${config.routes.find((r) => r.custom_domain).pattern}.`
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
