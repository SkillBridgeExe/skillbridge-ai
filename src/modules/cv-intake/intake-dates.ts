// src/modules/cv-intake/intake-dates.ts
const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};
const ONGOING_RE = /\b(nay|hiện tại|hiện nay|present|current|now|đến nay)\b/iu;
// MM/YYYY, M/YYYY, MM-YYYY, "May 2023", or a bare YYYY.
const TOKEN_RE = /\b(\d{1,2})[/-](\d{4})\b|\b([a-zA-Z]{3,})\.?\s+(\d{4})\b|\b(\d{4})\b/gu;

function normalize(m: RegExpMatchArray): string {
  if (m[1] && m[2]) return `${m[1].padStart(2, "0")}/${m[2]}`;
  if (m[3] && m[4]) {
    const mm = MONTHS[m[3].slice(0, 3).toLowerCase()];
    return mm ? `${mm}/${m[4]}` : m[4];
  }
  return m[5]; // bare year
}

export function parseDateRange(text: string): { start: string | null; end: string | null; ongoing: boolean } {
  const ongoing = ONGOING_RE.test(text);
  const tokens = [...text.matchAll(TOKEN_RE)].map(normalize).filter(Boolean);
  const start = tokens[0] ?? null;
  const end = ongoing ? null : (tokens[1] ?? null);
  return { start, end, ongoing };
}
