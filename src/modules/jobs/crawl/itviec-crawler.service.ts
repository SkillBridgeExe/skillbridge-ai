import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseService } from '../../../infrastructure/database/database.service';
import { JdIngestService, RawJobInput } from '../ingest/jd-ingest.service';
import { extractJobSlugs, ItviecPosting, parseDetailPage } from './itviec-parser';

export interface CrawlSummary {
  /** 'sitemap' (preferred — official URL inventory) or 'listing' (fallback sweep). */
  discovery: 'sitemap' | 'listing';
  slugsDiscovered: number;
  /** Known slugs still present in the sitemap — freshness bumped with ZERO page fetches. */
  refreshed: number;
  detailsFetched: number;
  parsed: number;
  ingested: { inserted: number; updated: number; skipped: number; errors: number };
  expired: number;
}

/**
 * J3 — disciplined ITviec crawler (Tier A: robots.txt `Allow: /`, IT-pure — see
 * docs/jd-pool-research.md). Invoked by `pnpm jobs:crawl` from an EXTERNAL daily
 * trigger (Render free sleeps → in-process cron never fires).
 *
 * DISCIPLINE (legal posture, non-negotiable):
 *  - robots.txt is re-checked EVERY run; a Disallow covering /it-jobs aborts the crawl.
 *  - logged-off only, no fake accounts, public pages only (hiQ/BrightData lesson).
 *  - rate-limited: one request per CRAWL_DELAY_MS (default 4s) + jitter.
 *  - stores ONLY extracted skills + metadata + the canonical link — full JD text is
 *    discarded by the ingest pipeline after PII-scrub + extraction.
 *  - ghost-job hygiene: postings not re-seen for EXPIRE_AFTER_DAYS flip to 'expired'.
 *
 * UA note: default identifies SkillBridge honestly. ITviec's WAF 403s some non-browser
 * agents (intel 2026-06-05); if blocked, operators may set JOBS_CRAWLER_UA — robots.txt
 * permits all agents, so the 403 is WAF behavior, not site policy. Crawl stops on
 * repeated 403s rather than hammering.
 */
@Injectable()
export class ItviecCrawlerService {
  private readonly logger = new Logger(ItviecCrawlerService.name);

  private static readonly BASE = 'https://itviec.com';
  /** Listing categories covering the 8 pilot roles. */
  private static readonly CATEGORIES = [
    'reactjs',
    'fullstack',
    'backend-developer',
    'android',
    'react-native',
    'flutter',
    'devops',
    'qa-qc',
    'data-analyst',
    'machine-learning',
  ];
  private static readonly EXPIRE_AFTER_DAYS = 3;

  constructor(
    private readonly config: ConfigService,
    private readonly ingest: JdIngestService,
    private readonly db: DatabaseService,
  ) {}

  private get userAgent(): string {
    return (
      process.env.JOBS_CRAWLER_UA ??
      'Mozilla/5.0 (compatible; SkillBridgeBot/1.0; +https://skillbridge.vn/bot)'
    );
  }

  private get delayMs(): number {
    return parseInt(process.env.CRAWL_DELAY_MS ?? '4000', 10);
  }

  async crawl(maxNewDetails = 40): Promise<CrawlSummary> {
    const summary: CrawlSummary = {
      discovery: 'sitemap',
      slugsDiscovered: 0,
      refreshed: 0,
      detailsFetched: 0,
      parsed: 0,
      ingested: { inserted: 0, updated: 0, skipped: 0, errors: 0 },
      expired: 0,
    };

    const robots = await this.assertRobotsAllows();

    // 1. Discovery — SITEMAP FIRST: ITviec's robots.txt declares a sitemap whose jobs_desc
    //    sub-sitemaps inventory EVERY active posting (~870 URLs, verified 2026-06-05).
    //    That is an official URL inventory — both more complete and more polite than
    //    sweeping listing pages (whose static HTML exposes only a handful of slugs).
    let slugs = await this.discoverSlugsFromSitemap(robots);
    if (slugs.length === 0) {
      summary.discovery = 'listing';
      slugs = await this.discoverSlugsFromListings();
    }
    summary.slugsDiscovered = slugs.length;

    // 2. Freshness for FREE: a known slug still present in the sitemap is still live —
    //    bump last_seen_at in one SQL statement, zero page fetches. Slugs that dropped
    //    out stop being bumped and age into expireStale() naturally.
    const knownRows = await this.db.query<{ external_id: string }>(
      `SELECT external_id FROM public.jobs WHERE source_name = 'itviec'`,
    );
    const known = new Set(knownRows.map((r) => r.external_id));
    const stillLive = slugs.filter((s) => known.has(s));
    if (stillLive.length > 0) {
      await this.db.query(
        `UPDATE public.jobs SET last_seen_at = now(), status = 'active', updated_at = now()
          WHERE source_name = 'itviec' AND external_id = ANY($1) AND status IN ('active','expired')`,
        [stillLive],
      );
      summary.refreshed = stillLive.length;
    }

    // 3. Detail fetch + parse — NEW slugs only, bounded per run (daily cadence covers the rest).
    const newSlugs = slugs.filter((s) => !known.has(s));
    const postings: ItviecPosting[] = [];
    for (const slug of newSlugs.slice(0, maxNewDetails)) {
      const url = `${ItviecCrawlerService.BASE}/it-jobs/${slug}`;
      const res = await this.politeFetch(url);
      summary.detailsFetched++;
      if (res.status === 410 || res.status === 404) continue; // expired/gone
      if (!res.ok) continue;
      const posting = parseDetailPage(slug, url, await res.text());
      if (posting) {
        postings.push(posting);
        summary.parsed++;
      }
    }

    // 3. One ingest path for everything (PII scrub + extraction + dedup + embedding inside).
    if (postings.length > 0) {
      const items: RawJobInput[] = postings.map((p) => ({
        source_type: 'scraped',
        source_name: 'itviec',
        external_id: p.slug,
        source_url: p.url,
        title: p.title,
        company_name: p.companyName,
        location: p.location ?? undefined,
        salary_min: p.salaryMin ?? undefined,
        salary_max: p.salaryMax ?? undefined,
        currency: p.currency ?? undefined,
        posted_at: p.postedAt ?? undefined,
        expires_at: p.expiresAt ?? undefined,
        jd_text: p.descriptionText,
      }));
      const r = await this.ingest.ingestBatch(items, 'itviec');
      summary.ingested = {
        inserted: r.inserted,
        updated: r.updated,
        skipped: r.skipped_no_skills,
        errors: r.errors.length,
      };
    }

    // 4. Ghost-job hygiene: anything not re-seen for N days is no longer live.
    const cutoff = new Date(Date.now() - ItviecCrawlerService.EXPIRE_AFTER_DAYS * 86_400_000);
    summary.expired = await this.ingest.expireStale('itviec', cutoff);

    this.logger.log(
      `itviec crawl [${summary.discovery}]: ${summary.slugsDiscovered} slugs · refreshed ${summary.refreshed} · ` +
        `${summary.parsed}/${summary.detailsFetched} new parsed → +${summary.ingested.inserted} ` +
        `(expired ${summary.expired})`,
    );
    return summary;
  }

  /**
   * Job slugs from the OFFICIAL sitemap chain: robots.txt `Sitemap:` line → sitemap index →
   * jobs_desc sub-sitemaps → /it-jobs/<slug> URLs. Resilient to the index being renamed
   * (ITviec uses a custom name) because we always start from robots.txt.
   */
  private async discoverSlugsFromSitemap(robots: string): Promise<string[]> {
    try {
      const sitemapUrl = robots
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => /^sitemap:/i.test(l))
        ?.replace(/^sitemap:\s*/i, '');
      if (!sitemapUrl) return [];

      const indexRes = await this.politeFetch(sitemapUrl);
      if (!indexRes.ok) return [];
      const index = await indexRes.text();
      const subSitemaps = [...index.matchAll(/<loc>([^<]+)<\/loc>/g)]
        .map((m) => m[1])
        .filter((u) => /jobs_desc/i.test(u));

      const seen = new Set<string>();
      const slugs: string[] = [];
      for (const sub of subSitemaps) {
        const res = await this.politeFetch(sub);
        if (!res.ok) continue;
        const xml = await res.text();
        for (const m of xml.matchAll(
          /<loc>[^<]*\/it-jobs\/([a-z0-9][a-z0-9-]*-[0-9]{4})<\/loc>/gi,
        )) {
          if (!seen.has(m[1])) {
            seen.add(m[1]);
            slugs.push(m[1]);
          }
        }
      }
      return slugs;
    } catch (err) {
      this.logger.warn(`sitemap discovery failed: ${(err as Error).message}`);
      return [];
    }
  }

  /** Fallback discovery: category listing sweep (static HTML exposes only a few slugs). */
  private async discoverSlugsFromListings(): Promise<string[]> {
    const slugs: string[] = [];
    const seen = new Set<string>();
    let consecutive403 = 0;
    for (const category of ItviecCrawlerService.CATEGORIES) {
      const res = await this.politeFetch(`${ItviecCrawlerService.BASE}/it-jobs/${category}`);
      if (res.status === 403) {
        if (++consecutive403 >= 3) {
          this.logger.warn('3 consecutive 403s — WAF is blocking this UA; stopping politely.');
          break;
        }
        continue;
      }
      consecutive403 = 0;
      if (!res.ok) continue;
      for (const slug of extractJobSlugs(await res.text())) {
        if (!seen.has(slug)) {
          seen.add(slug);
          slugs.push(slug);
        }
      }
    }
    return slugs;
  }

  /** Re-checked every run: if ITviec ever disallows /it-jobs for us, we stop crawling. */
  private async assertRobotsAllows(): Promise<string> {
    const res = await this.politeFetch(`${ItviecCrawlerService.BASE}/robots.txt`);
    if (!res.ok)
      throw new Error(`robots.txt unreachable (HTTP ${res.status}) — refusing to crawl blind`);
    const robots = await res.text();
    // Minimal conservative check: any Disallow line whose path prefix covers /it-jobs.
    const disallowed = robots
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => /^disallow:/i.test(l))
      .map((l) => l.replace(/^disallow:\s*/i, ''))
      .some((path) => path !== '' && '/it-jobs'.startsWith(path.replace(/\*$/, '')));
    if (disallowed) {
      throw new Error('robots.txt now disallows /it-jobs — crawl aborted (policy changed).');
    }
    return robots;
  }

  private async politeFetch(url: string): Promise<Response> {
    // Jitter ±25% around the base delay — no fixed-cadence hammering.
    const base = this.delayMs;
    const wait = base * (0.75 + Math.random() * 0.5);
    await new Promise((r) => setTimeout(r, wait));
    return fetch(url, {
      headers: {
        'User-Agent': this.userAgent,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'vi,en;q=0.8',
      },
      redirect: 'follow',
    });
  }
}
