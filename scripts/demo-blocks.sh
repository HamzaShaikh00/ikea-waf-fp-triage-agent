#!/usr/bin/env bash
# Demo traffic for the WAF false-positive agent: trips each shop-API rule and prints the Ray IDs.
#   ./scripts/demo-blocks.sh                                      before the fix: expect blocks
#   X_CLIENT_ID=<value from the agent> ./scripts/demo-blocks.sh   after the fix: the approved call passes
# Blocks are also forwarded to the agent (POST /api/events), a stand-in for a security log feed.
HOST="${HOST:-agent.oceanic-wavelength.cftestdrive.com}"
BASE="https://$HOST/api/shop"
UA_BROWSER="Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15"
EXTRA=()
[ -n "${X_CLIENT_ID:-}" ] && EXTRA=(-H "x-client-id: $X_CLIENT_ID")
MY_IP=$(curl -s "https://$HOST/cdn-cgi/trace" | awk -F= '$1=="ip"{print $2}')
EVENTS=""

# hit "<label>" <scenario> <method> <path> <query> <user agent> [extra curl args...]
hit() {
  local label="$1" scenario="$2" method="$3" path="$4" query="$5" ua="$6"; shift 6
  local head code ray
  head=$(curl -s -o /dev/null -D - -X "$method" -A "$ua" "$@" ${EXTRA[@]+"${EXTRA[@]}"} "https://$HOST$path$query" | tr -d '\r')
  code=$(printf '%s\n' "$head" | awk 'NR==1{print $2}')
  ray=$(printf '%s\n' "$head" | awk -F': ' 'tolower($1)=="cf-ray"{print $2}')
  printf '  %-46s HTTP %s   Ray ID %s\n' "$label" "$code" "$ray"
  if [ "$code" = "403" ] || [ "$code" = "429" ]; then
    EVENTS="$EVENTS${EVENTS:+,}{\"rayId\":\"$ray\",\"datetime\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"scenario\":\"$scenario\",\"status\":$code,\"method\":\"$method\",\"path\":\"$path\",\"query\":\"$query\",\"userAgent\":\"$ua\",\"clientIP\":\"$MY_IP\"}"
  fi
}

echo "Shop API demo traffic -> $HOST${X_CLIENT_ID:+ (with x-client-id)}"

BODY=$(mktemp)
{ printf '{"design":"kitchen-3d-export","units":"cm","mesh":"'; head -c 300000 /dev/zero | tr '\0' 'A'; printf '"}'; } > "$BODY"
hit "1. Kitchen planner: 300 KB design upload" custom POST /api/shop/kitchen-planner/designs "" "$UA_BROWSER" \
  -H 'content-type: application/json' --data-binary @"$BODY"
rm -f "$BODY"

hit "2. Store inventory sync job (python-requests)" custom GET /api/shop/inventory/sync "?store=445" "python-requests/2.32.3"

hit "3. SOC threat-intel lookup (Log4Shell IOC)" managed GET /api/shop/soc/lookup \
  '?ioc=%24%7Bjndi%3Aldap%3A%2F%2F203.0.113.66%3A1389%2Fa%7D' "$UA_BROWSER"

echo "  4. Store stock checker: 8 lookups in a burst"
for i in 1 2 3 4 5 6 7 8; do
  hit "     lookup $i" ratelimit GET /api/shop/stock "?item=BILLY-80x28&store=445" "$UA_BROWSER"
done

if [ -n "$EVENTS" ]; then
  curl -s -o /dev/null -X POST "https://$HOST/api/events" -H 'content-type: application/json' -d "[$EVENTS]"
fi
echo
echo "Paste a Ray ID into #waf-help: https://$HOST"
