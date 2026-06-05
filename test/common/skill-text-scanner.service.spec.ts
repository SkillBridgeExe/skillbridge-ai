import { SkillTaxonomyService } from '../../src/common/services/skill-taxonomy.service';
import { SkillTextScannerService } from '../../src/common/services/skill-text-scanner.service';

describe('SkillTextScannerService (gazetteer over real taxonomy)', () => {
  let scanner: SkillTextScannerService;

  beforeAll(async () => {
    const taxonomy = new SkillTaxonomyService();
    await taxonomy.onModuleInit(); // fs-backed, DB-less
    scanner = new SkillTextScannerService(taxonomy);
    scanner.buildMatchers();
  });

  const canonicals = (text: string): string[] =>
    scanner
      .scan(text)
      .map((s) => s.canonical_name)
      .sort();

  it('finds literally-named skills in a VN JD', () => {
    const jd =
      'Phát triển giao diện web bằng ReactJS, HTML, CSS, JavaScript. Làm việc với REST API, Git.';
    const found = canonicals(jd);
    expect(found).toEqual(
      expect.arrayContaining(['react', 'html', 'css', 'javascript', 'rest_api', 'git']),
    );
  });

  it('handles symbol-bearing skills (C++, C#, Node.js) via boundary lookarounds', () => {
    const found = canonicals('Yêu cầu C++ hoặc C#, backend Node.js.');
    expect(found).toEqual(expect.arrayContaining(['cpp', 'node_js']));
  });

  it('does not fire substrings inside larger words', () => {
    // "javac" must not match "java"; "scalable" must not match anything spurious.
    const found = canonicals('We compile with javac and build scalable systems.');
    expect(found).not.toContain('java');
  });

  it('2-char letter-only forms match case-sensitively only', () => {
    // lowercase prose "we go fast" must not fire golang (alias "Go", if present).
    const lower = canonicals('we go fast and keep it simple');
    expect(lower).not.toContain('golang');
  });

  it('counts distinct canonicals once with occurrences aggregated', () => {
    const result = scanner.scan('React, React và ReactJS — đều là React.');
    const react = result.find((s) => s.canonical_name === 'react');
    expect(react).toBeDefined();
    expect(react!.occurrences).toBeGreaterThanOrEqual(3);
    expect(result.filter((s) => s.canonical_name === 'react')).toHaveLength(1);
  });

  it('returns [] for skill-free prose', () => {
    expect(scanner.scan('Quyền lợi: lương tháng 13, bảo hiểm đầy đủ, du lịch hàng năm.')).toEqual(
      [],
    );
  });
});
