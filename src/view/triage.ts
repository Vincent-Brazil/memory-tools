import { marked } from 'marked';
import {
    fetchFileContent,
    fetchMarkdownTree,
    githubInboxWorkflowUrl,
    startInboxProcessing,
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
    status: string;
    original: string;
    proposal: ReviewProposal | null;
    attempts: number;
    error: string;
    feedback: string;
    approvedOutcome: string;
    approvedTarget: string;
}

interface QueueLoadResult {
    items: ReviewItem[];
    missingPaths: string[];
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

export function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
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

export async function buildQueue(
    pat: string,
    paths: string[],
    fetchContent: (pat: string, path: string) => Promise<string> = fetchFileContent
): Promise<QueueLoadResult> {
    const inboxPaths = paths.filter((path) => path.startsWith('inbox/') && path !== 'inbox/README.md');
    const items: ReviewItem[] = [];
    const missingPaths: string[] = [];
    let index = 0;
    const worker = async () => {
        while (index < inboxPaths.length) {
            const path = inboxPaths[index++];
            try {
                const raw = await fetchContent(pat, path);
                const { meta, body } = parseFrontmatter(raw);
                items.push({
                    path,
                    captured: meta.captured ?? '',
                    status: meta.status || 'captured',
                    original: originalText(body),
                    proposal: parseProposal(body),
                    attempts: Number(meta.processing_attempts ?? meta.shaping_attempts ?? meta.preparation_attempts) || 0,
                    error: meta.processing_error ?? meta.shaping_error ?? meta.preparation_error ?? '',
                    feedback: meta.review_feedback ?? '',
                    approvedOutcome: meta.approved_outcome ?? '',
                    approvedTarget: meta.approved_target ?? '',
                });
            } catch (error) {
                if (error instanceof Error && error.message.startsWith('Not found in memory:')) {
                    missingPaths.push(path);
                    continue;
                }
                items.push({
                    path,
                    captured: '',
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
    return {
        items: items.sort((left, right) => left.captured.localeCompare(right.captured)),
        missingPaths,
    };
}

function renderOriginal(item: ReviewItem): string {
    const original = item.original || '*(empty capture)*';
    return `<section class="review-source"><h3>Your capture</h3><p>This is the original text. Processing never replaces it.</p><blockquote class="review-original">${marked.parse(escapeHtml(original), { async: false })}</blockquote></section>`;
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
            <textarea class="review-feedback" rows="3" placeholder="Add the context needed to process this again.">${escapeHtml(item.feedback)}</textarea>
    </label>
    <div class="review-change-actions">
            <button type="button" class="review-btn review-btn-primary review-action" data-action="submit-change" data-path="${escapeHtml(item.path)}">Process again</button>
      <button type="button" class="review-btn review-action" data-action="cancel-change" data-path="${escapeHtml(item.path)}">Cancel</button>
    </div>
  </div>`;
}

function approvalActionLabel(outcome: ProposalOutcome): string {
    switch (outcome) {
        case 'save_idea': return 'Approve for filing as idea';
        case 'add_project_task': return 'Approve for project backlog';
        case 'send_to_cockpit': return 'Approve for Cockpit handoff';
        case 'create_research_task': return 'Approve research task';
        case 'attach_source': return 'Approve source attachment';
        case 'save_bookmark': return 'Approve for filing as bookmark';
        case 'ask_clarification': return 'Approve clarification request';
        case 'discard': return 'Discard';
    }
}

function approvalPendingEffect(outcome: ProposalOutcome, target: string): string {
    const destination = target || (outcome === 'save_idea' ? 'ideas/' : 'its eventual destination');
    switch (outcome) {
        case 'save_idea':
            return `This records your decision to file the processed idea in ${destination}. It does not create or move the idea entry yet; the full proposal stays in Inbox under “Approved, awaiting follow-through”.`;
        case 'add_project_task':
            return `This records your decision to add the processed task to ${destination}. It does not update that backlog yet; the full proposal stays in Inbox under “Approved, awaiting follow-through”.`;
        case 'send_to_cockpit':
            return 'This records your decision to hand the task to Cockpit. It does not create a Cockpit card yet; the full proposal stays in Inbox under “Approved, awaiting follow-through”.';
        case 'create_research_task':
            return 'This records your decision to create research work. It does not create that task yet; the full proposal stays in Inbox under “Approved, awaiting follow-through”.';
        case 'attach_source':
            return `This records your decision to attach the source to ${destination}. It does not update that destination yet; the full proposal stays in Inbox under “Approved, awaiting follow-through”.`;
        case 'save_bookmark':
            return 'This records your decision to retain the processed bookmark. It does not file it elsewhere yet; the full proposal stays in Inbox under “Approved, awaiting follow-through”.';
        case 'ask_clarification':
            return 'This records that the clarification needs answering. It stays visible in Inbox under “Approved, awaiting follow-through” until that happens.';
        case 'discard':
            return 'Discard removes this from the active queue but retains the original capture under “Skipped or discarded” so it can be restored.';
    }
}

function renderReady(item: ReviewItem, remaining: number): string {
    const proposal = item.proposal!;
    const primaryAction = proposal.outcome === 'discard' ? 'discard' : 'approve';
    const primaryLabel = approvalActionLabel(proposal.outcome);
    return `<article class="review-card" data-path="${escapeHtml(item.path)}">
    <header class="review-card-header">
      <span class="review-kind review-kind-${proposal.kind}">${escapeHtml(proposal.kind)}</span>
      <span class="review-progress">1 of ${remaining} to review</span>
    </header>
    <h2>${escapeHtml(proposal.title)}</h2>
    ${renderOriginal(item)}
        <section class="review-proposal-summary"><h3>Processed proposal</h3><p class="review-summary">${escapeHtml(proposal.summary)}</p></section>
        <details class="review-analysis">
            <summary>Supporting analysis</summary>
            <p class="review-analysis-help">These details preserve the reasoning for you and for later AI work. They support the decision; they are not separate actions.</p>
            <div class="review-detail-grid">
                ${renderDetail('Potential value', proposal.why_it_matters)}
                ${renderDetail('Facts and assumptions', proposal.grounding)}
                ${renderDetail('Feasibility and constraints', proposal.viability)}
                ${renderDetail('Potential approach', proposal.approach)}
                ${renderDetail('Definition of done', proposal.definition_of_done)}
                ${renderDetail('Smallest next step', proposal.next_step)}
                ${renderDetail('Biggest unknown', proposal.biggest_unknown)}
                ${renderDetail('Clarifying question', proposal.clarifying_question)}
                ${proposal.executor !== 'none' ? renderDetail('Suggested executor', proposal.executor) : ''}
            </div>
            ${renderEvidence(proposal)}
        </details>
    <div class="review-consequence">
        <span>What approval does now</span>
        <strong>${escapeHtml(primaryLabel)}</strong>
      ${proposal.target ? `<code>${escapeHtml(proposal.target)}</code>` : ''}
        <p>${escapeHtml(approvalPendingEffect(proposal.outcome, proposal.target))}</p>
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
        ? escapeHtml(item.error || 'The proposal is missing or invalid and needs to be processed again.')
        : item.feedback
            ? `Waiting to be processed again with your note: ${escapeHtml(item.feedback)}`
            : 'Waiting to be processed.';
    return `<li class="review-compact-card" data-path="${escapeHtml(item.path)}">
    <div><strong>${escapeHtml(item.original || item.path)}</strong><p>${message}</p></div>
    <div class="review-compact-actions">
      <button type="button" class="review-btn review-btn-primary review-process-action" data-process-item="${escapeHtml(item.path)}">${attention ? 'Retry processing' : 'Process this item'}</button>
      <button type="button" class="review-btn review-action" data-action="change" data-path="${escapeHtml(item.path)}">Add context</button>
      <button type="button" class="review-btn review-btn-danger review-action" data-action="discard" data-path="${escapeHtml(item.path)}">Discard</button>
    </div>
    ${renderChangeForm(item)}
  </li>`;
}

function renderCompletedItem(item: ReviewItem): string {
    const receipt = item.status === 'skipped'
        ? 'Skipped for now.'
        : 'Discarded. The original capture is retained and can be restored.';
    return `<li class="review-completed-card" data-path="${escapeHtml(item.path)}">
    <div><strong>${escapeHtml(item.original || item.path)}</strong><p>${escapeHtml(receipt)}</p></div>
    <button type="button" class="review-btn review-action" data-action="restore" data-path="${escapeHtml(item.path)}">${item.status === 'discarded' ? 'Restore capture' : 'Return to review'}</button>
  </li>`;
}

function renderApprovedItem(item: ReviewItem): string {
    const outcome = item.approvedOutcome as ProposalOutcome;
    const title = item.proposal?.title || item.original || item.path;
    const label = outcome ? approvalActionLabel(outcome).replace(/^Approve /, 'Approved ') : 'Approved';
    return `<li class="review-awaiting-card" data-path="${escapeHtml(item.path)}">
    <div><strong>${escapeHtml(title)}</strong><p>${escapeHtml(label)}. Nothing has been filed or handed off yet; the full proposal remains in Inbox until an executor completes it.</p></div>
    <div class="review-awaiting-actions">
      <a class="review-source-link" href="#/${encodeURIComponent(item.path)}">Open full proposal</a>
      <button type="button" class="review-btn review-action" data-action="restore" data-path="${escapeHtml(item.path)}">Undo approval</button>
    </div>
    </li>`;
}

export function renderReview(items: ReviewItem[]): string {
    const ready = items.filter((item) => item.status === 'ready' && item.proposal);
    const attention = items.filter((item) => item.status === 'needs_attention' || (item.status === 'ready' && !item.proposal));
    const pending = items.filter((item) => item.status === 'captured');
    const approved = items.filter((item) => item.status === 'approved');
    const parked = items.filter((item) => item.status === 'skipped' || item.status === 'discarded');
    const workflowUrl = githubInboxWorkflowUrl();
    const sections: string[] = [
                `<header class="review-page-header"><h1>Inbox review</h1><p>Processing turns each raw capture into a proposal. You decide what should happen next; approval records that decision but does not carry it out.</p>
                        <nav class="review-status-links" aria-label="Inbox status"><span>${ready.length} to review</span>${pending.length ? `<button type="button" data-review-target="to-process-items">${pending.length} to process</button>` : '<span>0 to process</span>'}${attention.length ? `<button type="button" data-review-target="attention-items">${attention.length} blocked</button>` : '<span>0 blocked</span>'}${parked.length ? `<button type="button" data-review-target="parked-items">${parked.length} parked</button>` : '<span>0 parked</span>'}${approved.length ? `<button type="button" data-review-target="approved-items">${approved.length} approved</button>` : '<span>0 approved</span>'}</nav>
                        <details class="review-guide"><summary>How Inbox review works</summary>
                            <ol><li><strong>Capture:</strong> your original text is preserved.</li><li><strong>Process:</strong> AI infers a stable kind and proposes one outcome.</li><li><strong>Review:</strong> approve, request a change, park, or discard the proposal.</li><li><strong>Follow-through:</strong> approved work stays unfinished until an executor performs the proposed write or handoff.</li></ol>
                              <p><strong>Kind:</strong> an idea is an opportunity, a task is executable work, a bookmark is a source worth retaining, and unclear means one answer is still needed.</p>
                              <p><strong>On a proposal:</strong> the title and summary are the processed interpretation; supporting analysis records value, evidence, assumptions, constraints, unknowns, and a possible route; the approval box states exactly what your decision records.</p>
                            <a href="#/tools%2Finbox-review%2FREADME.md">Read the full processing and field contract</a>
                        </details></header>`,
    ];
    if (ready.length) {
        sections.push(`<h3 class="review-section-title">Ready for you</h3>${renderReady(ready[0], ready.length)}`);
    } else {
        sections.push(`<div class="review-empty"><strong>No processed proposal is waiting for a decision.</strong><span>${pending.length ? `${pending.length} raw capture${pending.length === 1 ? ' is' : 's are'} still waiting to be processed.` : 'There is no active review backlog.'}</span></div>`);
    }
    if (attention.length) {
        sections.push(`<section id="attention-items"><h3 class="review-section-title">Needs attention (${attention.length})</h3><ul class="review-compact-list">${attention
            .map((item) => renderPendingItem(item, true))
            .join('')}</ul></section>`);
    }
    if (pending.length) {
        sections.push(`<details class="review-group" id="to-process-items" open><summary>To process (${pending.length})</summary>
            <div class="review-processing-controls"><button type="button" class="review-btn review-btn-primary review-process-action" data-process-limit="5">Process next five</button><span class="review-run-status" aria-live="polite"></span></div>
            <p class="review-workflow-help">Processing turns raw captures into proposals for review. It currently uses a low-cost hosted model, but the contract is provider-independent. <a href="${workflowUrl}" target="_blank" rel="noopener noreferrer">Open processing runs on GitHub ↗</a></p>
      <ul class="review-compact-list">${pending.map((item) => renderPendingItem(item)).join('')}</ul></details>`);
    }
    if (parked.length) {
        sections.push(`<details class="review-group" id="parked-items"><summary>Skipped or discarded (${parked.length})</summary><p class="review-workflow-help">These captures are retained, not deleted. Open this section and restore one to return it to the active flow.</p><ul class="review-compact-list">${parked
            .map(renderCompletedItem)
            .join('')}</ul></details>`);
    }
    if (approved.length) {
        sections.push(`<details class="review-awaiting-group" id="approved-items"><summary>Approved, awaiting follow-through (${approved.length})</summary>
            <p class="review-awaiting-help">These are not filed, handed off, or finished. Approval is recorded and the full proposal stays here until an executor completes the destination write.</p>
            <ul class="review-compact-list">${approved.map(renderApprovedItem).join('')}</ul></details>`);
    }
    return sections.join('');
}

function focusReviewSection(id: string, smooth = true): void {
    const target = document.getElementById(id);
    if (!target) return;
    if (target instanceof HTMLDetailsElement) target.open = true;
    target.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
}

function wireReviewNavigation(): void {
    document.querySelectorAll<HTMLButtonElement>('[data-review-target]').forEach((button) => {
        button.onclick = () => focusReviewSection(button.dataset.reviewTarget!);
    });
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

function toggleChange(path: string, visible: boolean): void {
    const panel = document.querySelector<HTMLElement>(`.review-change[data-change-for="${CSS.escape(path)}"]`);
    if (!panel) return;
    panel.hidden = !visible;
    if (visible) panel.querySelector<HTMLTextAreaElement>('textarea')?.focus();
}

function setBusy(path: string, busy: boolean): void {
    document.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`)?.classList.toggle('busy', busy);
}

async function pollProcessingState(
    pat: string,
    expectedItems: { path: string; attempts: number }[],
    refresh: () => Promise<void>
): Promise<void> {
    const status = document.querySelector<HTMLElement>('.review-run-status');
    if (status) status.textContent = 'Processing…';
    for (let attempt = 0; attempt < 80; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        const completed = await Promise.all(expectedItems.map(async (item) => {
            const raw = await fetchFileContent(pat, item.path);
            const meta = parseFrontmatter(raw).meta;
            const itemStatus = meta.status || 'captured';
            const attempts = Number(meta.processing_attempts ?? meta.shaping_attempts ?? meta.preparation_attempts) || 0;
            return itemStatus !== 'captured' || attempts > item.attempts;
        }));
        if (completed.every(Boolean)) {
            if (status) status.textContent = 'Processing complete. Refreshing…';
            await refresh();
            return;
        }
    }
    throw new Error('Processing is still running. Refresh Inbox review later to see the result.');
}

function wireProcessingActions(pat: string, items: ReviewItem[], refresh: () => Promise<void>): void {
    document.querySelectorAll<HTMLButtonElement>('.review-process-action').forEach((button) => {
        button.onclick = () => void (async () => {
            const original = button.textContent || 'Process';
            button.disabled = true;
            button.textContent = 'Starting…';
            try {
                const itemPath = button.dataset.processItem;
                const item = itemPath?.split('/').pop();
                const limit = Number(button.dataset.processLimit) || 5;
                const candidates = itemPath
                    ? items.filter((candidate) => candidate.path === itemPath)
                    : items.filter((candidate) => candidate.status === 'captured').slice(0, limit);
                if (candidates[0]?.status === 'needs_attention') {
                    const candidate = candidates[0];
                    await writeReviewState(
                        pat,
                        candidate,
                        {
                            status: 'captured',
                            processing_attempts: null,
                            processing_last_attempt: null,
                            processing_error: null,
                            shaping_attempts: null,
                            shaping_last_attempt: null,
                            shaping_error: null,
                            preparation_attempts: null,
                            preparation_last_attempt: null,
                            preparation_error: null,
                        },
                        `inbox review: ${candidate.path} -> retry processing`,
                        true
                    );
                    candidate.status = 'captured';
                    candidate.proposal = null;
                    candidate.attempts = 0;
                    candidate.error = '';
                }
                const expectedItems = candidates.map((candidate) => ({ path: candidate.path, attempts: candidate.attempts }));
                await startInboxProcessing(pat, item ? { item } : { limit });
                button.textContent = 'Processing…';
                await pollProcessingState(pat, expectedItems, refresh);
            } catch (error) {
                alert(error instanceof Error ? error.message : 'Could not start processing.');
                button.disabled = false;
                button.textContent = original;
            }
        })();
    });
}

function wireReviewActions(pat: string, items: ReviewItem[], render: () => void, refresh: () => Promise<void>): void {
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
                    if (!confirm(`Discard this capture?\n\n${item.original || item.path}\n\nIt will leave the active queue but can be restored later.`)) {
                        setBusy(path, false);
                        return;
                    }
                    await writeReviewState(
                        pat,
                        item,
                        {
                            status: 'discarded',
                            discarded_at: new Date().toISOString(),
                            approved_at: null,
                            approved_kind: null,
                            approved_outcome: null,
                            approved_target: null,
                            skipped_at: null,
                        },
                        `inbox review: ${path} -> discarded`
                    );
                    item.status = 'discarded';
                    item.approvedOutcome = '';
                    item.approvedTarget = '';
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
                    item.status = 'approved';
                    item.approvedOutcome = item.proposal.outcome;
                    item.approvedTarget = item.proposal.target;
                } else if (action === 'skip') {
                    await writeReviewState(
                        pat,
                        item,
                        { status: 'skipped', skipped_at: new Date().toISOString(), approved_at: null, approved_outcome: null, approved_target: null },
                        `inbox review: ${path} -> skipped`
                    );
                    item.status = 'skipped';
                } else if (action === 'restore') {
                    const nextStatus = item.proposal ? 'ready' : 'captured';
                    await writeReviewState(
                        pat,
                        item,
                        {
                            status: nextStatus,
                            approved_at: null,
                            approved_kind: null,
                            approved_outcome: null,
                            approved_target: null,
                            skipped_at: null,
                            discarded_at: null,
                        },
                        `inbox review: ${path} -> ${nextStatus}`
                    );
                    item.status = nextStatus;
                    item.approvedOutcome = '';
                    item.approvedTarget = '';
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
                            processed_at: null,
                            processed_by: null,
                            processing_attempts: null,
                            processing_last_attempt: null,
                            processing_error: null,
                            shaped_at: null,
                            shaped_by: null,
                            shaping_attempts: null,
                            shaping_last_attempt: null,
                            shaping_error: null,
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
                        `inbox review: ${path} -> process again`,
                        true
                    );
                    item.status = 'captured';
                    item.proposal = null;
                    item.feedback = feedback;
                    item.attempts = 0;
                    item.error = '';
                }
                render();
                window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
            } catch (error) {
                alert(error instanceof Error ? error.message : 'Could not update this capture.');
                setBusy(path, false);
            }
        })();
    };
}

export async function showInboxReview(pat: string, paths: string[], initialSection = '', initialItemPath = ''): Promise<void> {
    const breadcrumb = document.querySelector<HTMLParagraphElement>('#breadcrumb')!;
    const updated = document.querySelector<HTMLElement>('#last-updated')!;
    const editLink = document.querySelector<HTMLAnchorElement>('#edit-link')!;
    const inboxAction = document.querySelector<HTMLButtonElement>('#inbox-action-btn')!;
    const content = document.querySelector<HTMLElement>('#content')!;

    breadcrumb.textContent = 'inbox review';
    updated.textContent = '';
    editLink.hidden = true;
    inboxAction.hidden = true;
    document.querySelector<HTMLElement>('.graph-link')?.classList.remove('active');
    document.querySelector<HTMLElement>('.triage-link')?.classList.add('active');
    document.querySelectorAll<HTMLElement>('#tree .tree-item.active').forEach((entry) => entry.classList.remove('active'));
    content.classList.remove('doc', 'graph-view', 'triage-view');
    content.classList.add('inbox-review-view');
    content.innerHTML = '<p class="hint">Loading your review queue…</p>';

    try {
        let items: ReviewItem[] = [];
        let sectionToFocus = initialSection;
        let itemToFocus = initialItemPath;
        const refresh = async () => {
            const tree = await fetchMarkdownTree(pat);
            const freshPaths = tree.map((file) => file.path);
            const result = await buildQueue(pat, freshPaths);
            items = result.items;
            paths.splice(0, paths.length, ...freshPaths);
            render();
        };
        const render = () => {
            const focusedItem = itemToFocus ? items.find((item) => item.path === itemToFocus) : undefined;
            const renderedItems = focusedItem?.status === 'ready' && focusedItem.proposal
                ? [focusedItem, ...items.filter((item) => item.path !== itemToFocus)]
                : items;
            content.innerHTML = renderReview(renderedItems);
            wireReviewActions(pat, items, render, refresh);
            wireProcessingActions(pat, items, refresh);
            wireReviewNavigation();
            if (itemToFocus) {
                const target = document.querySelector<HTMLElement>(`[data-path="${CSS.escape(itemToFocus)}"]`);
                if (target) {
                    target.closest('details')?.setAttribute('open', '');
                    target.scrollIntoView({ behavior: 'auto', block: 'start' });
                }
                itemToFocus = '';
            } else if (sectionToFocus) {
                focusReviewSection(sectionToFocus, false);
                sectionToFocus = '';
            } else {
                document.querySelector('.content-column')?.scrollTo(0, 0);
            }
        };
        await refresh();
    } catch (error) {
        content.innerHTML = `<div class="review-empty"><strong>Could not build the review queue.</strong><span>${escapeHtml(
            error instanceof Error ? error.message : 'Unknown error'
        )}</span><button type="button" class="review-btn review-btn-primary" id="review-retry">Retry</button></div>`;
        document.querySelector<HTMLButtonElement>('#review-retry')!.onclick = () => void showInboxReview(pat, paths);
    }
}
