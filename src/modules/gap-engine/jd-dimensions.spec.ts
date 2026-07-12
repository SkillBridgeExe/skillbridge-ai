import {
  DimensionGrade,
  JdDimension,
  gradeDomain,
  gradeEducation,
  gradeLanguage,
  gradeNonSkillDimensions,
  gradeSeniority,
  normalizeJdDimensions,
} from './jd-dimensions';
import { CvSeniority, SeniorityBucket, Confidence } from '../../common/services/seniority';
import { CvProfileSignals, SignalConfidence } from '../../common/services/cv-profile-signals';

/** Minimal valid JdDimension — override per test. */
const dim = (over: Partial<JdDimension> = {}): JdDimension => ({
  dimension: 'seniority',
  value_text: 'Senior',
  level_hint: 'SENIOR',
  min_years: null,
  importance: 'PREFERRED',
  deal_breaker: false,
  evidence_text: 'JD quote',
  ...over,
});

const cv = (bucket: SeniorityBucket, confidence: Confidence = 'high'): CvSeniority => ({
  bucket,
  est_years: null,
  confidence,
  signals: [],
});

const signals = (over: Partial<CvProfileSignals> = {}): CvProfileSignals => ({
  english: null,
  education: null,
  domain: null,
  work_mode: null,
  ...over,
});

const english = (cefr: 'A1' | 'A2' | 'B1' | 'B2' | 'C1' | 'C2', conf: SignalConfidence = 'high') =>
  signals({
    english: { cefr, source_kind: 'cefr', raw: `English ${cefr}`, confidence: conf, signals: [] },
  });

describe('normalizeJdDimensions — LLM output coercer (anti-fabrication)', () => {
  it('non-array input → [] (null / undefined / object / string)', () => {
    expect(normalizeJdDimensions(null)).toEqual([]);
    expect(normalizeJdDimensions(undefined)).toEqual([]);
    expect(normalizeJdDimensions({ dimension: 'seniority' })).toEqual([]);
    expect(normalizeJdDimensions('seniority')).toEqual([]);
  });

  it('drops non-object entries and unknown dimension types', () => {
    const out = normalizeJdDimensions([
      null,
      'junk',
      42,
      { dimension: 'salary', evidence_text: 'quote' }, // unknown type
      { dimension: 123, evidence_text: 'quote' }, // non-string type
      { evidence_text: 'quote' }, // missing type
    ]);
    expect(out).toEqual([]);
  });

  it('drops entries with missing / empty / non-string evidence_text (no JD quote ⇒ no dimension)', () => {
    const out = normalizeJdDimensions([
      { dimension: 'seniority', level_hint: 'SENIOR' },
      { dimension: 'seniority', level_hint: 'SENIOR', evidence_text: '' },
      { dimension: 'seniority', level_hint: 'SENIOR', evidence_text: '   ' },
      { dimension: 'seniority', level_hint: 'SENIOR', evidence_text: 42 },
    ]);
    expect(out).toEqual([]);
  });

  it('dimension is trimmed + lowercased; value_text falls back to evidence_text', () => {
    const out = normalizeJdDimensions([
      { dimension: '  WORK_MODE ', evidence_text: ' Remote-first team ' },
    ]);
    expect(out).toEqual([
      {
        dimension: 'work_mode',
        value_text: 'Remote-first team',
        level_hint: null,
        min_years: null,
        importance: 'PREFERRED',
        deal_breaker: false,
        evidence_text: 'Remote-first team',
      },
    ]);
  });

  it('seniority level_hint is uppercased to a JOB_LEVEL_RANK key, or null when malformed', () => {
    const out = normalizeJdDimensions([
      { dimension: 'seniority', level_hint: 'senior', evidence_text: 'q' },
      { dimension: 'seniority', level_hint: 'Principal', evidence_text: 'q' }, // not a known level
      { dimension: 'seniority', level_hint: 7, evidence_text: 'q' }, // non-string
    ]);
    expect(out.map((d) => d.level_hint)).toEqual(['SENIOR', null, null]);
  });

  it('non-seniority level_hint is kept as the raw trimmed qualifier (NOT uppercased)', () => {
    const out = normalizeJdDimensions([
      { dimension: 'language', level_hint: ' b2 ', evidence_text: 'English required' },
    ]);
    expect(out[0].level_hint).toBe('b2');
  });

  it('importance defaults to PREFERRED; a valid hint is accepted case-insensitively', () => {
    const out = normalizeJdDimensions([
      { dimension: 'education', evidence_text: 'q' }, // no hint
      { dimension: 'education', importance_hint: ' required ', evidence_text: 'q' },
      { dimension: 'education', importance_hint: 'nice_to_have', evidence_text: 'q' },
      { dimension: 'education', importance_hint: 'CRITICAL', evidence_text: 'q' }, // unknown hint
    ]);
    expect(out.map((d) => d.importance)).toEqual([
      'PREFERRED',
      'REQUIRED',
      'NICE_TO_HAVE',
      'PREFERRED',
    ]);
  });

  it('deal_breaker=true forces REQUIRED (overrides the hint); only boolean true counts', () => {
    const out = normalizeJdDimensions([
      {
        dimension: 'language',
        deal_breaker: true,
        importance_hint: 'NICE_TO_HAVE',
        evidence_text: 'q',
      },
      { dimension: 'language', deal_breaker: 'true', evidence_text: 'q' }, // string is NOT true
    ]);
    expect(out[0]).toMatchObject({ deal_breaker: true, importance: 'REQUIRED' });
    expect(out[1]).toMatchObject({ deal_breaker: false, importance: 'PREFERRED' });
  });

  it('min_years: floored when a finite number ≥ 0, else null (0 is kept)', () => {
    const out = normalizeJdDimensions([
      { dimension: 'seniority', min_years: 2.9, evidence_text: 'q' },
      { dimension: 'seniority', min_years: 0, evidence_text: 'q' },
      { dimension: 'seniority', min_years: -1, evidence_text: 'q' },
      { dimension: 'seniority', min_years: '3', evidence_text: 'q' },
      { dimension: 'seniority', min_years: Infinity, evidence_text: 'q' },
    ]);
    expect(out.map((d) => d.min_years)).toEqual([2, 0, null, null, null]);
  });
});

describe('gradeSeniority — honest-null paths + verdict boundaries', () => {
  it('null when dims are empty / null / undefined', () => {
    expect(gradeSeniority([], cv('junior'))).toBeNull();
    expect(gradeSeniority(null, cv('junior'))).toBeNull();
    expect(gradeSeniority(undefined, cv('junior'))).toBeNull();
  });

  it('null when there is no CV signal or CV confidence is low', () => {
    expect(gradeSeniority([dim()], null)).toBeNull();
    expect(gradeSeniority([dim()], undefined)).toBeNull();
    expect(gradeSeniority([dim()], cv('junior', 'low'))).toBeNull();
  });

  it('medium CV confidence is enough to grade (only low is blocked)', () => {
    expect(gradeSeniority([dim()], cv('senior', 'medium'))).not.toBeNull();
  });

  it('null when no seniority dim carries a valid JOB_LEVEL_RANK level_hint', () => {
    expect(gradeSeniority([dim({ level_hint: null })], cv('junior'))).toBeNull();
    // lowercase is NOT re-coerced here — normalizeJdDimensions owns that
    expect(gradeSeniority([dim({ level_hint: 'senior' })], cv('junior'))).toBeNull();
    expect(
      gradeSeniority([dim({ dimension: 'language', level_hint: 'B2' })], cv('junior')),
    ).toBeNull();
  });

  it('≥2 levels below the JD = stretch = a real gap (cv_status missing, gap_levels = rank diff)', () => {
    const g = gradeSeniority([dim({ level_hint: 'SENIOR' })], cv('fresher'))!;
    expect(g).toMatchObject({
      jdRank: 4,
      cvRank: 1,
      verdict: 'stretch',
      cv_status: 'missing',
      gap_levels: 3,
    });
  });

  it('exactly 1 level below = fits = matched with zero gap (±1 tolerance boundary)', () => {
    const g = gradeSeniority([dim({ level_hint: 'SENIOR' })], cv('mid'))!;
    expect(g).toMatchObject({ verdict: 'fits', cv_status: 'matched', gap_levels: 0 });
  });

  it('over_qualified is also matched with zero gap (no penalty)', () => {
    const g = gradeSeniority([dim({ level_hint: 'FRESHER' })], cv('senior'))!;
    expect(g).toMatchObject({ verdict: 'over_qualified', cv_status: 'matched', gap_levels: 0 });
  });

  it('multiple seniority dims collapse to the STRICTEST (highest required rank)', () => {
    const junior = dim({ level_hint: 'JUNIOR', value_text: 'Junior' });
    const lead = dim({ level_hint: 'LEAD', value_text: 'Lead' });
    const g = gradeSeniority([junior, lead], cv('fresher'))!;
    expect(g.dim).toBe(lead);
    expect(g).toMatchObject({ jdRank: 5, gap_levels: 4, verdict: 'stretch' });
  });

  it('tie on rank → deal-breaker wins over an earlier-listed PREFERRED (P2 fix)', () => {
    const soft = dim({ level_hint: 'SENIOR', importance: 'PREFERRED' });
    const hard = dim({ level_hint: 'SENIOR', importance: 'REQUIRED', deal_breaker: true });
    expect(gradeSeniority([soft, hard], cv('fresher'))!.dim).toBe(hard);
  });

  it('tie on rank + deal-breaker → higher importance, then higher min_years', () => {
    const nice = dim({ level_hint: 'SENIOR', importance: 'NICE_TO_HAVE' });
    const req = dim({ level_hint: 'SENIOR', importance: 'REQUIRED' });
    expect(gradeSeniority([nice, req], cv('fresher'))!.dim).toBe(req);

    const y3 = dim({ level_hint: 'SENIOR', min_years: 3 });
    const y5 = dim({ level_hint: 'SENIOR', min_years: 5 });
    expect(gradeSeniority([y3, y5], cv('fresher'))!.dim).toBe(y5);
  });
});

describe('gradeLanguage — CEFR grading with risk-first target pick', () => {
  const lang = (value_text: string, over: Partial<JdDimension> = {}) =>
    dim({ dimension: 'language', level_hint: null, value_text, ...over });

  it('null when no language dim or the JD level is unparseable', () => {
    expect(gradeLanguage([dim()], english('B2'))).toBeNull(); // seniority dim only
    expect(gradeLanguage([lang('good communication skills')], english('B2'))).toBeNull();
    expect(gradeLanguage(null, english('B2'))).toBeNull();
  });

  it('CV at/above the requirement → matched, gap 0', () => {
    const g = gradeLanguage([lang('English B2')], english('C1'))!;
    expect(g).toMatchObject({
      type: 'language',
      cv_status: 'matched',
      cv_level: 5,
      required_level: 4,
      gap_levels: 0,
      from_silence: false,
    });
  });

  it('CV exactly 1 CEFR level below → partial, gap 1', () => {
    const g = gradeLanguage([lang('English B2')], english('B1'))!;
    expect(g).toMatchObject({
      cv_status: 'partial',
      cv_level: 3,
      required_level: 4,
      gap_levels: 1,
    });
  });

  it('CV ≥2 levels below → missing with the full rank diff', () => {
    const g = gradeLanguage([lang('English C1')], english('B1'))!;
    expect(g).toMatchObject({ cv_status: 'missing', gap_levels: 2, required_level: 5 });
  });

  it('grades against the highest-RISK failed requirement: lower REQUIRED beats higher PREFERRED', () => {
    const preferredC1 = lang('English C1', { importance: 'PREFERRED' });
    const requiredB1 = lang('English B1', { importance: 'REQUIRED' });
    const g = gradeLanguage([preferredC1, requiredB1], english('A2'))!;
    expect(g.dims).toEqual([requiredB1]);
    expect(g).toMatchObject({
      required_level: 3,
      gap_levels: 1,
      cv_status: 'partial',
      importance: 'REQUIRED',
    });
  });

  it('CV meets every requirement → graded against the strictest (matched)', () => {
    const b1 = lang('English B1', { importance: 'REQUIRED' });
    const b2 = lang('English B2', { importance: 'PREFERRED' });
    const g = gradeLanguage([b1, b2], english('C2'))!;
    expect(g.dims).toEqual([b2]);
    expect(g).toMatchObject({ cv_status: 'matched', required_level: 4 });
  });

  it('confidence maps from the CV signal: high 0.8 / low 0.6', () => {
    expect(gradeLanguage([lang('English B2')], english('B2', 'high'))!.confidence).toBe(0.8);
    expect(gradeLanguage([lang('English B2')], english('B2', 'low'))!.confidence).toBe(0.6);
  });

  it('CV silent + only soft requirements → null (honest omission)', () => {
    expect(gradeLanguage([lang('English C1', { importance: 'PREFERRED' })], signals())).toBeNull();
    expect(gradeLanguage([lang('English C1')], null)).toBeNull();
  });

  it('CV silent + hard requirement → missing from silence at confidence 0.5', () => {
    const soft = lang('English C1', { importance: 'PREFERRED' });
    const hard = lang('English B2', { importance: 'REQUIRED' });
    const g = gradeLanguage([soft, hard], signals())!;
    expect(g.dims).toEqual([hard]); // strictest HARD one — the higher PREFERRED must not hide it
    expect(g).toMatchObject({
      cv_status: 'missing',
      cv_level: null,
      required_level: 4,
      gap_levels: 4,
      confidence: 0.5,
      from_silence: true,
    });
  });
});

describe('gradeEducation — degree scale, no partial bucket', () => {
  const edu = (value_text: string, over: Partial<JdDimension> = {}) =>
    dim({ dimension: 'education', level_hint: null, value_text, ...over });
  const cvEdu = (level: 'associate' | 'bachelor' | 'master', conf: SignalConfidence = 'high') =>
    signals({ education: { level, field: null, confidence: conf, signals: [] } });

  it('null when no education dim classifies to a degree level', () => {
    expect(gradeEducation([edu('relevant field of study')], cvEdu('bachelor'))).toBeNull();
    expect(gradeEducation(null, cvEdu('bachelor'))).toBeNull();
  });

  it('CV at/above the required degree → matched (no partial bucket)', () => {
    const g = gradeEducation([edu('Bachelor in CS')], cvEdu('master'))!;
    expect(g).toMatchObject({
      type: 'education',
      cv_status: 'matched',
      cv_level: 4,
      required_level: 3,
      gap_levels: 0,
    });
  });

  it('CV exactly 1 degree below → missing (NOT partial), gap 1', () => {
    const g = gradeEducation([edu('Master degree')], cvEdu('bachelor'))!;
    expect(g).toMatchObject({ cv_status: 'missing', gap_levels: 1, from_silence: false });
  });

  it('field-only CV education (level null) is treated as silent → hard requirement gap from silence', () => {
    const fieldOnly = signals({
      education: { level: null, field: 'Computer Science', confidence: 'low', signals: [] },
    });
    const g = gradeEducation([edu('Bachelor degree', { importance: 'REQUIRED' })], fieldOnly)!;
    expect(g).toMatchObject({
      cv_status: 'missing',
      cv_level: null,
      required_level: 3,
      gap_levels: 3,
      confidence: 0.5,
      from_silence: true,
    });
  });

  it('CV silent + only soft degree requirements → null', () => {
    expect(
      gradeEducation([edu('Bachelor degree', { importance: 'PREFERRED' })], signals()),
    ).toBeNull();
  });
});

describe('gradeDomain — exact canonical overlap, silence always omitted', () => {
  const dom = (value_text: string, over: Partial<JdDimension> = {}) =>
    dim({ dimension: 'domain', level_hint: null, value_text, ...over });
  const cvDom = (domains: string[]) =>
    signals({ domain: { domains, confidence: 'medium', signals: [] } });

  it('null when the JD industry does not canonicalise', () => {
    expect(gradeDomain([dom('banana industry experience')], cvDom(['fintech']))).toBeNull();
  });

  it('CV silent → ALWAYS null, even for a deal-breaker domain', () => {
    expect(
      gradeDomain(
        [dom('fintech background', { deal_breaker: true, importance: 'REQUIRED' })],
        signals(),
      ),
    ).toBeNull();
  });

  it('canonical overlap → matched with gap 0; levels are N/A (null)', () => {
    const g = gradeDomain([dom('fintech background')], cvDom(['ecommerce', 'fintech']))!;
    expect(g).toMatchObject({
      type: 'domain',
      cv_status: 'matched',
      gap_levels: 0,
      cv_level: null,
      required_level: null,
      confidence: 0.7,
    });
  });

  it('no overlap → missing with a fixed gap of 1; dims lists every canonicalising dim', () => {
    const fin = dom('fintech background');
    const health = dom('healthcare platform');
    const junk = dom('misc industry'); // not canonicalisable → excluded from dims
    const g = gradeDomain([fin, health, junk], cvDom(['gaming']))!;
    expect(g).toMatchObject({ cv_status: 'missing', gap_levels: 1 });
    expect(g.dims).toEqual([fin, health]);
  });
});

describe('gradeNonSkillDimensions — aggregator', () => {
  it('returns at most one grade per type and drops null grades (work_mode never graded)', () => {
    const dims = [
      dim({ dimension: 'language', level_hint: null, value_text: 'English B2' }),
      dim({ dimension: 'education', level_hint: null, value_text: 'Bachelor degree' }),
      dim({ dimension: 'domain', level_hint: null, value_text: 'fintech background' }),
      dim({ dimension: 'work_mode', level_hint: null, value_text: 'Onsite only' }),
    ];
    const sig = signals({
      english: {
        cefr: 'B2',
        source_kind: 'cefr',
        raw: 'English B2',
        confidence: 'high',
        signals: [],
      },
      education: { level: 'bachelor', field: null, confidence: 'high', signals: [] },
      domain: { domains: ['fintech'], confidence: 'medium', signals: [] },
      work_mode: { mode: 'remote', confidence: 'low', signals: [] },
    });
    const grades = gradeNonSkillDimensions(dims, sig);
    expect(grades.map((g: DimensionGrade) => g.type)).toEqual(['language', 'education', 'domain']);
    expect(grades.every((g) => g.cv_status === 'matched')).toBe(true);
  });

  it('empty input → empty output (no fabricated grades)', () => {
    expect(gradeNonSkillDimensions(null, null)).toEqual([]);
    expect(gradeNonSkillDimensions([], signals())).toEqual([]);
  });
});
