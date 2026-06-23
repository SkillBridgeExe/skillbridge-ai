// src/modules/cv-intake/intake-dates.ts
const MONTHS: Record<string, string> = {
  jan: '01',
  feb: '02',
  mar: '03',
  apr: '04',
  may: '05',
  jun: '06',
  jul: '07',
  aug: '08',
  sep: '09',
  oct: '10',
  nov: '11',
  dec: '12',
};
const ONGOING_RE = /\b(nay|hiện tại|hiện nay|present|current|now|đến nay)\b/iu;
// MM/YYYY, M/YYYY, MM-YYYY, "May 2023", or a bare YYYY.
const TOKEN_RE = /\b(\d{1,2})[/-](\d{4})\b|\b([a-zA-Z]{3,})\.?\s+(\d{4})\b|\b(\d{4})\b/gu;

export function parseDateRange(text: string): {
  start: string | null;
  end: string | null;
  ongoing: boolean;
} {
  const ongoing = ONGOING_RE.test(text);

  // Explicit dates (MM/YYYY or a real month name) are trustworthy; a bare 4-digit number is only a
  // year when no explicit date is present AND it falls in a plausible career range — so a stray count
  // ("2048 requests") or latency ("2000 ms") never becomes a date.
  const explicit: string[] = [];
  const bareYears: string[] = [];
  for (const m of text.matchAll(TOKEN_RE)) {
    if (m[1] && m[2]) {
      explicit.push(`${m[1].padStart(2, '0')}/${m[2]}`);
    } else if (m[3] && m[4]) {
      const mm = MONTHS[m[3].slice(0, 3).toLowerCase()];
      if (mm) explicit.push(`${mm}/${m[4]}`);
      else bareYears.push(m[4]); // a non-month word before a number → treat the number as a bare year
    } else if (m[5]) {
      bareYears.push(m[5]);
    }
  }

  const plausibleYears = bareYears.filter((y) => {
    const n = Number(y);
    return n >= 1950 && n <= 2035;
  });
  const tokens = explicit.length > 0 ? explicit : plausibleYears;

  const start = tokens[0] ?? null;
  const end = ongoing ? null : (tokens[1] ?? null);
  return { start, end, ongoing };
}
