import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { CatalogCourse } from './course-matcher.service';
import {
  LanguagePref,
  LearningResource,
  LearningResourceMatchResult,
  ResourceMatchRequest,
  ResourceSourceType,
  coerceLearningResources,
  mapCourseToLearningResource,
  matchResources,
  mergeResourceCatalogs,
} from './learning-resource';

/** Curation date of the seed course-catalog.json (see its `_note`). Deterministic — no runtime clock. */
const SEED_VERIFIED_AT = '2026-06-10';

/**
 * Loads the unified learning-resource catalog (course-catalog.json seed mapped to LearningResource,
 * merged with explicit learning-resource-catalog.json — duplicate id overrides the seed) and matches
 * resources to skills deterministically via the pure matcher. Replaces direct catalog ownership; the
 * CourseMatcher wrapper delegates here for source_type='course'.
 */
@Injectable()
export class LearningResourceMatcherService implements OnModuleInit {
  private readonly logger = new Logger(LearningResourceMatcherService.name);
  private catalog: LearningResource[] = [];

  onModuleInit(): void {
    const seed = this.readSeedCourses().map((c) =>
      mapCourseToLearningResource(c, SEED_VERIFIED_AT),
    );
    const explicit = this.readExplicitResources();
    this.catalog = mergeResourceCatalogs(seed, explicit, (id) =>
      this.logger.warn(
        `Duplicate resource id '${id}' — learning-resource-catalog.json overrides the course-catalog.json seed.`,
      ),
    );
    this.logger.log(
      `Loaded ${this.catalog.length} learning resources (${seed.length} seed courses + ${explicit.length} explicit).`,
    );
  }

  /** Test seam: inject a catalog without file IO. */
  setCatalogForTest(resources: LearningResource[]): void {
    this.catalog = resources;
  }

  /** Read-only view of the loaded catalog (for the retriever's sparse lane + metadata resolve). */
  allResources(): LearningResource[] {
    return this.catalog;
  }

  matchResources(
    requests: ResourceMatchRequest[],
    opts?: { sourceTypes?: ResourceSourceType[]; langPref?: LanguagePref },
  ): LearningResourceMatchResult {
    return matchResources(this.catalog, requests, opts);
  }

  private readSeedCourses(): CatalogCourse[] {
    const file = path.join(process.cwd(), 'data', 'course-catalog.json');
    if (!fs.existsSync(file)) {
      this.logger.warn(`Seed course catalog not found at ${file}.`);
      return [];
    }
    try {
      return (
        (JSON.parse(fs.readFileSync(file, 'utf-8')) as { courses?: CatalogCourse[] }).courses ?? []
      );
    } catch (err) {
      this.logger.error(`Failed to read course-catalog.json: ${(err as Error).message}.`);
      return [];
    }
  }

  private readExplicitResources(): LearningResource[] {
    const file = path.join(process.cwd(), 'data', 'learning-resource-catalog.json');
    if (!fs.existsSync(file)) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as { resources?: unknown };
      // Validate the hand-curated explicit catalog — invalid entries are dropped + warned, never matched.
      return coerceLearningResources(parsed.resources, (reason) =>
        this.logger.warn(`Dropping invalid explicit learning resource — ${reason}.`),
      );
    } catch (err) {
      this.logger.error(
        `Failed to read learning-resource-catalog.json: ${(err as Error).message}.`,
      );
      return [];
    }
  }
}
