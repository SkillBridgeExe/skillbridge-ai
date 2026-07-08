import * as skillsData from '../../../data/skills-pilot.json';
import { SkillTaxonomyService } from './skill-taxonomy.service';

interface Entry {
  canonical_name: string;
  display_name: string;
  aliases?: string[];
}

describe('skills-pilot.json integrity', () => {
  it('no normalized key maps to two different canonicals', () => {
    const data = skillsData as unknown as { skills: Entry[] };
    const entries = data.skills;
    const keyToCanonical = new Map<string, string>();
    const conflicts: string[] = [];
    for (const e of entries) {
      const surfaces = [e.canonical_name, e.display_name, ...(e.aliases ?? [])];
      for (const s of surfaces) {
        const k = SkillTaxonomyService.normalizeKey(s);
        const prev = keyToCanonical.get(k);
        if (prev && prev !== e.canonical_name) {
          conflicts.push(`key "${k}": ${prev} vs ${e.canonical_name} (from "${s}")`);
        } else if (!prev) {
          keyToCanonical.set(k, e.canonical_name);
        }
      }
    }
    expect(conflicts).toEqual([]);
  });
});
