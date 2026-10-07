/**
 * `/mcp`: this Worker's own MCP server, added on top of stock `agents-starter`. It is what Step 6's
 * "Secure MCP" shield puts Cloudflare Access and an MCP server portal in front of: right now anyone
 * with the URL can list and call its tools.
 *
 * Uses the current `createMcpHandler` + `McpServer` API (not the deprecated `McpAgent`), the same
 * pattern as the event site's own `/mcp`. Stateless: no Durable Object needed for a one-tool server.
 *
 * `ask_agent` below just asks Workers AI to answer as "this team's agent". Replace the body of the
 * handler with a call into your ACTUAL agent logic (for example a method on `ChatAgent`) once you have
 * built something real, or add more tools next to it.
 */
import { createMcpHandler } from "agents/mcp/server";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

/** A fast, cheap model: latency matters more than reasoning depth for a one-sentence answer. */
const MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";

function buildServer(env: Env): McpServer {
  const server = new McpServer({ name: "my-agent", version: "1.0.0" });

  server.registerTool(
    "ask_agent",
    {
      description:
        "Ask this team's agent one question and get a one-sentence answer.",
      inputSchema: { question: z.string().max(1000) }
    },
    async ({ question }: { question: string }) => {
      try {
        const response = await env.AI.run(
          MODEL,
          {
            messages: [
              {
                role: "system",
                content:
                  "You are one team's hackathon agent. Answer the question in one short " +
                  "sentence, from the point of view of what YOUR agent does. Stay in your " +
                  "own lane."
              },
              { role: "user", content: question }
            ]
          },
          // Your AI Gateway (Shield 1) once AI_GATEWAY_ID is set in wrangler.jsonc.
          env.AI_GATEWAY_ID ? { gateway: { id: env.AI_GATEWAY_ID } } : {}
        );
        const text =
          (response as { response?: string }).response?.trim() ||
          "No response.";
        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        // A broken model call returns an error result to the caller instead of crashing the Worker.
        return {
          content: [
            {
              type: "text" as const,
              text: `ask_agent failed: ${err instanceof Error ? err.message : String(err)}`
            }
          ],
          isError: true
        };
      }
    }
  );

  return server;
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return createMcpHandler(() => buildServer(env))(request, env, ctx);
  }
};
