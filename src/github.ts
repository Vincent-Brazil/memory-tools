let OWNER = '';
let REPO = '';
const BRANCH = 'main';

/** Points every subsequent call at the given repo. Must be called once at
 * boot (after setup) before any other function in this module is used. */
export function configureRepo(owner: string, repo: string): void {
  OWNER = owner;
  REPO = repo;
}

export function githubEditUrl(path: string): string {
  return `https://github.com/${OWNER}/${REPO}/edit/${BRANCH}/${path}`;
}

export function githubInboxWorkflowUrl(): string {
  return `https://github.com/${OWNER}/${REPO}/actions/workflows/inbox-review.yml`;
}

const INBOX_PROCESS_WORKFLOW = 'inbox-review.yml';

export interface InboxProcessRun {
  id: number;
  status: 'queued' | 'in_progress' | 'completed' | 'waiting' | 'requested' | 'pending';
  conclusion: string | null;
  htmlUrl: string;
  createdAt: string;
}

function authHeaders(pat: string) {
  return {
    Authorization: `Bearer ${pat}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function githubError(res: Response, fallback: string): Promise<Error> {
  const body = (await res.json().catch(() => ({}))) as { message?: string };
  if (res.status === 401 || res.status === 403) {
    return new Error('GitHub rejected this action. Check that the token has Actions read/write access as well as Contents access.');
  }
  return new Error(body.message || fallback);
}

function parseProcessRun(value: {
  id: number;
  status: InboxProcessRun['status'];
  conclusion: string | null;
  html_url: string;
  created_at: string;
}): InboxProcessRun {
  return {
    id: value.id,
    status: value.status,
    conclusion: value.conclusion,
    htmlUrl: value.html_url,
    createdAt: value.created_at,
  };
}

export async function fetchLatestInboxProcessRun(pat: string): Promise<InboxProcessRun | null> {
  const res = await fetch(
    `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${INBOX_PROCESS_WORKFLOW}/runs?event=workflow_dispatch&branch=${BRANCH}&per_page=1&_=${Date.now()}`,
    { headers: authHeaders(pat), cache: 'no-store' }
  );
  if (!res.ok) throw await githubError(res, `Could not check processing runs (${res.status})`);
  const data = (await res.json()) as {
    workflow_runs: Parameters<typeof parseProcessRun>[0][];
  };
  return data.workflow_runs[0] ? parseProcessRun(data.workflow_runs[0]) : null;
}

export async function fetchInboxProcessRun(pat: string, runId: number): Promise<InboxProcessRun> {
  const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/actions/runs/${runId}?_=${Date.now()}`, {
    headers: authHeaders(pat),
    cache: 'no-store',
  });
  if (!res.ok) throw await githubError(res, `Could not check processing run (${res.status})`);
  return parseProcessRun((await res.json()) as Parameters<typeof parseProcessRun>[0]);
}

export async function startInboxProcessing(
  pat: string,
  options: { item?: string; limit?: number }
): Promise<InboxProcessRun> {
  const startedAfter = Date.now() - 2_000;
  const res = await fetch(
    `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${INBOX_PROCESS_WORKFLOW}/dispatches`,
    {
      method: 'POST',
      headers: { ...authHeaders(pat), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ref: BRANCH,
        inputs: {
          limit: String(options.limit ?? 5),
          item: options.item ?? '',
        },
      }),
    }
  );
  if (!res.ok) throw await githubError(res, `Could not start processing (${res.status})`);

  // Workflow dispatch returns 204 rather than a run ID. Find the new run,
  // allowing a short delay while GitHub creates it.
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, attempt ? 1_500 : 700));
    const run = await fetchLatestInboxProcessRun(pat);
    if (run && new Date(run.createdAt).getTime() >= startedAfter) return run;
  }
  throw new Error('Processing was requested, but GitHub has not exposed the run yet. Open Actions to check it.');
}

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
  const bytes = new TextEncoder().encode(input);
  let binary = '';
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary);
}

function fromBase64Utf8(base64: string): string {
  const binary = atob(base64.replace(/\n/g, ''));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
}

export async function createInboxEntry(pat: string, text: string): Promise<string> {
  const iso = new Date().toISOString();
  const dateStr = iso.slice(0, 10);
  const path = `inbox/${dateStr}-${slugify(text)}.md`;

  const content = `---\ncaptured: ${iso}\nsource: mobile-capture\nstatus: captured\n---\n\n${text}\n`;

  const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(path)}`, {
    method: 'PUT',
    headers: { ...authHeaders(pat), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: `capture: ${text.slice(0, 60)}`,
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

  return path;
}

export async function validateToken(pat: string): Promise<void> {
  const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/index.md?ref=${BRANCH}`, {
    headers: authHeaders(pat),
  });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new Error('Token rejected — check it has Contents access on the memory repo.');
    }
    if (res.status === 404) {
      throw new Error("Token can't see the memory repo — check repository access.");
    }
    throw new Error(`GitHub API error ${res.status}`);
  }
}

export async function fetchLastCommitDate(pat: string, path: string): Promise<string | null> {
  const res = await fetch(
    `https://api.github.com/repos/${OWNER}/${REPO}/commits?path=${encodeURIComponent(path)}&sha=${BRANCH}&per_page=1`,
    { headers: authHeaders(pat) }
  );
  if (!res.ok) return null;
  const data = (await res.json()) as { commit?: { committer?: { date?: string } } }[];
  return data[0]?.commit?.committer?.date ?? null;
}

export interface MarkdownFile {
  path: string;
}

export async function fetchMarkdownTree(pat: string): Promise<MarkdownFile[]> {
  const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/git/trees/${BRANCH}?recursive=1&_=${Date.now()}`, {
    headers: authHeaders(pat),
    cache: 'no-store',
  });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new Error('Token rejected — check it still has access to the memory repo.');
    }
    throw new Error(`Could not list files (${res.status})`);
  }
  const data = (await res.json()) as { tree: { path: string; type: string }[] };
  return data.tree.filter((entry) => entry.type === 'blob' && entry.path.endsWith('.md')).map((entry) => ({ path: entry.path }));
}

export async function fetchFileContent(pat: string, path: string): Promise<string> {
  const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(path)}?ref=${BRANCH}&_=${Date.now()}`, {
    headers: authHeaders(pat),
    cache: 'no-store',
  });
  if (!res.ok) {
    if (res.status === 404) throw new Error(`Not found in memory: ${path}`);
    if (res.status === 401 || res.status === 403) {
      throw new Error('Token rejected — check it still has access to the memory repo.');
    }
    throw new Error(`GitHub API error ${res.status}`);
  }
  const data = (await res.json()) as { content: string };
  return fromBase64Utf8(data.content);
}

export async function updateFileContent(pat: string, path: string, content: string, message: string): Promise<void> {
  const getRes = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(path)}?ref=${BRANCH}`, {
    headers: authHeaders(pat),
  });
  if (!getRes.ok) throw new Error(`Could not look up file before updating it (${getRes.status})`);
  const { sha } = (await getRes.json()) as { sha: string };

  const putRes = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(path)}`, {
    method: 'PUT',
    headers: { ...authHeaders(pat), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      content: toBase64Utf8(content),
      sha,
      branch: BRANCH,
    }),
  });
  if (!putRes.ok) {
    if (putRes.status === 401 || putRes.status === 403) {
      throw new Error('Token rejected — check it still has write access to the memory repo.');
    }
    const body = (await putRes.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message || `GitHub API error ${putRes.status}`);
  }
}
