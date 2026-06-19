import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import type { CatalogCourse } from './course-matcher.service';
import {
  LearningResource,
  LearningResourceMatchResult,
  ResourceMatchRequest,
  ResourceSourceType,
  mapCourseToLearningResource,
  matchResources,
  mergeResourceCatalogs,
} from './learning-resource';

const SEED_VERIFIED_AT = '2026-06-10';

@Injectable()
export class LearningResourceMatcherService implements OnModuleInit {
  private readonly logger = new Logger(LearningResourceMatcherService.name);
  private catalog: LearningResource[] = [];

  async onModuleInit(): Promise<void> {
    const seed = this.readSeedCourses().map((course) =>
      mapCourseToLearningResource(course, SEED_VERIFIED_AT),
    );
    const explicit = this.readExplicitResources();
    this.catalog = mergeResourceCatalogs(seed, explicit, (id) =>
      this.logger.warn(
        `Duplicate resource id '${id}': learning-resource-catalog.json overrides the course-catalog.json seed.`,
      ),
    );
    this.logger.log(
      `Loaded ${this.catalog.length} learning resources (${seed.length} seed courses + ${explicit.length} explicit).`,
    );
  }

  setCatalogForTest(resources: LearningResource[]): void {
    this.catalog = resources;
  }

  matchResources(
    requests: ResourceMatchRequest[],
    opts?: { sourceTypes?: ResourceSourceType[] },
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
    if (!fs.existsSync(file)) {
      return [];
    }

    try {
      return (
        (JSON.parse(fs.readFileSync(file, 'utf-8')) as { resources?: LearningResource[] })
          .resources ?? []
      );
    } catch (err) {
      this.logger.error(
        `Failed to read learning-resource-catalog.json: ${(err as Error).message}.`,
      );
      return [];
    }
  }
}
