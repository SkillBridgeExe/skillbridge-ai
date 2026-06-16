import * as fs from 'fs';
import * as path from 'path';
import { SkillTaxonomyService } from '../../src/common/services/skill-taxonomy.service';

interface DetCase {
  id: string;
  lang: 'en' | 'vi' | 'mixed';
  target_role: string;
  category: 'fe' | 'be' | 'ai_app' | 'mobile' | 'off_topic' | 'bilingual';
  cv_text: string;
  jd_text: string;
  expected_cv_skills: string[];
  expected_jd_requirements: string[];
}

describe('eval-determinism-cases.json integrity', () => {
  const file = path.join(process.cwd(), 'data', 'eval-determinism-cases.json');
  const { cases } = JSON.parse(fs.readFileSync(file, 'utf-8')) as { cases: DetCase[] };
  const tax = new SkillTaxonomyService();
  beforeAll(async () => {
    await tax.onModuleInit();
  });

  it('has 6-8 cases with unique ids', () => {
    expect(cases.length).toBeGreaterThanOrEqual(6);
    expect(cases.length).toBeLessThanOrEqual(8);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
  });

  it('covers the required categories', () => {
    const cats = new Set(cases.map((c) => c.category));
    for (const need of ['fe', 'be', 'ai_app', 'mobile', 'off_topic', 'bilingual']) {
      expect(cats.has(need as DetCase['category'])).toBe(true);
    }
  });

  it('every expected skill resolves to a real taxonomy canonical', () => {
    const unresolved: string[] = [];
    for (const c of cases) {
      for (const s of [...c.expected_cv_skills, ...c.expected_jd_requirements]) {
        if (!tax.getByCanonical(s)) unresolved.push(`${c.id}: ${s}`);
      }
    }
    expect(unresolved).toEqual([]);
  });

  it('is PII-free (no emails / phone numbers in cv/jd text)', () => {
    const email = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
    const phone = /(?:\+?\d[\d\s().-]{7,}\d)/;
    const offenders: string[] = [];
    for (const c of cases) {
      if (email.test(c.cv_text + c.jd_text)) offenders.push(`${c.id} email`);
      if (phone.test(c.cv_text + c.jd_text)) offenders.push(`${c.id} phone`);
    }
    expect(offenders).toEqual([]);
  });
});
