import {
  RoleRubricService,
  BAND_OFFSET,
  RubricBand,
} from '../../src/common/services/role-rubric.service';

/**
 * Seniority-band v1 (spec 2026-06-11, user-approved): the rubric is a MID-LEVEL yardstick;
 * fresher/intern bands shift every required_level down by a fixed offset (clamped 1-5).
 * Band selection NEVER comes from the CV itself (self-serving loop) — callers pass it.
 */
describe('RoleRubricService — seniority bands', () => {
  let svc: RoleRubricService;

  beforeAll(async () => {
    svc = new RoleRubricService();
    await svc.onModuleInit();
  });

  it('mid band returns the base rubric unchanged (identity)', () => {
    const base = svc.getRubric('frontend_developer');
    const mid = svc.getRubric('frontend_developer', 'mid');
    expect(mid).toBe(base);
  });

  it('fresher band = every required_level − 1, clamped to ≥1', () => {
    const base = svc.getRubric('frontend_developer')!;
    const fresher = svc.getRubric('frontend_developer', 'fresher')!;
    for (let i = 0; i < base.skills.length; i++) {
      const expected = Math.max(
        1,
        Math.min(5, base.skills[i].required_level + BAND_OFFSET.fresher),
      );
      expect(fresher.skills[i].required_level).toBe(expected);
      // weight/importance untouched
      expect(fresher.skills[i].weight).toBe(base.skills[i].weight);
      expect(fresher.skills[i].importance).toBe(base.skills[i].importance);
    }
  });

  it('intern band = −2 with clamping (an L2 requirement floors at 1, never 0)', () => {
    const base = svc.getRubric('frontend_developer')!;
    const intern = svc.getRubric('frontend_developer', 'intern')!;
    const l2 = base.skills.findIndex((s) => s.required_level === 2);
    expect(l2).toBeGreaterThanOrEqual(0);
    expect(intern.skills[l2].required_level).toBe(1);
  });

  it('banded rubrics are cached (same object on repeat) and never mutate the base', () => {
    const a = svc.getRubric('backend_developer', 'fresher');
    const b = svc.getRubric('backend_developer', 'fresher');
    expect(a).toBe(b);
    const base = svc.getRubric('backend_developer')!;
    expect(base.skills.some((s) => s.required_level >= 3)).toBe(true); // base intact
  });

  it('mobile rubric carries the swift/kotlin OR-group (any_of) after the dual-platform fix', () => {
    const mobile = svc.getRubric('mobile_developer')!;
    const group = mobile.skills.find((s) => s.any_of && s.any_of.length === 2);
    expect(group).toBeDefined();
    expect(group?.any_of).toEqual(expect.arrayContaining(['swift', 'kotlin']));
    expect(group?.importance).toBe('REQUIRED');
    // the two platform skills remain as light PREFERRED entries
    const swift = mobile.skills.find((s) => s.skill_canonical_name === 'swift' && !s.any_of);
    const kotlin = mobile.skills.find((s) => s.skill_canonical_name === 'kotlin' && !s.any_of);
    expect(swift?.importance).toBe('PREFERRED');
    expect(kotlin?.importance).toBe('PREFERRED');
  });

  it('weight sum stays ~1.0 for mobile after the OR-group restructure', () => {
    const mobile = svc.getRubric('mobile_developer')!;
    const sum = mobile.skills.reduce((s, r) => s + r.weight, 0);
    expect(sum).toBeGreaterThanOrEqual(0.95);
    expect(sum).toBeLessThanOrEqual(1.05);
  });

  it('every band value is typed and produces a rubric for every role', () => {
    const bands: RubricBand[] = ['intern', 'fresher', 'mid'];
    for (const role of svc.listRoleCodes()) {
      for (const band of bands) {
        expect(svc.getRubric(role, band)).toBeTruthy();
      }
    }
  });
});
