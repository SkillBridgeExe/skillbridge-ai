import {
  buildInterviewOpening,
  fingerprintInterviewQuestion,
  isRepeatedInterviewQuestion,
  resolveInterviewIdentity,
} from './interview-context';

describe('interview context identity', () => {
  it('uses the structured CV name and an explicitly named JD employer', () => {
    const identity = resolveInterviewIdentity({
      cv: {
        parsedJson: {
          contact: { name: 'Nguyễn An' },
        },
        targetRole: 'backend_engineer',
        title: 'Backend CV',
      },
      jd: {
        title: 'Backend Engineer at FPT Software',
        rawText: 'Company: FPT Software\nWe are hiring a Backend Engineer.',
        parsedJson: null,
      },
      targetRole: 'backend_engineer',
    });

    expect(identity).toEqual({
      candidateName: 'Nguyễn An',
      employerName: 'FPT Software',
      jobTitle: 'Backend Engineer',
      employerSource: 'jd',
    });
  });

  it('does not invent an employer when the JD does not identify one', () => {
    const identity = resolveInterviewIdentity({
      cv: { parsedJson: null, targetRole: null, title: null },
      jd: {
        title: 'Junior Frontend Engineer',
        rawText: 'Build accessible React interfaces for our product.',
        parsedJson: null,
      },
      targetRole: 'frontend_engineer',
    });

    expect(identity).toEqual({
      candidateName: null,
      employerName: null,
      jobTitle: 'Junior Frontend Engineer',
      employerSource: 'unknown',
    });
  });

  it('uses an explicitly labelled name from CV text when structured contact data is empty', () => {
    const identity = resolveInterviewIdentity({
      cv: {
        parsedJson: { contact: { name: null } },
        parsedText: 'Name: Tran Minh Anh\nEmail: anh@example.com\nFrontend Intern',
      },
      jd: { title: 'Frontend Intern', rawText: null, parsedJson: null },
      targetRole: 'frontend_developer',
    });

    expect(identity.candidateName).toBe('Tran Minh Anh');
  });

  it('builds a neutral Vietnamese opening for a role-only interview', () => {
    const opening = buildInterviewOpening(
      {
        candidateName: null,
        employerName: null,
        jobTitle: 'Junior Frontend Engineer',
        employerSource: 'unknown',
      },
      'vi',
      'ROLE_ONLY',
    );

    expect(opening).toContain('Junior Frontend Engineer');
    expect(opening).not.toMatch(/\b(?:JD|CV)\b|job description/i);
  });

  it('mentions only the CV in a CV-only opening', () => {
    const opening = buildInterviewOpening(
      {
        candidateName: 'Minh',
        employerName: null,
        jobTitle: 'Frontend Developer',
        employerSource: 'unknown',
      },
      'en',
      'CV_ONLY',
    );

    expect(opening).toMatch(/CV/i);
    expect(opening).not.toMatch(/\bJD\b|job description/i);
  });
  it('names the candidate and employer when both are grounded', () => {
    expect(
      buildInterviewOpening(
        {
          candidateName: 'Nguyễn An',
          employerName: 'FPT Software',
          jobTitle: 'Backend Engineer',
          employerSource: 'jd',
        },
        'vi',
        'CV_JD_MATCH',
      ),
    ).toContain('Xin chào Nguyễn An, tôi là HR AI của FPT Software');
  });
});

describe('interview question fingerprint', () => {
  it('treats whitespace, punctuation, and case changes as the same question', () => {
    expect(fingerprintInterviewQuestion('How do you debug a slow API?')).toBe(
      fingerprintInterviewQuestion('  how do you debug a slow API  '),
    );
  });

  it('keeps materially different questions distinguishable', () => {
    expect(fingerprintInterviewQuestion('How do you debug a slow API?')).not.toBe(
      fingerprintInterviewQuestion('Why did you choose a cache instead of a queue?'),
    );
  });

  it('detects exact and near-duplicate questions before they reach the candidate', () => {
    expect(
      isRepeatedInterviewQuestion('How do you test React components?', [
        'How do you test React components?',
      ]),
    ).toBe(true);
    expect(
      isRepeatedInterviewQuestion('In practice, how do you test React components?', [
        'How do you test React components?',
      ]),
    ).toBe(true);
    expect(
      isRepeatedInterviewQuestion('Which trade-off made you choose React?', [
        'How do you test React components?',
      ]),
    ).toBe(false);
  });
});
