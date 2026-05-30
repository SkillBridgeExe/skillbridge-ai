import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

export type Importance = 'REQUIRED' | 'PREFERRED' | 'NICE_TO_HAVE';

export interface RoleSkillRequirement {
  skill_canonical_name: string;
  required_level: number; // 1-5
  importance: Importance;
  weight: number; // 0-1, sum per role ≈ 1.00
}

export interface RoleRubric {
  role_code: string;
  display_name_vi: string;
  display_name_en: string;
  description: string;
  skills: RoleSkillRequirement[];
}

/**
 * In-memory cache of role rubrics loaded from `data/role-rubrics-pilot.json`.
 *
 * A "rubric" is the answer to: what skills (and at what level) does a person
 * need to be considered a "Frontend Developer" / "Data Analyst" / etc.?
 *
 * Pilot ships 5 rubrics. Production goal: 50 industries via HR expert curation
 * (see budget item in CONTEXT.md, 20h × 300k/h).
 *
 * Used by:
 *   - SkillDiffService — to compute matched/missing/partial skills
 *   - RoadmapService   — to prioritize missing skills by weight
 *   - CourseMatcherService — to weight courses against gap importance
 */
@Injectable()
export class RoleRubricService implements OnModuleInit {
  private readonly logger = new Logger(RoleRubricService.name);

  private rubrics: Map<string, RoleRubric> = new Map();

  async onModuleInit(): Promise<void> {
    const filePath = path.join(process.cwd(), 'data', 'role-rubrics-pilot.json');
    if (!fs.existsSync(filePath)) {
      this.logger.warn(
        `Role rubrics file not found at ${filePath}. Roadmap/match will degrade gracefully ` +
          `(empty required-skill list ⇒ match score driven entirely by JD extraction).`,
      );
      return;
    }

    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const json = JSON.parse(raw) as {
        role_rubrics: Record<string, Omit<RoleRubric, 'role_code'>>;
      };
      const rubricsMap = json.role_rubrics ?? {};

      for (const [roleCode, payload] of Object.entries(rubricsMap)) {
        this.rubrics.set(roleCode, { role_code: roleCode, ...payload });
      }

      this.logger.log(
        `Loaded ${this.rubrics.size} role rubrics: ${[...this.rubrics.keys()].join(', ')}`,
      );
      this.validateRubrics();
    } catch (err) {
      this.logger.error(
        `Failed to load role-rubrics-pilot.json: ${(err as Error).message}. Rubrics will be empty.`,
      );
    }
  }

  /**
   * Validate weight sums + level ranges. Logs warnings but does not throw —
   * pilot data is hand-curated, we tolerate small drift.
   */
  private validateRubrics(): void {
    for (const [roleCode, rubric] of this.rubrics.entries()) {
      if (rubric.skills.length < 8) {
        this.logger.warn(
          `Rubric "${roleCode}" has only ${rubric.skills.length} skills (<8). Scoring will be coarse.`,
        );
      }
      const weightSum = rubric.skills.reduce((s, r) => s + r.weight, 0);
      if (weightSum < 0.95 || weightSum > 1.05) {
        this.logger.warn(
          `Rubric "${roleCode}" weight sum = ${weightSum.toFixed(3)} (expected 0.95-1.05).`,
        );
      }
      for (const req of rubric.skills) {
        if (req.required_level < 1 || req.required_level > 5) {
          this.logger.warn(
            `Rubric "${roleCode}" skill "${req.skill_canonical_name}" has invalid level ${req.required_level} (must be 1-5).`,
          );
        }
      }
    }
  }

  getRubric(roleCode: string): RoleRubric | null {
    return this.rubrics.get(roleCode) ?? null;
  }

  listRoleCodes(): string[] {
    return [...this.rubrics.keys()];
  }

  listRubrics(): RoleRubric[] {
    return [...this.rubrics.values()];
  }
}
