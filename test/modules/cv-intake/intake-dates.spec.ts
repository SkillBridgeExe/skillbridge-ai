// test/modules/cv-intake/intake-dates.spec.ts
import { parseDateRange } from '../../../src/modules/cv-intake/intake-dates';
describe('parseDateRange', () => {
  it("parses 'từ 05/2023 tới nay' → 05/2023 + ongoing", () => {
    expect(parseDateRange('từ 05/2023 tới nay')).toEqual({
      start: '05/2023',
      end: null,
      ongoing: true,
    });
  });
  it("parses 'May 2023 - Dec 2024'", () => {
    expect(parseDateRange('May 2023 - Dec 2024')).toEqual({
      start: '05/2023',
      end: '12/2024',
      ongoing: false,
    });
  });
  it("parses bare years '2021–2023'", () => {
    expect(parseDateRange('2021–2023')).toEqual({ start: '2021', end: '2023', ongoing: false });
  });
  it('no dates → nulls', () => {
    expect(parseDateRange('built a chatbot')).toEqual({ start: null, end: null, ongoing: false });
  });
});
