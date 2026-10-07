import { createWorkersAI } from "workers-ai-provider";
import {
  callable,
  getAgentByName,
  routeAgentRequest,
  type Schedule
} from "agents";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
  convertToModelMessages,
  generateText,
  pruneMessages,
  stepCountIs,
  streamText,
  tool
} from "ai";
import { z } from "zod";
// IKEA Agent Hack addition: this Worker's own `/mcp` (the server Step 6's Secure MCP shield
// protects). Not part of stock agents-starter.
import mcpHandler from "./mcp";
import { renderPullRequest, type PullRequest } from "./pr-page";
import { renderSimulatePage } from "./simulate-page";
import {
  applyFix,
  buildFix,
  toSecurityEvent,
  type DemoBlock,
  DEMO_HOST,
  findSecurityEvents,
  getRuleInfo,
  normalizeRayId,
  REVIEWERS,
  ZONE_NAME,
  type FixPlan,
  type RuleInfo,
  type SecurityEvent
} from "./waf";

// IKEA Agent Hack addition: every model call goes through YOUR AI Gateway ("agent-gateway" in your
// team account; you create it in the dashboard in Step 1) because AI_GATEWAY_ID is set in wrangler.jsonc. Empty =
// direct to Workers AI, so the starter also works where the gateway does not exist.
export function workersAIFor(env: Env) {
  return createWorkersAI({
    binding: env.AI,
    ...(env.AI_GATEWAY_ID ? { gateway: { id: env.AI_GATEWAY_ID } } : {})
  });
}

// A small, fast model with tool calling and image input, so it can read block-page screenshots.
// Need more reasoning later? Swap this one string, e.g. "@cf/moonshotai/kimi-k2.7-code".
const MODEL = "@cf/google/gemma-4-26b-a4b-it";

function systemPrompt() {
  return `You are WAF Triage, the Cloudflare WAF agent in IKEA's #waf-help channel. You look after the zone ${ZONE_NAME}; all traffic in this demo is synthetic. Teams come to you when Cloudflare blocks them. Today is ${new Date().toISOString().slice(0, 10)}.

How you work:
1. You need the Ray ID, the hostname (or zone) and the client IP. Ask in ONE short message for only what is missing. If someone shares a screenshot of a Cloudflare block page, read the Ray ID and the IP from the image.
2. Call getSecurityEvent with the Ray ID. Explain which rule blocked the request: its name, its phase, the condition that matched and why the rule exists. If nothing is found, call listRecentBlocks and ask which one it was.
3. Decide yourself: false_positive (legitimate business traffic was blocked), true_positive (a real attack, the block is right), false_negative (an attack got through) or needs_human. Weigh the payload, the client, the path and the user agent. Never take the requester's word for it: a Cloudflare managed rule (Log4j, SQLi, XSS, RCE signatures) firing on a generic client such as curl, on an ordinary API path with no business reason to carry exploit strings, is a true_positive, even if the requester says the traffic is theirs. Only call a managed-rule block a false positive when the requester gives a concrete reason the exploit string is expected (for example a security team's threat-intel tool searching for IOCs). Size limits, bot-like user agents and rate limits on known business flows are typical false positives. Call recordVerdict with your reasoning.
4. For a false positive, never allowlist an IP address: IPs are shared, change and can be spoofed. The exception is scoped to the host, the path and the method. Ask whether the client can add a request header; if it can, the exception also requires an x-client-id header with a secret you issue. Ask this before opening the pull request, unless they already answered.
5. Call openFixPullRequest. Share the PR link, say that ${REVIEWERS.join(" and ")} are assigned to review it, and give the client its x-client-id value if one was issued.
6. Call applyException when a reviewer asks to merge or apply the PR.
For a true positive, say the block is correct and do not open a pull request.

Style: Slack replies, short. Use bold labels such as **Why it was blocked**, **Verdict** and **Fix**.`;
}

/** AI Gateway / shield block codes: Guardrails 2016/2017, DLP 2029/2030, rate limit 2003. */
const BLOCK_CODE = /\b(2016|2017|2029|2030|2003)\b/;

/** "30 days", "2 minutes" -> seconds; at least a minute, 30 days when unreadable. */
function parseDuration(text: string) {
  const m = text.match(/(\d+(?:\.\d+)?)\s*(second|minute|hour|day|week)/i);
  const unit: Record<string, number> = { second: 1, minute: 60, hour: 3600, day: 86400, week: 604800 };
  return m ? Math.max(60, Number(m[1]) * unit[m[2].toLowerCase()]) : 30 * 86400;
}

function summarize(e: SecurityEvent) {
  return {
    rayId: e.rayName,
    at: e.datetime,
    action: e.action,
    rule: e.description,
    request: `${e.clientRequestHTTPMethodName} ${e.clientRequestHTTPHost}${e.clientRequestPath}`,
    clientIP: e.clientIP,
    userAgent: e.userAgent
  };
}

/** A failed API call becomes a result the model can explain, instead of a broken turn. */
async function safely<T>(fn: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await fn();
  } catch (err) {
    console.error("tool failed:", err);
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

function prBody(o: {
  event: SecurityEvent;
  info: RuleInfo;
  plan: FixPlan;
  reasoning: string | null;
  secret: string | null;
  varName: string;
  reviewAt: string;
}) {
  const e = o.event;
  return [
    "## Summary",
    `False positive: "${e.description}" (${o.info.phase}) blocked ${e.clientRequestHTTPMethodName} ${e.clientRequestPath} on ${e.clientRequestHTTPHost}. Ray ${e.rayName}, ${e.datetime}.`,
    "## Triage",
    o.reasoning ?? "See the #waf-help thread.",
    "## Change",
    `Exception scoped to ${o.plan.scope}. No IP allowlisting.`,
    o.secret
      ? `Requests must carry x-client-id. Its value is kept in the secrets manager (Terraform var.${o.varName}, sensitive) and was sent to the client directly: it is not in this repository.`
      : "No request header check: the client cannot send one, so the exception covers every client on this path and method.",
    "## Rollback",
    "Revert this PR: the original rule applies again on the next terraform apply.",
    "## Review",
    `Time-boxed: the agent re-reviews this exception on ${o.reviewAt.slice(0, 10)}.`
  ].join("\n");
}

export class ChatAgent extends AIChatAgent<Env> {
  maxPersistedMessages = 100;
  chatRecovery = true;
  // Wait for MCP connections to be re-established after hibernation before
  // processing a message, so MCP tools aren't intermittently missing.
  waitForMcpConnections = true;

  onStart() {
    // WAF triage memory: one case per Ray ID, the mock pull requests and the issued x-client-id secrets.
    this.sql`CREATE TABLE IF NOT EXISTS waf_cases (
      ray_id TEXT PRIMARY KEY, created_at TEXT NOT NULL, host TEXT, method TEXT, path TEXT,
      client_ip TEXT, rule_description TEXT, phase TEXT, event_json TEXT, rule_json TEXT,
      verdict TEXT, confidence TEXT, reasoning TEXT, status TEXT NOT NULL DEFAULT 'investigating',
      pr_number INTEGER)`;
    this.sql`CREATE TABLE IF NOT EXISTS waf_prs (
      number INTEGER PRIMARY KEY AUTOINCREMENT, ray_id TEXT NOT NULL, title TEXT NOT NULL,
      body TEXT NOT NULL, branch TEXT NOT NULL, files TEXT NOT NULL, plan TEXT NOT NULL,
      status TEXT NOT NULL, created_at TEXT NOT NULL, review_at TEXT, merged_at TEXT, merged_by TEXT)`;
    this.sql`CREATE TABLE IF NOT EXISTS waf_client_secrets (
      ray_id TEXT PRIMARY KEY, value TEXT NOT NULL, created_at TEXT NOT NULL)`;
    // Blocks forwarded by scripts/demo-blocks.sh, for when the token cannot read security events.
    this.sql`CREATE TABLE IF NOT EXISTS waf_event_log (
      ray_id TEXT PRIMARY KEY, event_json TEXT NOT NULL, created_at TEXT NOT NULL)`;

    // Configure OAuth popup behavior for MCP servers that require authentication
    this.mcp.configureOAuthCallback({
      customHandler: (result) => {
        if (result.authSuccess) {
          return new Response("<script>window.close();</script>", {
            headers: { "content-type": "text/html" },
            status: 200
          });
        }
        return new Response(
          `Authentication Failed: ${result.authError || "Unknown error"}`,
          { headers: { "content-type": "text/plain" }, status: 400 }
        );
      }
    });
  }

  @callable()
  async addServer(name: string, url: string) {
    return await this.addMcpServer(name, url);
  }

  @callable()
  async removeServer(serverId: string) {
    await this.removeMcpServer(serverId);
  }

  /**
   * IKEA Agent Hack addition: POST /api/chat lands here. Same model, system
   * prompt and tool definitions as the chat UI, but one JSON reply instead of a stream.
   * You can curl it, and Step 6's shields (if you explore them) are tested through it.
   *
   * It is the SAME agent as the browser chat: the route below uses the instance the chat page
   * connects to ("default"), so cases, pull requests and schedules are shared and a toast from a
   * scheduled task shows up in an open chat page. Each call is a one-off question (no chat
   * history), and tools that need a human click (approvals) simply end the turn here.
   */
  async chat(message: string): Promise<string> {
    const result = await generateText({
      model: workersAIFor(this.env)(MODEL),
      system: systemPrompt(),
      prompt: message,
      tools: this.tools(),
      stopWhen: stepCountIs(5)
    });
    return result.text;
  }

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const result = streamText({
      model: workersAIFor(this.env)(MODEL, {
        sessionAffinity: this.sessionAffinity
      }),
      system: systemPrompt(),
      // Prune old tool calls and reasoning to save tokens on long conversations
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages",
        reasoning: "before-last-message"
      }),
      tools: this.tools(),
      stopWhen: stepCountIs(20),
      abortSignal: options?.abortSignal
    });

    return result.toUIMessageStreamResponse({
      // The stock chat page does not render stream errors, so a missing gateway looks like silence.
      // Put the cause into the error text and into `npx wrangler tail`.
      onError: (error) => {
        const message = /\b2001\b/.test(String(error))
          ? `The AI Gateway "${this.env.AI_GATEWAY_ID}" does not exist in your account yet (error 2001). Create it in the dashboard: AI > AI Gateway > Create custom gateway, with exactly that Gateway ID.`
          : "The model call failed. Run `npx wrangler tail` to see why.";
        console.error("chat failed:", message, error);
        return message;
      }
    });
  }

  /** Security events for one Ray ID: Cloudflare's events API first, then the forwarded block log. */
  private async eventsFor(ray: string): Promise<SecurityEvent[]> {
    let events: SecurityEvent[] = [];
    let apiError: unknown = null;
    try {
      events = await findSecurityEvents(this.env, ray);
    } catch (err) {
      apiError = err;
    }
    if (events.length > 0) return events;
    const [logged] = this.sql<{ event_json: string }>`SELECT event_json FROM waf_event_log WHERE ray_id = ${ray}`;
    if (logged) return [JSON.parse(logged.event_json) as SecurityEvent];
    if (apiError) throw apiError;
    return [];
  }

  private async recentEvents(limit: number): Promise<SecurityEvent[]> {
    try {
      const events = await findSecurityEvents(this.env, undefined, limit);
      if (events.length > 0) return events;
    } catch {
      // fall through to the forwarded block log
    }
    return this.sql<{ event_json: string }>`SELECT event_json FROM waf_event_log
      ORDER BY created_at DESC LIMIT ${limit}`.map((r) => JSON.parse(r.event_json) as SecurityEvent);
  }

  /** POST /api/events: blocks forwarded by scripts/demo-blocks.sh (a stand-in for a log feed). */
  async ingestEvents(events: SecurityEvent[]) {
    for (const e of events) {
      this.sql`INSERT OR REPLACE INTO waf_event_log (ray_id, event_json, created_at)
        VALUES (${normalizeRayId(e.rayName)}, ${JSON.stringify({ ...e, rayName: normalizeRayId(e.rayName) })}, ${e.datetime})`;
    }
    return events.length;
  }

  /** Read by the mock pull request page (GET /pr/:number). Never returns the fix plan or secrets. */
  getPullRequest(number: number): PullRequest | null {
    const [pr] = this.sql<PullRequest>`SELECT number, ray_id, title, body, branch, files, status,
      created_at, review_at, merged_at, merged_by FROM waf_prs WHERE number = ${number}`;
    return pr ?? null;
  }

  /** One tool set for both the chat UI and POST /api/chat. */
  private tools() {
    return {
      // MCP tools from connected servers
      ...this.mcp.getAITools(),

      getSecurityEvent: tool({
        description:
          "Look up a Cloudflare WAF security event by Ray ID: the rule that fired (name, phase, expression) and the request (host, path, method, user agent, client IP). Use it as soon as you have a Ray ID.",
        inputSchema: z.object({
          rayId: z
            .string()
            .describe("Cloudflare Ray ID, for example 8f3a1c2d4b5e6071 or 8f3a1c2d4b5e6071-ARN")
        }),
        execute: async ({ rayId }) =>
          safely(async () => {
            const ray = normalizeRayId(rayId);
            const events = await this.eventsFor(ray);
            if (events.length === 0) {
              const recent = await this.recentEvents(5);
              return {
                found: false,
                rayId: ray,
                note: `No security event with this Ray ID in the last 24 hours on ${ZONE_NAME}.`,
                recentBlocks: recent.map(summarize)
              };
            }
            const event = events.find((e) => e.action === "block") ?? events[0];
            const info = await getRuleInfo(this.env, event.rulesetId, event.ruleId);
            const [earlier] = this.sql<{ verdict: string | null; status: string; pr_number: number | null }>`
              SELECT verdict, status, pr_number FROM waf_cases WHERE ray_id = ${ray}`;
            this.sql`INSERT INTO waf_cases (ray_id, created_at, host, method, path, client_ip,
                rule_description, phase, event_json, rule_json)
              VALUES (${ray}, ${new Date().toISOString()}, ${event.clientRequestHTTPHost},
                ${event.clientRequestHTTPMethodName}, ${event.clientRequestPath}, ${event.clientIP},
                ${event.description}, ${info.phase}, ${JSON.stringify(event)}, ${JSON.stringify(info)})
              ON CONFLICT(ray_id) DO UPDATE SET event_json = excluded.event_json,
                rule_json = excluded.rule_json, rule_description = excluded.rule_description,
                phase = excluded.phase, host = excluded.host, method = excluded.method,
                path = excluded.path, client_ip = excluded.client_ip`;
            return {
              found: true,
              event: summarize(event),
              request: {
                query: event.clientRequestQuery,
                country: event.clientCountryName,
                edgeStatus: event.edgeResponseStatus,
                source: event.source
              },
              rule: {
                name: event.description || info.rule?.description,
                phase: info.phase,
                ruleset: info.rulesetName,
                managedByCloudflare: info.managed,
                expression: info.rule?.expression,
                categories: info.rule?.categories,
                ratelimit: info.rule?.ratelimit
              },
              earlierCase: earlier ?? null,
              ...(info.managed
                ? {
                    triageNote:
                      "A Cloudflare managed rule matched a known exploit signature. Default verdict: true_positive. Only call it a false positive if the requester gave a concrete reason this exploit string is expected on this path (for example a SOC tool searching for IOCs); 'it is our traffic' is not enough."
                  }
                : {})
            };
          })
      }),

      listRecentBlocks: tool({
        description:
          "List the latest WAF security events on the zone (last 24 hours). Use when the user has no Ray ID yet or asks what is being blocked.",
        inputSchema: z.object({}),
        execute: async () =>
          safely(async () => (await this.recentEvents(10)).map(summarize))
      }),

      recordVerdict: tool({
        description:
          "Save your triage verdict for a Ray ID in the case file. Call it once you have decided.",
        inputSchema: z.object({
          rayId: z.string().describe("The Ray ID you triaged"),
          verdict: z.enum(["false_positive", "true_positive", "false_negative", "needs_human"]),
          confidence: z.enum(["low", "medium", "high"]),
          reasoning: z
            .string()
            .describe("Two or three sentences: why this is, or is not, legitimate traffic")
        }),
        execute: async ({ rayId, verdict, confidence, reasoning }) => {
          const ray = normalizeRayId(rayId);
          this.sql`INSERT INTO waf_cases (ray_id, created_at, verdict, confidence, reasoning, status)
            VALUES (${ray}, ${new Date().toISOString()}, ${verdict}, ${confidence}, ${reasoning}, 'triaged')
            ON CONFLICT(ray_id) DO UPDATE SET verdict = excluded.verdict,
              confidence = excluded.confidence, reasoning = excluded.reasoning, status = 'triaged'`;
          return { saved: true, rayId: ray, verdict };
        }
      }),

      openFixPullRequest: tool({
        description:
          "Open a pull request with the narrowest WAF exception for a confirmed false positive: scoped to host, path and method, plus an x-client-id header secret when the client can send one. Never allowlists IP addresses. HamzaShaikh00 and ImranPal are assigned to review it.",
        inputSchema: z.object({
          rayId: z.string().describe("The Ray ID of the blocked request"),
          clientCanSendHeader: z
            .boolean()
            .describe("true if the client confirmed it can add the x-client-id request header"),
          clientName: z.string().describe("Short name of the client or system, e.g. kitchen-planner"),
          reviewIn: z
            .string()
            .optional()
            .describe('When the exception must be reviewed again, e.g. "30 days" (default)')
        }),
        execute: async ({ rayId, clientCanSendHeader, clientName, reviewIn }) =>
          safely(async () => {
            const ray = normalizeRayId(rayId);
            const [row] = this.sql<{
              event_json: string | null;
              rule_json: string | null;
              verdict: string | null;
              reasoning: string | null;
            }>`SELECT event_json, rule_json, verdict, reasoning FROM waf_cases WHERE ray_id = ${ray}`;
            if (!row?.event_json || !row.rule_json) {
              return { error: "Look the Ray ID up with getSecurityEvent first." };
            }
            if (row.verdict === "true_positive") {
              return { error: "This block was triaged as a real attack: no exception." };
            }
            const event = JSON.parse(row.event_json) as SecurityEvent;
            const info = JSON.parse(row.rule_json) as RuleInfo;
            const slug =
              clientName.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "client";
            const varName = `x_client_id_${slug}`;
            const secret = clientCanSendHeader ? `xcid_${crypto.randomUUID().replace(/-/g, "")}` : null;
            const plan = buildFix(event, info, secret, varName);
            const now = new Date().toISOString();
            const reviewAt = new Date(Date.now() + parseDuration(reviewIn ?? "30 days") * 1000).toISOString();
            const title = `WAF exception: ${event.clientRequestHTTPMethodName} ${event.clientRequestPath} for ${clientName}`;
            const body = prBody({ event, info, plan, reasoning: row.reasoning, secret, varName, reviewAt });
            const [pr] = this.sql<{ number: number }>`INSERT INTO waf_prs (ray_id, title, body, branch,
                files, plan, status, created_at, review_at)
              VALUES (${ray}, ${title}, ${body}, ${`waf-fp/${ray}`}, ${JSON.stringify(plan.files)},
                ${JSON.stringify(plan)}, 'open', ${now}, ${reviewAt})
              RETURNING number`;
            if (secret) {
              this.sql`INSERT OR REPLACE INTO waf_client_secrets (ray_id, value, created_at)
                VALUES (${ray}, ${secret}, ${now})`;
            }
            this.sql`UPDATE waf_cases SET status = 'pr_open', pr_number = ${pr.number} WHERE ray_id = ${ray}`;
            return {
              pullRequest: {
                number: pr.number,
                title,
                url: `https://${DEMO_HOST}/pr/${pr.number}`,
                reviewers: REVIEWERS
              },
              scope: plan.scope,
              ...(secret
                ? {
                    clientHeader: {
                      name: "x-client-id",
                      value: secret,
                      note: "Give this to the client only. The PR references a sensitive Terraform variable, not the value."
                    }
                  }
                : {}),
              reviewAt
            };
          })
      }),

      applyException: tool({
        description:
          "Merge a reviewed WAF exception pull request and apply it to the live zone. Use when a reviewer says to merge or apply PR #n.",
        inputSchema: z.object({
          prNumber: z.number().int().describe("Pull request number"),
          summary: z.string().describe("One line: what changes on the live zone")
        }),
        needsApproval: true,
        execute: async ({ prNumber }) =>
          safely(async () => {
            const [pr] = this.sql<{ ray_id: string; plan: string; status: string; review_at: string | null }>`
              SELECT ray_id, plan, status, review_at FROM waf_prs WHERE number = ${prNumber}`;
            if (!pr) return { error: `There is no PR #${prNumber}.` };
            if (pr.status === "merged") return { error: `PR #${prNumber} is already merged and live.` };
            const change = await applyFix(this.env, JSON.parse(pr.plan) as FixPlan);
            this.sql`UPDATE waf_prs SET status = 'merged', merged_at = ${new Date().toISOString()},
              merged_by = 'approved in #waf-help' WHERE number = ${prNumber}`;
            this.sql`UPDATE waf_cases SET status = 'exception_live' WHERE ray_id = ${pr.ray_id}`;
            // Step 4 primitive: exceptions are time-boxed, so the agent schedules its own review.
            const seconds =
              Math.max(60, Math.round((Date.parse(pr.review_at ?? "") - Date.now()) / 1000)) || 30 * 86400;
            await this.schedule(seconds, "reviewException", { prNumber, rayId: pr.ray_id });
            const [secret] = this.sql<{ value: string }>`
              SELECT value FROM waf_client_secrets WHERE ray_id = ${pr.ray_id}`;
            return {
              applied: true,
              change,
              prUrl: `https://${DEMO_HOST}/pr/${prNumber}`,
              reviewScheduledFor: pr.review_at,
              retest: secret ? `X_CLIENT_ID=${secret.value} ./scripts/demo-blocks.sh` : "./scripts/demo-blocks.sh"
            };
          })
      }),

      listCases: tool({
        description:
          "List recent WAF triage cases from memory: verdicts, open pull requests and live exceptions.",
        inputSchema: z.object({}),
        execute: async () =>
          this.sql`SELECT c.ray_id, c.created_at, c.method, c.path, c.rule_description, c.verdict,
              c.status, c.pr_number, p.review_at
            FROM waf_cases c LEFT JOIN waf_prs p ON p.number = c.pr_number
            ORDER BY c.created_at DESC LIMIT 20`
      })
    };
  }

  async executeTask(description: string, _task: Schedule<string>) {
    // Do the actual work here (send email, call API, etc.)
    console.log(`Executing scheduled task: ${description}`);

    // Notify connected clients via a broadcast event.
    // We use broadcast() instead of saveMessages() to avoid injecting
    // into chat history — that would cause the AI to see the notification
    // as new context and potentially loop.
    this.broadcast(
      JSON.stringify({
        type: "scheduled-task",
        description,
        timestamp: new Date().toISOString()
      })
    );
  }

  /** Scheduled by applyException: an exception is time-boxed, so the agent comes back to it. */
  async reviewException(payload: { prNumber: number; rayId: string }) {
    this.sql`UPDATE waf_cases SET status = 'review_due' WHERE ray_id = ${payload.rayId}`;
    console.log("exception review due", payload);
    this.broadcast(
      JSON.stringify({
        type: "scheduled-task",
        description: `Review due: WAF exception PR #${payload.prNumber} (Ray ${payload.rayId}). Is it still needed?`,
        timestamp: new Date().toISOString()
      })
    );
  }
}

/** The instance the chat page connects to (useAgent without a name). /api/chat uses it too: one agent. */
const CHAT_AGENT_NAME = "default";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // IKEA Agent Hack addition: this Worker's own MCP server (src/mcp.ts) with one
    // `ask_agent` tool. Everything else here is stock agents-starter.
    const url = new URL(request.url);
    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
      return mcpHandler.fetch(request, env, ctx);
    }
    // WAF triage demo: a synthetic shop API behind the demo WAF rules (scripts/demo-blocks.sh).
    // A request that reaches this line was let through by the WAF.
    if (url.pathname.startsWith("/api/shop/")) {
      return Response.json({
        ok: true,
        service: "IKEA shop API (synthetic demo)",
        method: request.method,
        path: url.pathname,
        rayId: request.headers.get("cf-ray")
      });
    }
    // WAF triage demo: blocks forwarded by scripts/demo-blocks.sh. The rule is resolved here
    // from the scenario, using the same token (WAF read) the agent already has.
    if (url.pathname === "/api/events" && request.method === "POST") {
      const raw = (await request.json().catch(() => null)) as DemoBlock[] | null;
      if (!Array.isArray(raw) || raw.length > 20) {
        return Response.json({ error: "expected an array of up to 20 events" }, { status: 400 });
      }
      const blocks = raw.filter(
        (b) => /^[0-9a-f]{16}/.test(String(b.rayId)) && String(b.path).startsWith("/api/shop/")
      );
      const events = await Promise.all(blocks.map((b) => toSecurityEvent(env, b)));
      const agent = await getAgentByName(env.ChatAgent, CHAT_AGENT_NAME);
      return Response.json({ stored: await agent.ingestEvents(events) });
    }
    // WAF triage demo: buttons that send blocked shop traffic from the browser.
    if (url.pathname === "/simulate") {
      return new Response(renderSimulatePage(), { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    // WAF triage demo: the agent's mock pull requests.
    const prPath = url.pathname.match(/^\/pr\/(\d+)$/);
    if (prPath) {
      const agent = await getAgentByName(env.ChatAgent, CHAT_AGENT_NAME);
      const pr = (await agent.getPullRequest(Number(prPath[1]))) as PullRequest | null;
      return pr
        ? new Response(renderPullRequest(pr), { headers: { "content-type": "text/html; charset=utf-8" } })
        : new Response("Pull request not found", { status: 404 });
    }
    // IKEA Agent Hack addition: { "message": "..." } -> { "reply": "..." }.
    if (url.pathname === "/api/chat") {
      if (request.method !== "POST") {
        return Response.json({ error: "POST only" }, { status: 405 });
      }
      const body = (await request.json().catch(() => null)) as {
        message?: unknown;
      } | null;
      if (typeof body?.message !== "string" || !body.message.trim()) {
        return Response.json({ error: "message is required" }, { status: 400 });
      }
      try {
        // getAgentByName (not a raw Durable Object stub) so the Agent starts properly:
        // a raw stub skips onStart(), so a table created there (Step 3) would not exist.
        const agent = await getAgentByName(env.ChatAgent, CHAT_AGENT_NAME);
        const reply = await agent.chat(body.message);
        return Response.json({ reply });
      } catch (err) {
        // A shield said no: return it honestly so a curl or a test can tell "blocked" from "answered".
        const code = String(err).match(BLOCK_CODE)?.[1];
        if (code) {
          return Response.json(
            { blocked: true, code: Number(code) },
            { status: 403 }
          );
        }
        if (/\b2001\b/.test(String(err))) {
          // AI_GATEWAY_ID names a gateway that does not exist yet.
          return Response.json(
            {
              error: "gateway_not_configured",
              detail:
                'The AI Gateway named in AI_GATEWAY_ID does not exist in your account yet (error 2001). Create it: Cloudflare dashboard > AI > AI Gateway > Create custom gateway, set the Gateway ID exactly as AI_GATEWAY_ID (agent-gateway). No redeploy needed. Or set AI_GATEWAY_ID to "" to call Workers AI directly.'
            },
            { status: 500 }
          );
        }
        console.error("/api/chat failed:", err);
        return Response.json({ error: "agent error" }, { status: 500 });
      }
    }
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
