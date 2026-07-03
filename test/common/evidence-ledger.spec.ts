import { buildEvidenceLedger } from '../../src/common/services/evidence-ledger';
import { emptyCanonicalCv, CanonicalCvDocument } from '../../src/common/types/canonical-cv';
import { SkillTaxonomyService } from '../../src/common/services/skill-taxonomy.service';
import { SkillTextScannerService } from '../../src/common/services/skill-text-scanner.service';

// Controlled stub: emits a canonical when its needle appears (case-insensitive) in the text.
const SKILL_NEEDLES: Array<{ canonical: string; needle: string }> = [
  { canonical: 'react', needle: 'react' },
  { canonical: 'docker', needle: 'docker' },
  { canonical: 'python', needle: 'python' },
  { canonical: 'communication', needle: 'communication' },
  { canonical: 'nodejs', needle: 'node.js' },
];
const stubScan = (text: string) => {
  const t = text.toLowerCase();
  return SKILL_NEEDLES.filter((s) => t.includes(s.needle)).map((s) => ({
    canonical_name: s.canonical,
    matched_text: s.needle,
    occurrences: 1,
  }));
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

  // E1: real quote spans (evidence-ledger.ts:106-109 used to discard the matched section text —
  // this captures the actual bullet/sentence so the ledger can SHOW proof, not just cite a name).
  it('captures the real bullet as the quote for a skill demonstrated in experience', () => {
    const doc = docWith({
      experience: [
        {
          org: 'Acme',
          role: 'Backend Dev',
          start: '2022',
          end: '2024',
          location: null,
          bullets: ['Built REST APIs with Node.js for booking'],
        },
      ],
    });
    const led = buildEvidenceLedger(doc, stubScan, id, 2026);
    const nodejs = led.items.find((i) => i.skill_canonical === 'nodejs')!;
    expect(nodejs.sources[0]).toEqual({
      kind: 'experience',
      ref: 'Acme — Backend Dev',
      recency_year: 2024,
      quote: 'Built REST APIs with Node.js for booking',
    });
  });

  it('a skill only in the Skills section (a bare listing, not a sentence) gets quote: null', () => {
    const doc = docWith({ skills: { technical: ['Docker'], soft: [], languages: [], tools: [] } });
    const led = buildEvidenceLedger(doc, stubScan, id, 2026);
    const docker = led.items.find((i) => i.skill_canonical === 'docker')!;
    expect(docker.sources[0].quote).toBeNull();
  });

  it('trims a long matching bullet to 200 chars for the quote', () => {
    const longBullet = `Led a cross-functional team to design and ship a React-based dashboard that reduced manual reporting time by an enormous amount across every department in the company over several fiscal quarters, well past two hundred characters`;
    const doc = docWith({
      experience: [
        {
          org: 'Acme',
          role: null,
          start: null,
          end: null,
          location: null,
          bullets: [longBullet],
        },
      ],
    });
    const led = buildEvidenceLedger(doc, stubScan, id, 2026);
    const react = led.items.find((i) => i.skill_canonical === 'react')!;
    expect(react.sources[0].quote).toHaveLength(200);
    expect(react.sources[0].quote).toBe(longBullet.slice(0, 200));
  });

  it('summary quote is the sentence containing the match, not the whole paragraph', () => {
    const doc = docWith({
      summary:
        'Backend engineer with 3 years of experience.  Strong in Python and distributed systems.  Enjoys mentoring juniors.',
    });
    const led = buildEvidenceLedger(doc, stubScan, id, 2026);
    const python = led.items.find((i) => i.skill_canonical === 'python')!;
    expect(python.sources[0].quote).toBe('Strong in Python and distributed systems.');
  });

  // Fix 1: within a section, a label unit (project tech line, quote:null) used to be scanned
  // before the bullet units, so a shared `seen` dedup let the label claim the skill first and the
  // real bullet quote was lost. Quotable units must win when both match the same skill.
  it('a bullet quote wins over a project tech-line label for the same skill', () => {
    const doc = docWith({
      projects: [
        {
          name: 'Checkout Revamp',
          role: null,
          tech: ['React', 'Node.js'],
          bullets: ['Built the checkout UI with React'],
          link: null,
        },
      ],
    });
    const led = buildEvidenceLedger(doc, stubScan, id, 2026);
    const react = led.items.find((i) => i.skill_canonical === 'react')!;
    expect(react.sources).toHaveLength(1); // dedup within the section still holds
    expect(react.sources[0].quote).toBe('Built the checkout UI with React');
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
