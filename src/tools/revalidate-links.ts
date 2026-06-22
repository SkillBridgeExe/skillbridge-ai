/**
 * Revalidate learning-resource URLs and demote hard failures to dead_link.
 *
 * Default mode is dry-run. Use `pnpm revalidate:links -- --apply` to write
 * data/learning-resource-catalog.json. No LLM, no content scraping.
 */
import * as fs from 'fs';
import * as path from 'path';
import { LearningResource } from '../modules/roadmap/learning-resource';

export type LinkProbe = (url: string) => Promise<number | null>;

export interface LinkTransition {
  resource_id: string;
  status: number | null;
}

export interface RevalidateResult {
  resources: LearningResource[];
  transitions: LinkTransition[];
}

export function shouldDemoteLink(status: number | null): boolean {
  return status === null || status === 404 || status === 410;
}

export async function revalidateResources(
  resources: LearningResource[],
  probe: LinkProbe,
): Promise<RevalidateResult> {
  const transitions: LinkTransition[] = [];
  const updated: LearningResource[] = [];

  for (const resource of resources) {
    if (!resource.url || resource.validation_status === 'dead_link') {
      updated.push(resource);
      continue;
    }

    const status = await probe(resource.url);
    if (shouldDemoteLink(status)) {
      transitions.push({ resource_id: resource.id, status });
      updated.push({ ...resource, validation_status: 'dead_link' });
      continue;
    }
    updated.push(resource);
  }

  return { resources: updated, transitions };
}

async function probeUrl(url: string): Promise<number | null> {
  const init = {
    redirect: 'follow' as const,
    signal: AbortSignal.timeout(10_000),
  };
  try {
    const head = await fetch(url, { ...init, method: 'HEAD' });
    if (head.status !== 405) return head.status;
    const get = await fetch(url, { ...init, method: 'GET' });
    return get.status;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const file = path.join(process.cwd(), 'data', 'learning-resource-catalog.json');
  const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as { resources?: LearningResource[] };
  const resources = parsed.resources ?? [];

  const result = await revalidateResources(resources, probeUrl);
  for (const transition of result.transitions) {
    console.log(
      `${transition.resource_id}: demote to dead_link (${transition.status ?? 'timeout/error'})`,
    );
  }
  console.log(`${result.transitions.length} resource link(s) would be demoted.`);

  if (!apply) {
    console.log('Dry-run only. Pass --apply to write data/learning-resource-catalog.json.');
    return;
  }

  fs.writeFileSync(
    file,
    `${JSON.stringify({ ...parsed, resources: result.resources }, null, 2)}\n`,
  );
  console.log(`Updated ${file}.`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`revalidate failed: ${(err as Error).message}`);
    process.exit(1);
  });
}
