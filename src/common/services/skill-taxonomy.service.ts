import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

/**
 * One entry from `data/skills-pilot.json`. Matches the `skills` table schema
 * in skillbridge-mvp.dbml (canonical_name + display_name + aliases + source).
 */
export interface TaxonomyEntry {
  canonical_name: string;
  display_name: string;
  category?: string | null;
  source?: string | null;
  source_external_id?: string | null;
  aliases: string[];
}

/**
 * In-memory taxonomy cache.
 *
 * Pilot: loads `data/skills-pilot.json` at module init (the file is a copy
 * of the canonical FE seed file — see data/README.md).
 *
 * Production: this same service interface will be backed by an HTTP fetch
 * to `/internal/v1/skills/taxonomy` on the .NET service, refreshed every 1h.
 * Consumers (`SkillNormalizerService`, `SkillDiffService`, `CourseMatcherService`)
 * depend on this interface, not the data source.
 */
@Injectable()
export class SkillTaxonomyService implements OnModuleInit {
  private readonly logger = new Logger(SkillTaxonomyService.name);

  private entries: TaxonomyEntry[] = [];
  /** Lowercased normalized alias → canonical_name. Built once at init. */
  private aliasIndex: Map<string, string> = new Map();
  /** canonical_name → entry, for O(1) lookup. */
  private canonicalIndex: Map<string, TaxonomyEntry> = new Map();

  async onModuleInit(): Promise<void> {
    const filePath = path.join(process.cwd(), 'data', 'skills-pilot.json');
    if (!fs.existsSync(filePath)) {
      this.logger.warn(
        `Taxonomy file not found at ${filePath}. Skill normalization will fall through. ` +
          `This is expected in some test environments; in production .NET should serve taxonomy.`,
      );
      return;
    }

    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const json = JSON.parse(raw) as { skills: TaxonomyEntry[] };
      this.entries = json.skills ?? [];
      this.buildIndexes();
      this.logger.log(
        `Loaded ${this.entries.length} skills from taxonomy; alias index size ${this.aliasIndex.size}.`,
      );
    } catch (err) {
      this.logger.error(
        `Failed to load skills-pilot.json: ${(err as Error).message}. Taxonomy will be empty.`,
      );
    }
  }

  /**
   * Lowercase + strip punctuation/whitespace for alias lookup.
   * Examples:
   *   "React.js"     → "reactjs"
   *   "Node JS"      → "nodejs"
   *   "C#"           → "c#"  (preserves # since it's meaningful)
   *   "C++"          → "c++"
   *   "Tiếng Anh"    → "tiếng anh" → "tienganh" (after diacritics strip? we keep Vietnamese chars as-is)
   *
   * NOTE: We DO keep Vietnamese diacritics — the aliases array in skills-pilot.json
   * already covers VN variants, so direct lookup works.
   */
  static normalizeKey(input: string): string {
    return input
      .toLowerCase()
      .trim()
      .replace(/[\s\-_./]+/g, '') // drop spaces, dashes, underscores, dots, slashes
      .replace(/[()\[\]]/g, ''); // drop brackets
  }

  private buildIndexes(): void {
    this.aliasIndex.clear();
    this.canonicalIndex.clear();

    for (const entry of this.entries) {
      this.canonicalIndex.set(entry.canonical_name, entry);

      // Index the canonical_name itself as an alias (e.g. "react" → "react")
      this.aliasIndex.set(
        SkillTaxonomyService.normalizeKey(entry.canonical_name),
        entry.canonical_name,
      );
      // Index the display_name (e.g. "React" → "react")
      this.aliasIndex.set(
        SkillTaxonomyService.normalizeKey(entry.display_name),
        entry.canonical_name,
      );

      for (const alias of entry.aliases ?? []) {
        const key = SkillTaxonomyService.normalizeKey(alias);
        if (!this.aliasIndex.has(key)) {
          this.aliasIndex.set(key, entry.canonical_name);
        }
      }
    }
  }

  getAll(): TaxonomyEntry[] {
    return this.entries;
  }

  getByCanonical(canonicalName: string): TaxonomyEntry | undefined {
    return this.canonicalIndex.get(canonicalName);
  }

  /**
   * Look up by alias key. Returns canonical_name or undefined.
   * Used by SkillNormalizerService first-pass (exact + alias hit).
   */
  lookupByAliasKey(normalizedKey: string): string | undefined {
    return this.aliasIndex.get(normalizedKey);
  }

  /** Iterate all alias keys, used by fuzzy match in SkillNormalizerService. */
  iterateAliasEntries(): IterableIterator<[string, string]> {
    return this.aliasIndex.entries();
  }
}
