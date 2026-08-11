/**
 * Small, deterministic helpers for the platform interview context.
 *
 * The interviewer may phrase questions, but it must not invent the candidate's name or the
 * employer. These helpers deliberately accept unknown JSON because JD extraction is an untrusted
 * boundary and its parsed shape is not a stable public contract yet.
 */

export type InterviewEmployerSource = 'jd' | 'unknown';

export interface InterviewIdentity {
  candidateName: string | null;
  employerName: string | null;
  jobTitle: string;
  employerSource: InterviewEmployerSource;
}

export interface InterviewIdentityInput {
  cv?: {
    parsedJson?: unknown;
    parsedText?: string | null;
    targetRole?: string | null;
    title?: string | null;
  } | null;
  jd?: {
    title?: string | null;
    rawText?: string | null;
    parsedJson?: unknown;
  } | null;
  targetRole?: string | null;
}

const EMPLOYER_KEYS = [
  'company',
  'company_name',
  'companyName',
  'employer',
  'employer_name',
  'employerName',
  'organization',
  'organisation',
] as const;

const EXPLICIT_EMPLOYER_LINE =
  /^\s*(?:company|employer|organization|organisation|công ty|doanh nghiệp)\s*[:\-]\s*(.+?)\s*$/imu;
const EXPLICIT_CANDIDATE_LINE =
  /^\s*(?:name|full\s+name|candidate|họ\s+tên|họ\s+và\s+tên)\s*[:\-]\s*(.+?)\s*$/imu;
const TITLE_EMPLOYER_PATTERN = /^(.+?)\s+(?:at|@)\s+([^|,]+?)\s*$/i;

function cleanAtom(value: unknown, maxLength = 160): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;
  return (
    cleaned
      .replace(/^['"“”]+|['"“”]+$/g, '')
      .trim()
      .slice(0, maxLength) || null
  );
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readNamedValue(value: unknown, keys: readonly string[]): string | null {
  const object = record(value);
  if (!object) return null;
  for (const key of keys) {
    const direct = cleanAtom(object[key]);
    if (direct) return direct;
    const nested = record(object[key]);
    const nestedName = nested ? cleanAtom(nested.name ?? nested.value) : null;
    if (nestedName) return nestedName;
  }
  return null;
}

function candidateNameFromCv(parsedJson: unknown, parsedText?: string | null): string | null {
  const root = record(parsedJson);
  const contact = root ? record(root.contact) : null;
  const structuredName = cleanAtom(contact?.name ?? (root ? root.name : null));
  if (structuredName) return structuredName;
  return cleanAtom(parsedText?.match(EXPLICIT_CANDIDATE_LINE)?.[1]);
}

function employerFromJd(jd: InterviewIdentityInput['jd']): string | null {
  if (!jd) return null;

  const structured = readNamedValue(jd.parsedJson, EMPLOYER_KEYS);
  if (structured) return structured;

  const labelled = jd.rawText?.match(EXPLICIT_EMPLOYER_LINE)?.[1];
  const labelledEmployer = cleanAtom(labelled);
  if (labelledEmployer) return labelledEmployer;

  const title = cleanAtom(jd.title);
  const titleEmployer = title?.match(TITLE_EMPLOYER_PATTERN)?.[2];
  return cleanAtom(titleEmployer);
}

function titleWithoutEmployer(title: string | null): string | null {
  const cleaned = cleanAtom(title);
  if (!cleaned) return null;
  return cleanAtom(cleaned.match(TITLE_EMPLOYER_PATTERN)?.[1] ?? cleaned);
}

function displayRole(value: string | null | undefined): string | null {
  const cleaned = cleanAtom(value);
  if (!cleaned) return null;
  return cleaned
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function resolveInterviewIdentity(input: InterviewIdentityInput): InterviewIdentity {
  const jdTitle = titleWithoutEmployer(input.jd?.title ?? null);
  const targetRole = displayRole(input.targetRole);
  const cvRole = displayRole(input.cv?.targetRole);
  const cvTitle = displayRole(input.cv?.title);
  const jobTitle = jdTitle ?? targetRole ?? cvRole ?? cvTitle ?? 'the target role';
  const employerName = employerFromJd(input.jd);

  return {
    candidateName: candidateNameFromCv(input.cv?.parsedJson, input.cv?.parsedText),
    employerName,
    jobTitle,
    employerSource: employerName ? 'jd' : 'unknown',
  };
}

export function buildInterviewOpening(
  identity: InterviewIdentity,
  language: 'vi' | 'en',
  contextMode: 'ROLE_ONLY' | 'CV_ONLY' | 'CV_JD_MATCH',
): string {
  const candidate = identity.candidateName ?? (language === 'vi' ? 'bạn' : 'there');
  if (language === 'en') {
    if (contextMode === 'CV_JD_MATCH' && identity.employerName) {
      return `Hello ${candidate}, I am the HR AI interviewer for ${identity.employerName} for the ${identity.jobTitle} role. We will go through your experience, the role requirements, and a few realistic scenarios; let us begin.`;
    }
    if (contextMode === 'CV_JD_MATCH') {
      return `Hello ${candidate}, I am SkillBridge's AI interviewer for the ${identity.jobTitle} role, based on your CV and the job description. We will go through your experience, the role requirements, and a few realistic scenarios; let us begin.`;
    }
    if (contextMode === 'CV_ONLY') {
      return `Hello ${candidate}, I am SkillBridge's AI interviewer for the ${identity.jobTitle} role, based on your CV. We will discuss your experience and a few realistic scenarios; let us begin.`;
    }
    return `Hello ${candidate}, I am SkillBridge's AI interviewer for the ${identity.jobTitle} role. We will discuss your experience and a few realistic scenarios; let us begin.`;
  }

  if (contextMode === 'CV_JD_MATCH' && identity.employerName) {
    return `Xin chào ${candidate}, tôi là HR AI của ${identity.employerName} cho vị trí ${identity.jobTitle}. Mình sẽ lần lượt trao đổi về kinh nghiệm của bạn, yêu cầu của vị trí và một vài tình huống thực tế; chúng ta bắt đầu nhé.`;
  }
  if (contextMode === 'CV_JD_MATCH') {
    return `Xin chào ${candidate}, tôi là AI interviewer của SkillBridge cho vị trí ${identity.jobTitle}, dựa trên CV và JD của bạn. Mình sẽ lần lượt trao đổi về kinh nghiệm, yêu cầu của vị trí và một vài tình huống thực tế; chúng ta bắt đầu nhé.`;
  }
  if (contextMode === 'CV_ONLY') {
    return `Xin chào ${candidate}, tôi là AI interviewer của SkillBridge cho vị trí ${identity.jobTitle}, dựa trên CV của bạn. Mình sẽ trao đổi về kinh nghiệm và một vài tình huống thực tế; chúng ta bắt đầu nhé.`;
  }
  return `Xin chào ${candidate}, tôi là AI interviewer của SkillBridge cho vị trí ${identity.jobTitle}. Mình sẽ trao đổi về kinh nghiệm và một vài tình huống thực tế; chúng ta bắt đầu nhé.`;
}
export function interviewQuestionTokens(question: string): string[] {
  const withoutMarks = question
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  return [...new Set(withoutMarks.match(/[a-z0-9+#]+/g) ?? [])].filter((token) => token.length > 1);
}

export function fingerprintInterviewQuestion(question: string): string {
  return interviewQuestionTokens(question).sort().join('|');
}

export function interviewQuestionSimilarity(left: string, right: string): number {
  const a = new Set(interviewQuestionTokens(left));
  const b = new Set(interviewQuestionTokens(right));
  if (!a.size || !b.size) return 0;
  const intersection = [...a].filter((token) => b.has(token)).length;
  return intersection / new Set([...a, ...b]).size;
}

/**
 * A model can return a paraphrase that is functionally the same question. Keep this guard
 * deterministic so a retry or fallback cannot silently ask the candidate the same thing.
 */
export function isRepeatedInterviewQuestion(
  question: string,
  previousQuestions: string[],
  threshold = 0.82,
): boolean {
  const fingerprint = fingerprintInterviewQuestion(question);
  if (!fingerprint) return false;
  return previousQuestions.some((previous) => {
    if (fingerprint === fingerprintInterviewQuestion(previous)) return true;
    const currentTokens = new Set(interviewQuestionTokens(question));
    const previousTokens = new Set(interviewQuestionTokens(previous));
    const intersection = [...currentTokens].filter((token) => previousTokens.has(token)).length;
    const smallerSet = Math.min(currentTokens.size, previousTokens.size);
    const containment = smallerSet ? intersection / smallerSet : 0;
    return interviewQuestionSimilarity(question, previous) >= threshold || containment >= 0.8;
  });
}
