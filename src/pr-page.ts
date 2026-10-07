/** A GitHub-style page for the agent's mock pull requests (GET /pr/:number). Never shows client secrets. */
import { REVIEWERS } from "./waf";

export interface PullRequest {
  number: number;
  ray_id: string;
  title: string;
  body: string;
  branch: string;
  files: string;
  status: string;
  created_at: string;
  review_at: string | null;
  merged_at: string | null;
  merged_by: string | null;
}

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c
  );

const when = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;

function renderBody(body: string) {
  return body
    .split("\n")
    .map((line) =>
      line.startsWith("## ") ? `<h3>${esc(line.slice(3))}</h3>` : line.trim() ? `<p>${esc(line)}</p>` : ""
    )
    .join("");
}

function renderDiff(diff: string) {
  return diff
    .split("\n")
    .map((line) => {
      const kind = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx";
      return `<div class="ln ${kind}">${esc(line) || "&nbsp;"}</div>`;
    })
    .join("");
}

const avatar = (user: string) =>
  `<img src="https://github.com/${user}.png?size=48" alt="" width="20" height="20">`;

export function renderPullRequest(pr: PullRequest) {
  const files = JSON.parse(pr.files) as { path: string; diff: string }[];
  const merged = pr.status === "merged";
  const count = (prefix: string) =>
    files.reduce((n, f) => n + f.diff.split("\n").filter((l) => l.startsWith(prefix)).length, 0);
  const people = (note: string) =>
    REVIEWERS.map((u) => `<li>${avatar(u)}<span>${u}</span>${note ? `<em>${note}</em>` : ""}</li>`).join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>PR #${pr.number}: ${esc(pr.title)}</title>
<style>
:root { --bg:#fff; --fg:#1f2328; --muted:#59636e; --line:#d1d9e0; --panel:#f6f8fa; --green:#1a7f37; --purple:#8250df; --red:#cf222e; --addbg:#dafbe1; --delbg:#ffebe9; }
@media (prefers-color-scheme: dark) { :root { --bg:#0d1117; --fg:#e6edf3; --muted:#9198a1; --line:#3d444d; --panel:#151b23; --green:#3fb950; --purple:#ab7df8; --red:#f85149; --addbg:#12261e; --delbg:#25171c; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
main { max-width: 1012px; margin: 0 auto; padding: 24px 16px 48px; }
.repo { color: var(--muted); margin-bottom: 8px; }
h1 { font-size: 26px; font-weight: 400; margin: 0 0 8px; overflow-wrap: anywhere; }
h1 span { color: var(--muted); }
.state { display: inline-block; padding: 4px 12px; border-radius: 2em; color: #fff; font-weight: 500; background: var(--green); margin-right: 8px; }
.state.merged { background: var(--purple); }
.meta { color: var(--muted); padding-bottom: 16px; border-bottom: 1px solid var(--line); }
code { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--panel); padding: 2px 6px; border-radius: 6px; }
.layout { display: grid; grid-template-columns: minmax(0, 1fr) 220px; gap: 24px; margin-top: 16px; }
@media (max-width: 760px) { .layout { grid-template-columns: minmax(0, 1fr); } }
.card { border: 1px solid var(--line); border-radius: 6px; margin-bottom: 16px; overflow: hidden; }
.card > header { background: var(--panel); border-bottom: 1px solid var(--line); padding: 8px 16px; color: var(--muted); }
.card .content { padding: 4px 16px 8px; }
h3 { font-size: 15px; margin: 16px 0 4px; }
p { margin: 0 0 8px; overflow-wrap: anywhere; }
.side h4 { font-size: 12px; color: var(--muted); margin: 0 0 8px; }
.side ul { list-style: none; padding: 0; margin: 0 0 16px; }
.side li { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
.side img { border-radius: 50%; }
.side em { color: var(--muted); font-size: 12px; margin-left: auto; font-style: normal; }
.diff { font: 12px/20px ui-monospace, SFMono-Regular, Menlo, monospace; overflow-x: auto; }
.ln { padding: 0 16px; white-space: pre; }
.ln.add { background: var(--addbg); }
.ln.del { background: var(--delbg); }
.add-n { color: var(--green); } .del-n { color: var(--red); }
</style></head><body><main>
<div class="repo">HamzaShaikh00 / ikea-waf-terraform · opened by the #waf-help triage agent</div>
<h1>${esc(pr.title)} <span>#${pr.number}</span></h1>
<div class="meta"><span class="state${merged ? " merged" : ""}">${merged ? "Merged" : "Open"}</span>
waf-triage-agent wants to merge 1 commit into <code>main</code> from <code>${esc(pr.branch)}</code> · opened ${when(pr.created_at)}${
    merged && pr.merged_at ? ` · merged ${when(pr.merged_at)} (${esc(pr.merged_by ?? "")})` : ""
  }</div>
<div class="layout"><div>
<div class="card"><header>waf-triage-agent commented</header><div class="content">${renderBody(pr.body)}</div></div>
<div class="card"><header>Files changed · <span class="add-n">+${count("+")}</span> <span class="del-n">−${count("-")}</span></header></div>
${files.map((f) => `<div class="card"><header><code>${esc(f.path)}</code></header><div class="diff">${renderDiff(f.diff)}</div></div>`).join("")}
</div><aside class="side">
<h4>Reviewers</h4><ul>${people(merged ? "approved" : "requested")}</ul>
<h4>Assignees</h4><ul>${people("")}</ul>
<h4>Labels</h4><ul><li><code>waf-exception</code></li><li><code>false-positive</code></li></ul>
<h4>Review again by</h4><ul><li>${esc((pr.review_at ?? "").slice(0, 10))}</li></ul>
</aside></div></main></body></html>`;
}
