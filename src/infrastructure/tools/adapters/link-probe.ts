export interface LinkProbeResult {
  alive: boolean;
  status: number | null;
  final_url: string;
  content_type: string | null;
}

const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;

function isDeadStatus(status: number): boolean {
  return status === 404 || status === 410;
}

/**
 * HEAD (GET fallback on 405), manual redirect-following capped at 3 hops. Shared by the
 * `resource.validate` tool (mid-chat, one URL) AND `src/tools/revalidate-links.ts` (offline batch
 * over the whole catalog) — one probe implementation, two callers (Task 4).
 */
export async function probeUrl(url: string): Promise<LinkProbeResult> {
  try {
    const startedAt = Date.now();
    const signal = () => AbortSignal.timeout(Math.max(1, TIMEOUT_MS - (Date.now() - startedAt)));
    let current = url;
    let res: { status: number; url: string; headers: { get(name: string): string | null } } | null =
      null;
    let unresolvedRedirect = false;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      res = await fetch(current, {
        method: 'HEAD',
        redirect: 'manual',
        signal: signal(),
      });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        current = new URL(res.headers.get('location')!, current).toString();
        unresolvedRedirect = hop === MAX_REDIRECTS;
        continue;
      }
      unresolvedRedirect = false;
      break;
    }
    if (unresolvedRedirect && res) {
      return {
        alive: false,
        status: res.status,
        final_url: current,
        content_type: res.headers.get('content-type'),
      };
    }
    if (res!.status === 405) {
      res = await fetch(current, {
        method: 'GET',
        redirect: 'follow',
        signal: signal(),
      });
    }
    const status = res!.status;
    return {
      alive: !isDeadStatus(status),
      status,
      final_url: res!.url || current,
      content_type: res!.headers.get('content-type'),
    };
  } catch {
    return { alive: false, status: null, final_url: url, content_type: null };
  }
}
