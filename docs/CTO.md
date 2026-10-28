# Your CTO

A seat beside Donna that reads every project's receipts and writes one weekly page. Back to the [README](../README.md).

The report card and Verified done give every project its receipts. The CTO reads all of them at
once and tells you, on one page, which projects are on track, at risk or stalled, why, and what to
decide. It is a seat beside Donna on the org map: a normal Claude Code session on your plan, with
one job.

![The CTO's weekly review: each project's status computed by Clawdling, every line linked to its receipt, and the decisions it asked](img/cto-review.png)

- **Add it.** On the org map, click **Add a CTO**. It appears beside Donna, with its own folder
  (`cto/`) and its own CLAUDE.md, which you can edit in its Context tab like any agent's.
- **Run a review.** Open the CTO and press **Run this week's review**. Clawdling shows the cost first
  (a range, a list-price equivalent, not a bill), then starts one Claude Code session. The CTO reads
  the report for your whole org (`clawdling report --all`), writes this week's page
  (`cto/reviews/2026-W44.md`, say), and asks you up to three decisions as cards, in the chat and in
  Needs you.
- **Decisions become instructions.** When you answer, the CTO drafts a short message to that agent,
  for its live session or a new one. Claude Code asks you before each one goes, and the cockpit shows
  the exact message beside the buttons. Say no and nothing is sent; the review notes it as declined.
- **Ask it anything.** "Should I keep going on the newsletter project?" Press **Ask the CTO
  something** and it answers from the same receipts, or says "no receipts for that".
- **Every Monday, if you want.** In Settings, "Run the CTO review every Monday at 08:00" stays off
  until you turn it on. It shows what one review costs first, runs at most once a week, and skips a
  week that would go over the weekly cap you set ($2 to start). Another switch, also off, adds the
  CTO's one-line headline and "3 decisions waiting" to your Monday report.

**What "receipts" means here.** Every fact the CTO may use has an id, like `R-session-1a2b3c4d`: a
session that finished work, a "done" claim and its label, a ship check, a check-up, a week's usage,
something waiting on you, the agent's own next steps. The CTO must cite one in brackets on every
line. On the review page each citation is a link: tap it and you are on that session or that tab.
A line with no citation is marked **uncited** (unless it says "no receipts", which is the CTO
following its rules), an id that does not exist says **no such receipt**,
and the top of the page sums it up: "14 findings, all cited", or "2 uncited".

**The labels are not the model's opinion.** On track, At risk, Stalled and Quiet are worked out by
Clawdling from the receipts, with fixed rules. At risk means something concrete: a "done" claim a
check contradicted, a failed ship check, a check-up score that fell 20 points, usage up by half
while finished work was not, or something waiting on you for two days. Stalled means a project that
finished nothing in a week and whose next steps have not moved. You can tune those numbers in
Settings, not the rules. The CTO may disagree, in one line with a receipt, and the page shows that
as "Overridden by the CTO, here is why: …" next to Clawdling's own label.

**What it never does.** It never edits a project or another agent's files: the only thing it can
write without asking is its own reviews. It cannot browse the web, and no MCP servers start in it.
It never runs a ship check or a check-up itself (it suggests one as a decision). It never sends a
message to another agent without your yes. It never runs on its own unless you turned on the weekly
review, and it cannot change its own instructions or settings. How the seat is locked down:
[SECURITY.md](SECURITY.md#the-cto-seat-17).
