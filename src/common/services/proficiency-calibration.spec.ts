import {
  PROFICIENCY_TO_LEVEL,
  Proficiency,
  qualifierToProficiency,
  capForEvidence,
} from './proficiency-calibration';

describe('proficiency-calibration', () => {
  describe('PROFICIENCY_TO_LEVEL (relocated verbatim — must equal skill-diff’s table)', () => {
    it('maps the 5-value enum to 1..5', () => {
      expect(PROFICIENCY_TO_LEVEL).toEqual({
        BEGINNER: 1,
        NOVICE: 2,
        INTERMEDIATE: 3,
        ADVANCED: 4,
        EXPERT: 5,
      });
    });

    it('is strictly monotonic across the canonical order', () => {
      const order: Proficiency[] = ['BEGINNER', 'NOVICE', 'INTERMEDIATE', 'ADVANCED', 'EXPERT'];
      const lv = order.map((p) => PROFICIENCY_TO_LEVEL[p]);
      expect(lv).toEqual([...lv].sort((a, b) => a - b));
      expect(new Set(lv).size).toBe(5);
    });
  });

  describe('qualifierToProficiency (EN + VN, word-boundary, null when absent)', () => {
    it.each<[string, Proficiency]>([
      ['basic React', 'BEGINNER'],
      ['cơ bản', 'BEGINNER'],
      ['familiar with Java', 'NOVICE'],
      ['làm quen với Go', 'NOVICE'],
      ['intermediate SQL', 'INTERMEDIATE'],
      ['khá tốt', 'INTERMEDIATE'],
      ['strong in Python', 'ADVANCED'],
      ['thành thạo Docker', 'ADVANCED'],
      ['expert-level k8s', 'EXPERT'],
      ['chuyên sâu về AWS', 'EXPERT'],
    ])('"%s" → %s', (text, expected) => {
      expect(qualifierToProficiency(text)).toBe(expected);
    });

    it('returns null when no qualifier is present (≠ inflation)', () => {
      expect(qualifierToProficiency('React, Node.js, PostgreSQL')).toBeNull();
      expect(qualifierToProficiency('')).toBeNull();
    });

    it('does NOT match a qualifier embedded inside a longer word (boundary)', () => {
      expect(qualifierToProficiency('masterclass attendee')).toBeNull();
      expect(qualifierToProficiency('basics of CS')).toBeNull();
    });

    it('picks the highest-specificity qualifier when several are present', () => {
      expect(qualifierToProficiency('basic but now expert in React')).toBe('EXPERT');
    });
  });

  describe('capForEvidence (anti-inflate; NOT wired to scoring — telemetry/gate only)', () => {
    it('caps listed_only/mentioned at INTERMEDIATE', () => {
      expect(capForEvidence('EXPERT', 'listed_only')).toBe('INTERMEDIATE');
      expect(capForEvidence('ADVANCED', 'mentioned')).toBe('INTERMEDIATE');
      expect(capForEvidence('NOVICE', 'listed_only')).toBe('NOVICE'); // already below cap
      expect(capForEvidence('INTERMEDIATE', 'mentioned')).toBe('INTERMEDIATE');
    });

    it('leaves demonstrated evidence uncapped', () => {
      expect(capForEvidence('EXPERT', 'demonstrated')).toBe('EXPERT');
      expect(capForEvidence('ADVANCED', 'demonstrated')).toBe('ADVANCED');
    });
  });
});
