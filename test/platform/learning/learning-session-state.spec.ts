import {
  resolveModuleSessionStatuses,
  validateLearningSessionCompletion,
} from '../../../src/platform/learning/learning-session-state';

describe('learning session state', () => {
  const modules = [
    { id: 'module-1', rank: 1 },
    { id: 'module-2', rank: 2 },
  ];
  const sessions = [
    { id: 'session-1', moduleId: 'module-1', sequence: 1 },
    { id: 'session-2', moduleId: 'module-1', sequence: 2 },
    { id: 'session-3', moduleId: 'module-2', sequence: 1 },
    { id: 'session-4', moduleId: 'module-2', sequence: 2 },
  ];

  it('makes every unfinished session in the current module available', () => {
    const statuses = resolveModuleSessionStatuses(modules, sessions, new Set(['session-1']));

    expect(Object.fromEntries(statuses)).toEqual({
      'session-1': 'COMPLETED',
      'session-2': 'AVAILABLE',
      'session-3': 'LOCKED',
      'session-4': 'LOCKED',
    });
  });

  it('unlocks every session in the next module after the current module is complete', () => {
    const statuses = resolveModuleSessionStatuses(
      modules,
      sessions,
      new Set(['session-1', 'session-2']),
    );

    expect(Object.fromEntries(statuses)).toEqual({
      'session-1': 'COMPLETED',
      'session-2': 'COMPLETED',
      'session-3': 'AVAILABLE',
      'session-4': 'AVAILABLE',
    });
  });

  it('keeps future modules locked even if they contain a stale completion marker', () => {
    const statuses = resolveModuleSessionStatuses(modules, sessions, new Set(['session-3']));

    expect(Object.fromEntries(statuses)).toEqual({
      'session-1': 'AVAILABLE',
      'session-2': 'AVAILABLE',
      'session-3': 'LOCKED',
      'session-4': 'LOCKED',
    });
  });

  it('keeps a fully marked future module locked until the current module is complete', () => {
    const statuses = resolveModuleSessionStatuses(
      modules,
      sessions,
      new Set(['session-3', 'session-4']),
    );

    expect(Object.fromEntries(statuses)).toEqual({
      'session-1': 'AVAILABLE',
      'session-2': 'AVAILABLE',
      'session-3': 'LOCKED',
      'session-4': 'LOCKED',
    });
  });

  it('requires checklist proof and exercise proof but does not require a quiz', () => {
    const result = validateLearningSessionCompletion(
      [
        {
          type: 'lesson',
          content: {
            sections: [
              {
                id: 'semantic-html',
                checklist: [{ id: 'use-landmarks' }],
              },
            ],
            exercises: [{ id: 'build-form' }],
            quiz: [{ id: 'optional-quiz' }],
          },
        },
      ],
      {
        checkedChecklistItems: {
          'semantic-html': ['use-landmarks'],
        },
        exerciseProofs: {
          'task:semantic-html:use-landmarks': 'Used header and main landmarks.',
          'build-form': 'https://example.test/form-proof',
        },
      },
    );

    expect(result).toEqual({
      complete: true,
      missing_section_ids: [],
      missing_checklist_item_ids: [],
      missing_exercise_ids: [],
    });
  });

  it('reports the exact incomplete section, checklist item and exercise', () => {
    const result = validateLearningSessionCompletion(
      [
        {
          type: 'lesson',
          content: {
            sections: [
              { id: 'reading-only', checklist: [] },
              {
                id: 'semantic-html',
                checklist: [{ id: 'use-landmarks' }],
              },
            ],
            exercises: [{ id: 'build-form' }],
          },
        },
      ],
      {
        checkedChecklistItems: {
          'semantic-html': ['use-landmarks'],
        },
        exerciseProofs: {
          'task:semantic-html:use-landmarks': 'short',
        },
      },
    );

    expect(result).toEqual({
      complete: false,
      missing_section_ids: ['reading-only'],
      missing_checklist_item_ids: ['semantic-html:use-landmarks'],
      missing_exercise_ids: ['build-form'],
    });
  });
});
