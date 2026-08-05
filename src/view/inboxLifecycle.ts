export type InboxPageAction = 'process' | 'review' | 'approved' | 'parked' | 'blocked' | 'none';

export interface InboxPageActionConfig {
    type: InboxPageAction;
    label: string;
    description: string;
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
        case 'discarded':
            return {
                type: 'parked',
                label: 'Open in Inbox review',
                description: 'This item is parked and can be restored from Inbox review.',
            };
        case 'needs_attention':
            return {
                type: 'blocked',
                label: 'Retry processing',
                description: 'Processing failed repeatedly; retry it from this item.',
            };
        default:
            return { type: 'none', label: '', description: '' };
    }
}
