import { marked } from 'marked';
import {
  deleteInboxFile,
  fetchFileContent,
  githubInboxWorkflowUrl,
  updateFileContent,
} from '../github';

const FETCH_CONCURRENCY = 6;
const PROPOSAL_MARKER = '## Proposal (auto)';

type ProposalKind = 'idea' | 'task' | 'bookmark' | 'unclear';
type ProposalOutcome =
  | 'save_idea'
  | 'add_project_task'
  | 'send_to_cockpit'
  | 'create_research_task'
  | 'attach_source'
  | 'save_bookmark'
  | 'ask_clarification'
  | 'discard';

interface ProposalRelation {
  path: string;
  reason: string;
}

interface ReviewProposal {
  schema_version: 2;
  kind: ProposalKind;
  title: string;
  summary: string;
  why_it_matters: string;
  grounding: string;
  viability: string;
  approach: string;
  definition_of_done: string;
  next_step: string;
  biggest_unknown: string;
  clarifying_question: string;
  executor: 'human' | 'agent' | 'either' | 'none';
  outcome: ProposalOutcome;
  outcome_label: string;
  target: string;
  approval_effect: string;
  evidence: string[];
  related: ProposalRelation[];
}

interface ReviewItem {
  path: string;
  captured: string;
  captureHint: string;
  status: string;
  original: string;
  proposal: ReviewProposal | null;
  attempts: number;
  error: string;
  feedback: string;
  approvedOutcome: string;
  approvedTarget: string;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return entities[character];
  });
}

function decodeFlatScalar(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"')) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return trimmed;
    }
  }
  return trimmed.replace(/^'|'$/g, '');
}

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { meta: {}, body: raw };
  const meta: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (field) meta[field[1]] = decodeFlatScalar(field[2]);
  }
  return { meta, body: raw.slice(match[0].length) };
}

function yamlScalar(value: string): string {
  return /^[a-zA-Z0-9_.:/-]+$/.test(value) ? value : JSON.stringify(value);
}

function updateFrontmatter(raw: string, updates: Record<string, string | null>): string {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const lines = match ? match[1].split(/\r?\n/) : [];
  for (const [key, value] of Object.entries(updates)) {
    const index = lines.findIndex((line) => new RegExp(`^${key}:`).test(line));
    if (value === null) {
      if (index !== -1) lines.splice(index, 1);
      continue;
    }
    const next = `${key}: ${yamlScalar(value)}`;
    if (index === -1) lines.push(next);
    else lines[index] = next;
  }
  const body = match ? raw.slice(match[0].length) : raw;
  return `---\n${lines.join('\n')}\n---\n\n${body.replace(/^\s+/, '')}`;
}

function originalText(body: string): string {
  const proposal = body.indexOf(PROPOSAL_MARKER);
  const legacy = body.indexOf('## Enrichment (auto,');
  const markers = [proposal, legacy].filter((index) => index >= 0);
  return (markers.length ? body.slice(0, Math.min(...markers)) : body).trim();
}

function stripProposal(raw: string): string {
  return raw.replace(/\n## Proposal \(auto\)[\s\S]*$/, '\n').trimEnd() + '\n';
}

function parseProposal(body: string): ReviewProposal | null {
  const match = body.match(/<!--\s*inbox-proposal:v2\s*\r?\n([\s\S]*?)\r?\n-->/);
  if (!match) return null;
  try {
    const value = JSON.parse(match[1]) as ReviewProposal;
    if (value.schema_version !== 2 || !value.title || !value.outcome_label || !value.approval_effect) return null;
    return value;
  } catch {
    return null;
  }
}

async function buildQueue(pat: string, paths: string[]): Promise<ReviewItem[]> {
  const inboxPaths = paths.filter((path) => path.startsWith('inbox/') && path !== 'inbox/README.md');
  const items: ReviewItem[] = [];
  let index = 0;
  const worker = async () => {
    while (index < inboxPaths.length) {
      const path = inboxPaths[index++];
      try {
        const raw = await fetchFileContent(pat, path);
        const { meta, body } = parseFrontmatter(raw);
        items.push({
          path,
          captured: meta.captured ?? '',
          captureHint: meta.capture_hint ?? meta.type ?? '',
          status: meta.status || 'captured',
          original: originalText(body),
          proposal: parseProposal(body),
          attempts: Number(meta.preparation_attempts) || 0,
          error: meta.preparation_error ?? '',
          feedback: meta.review_feedback ?? '',
          approvedOutcome: meta.approved_outcome ?? '',
          approvedTarget: meta.approved_target ?? '',
        });
      } catch (error) {
        items.push({
          path,
          captured: '',
          captureHint: '',
          status: 'needs_attention',
          original: '',
          proposal: null,
          attempts: 0,
          error: error instanceof Error ? error.message : 'Could not load this capture.',
          feedback: '',
          approvedOutcome: '',
          approvedTarget: '',
        });
      }
    }
  };
  await Promise.all(Array.from({ length: FETCH_CONCURRENCY }, worker));
  return items.sort((left, right) => left.captured.localeCompare(right.captured));
}

function renderOriginal(item: ReviewItem): string {
  const original = item.original || '*(empty capture)*';
  return `<blockquote class="review-original">${marked.parse(escapeHtml(original), { async: false })}</blockquote>`;
}

function renderDetail(label: string, value: string): string {
  if (!value) return '';
  return `<section class="review-detail"><h4>${escapeHtml(label)}</h4><p>${escapeHtml(value)}</p></section>`;
}

function renderEvidence(proposal: ReviewProposal): string {
  if (!proposal.evidence.length && !proposal.related.length) return '';
  const evidence = proposal.evidence.length
    ? `<h4>Evidence</h4><ul>${proposal.evidence.map((entry) => `<li>${escapeHtml(entry)}</li>`).join('')}</ul>`
    : '';
  const related = proposal.related.length
    ? `<h4>Related</h4><ul>${proposal.related
        .map((entry) => `<li><strong>${escapeHtml(entry.path)}</strong>: ${escapeHtml(entry.reason)}</li>`)
        .join('')}</ul>`
    : '';
  return `<details class="review-evidence"><summary>Evidence and related items</summary>${evidence}${related}</details>`;
}

function renderChangeForm(item: ReviewItem): string {
  return `<div class="review-change" data-change-for="${escapeHtml(item.path)}" hidden>
    <label>What is wrong or missing?
      <textarea class="review-feedback" rows="3" placeholder="Add the context DeepSeek needs to prepare this again.">${escapeHtml(item.feedback)}</textarea>
    </label>
    <div class="review-change-actions">
      <button type="button" class="review-btn review-btn-primary review-action" data-action="submit-change" data-path="${escapeHtml(item.path)}">Prepare again</button>
      <button type="button" class="review-btn review-action" data-action="cancel-change" data-path="${escapeHtml(item.path)}">Cancel</button>
    </div>
  </div>`;
}

function renderReady(item: ReviewItem, remaining: number): string {
  const proposal = item.proposal!;
  const primaryAction = proposal.outcome === 'discard' ? 'discard' : 'approve';
  const primaryLabel = proposal.outcome === 'discard' ? 'Discard' : `Approve: ${proposal.outcome_label}`;
  return `<article class="review-card" data-path="${escapeHtml(item.path)}">
    <header class="review-card-header">
      <span class="review-kind review-kind-${proposal.kind}">${escapeHtml(proposal.kind)}</span>
      <span class="review-progress">${remaining} ready</span>
    </header>
    <h2>${escapeHtml(proposal.title)}</h2>
    ${renderOriginal(item)}
    <p class="review-summary">${escapeHtml(proposal.summary)}</p>
    <div class="review-detail-grid">
      ${renderDetail('Why it may matter', proposal.why_it_matters)}
      ${renderDetail('Grounding', proposal.grounding)}
      ${renderDetail('Viability', proposal.viability)}
      ${renderDetail('Potential approach', proposal.approach)}
      ${renderDetail('Definition of done', proposal.definition_of_done)}
      ${renderDetail('Smallest next step', proposal.next_step)}
      ${renderDetail('Biggest unknown', proposal.biggest_unknown)}
      ${renderDetail('Clarifying question', proposal.clarifying_question)}
      ${proposal.executor !== 'none' ? renderDetail('Suggested executor', proposal.executor) : ''}
    </div>
    ${renderEvidence(proposal)}
    <div class="review-consequence">
      <span>Proposed outcome</span>
      <strong>${escapeHtml(proposal.outcome_label)}</strong>
      ${proposal.target ? `<code>${escapeHtml(proposal.target)}</code>` : ''}
      <p>${escapeHtml(proposal.approval_effect)}</p>
    </div>
    <div class="review-actions">
      <button type="button" class="review-btn review-btn-primary review-action" data-action="${primaryAction}" data-path="${escapeHtml(item.path)}">${escapeHtml(primaryLabel)}</button>
      <button type="button" class="review-btn review-action" data-action="change" data-path="${escapeHtml(item.path)}">Change</button>
      <button type="button" class="review-btn review-action" data-action="skip" data-path="${escapeHtml(item.path)}">Skip for now</button>
      ${proposal.outcome === 'discard' ? '' : `<button type="button" class="review-btn review-btn-danger review-action" data-action="discard" data-path="${escapeHtml(item.path)}">Discard</button>`}
    </div>
    ${renderChangeForm(item)}
    <a class="review-source-link" href="#/${encodeURIComponent(item.path)}">Open source card</a>
  </article>`;
}

function renderPendingItem(item: ReviewItem, attention = false): string {
  const message = attention
    ? escapeHtml(item.error || 'The proposal is missing or invalid and needs another preparation attempt.')
    : item.feedback
      ? `Waiting to be prepared again with your note: ${escapeHtml(item.feedback)}`
      : 'Waiting for preparation.';
  return `<li class="review-compact-card" data-path="${escapeHtml(item.path)}">
    <div><strong>${escapeHtml(item.original || item.path)}</strong><p>${message}</p></div>
    <div class="review-compact-actions">
      ${attention ? `<button type="button" class="review-btn review-action" data-action="retry" data-path="${escapeHtml(item.path)}">Retry</button>` : ''}
      <button type="button" class="review-btn review-action" data-action="change" data-path="${escapeHtml(item.path)}">Add context</button>
      <button type="button" class="review-btn review-btn-danger review-action" data-action="discard" data-path="${escapeHtml(item.path)}">Discard</button>
    </div>
    ${renderChangeForm(item)}
  </li>`;
}

function renderCompletedItem(item: ReviewItem): string {
  const skipped = item.status === 'skipped';
  const receipt = skipped
    ? 'Skipped for now.'
    : `Approved: ${item.approvedOutcome}${item.approvedTarget ? ` → ${item.approvedTarget}` : ''}. Awaiting execution.`;
  return `<li class="review-completed-card" data-path="${escapeHtml(item.path)}">
    <div><strong>${escapeHtml(item.original || item.path)}</strong><p>${escapeHtml(receipt)}</p></div>
    <button type="button" class="review-btn review-action" data-action="restore" data-path="${escapeHtml(item.path)}">Return to review</button>
  </li>`;
}

function renderReview(items: ReviewItem[]): string {
  const ready = items.filter((item) => item.status === 'ready' && item.proposal);
  const attention = items.filter((item) => item.status === 'needs_attention' || (item.status === 'ready' && !item.proposal));
  const pending = items.filter((item) => item.status === 'captured');
  const completed = items.filter((item) => item.status === 'approved' || item.status === 'skipped');
  const workflowUrl = githubInboxWorkflowUrl();
  const sections: string[] = [
    `<header class="review-page-header"><h1>Inbox review</h1><p>Review one shaped proposal at a time. Nothing reaches Memory or Cockpit until you approve it.</p></header>`,
  ];
  if (ready.length) {
    sections.push(`<h3 class="review-section-title">Ready for you</h3>${renderReady(ready[0], ready.length)}`);
  } else {
    sections.push(`<div class="review-empty"><strong>No proposal is waiting for a decision.</strong><span>Raw captures stay safe until the preparation task runs.</span></div>`);
  }
  if (attention.length) {
    sections.push(`<h3 class="review-section-title">Needs attention (${attention.length})</h3><ul class="review-compact-list">${attention
      .map((item) => renderPendingItem(item, true))
      .join('')}</ul>`);
  }
  if (pending.length) {
    sections.push(`<details class="review-group" open><summary>Waiting to be prepared (${pending.length})</summary>
      <p class="review-workflow-help">DeepSeek prepares up to five each morning. <a href="${workflowUrl}" target="_blank" rel="noopener noreferrer">Run Prepare inbox now on GitHub ↗</a></p>
      <ul class="review-compact-list">${pending.map((item) => renderPendingItem(item)).join('')}</ul></details>`);
  }
  if (completed.length) {
    sections.push(`<details class="review-group"><summary>Approved or skipped (${completed.length})</summary><ul class="review-compact-list">${completed
      .map(renderCompletedItem)
      .join('')}</ul></details>`);
  }
  return sections.join('');
}

async function writeReviewState(
  pat: string,
  item: ReviewItem,
  updates: Record<string, string | null>,
  message: string,
  removeProposal = false
): Promise<void> {
  const raw = await fetchFileContent(pat, item.path);
  const updated = updateFrontmatter(removeProposal ? stripProposal(raw) : raw, updates);
  await updateFileContent(pat, item.path, updated, message);
}

async function discardItem(pat: string, item: ReviewItem): Promise<void> {
  if (!confirm(`Discard this capture?\n\n${item.original || item.path}\n\nThis deletes it from the inbox.`)) return;
  await deleteInboxFile(pat, item.path);
}

function toggleChange(path: string, visible: boolean): void {
  const panel = document.querySelector<HTMLElement>(`.review-change[data-change-for="${CSS.escape(path)}"]`);
  if (!panel) return;
  panel.hidden = !visible;
  if (visible) panel.querySelector<HTMLTextAreaElement>('textarea')?.focus();
}

function setBusy(path: string, busy: boolean): void {
  document.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`)?.classList.toggle('busy', busy);
}

function wireReviewActions(pat: string, items: ReviewItem[], refresh: () => Promise<void>): void {
  const content = document.querySelector<HTMLElement>('#content')!;
  const byPath = new Map(items.map((item) => [item.path, item]));
  content.onclick = (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('.review-action');
    if (!button) return;
    const path = button.dataset.path!;
    const action = button.dataset.action!;
    const item = byPath.get(path);
    if (!item) return;
    if (action === 'change' || action === 'cancel-change') {
      toggleChange(path, action === 'change');
      return;
    }

    void (async () => {
      setBusy(path, true);
      try {
        if (action === 'discard') {
          await discardItem(pat, item);
        } else if (action === 'approve' && item.proposal) {
          const now = new Date().toISOString();
          await writeReviewState(
            pat,
            item,
            {
              status: 'approved',
              approved_at: now,
              approved_kind: item.proposal.kind,
              approved_outcome: item.proposal.outcome,
              approved_target: item.proposal.target || null,
              skipped_at: null,
            },
            `inbox review: ${path} -> approved (${item.proposal.outcome})`
          );
        } else if (action === 'skip') {
          await writeReviewState(
            pat,
            item,
            { status: 'skipped', skipped_at: new Date().toISOString(), approved_at: null, approved_outcome: null, approved_target: null },
            `inbox review: ${path} -> skipped`
          );
        } else if (action === 'restore') {
          await writeReviewState(
            pat,
            item,
            {
              status: 'ready',
              approved_at: null,
              approved_kind: null,
              approved_outcome: null,
              approved_target: null,
              skipped_at: null,
            },
            `inbox review: ${path} -> ready`
          );
        } else if (action === 'retry') {
          await writeReviewState(
            pat,
            item,
            { status: 'captured', preparation_attempts: null, preparation_last_attempt: null, preparation_error: null },
            `inbox review: ${path} -> retry preparation`,
            true
          );
        } else if (action === 'submit-change') {
          const panel = document.querySelector<HTMLElement>(`.review-change[data-change-for="${CSS.escape(path)}"]`)!;
          const feedback = panel.querySelector<HTMLTextAreaElement>('.review-feedback')!.value.trim();
          if (!feedback) {
            alert('Say what is wrong or missing so the next proposal can improve.');
            return;
          }
          await writeReviewState(
            pat,
            item,
            {
              status: 'captured',
              review_feedback: feedback,
              prepared_at: null,
              prepared_by: null,
              preparation_attempts: null,
              preparation_last_attempt: null,
              preparation_error: null,
              approved_at: null,
              approved_kind: null,
              approved_outcome: null,
              approved_target: null,
              skipped_at: null,
            },
            `inbox review: ${path} -> prepare again`,
            true
          );
        }
        await refresh();
      } catch (error) {
        alert(error instanceof Error ? error.message : 'Could not update this capture.');
        setBusy(path, false);
      }
    })();
  };
}

export async function showInboxReview(pat: string, paths: string[]): Promise<void> {
  const breadcrumb = document.querySelector<HTMLParagraphElement>('#breadcrumb')!;
  const updated = document.querySelector<HTMLElement>('#last-updated')!;
  const editLink = document.querySelector<HTMLAnchorElement>('#edit-link')!;
  const complete = document.querySelector<HTMLButtonElement>('#complete-btn')!;
  const content = document.querySelector<HTMLElement>('#content')!;

  breadcrumb.textContent = 'inbox review';
  updated.textContent = '';
  editLink.hidden = true;
  complete.hidden = true;
  document.querySelector<HTMLElement>('.graph-link')?.classList.remove('active');
  document.querySelector<HTMLElement>('.triage-link')?.classList.add('active');
  document.querySelectorAll<HTMLElement>('#tree .tree-item.active').forEach((entry) => entry.classList.remove('active'));
  content.classList.remove('doc', 'graph-view', 'triage-view');
  content.classList.add('inbox-review-view');
  content.innerHTML = '<p class="hint">Preparing your review queue…</p>';

  try {
    const items = await buildQueue(pat, paths);
    content.innerHTML = renderReview(items);
    const refresh = () => showInboxReview(pat, paths);
    wireReviewActions(pat, items, refresh);
    document.querySelector('.content-column')?.scrollTo(0, 0);
  } catch (error) {
    content.innerHTML = `<div class="review-empty"><strong>Could not build the review queue.</strong><span>${escapeHtml(
      error instanceof Error ? error.message : 'Unknown error'
    )}</span><button type="button" class="review-btn review-btn-primary" id="review-retry">Retry</button></div>`;
    document.querySelector<HTMLButtonElement>('#review-retry')!.onclick = () => void showInboxReview(pat, paths);
  }
}
