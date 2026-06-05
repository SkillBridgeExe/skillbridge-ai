import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { DatabaseService } from '../../../infrastructure/database/database.service';
import { LlmService } from '../../../infrastructure/llm/llm.service';
import { SkillTextScannerService } from '../../../common/services/skill-text-scanner.service';
import { SkillTaxonomyService } from '../../../common/services/skill-taxonomy.service';
import {
  classifyRole,
  isAdvantageLine,
  normalizeCompanyName,
  normalizeForHash,
  scrubPii,
} from './ingest-normalizers';

export type JobSourceType = 'employer' | 'scraped' | 'imported' | 'feed';

export interface RawJobInput {
  source_type: JobSourceType;
  /** 'manual' | 'itviec' | 'topdev' | employer org slug... part of the dedup identity. */
  source_name: string;
  /** Board-side id; defaults to content_hash so manual re-imports stay idempotent. */
  external_id?: string;
  source_url?: string;
  title: string;
  company_name: string;
  location?: string;
  employment_type?: 'FULL_TIME' | 'PART_TIME' | 'INTERNSHIP' | 'CONTRACT' | 'FREELANCE';
  experience_level?: 'INTERN' | 'FRESHER' | 'JUNIOR' | 'MIDDLE' | 'SENIOR' | 'LEAD';
  salary_min?: number;
  salary_max?: number;
  currency?: string;
  /** ISO timestamps (source-side). */
  posted_at?: string;
  expires_at?: string;
  /**
   * Full JD text — INPUT ONLY. Used for PII-scrub + skill extraction, then DISCARDED.
   * Never persisted (legal posture: docs/jd-pool-research.md — copyright-thin + PDPL-safe).
   */
  jd_text: string;
}

export interface IngestSummary {
  source_name: string;
  fetched: number;
  inserted: number;
  updated: number;
  skipped_no_skills: number;
  embedded: number;
  errors: Array<{ title: string; error: string }>;
}

interface ExtractedSkillRow {
  canonical: string;
  importance: 'REQUIRED' | 'NICE_TO_HAVE';
  matchedText: string;
}

/**
 * JD ingest pipeline (J2) — ONE code path for every source (manual import, employer-posted,
 * Tier-A crawlers):
 *
 *   raw → scrubPii → gazetteer skill scan (deterministic, per-line importance)
 *       → company upsert (normalized dedup key) → role classify → content_hash
 *       → job upsert (idempotent on (source_name, external_id); revives expired on re-see)
 *       → cross-source dedup link (canonical_job_id) → job_skills replace
 *       → skill-set embedding (same tuple as skill_embeddings; skipped when unchanged)
 *       → ingest_runs audit row
 *
 * Jobs with ZERO extractable skills are skipped — they cannot participate in matching and
 * would only pollute trend counts. Embedding failures degrade gracefully (job stays in pool,
 * RRF falls back to the deterministic skill-match signal for it).
 */
@Injectable()
export class JdIngestService {
  private readonly logger = new Logger(JdIngestService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly config: ConfigService,
    private readonly llm: LlmService,
    private readonly scanner: SkillTextScannerService,
    private readonly taxonomy: SkillTaxonomyService,
  ) {}

  async ingestBatch(items: RawJobInput[], runSourceName?: string): Promise<IngestSummary> {
    const sourceName = runSourceName ?? items[0]?.source_name ?? 'unknown';
    const summary: IngestSummary = {
      source_name: sourceName,
      fetched: items.length,
      inserted: 0,
      updated: 0,
      skipped_no_skills: 0,
      embedded: 0,
      errors: [],
    };

    const runRows = await this.db.query<{ id: string }>(
      `INSERT INTO public.ingest_runs (source_name, fetched_count) VALUES ($1, $2) RETURNING id`,
      [sourceName, items.length],
    );
    const runId = runRows[0].id;

    try {
      for (const item of items) {
        try {
          const outcome = await this.ingestOne(item);
          if (outcome === 'inserted') summary.inserted++;
          else if (outcome === 'updated') summary.updated++;
          else if (outcome === 'skipped_no_skills') summary.skipped_no_skills++;
          if (outcome === 'inserted' || outcome === 'updated') summary.embedded++;
        } catch (err) {
          summary.errors.push({ title: item.title, error: (err as Error).message });
          this.logger.warn(`ingest failed for "${item.title}": ${(err as Error).message}`);
        }
      }

      await this.db.query(
        `UPDATE public.ingest_runs
            SET finished_at = now(), status = $2, new_count = $3, updated_count = $4,
                error_text = $5
          WHERE id = $1`,
        [
          runId,
          summary.errors.length === items.length && items.length > 0 ? 'failed' : 'success',
          summary.inserted,
          summary.updated,
          summary.errors.length > 0 ? JSON.stringify(summary.errors).slice(0, 4000) : null,
        ],
      );
    } catch (err) {
      await this.db.query(
        `UPDATE public.ingest_runs SET finished_at = now(), status = 'failed', error_text = $2 WHERE id = $1`,
        [runId, (err as Error).message],
      );
      throw err;
    }
    return summary;
  }

  /** Mark jobs of a source not seen since `olderThan` as expired (ghost-job hygiene, J3 cron). */
  async expireStale(sourceName: string, olderThan: Date): Promise<number> {
    const rows = await this.db.query<{ id: string }>(
      `UPDATE public.jobs SET status = 'expired', updated_at = now()
        WHERE source_name = $1 AND status = 'active' AND last_seen_at < $2
        RETURNING id`,
      [sourceName, olderThan.toISOString()],
    );
    if (rows.length > 0) {
      this.logger.log(`expired ${rows.length} stale jobs for source=${sourceName}`);
    }
    return rows.length;
  }

  private async ingestOne(
    item: RawJobInput,
  ): Promise<'inserted' | 'updated' | 'skipped_no_skills'> {
    this.validate(item);

    // 1. PII scrub BEFORE anything touches the text (PDPL posture).
    const text = scrubPii(item.jd_text);

    // 2. Deterministic skill extraction + per-line importance.
    const skills = this.extractSkills(text);
    if (skills.length === 0) return 'skipped_no_skills';

    // 3. Company upsert on the normalized dedup key.
    const companyId = await this.upsertCompany(item.company_name);

    // 4. Two distinct hashes:
    //   - identityHash (company|title|location) is TAXONOMY-INDEPENDENT → stable fallback
    //     external_id so re-importing a manual JD after taxonomy growth UPSERTs the same row
    //     instead of inserting a duplicate (review finding). Real sources pass external_id.
    //   - contentHash adds the sorted skill set → change-detection + cross-source dup link.
    const canonicals = skills.map((s) => s.canonical).sort();
    const identityParts = [
      normalizeForHash(normalizeCompanyName(item.company_name)),
      normalizeForHash(item.title),
      normalizeForHash(item.location ?? ''),
    ];
    const identityHash = createHash('sha256').update(identityParts.join('|')).digest('hex');
    const contentHash = createHash('sha256')
      .update([...identityParts, canonicals.join(',')].join('|'))
      .digest('hex');
    const externalId = item.external_id ?? identityHash;
    const roleCode = classifyRole(item.title);

    // 5-7. ATOMIC: job upsert + cross-source canonical link + job_skills replacement run in
    // ONE transaction so a new job row never becomes visible WITHOUT its skills (a crash
    // between them used to leave a skill-less job in the pool — review finding). The embedding
    // (step 8) stays OUTSIDE — it is a best-effort network call and must not hold a tx open.
    const { jobId, isNew } = await this.db.transaction(async (client) => {
      const jobRows = await client.query<{ id: string; is_new: boolean }>(
        `INSERT INTO public.jobs
           (company_id, title, role_code, location, employment_type, experience_level,
            salary_min, salary_max, currency, status, source_type, source_name, source_url,
            external_id, content_hash, posted_at, last_seen_at, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9,'VND'),'active',$10,$11,$12,$13,$14,$15,now(),$16)
         ON CONFLICT (source_name, external_id) DO UPDATE SET
           title = EXCLUDED.title,
           role_code = EXCLUDED.role_code,
           location = EXCLUDED.location,
           employment_type = EXCLUDED.employment_type,
           experience_level = EXCLUDED.experience_level,
           salary_min = EXCLUDED.salary_min,
           salary_max = EXCLUDED.salary_max,
           currency = EXCLUDED.currency,
           status = 'active',
           source_url = EXCLUDED.source_url,
           content_hash = EXCLUDED.content_hash,
           expires_at = EXCLUDED.expires_at,
           last_seen_at = now(),
           updated_at = now()
         RETURNING id, (xmax = 0) AS is_new`,
        [
          companyId,
          item.title.slice(0, 255),
          roleCode,
          item.location?.slice(0, 255) ?? null,
          item.employment_type ?? null,
          item.experience_level ?? null,
          this.clampSalary(item.salary_min),
          this.clampSalary(item.salary_max),
          item.currency ?? null,
          item.source_type,
          item.source_name,
          item.source_url ?? null,
          externalId,
          contentHash,
          item.posted_at ?? null,
          item.expires_at ?? null,
        ],
      );
      const id = jobRows.rows[0].id;

      // Cross-source duplicate link (same content, different board) — first writer is canonical.
      await client.query(
        `UPDATE public.jobs SET canonical_job_id = (
           SELECT id FROM public.jobs
            WHERE content_hash = $2 AND id <> $1 AND canonical_job_id IS NULL AND status = 'active'
            ORDER BY created_at ASC LIMIT 1
         ), updated_at = now()
         WHERE id = $1 AND canonical_job_id IS NULL
           AND EXISTS (
             SELECT 1 FROM public.jobs
              WHERE content_hash = $2 AND id <> $1 AND canonical_job_id IS NULL AND status = 'active'
           )`,
        [id, contentHash],
      );

      // Replace job_skills (re-extraction may legitimately change on update).
      await client.query(`DELETE FROM public.job_skills WHERE job_id = $1`, [id]);
      for (const s of skills) {
        const skillIdRows = await client.query<{ id: string }>(
          `SELECT id FROM public.skills WHERE canonical_name = $1`,
          [s.canonical],
        );
        const skillId = skillIdRows.rows[0]?.id;
        if (!skillId) continue; // taxonomy/DB drift — seed not run; skip silently, scanner warned at boot
        await client.query(
          `INSERT INTO public.job_skills (job_id, skill_id, importance, confidence, raw_text)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (job_id, skill_id) DO NOTHING`,
          [id, skillId, s.importance, '0.90', s.matchedText.slice(0, 255)],
        );
      }
      return { jobId: id, isNew: jobRows.rows[0].is_new };
    });

    // 8. Skill-set embedding (outside the tx — network call must not hold a transaction).
    await this.embedJob(jobId, canonicals);

    return isNew ? 'inserted' : 'updated';
  }

  /**
   * Distinct canonicals with importance. SECTION-AWARE (review finding): an advantage cue
   * on a HEADER line ("Nice to have:", "Ưu tiên:") opens an advantage section, so the bullet
   * lines beneath it inherit NICE_TO_HAVE even though they carry no cue themselves. A header
   * is a cue line that names NO skill of its own; a later non-cue line that itself names a
   * skill closes the section. A skill seen REQUIRED anywhere always wins over advantage-only.
   */
  private extractSkills(text: string): ExtractedSkillRow[] {
    const all = this.scanner.scan(text);
    if (all.length === 0) return [];

    const advantageCanonicals = new Set<string>();
    const requiredCanonicals = new Set<string>();
    let inAdvantageSection = false;
    for (const line of text.split(/\r?\n/)) {
      if (line.trim().length === 0) continue;
      const lineSkills = this.scanner.scan(line);
      const cue = isAdvantageLine(line);

      if (lineSkills.length === 0) {
        // Pure cue header opens a section; a non-cue header (a new "Requirements:" etc.) closes it.
        if (cue) inAdvantageSection = true;
        else if (/[:：]\s*$/.test(line.trim())) inAdvantageSection = false;
        continue;
      }

      const isAdvantage = cue || inAdvantageSection;
      const bucket = isAdvantage ? advantageCanonicals : requiredCanonicals;
      for (const s of lineSkills) bucket.add(s.canonical_name);
    }

    return all.map((s) => ({
      canonical: s.canonical_name,
      // REQUIRED anywhere beats advantage-only (a skill in both contexts is required).
      importance:
        advantageCanonicals.has(s.canonical_name) && !requiredCanonicals.has(s.canonical_name)
          ? 'NICE_TO_HAVE'
          : 'REQUIRED',
      matchedText: s.matched_text,
    }));
  }

  /**
   * Clamp salary into numeric(12,2) range (max 9,999,999,999.99). Untrusted JSON-LD figures
   * can be absurd (e.g. annual-in-cents); an out-of-range value would abort the whole batch
   * with a Postgres numeric-overflow. Out-of-range or non-finite → null (unknown salary).
   */
  private clampSalary(v: number | undefined): number | null {
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return null;
    return v <= 9_999_999_999.99 ? v : null;
  }

  private async upsertCompany(rawName: string): Promise<string> {
    const normalized = normalizeCompanyName(rawName);
    const key = normalized.length > 0 ? normalized : rawName.toLowerCase().trim();
    const rows = await this.db.query<{ id: string }>(
      `INSERT INTO public.companies (name, name_normalized)
       VALUES ($1, $2)
       ON CONFLICT (name_normalized) DO UPDATE SET updated_at = now()
       RETURNING id`,
      [rawName.slice(0, 255).trim(), key.slice(0, 255)],
    );
    return rows[0].id;
  }

  /**
   * One dense vector per job = its canonical skill-set as display-name text, embedded in
   * the SAME tuple as skill_embeddings (geometry shared with the CV side for J4 RRF).
   * Unchanged source_text → skip (no re-spend). Failure → warn + keep the job.
   */
  private async embedJob(jobId: string, sortedCanonicals: string[]): Promise<void> {
    const model = this.config.get<string>('llm.openai.modelEmbedding') ?? 'text-embedding-3-large';
    const dimensions = this.config.get<number>('vector.dimension') ?? 1024;
    const version = this.config.get<string>('vector.embeddingVersion') ?? 'v1';

    const displayNames = sortedCanonicals
      .map((c) => this.taxonomy.getByCanonical(c)?.display_name ?? c)
      .sort((a, b) => a.localeCompare(b, 'en'));
    const sourceText = displayNames.join(', ');

    try {
      const existing = await this.db.query<{ source_text: string }>(
        `SELECT source_text FROM public.job_embeddings
          WHERE job_id = $1 AND model = $2 AND dimensions = $3 AND embedding_version = $4`,
        [jobId, model, dimensions, version],
      );
      if (existing[0]?.source_text === sourceText) return; // unchanged — free

      const { embedding } = await this.llm.embed(sourceText, {
        provider: 'openai',
        dimensions,
      });
      const vectorLiteral = `[${embedding.join(',')}]`;
      await this.db.query(
        `INSERT INTO public.job_embeddings (job_id, embedding, source_text, model, dimensions, embedding_version)
         VALUES ($1, $2::extensions.vector, $3, $4, $5, $6)
         ON CONFLICT (job_id, model, dimensions, embedding_version)
         DO UPDATE SET embedding = EXCLUDED.embedding, source_text = EXCLUDED.source_text`,
        [jobId, vectorLiteral, sourceText, model, dimensions, version],
      );
    } catch (err) {
      // Best-effort: the job stays in the pool; J4 RRF degrades to skill-match-only for it.
      this.logger.warn(`job embedding failed (job=${jobId}): ${(err as Error).message}`);
    }
  }

  private validate(item: RawJobInput): void {
    if (!item.title?.trim()) throw new Error('title is required');
    if (!item.company_name?.trim()) throw new Error('company_name is required');
    if (!item.jd_text?.trim()) throw new Error('jd_text is required');
    if (!['employer', 'scraped', 'imported', 'feed'].includes(item.source_type)) {
      throw new Error(`invalid source_type: ${item.source_type}`);
    }
    if (!item.source_name?.trim()) throw new Error('source_name is required');
  }
}
