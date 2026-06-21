/**
 * Offline batch curation for data/learning-resource-catalog.json.
 *
 * Default is dry-run. Use `pnpm curate:resources -- --apply` to persist catalog changes and
 * data/curation-audit.json. Only pending explicit resources are processed; verified/flagged/dead_link
 * are terminal.
 */
import { NestFactory } from '@nestjs/core';
import * as fs from 'fs';
import * as path from 'path';
import { AppModule } from '../app.module';
import { LearningResource, coerceLearningResources } from '../modules/roadmap/learning-resource';
import { CurationService } from '../modules/resource-curation/curation.service';
import { CuratedResource } from '../modules/resource-curation/curation-scoring';

export interface CurateResourcesArgs {
  apply: boolean;
  only?: string;
  limit?: number;
}

export interface CurationAuditEntry {
  resource_id: string;
  curated_at: string;
  old_status: LearningResource['validation_status'];
  new_status: LearningResource['validation_status'];
  quality_score: number;
  flags: string[];
  craap: CuratedResource['craap'];
}

export function parseArgs(argv: string[]): CurateResourcesArgs {
  const out: CurateResourcesArgs = { apply: argv.includes('--apply') };
  for (const arg of argv) {
    if (arg.startsWith('--only=')) out.only = arg.slice('--only='.length);
    if (arg.startsWith('--limit=')) {
      const parsed = Number(arg.slice('--limit='.length));
      if (Number.isInteger(parsed) && parsed > 0) out.limit = parsed;
    }
  }
  return out;
}

export function selectPendingResources(
  resources: LearningResource[],
  args: CurateResourcesArgs,
): LearningResource[] {
  let selected = resources.filter((resource) => resource.validation_status === 'pending');
  if (args.only) selected = selected.filter((resource) => resource.id === args.only);
  if (args.limit) selected = selected.slice(0, args.limit);
  return selected;
}

export function applyCuration(
  resource: LearningResource,
  curated: CuratedResource,
  verifiedAt: string,
): LearningResource {
  return {
    ...resource,
    validation_status: curated.validation_status,
    quality_score: curated.quality_score,
    description: curated.description,
    last_verified_at: verifiedAt,
    freshness_score: 100,
  };
}

async function main(): Promise<void> {
  const dotenv = await import('dotenv');
  const dotenvParsed = dotenv.config().parsed ?? {};
  if (dotenvParsed.OPENAI_API_KEY) process.env.OPENAI_API_KEY = dotenvParsed.OPENAI_API_KEY;

  const args = parseArgs(process.argv.slice(2));
  const catalogFile = path.join(process.cwd(), 'data', 'learning-resource-catalog.json');
  const auditFile = path.join(process.cwd(), 'data', 'curation-audit.json');
  const parsed = JSON.parse(fs.readFileSync(catalogFile, 'utf-8')) as {
    resources?: unknown;
    [key: string]: unknown;
  };
  const resources = coerceLearningResources(parsed.resources, (reason) =>
    console.warn(`Skipping invalid resource before curation: ${reason}`),
  );
  const selected = selectPendingResources(resources, args);
  console.log(
    `Curation batch: ${selected.length} pending resource(s) selected (${args.apply ? 'apply' : 'dry-run'}).`,
  );
  if (selected.length === 0) return;

  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try {
    const curation = app.get(CurationService);
    const byId = new Map(resources.map((resource) => [resource.id, resource]));
    const audit: CurationAuditEntry[] = fs.existsSync(auditFile)
      ? (JSON.parse(fs.readFileSync(auditFile, 'utf-8')) as CurationAuditEntry[])
      : [];
    const today = new Date().toISOString().slice(0, 10);

    for (const resource of selected) {
      const curated = await curation.curate(
        {
          title: resource.title,
          provider: resource.provider,
          description: resource.description,
          skills: resource.skills.map((skill) => skill.skill_canonical_name),
          url: resource.url,
        },
        'system',
      );
      const updated = applyCuration(resource, curated, today);
      byId.set(resource.id, updated);
      audit.push({
        resource_id: resource.id,
        curated_at: new Date().toISOString(),
        old_status: resource.validation_status,
        new_status: curated.validation_status,
        quality_score: curated.quality_score,
        flags: curated.flags,
        craap: curated.craap,
      });
      console.log(
        `${resource.id} | ${resource.title} | ${resource.validation_status}->${curated.validation_status} | quality=${curated.quality_score}`,
      );
    }

    if (!args.apply) {
      console.log('Dry-run only. Pass --apply to write catalog + curation audit.');
      return;
    }

    const nextResources = resources.map((resource) => byId.get(resource.id) ?? resource);
    const coerced = coerceLearningResources(nextResources);
    if (coerced.length !== nextResources.length) {
      throw new Error(
        'Refusing to write: curated catalog no longer passes coerceLearningResources',
      );
    }
    fs.writeFileSync(
      catalogFile,
      `${JSON.stringify({ ...parsed, resources: nextResources }, null, 2)}\n`,
    );
    fs.writeFileSync(auditFile, `${JSON.stringify(audit, null, 2)}\n`);
    console.log(`Wrote ${catalogFile} and ${auditFile}.`);
  } finally {
    await app.close();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`curation failed: ${(err as Error).message}`);
    process.exit(1);
  });
}
