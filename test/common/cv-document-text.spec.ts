import { documentToPlainText } from '../../src/common/services/cv-document-text';
import { CanonicalCvDocument, emptyCanonicalCv } from '../../src/common/types/canonical-cv';

const fullDoc: CanonicalCvDocument = {
  language: 'en',
  contact: {
    name: 'Nguyen Van A',
    email: 'vana@example.com',
    phone: '0901234567',
    location: 'Ho Chi Minh City',
    links: [
      { label: 'GitHub', url: 'https://github.com/vana' },
      { label: 'LinkedIn', url: 'https://linkedin.com/in/vana' },
    ],
  },
  summary: 'Full-stack developer with 3 years experience.',
  education: [
    {
      school: 'FPT University',
      degree: 'Bachelor',
      field: 'Software Engineering',
      start: '09/2020',
      end: '07/2024',
      gpa: '3.5/4.0',
      highlights: ["Dean's List 2022", 'Capstone: AI-powered CV tool'],
    },
  ],
  experience: [
    {
      org: 'TechCorp Vietnam',
      role: 'Backend Developer',
      start: '01/2024',
      end: 'Present',
      location: 'Ho Chi Minh City',
      bullets: [
        'Designed REST APIs serving 10k daily active users.',
        'Migrated PostgreSQL schema reducing query time 35%.',
      ],
    },
  ],
  projects: [
    {
      name: 'SkillBridge',
      role: 'Lead',
      tech: ['NestJS', 'React', 'PostgreSQL'],
      bullets: ['Built AI-powered CV diagnosis module.', 'Deployed to Cloud Run.'],
      link: 'https://skillbridge.vn',
    },
  ],
  skills: {
    technical: ['TypeScript', 'NestJS', 'React'],
    soft: ['Communication', 'Teamwork'],
    languages: ['English (IELTS 7.0)', 'Vietnamese (Native)'],
    tools: ['Docker', 'Git', 'Figma'],
  },
  certifications: [{ name: 'AWS Solutions Architect', issuer: 'Amazon', date: '2023' }],
  activities: [
    {
      org: 'Google Developer Student Club',
      role: 'Technical Lead',
      bullets: ['Organized 5 workshops on web development.'],
    },
  ],
};

describe('documentToPlainText', () => {
  it('empty doc → empty string', () => {
    const result = documentToPlainText(emptyCanonicalCv());
    expect(result).toBe('');
  });

  it('full doc contains org name', () => {
    const result = documentToPlainText(fullDoc);
    expect(result).toContain('TechCorp Vietnam');
  });

  it('full doc contains a bullet', () => {
    const result = documentToPlainText(fullDoc);
    expect(result).toContain('Designed REST APIs serving 10k daily active users.');
  });

  it('full doc contains a skill', () => {
    const result = documentToPlainText(fullDoc);
    expect(result).toContain('TypeScript');
  });

  it('full doc contains project name', () => {
    const result = documentToPlainText(fullDoc);
    expect(result).toContain('SkillBridge');
  });

  it('sections with empty arrays produce no dangling headers', () => {
    const minimalDoc: CanonicalCvDocument = {
      ...emptyCanonicalCv(),
      contact: {
        name: 'Test User',
        email: null,
        phone: null,
        location: null,
        links: [],
      },
      summary: '',
      experience: [],
      projects: [],
      certifications: [],
      activities: [],
    };
    const result = documentToPlainText(minimalDoc);
    // Should not contain empty section-header lines that produce dangling labels
    expect(result).not.toMatch(/^\s*Experience\s*$/m);
    expect(result).not.toMatch(/^\s*Projects\s*$/m);
    expect(result).not.toMatch(/^\s*Certifications\s*$/m);
  });

  it('full doc contains contact name and email', () => {
    const result = documentToPlainText(fullDoc);
    expect(result).toContain('Nguyen Van A');
    expect(result).toContain('vana@example.com');
  });

  it('full doc contains school name', () => {
    const result = documentToPlainText(fullDoc);
    expect(result).toContain('FPT University');
  });

  it('full doc contains certification name', () => {
    const result = documentToPlainText(fullDoc);
    expect(result).toContain('AWS Solutions Architect');
  });
});
