import { buildTailorChecklist, TailorAction } from './tailor-checklist';
import { decorateWithPatch } from './cv-patch';
import { CvJdMatchParsedResponse, KeywordFrequency } from './dto/cv-jd-match-response.dto';
import { MatchedSkill, MissingSkill, PartialSkill } from './skill-diff.service';
import {
  EvidenceItem,
  EvidenceLedger,
  EvidenceSource,
} from '../../common/services/evidence-ledger';

/**
 * Behavior-pinning spec for buildTailorChecklist (pure, no LLM/DB). Severity mode (ACTION' A1)
 * ranks the FULL uncapped candidate pool first, then applies the per-bucket caps as diversity
 * constraints and MAX_TOTAL last — so the top action is always the top actionable gap. The legacy
 * path (no severity map) keeps the old slice-per-bucket behavior byte-identical. If a test here
 * breaks, the wire behavior of GET tailor-checklist / gap-report recommended_actions changed.
 */

function missing(canonical: string, over: Partial<MissingSkill> = {}): MissingSkill {
  return {
    skill_id: canonical,
    canonical_name: canonical,
    display_name: canonical.toUpperCase(),
    required_level: 3,
    importance: 'REQUIRED',
    weight: 0.5,
    skill_type: 'hard',
    gap_levels: 3,
    ...over,
  };
}

function matched(canonical: string, over: Partial<MatchedSkill> = {}): MatchedSkill {
  return {
    skill_id: canonical,
    canonical_name: canonical,
    display_name: canonical.toUpperCase(),
    cv_level: 3,
    required_level: 3,
    importance: 'REQUIRED',
    weight: 0.5,
    skill_type: 'hard',
    ...over,
  };
}

function partial(canonical: string, over: Partial<PartialSkill> = {}): PartialSkill {
  return { ...matched(canonical), cv_level: 2, required_level: 4, gap_levels: 2, ...over };
}

function kf(canonical: string, jd_count: number, cv_count: number): KeywordFrequency {
  return { canonical_name: canonical, display_name: canonical.toUpperCase(), jd_count, cv_count };
}

const PROJECT_SOURCE: EvidenceSource = {
  kind: 'project',
  ref: 'Booking App',
  recency_year: 2025,
  quote: null,
};

function demonstrated(canonical: string): EvidenceItem {
  return {
    skill_canonical: canonical,
    display_name: canonical.toUpperCase(),
    sources: [PROJECT_SOURCE],
    strength: 'demonstrated',
    most_recent_year: 2025,
  };
}

function ledgerOf(input: { gap?: string[]; demonstrated?: string[] }): EvidenceLedger {
  return {
    items: (input.demonstrated ?? []).map(demonstrated),
    evidence_gap: input.gap ?? [],
  };
}

// Same cast pattern as eval-golden.ts: buildTailorChecklist only reads these fields.
function matchOf(over: Partial<CvJdMatchParsedResponse>): CvJdMatchParsedResponse {
  return {
    matched_skills: [],
    partial_skills: [],
    missing_skills: [],
    keyword_frequency: [],
    ...over,
  } as unknown as CvJdMatchParsedResponse;
}

const canonicals = (out: TailorAction[]) => out.map((a) => a.skill_canonical);

/**
 * 10 capped candidates across all 4 buckets (3 missing + 2 add_evidence + 3 emphasize +
 * 2 deepen), with a 4th/3rd per-bucket loser each, so one fixture pins every cap + the top-8.
 */
function busyFixture() {
  const match = matchOf({
    missing_skills: [
      missing('m1', { weight: 0.9 }),
      missing('m2', { weight: 0.8 }),
      missing('m3', { weight: 0.7 }),
      missing('m4', { weight: 0.6 }),
    ],
    matched_skills: [
      matched('e1', { weight: 0.9 }),
      matched('e2', { weight: 0.8 }),
      matched('e3', { weight: 0.7 }),
      matched('f1'),
      matched('f2'),
      matched('f3'),
      matched('f4'),
    ],
    partial_skills: [
      partial('d1', { cv_level: 1, gap_levels: 3 }),
      partial('d2', { cv_level: 2, gap_levels: 2 }),
      partial('d3', { cv_level: 3, gap_levels: 1 }),
    ],
    keyword_frequency: [kf('f1', 5, 0), kf('f2', 4, 0), kf('f3', 3, 0), kf('f4', 2, 0)],
  });
  const ledger = ledgerOf({ gap: ['e1', 'e2', 'e3'], demonstrated: ['d1', 'd2', 'd3'] });
  return { match, ledger };
}

describe('buildTailorChecklist', () => {
  it('returns [] for an empty match and null ledger (with and without severity map)', () => {
    expect(buildTailorChecklist(matchOf({}), null, 'vi')).toEqual([]);
    expect(buildTailorChecklist(matchOf({}), null, 'en', new Map())).toEqual([]);
  });

  it('no severity map: bucket order missing_required → add_evidence → emphasize → deepen_wording, no gap_severity field', () => {
    const match = matchOf({
      missing_skills: [missing('docker'), missing('python', { importance: 'PREFERRED' })],
      matched_skills: [matched('git'), matched('sql')],
      partial_skills: [partial('react')],
      keyword_frequency: [kf('docker', 4, 0), kf('sql', 3, 1)],
    });
    const ledger = ledgerOf({ gap: ['git'], demonstrated: ['react'] });

    const out = buildTailorChecklist(match, ledger, 'vi');

    expect(out.map((a) => [a.action_type, a.skill_canonical])).toEqual([
      ['missing_required', 'docker'],
      ['add_evidence', 'git'],
      ['emphasize', 'sql'],
      ['deepen_wording', 'react'],
    ]);
    // Non-REQUIRED missing skills never produce an action.
    expect(canonicals(out)).not.toContain('python');

    const [dockerA, gitA, sqlA, reactA] = out;
    // missing_required: no rewrite, jd_count joined from keyword_frequency.
    expect(dockerA.rewrite_eligible).toBe(false);
    expect(dockerA.anchor).toBeNull();
    expect(dockerA.jd_count).toBe(4);
    expect(dockerA.cv_level).toBeNull();
    // add_evidence: no keyword_frequency row → null counts, no rewrite.
    expect(gitA.rewrite_eligible).toBe(false);
    expect(gitA.jd_count).toBeNull();
    // emphasize: rewrite-eligible, real counts.
    expect(sqlA.rewrite_eligible).toBe(true);
    expect(sqlA.jd_count).toBe(3);
    expect(sqlA.cv_count).toBe(1);
    // deepen_wording: anchored to the first demonstrated source.
    expect(reactA.rewrite_eligible).toBe(true);
    expect(reactA.anchor).toEqual({ kind: 'project', ref: 'Booking App' });
    // Legacy path attaches no gap_severity anywhere.
    for (const a of out) expect(a).not.toHaveProperty('gap_severity');
  });

  it('dedupes to one action per skill — the earlier bucket wins', () => {
    const match = matchOf({
      // ts qualifies for add_evidence AND emphasize; node for emphasize AND deepen_wording.
      matched_skills: [matched('ts')],
      partial_skills: [partial('node')],
      keyword_frequency: [kf('ts', 5, 0), kf('node', 3, 1)],
    });
    const ledger = ledgerOf({ gap: ['ts'], demonstrated: ['node'] });

    const out = buildTailorChecklist(match, ledger, 'en');

    expect(out.map((a) => [a.action_type, a.skill_canonical])).toEqual([
      ['add_evidence', 'ts'],
      ['emphasize', 'node'],
    ]);
  });

  it('caps buckets at 3 missing / 2 add_evidence / 3 emphasize / 2 deepen and the total at 8 (legacy path: later buckets sliced off)', () => {
    const { match, ledger } = busyFixture();

    const out = buildTailorChecklist(match, ledger, 'vi');

    // Per-bucket losers (m4 by weight, e3 by weight, f4 by jd_count) never enter the pool;
    // the capped pool is 10, so the top-8 slice drops the whole deepen bucket (d1/d2).
    expect(canonicals(out)).toEqual(['m1', 'm2', 'm3', 'e1', 'e2', 'f1', 'f2', 'f3']);
  });

  it("ACTION' A1: severity ranks the UNCAPPED pool — the 4th missing with top severity survives, the cap drops the least severe instead", () => {
    const match = matchOf({
      missing_skills: [
        missing('a', { weight: 0.9 }),
        missing('b', { weight: 0.8 }),
        missing('c', { weight: 0.7 }),
        missing('d', { weight: 0.1 }),
      ],
    });
    // 'd' is the single most severe gap. MAX_MISSING=3 is a diversity cap applied AFTER the
    // global severity ranking, so 'd' leads and 'c' (least severe) is the one capped out.
    const severity = new Map([
      ['a', 0.2],
      ['b', 0.15],
      ['c', 0.1],
      ['d', 0.99],
    ]);

    const out = buildTailorChecklist(match, null, 'vi', severity);

    expect(canonicals(out)).toEqual(['d', 'a', 'b']);
    expect(out[0].gap_severity).toBe(0.99);
  });

  it("ACTION' A1: legacy path (no severity map) still slices per-bucket by weight — byte-identical", () => {
    const match = matchOf({
      missing_skills: [
        missing('a', { weight: 0.9 }),
        missing('b', { weight: 0.8 }),
        missing('c', { weight: 0.7 }),
        missing('d', { weight: 0.1 }),
      ],
    });

    const out = buildTailorChecklist(match, null, 'vi');

    expect(canonicals(out)).toEqual(['a', 'b', 'c']);
    expect(canonicals(out)).not.toContain('d');
  });

  it('severity map: sorts the full capped pool by severity desc BEFORE the top-8 cap (deepen outranks missing) and attaches gap_severity', () => {
    const { match, ledger } = busyFixture();
    const severity = new Map([
      ['d1', 0.95],
      ['d2', 0.9],
      ['m1', 0.8],
      ['m2', 0.7],
      ['m3', 0.6],
      ['e1', 0.5],
      ['e2', 0.4],
      ['f1', 0.3],
      ['f2', 0.02],
      ['f3', 0.01],
    ]);

    const out = buildTailorChecklist(match, ledger, 'vi', severity);

    // deepen actions survive the top-8 (unlike the legacy path) and lead; f2/f3 drop instead.
    expect(canonicals(out)).toEqual(['d1', 'd2', 'm1', 'm2', 'm3', 'e1', 'e2', 'f1']);
    expect(out[0].gap_severity).toBe(0.95);
    expect(out.every((a) => a.gap_severity !== undefined)).toBe(true);
  });

  it('severity ties keep bucket order (stable sort); canonicals absent from the map sort last with NO gap_severity field', () => {
    const match = matchOf({
      missing_skills: [missing('a')],
      matched_skills: [matched('b')],
      partial_skills: [partial('c')],
    });
    const ledger = ledgerOf({ gap: ['b'], demonstrated: ['c'] });
    const severity = new Map([
      ['a', 0.5],
      ['b', 0.5],
      // 'c' intentionally absent → treated as severity 0.
    ]);

    const out = buildTailorChecklist(match, ledger, 'vi', severity);

    expect(canonicals(out)).toEqual(['a', 'b', 'c']);
    expect(out[0].gap_severity).toBe(0.5);
    expect(out[1].gap_severity).toBe(0.5);
    expect(out[2]).not.toHaveProperty('gap_severity');
  });

  it('action_id: NOT set by buildTailorChecklist — decorateWithPatch derives `${action_type}:${skill_canonical}`, unique per action', () => {
    const { match, ledger } = busyFixture();
    const actions = buildTailorChecklist(match, ledger, 'vi');
    for (const a of actions) expect(a).not.toHaveProperty('action_id');

    const patched = decorateWithPatch({ actions, gapItems: [], document: null, lang: 'vi' });
    expect(patched.map((p) => p.action_id)).toEqual(
      actions.map((a) => `${a.action_type}:${a.skill_canonical}`),
    );
    expect(new Set(patched.map((p) => p.action_id)).size).toBe(patched.length);
  });
});
