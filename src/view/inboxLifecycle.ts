export type InboxPageAction = 'process' | 'review' | 'approved' | 'blocked' | 'none';

export interface InboxPageActionConfig {
    type: InboxPageAction;
    label: string;
    description: string;
}

export function inboxReviewHash(path = ''): string {
    return path ? `#/triage?item=${encodeURIComponent(path)}` : '#/triage';
}

export function inboxReviewItemFromRoute(route: string): string | null {
    const prefix = 'triage?item=';
    if (!route.startsWith(prefix)) return null;
    const path = route.slice(prefix.length).trim();
    return path.startsWith('inbox/') && path !== 'inbox/README.md' ? path : null;
}

export function inboxPageActionFor(path: string, status = 'captured'): InboxPageActionConfig {
    if (!path.startsWith('inbox/') || path === 'inbox/README.md') {
        return { type: 'none', label: '', description: '' };
    }
    switch (status) {
        case 'captured':
            return {
                type: 'process',
                label: 'Process this item',
                description: 'Start a bounded processing run for this raw capture.',
            };
        case 'ready':
            return {
                type: 'review',
                label: 'Open in Inbox review',
                description: 'The processed proposal is ready for a decision.',
            };
        case 'approved':
            return {
                type: 'approved',
                label: 'Approved, awaiting follow-through',
                description: 'Approval is recorded, but the destination write has not happened yet.',
            };
        case 'skipped':
            return {
                type: 'review',
                label: 'Open in Inbox review',
                description: 'This item was skipped and can be returned to review.',
            };
        case 'discarded':
            return {
                type: 'review',
                label: 'Open in Inbox review',
                description: 'This item was discarded and can be restored or permanently deleted from Inbox review.',
            };
        case 'needs_attention':
            return {
                type: 'review',
                label: 'Open in Inbox review',
                description: 'Processing needs attention; retry it from Inbox review.',
            };
        // Set by the inbox processor when a capture looks like work content. It is REFUSED, not
        // failed: the daily run happens in GitHub Actions, which has no local Claude CLI, and
        // work content must never reach a hosted provider. It needs the work laptop.
        //
        // Its own status rather than needs_attention, so it cannot hide among items that errored
        // — and it needs a case here, because an unrecognised status falls through to
        // `type: 'none'` and renders with no action at all, which is exactly the silent stall the
        // separate status exists to prevent.
        // 'review', not 'blocked', deliberately. A 'blocked' action dispatches another
        // processing run, which would refuse this item again for the same reason — and the
        // waiter would sit for four minutes because a refusal sets neither 'ready' nor an
        // attempt count. 'review' opens the item so the reason can be read instead.
        case 'needs_work_laptop':
            return {
                type: 'review',
                label: 'Needs the work laptop',
                description:
                    'This capture looks like work content, so it was not sent to a hosted model. '
                    + 'Process it on the work laptop, where the local Claude CLI is available.',
            };
        default:
            return { type: 'none', label: '', description: '' };
    }
}
