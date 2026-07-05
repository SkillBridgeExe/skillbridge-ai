import { SkillTaxonomyService } from '../../common/services/skill-taxonomy.service';
import { SkillNormalizerService } from '../../common/services/skill-normalizer.service';
import { RoleRubricService } from '../../common/services/role-rubric.service';
import { SkillDiffService, RawCvSkill, RawJdRequirement } from '../cv-jd-match/skill-diff.service';
import { CvJdMatchParsedResponse } from '../cv-jd-match/dto/cv-jd-match-response.dto';
import { EvidenceLedger } from '../../common/services/evidence-ledger';
import { buildGapItems, GapItem } from './gap-item';

/**
 * I3 (Wave IMPACT): GitHub corroboration overlay. `corroborated` is a platform-fetched PLAIN Map
 * (canonical_name → { ref }) — buildGapItems never talks to GithubEvidenceService itself, keeping
 * this module pure/sync (wave-impact-constraints.md fact #3/#4).
 */
describe('buildGapItems — github corroboration overlay (I3)', () => {
  let diffSvc: SkillDiffService;

  beforeAll(async () => {
    const taxonomy = new SkillTaxonomyService();
    await taxonomy.onModuleInit();
    const normalizer = new SkillNormalizerService(taxonomy);
    const rubrics = new RoleRubricService();
    await rubrics.onModuleInit();
    diffSvc = new SkillDiffService(normalizer, rubrics);
  });

  // react: ADVANCED (cv_level 4) claimed == required -> matched, but listed_only + cv_level>=4 ⇒
  // OVERCLAIMED (evidence_risk 'unproven'). sql: INTERMEDIATE (cv_level 3) vs required ADVANCED ⇒
  // PARTIAL, listed_only ⇒ evidence_risk 'listed_only'. git: matched, no ledger entry at all ⇒
  // evidence_risk 'none'. One real diff() call exercises all three evidence_risk starting values.
  function buildFixture() {
    const res = diffSvc.diff({
      cv_skills_raw: [
        { name: 'React', proficiency_hint: 'ADVANCED' },
        { name: 'SQL', proficiency_hint: 'INTERMEDIATE' },
        { name: 'Git', proficiency_hint: 'INTERMEDIATE' },
      ] as RawCvSkill[],
      jd_requirements_raw: [
        { name: 'React', importance_hint: 'REQUIRED', required_level_hint: 'ADVANCED' },
        { name: 'SQL', importance_hint: 'REQUIRED', required_level_hint: 'ADVANCED' },
        { name: 'Git', importance_hint: 'REQUIRED', required_level_hint: 'INTERMEDIATE' },
      ] as RawJdRequirement[],
    });
    expect(res.unnormalized_cv_skills).toEqual([]);
    expect(res.unnormalized_jd_requirements).toEqual([]);

    const match = {
      matched_skills: res.matched_skills,
      partial_skills: res.partial_skills,
      missing_skills: res.missing_skills,
      source_of_requirements: res.requirements_source,
      target_role: 'frontend_developer',
    } as unknown as CvJdMatchParsedResponse;

    const ledger: EvidenceLedger = {
      evidence_gap: ['react', 'sql'],
      items: [
        {
          skill_canonical: 'react',
          display_name: 'React',
          sources: [],
          strength: 'listed_only',
          most_recent_year: null,
        },
        {
          skill_canonical: 'sql',
          display_name: 'SQL',
          sources: [],
          strength: 'listed_only',
          most_recent_year: null,
        },
      ],
    };
    return { match, ledger };
  }

  const byCanonical = (items: GapItem[]) => new Map(items.map((i) => [i.canonical_name, i]));

  it('sanity: baseline statuses without any github corroboration', () => {
    const { match, ledger } = buildFixture();
    const g = byCanonical(buildGapItems({ match, ledger }));
    expect(g.get('react')).toMatchObject({ cv_status: 'overclaimed', evidence_risk: 'unproven' });
    expect(g.get('sql')).toMatchObject({ cv_status: 'partial', evidence_risk: 'listed_only' });
    expect(g.get('git')).toMatchObject({ cv_status: 'matched', evidence_risk: 'none' });
    expect(g.get('git')?.evidence).toBeUndefined();
  });

  it('listed_only + corroborated -> none, plus a github evidence citation', () => {
    const { match, ledger } = buildFixture();
    const corroborated = new Map([['sql', { ref: 'my-sql-project' }]]);
    const sql = byCanonical(buildGapItems({ match, ledger, corroborated })).get('sql')!;
    expect(sql.evidence_risk).toBe('none');
    expect(sql.cv_status).toBe('partial'); // unchanged: repo proves USAGE, not level
    expect(sql.evidence).toEqual(
      expect.arrayContaining([{ kind: 'github', ref: 'my-sql-project', quote: null }]),
    );
  });

  it('unproven + corroborated -> listed_only (repo proves usage, not level)', () => {
    const { match, ledger } = buildFixture();
    const corroborated = new Map([['react', { ref: 'my-react-app' }]]);
    const react = byCanonical(buildGapItems({ match, ledger, corroborated })).get('react')!;
    expect(react.evidence_risk).toBe('listed_only');
    expect(react.cv_status).toBe('overclaimed'); // unchanged: still an unresolved level overclaim
    expect(react.evidence).toEqual(
      expect.arrayContaining([{ kind: 'github', ref: 'my-react-app', quote: null }]),
    );
  });

  it('none + corroborated -> stays none, still cited', () => {
    const { match, ledger } = buildFixture();
    const corroborated = new Map([['git', { ref: 'my-git-tool' }]]);
    const git = byCanonical(buildGapItems({ match, ledger, corroborated })).get('git')!;
    expect(git.evidence_risk).toBe('none');
    expect(git.evidence).toEqual([{ kind: 'github', ref: 'my-git-tool', quote: null }]);
  });

  it('severity recomputes from the downgraded evidence_risk input (no formula edits)', () => {
    const { match, ledger } = buildFixture();
    const before = byCanonical(buildGapItems({ match, ledger })).get('sql')!;
    const after = byCanonical(
      buildGapItems({ match, ledger, corroborated: new Map([['sql', { ref: 'x' }]]) }),
    ).get('sql')!;
    expect(after.severity).toBeLessThan(before.severity);
  });

  it('no corroborated map -> byte-identical output (absent github params on the request)', () => {
    const { match, ledger } = buildFixture();
    const withoutField = buildGapItems({ match, ledger });
    const explicitUndefined = buildGapItems({ match, ledger, corroborated: undefined });
    const explicitEmptyMap = buildGapItems({ match, ledger, corroborated: new Map() });
    expect(explicitUndefined).toEqual(withoutField);
    expect(explicitEmptyMap).toEqual(withoutField);
  });

  // V1 (Wave VALUE_CHAIN): real interview outcomes overlay. Same platform-fetched plain-Map pattern
  // as `corroborated` — buildGapItems never talks to the interview services itself.
  describe('interview signal overlay (V1, Wave VALUE_CHAIN)', () => {
    it('a real interview signal RAISES severity and adds an interview evidence citation', () => {
      const { match, ledger } = buildFixture();
      const baseline = byCanonical(buildGapItems({ match, ledger })).get('sql')!;
      const sql = byCanonical(
        buildGapItems({
          match,
          ledger,
          interviewSignals: new Map([['sql', { risk: 0.95, ref: 'sess-abc1' }]]),
        }),
      ).get('sql')!;
      expect(sql.severity).toBeGreaterThan(baseline.severity);
      expect(sql.cv_status).toBe(baseline.cv_status); // overlay never touches cv_status
      expect(sql.evidence_risk).toBe(baseline.evidence_risk); // nor evidence_risk (github owns that)
      expect(sql.evidence).toEqual(
        expect.arrayContaining([{ kind: 'interview', ref: 'sess-abc1', quote: null }]),
      );
    });

    it('a LOWER signal never lowers severity (max) — the citation still lands', () => {
      // react is overclaimed/unproven → derived interview risk 1.0×(0.5+0.5×0.7) = 0.85; 0.2 loses.
      const { match, ledger } = buildFixture();
      const baseline = byCanonical(buildGapItems({ match, ledger })).get('react')!;
      const react = byCanonical(
        buildGapItems({
          match,
          ledger,
          interviewSignals: new Map([['react', { risk: 0.2, ref: 'sess-abc1' }]]),
        }),
      ).get('react')!;
      expect(react.severity).toBe(baseline.severity);
      expect(react.severity_factors).toEqual(baseline.severity_factors);
      expect(react.evidence).toEqual(
        expect.arrayContaining([{ kind: 'interview', ref: 'sess-abc1', quote: null }]),
      );
    });

    it('absent/empty signals map -> byte-identical output (no completed interview yet)', () => {
      const { match, ledger } = buildFixture();
      const withoutField = buildGapItems({ match, ledger });
      expect(buildGapItems({ match, ledger, interviewSignals: undefined })).toEqual(withoutField);
      expect(buildGapItems({ match, ledger, interviewSignals: new Map() })).toEqual(withoutField);
    });

    it('stacks on github corroboration: severity recomputes from the DOWNGRADED evidence_risk', () => {
      const { match, ledger } = buildFixture();
      const corroborated = new Map([['sql', { ref: 'my-sql-project' }]]);
      const githubOnly = byCanonical(buildGapItems({ match, ledger, corroborated })).get('sql')!;
      const both = byCanonical(
        buildGapItems({
          match,
          ledger,
          corroborated,
          interviewSignals: new Map([['sql', { risk: 0.95, ref: 'sess-abc1' }]]),
        }),
      ).get('sql')!;
      expect(both.evidence_risk).toBe('none'); // github downgrade still applied
      expect(both.evidence).toEqual([
        { kind: 'github', ref: 'my-sql-project', quote: null },
        { kind: 'interview', ref: 'sess-abc1', quote: null },
      ]);
      expect(both.severity).toBeGreaterThan(githubOnly.severity);
    });
  });
});
