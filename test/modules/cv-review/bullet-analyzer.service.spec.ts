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
});
