import {
  hasPlantedNumber,
  groundSmartQuestions,
} from '../../../src/modules/cv-assistant/cv-question-grounding';

describe('hasPlantedNumber', () => {
  it('flags a standalone number, ignores digits inside tech names', () => {
    expect(hasPlantedNumber('bạn đạt 30% cải thiện?')).toBe(true);
    expect(hasPlantedNumber('bạn dùng K8s hay ES6?')).toBe(false);
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
  it('returns null on non-object / empty questions (caller falls back)', () => {
    expect(groundSmartQuestions(null, ['tech'], 'vi')).toBeNull();
    expect(groundSmartQuestions({ questions: [] }, ['tech'], 'vi')).toBeNull();
  });
});
