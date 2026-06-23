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

  // Issue #2: a stray 4-digit number must NOT become a date when explicit MM/YYYY / month-name exist.
  it('ignores a stray 4-digit count when explicit MM/YYYY dates exist', () => {
    expect(parseDateRange('handling 2048 requests at TechCorp from 05/2023 to 06/2024')).toEqual({
      start: '05/2023',
      end: '06/2024',
      ongoing: false,
    });
  });
  it('prefers month-name dates over stray latency numbers', () => {
    expect(parseDateRange('reduced from 1500 to 2000 ms, May 2023 - Jun 2024')).toEqual({
      start: '05/2023',
      end: '06/2024',
      ongoing: false,
    });
  });
  it('ignores a graduation year, takes the MM/YYYY job range', () => {
    expect(parseDateRange('graduated in 2019, then joined in 03/2021 until 12/2022')).toEqual({
      start: '03/2021',
      end: '12/2022',
      ongoing: false,
    });
  });

  // An out-of-range month (13/2023, 00/2023) is a typo, not a date — salvage the year as a bare year
  // instead of emitting a bogus "13/2023" with high confidence.
  it('rejects an invalid month and salvages the year', () => {
    expect(parseDateRange('dự án từ 13/2023')).toEqual({
      start: '2023',
      end: null,
      ongoing: false,
    });
    expect(parseDateRange('00/2023')).toEqual({ start: '2023', end: null, ongoing: false });
  });

  it('rejects an out-of-range bare year and accepts the boundary', () => {
    expect(parseDateRange('làm năm 2036').start).toBeNull(); // > 2035 → not a plausible career year
    expect(parseDateRange('làm năm 1949').start).toBeNull(); // < 1950
    expect(parseDateRange('làm năm 2035')).toEqual({ start: '2035', end: null, ongoing: false });
  });

  it('takes the first date range from a multi-entry story (one entry by design)', () => {
    expect(parseDateRange('Job A 01/2020 - 12/2021, then Job B 01/2022 - 12/2023')).toEqual({
      start: '01/2020',
      end: '12/2021',
      ongoing: false,
    });
  });
});
