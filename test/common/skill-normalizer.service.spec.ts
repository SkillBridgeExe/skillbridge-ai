import { SkillTaxonomyService } from '../../src/common/services/skill-taxonomy.service';
import { SkillNormalizerService } from '../../src/common/services/skill-normalizer.service';

/**
 * Stage-0 pre-normalize anchors (blueprint step 4) — offline, real taxonomy from data/.
 * Mirrors eval-mentions rows so a regression here = a regression on the gate.
 */
describe('SkillNormalizerService stage-0', () => {
  let svc: SkillNormalizerService;

  beforeAll(async () => {
    const taxonomy = new SkillTaxonomyService();
    await taxonomy.onModuleInit();
    svc = new SkillNormalizerService(taxonomy);
  });

  const canonicals = (mention: string): string[] =>
    svc
      .normalizeMention(mention)
      .map((s) => s.canonical_name)
      .filter((c): c is string => c !== null)
      .sort();

  it('splits compounds into every named skill', () => {
    expect(canonicals('React + Redux')).toEqual(['react', 'redux']);
    expect(canonicals('HTML, CSS, JavaScript')).toEqual(['css', 'html', 'javascript']);
    expect(canonicals('Docker & Kubernetes')).toEqual(['docker', 'kubernetes']);
    expect(canonicals('Swift/Kotlin')).toEqual(['kotlin', 'swift']);
  });

  it('dedupes compound parts that resolve to the same canonical', () => {
    expect(canonicals('Node.js và Express')).toEqual(['node_js']);
    expect(canonicals('SQL Server, MySQL')).toEqual(['sql']);
    expect(canonicals('Jest và Cypress')).toEqual(['frontend_testing']);
  });

  it('NEVER splits phrases that resolve whole ("CI/CD", "TCP/IP")', () => {
    expect(canonicals('CI/CD')).toEqual(['ci_cd']);
    expect(canonicals('TCP/IP')).toEqual(['networking']);
  });

  it('strips trailing versions before matching', () => {
    expect(canonicals('Tailwind 3')).toEqual(['css']);
    expect(canonicals('Go 1.21')).toEqual(['golang']);
    expect(canonicals('Python 3.11')).toEqual(['python']);
    expect(canonicals('ES2022')).toEqual(['javascript']);
  });

  it('expands Vietnamese umbrella phrases to their concrete skills', () => {
    expect(canonicals('Lập trình web')).toEqual(['css', 'html', 'javascript']);
    expect(canonicals('Lập trình di động')).toEqual(['flutter', 'kotlin', 'react_native', 'swift']);
  });

  it('token fallback rescues short phrases with an exact key inside (no fuzzy per token)', () => {
    expect(canonicals('k8s cluster')).toEqual(['kubernetes']);
    expect(canonicals('excel hơi biết')).toEqual(['excel']);
  });

  it('fuzzy guard kills the eval-verified short-key false positives', () => {
    for (const negative of ['Canva', 'Vercel', 'Word', 'SEO', 'R']) {
      expect(canonicals(negative)).toEqual([]);
    }
  });

  it('keeps legitimate fuzzy matches working under the guard', () => {
    expect(canonicals('dockr')).toEqual(['docker']); // len 5 → d≤1
    expect(canonicals('tyepscript')).toEqual(['typescript']); // len 10 → d≤2
    expect(canonicals('kubernets')).toEqual(['kubernetes']);
  });

  it('does not invent matches for true negatives', () => {
    expect(canonicals('Nguyen Van A')).toEqual([]);
    expect(canonicals('làm việc chăm chỉ')).toEqual([]);
  });
});
