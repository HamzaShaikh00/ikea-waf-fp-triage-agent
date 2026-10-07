#!/usr/bin/env bash
# One-time demo setup: creates the shop-API WAF rules and gives the agent its Cloudflare API token.
# The token is read with a hidden prompt; it is never written to disk or printed.
set -euo pipefail
cd "$(dirname "$0")/.."

read -rsp "Paste the waf-fp-agent Cloudflare API token, then press Enter: " CF_API_TOKEN
echo
export CF_API_TOKEN

echo "Creating the demo WAF rules..."
node scripts/setup-waf-rules.mjs

echo "Saving the token as the agent's CF_API_TOKEN secret..."
# Use the wrangler login (an old CLOUDFLARE_API_TOKEN in the shell would override it).
printf '%s' "$CF_API_TOKEN" | env -u CLOUDFLARE_API_TOKEN -u CLOUDFLARE_ACCOUNT_ID npx wrangler secret put CF_API_TOKEN
echo "Done. Next: ./scripts/demo-blocks.sh"
