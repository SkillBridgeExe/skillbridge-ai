import {
  classifyRole,
  isAdvantageLine,
  normalizeCompanyName,
  scrubPii,
} from '../../../src/modules/jobs/ingest/ingest-normalizers';

describe('JD ingest normalizers (pure)', () => {
  describe('scrubPii', () => {
    it('removes emails, VN phones, and chat handles', () => {
      const input =
        'Contact: hr@samplesolutions.vn - 0901234567, Zalo: 0987 654 321, hoặc +84 28 1234 5678';
      const out = scrubPii(input);
      expect(out).not.toContain('hr@samplesolutions.vn');
      expect(out).not.toContain('0901234567');
      expect(out).not.toContain('0987 654 321');
      expect(out).toContain('[email-removed]');
      expect(out).toContain('[phone-removed]');
    });

    it('leaves skill text untouched', () => {
      const input = 'Yêu cầu: ReactJS, Node.js 18, C++ và C#.';
      expect(scrubPii(input)).toBe(input);
    });

    it('does not eat plain years or small numbers', () => {
      const input = 'Thành lập 2015, hơn 300 nhân sự, lương 13 tháng';
      expect(scrubPii(input)).toBe(input);
    });

    it('removes international phone numbers (+1, +65, +44), not just +84', () => {
      const out = scrubPii('Call +1 415 555 0123 or +65 9123 4567 or +44 20 7946 0958');
      expect(out).not.toMatch(/\+1 415|\+65 9123|\+44 20/);
      expect(out).toContain('[phone-removed]');
    });
  });

  describe('normalizeCompanyName', () => {
    it('collapses legal-suffix variants to the same dedup key', () => {
      expect(normalizeCompanyName('FPT Software Co., Ltd.')).toBe('fpt software');
      expect(normalizeCompanyName('Công ty TNHH FPT Software')).toBe('fpt software');
      expect(normalizeCompanyName('FPT SOFTWARE')).toBe('fpt software');
    });

    it('handles JSC + Vietnam suffixes', () => {
      expect(normalizeCompanyName('Sample Solutions JSC')).toBe('sample solutions');
      expect(normalizeCompanyName('Sample Solutions Vietnam')).toBe('sample solutions');
    });

    it('keeps distinct companies distinct', () => {
      expect(normalizeCompanyName('FPT Software')).not.toBe(normalizeCompanyName('FPT Telecom'));
    });
  });

  describe('classifyRole', () => {
    it.each([
      ['Fresher Frontend Developer (ReactJS)', 'frontend_developer'],
      ['React Developer', 'frontend_developer'], // regression: `reactjs?` typo broke this
      ['Senior React Developer', 'frontend_developer'],
      ['Junior Backend Developer (NodeJS)', 'backend_developer'],
      ['Fullstack Engineer', 'fullstack_developer'],
      ['Full-stack Developer (React + Node)', 'fullstack_developer'],
      ['Mobile Developer (Flutter)', 'mobile_developer'],
      ['DevOps Engineer', 'devops_engineer'],
      ['QA/QC Engineer', 'qa_tester'],
      ['Nhân viên kiểm thử phần mềm', 'qa_tester'],
      ['AI Engineer (LLM)', 'ai_ml_engineer'],
      ['Machine Learning Engineer (Android on-device)', 'ai_ml_engineer'], // AI beats mobile token
      ['Data Analyst', 'data_analyst'],
      ['Software Engineer', 'backend_developer'], // generic fallback
      ['Nhân viên kinh doanh', null], // non-IT → unclassified
    ])('"%s" → %s', (title, expected) => {
      expect(classifyRole(title)).toBe(expected);
    });
  });

  describe('isAdvantageLine', () => {
    it('detects VN + EN advantage phrasing', () => {
      expect(isAdvantageLine('Biết TypeScript là lợi thế')).toBe(true);
      expect(isAdvantageLine('Ưu tiên ứng viên biết Docker')).toBe(true);
      expect(isAdvantageLine('Knowledge of Redis or Kafka is a plus.')).toBe(true);
      expect(isAdvantageLine('Experience with AWS preferred')).toBe(true);
    });

    it('does not flag normal requirement lines', () => {
      expect(isAdvantageLine('Nắm vững JavaScript, HTML, CSS')).toBe(false);
      expect(isAdvantageLine('Build REST API with NestJS')).toBe(false);
    });
  });
});
