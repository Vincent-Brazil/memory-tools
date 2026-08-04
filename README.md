# memory-tools

A static PWA for capturing, reviewing, and browsing
[`Vincent-Brazil/memory`](https://github.com/Vincent-Brazil/memory). It has no backend and
calls GitHub's Contents API directly from the browser.

## Live app

Open [memory-tools on GitHub Pages](https://vincent-brazil.github.io/memory-tools/) in a
browser. On first use, enter the target `owner/repo` and a fine-grained GitHub token with
Contents read/write access to that repository. Both stay in that browser's `localStorage`.

On mobile, use the browser menu to add it to the home screen. On desktop Chrome or Edge,
use the install icon in the address bar.

## Workflow

### Capture

Capture is deliberately untyped. Drop in a rough thought, something to do, or a link. The
app preserves exactly what was entered and writes:

```yaml
---
captured: <ISO timestamp>
source: mobile-capture
status: captured
---
```

Capture-time guesses do not decide whether something is an idea, task, or bookmark.

### Inbox review

A bounded DeepSeek job in the Memory repository shapes raw captures into structured
proposals. The review screen shows one proposal at a time with:

- inferred kind: idea, task, bookmark, or unclear
- a shaped description and grounding
- viability, approach, definition of done, or next step where relevant
- one concrete proposed outcome
- a receipt explaining exactly what approval records

Available actions are **Approve**, **Change**, **Skip for now**, and **Discard**. Change
stores human feedback, removes the generated proposal, and queues the original capture for
shaping again. Discard removes the capture from the active queue but retains it for recovery.
Approval records a concrete outcome; it does not pretend a later Memory,
Cockpit, or agent execution has already happened.

The primary button therefore says **Approve for filing/handoff**, not that filing has
already happened. Approved captures remain visible in an expanded **Approved, awaiting
follow-through** queue, with their full shaped proposal intact, until an executor writes the
destination and marks the inbox item complete. They are not folded into Reviewed as if done.

Pending captures link directly to the hosted Shape inbox workflow in GitHub Actions. The
screen reports how many proposals are ready, how many raw captures are waiting for DeepSeek,
and how many are blocked, so an empty ready queue is not confused with an empty inbox.
DeepSeek shapes at most five captures in the daily run; reviewing one proposal does not
automatically shape the remaining backlog.

### Viewer and Graph

The Viewer renders the Memory Markdown tree with search, recent pages, backlinks, edit links,
and inbox completion controls. Graph visualises explicit links, inferred raw-capture
relationships, and data-quality issues. Graph suggestions remain context, never decisions.

## Local development

```text
npm install
npm run typecheck
npm run build
npm run dev
```

The GitHub Pages workflow type-checks and builds before deployment.
