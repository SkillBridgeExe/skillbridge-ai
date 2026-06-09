import { buildEvidenceLedger } from '../../src/common/services/evidence-ledger';
import { emptyCanonicalCv, CanonicalCvDocument } from '../../src/common/types/canonical-cv';
import { SkillTaxonomyService } from '../../src/common/services/skill-taxonomy.service';
import { SkillTextScannerService } from '../../src/common/services/skill-text-scanner.service';

// Controlled stub: emits a canonical when its name appears (case-insensitive) in the text.
const stubScan = (text: string) => {
  const t = text.toLowerCase();
  return ['react', 'docker', 'python', 'communication']
    .filter((c) => t.includes(c))
    .map((c) => ({ canonical_name: c, matched_text: c, occurrences: 1 }));
};
const id = (c: string) => c;

function docWith(partial: Partial<CanonicalCvDocument>): CanonicalCvDocument {
  return { ...emptyCanonicalCv('en'), ...partial };
}

describe('buildEvidenceLedger (pure)', () => {
  it('marks a skill in a dated experience bullet as demonstrated, with recency', () => {
    const doc = docWith({
      experience: [
        {
          org: 'Acme',
          role: 'Dev',
          start: '2022',
          end: '2024',
          location: null,
          bullets: ['Built a React dashboard'],
        },
      ],
    });
    const led = buildEvidenceLedger(doc, stubScan, id, 2026);
    const react = led.items.find((i) => i.skill_canonical === 'react')!;
    expect(react.strength).toBe('demonstrated');
    expect(react.most_recent_year).toBe(2024);
    expect(react.sources[0].kind).toBe('experience');
    expect(led.evidence_gap).not.toContain('react');
  });

  it('marks a skill only in the skills list as listed_only → evidence_gap', () => {
    const doc = docWith({ skills: { technical: ['Docker'], soft: [], languages: [], tools: [] } });
    const led = buildEvidenceLedger(doc, stubScan, id, 2026);
    expect(led.items.find((i) => i.skill_canonical === 'docker')!.strength).toBe('listed_only');
    expect(led.evidence_gap).toContain('docker');
  });

  it('marks a skill only in the summary as mentioned (not a gap)', () => {
    const doc = docWith({ summary: 'Backend engineer focused on Python services.' });
    const led = buildEvidenceLedger(doc, stubScan, id, 2026);
    expect(led.items.find((i) => i.skill_canonical === 'python')!.strength).toBe('mentioned');
    expect(led.evidence_gap).not.toContain('python');
  });

  it('prefers demonstrated when a skill is both shown and listed (no double, not a gap)', () => {
    const doc = docWith({
      experience: [
        {
          org: 'Acme',
          role: null,
          start: null,
          end: '2023',
          location: null,
          bullets: ['Shipped React app'],
        },
      ],
      skills: { technical: ['React'], soft: [], languages: [], tools: [] },
    });
    const led = buildEvidenceLedger(doc, stubScan, id, 2026);
    const react = led.items.find((i) => i.skill_canonical === 'react')!;
    expect(react.strength).toBe('demonstrated');
    expect(react.sources.length).toBe(2); // experience + skills_list
    expect(led.evidence_gap).not.toContain('react');
  });

  it('resolves "Present"/"Hiện tại" end dates to nowYear', () => {
    const doc = docWith({
      experience: [
        {
          org: 'Acme',
          role: null,
          start: '2024',
          end: 'Present',
          location: null,
          bullets: ['React work'],
        },
      ],
    });
    expect(buildEvidenceLedger(doc, stubScan, id, 2026).items[0].most_recent_year).toBe(2026);
  });

  it('returns empty ledger for an empty CV', () => {
    expect(buildEvidenceLedger(emptyCanonicalCv('en'), stubScan, id, 2026)).toEqual({
      items: [],
      evidence_gap: [],
    });
  });

  it('integration: real scanner finds a demonstrated skill in a bullet', async () => {
    const taxonomy = new SkillTaxonomyService();
    await taxonomy.onModuleInit();
    const scanner = new SkillTextScannerService(taxonomy);
    scanner.onModuleInit();
    const doc = docWith({
      experience: [
        {
          org: 'Acme',
          role: 'Frontend',
          start: '2023',
          end: '2025',
          location: null,
          bullets: ['Built UIs with ReactJS and TypeScript'],
        },
      ],
    });
    const led = buildEvidenceLedger(
      doc,
      (t) => scanner.scan(t),
      (c) => c,
      2026,
    );
    expect(led.items.find((i) => i.skill_canonical === 'react')?.strength).toBe('demonstrated');
  });
});
