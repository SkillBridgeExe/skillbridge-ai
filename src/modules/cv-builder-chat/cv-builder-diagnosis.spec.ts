import {
  stripDigitRuns,
  buildDiagnosisChatBlock,
  diagnosisProseLicense,
  CvBuilderDiagnosisBlock,
} from './cv-builder-diagnosis';
import type { CvReviewParsedResponse } from '../cv-review/dto/cv-review-response.dto';

describe('stripDigitRuns', () => {
  it('removes an ASCII percentage run, collapsing the whitespace left behind', () => {
    expect(stripDigitRuns('tăng 40% doanh thu')).toBe('tăng doanh thu');
  });

  it('removes a standalone score number ("5 điểm" → "điểm")', () => {
    expect(stripDigitRuns('5 điểm')).toBe('điểm');
  });

  it('removes a decimal scale run ("3.5/5")', () => {
    expect(stripDigitRuns('bạn đạt 3.5/5 điểm')).toBe('bạn đạt điểm');
  });

  it('removes non-ASCII Arabic-Indic digits — fail-closed on \\p{Nd}', () => {
    expect(stripDigitRuns('٤٠')).toBe('');
    expect(stripDigitRuns('giảm ٤٠ phút')).toBe('giảm phút');
  });

  it('leaves digit-free prose untouched', () => {
    expect(stripDigitRuns('Mở đầu bằng động từ hành động')).toBe('Mở đầu bằng động từ hành động');
  });
});

const makeReview = (over: Partial<CvReviewParsedResponse> = {}): CvReviewParsedResponse =>
  ({
    rationale: {
      action_verbs: 'Nhiều bullet mở đầu yếu, thiếu động từ hành động',
      skills_relevance: '',
      experience: 'Kinh nghiệm chung chung, thiếu kết quả đo được như tăng 40% doanh thu',
      education: '',
    },
    top_summary: {
      headline: 'x',
      prioritized_actions: [
        'Thêm số liệu 40% vào bullet',
        'Dùng động từ mạnh hơn',
        'Bỏ đại từ nhân xưng',
        'Hành động thứ 4 phải bị cắt',
      ],
    },
    bullet_feedback: [
      {
        text: 'Làm việc với team 5 người phát triển web',
        section: 'experience',
        tips: ['Mở đầu bằng động từ hành động', 'Thêm kết quả đo được'],
      },
      { text: 'Bullet không có tip', section: 'projects', tips: [] },
    ],
    ...over,
  }) as unknown as CvReviewParsedResponse;

describe('buildDiagnosisChatBlock', () => {
  it('returns null for a null review', () => {
    expect(buildDiagnosisChatBlock(null)).toBeNull();
  });

  it('caps prioritized_actions at 3, digit-stripped and verbatim otherwise', () => {
    const b = buildDiagnosisChatBlock(makeReview())!;
    expect(b.prioritized_actions).toHaveLength(3);
    expect(b.prioritized_actions[0]).toBe('Thêm số liệu vào bullet');
    expect(b.prioritized_actions.join(' ')).not.toMatch(/\p{Nd}/u);
  });

  it('keeps only non-empty rationale dimensions, digit-stripped verbatim', () => {
    const b = buildDiagnosisChatBlock(makeReview())!;
    const dims = b.dimension_notes.map((d) => d.dimension);
    expect(dims).toContain('action_verbs');
    expect(dims).toContain('experience');
    expect(dims).not.toContain('skills_relevance'); // empty → dropped
    expect(dims).not.toContain('education'); // empty → dropped
    const exp = b.dimension_notes.find((d) => d.dimension === 'experience')!;
    expect(exp.note).not.toMatch(/\p{Nd}/u);
    expect(exp.note).toContain('kết quả đo được'); // verbatim minus digits
  });

  it('drops bullets without tips and strips digits from excerpt + tips', () => {
    const b = buildDiagnosisChatBlock(makeReview())!;
    expect(b.bullet_notes).toHaveLength(1);
    expect(b.bullet_notes[0].excerpt).toBe('Làm việc với team người phát triển web');
    expect(b.bullet_notes[0].tips).toEqual([
      'Mở đầu bằng động từ hành động',
      'Thêm kết quả đo được',
    ]);
  });

  it('caps bullet_notes at 5', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      text: `bullet ${i}`,
      section: 'experience',
      tips: ['một tip'],
    }));
    const b = buildDiagnosisChatBlock(makeReview({ bullet_feedback: many as never }))!;
    expect(b.bullet_notes).toHaveLength(5);
  });

  it('truncates an excerpt to 120 chars', () => {
    const long = 'a'.repeat(200);
    const b = buildDiagnosisChatBlock(
      makeReview({
        bullet_feedback: [{ text: long, section: 'experience', tips: ['t'] }] as never,
      }),
    )!;
    expect(b.bullet_notes[0].excerpt.length).toBe(120);
  });
});

describe('diagnosisProseLicense', () => {
  it('returns empty string for a null block', () => {
    expect(diagnosisProseLicense(null)).toBe('');
  });

  it('joins every string in the block with spaces (prose-only corpus)', () => {
    const block: CvBuilderDiagnosisBlock = {
      prioritized_actions: ['Thêm số liệu'],
      dimension_notes: [{ dimension: 'experience', note: 'thiếu kết quả' }],
      bullet_notes: [{ excerpt: 'Làm việc với team', tips: ['Mở đầu bằng động từ'] }],
    };
    const s = diagnosisProseLicense(block);
    expect(s).toContain('Thêm số liệu');
    expect(s).toContain('thiếu kết quả');
    expect(s).toContain('Làm việc với team');
    expect(s).toContain('Mở đầu bằng động từ');
  });
});
