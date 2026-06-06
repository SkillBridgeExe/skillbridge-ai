import { SkillTaxonomyService } from '../../../src/common/services/skill-taxonomy.service';
import { RoleRubricService } from '../../../src/common/services/role-rubric.service';
import { BulletAnalyzerService } from '../../../src/modules/cv-review/bullet-analyzer.service';
import { SectionEvaluatorService } from '../../../src/modules/cv-builder/section-evaluator.service';
import { EvaluateSectionRequestDto } from '../../../src/modules/cv-builder/dto/evaluate-section.dto';

describe('SectionEvaluatorService (deterministic, DB-less)', () => {
  let svc: SectionEvaluatorService;

  beforeAll(async () => {
    const taxonomy = new SkillTaxonomyService();
    await taxonomy.onModuleInit();
    const rubrics = new RoleRubricService();
    await rubrics.onModuleInit();
    svc = new SectionEvaluatorService(new BulletAnalyzerService(), rubrics, taxonomy);
  });

  const flags = (req: EvaluateSectionRequestDto): Record<string, boolean> =>
    Object.fromEntries(svc.evaluate(req).checklist.map((c) => [c.id, c.pass]));

  it('empty section → score 0, label "Chưa có thông tin"', () => {
    const res = svc.evaluate({ section: 'summary', language: 'vi', content: { summary: '' } });
    expect(res.score).toBe(0);
    expect(res.label).toBe('Chưa có thông tin');
    expect(res.missing.length).toBeGreaterThan(0);
  });

  it('score = round(passed/total × 100) and is reproducible', () => {
    const req: EvaluateSectionRequestDto = {
      section: 'experience',
      language: 'en',
      content: {
        entries: [
          {
            position: 'Backend Developer',
            company: 'FPT',
            startDate: '01/2024',
            isCurrent: true,
            description: 'Built REST APIs with Node.js, cutting latency 40%.',
          },
        ],
      } as never,
    };
    const a = svc.evaluate(req);
    const b = svc.evaluate(req);
    expect(a).toEqual(b); // deterministic
    const passed = a.checklist.filter((c) => c.pass).length;
    expect(a.score).toBe(Math.round((passed / a.checklist.length) * 100));
  });

  it('experience: strong bullet passes verb-first + quantified', () => {
    const f = flags({
      section: 'experience',
      language: 'en',
      content: {
        entries: [
          {
            position: 'Dev',
            company: 'X',
            startDate: '01/2024',
            isCurrent: true,
            description: 'Optimized the pipeline, reducing build time by 30%.',
          },
        ],
      } as never,
    });
    expect(f.exp_verb_first).toBe(true);
    expect(f.exp_quantified).toBe(true);
  });

  it('experience: weak/passive opener fails verb-first', () => {
    const f = flags({
      section: 'experience',
      language: 'en',
      content: {
        entries: [
          {
            position: 'Intern',
            company: 'X',
            startDate: '01/2024',
            description: 'Responsible for testing the application.',
          },
        ],
      } as never,
    });
    expect(f.exp_verb_first).toBe(false);
  });

  it('experience: detects reverse-chronological violation', () => {
    const f = flags({
      section: 'experience',
      language: 'en',
      content: {
        entries: [
          {
            position: 'Old',
            company: 'A',
            startDate: '01/2020',
            endDate: '12/2020',
            description: 'Did stuff.',
          },
          {
            position: 'New',
            company: 'B',
            startDate: '01/2024',
            isCurrent: true,
            description: 'Led things.',
          },
        ],
      } as never,
    });
    expect(f.exp_reverse_chrono).toBe(false);
  });

  it('basic: unprofessional email fails', () => {
    const f = flags({
      section: 'basic',
      language: 'vi',
      content: {
        fullName: 'A B',
        email: 'cutebaby@gmail.com',
        phone: '0900000000',
        location: 'HCM',
      },
    });
    expect(f.basic_email_pro).toBe(false);
    expect(f.basic_core).toBe(true);
  });

  it('reverse-chrono: newest entry with blank date (still editing) does NOT falsely fail', () => {
    const f = flags({
      section: 'experience',
      language: 'en',
      content: {
        entries: [
          { position: 'Backend Dev', company: 'New', description: 'Built services.' }, // no date yet
          {
            position: 'Old',
            company: 'A',
            startDate: '01/2020',
            endDate: '12/2020',
            description: 'Did work.',
          },
        ],
      } as never,
    });
    expect(f.exp_reverse_chrono).toBe(true);
  });

  it('gpa 10/10 is recognized as strong (regression: single-digit parse)', () => {
    const f = flags({
      section: 'education',
      language: 'en',
      content: {
        entries: [{ school: 'X', major: 'CS', startYear: '2021', endYear: '2025', gpa: '10/10' }],
      } as never,
    });
    expect(f.edu_gpa).toBe(true);
  });

  it('skills with ONLY languages → empty (score 0), not vacuous 67%', () => {
    const res = svc.evaluate({
      section: 'skills',
      language: 'en',
      content: { languages: ['English', 'Vietnamese'] } as never,
    });
    expect(res.score).toBe(0);
  });

  it('experience: bullets in responsibilities/achievements are scored (not just description)', () => {
    const f = flags({
      section: 'experience',
      language: 'en',
      content: {
        entries: [
          {
            position: 'Dev',
            company: 'X',
            startDate: '01/2024',
            responsibilities: 'Optimized the API, reducing latency by 50%.',
          },
        ],
      } as never,
    });
    expect(f.exp_verb_first).toBe(true);
    expect(f.exp_quantified).toBe(true);
  });

  it('inline-bulleted single line splits into multiple bullets', () => {
    const f = flags({
      section: 'experience',
      language: 'en',
      content: {
        entries: [
          {
            position: 'Dev',
            company: 'X',
            startDate: '01/2024',
            description: '• Built API • Optimized DB • Led team of 3',
          },
        ],
      } as never,
    });
    expect(f.exp_verb_first).toBe(true);
  });

  it('non-empty section that fails everything → "Cần cải thiện", not "Chưa có thông tin"', () => {
    const res = svc.evaluate({
      section: 'summary',
      // short + first-person + filler + double-space/"!!" typos → all 5 criteria fail → score 0
      language: 'vi',
      content: { summary: 'tôi  nhiệt tình!!' } as never,
    });
    expect(res.score).toBe(0);
    expect(res.label).toBe('Cần cải thiện'); // nonEmpty floor, NOT "Chưa có thông tin"
  });

  it('skills: role-rubric gap surfaces missing in-demand skills', () => {
    const res = svc.evaluate({
      section: 'skills',
      language: 'en',
      role_code: 'frontend_developer',
      content: { technicalSkills: ['Python'] } as never,
    });
    expect(res.missing.some((m) => /usually also expects/i.test(m))).toBe(true);
  });
});
