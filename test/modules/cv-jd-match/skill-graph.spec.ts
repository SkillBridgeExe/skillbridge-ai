import {
  inferSkills,
  loadSkillEdges,
  SkillEdge,
} from '../../../src/modules/cv-jd-match/skill-graph';
import { SkillTaxonomyService } from '../../../src/common/services/skill-taxonomy.service';
import { SkillNormalizerService } from '../../../src/common/services/skill-normalizer.service';
import { RoleRubricService } from '../../../src/common/services/role-rubric.service';

// identity display resolver keeps behavior tests independent of the taxonomy
const id = (c: string) => c;

const FIXTURE: SkillEdge[] = [
  {
    from: 'javascript',
    to: 'react',
    type: 'ecosystem',
    confidence: 0.6,
    roles: ['frontend_developer'],
  },
  {
    from: 'typescript',
    to: 'react',
    type: 'ecosystem',
    confidence: 0.55,
    roles: ['frontend_developer'],
  },
  {
    from: 'javascript',
    to: 'node_js',
    type: 'ecosystem',
    confidence: 0.5,
    roles: ['backend_developer'],
  },
  { from: 'python', to: 'pandas', type: 'ecosystem', confidence: 0.6, roles: ['data_analyst'] },
  { from: 'python', to: 'numpy', type: 'ecosystem', confidence: 0.5, roles: ['data_analyst'] },
  {
    from: 'python',
    to: 'django',
    type: 'ecosystem',
    confidence: 0.5,
    roles: ['backend_developer'],
  },
  {
    from: 'python',
    to: 'flask',
    type: 'ecosystem',
    confidence: 0.45,
    roles: ['backend_developer'],
  }, // < floor
  { from: 'docker', to: 'kubernetes', type: 'ecosystem', confidence: 0.5, roles: ['*'] },
];

describe('inferSkills (pure)', () => {
  it('role-gates: javascript→react fires for frontend, not for backend', () => {
    const fe = inferSkills(FIXTURE, ['javascript'], 'frontend_developer', new Set(), id);
    expect(fe.map((s) => s.canonical_name)).toContain('react');
    const be = inferSkills(FIXTURE, ['javascript'], 'backend_developer', new Set(), id);
    expect(be.map((s) => s.canonical_name)).not.toContain('react');
    expect(be.map((s) => s.canonical_name)).toContain('node_js'); // backend-gated edge fires
  });

  it('wildcard role edges fire for any role and for a null role', () => {
    const out = inferSkills(FIXTURE, ['docker'], null, new Set(), id);
    expect(out.map((s) => s.canonical_name)).toContain('kubernetes');
  });

  it('requires the source skill in the CV', () => {
    const out = inferSkills(FIXTURE, ['python'], 'frontend_developer', new Set(), id);
    expect(out.map((s) => s.canonical_name)).not.toContain('react'); // no javascript/typescript
  });

  it('applies the confidence floor (0.5): a 0.45 edge never surfaces', () => {
    const out = inferSkills(FIXTURE, ['python'], 'backend_developer', new Set(), id);
    expect(out.map((s) => s.canonical_name)).toContain('django'); // 0.5 OK
    expect(out.map((s) => s.canonical_name)).not.toContain('flask'); // 0.45 dropped
  });

  it('never re-suggests an already-covered skill (excludeCanonicals)', () => {
    const out = inferSkills(FIXTURE, ['javascript'], 'frontend_developer', new Set(['react']), id);
    expect(out.map((s) => s.canonical_name)).not.toContain('react');
  });

  it('dedups by target, keeping the highest-confidence source', () => {
    // both javascript(0.6) and typescript(0.55) → react; expect ONE react at 0.6
    const out = inferSkills(
      FIXTURE,
      ['javascript', 'typescript'],
      'frontend_developer',
      new Set(),
      id,
    );
    const reacts = out.filter((s) => s.canonical_name === 'react');
    expect(reacts).toHaveLength(1);
    expect(reacts[0].confidence).toBe(0.6);
    expect(reacts[0].inferred_from).toBe('javascript');
  });

  it('caps at MAX_INFERRED (5), highest-confidence first', () => {
    const many: SkillEdge[] = Array.from({ length: 8 }, (_, i) => ({
      from: 'python',
      to: `skill_${i}`,
      type: 'ecosystem' as const,
      confidence: 0.5 + i * 0.05,
      roles: ['data_analyst'],
    }));
    const out = inferSkills(many, ['python'], 'data_analyst', new Set(), id);
    expect(out).toHaveLength(5);
    expect(out[0].confidence).toBeGreaterThanOrEqual(out[4].confidence); // sorted desc
  });

  it('emits honest, structured fields + a localized reason', () => {
    const vi = inferSkills(FIXTURE, ['javascript'], 'frontend_developer', new Set(), (c) =>
      c.toUpperCase(),
    );
    const react = vi.find((s) => s.canonical_name === 'react')!;
    expect(react).toMatchObject({
      canonical_name: 'react',
      inferred_from: 'javascript',
      edge_type: 'ecosystem',
      confidence: 0.6,
    });
    expect(react.display_name).toBe('REACT'); // resolver applied
    expect(react.reason.length).toBeGreaterThan(0);
    const en = inferSkills(FIXTURE, ['javascript'], 'frontend_developer', new Set(), id, 'en');
    expect(en.find((s) => s.canonical_name === 'react')!.reason).toMatch(/you have/i);
  });
});

describe('skill-graph-edges.json dataset integrity', () => {
  it('every edge from/to is a real taxonomy canonical and every role is known', async () => {
    const edges = loadSkillEdges();
    expect(edges.length).toBeGreaterThan(0);

    const taxonomy = new SkillTaxonomyService();
    await taxonomy.onModuleInit();
    const normalizer = new SkillNormalizerService(taxonomy);

    const rubrics = new RoleRubricService();
    await rubrics.onModuleInit();
    const knownRoles = new Set<string>(rubrics.listRoleCodes());

    for (const e of edges) {
      const fromEntry = normalizer.getByCanonical(e.from);
      expect(fromEntry).toBeTruthy(); // from canonical must exist: ${e.from}
      const toEntry = normalizer.getByCanonical(e.to);
      expect(toEntry).toBeTruthy(); // to canonical must exist: ${e.to}
      expect(['ecosystem', 'adjacent', 'tooling']).toContain(e.type);
      expect(e.confidence).toBeGreaterThan(0);
      for (const r of e.roles) {
        const roleValid = r === '*' || knownRoles.has(r);
        expect(roleValid).toBe(true); // role must be known: ${r}
      }
    }
  });
});
