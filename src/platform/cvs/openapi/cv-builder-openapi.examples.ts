const BUILDER_CANONICAL_EXAMPLE = {
  language: 'vi',
  contact: {
    name: 'Nguyen Van A',
    email: 'a@example.com',
    phone: '0900000000',
    location: 'Ho Chi Minh',
    links: [{ label: 'GitHub', url: 'https://github.com/example' }],
  },
  summary: 'Frontend developer with React and TypeScript experience.',
  education: [],
  experience: [
    {
      org: 'ABC Tech',
      role: 'Frontend Developer',
      start: '2024',
      end: 'Present',
      location: null,
      bullets: ['Built a React dashboard that reduced load time by 30%.'],
    },
  ],
  projects: [],
  skills: {
    technical: ['React', 'TypeScript'],
    soft: ['Communication'],
    languages: ['English'],
    tools: ['Git', 'Docker'],
  },
  certifications: [],
  activities: [],
};

export const CREATE_BUILDER_BODY_EXAMPLES = {
  blank: {
    summary: 'Create blank builder draft',
    value: {
      title: 'My Builder CV',
      targetRole: 'frontend_developer',
      language: 'vi',
    },
  },
  fromUploadedCv: {
    summary: 'Create builder draft from an uploaded CV',
    value: {
      sourceCvId: '8c4d4f2d-55dd-42a4-b9c7-57b6bdfc8d7f',
      title: 'Frontend CV Builder Draft',
      targetRole: 'frontend_developer',
      language: 'vi',
    },
  },
};

export const UPDATE_BUILDER_BODY_EXAMPLES = {
  autosave: {
    summary: 'Autosave full builder document',
    value: {
      parsedJson: BUILDER_CANONICAL_EXAMPLE,
      title: 'Updated Frontend CV',
      targetRole: 'frontend_developer',
      language: 'vi',
    },
  },
};

export const EVALUATE_BUILDER_BODY_EXAMPLES = {
  basic: {
    summary: 'Evaluate basic info',
    value: {
      section: 'basic',
      role_code: 'frontend_developer',
      language: 'vi',
      content: {
        fullName: 'Nguyen Van A',
        email: 'a@example.com',
        phone: '0900000000',
        location: 'Ho Chi Minh',
        linkedin: 'https://linkedin.com/in/example',
        github: 'https://github.com/example',
        portfolio: 'https://example.dev',
      },
    },
  },
  experience: {
    summary: 'Evaluate experience',
    value: {
      section: 'experience',
      role_code: 'frontend_developer',
      language: 'vi',
      content: {
        entries: [
          {
            position: 'Frontend Developer',
            company: 'ABC Tech',
            startDate: '2024',
            endDate: 'Present',
            description: 'Built React dashboard for internal users.',
            responsibilities: 'Owned reusable UI components.',
            achievements: 'Reduced dashboard load time by 30%.',
          },
        ],
      },
    },
  },
  skills: {
    summary: 'Evaluate skills',
    value: {
      section: 'skills',
      role_code: 'frontend_developer',
      language: 'vi',
      content: {
        technicalSkills: ['React', 'TypeScript'],
        softSkills: ['Communication'],
        tools: ['Git', 'Docker'],
        languages: ['English'],
      },
    },
  },
};

export const REWRITE_BUILDER_BODY_EXAMPLES = {
  harvard: {
    summary: 'Improve wording to Harvard CV style',
    value: {
      text: 'built admin dashboard with React',
      mode: 'harvard',
      role_code: 'frontend_developer',
      section: 'experience',
    },
  },
  translate: {
    summary: 'Translate field text',
    value: {
      text: 'Built an admin dashboard with React.',
      mode: 'translate',
      target_lang: 'vi',
      section: 'experience',
    },
  },
  custom: {
    summary: 'Custom rewrite instruction',
    value: {
      text: 'Built an admin dashboard with React.',
      mode: 'custom',
      instruction: 'Make it shorter and more impact-focused.',
      role_code: 'frontend_developer',
      section: 'experience',
    },
  },
};
