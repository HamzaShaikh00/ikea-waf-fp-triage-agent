import { createWorkersAI } from "workers-ai-provider";
import {
  callable,
  getAgentByName,
  routeAgentRequest,
  type Schedule
} from "agents";
import { getSchedulePrompt, scheduleSchema } from "agents/schedule";
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

// IKEA Agent Hack addition: every model call goes through YOUR AI Gateway ("agent-gateway" in your
// team account; you create it in the dashboard in Step 1) because AI_GATEWAY_ID is set in wrangler.jsonc. Empty =
// direct to Workers AI, so the starter also works where the gateway does not exist.
export function workersAIFor(env: Env) {
  return createWorkersAI({
    binding: env.AI,
    ...(env.AI_GATEWAY_ID ? { gateway: { id: env.AI_GATEWAY_ID } } : {})
  });
}

// A small, fast model with tool calling and image input, chosen so the first
// replies come back quickly. Need more reasoning later? Swap this one string,
// e.g. "@cf/moonshotai/kimi-k2.7-code" (a much larger model, slower).
const MODEL = "@cf/google/gemma-4-26b-a4b-it";

function systemPrompt() {
  return `You are a helpful assistant that can understand images. You can check the weather, get the user's timezone, run calculations, and schedule tasks. When users share images, describe what you see and answer questions about them.

${getSchedulePrompt({ date: new Date() })}

If the user asks to schedule a task, use the schedule tool to schedule the task.`;
}

/** AI Gateway / shield block codes: Guardrails 2016/2017, DLP 2029/2030, rate limit 2003. */
const BLOCK_CODE = /\b(2016|2017|2029|2030|2003)\b/;

export class ChatAgent extends AIChatAgent<Env> {
  maxPersistedMessages = 100;
  chatRecovery = true;
  // Wait for MCP connections to be re-established after hibernation before
  // processing a message, so MCP tools aren't intermittently missing.
  waitForMcpConnections = true;

  onStart() {
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
   * connects to ("default"), so notes, schedules and workflows are shared and a toast from a
   * scheduled task shows up in an open chat page. Each call is a one-off question (no chat
   * history), and tools that need a browser or a human click (getUserTimezone, approvals) simply
   * end the turn here.
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

  /** One tool set for both the chat UI and POST /api/chat. Add your tools here. */
  private tools() {
    return {
      // MCP tools from connected servers
      ...this.mcp.getAITools(),

      // Server-side tool: runs automatically on the server
      getWeather: tool({
        description: "Get the current weather for a city",
        inputSchema: z.object({
          city: z.string().describe("City name")
        }),
        execute: async ({ city }) => {
          // Replace with a real weather API in production
          const conditions = ["sunny", "cloudy", "rainy", "snowy"];
          const temp = Math.floor(Math.random() * 30) + 5;
          return {
            city,
            temperature: temp,
            condition:
              conditions[Math.floor(Math.random() * conditions.length)],
            unit: "celsius"
          };
        }
      }),

      // Client-side tool: no execute function — the browser handles it
      getUserTimezone: tool({
        description:
          "Get the user's timezone from their browser. Use this when you need to know the user's local time.",
        inputSchema: z.object({})
      }),

      // Approval tool: requires user confirmation before executing
      calculate: tool({
        description:
          "Perform a math calculation with two numbers. Requires user approval for large numbers.",
        inputSchema: z.object({
          a: z.number().describe("First number"),
          b: z.number().describe("Second number"),
          operator: z
            .enum(["+", "-", "*", "/", "%"])
            .describe("Arithmetic operator")
        }),
        needsApproval: async ({ a, b }) =>
          Math.abs(a) > 1000 || Math.abs(b) > 1000,
        execute: async ({ a, b, operator }) => {
          const ops: Record<string, (x: number, y: number) => number> = {
            "+": (x, y) => x + y,
            "-": (x, y) => x - y,
            "*": (x, y) => x * y,
            "/": (x, y) => x / y,
            "%": (x, y) => x % y
          };
          if (operator === "/" && b === 0) {
            return { error: "Division by zero" };
          }
          return {
            expression: `${a} ${operator} ${b}`,
            result: ops[operator](a, b)
          };
        }
      }),

      // IKEA Agent Hack bonus: a human approval gate on a REAL action, not a
      // toy calculator. `calculate` above already shows the pattern; this is
      // a copy-paste starting point for your own irreversible action.
      // Uncomment, rename, and replace the body. For gating a whole durable
      // pipeline, see Workflows `waitForEvent` in the event's Platform Guide.
      //
      // issueGoodwillCredit: tool({
      //   description:
      //     "Issue a goodwill credit to a customer for a service failure. " +
      //     "Call this whenever the user asks for a credit.",
      //   // Do not write "ask for approval" in the description: the model would ask in chat
      //   // text and never call the tool. needsApproval below is what shows the Approve card.
      //   inputSchema: z.object({
      //     customerId: z.string(),
      //     amountCents: z.number().int().positive(),
      //     reason: z.string(),
      //   }),
      //   needsApproval: async ({ amountCents }) => {
      //     console.log("approval check", { amountCents }); // shows in wrangler tail
      //     return amountCents > 5000; // > $50
      //   },
      //   execute: async ({ customerId, amountCents, reason }) => {
      //     // Replace with your real system call once this is more than a demo.
      //     return { customerId, amountCents, reason, issued: true };
      //   },
      // }),

      scheduleTask: tool({
        description:
          "Schedule a task to be executed at a later time. Use this when the user asks to be reminded or wants something done later.",
        inputSchema: scheduleSchema,
        execute: async ({ when, description }) => {
          if (when.type === "no-schedule") {
            return "Not a valid schedule input";
          }
          const input =
            when.type === "scheduled"
              ? when.date
              : when.type === "delayed"
                ? when.delayInSeconds
                : when.type === "cron"
                  ? when.cron
                  : null;
          if (!input) return "Invalid schedule type";
          try {
            this.schedule(input, "executeTask", description, {
              idempotent: true
            });
            return `Task scheduled: "${description}" (${when.type}: ${input})`;
          } catch (error) {
            return `Error scheduling task: ${error}`;
          }
        }
      }),

      getScheduledTasks: tool({
        description: "List all tasks that have been scheduled",
        inputSchema: z.object({}),
        execute: async () => {
          const tasks = this.getSchedules();
          return tasks.length > 0 ? tasks : "No scheduled tasks found.";
        }
      }),

      cancelScheduledTask: tool({
        description: "Cancel a scheduled task by its ID",
        inputSchema: z.object({
          taskId: z.string().describe("The ID of the task to cancel")
        }),
        execute: async ({ taskId }) => {
          try {
            this.cancelSchedule(taskId);
            return `Task ${taskId} cancelled.`;
          } catch (error) {
            return `Error cancelling task: ${error}`;
          }
        }
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
