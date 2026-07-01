import { mergeStoryItems } from './story-merge';
import { CanonicalCvDocument, emptyCanonicalCv } from '../../common/types/canonical-cv';

describe('mergeStoryItems', () => {
  it('appends a new project and reports applied count', () => {
    const doc = emptyCanonicalCv('vi');
    const r = mergeStoryItems(doc, {
      projects: [
        { name: 'Shop Online', role: null, tech: ['react'], bullets: ['built it'], link: null },
      ],
    });
    expect(r.doc.projects.length).toBe(1);
    expect(r.applied.projects).toBe(1);
    expect(r.skipped_duplicates).toEqual([]);
  });

  it('skips a project whose name already exists (case-insensitive) and reports it', () => {
    const doc = emptyCanonicalCv('vi');
    doc.projects.push({ name: 'Shop Online', role: null, tech: [], bullets: [], link: null });
    const r = mergeStoryItems(doc, {
      projects: [{ name: 'shop online', role: null, tech: ['react'], bullets: [], link: null }],
    });
    expect(r.doc.projects.length).toBe(1); // not duplicated
    expect(r.applied.projects).toBe(0);
    expect(r.skipped_duplicates).toEqual([{ section: 'projects', name: 'shop online' }]);
  });

  it('skips an empty-name project (anti-empty)', () => {
    const doc = emptyCanonicalCv('vi');
    const r = mergeStoryItems(doc, {
      projects: [{ name: '  ', role: null, tech: [], bullets: [], link: null }],
    });
    expect(r.doc.projects.length).toBe(0);
    expect(r.applied.projects).toBe(0);
  });

  it('merges certifications with the same dedup rule', () => {
    const doc = emptyCanonicalCv('vi');
    doc.certifications.push({ name: 'TOEIC', issuer: 'ETS', date: null });
    const r = mergeStoryItems(doc, {
      certifications: [
        { name: 'TOEIC', issuer: 'ETS', date: '2022' }, // dup
        { name: 'AWS Certified', issuer: 'Amazon Web Services', date: null }, // new
      ],
    });
    expect(r.doc.certifications.length).toBe(2);
    expect(r.applied.certifications).toBe(1);
    expect(r.skipped_duplicates).toContainEqual({ section: 'certifications', name: 'TOEIC' });
  });

  it('does NOT put role_code into the doc and does NOT mutate the input', () => {
    const doc = emptyCanonicalCv('vi');
    const before = JSON.stringify(doc);
    const r = mergeStoryItems(doc, {
      role_code: 'frontend_developer',
      projects: [{ name: 'X', role: null, tech: [], bullets: [], link: null }],
    });
    expect(JSON.stringify(doc)).toBe(before); // input untouched
    expect(JSON.stringify(r.doc)).not.toContain('frontend_developer'); // role not in doc
  });

  it('dedups two same-named projects within one selected.projects batch', () => {
    const doc = emptyCanonicalCv('vi');
    const r = mergeStoryItems(doc, {
      projects: [
        { name: 'Portfolio', role: null, tech: [], bullets: [], link: null },
        { name: 'portfolio', role: null, tech: ['react'], bullets: [], link: null },
      ],
    });
    expect(r.doc.projects.length).toBe(1);
    expect(r.applied.projects).toBe(1);
    expect(r.skipped_duplicates).toEqual([{ section: 'projects', name: 'portfolio' }]);
  });

  it('handles a malformed doc missing projects/certifications arrays without throwing', () => {
    const malformed = {} as unknown as CanonicalCvDocument;
    const r = mergeStoryItems(malformed, {
      projects: [{ name: 'X', role: null, tech: [], bullets: [], link: null }],
    });
    expect(r.applied.projects).toBe(1);
    expect(r.doc.projects.length).toBe(1);
    expect(r.doc.certifications).toEqual([]);
  });
});
