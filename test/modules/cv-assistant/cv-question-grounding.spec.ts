import {
  hasPlantedNumber,
  groundSmartQuestions,
} from '../../../src/modules/cv-assistant/cv-question-grounding';

describe('hasPlantedNumber', () => {
  it('flags a standalone number, ignores digits inside tech names', () => {
    expect(hasPlantedNumber('bạn đạt 30% cải thiện?')).toBe(true);
    expect(hasPlantedNumber('bạn dùng K8s hay ES6?')).toBe(false);
  });
  it('flags Nx multiplier-style boasts, exempts tech shorthand', () => {
    // FLAGGED: multipliers
    expect(hasPlantedNumber('5x')).toBe(true);
    expect(hasPlantedNumber('3x')).toBe(true);
    expect(hasPlantedNumber('10x nhanh hơn')).toBe(true);
    expect(hasPlantedNumber('cải thiện 5x')).toBe(true);
    expect(hasPlantedNumber('tăng 3x hiệu suất')).toBe(true);
    expect(hasPlantedNumber('tăng 10X')).toBe(true);
    // FLAGGED: reversed multipliers (Vietnamese "x2 doanh số" = doubled revenue)
    expect(hasPlantedNumber('x2')).toBe(true);
    expect(hasPlantedNumber('x10')).toBe(true);
    expect(hasPlantedNumber('x2 doanh số')).toBe(true);
    expect(hasPlantedNumber('X5 hiệu suất')).toBe(true);
    // FLAGGED: Nk/Nm/Nb magnitude boasts (most common fake-metric pattern)
    expect(hasPlantedNumber('10k')).toBe(true);
    expect(hasPlantedNumber('5m')).toBe(true);
    expect(hasPlantedNumber('2.5b')).toBe(true);
    expect(hasPlantedNumber('100K')).toBe(true);
    expect(hasPlantedNumber('10k users')).toBe(true);
    expect(hasPlantedNumber('tăng 5m requests')).toBe(true);
    expect(hasPlantedNumber('100k downloads')).toBe(true);
    expect(hasPlantedNumber('4k salary')).toBe(true);
    // FLAGGED: existing standalone numbers
    expect(hasPlantedNumber('30%')).toBe(true);
    expect(hasPlantedNumber('5000')).toBe(true);
    expect(hasPlantedNumber('3.5')).toBe(true);
    expect(hasPlantedNumber('1,000')).toBe(true);
    // FLAGGED trade-off: 4K/8K resolution now caught (asymmetry favors flagging — a
    // stripped chip just falls back to a generic prompt; missing "10k users" plants a lie)
    expect(hasPlantedNumber('4K')).toBe(true);
    expect(hasPlantedNumber('8K')).toBe(true);
    // NOT FLAGGED: tech shorthand/names + data units (letter follows the k/m/b)
    expect(hasPlantedNumber('K8s')).toBe(false);
    expect(hasPlantedNumber('ES6')).toBe(false);
    expect(hasPlantedNumber('Vue3')).toBe(false);
    expect(hasPlantedNumber('S3')).toBe(false);
    expect(hasPlantedNumber('gpt-4o')).toBe(false);
    expect(hasPlantedNumber('3D')).toBe(false);
    expect(hasPlantedNumber('2FA')).toBe(false);
    expect(hasPlantedNumber('10km')).toBe(false); // kilometer — k followed by m
    expect(hasPlantedNumber('5kb')).toBe(false); // data unit — letter follows
    expect(hasPlantedNumber('10mb')).toBe(false); // data unit — letter follows
    expect(hasPlantedNumber('1080p')).toBe(false);
    expect(hasPlantedNumber('h264')).toBe(false);
    expect(hasPlantedNumber('x')).toBe(false); // bare letter, no digit
  });
});

describe('groundSmartQuestions', () => {
  const raw = {
    already_strong: false,
    questions: [
      { gap: 'tech', prompt: 'Bạn dựng API bằng gì?', chips: ['Node', 'Java-Spring', 'SQL'] },
      {
        gap: 'result',
        prompt: 'Bạn xử lý ~5000 đơn/ngày?',
        chips: ['nhiều đơn hơn', '30% nhanh hơn'],
      },
      { gap: 'off_topic', prompt: 'Sở thích của bạn?', chips: ['đọc sách'] },
    ],
  };
  it('keeps role chips, strips planted numbers, drops off-taxonomy gaps', () => {
    const out = groundSmartQuestions(raw, ['tech', 'result'], 'vi')!;
    expect(out.already_strong).toBe(false);
    const gaps = out.questions.map((q) => q.gap);
    expect(gaps).toEqual(['tech', 'result']); // off_topic dropped
    const tech = out.questions.find((q) => q.gap === 'tech')!;
    expect(tech.options.map((o) => o.label)).toContain('Node');
    const result = out.questions.find((q) => q.gap === 'result')!;
    expect(result.prompt).not.toMatch(/5000/); // planted number stripped from prompt → fallback prompt
    expect(result.options.map((o) => o.label)).not.toContain('30% nhanh hơn'); // planted-number chip removed
    expect(result.options.map((o) => o.label)).toContain('nhiều đơn hơn');
  });
  it('returns null on non-object / empty-and-not-strong questions (caller falls back)', () => {
    expect(groundSmartQuestions(null, ['tech'], 'vi')).toBeNull();
    expect(groundSmartQuestions({ questions: [] }, ['tech'], 'vi')).toBeNull();
    expect(
      groundSmartQuestions({ already_strong: false, questions: [] }, ['tech'], 'vi'),
    ).toBeNull();
  });
  it('already_strong=true + empty questions → grounded empty result, NOT null (spec: honor the signal)', () => {
    const out = groundSmartQuestions({ already_strong: true, questions: [] }, ['tech'], 'vi');
    expect(out).toEqual({ questions: [], already_strong: true });
  });
});
