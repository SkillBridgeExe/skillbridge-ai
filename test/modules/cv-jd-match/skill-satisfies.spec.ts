import {
  findSatisfying,
  loadSatisfiesEdges,
  SatisfiesEdge,
} from '../../../src/modules/cv-jd-match/skill-satisfies';
import { SkillTaxonomyService } from '../../../src/common/services/skill-taxonomy.service';
import { SkillNormalizerService } from '../../../src/common/services/skill-normalizer.service';

/**
 * Satisfies-edges feed the SCORE (unlike skill-graph, which is display-only) — so the
 * curated set must stay trivially auditable: real canonicals only, no self-edges, and
 * strictly flat (a child may never itself be a parent → no transitive credit chains).
 */
describe('skill-satisfies — curated credit edges', () => {
  it('every edge endpoint is a real taxonomy canonical, no self-edge, no chaining', async () => {
    const taxonomy = new SkillTaxonomyService();
    await taxonomy.onModuleInit();
    const normalizer = new SkillNormalizerService(taxonomy);
    const edges = loadSatisfiesEdges();
    expect(edges.length).toBeGreaterThan(0);
    const parents = new Set(edges.map((e) => e.parent));
    for (const e of edges) {
      expect(normalizer.getByCanonical(e.child)).toBeDefined();
      expect(normalizer.getByCanonical(e.parent)).toBeDefined();
      expect(e.child).not.toBe(e.parent);
      // flat 2 tầng: child không bao giờ đồng thời là parent (chặn chaining từ data)
      expect(parents.has(e.child)).toBe(false);
    }
  });

  it('findSatisfying picks the HIGHEST-level child and returns null when nothing applies', () => {
    const edges: SatisfiesEdge[] = [
      { child: 'sql_server', parent: 'sql' },
      { child: 'postgresql', parent: 'sql' },
    ];
    const cv = new Map([
      ['sql_server', { level: 3 }],
      ['postgresql', { level: 4 }],
    ]);
    expect(findSatisfying('sql', cv, edges)).toEqual({ child: 'postgresql', level: 4 });
    expect(findSatisfying('docker', cv, edges)).toBeNull();
    expect(findSatisfying('sql', new Map(), edges)).toBeNull();
  });
});
