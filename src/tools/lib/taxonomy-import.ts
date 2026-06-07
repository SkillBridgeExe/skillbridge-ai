/**
 * Pure parse / filter / dedupe / map helpers for the Taxonomy v2 importers.
 *
 * These functions have NO side effects (no fs, no network, no DB) so they are
 * unit-tested in isolation (`test/tools/taxonomy-import.spec.ts`). The thin
 * download/IO wrappers live in `src/tools/import-onet-tech-skills.ts` (and the
 * ESCO equivalent) and delegate the actual transformation here.
 */
import { parse } from 'csv-parse/sync';

/**
 * One deduped O*NET "Technology Skills" tool, already filtered to the IT subset.
 */
export interface OnetRow {
  /** The tool/example name as O*NET lists it, e.g. "Microsoft SQL Server". */
  example: string;
  /** O*NET UNSPSC Commodity Code (e.g. "43232408"). */
  commodityCode: string;
  /** O*NET Commodity Title (e.g. "Web platform development software"). */
  commodityTitle: string;
  /** Economy-wide "Hot Technology" flag (OR-merged across the tool's rows). */
  hotTechnology: boolean;
  /** Stable import-time identity: `onet:<commodityCode>:<example>`. */
  sourceExternalId: string;
}

/**
 * Software-category titles that mark an IT-/software-engineering-relevant tool.
 * Case-insensitive, applied to the category column (old "Commodity Title", new
 * 30.x "Element Name").
 *
 * NOTE — deviation from the original plan (see header of `parseOnetTechSkills`):
 *  - The plan's UNSPSC `Commodity Code` "43" prefix rule no longer exists in
 *    O*NET 30.x (the Element ID is a Content-Model ref like "2.E.5.b"), so it is
 *    dropped — it was also too broad (it would keep "Graphics software" /
 *    "Financial analysis software", which the unit test requires us to exclude).
 *  - The plan's bare `software` alternative is removed: O*NET 30.x ships a
 *    `Software Skills.txt` whose categories ALL contain the word "software", so
 *    matching on "software" alone keeps the entire ~8.7k-tool file (business
 *    apps included). We instead curate the genuinely IT/software-engineering
 *    categories (languages, dev environments, web platforms, databases, OS,
 *    networking/security, cloud, infra), validated against the real 30.3
 *    Element-Name list. This keeps React in and Adobe Photoshop ("Graphics
 *    software") / Microsoft Excel ("Financial analysis software") out.
 */
const IT_COMMODITY_RE =
  /programming|software development|development environment|object.*oriented.*development|graphical user interface development|requirements analysis and system architecture|web platform|web page creation|operating system|network operating system|\bdatabase\b|data base|configuration management|\bversion|program testing|compiler|enterprise application integration|application server|transaction server|portal server|communications server|enterprise system management|network monitoring|network security|virtual private network|clustering|storage networking|filesystem|software defined networking|backup or archival|metadata management|data mining|business intelligence|expert system|cloud-based|authentication server|internet directory services|switch or router/i;

/**
 * Parse the tab-delimited O*NET technology/software-skills file (header row),
 * keep only the IT subset, and dedupe by the tool name (a single tool appears
 * under many SOC occupations). The "Hot Technology" flag is economy-wide for a
 * given tool, so OR-merging it across the duplicate rows is safe.
 *
 * Schema-tolerant: works with BOTH the pre-30 "Technology Skills.txt" columns
 * (`Example`, `Commodity Code`, `Commodity Title`) AND the O*NET 30.x
 * "Software Skills.txt" columns (`Workplace Example`, `Element ID`,
 * `Element Name`). The 30.x rename is why we resolve each field from a list of
 * candidate header names below.
 *
 * IT subset rule: the category title matches {@link IT_COMMODITY_RE}.
 */
export function parseOnetTechSkills(tsv: string): OnetRow[] {
  const records = parse(tsv, {
    delimiter: '\t',
    columns: true,
    skip_empty_lines: true,
    relax_quotes: true,
    trim: true,
  }) as Record<string, string>[];

  const pick = (r: Record<string, string>, keys: string[]): string => {
    for (const k of keys) {
      if (r[k] != null && String(r[k]).length > 0) return String(r[k]);
    }
    return '';
  };

  const byExample = new Map<string, OnetRow>();
  for (const r of records) {
    // 30.x renamed Commodity Code → Element ID, Commodity Title → Element Name,
    // Example → Workplace Example.
    const code = pick(r, ['Commodity Code', 'Element ID']);
    const title = pick(r, ['Commodity Title', 'Element Name']);
    if (!IT_COMMODITY_RE.test(title)) continue;

    const example = pick(r, ['Example', 'Workplace Example']).trim();
    if (!example) continue;

    const hot = (r['Hot Technology'] ?? 'N').trim().toUpperCase() === 'Y';
    const prev = byExample.get(example);
    byExample.set(example, {
      example,
      commodityCode: code,
      commodityTitle: title,
      // Hot Technology is an economy-wide property of the tool, not the
      // occupation pairing → OR across duplicate rows is correct.
      hotTechnology: hot || (prev?.hotTechnology ?? false),
      sourceExternalId: `onet:${code}:${example}`,
    });
  }

  return [...byExample.values()];
}

/**
 * One ESCO "KnowledgeSkillCompetence" concept from the digital-skills collection.
 */
export interface EscoRow {
  /** Stable ESCO concept URI (also the `source_external_id`). */
  conceptUri: string;
  /** ESCO `preferredLabel` (English). */
  preferredLabel: string;
  /** snake_case(preferredLabel) — a RAW candidate key; curation may rename it. */
  canonical_name: string;
  /** Human-facing name = preferredLabel. */
  display_name: string;
  /** = conceptUri (provenance). */
  source_external_id: string;
  /** ESCO `skillType`: 'knowledge' (concrete tech/concept) | 'skill/competence' (verb phrase). */
  skillType: string;
  /** altLabels ∪ hiddenLabels, newline-split, trimmed, deduped. */
  aliases: string[];
  /** ESCO `description` (kept for embedding-fallback matching + human review). */
  description: string;
}

const ESCO_PARSE_OPTS = {
  columns: true,
  skip_empty_lines: true,
  relax_quotes: true,
  bom: true, // ESCO CSVs ship a UTF-8 BOM; without this the first header key is mangled.
  trim: true,
} as const;

/**
 * Build the set of `conceptUri`s that belong to ESCO's Digital Skills collection
 * (`digitalSkillsCollection_en.csv`). Used to filter the full `skills_en.csv` down
 * to the digital/IT subset (the collection file itself omits `hiddenLabels`, so we
 * filter-then-read the richer `skills_en.csv`).
 */
export function parseEscoDigitalUris(digitalCsv: string): Set<string> {
  const records = parse(digitalCsv, ESCO_PARSE_OPTS) as Record<string, string>[];
  const set = new Set<string>();
  for (const r of records) {
    const uri = (r.conceptUri ?? '').trim();
    if (uri) set.add(uri);
  }
  return set;
}

/**
 * Parse `skills_en.csv`, keep only `KnowledgeSkillCompetence` rows whose `conceptUri`
 * is in {@link parseEscoDigitalUris}, and project each to an {@link EscoRow}. Multi-value
 * label fields (`altLabels`, `hiddenLabels`) are newline-separated within a single quoted
 * cell → split on `\n`. No IT-narrowing or dedupe-vs-taxonomy here (that is the curation
 * step's job, mirroring the O*NET flow); this stays a pure projection of the digital subset.
 */
export function parseEscoSkills(skillsCsv: string, digitalUris: Set<string>): EscoRow[] {
  const records = parse(skillsCsv, ESCO_PARSE_OPTS) as Record<string, string>[];
  const rows: EscoRow[] = [];
  for (const r of records) {
    if ((r.conceptType ?? '').trim() !== 'KnowledgeSkillCompetence') continue;
    const uri = (r.conceptUri ?? '').trim();
    if (!digitalUris.has(uri)) continue;
    const preferredLabel = (r.preferredLabel ?? '').trim();
    if (!preferredLabel) continue;

    const aliases = [...(r.altLabels ?? '').split('\n'), ...(r.hiddenLabels ?? '').split('\n')]
      .map((a) => a.trim())
      .filter(Boolean);

    rows.push({
      conceptUri: uri,
      preferredLabel,
      canonical_name: snakeCaseSkill(preferredLabel),
      display_name: preferredLabel,
      source_external_id: uri,
      skillType: (r.skillType ?? '').trim(),
      aliases: [...new Set(aliases)],
      description: (r.description ?? '').trim(),
    });
  }
  return rows;
}

/**
 * snake_case a skill name into a `canonical_name`, mirroring the *style* of
 * {@link SkillTaxonomyService.normalizeKey} (lowercase + trim) but producing an
 * underscore-joined token rather than a punctuation-stripped lookup key.
 *
 * Rules: lowercase, trim, collapse runs of whitespace / `-` / `_` / `.` / `/`
 * into a single `_`, drop most other punctuation, but KEEP `+` and `#`
 * (semantically meaningful in language names). Trailing/leading `_` is trimmed.
 *
 *   "Microsoft SQL Server" → "microsoft_sql_server"
 *   "C++"                  → "c++"
 *   "C#"                   → "c#"
 *   "Node.js"              → "node_js"
 *   "ASP.NET"              → "asp_net"
 */
export function snakeCaseSkill(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[\s\-_./]+/g, '_') // collapse separators → single underscore
    .replace(/[^a-z0-9_+#]+/g, '') // drop anything else, KEEP + and #
    .replace(/_+/g, '_') // collapse any underscore runs introduced above
    .replace(/^_+|_+$/g, ''); // trim leading/trailing underscores
}
