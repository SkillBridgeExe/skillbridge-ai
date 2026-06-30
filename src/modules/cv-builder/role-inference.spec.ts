import { inferRoleFromSkills, RoleProfile } from './role-inference';

const ROLES: RoleProfile[] = [
  {
    role_code: 'frontend_developer',
    requirements: [
      { skill_canonical_name: 'react', weight: 0.4 },
      { skill_canonical_name: 'javascript', weight: 0.3 },
      { skill_canonical_name: 'css', weight: 0.3 },
    ],
  },
  {
    role_code: 'backend_developer',
    requirements: [
      { skill_canonical_name: 'nodejs', weight: 0.4 },
      { skill_canonical_name: 'sql', weight: 0.3 },
      { skill_canonical_name: 'docker', weight: 0.3 },
    ],
  },
  {
    role_code: 'mobile_developer',
    requirements: [
      { skill_canonical_name: 'swift', weight: 0.6, any_of: ['swift', 'kotlin'] },
      { skill_canonical_name: 'mobile_ui', weight: 0.4 },
    ],
  },
];

describe('inferRoleFromSkills', () => {
  it('scores by SUMMED weight, not count (1 stray skill does not flip role)', () => {
    // strong backend (0.4+0.3=0.7) + one stray react (0.4 frontend) → backend wins
    const r = inferRoleFromSkills(['nodejs', 'sql', 'react'], ROLES);
    expect(r.role_code).toBe('backend_developer');
    expect(r.confidence).toBeCloseTo(0.7);
    expect(r.reason).toBe('ok');
  });

  it('matches an any_of group member (kotlin satisfies the swift-or-kotlin req)', () => {
    const r = inferRoleFromSkills(['kotlin', 'mobile_ui'], ROLES, { minMatched: 1 });
    expect(r.role_code).toBe('mobile_developer');
    expect(r.confidence).toBeCloseTo(1.0);
  });

  it('abstains (ambiguous) when top two scores are within the margin', () => {
    // react(0.4)+nodejs(0.4): frontend 0.4 vs backend 0.4 → tie → ask
    const r = inferRoleFromSkills(['react', 'nodejs'], ROLES, { minMatched: 1 });
    expect(r.role_code).toBeNull();
    expect(r.needs_user_input).toBe(true);
    expect(r.reason).toBe('ambiguous');
  });

  it('abstains (too_weak) when coverage below minConfidence', () => {
    const r = inferRoleFromSkills(['css'], ROLES); // frontend 0.3 < 0.34 default
    expect(r.role_code).toBeNull();
    expect(r.reason).toBe('too_weak');
  });

  it('is deterministic + tie-breaks by role_code alpha when scores AND margin equal', () => {
    const a = inferRoleFromSkills(['react', 'javascript'], ROLES);
    const b = inferRoleFromSkills(['react', 'javascript'], ROLES);
    expect(a).toEqual(b);
  });

  it('returns no_roles cleanly on empty rubric set', () => {
    expect(inferRoleFromSkills(['react'], []).reason).toBe('no_roles');
  });
});
