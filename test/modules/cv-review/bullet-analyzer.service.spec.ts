import { BulletAnalyzerService } from '../../../src/modules/cv-review/bullet-analyzer.service';
import { CanonicalCvDocument, emptyCanonicalCv } from '../../../src/common/types/canonical-cv';

/**
 * Deterministic Dimension-1 scorer — anchor-based unit tests (no LLM, no quota).
 * Anchors seeded from the verbatim weak/strong examples in docs/cv-scoring-methodology.md.
 */
function docWith(bullets: string[], language = 'en'): CanonicalCvDocument {
  return {
    ...emptyCanonicalCv(language),
    experience: [{ org: 'Org', role: 'Role', start: null, end: null, location: null, bullets }],
  };
}

describe('BulletAnalyzerService', () => {
  const svc = new BulletAnalyzerService();

  it('scores a strong EN CV (verb-first + quantified) in the exemplary band', () => {
    const a = svc.analyze(
      docWith([
        'Led redesign of the checkout flow, cutting load time 40% for 50k users',
        'Built a reusable component library (20+ components) adopted by 3 product teams',
        'Implemented responsive layouts across 12 pages, raising Lighthouse from 72 to 96',
      ]),
    );
    expect(a.verbFirstRatio).toBe(1);
    expect(a.quantifiedRatio).toBe(1);
    expect(a.actionVerbsScore).toBe(20);
    expect(a.band).toBe('exemplary');
  });

  it('scores a weak EN CV ("Responsible for…", no metrics) in the beginning band', () => {
    const a = svc.analyze(
      docWith(['Responsible for the website', 'Worked on some tasks and helped the team']),
    );
    expect(a.verbFirstRatio).toBe(0);
    expect(a.quantifiedRatio).toBe(0);
    expect(a.weakOpenerRatio).toBe(1);
    expect(a.actionVerbsScore).toBeLessThanOrEqual(6);
    expect(a.band).toBe('beginning');
  });

  it('detects Vietnamese action verbs at the start of a bullet', () => {
    const a = svc.analyze(
      docWith(
        [
          'Phát triển REST API cho ứng dụng mobile',
          'Tối ưu thời gian tải, giảm 40% cho 50.000 người dùng',
        ],
        'vi',
      ),
    );
    expect(a.verbFirstRatio).toBe(1);
    expect(a.quantifiedRatio).toBeGreaterThanOrEqual(0.5);
    expect(a.actionVerbsScore).toBeGreaterThanOrEqual(15);
  });

  it('does NOT treat a bare 4-digit year as quantified impact', () => {
    const a = svc.analyze(docWith(['Joined the project in 2023 and attended meetings']));
    expect(a.quantifiedRatio).toBe(0);
  });

  it('recognizes varied quantified forms', () => {
    for (const bullet of [
      'Reduced API latency by 40%',
      'Saved the team $5000 per month',
      'Made the pipeline 3x faster',
      'Shipped 20+ features',
      'Served 50k users daily',
    ]) {
      const a = svc.analyze(docWith([bullet]));
      expect(a.quantifiedRatio).toBe(1);
    }
  });

  it('flags first-person and filler', () => {
    const a = svc.analyze(docWith(['I am a hardworking team player who worked on the app']));
    expect(a.firstPersonRatio).toBe(1);
    expect(a.fillerCount).toBeGreaterThanOrEqual(1);
  });

  it('harvests bullets from projects and activities, not just experience', () => {
    const doc: CanonicalCvDocument = {
      ...emptyCanonicalCv('en'),
      projects: [
        {
          name: 'P',
          role: null,
          tech: [],
          bullets: ['Built a CLI that cut build time 30%'],
          link: null,
        },
      ],
      activities: [
        { org: 'Club', role: null, bullets: ['Organized 5 workshops for 200 students'] },
      ],
    };
    const a = svc.analyze(doc);
    expect(a.bulletCount).toBe(2);
    expect(a.verbFirstRatio).toBe(1);
  });

  it('returns a safe beginning score when there are no bullets', () => {
    const a = svc.analyze(emptyCanonicalCv('en'));
    expect(a.bulletCount).toBe(0);
    expect(a.band).toBe('beginning');
    expect(a.actionVerbsScore).toBeLessThanOrEqual(3);
  });

  // ─── review fixes (N1 v2) ────────────────────────────────────────────────

  it('detects verb-first even when the opening verb has trailing punctuation', () => {
    const a = svc.analyze(
      docWith([
        'Designed, built and shipped a feature serving 50k users',
        'Led: the redesign, cutting latency 40%',
        'Optimized — queries, saving 30% of time',
      ]),
    );
    expect(a.verbFirstRatio).toBe(1);
  });

  it('detects common Vietnamese IT action verbs (fairness: VN CV not under-scored)', () => {
    const a = svc.analyze(
      docWith(
        [
          'Sử dụng React và TypeScript xây dựng dashboard cho 5000 người dùng',
          'Thực hiện tối ưu truy vấn, giảm 60% thời gian phản hồi',
          'Áp dụng CI/CD cho 3 dự án',
        ],
        'vi',
      ),
    );
    expect(a.verbFirstRatio).toBe(1);
    expect(a.actionVerbsScore).toBeGreaterThanOrEqual(15);
  });

  it('does NOT count a phone number as quantified impact', () => {
    const a = svc.analyze(docWith(['Contact me at 0987654321 regarding the position']));
    expect(a.quantifiedRatio).toBe(0);
  });

  it('counts a decimal percentage as quantified', () => {
    const a = svc.analyze(docWith(['Achieved 99.9% uptime across the cluster']));
    expect(a.quantifiedRatio).toBe(1);
  });

  it('treats VN passive "Được giao…" as weak but not "Đạt được…"', () => {
    const passive = svc.analyze(docWith(['Được giao nhiệm vụ kiểm thử ứng dụng'], 'vi'));
    expect(passive.weakOpenerRatio).toBe(1);
    expect(passive.verbFirstRatio).toBe(0);

    const strong = svc.analyze(docWith(['Đạt được kết quả tốt trong dự án nhóm'], 'vi'));
    expect(strong.weakOpenerRatio).toBe(0);
    expect(strong.verbFirstRatio).toBe(1);
  });

  // ─── review fixes (N1 v3 — from the 4-lens adversarial review) ───────────

  it('recognizes common IT verbs that were missing ("Set up", "Fixed", "Trained", "Tracked")', () => {
    // Mirrors the eval-devops regression: "Set up" must count, "Worked on"/"Helped" stay weak.
    const devops = svc.analyze(
      docWith([
        'Set up Docker containers for the backend services',
        'Worked on the CI pipeline with GitHub Actions',
        'Helped monitor servers and fixed deployment issues',
      ]),
    );
    expect(devops.verbFirstRatio).toBeCloseTo(1 / 3, 2);
    expect(devops.actionVerbsScore).toBeGreaterThanOrEqual(7);
    expect(devops.band).not.toBe('beginning');

    for (const v of [
      'Fixed the auth bug',
      'Trained a classifier',
      'Tracked issues in Jira',
      'Added a feature',
    ]) {
      expect(svc.analyze(docWith([v])).verbFirstRatio).toBe(1);
    }
  });

  it('detects a verb-first bullet even behind a numbered/lettered list marker', () => {
    const a = svc.analyze(
      docWith([
        '1. Led the redesign, cutting latency 40%',
        '(2) Designed the schema',
        'a) Built the API',
      ]),
    );
    expect(a.verbFirstRatio).toBe(1);
  });

  it('counts Vietnamese units ending in a diacritic as quantified ("giờ", "tỷ")', () => {
    expect(
      svc.analyze(docWith(['Tối ưu quy trình, tiết kiệm 200 giờ mỗi quý'], 'vi')).quantifiedRatio,
    ).toBe(1);
    expect(svc.analyze(docWith(['Tạo doanh thu 1 tỷ cho công ty'], 'vi')).quantifiedRatio).toBe(1);
  });

  it('still rejects a bare unit prefix of a longer word ("5 marketing" is NOT quantified)', () => {
    expect(svc.analyze(docWith(['Owned 5 marketing campaigns for the team'])).quantifiedRatio).toBe(
      0,
    );
  });

  it('does NOT flag English "em" (CSS unit) as first-person on an EN CV', () => {
    const a = svc.analyze(docWith(['Designed a system using REM and EM units across the app']));
    expect(a.firstPersonRatio).toBe(0);
  });

  // ─── review fixes (R1 hardening — 3-lens adversarial review) ─────────────

  it('counts gerund / present-participle openers as verb-first ("Building", "Leading", "Implementing")', () => {
    const a = svc.analyze(
      docWith([
        'Building scalable microservices for the platform',
        'Leading the migration to TypeScript',
        'Implementing OAuth2 across the app',
        'Optimizing slow queries and refactoring the auth module',
      ]),
    );
    expect(a.verbFirstRatio).toBe(1);
    expect(a.band).not.toBe('beginning');
  });

  it('counts single-digit / small-team metrics as quantified ("team of 5", "5 engineers", "5 juniors")', () => {
    expect(
      svc.analyze(docWith(['Led a team of 5 engineers on the checkout rewrite'])).quantifiedRatio,
    ).toBe(1);
    expect(
      svc.analyze(docWith(['Mentored 5 juniors during the internship program'])).quantifiedRatio,
    ).toBe(1);
    expect(svc.analyze(docWith(['Built a team of 4 to ship the MVP'])).quantifiedRatio).toBe(1);
  });

  it('VI "em"/"mình" only fire as a leading subject pronoun, not on mid-sentence English terms', () => {
    // Mid-sentence "EM" (Expectation-Maximization / CSS unit) inside a VI CV must NOT flag first-person.
    const clean = svc.analyze(docWith(['Triển khai mô hình EM cho 5 tập dữ liệu'], 'vi'));
    expect(clean.firstPersonRatio).toBe(0);
    // A genuine leading first-person pronoun still IS flagged.
    const fp = svc.analyze(docWith(['Em phát triển hệ thống cho 5000 người dùng'], 'vi'));
    expect(fp.firstPersonRatio).toBe(1);
  });

  // ─── analyzeBullets — per-bullet deterministic feedback (Task 2) ─────────

  it('analyzeBullets flags a weak-opener bullet with a tip + section', () => {
    const doc = docWith(['Responsible for fixing bugs'], 'en');
    const out = svc.analyzeBullets(doc);
    expect(out).toHaveLength(1);
    expect(out[0].section).toBe('experience');
    expect(out[0].weakOpener).toBe(true);
    expect(out[0].tips.length).toBeGreaterThan(0);
  });

  it('analyzeBullets returns [] when there are no bullets', () => {
    const doc = { ...emptyCanonicalCv('en') };
    expect(svc.analyzeBullets(doc)).toEqual([]);
  });

  it('band aligns with methodology: ≥80% verb-first reaches exemplary ONLY at ≥50% quantified', () => {
    const lowQuant = svc.analyze(
      docWith([
        'Built the onboarding screen',
        'Designed the data model',
        'Refactored the auth module',
        'Reduced API latency by 40%', // 1/4 quantified = 0.25
      ]),
    );
    expect(lowQuant.verbFirstRatio).toBe(1);
    expect(lowQuant.quantifiedRatio).toBe(0.25);
    expect(lowQuant.actionVerbsScore).toBe(17); // base 15 + bonus 2 — NOT exemplary
    expect(lowQuant.band).toBe('accomplished');

    const highQuant = svc.analyze(
      docWith([
        'Built the onboarding screen for 2000 users',
        'Designed the data model cutting query time 30%',
        'Refactored the auth module',
        'Reduced API latency by 40%', // 3/4 quantified ≥ 0.5
      ]),
    );
    expect(highQuant.quantifiedRatio).toBeGreaterThanOrEqual(0.5);
    expect(highQuant.actionVerbsScore).toBe(20);
    expect(highQuant.band).toBe('exemplary');
  });
});
