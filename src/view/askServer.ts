// Asking the question. The browser holds no model key: it sends the grounding it
// assembled to this app's own /api/ask, which holds the OpenRouter key and calls
// the model through toolbelt-llm-router.
//
// The GitHub PAT is the auth. It is already in this browser, entered per device,
// and the server checks it can read the private memory repo before spending
// anything — so there is no second credential to paste, and nothing spendable
// sits on a phone.

// Resolved from the vite base rather than a bare relative path: the viewer lives
// at /view/, so `fetch('api/ask')` would ask for /view/api/ask. BASE_URL is '/'
// on Railway and '/memory-tools/' on Pages, where there is no server and a 404 is
// the correct answer.
const API = (path: string) => `${import.meta.env.BASE_URL}${path}`;

export interface AskResult {
  answer: string;
  provider: string | null;
}

export class AssistantUnavailable extends Error {}

/** True when this build is being served by something that can answer — the app
 * still works entirely without it, since Capture and Viewer never call the
 * origin. Used to explain the panel being disabled rather than just failing. */
export async function assistantAvailable(): Promise<boolean> {
  try {
    const res = await fetch(API('healthz'), { cache: 'no-store' });
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: boolean; providers?: string[] };
    return Boolean(body.ok && body.providers?.length);
  } catch {
    return false;
  }
}

export async function ask(
  options: { prompt: string; pat: string; signal?: AbortSignal }
): Promise<AskResult> {
  let res: Response;
  try {
    res = await fetch(API('api/ask'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-github-token': options.pat },
      body: JSON.stringify({ prompt: options.prompt }),
      signal: options.signal,
    });
  } catch (err) {
    if (options.signal?.aborted) throw err;
    throw new AssistantUnavailable(
      'Could not reach the assistant. This half of the app needs the server — it is not available on the static host.'
    );
  }

  if (res.status === 404) {
    throw new AssistantUnavailable(
      'No assistant on this host. Open the app from its Railway URL, which serves /api/ask.'
    );
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || `The assistant failed (${res.status}).`);
  }

  const body = (await res.json()) as { answer?: string; provider?: string | null };
  if (!body.answer?.trim()) throw new Error('The model returned an empty answer. Try asking again.');
  return { answer: body.answer, provider: body.provider ?? null };
}
