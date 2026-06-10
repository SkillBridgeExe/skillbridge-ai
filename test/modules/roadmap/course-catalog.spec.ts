import * as fs from 'fs';
import * as path from 'path';
import { SkillTaxonomyService } from '../../../src/common/services/skill-taxonomy.service';
import { RoleRubricService } from '../../../src/common/services/role-rubric.service';
import { CatalogCourse } from '../../../src/modules/roadmap/course-matcher.service';

/**
 * Integrity gate for the CURATED course catalog (data/course-catalog.json).
 * Guards the dataset the same way skill-graph-edges/eval pairs are guarded:
 * every skill must resolve against the REAL taxonomy, enums/ranges must hold, and the
 * catalog must fully cover every role-rubric skill + every in_demand skill — so the
 * roadmap never silently returns empty courses for a common gap (audit P1, 2026-06-10).
 */
describe('course-catalog.json dataset integrity', () => {
  let courses: CatalogCourse[];
  let taxonomy: SkillTaxonomyService;
  let rubrics: RoleRubricService;

  beforeAll(async () => {
    const raw = fs.readFileSync(path.join(process.cwd(), 'data', 'course-catalog.json'), 'utf-8');
    courses = (JSON.parse(raw) as { courses: CatalogCourse[] }).courses;
    taxonomy = new SkillTaxonomyService();
    await taxonomy.onModuleInit();
    rubrics = new RoleRubricService();
    await rubrics.onModuleInit();
  });

  it('loads a non-trivial catalog', () => {
    expect(courses.length).toBeGreaterThanOrEqual(100);
  });

  it('every course field is valid (enums, ranges, https URLs, unique ids/urls)', () => {
    const ids = new Set<string>();
    const urls = new Set<string>();
    for (const c of courses) {
      expect(c.id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      expect(ids.has(c.id)).toBe(false);
      ids.add(c.id);
      expect(c.url).toMatch(/^https:\/\//);
      expect(urls.has(c.url)).toBe(false);
      urls.add(c.url);
      expect(['vi', 'en']).toContain(c.language);
      expect(['BEGINNER', 'INTERMEDIATE', 'ADVANCED']).toContain(c.difficulty);
      // Editorial reputation band (documented in the catalog _note) — NOT user reviews.
      expect(c.rating).toBeGreaterThanOrEqual(4.0);
      expect(c.rating).toBeLessThanOrEqual(4.8);
      expect(c.duration_minutes).toBeGreaterThan(0);
      expect(c.skills.length).toBeGreaterThan(0);
    }
  });

  it('every tagged skill resolves to a REAL taxonomy canonical with a sane level', () => {
    for (const c of courses) {
      for (const s of c.skills) {
        expect(taxonomy.getByCanonical(s.skill_canonical_name)).toBeTruthy();
        expect(s.teaches_level).toBeGreaterThanOrEqual(1);
        expect(s.teaches_level).toBeLessThanOrEqual(5);
      }
    }
  });

  it('covers 100% of role-rubric skills AND 100% of in_demand skills (roadmap never empty for common gaps)', () => {
    const covered = new Set<string>();
    for (const c of courses) for (const s of c.skills) covered.add(s.skill_canonical_name);

    const uncoveredRubric: string[] = [];
    for (const role of rubrics.listRoleCodes()) {
      for (const req of rubrics.getRubric(role)?.skills ?? []) {
        if (!covered.has(req.skill_canonical_name)) uncoveredRubric.push(req.skill_canonical_name);
      }
    }
    expect([...new Set(uncoveredRubric)]).toEqual([]);

    // in_demand is a raw dataset flag (not on the TaxonomyEntry type) — read it from the source file.
    const rawTax = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'data', 'skills-pilot.json'), 'utf-8'),
    ) as { skills: Array<{ canonical_name: string; in_demand?: boolean }> };
    const uncoveredInDemand = rawTax.skills
      .filter((s) => s.in_demand === true && !covered.has(s.canonical_name))
      .map((s) => s.canonical_name);
    expect(uncoveredInDemand).toEqual([]);
  });

  it('keeps a healthy free + Vietnamese share (catalog quality bars)', () => {
    const free = courses.filter((c) => c.is_free).length;
    expect(free / courses.length).toBeGreaterThanOrEqual(0.7); // free-first curation rule
    expect(courses.some((c) => c.language === 'vi')).toBe(true); // VN sources present (F8…)
  });
});
