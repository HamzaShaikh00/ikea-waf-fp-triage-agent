# Instructions for your coding agent

This is the IKEA Agent Hack starter: a chat agent on Cloudflare's Agents SDK. The person you are
helping may be new to Cloudflare. Keep answers short and in plain language.

## Ground rules

- Check the live docs before writing against the Agents SDK, Workflows, AI Search, Browser Run or
  AI Gateway: https://developers.cloudflare.com/agents/ . Do not trust remembered signatures.
- Change `src/server.ts` for agent behaviour. In `wrangler.jsonc` only change what a step asks you to;
  `account_id` and the `routes` hostname are the team's own and must stay as they are.
- Run `npm run check:team` before `npm run dev` or `npm run deploy`. Never put secrets or real customer
  data in the code: the demo hostname is public, so use synthetic data.
- Do not turn `workers_dev` or `preview_urls` on.

## After every change, give the user a prompt to test it

Finish each change with a short block the user can paste into the agent's chat page, or send with
`curl` to `/api/chat`, to prove the change works. Make it a nice, realistic request, not "test".
Say in one line what they should see if it worked.

Example, after adding a tool:

> Test it. Ask your agent: "Which of our stores in Helsingborg is open latest on Sunday, and what is
> the fastest way to get there from the station?"
> You should see the agent call your new tool and answer from its result, not from memory.

## Workflows: send the user to the dashboard

When you add or change a Workflow (`WorkflowEntrypoint`), do not stop at the code. After it is deployed
and the user has started one run:

1. Ask the user to open the Workflows page of their team account:
   https://dash.cloudflare.com/?to=/:account/workers/workflows , select the Workflow, then the latest
   instance, and tell you what they see.
2. Explain what they are looking at. Cloudflare draws a diagram of the Workflow from the code (a beta
   feature, nothing to configure): one box per step, in order, with the status and result of this run.
3. Explain why that is powerful: they can see how the job is built without reading code, which step
   is running, failed or retried and what each returned, and loops and branches show up too. It is also
   the best way to show the job to a colleague who does not read TypeScript.
4. Offer to start another run so they can watch a `step.sleep` or `step.waitForEvent` step wait live.

## Other platform pieces

After adding R2, D1, AI Search, a schedule or an AI Gateway rule, tell the user which dashboard page
shows it (Storage, D1, AI Search, the Worker's Observability tab, AI Gateway Logs) and what to look
for there. Seeing it is part of the lesson.
