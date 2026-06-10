import { assessTextQuality } from '../../src/common/services/text-quality';

const SHORT = { minMeaningfulTokens: 4, minMeaningfulChars: 25 };
const CV = { minMeaningfulTokens: 15, minMeaningfulChars: 80 };

describe('assessTextQuality (shared AI-input gate core)', () => {
  it('fails junk and thin inputs (rewrite thresholds)', () => {
    for (const bad of ['aa', 'AAA', 'aaaa aaaa', 'asdf asdf', 'lorem ipsum', '12 34 56']) {
      expect(assessTextQuality(bad, SHORT).ok).toBe(false);
    }
  });

  it('fails short repetitive spam via the unique-ratio rule', () => {
    expect(assessTextQuality('test test test', SHORT).ok).toBe(false);
    expect(assessTextQuality('react react react react', SHORT).ok).toBe(false);
  });

  it('does NOT apply the ratio rule to LONG real text (a full CV legitimately repeats words)', () => {
    // 30 tokens, only 9 unique (ratio 0.3) — would false-reject under an unbounded ratio rule.
    const longRepetitive = Array.from({ length: 10 }, () => 'phát triển hệ thống quản lý').join(
      ' và rồi ',
    );
    const v = assessTextQuality(longRepetitive, CV);
    expect(v.ok).toBe(true);
  });

  it('passes real CV-ish content at both threshold profiles', () => {
    expect(assessTextQuality('Built admin dashboard with React', SHORT).ok).toBe(true);
    expect(assessTextQuality('Xây dựng giỏ hàng với ReactJS, tăng chuyển đổi 12%', SHORT).ok).toBe(
      true,
    );
    const realCv =
      'Nguyễn Văn A — Frontend Developer. Kinh nghiệm: Thực tập sinh tại FPT Software, ' +
      'xây dựng giao diện quản trị với ReactJS và TypeScript, tối ưu hiệu năng render. ' +
      'Dự án: Web bán hàng EcomViet (React, Redux). Kỹ năng: HTML, CSS, JavaScript, Git.';
    expect(assessTextQuality(realCv, CV).ok).toBe(true);
  });

  it('fails OCR-noise / blank-scan style input at CV thresholds', () => {
    expect(assessTextQuality('', CV).ok).toBe(false);
    expect(assessTextQuality('l1 ll1l 0O0 . , -- ~', CV).ok).toBe(false);
    expect(assessTextQuality('CV của tôi', CV).ok).toBe(false); // 3 meaningful tokens — not a CV
  });

  it('reports counters for observability', () => {
    const v = assessTextQuality('Built dashboards with React', SHORT);
    expect(v.meaningful_tokens).toBe(4);
    expect(v.meaningful_chars).toBeGreaterThanOrEqual(24);
  });
});
