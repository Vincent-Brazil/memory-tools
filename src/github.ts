const OWNER = 'Vincent-Brazil';
const REPO = 'memory';
const BRANCH = 'main';

export type CaptureType = 'idea' | 'task' | 'link';

function slugify(text: string): string {
  const base = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  const suffix = Date.now().toString(36).slice(-4);
  return `${base || 'capture'}-${suffix}`;
}

function toBase64Utf8(input: string): string {
  return btoa(unescape(encodeURIComponent(input)));
}

export async function createInboxEntry(pat: string, text: string, type: CaptureType): Promise<void> {
  const iso = new Date().toISOString();
  const dateStr = iso.slice(0, 10);
  const path = `inbox/${dateStr}-${slugify(text)}.md`;

  const content = `---\ntype: ${type}\ncaptured: ${iso}\nsource: mobile-capture\n---\n\n${text}\n`;

  const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(path)}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({
      message: `capture: ${type} — ${text.slice(0, 60)}`,
      content: toBase64Utf8(content),
      branch: BRANCH,
    }),
  });

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new Error('Token rejected — check it still has access to the memory repo.');
    }
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message || `GitHub API error ${res.status}`);
  }
}
