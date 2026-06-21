import { readFileSync } from 'fs';
import { join } from 'path';
import { CURATION_FLAGS } from '../../../src/modules/resource-curation/curation-scoring';

const p = readFileSync(join(process.cwd(), 'prompts', 'resource_curation_v1.md'), 'utf8');

describe('resource_curation_v1 prompt contract', () => {
  it('starts with the system frontmatter the loader expects', () => {
    expect(p.startsWith('---')).toBe(true);
    expect(p).toMatch(/system:/);
  });

  it('declares the {{resource}} input variable', () => {
    expect(p).toContain('{{resource}}');
  });

  it('anchors every CRAAP dimension with a 0-3 level scale', () => {
    for (const dim of ['relevance', 'authority', 'currency', 'accuracy', 'purpose']) {
      expect(p).toContain(dim);
    }
    expect(p).toContain('level');
    expect(p).toMatch(/0-3/);
  });

  it('lists exactly the allowed flag vocabulary (matches CURATION_FLAGS)', () => {
    for (const f of CURATION_FLAGS) expect(p).toContain(f);
  });

  it('enforces anti-fabrication + no-URL-in-description guards', () => {
    const low = p.toLowerCase();
    expect(low).toMatch(/không bịa|không suy đoán/);
    expect(low).toMatch(/không.*url/);
    expect(low).toMatch(/chỉ.*đánh giá.*input|chỉ đánh giá dựa trên/);
  });

  it('specifies the output JSON shape (craap.level + flags + description)', () => {
    for (const field of ['craap', 'rationale', 'flags', 'description']) expect(p).toContain(field);
  });
});
