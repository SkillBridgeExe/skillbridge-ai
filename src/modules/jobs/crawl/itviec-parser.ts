/**
 * Pure parsing helpers for the ITviec crawler (no I/O — fully unit-testable).
 *
 * Intel (verified live, 2026-06-05, 4 gather agents):
 *  - Listing pages /it-jobs/<category> are SERVER-RENDERED; job links appear as
 *    /it-jobs/<slug> anchors in static HTML.
 *  - Detail pages embed a JSON-LD JobPosting block — NOTE: the script tag uses
 *    SINGLE-quoted attributes (type='application/ld+json'); a double-quote-only
 *    matcher silently misses it.
 *  - Expired postings return HTTP 410 or a "Job expired" title.
 *  - JSON-LD baseSalary on ITviec is an unreliable placeholder (currency USD, empty
 *    min/max) — only trust it when min/max are actually populated.
 */

export interface ItviecPosting {
  slug: string;
  url: string;
  title: string;
  companyName: string;
  location: string | null;
  postedAt: string | null;
  expiresAt: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  currency: string | null;
  /** Plain-text description (HTML stripped) — input for skill extraction only. */
  descriptionText: string;
}

/**
 * Canonical ITviec job-slug shape: kebab text then a hyphen + a numeric id of 4 OR MORE
 * digits (real ids are not always exactly 4 — review finding). Shared by BOTH the listing
 * and sitemap discovery paths so they capture an IDENTICAL slug set (the freshness bump
 * keys on these — a mismatch would silently never match known jobs).
 */
export const ITVIEC_SLUG_CORE = '[a-z0-9][a-z0-9-]*-[0-9]{4,}';

/** Job-detail slugs from a listing page (deduped, order preserved). */
export function extractJobSlugs(listingHtml: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const re = new RegExp(`href=["']/it-jobs/(${ITVIEC_SLUG_CORE})["'?#]`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(listingHtml)) !== null) {
    const slug = m[1];
    if (!seen.has(slug)) {
      seen.add(slug);
      out.push(slug);
    }
  }
  return out;
}

/** Job slugs from a sitemap XML (<loc> URLs). Same slug shape as the listing path. */
export function extractSitemapSlugs(xml: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const re = new RegExp(`<loc>[^<]*/it-jobs/(${ITVIEC_SLUG_CORE})</loc>`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      out.push(m[1]);
    }
  }
  return out;
}

/** All JSON-LD blocks in a page — tolerant of single OR double quoted attributes. */
export function extractJsonLdBlocks(html: string): unknown[] {
  const blocks: unknown[] = [];
  const re = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try {
      blocks.push(JSON.parse(m[1].trim()));
    } catch {
      // malformed block — skip silently, the caller treats "no JobPosting" as unusable page
    }
  }
  return blocks;
}

/** Minimal named-entity map (the rest are decoded numerically). */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/**
 * Crude but dependency-free HTML→text: strip tags, keep line structure, and FULLY decode
 * entities — Vietnamese JD text is riddled with numeric entities (&#7847; = ầ) and named
 * Latin ones (&ecirc; = ê) that, left raw, become garbage tokens in skill extraction.
 */
export function htmlToText(html: string): string {
  return (
    html
      .replace(/<\s*(br|\/p|\/li|\/h[1-6]|\/div)[^>]*>/gi, '\n')
      .replace(/<li[^>]*>/gi, '- ')
      .replace(/<[^>]+>/g, ' ')
      // Numeric entities: &#7847; (decimal) and &#x1EA7; (hex).
      .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeFromCodePoint(parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_, dec) => safeFromCodePoint(parseInt(dec, 10)))
      // Named entities: known set decoded exactly; any other &name; collapses to a space
      // (so "&ecirc;" never survives as a literal token).
      .replace(/&([a-z][a-z0-9]{1,31});/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/ ?\n ?/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

function safeFromCodePoint(cp: number): string {
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return ' ';
  try {
    return String.fromCodePoint(cp);
  } catch {
    return ' ';
  }
}

/** ITviec districts → city (JSON-LD gives "Quan 1" etc.; trends need the city). */
const HCM_HINTS =
  /quận|quan\s|thủ đức|thu duc|tân bình|tan binh|bình thạnh|binh thanh|phú nhuận|phu nhuan|gò vấp|go vap|hồ chí minh|ho chi minh|hcm/i;
const HN_HINTS =
  /hà nội|ha noi|hoàn kiếm|hoan kiem|cầu giấy|cau giay|nam từ liêm|nam tu liem|ba đình|ba dinh|tây hồ|tay ho|đống đa|dong da|thanh xuân|thanh xuan/i;
const DN_HINTS = /đà nẵng|da nang/i;

export function normalizeLocation(raw: string | null | undefined): string | null {
  const s = (raw ?? '').trim();
  if (s.length === 0 || /not available/i.test(s)) return null;
  if (DN_HINTS.test(s)) return 'Đà Nẵng';
  if (HN_HINTS.test(s)) return 'Hà Nội';
  if (HCM_HINTS.test(s)) return 'Hồ Chí Minh';
  return s;
}

/** Parse one detail page → posting, or null when it has no usable ACTIVE JobPosting. */
export function parseDetailPage(slug: string, url: string, html: string): ItviecPosting | null {
  if (/job\s+expired/i.test(html.slice(0, 2000))) return null;

  const blocks = extractJsonLdBlocks(html);
  const flat: Array<Record<string, unknown>> = [];
  for (const b of blocks) {
    if (Array.isArray(b)) flat.push(...(b as Array<Record<string, unknown>>));
    else if (b && typeof b === 'object') flat.push(b as Record<string, unknown>);
  }
  const posting = flat.find((b) => b['@type'] === 'JobPosting');
  if (!posting) return null;

  const title = String(posting.title ?? '').trim();
  const org = posting.hiringOrganization as { name?: string } | undefined;
  const companyName = String(org?.name ?? '').trim();
  const description = htmlToText(String(posting.description ?? ''));
  if (!title || !companyName || description.length < 200) return null;

  // validThrough in the past = expired even when the page still renders. A DATE-ONLY value
  // ("2026-06-05") is parsed by Date as UTC midnight; in VN (UTC+7) that wrongly expires a
  // still-valid posting for the first 7 hours of its last day — anchor date-only values to
  // END of day in UTC+7 (review finding).
  const validThrough = posting.validThrough ? String(posting.validThrough) : null;
  if (validThrough) {
    const cmp = /^\d{4}-\d{2}-\d{2}$/.test(validThrough)
      ? Date.parse(`${validThrough}T23:59:59+07:00`)
      : Date.parse(validThrough);
    if (Number.isFinite(cmp) && cmp < Date.now()) return null;
  }

  const jobLocation = posting.jobLocation as
    | { address?: { addressLocality?: string; addressRegion?: string } }
    | Array<{ address?: { addressLocality?: string; addressRegion?: string } }>
    | undefined;
  const addr = Array.isArray(jobLocation) ? jobLocation[0]?.address : jobLocation?.address;
  const location = normalizeLocation(addr?.addressLocality ?? addr?.addressRegion ?? null);

  // baseSalary: trust ONLY when min/max are populated (placeholder otherwise — intel note).
  const baseSalary = posting.baseSalary as
    | { currency?: string; value?: { minValue?: number; maxValue?: number } }
    | undefined;
  const minV = baseSalary?.value?.minValue;
  const maxV = baseSalary?.value?.maxValue;
  const hasSalary =
    (typeof minV === 'number' && minV > 0) || (typeof maxV === 'number' && maxV > 0);

  return {
    slug,
    url,
    title,
    companyName,
    location,
    postedAt: posting.datePosted ? String(posting.datePosted) : null,
    expiresAt: validThrough,
    salaryMin: hasSalary && typeof minV === 'number' && minV > 0 ? minV : null,
    salaryMax: hasSalary && typeof maxV === 'number' && maxV > 0 ? maxV : null,
    currency: hasSalary ? (baseSalary?.currency ?? null) : null,
    descriptionText: description,
  };
}
