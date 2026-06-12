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
    expect(canonicals('GitHub, GitLab')).toEqual(['git']);
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

  // ─── review fixes (adversarial review of the engine branch) ───────────────

  it('resolves versioned compound parts ("React 18 + Redux 4") — strip must not eat the split budget', () => {
    expect(canonicals('React 18 + Redux 4')).toEqual(['react', 'redux']);
    expect(canonicals('Spring Boot 3 + Java 17')).toEqual(['java']);
  });

  it('keeps per-part raw_input on version-strip fan-out (audit contract)', () => {
    const results = svc.normalizeMention('React 18 + Vue 3');
    const react = results.find((s) => s.canonical_name === 'react');
    const vue = results.find((s) => s.canonical_name === 'vue');
    expect(react?.raw_input).not.toBe('React 18 + Vue 3');
    expect(vue?.raw_input).not.toBe('React 18 + Vue 3');
  });

  it('protects slash-skills nested inside larger compounds ("Docker và CI/CD")', () => {
    expect(canonicals('Docker và CI/CD')).toEqual(['ci_cd', 'docker']);
    expect(canonicals('AWS & Terraform, CI/CD')).toEqual(
      expect.arrayContaining(['ci_cd', 'cloud_aws', 'infrastructure_as_code']),
    );
  });

  it('token fallback rejects prose around short alias keys (precision guard)', () => {
    for (const prose of [
      'updated my cv',
      'be on time',
      'next step',
      'ready to go',
      'rest of team',
      'team unity',
      'java island trip',
    ]) {
      expect(canonicals(prose)).toEqual([]);
    }
    // ...while skill+qualifier phrases still resolve
    expect(canonicals('k8s cluster')).toEqual(['kubernetes']);
    expect(canonicals('Excel cơ bản')).toEqual(['excel']);
  });

  it('normalizeMany keeps the strongest evidence per canonical (not first-seen)', () => {
    const out = svc.normalizeMany(['javscript', 'JavaScript']);
    const js = out.find((s) => s.canonical_name === 'javascript');
    expect(js?.matched_via).toBe('exact');
    expect(js?.confidence).toBe(1.0);
  });

  // Live-verified misses 2026-06-11 (prod E2E): phrase variants failed the whole-phrase
  // lookup and the token fallback rejects non-qualifier neighbors ('authentication',
  // 'design', 'core'...). Each row below was dropped as not_in_taxonomy on a real CV/JD.
  it.each([
    ['JWT Authentication', 'authentication_authorization'],
    ['Google OAuth 2.0', 'authentication_authorization'],
    ['Entity Framework Core', 'orm'],
    ['EF Core', 'orm'],
    ['RESTful API design', 'rest_api'],
    ['CI/CD pipelines', 'ci_cd'],
  ])('normalizes the live-miss phrase "%s" → %s', (raw, canonical) => {
    expect(canonicals(raw)).toContain(canonical);
  });

  // ── 7-role probe findings 2026-06-11 (strong on-target CVs losing credit) ──

  // Paren-expansion: "A (B, C)" must credit A and every paren part that resolves.
  it.each([
    ['JavaScript (ES6+)', 'javascript'],
    ['API testing (Postman)', 'api_testing'],
    ['Advanced Excel (PivotTable, Power Query)', 'excel'],
    ['Statistics (hypothesis testing, A/B testing)', 'statistics'],
    ['English (IELTS 6.5)', 'english_proficiency'],
    ['Computer vision (OpenCV)', 'computer_vision'],
    ['NLP (Hugging Face Transformers)', 'nlp'],
    ['Firebase (Auth, FCM, Crashlytics)', 'firebase'],
    ['AWS (EC2, S3, RDS, IAM)', 'cloud_aws'],
  ])('paren-expansion: "%s" → %s', (raw, canonical) => {
    expect(canonicals(raw)).toContain(canonical);
  });

  it('paren-expansion credits BOTH head and resolvable paren parts', () => {
    const out = canonicals('Linux (Ubuntu, Bash scripting)');
    expect(out).toContain('linux');
  });

  // New token-qualifiers: trailing tool-words must not block a single known skill.
  it.each([
    ['Python scripting', 'python'],
    ['Cypress E2E', 'frontend_testing'],
  ])('qualifier tokens: "%s" → %s', (raw, canonical) => {
    expect(canonicals(raw)).toContain(canonical);
  });

  // Alias additions — every row was dropped as not_in_taxonomy in the 7-role probe.
  it.each([
    ['Selenium WebDriver', 'test_automation'],
    ['REST API integration', 'rest_api'],
    ['REST API design', 'rest_api'],
    ['Responsive web design', 'responsive_design'],
    ['Database schema design', 'database_design'],
    ['System design basics', 'system_design'],
    ['Bug reporting', 'bug_tracking_jira'],
    ['Espresso UI testing', 'mobile_testing'],
    ['English', 'english_proficiency'],
    ['Keras', 'pytorch_tensorflow'],
    ['Express', 'node_js'],
    ['Hugging Face', 'nlp'],
    ['Advanced Excel', 'excel'],
    ['A/B testing', 'statistics'],
    ['Lighthouse performance tuning', 'web_performance'],
    ['WCAG accessibility', 'accessibility_a11y'],
  ])('probe alias: "%s" → %s', (raw, canonical) => {
    expect(canonicals(raw)).toContain(canonical);
  });

  // Ownership MOVES (taxonomy mis-wiring): the canonical that NAMES the tool owns it.
  it('moves "PyTorch"/"TensorFlow" to pytorch_tensorflow (was machine_learning — every AI/ML CV missed the L4 REQUIRED)', () => {
    expect(canonicals('PyTorch')).toContain('pytorch_tensorflow');
    expect(canonicals('TensorFlow')).toContain('pytorch_tensorflow');
  });

  it('moves "Jira" to bug_tracking_jira (was agile_scrum — QA/mobile CVs missed the REQUIRED tracker)', () => {
    expect(canonicals('Jira')).toContain('bug_tracking_jira');
  });
});
