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
        default:
            return { type: 'none', label: '', description: '' };
    }
}
