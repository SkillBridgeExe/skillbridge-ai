import { Injectable, Logger, Optional } from '@nestjs/common';
import { SkillTaxonomyService, TaxonomyEntry } from './skill-taxonomy.service';
import { SemanticSkillMatcherService } from './semantic-skill-matcher.service';

export type NormalizationMatchType =
  | 'exact'
  | 'alias'
  | 'fuzzy'
  | 'umbrella'
  | 'token'
  | 'semantic'
  | 'none';

export interface NormalizedSkill {
  /** canonical_name if matched, null if unrecognized */
  skill_id: string | null;
  /** Same as skill_id (kept for clarity in API responses) */
  canonical_name: string | null;
  /** Human display name from taxonomy, null if unrecognized */
  display_name: string | null;
  /** Original LLM-extracted name preserved for audit (the PART text for compound splits) */
  raw_input: string;
  /** How we matched it */
  matched_via: NormalizationMatchType;
  /** 1.0 = certain, 0.7 = fuzzy guess, 0.0 = no match */
  confidence: number;
}

/**
 * Maps raw LLM-extracted skill text → canonical taxonomy ID(s).
 *
 * STAGE 0 (pre-normalize, blueprint step 4) wraps the original cascade:
 *   0a. whole-phrase lookup first (so "CI/CD", "TCP/IP" are NEVER split),
 *   0b. Vietnamese UMBRELLA phrases → multiple canonicals ("Lập trình web" → html+css+js),
 *   0c. version-strip ("Vue 3" → "vue", "Python 3.11" → "python", "ES2022" → es6),
 *   0d. compound split on + & , / "và" "and" ("React + Redux" → react, redux),
 *   0e. exact-only token fallback ("k8s cluster" → kubernetes, "excel hơi biết" → excel).
 *
 * STAGES 1-3 (single phrase): exact → alias → fuzzy. The fuzzy stage is LENGTH-GUARDED
 * (eval-verified false positives: "canva"→java@d2, "vercel"→excel@d2, "word", "seo", "r"):
 *   key ≤ 4 chars → no fuzzy · 5-7 chars → distance ≤ 1 · ≥ 8 chars → distance ≤ 2.
 *
 * NO LLM CALLS HERE. Pure deterministic code so cv→skills extraction is reproducible.
 * Gate: `pnpm eval:mentions` (precision ≥ 0.90 / F1 ≥ 0.75 in strict mode).
 */
@Injectable()
export class SkillNormalizerService {
  private readonly logger = new Logger(SkillNormalizerService.name);

  constructor(
    private readonly taxonomy: SkillTaxonomyService,
    // @Optional so DB-less constructions stay valid: the calibration harnesses
    // (eval-mentions/eval-match) and unit tests build `new SkillNormalizerService(taxonomy)`
    // directly — the sync cascade must never require the semantic tier.
    @Optional() private readonly semantic?: SemanticSkillMatcherService,
  ) {}

  // ─── Stage-0 tables ─────────────────────────────────────────────────────────

  /** VI umbrella phrases naming an AREA, mapped to the concrete skills they imply. */
  private static readonly UMBRELLA: ReadonlyArray<[string[], string[]]> = [
    [
      [
        'lập trình web',
        'lap trinh web',
        'phát triển ứng dụng web',
        'phat trien ung dung web',
        'phát triển web',
        'phat trien web',
      ],
      ['html', 'css', 'javascript'],
    ],
    [
      [
        'lập trình di động',
        'lap trinh di dong',
        'lập trình mobile',
        'lap trinh mobile',
        'phát triển ứng dụng di động',
        'phat trien ung dung di dong',
      ],
      ['swift', 'kotlin', 'flutter', 'react_native'],
    ],
  ];

  /** Trailing version tokens: "Vue 3", "Python 3.11", "Java 17", "Go 1.21", ".NET 8", "Kotlin 1.9". */
  private static readonly TRAILING_VERSION = /\s+v?\d+(?:\.\d+)*\+?$/i;
  /** ECMAScript year/edition forms collapse to the indexed "es6" alias (javascript). */
  private static readonly ES_VERSION = /^es\d{1,4}$/i;
  /**
   * Primary compound delimiters — SLASH IS EXCLUDED here: slash-compounds ("HTML/CSS") are
   * split in a second pass ONLY when the fragment doesn't resolve whole, so "CI/CD"/"TCP/IP"
   * survive even when nested inside a larger compound ("Docker và CI/CD") — review finding.
   */
  private static readonly SPLIT_PRIMARY = /\s+(?:và|and)\s+|[+&,]/i;
  /**
   * Token-fallback safety (review finding: "updated my cv"→computer_vision, "next step"→nextjs):
   * the fallback only fires when every NON-skill token is a known qualifier students attach to
   * a skill ("excel hơi biết", "k8s cluster"). Arbitrary prose around a short alias is rejected.
   */
  private static readonly TOKEN_QUALIFIERS = new Set([
    'basic',
    'basics',
    'fundamental',
    'fundamentals',
    'beginner',
    'intermediate',
    'advanced',
    'knowledge',
    'experience',
    'experienced',
    'skill',
    'skills',
    'proficient',
    'proficiency',
    'using',
    'usage',
    'with',
    'level',
    'cluster',
    'administration',
    'admin',
    'programming',
    'language',
    'hơi',
    'biết',
    'cơ',
    'bản',
    'thành',
    'thạo',
    'tốt',
    'khá',
    'sử',
    'dụng',
    'về',
    'căn',
    'co',
    'ban',
    'thanh',
    'thao',
    'tot',
    'kha',
    'su',
    'dung',
    've',
    'can',
  ]);
  /**
   * Quality order for cross-mention dedupe: keep the strongest evidence for a canonical.
   * 'semantic' (whole-phrase cosine ≥ accept-threshold) ranks above 'fuzzy' (levenshtein
   * d≤2 can be a near-collision) but below 'token' (an exact alias hit inside the phrase).
   */
  private static readonly VIA_RANK: Record<NormalizationMatchType, number> = {
    exact: 6,
    alias: 5,
    umbrella: 4,
    token: 3,
    semantic: 2,
    fuzzy: 1,
    none: 0,
  };

  /**
   * Stage-0 entry point: one raw mention → ZERO OR MORE canonical skills.
   * Single-phrase callers can keep using normalizeRaw(); matching/persistence flows should
   * use this so compounds and umbrella phrases contribute every skill they name.
   */
  normalizeMention(rawName: string, depth = 0): NormalizedSkill[] {
    const raw = (rawName ?? '').trim();
    if (raw.length === 0) return [];

    // 0a. whole phrase first — EXACT/ALIAS only. Fuzzy is deferred to the very end:
    // a whole-phrase fuzzy hit would hijack compounds ("react+redux" ~d1~ alias
    // "react redux" → redux, swallowing react before the split could run).
    const whole = this.exactOrAlias(raw);
    if (whole.canonical_name) return [whole];

    const lower = raw.toLowerCase();

    // 0b. Vietnamese umbrella phrases → multiple concrete skills.
    for (const [phrases, canonicals] of SkillNormalizerService.UMBRELLA) {
      if (phrases.includes(lower)) {
        return canonicals
          .map((c) => this.fromCanonical(c, raw, 'umbrella', 0.9))
          .filter((s): s is NormalizedSkill => s !== null);
      }
    }

    // Depth 3 budget: a versioned compound part needs strip(+1) inside split(+1) — review
    // finding: 'React 18 + Redux 4' lost react at the old depth-2 cap. Strings strictly
    // shrink per recursion, so this cannot run away.
    if (depth >= 3) return [];

    // 0c. version-strip ("Tailwind 3" → "tailwind"; "ES2022" → "es6").
    if (SkillNormalizerService.ES_VERSION.test(lower)) {
      const es = this.normalizeRaw('es6');
      if (es.canonical_name) return [{ ...es, raw_input: raw }];
    }
    const stripped = raw.replace(SkillNormalizerService.TRAILING_VERSION, '');
    if (stripped !== raw && stripped.length > 0) {
      const viaStrip = this.normalizeMention(stripped, depth + 1);
      // Single 1:1 result → the original (versioned) text is the meaningful audit trail.
      // Fan-out (the strip uncovered a compound) → keep each PART's own raw_input (review finding).
      if (viaStrip.length === 1) return [{ ...viaStrip[0], raw_input: raw }];
      if (viaStrip.length > 0) return viaStrip;
    }

    // 0d. compound split — primary delimiters first; slash only for fragments that don't
    // resolve whole (protects "CI/CD"/"TCP/IP" nested in "Docker và CI/CD" — review finding).
    const fragments = raw
      .split(SkillNormalizerService.SPLIT_PRIMARY)
      .map((p) => p.trim())
      .filter((p) => p.length >= 2);
    const parts: string[] = [];
    for (const frag of fragments) {
      if (frag.includes('/') && !this.exactOrAlias(frag).canonical_name) {
        parts.push(
          ...frag
            .split('/')
            .map((p) => p.trim())
            .filter((p) => p.length >= 2),
        );
      } else {
        parts.push(frag);
      }
    }
    if (parts.length >= 2) {
      const resolved = new Map<string, NormalizedSkill>();
      for (const part of parts) {
        for (const s of this.normalizeMention(part, depth + 1)) {
          if (s.canonical_name && !resolved.has(s.canonical_name))
            resolved.set(s.canonical_name, s);
        }
      }
      if (resolved.size > 0) return [...resolved.values()];
    }

    // 0e. exact-only token fallback for "skill + qualifier" phrases ("k8s cluster",
    // "excel hơi biết"). Fuzzy is NOT applied per-token, and EVERY non-skill token must be
    // a known qualifier — otherwise arbitrary prose with a short alias inside would
    // false-match ("updated my cv"→computer_vision, "next step"→nextjs; review finding).
    const tokens = raw.split(/\s+/).filter((t) => t.length >= 2);
    if (tokens.length >= 2 && tokens.length <= 4) {
      const resolved = new Map<string, NormalizedSkill>();
      let qualifiersOnly = true;
      for (const token of tokens) {
        const key = SkillTaxonomyService.normalizeKey(token);
        const canonical = this.taxonomy.lookupByAliasKey(key);
        if (canonical) {
          if (!resolved.has(canonical)) {
            const hit = this.fromCanonical(canonical, token, 'token', 0.8);
            if (hit) resolved.set(canonical, hit);
          }
        } else if (!SkillNormalizerService.TOKEN_QUALIFIERS.has(token.toLowerCase())) {
          qualifiersOnly = false;
          break;
        }
      }
      if (qualifiersOnly && resolved.size > 0) return [...resolved.values()];
    }

    // 0f. LAST resort: length-guarded fuzzy on the whole phrase (typos: "javscript").
    const fuzzy = this.fuzzyMatch(raw);
    if (fuzzy.canonical_name) return [fuzzy];

    return [];
  }

  /** Single-phrase cascade (stages 1-3): exact → alias → length-guarded fuzzy. */
  normalizeRaw(rawName: string): NormalizedSkill {
    const direct = this.exactOrAlias(rawName ?? '');
    if (direct.canonical_name) return direct;
    return this.fuzzyMatch(rawName ?? '');
  }

  /** Stage 1-2: exact canonical/display or alias hit via the index. */
  private exactOrAlias(raw: string): NormalizedSkill {
    if (raw.trim().length === 0) {
      return this.unmatched(raw);
    }

    const key = SkillTaxonomyService.normalizeKey(raw);
    const direct = this.taxonomy.lookupByAliasKey(key);
    if (direct) {
      const entry = this.taxonomy.getByCanonical(direct);
      if (!entry) return this.unmatched(raw); // shouldn't happen but be safe

      const isCanonical = SkillTaxonomyService.normalizeKey(entry.canonical_name) === key;
      const isDisplay = SkillTaxonomyService.normalizeKey(entry.display_name) === key;
      const matchType: NormalizationMatchType = isCanonical || isDisplay ? 'exact' : 'alias';
      return {
        skill_id: entry.canonical_name,
        canonical_name: entry.canonical_name,
        display_name: entry.display_name,
        raw_input: raw,
        matched_via: matchType,
        confidence: matchType === 'exact' ? 1.0 : 0.9,
      };
    }
    return this.unmatched(raw);
  }

  /**
   * Stage 3: fuzzy, LENGTH-GUARDED. Short keys false-match catastrophically at d≤2
   * ("canva"→java, "vercel"→excel, "seo"→dotnet — all eval-verified), so:
   *   ≤4 chars: no fuzzy · 5-7: d≤1 · ≥8: d≤2.
   */
  private fuzzyMatch(raw: string): NormalizedSkill {
    if (raw.trim().length === 0) return this.unmatched(raw);
    const key = SkillTaxonomyService.normalizeKey(raw);
    const maxDistance = key.length <= 4 ? 0 : key.length <= 7 ? 1 : 2;
    if (maxDistance === 0) return this.unmatched(raw);

    let bestCanonical: string | null = null;
    let bestDistance = Infinity;
    for (const [aliasKey, canonical] of this.taxonomy.iterateAliasEntries()) {
      // Early skip: if length differs more than threshold, can't possibly match.
      if (Math.abs(aliasKey.length - key.length) > maxDistance) continue;
      const d = levenshtein(key, aliasKey, maxDistance);
      if (d < bestDistance) {
        bestDistance = d;
        bestCanonical = canonical;
        if (d === 0) break; // can't beat zero
      }
    }

    if (bestCanonical && bestDistance <= maxDistance) {
      const entry = this.taxonomy.getByCanonical(bestCanonical);
      if (entry) {
        return {
          skill_id: entry.canonical_name,
          canonical_name: entry.canonical_name,
          display_name: entry.display_name,
          raw_input: raw,
          matched_via: 'fuzzy',
          // Closer = more confident; distance 1 → 0.75, distance 2 → 0.65
          confidence: bestDistance === 1 ? 0.75 : 0.65,
        };
      }
    }

    return this.unmatched(raw);
  }

  /**
   * Flattened multi-mention normalization (compounds contribute every named skill).
   * Cross-mention dedupe keeps the STRONGEST evidence per canonical (matched_via rank, then
   * confidence) — not the first seen, which was LLM-output-order dependent (review finding).
   */
  normalizeMany(rawNames: string[]): NormalizedSkill[] {
    const best = new Map<string, NormalizedSkill>();
    const unresolved: NormalizedSkill[] = [];
    for (const n of rawNames) {
      this.mergeMentionResults(n, this.normalizeMention(n), best, unresolved);
    }
    return [...best.values(), ...unresolved];
  }

  // ─── Async variants (deterministic cascade + semantic embedding fallback) ──────────

  /**
   * normalizeMention + the semantic embedding tier as TRUE last resort: the async path
   * consults SemanticSkillMatcherService ONLY when the whole sync cascade returned [],
   * so every deterministic result is byte-identical to the sync API (eval:mentions
   * stays the source of truth for stages 0-3). When the tier is disabled (test env,
   * no key, no DB) this degrades to exactly normalizeMention.
   */
  async normalizeMentionAsync(rawName: string): Promise<NormalizedSkill[]> {
    const sync = this.normalizeMention(rawName);
    if (sync.length > 0) return sync;
    if (!this.semantic?.isEnabled()) return sync;

    const raw = (rawName ?? '').trim();
    if (raw.length === 0) return sync;

    const hit = await this.semantic.resolve(raw); // null unless band 'auto'
    if (!hit) return [];
    const entry = this.taxonomy.getByCanonical(hit.canonicalName);
    if (!entry) {
      // DB knows a skill the in-memory taxonomy doesn't (drifted seed) — don't fabricate.
      this.logger.warn(
        `semantic tier resolved "${raw}" → ${hit.canonicalName}, which is missing from skills-pilot.json; ignoring.`,
      );
      return [];
    }
    return [
      {
        skill_id: entry.canonical_name,
        canonical_name: entry.canonical_name,
        display_name: entry.display_name,
        raw_input: raw,
        matched_via: 'semantic',
        // Carry the measured similarity (capped below alias's 0.9) so downstream
        // confidence ordering stays meaningful and auditable.
        confidence: Math.min(0.85, Number(hit.similarity.toFixed(2))),
      },
    ];
  }

  /** Async normalizeMany — same merge semantics, semantic tier on sync misses only. */
  async normalizeManyAsync(rawNames: string[]): Promise<NormalizedSkill[]> {
    const best = new Map<string, NormalizedSkill>();
    const unresolved: NormalizedSkill[] = [];
    // Sequential on purpose: misses are rare (head handled by stages 0-3), and the
    // resolution cache makes repeats free — no need to burst the embeddings API.
    for (const n of rawNames) {
      this.mergeMentionResults(n, await this.normalizeMentionAsync(n), best, unresolved);
    }
    return [...best.values(), ...unresolved];
  }

  /** Shared merge for normalizeMany/normalizeManyAsync (strongest evidence per canonical). */
  private mergeMentionResults(
    rawName: string,
    results: NormalizedSkill[],
    best: Map<string, NormalizedSkill>,
    unresolved: NormalizedSkill[],
  ): void {
    if (results.length === 0) {
      unresolved.push(this.unmatched(rawName)); // keep raw for audit/taxonomy-expansion signals
      return;
    }
    for (const s of results) {
      if (!s.canonical_name) continue;
      const prev = best.get(s.canonical_name);
      const rank = SkillNormalizerService.VIA_RANK;
      if (
        !prev ||
        rank[s.matched_via] > rank[prev.matched_via] ||
        (rank[s.matched_via] === rank[prev.matched_via] && s.confidence > prev.confidence)
      ) {
        best.set(s.canonical_name, s);
      }
    }
  }

  /** O(1) taxonomy lookup passthrough for downstream services (display names etc.). */
  getByCanonical(canonicalName: string): TaxonomyEntry | undefined {
    return this.taxonomy.getByCanonical(canonicalName);
  }

  private fromCanonical(
    canonical: string,
    rawInput: string,
    via: NormalizationMatchType,
    confidence: number,
  ): NormalizedSkill | null {
    const entry = this.taxonomy.getByCanonical(canonical);
    if (!entry) return null;
    return {
      skill_id: entry.canonical_name,
      canonical_name: entry.canonical_name,
      display_name: entry.display_name,
      raw_input: rawInput,
      matched_via: via,
      confidence,
    };
  }

  private unmatched(raw: string): NormalizedSkill {
    return {
      skill_id: null,
      canonical_name: null,
      display_name: null,
      raw_input: raw,
      matched_via: 'none',
      confidence: 0,
    };
  }

  /** Convenience for downstream services iterating canonical taxonomy. */
  getTaxonomyEntries(): TaxonomyEntry[] {
    return this.taxonomy.getAll();
  }
}

/**
 * Levenshtein distance with an upper bound (early exit).
 * Returns Infinity if distance exceeds `maxDistance` — caller can skip.
 *
 * Standard DP, O(a*b) time, O(b) space. For our usage (strings < 30 chars,
 * ~750 alias entries), runs in microseconds.
 */
export function levenshtein(a: string, b: string, maxDistance = Infinity): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  if (Math.abs(a.length - b.length) > maxDistance) return Infinity;

  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1, // insertion
        prev[j] + 1, // deletion
        prev[j - 1] + cost, // substitution
      );
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    // Early exit if entire row exceeds threshold
    if (rowMin > maxDistance) return Infinity;
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}
