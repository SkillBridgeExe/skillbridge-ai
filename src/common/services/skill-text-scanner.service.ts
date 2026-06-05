import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SkillTaxonomyService } from './skill-taxonomy.service';

export interface ScannedSkill {
  canonical_name: string;
  /** The surface form that matched in the text (alias/display/canonical). */
  matched_text: string;
  /** Number of occurrences found. */
  occurrences: number;
}

/**
 * Deterministic GAZETTEER scan: find taxonomy skills named ANYWHERE in a long free text
 * (job descriptions). This is the JD-side counterpart of SkillNormalizerService — which
 * normalizes short MENTIONS; this scans whole documents.
 *
 * NO LLM by design (deterministic-first): JDs overwhelmingly name hard skills literally
 * ("ReactJS", "Node.js", "PostgreSQL"), so a surface-form scan over the 106-skill /
 * ~840-surface-form taxonomy captures the head reliably, reproducibly, and for free.
 * Long-tail paraphrases ("xây dựng pipeline dữ liệu") are NOT caught here — that is the
 * semantic tier's job and can be wired to unresolved JD phrases later (noted in J-plan).
 *
 * False-positive guards (mirrors the normalizer's length-guard philosophy):
 *  - surface forms < 2 chars are never scanned;
 *  - 2-char letter-only forms (e.g. "go") match CASE-SENSITIVELY as written in the
 *    taxonomy display ("Go") — lowercase prose "we go fast" does not fire;
 *  - matches require non-letter/digit boundaries (Unicode-aware), so "javac" does not
 *    fire "java", while "C++"/"C#"/".NET" still match (symbols are valid boundaries).
 */
@Injectable()
export class SkillTextScannerService implements OnModuleInit {
  private readonly logger = new Logger(SkillTextScannerService.name);

  /** Precompiled per-surface-form matchers, built once from the taxonomy. */
  private matchers: Array<{ canonical: string; surface: string; regex: RegExp }> = [];

  constructor(private readonly taxonomy: SkillTaxonomyService) {}

  onModuleInit(): void {
    this.buildMatchers();
  }

  /**
   * Surface forms that are common English/Vietnamese PROSE words and would false-fire on
   * job-description text ("send your CV" → computer_vision, "the rest of" → rest_api,
   * "Go to step 2" → golang, "be responsible" → backend). They stay in the NORMALIZER's
   * alias index (short CV-mention path, length-guarded) — ONLY the long-text gazetteer skips
   * them. Each owning skill still matches via an unambiguous surface (canonical/display or a
   * longer alias: nodejs, spring boot, restful api, golang, ...).
   */
  private static readonly GAZETTEER_DENYLIST = new Set([
    'cv',
    'be',
    'fe',
    'ts',
    'dl',
    'db',
    'ai',
    'qa',
    'go',
    'rest',
    'node',
    'spring',
  ]);

  /** Idempotent (re)build — callable directly by DB-less harnesses/tests after taxonomy init. */
  buildMatchers(): void {
    const seen = new Set<string>();
    this.matchers = [];
    for (const entry of this.taxonomy.getAll()) {
      const surfaces = [entry.canonical_name, entry.display_name, ...(entry.aliases ?? [])];
      for (const surface of surfaces) {
        const s = (surface ?? '').trim();
        if (s.length < 2) continue;
        if (SkillTextScannerService.GAZETTEER_DENYLIST.has(s.toLowerCase())) continue;
        const key = `${entry.canonical_name}|${s.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const letterOnly = /^[\p{L}]+$/u.test(s);
        const caseSensitive = s.length === 2 && letterOnly;
        // Boundaries: not preceded/followed by a letter or digit (Unicode-aware) — symbols
        // like '+', '#', '.', '/' count as boundaries so "C++", "C#", "Node.js" work.
        const escaped = s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // Canonical names use snake_case — match their spaced form too ("data_structures" → "data structures").
        let pattern = escaped.replace(/_/g, '[_ ]');
        if (caseSensitive) {
          // 2-char forms must appear CAPITALIZED in the text ("Go"/"GO") no matter how the
          // taxonomy writes the alias — lowercase prose ("we go fast") must never fire.
          const cap = s[0].toUpperCase() + s[1].toLowerCase();
          pattern = `(?:${cap}|${s.toUpperCase()})`;
        }
        this.matchers.push({
          canonical: entry.canonical_name,
          surface: s,
          regex: new RegExp(
            `(?<![\\p{L}\\p{N}])${pattern}(?![\\p{L}\\p{N}])`,
            caseSensitive ? 'gu' : 'giu',
          ),
        });
      }
    }
    this.logger.log(`Skill gazetteer built: ${this.matchers.length} surface-form matchers.`);
  }

  /**
   * Scan a document; returns one entry per DISTINCT canonical skill found,
   * with the longest matched surface form kept as evidence.
   */
  scan(text: string): ScannedSkill[] {
    if (!text || text.trim().length === 0) return [];
    if (this.matchers.length === 0) this.buildMatchers();

    const byCanonical = new Map<string, ScannedSkill>();
    for (const m of this.matchers) {
      m.regex.lastIndex = 0;
      const matches = text.match(m.regex);
      if (!matches || matches.length === 0) continue;
      const prev = byCanonical.get(m.canonical);
      if (!prev) {
        byCanonical.set(m.canonical, {
          canonical_name: m.canonical,
          matched_text: matches[0],
          occurrences: matches.length,
        });
      } else {
        prev.occurrences += matches.length;
        // Longer surface form = stronger evidence for audit display.
        if (matches[0].length > prev.matched_text.length) prev.matched_text = matches[0];
      }
    }
    return [...byCanonical.values()];
  }
}
