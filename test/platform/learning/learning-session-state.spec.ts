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

  it('makes every unfinished session available for self-directed learning', () => {
    const statuses = resolveModuleSessionStatuses(modules, sessions, new Set(['session-1']));

    expect(Object.fromEntries(statuses)).toEqual({
      'session-1': 'COMPLETED',
      'session-2': 'AVAILABLE',
      'session-3': 'AVAILABLE',
      'session-4': 'AVAILABLE',
    });
  });

  it('recognizes completion markers regardless of recommended module order', () => {
    const statuses = resolveModuleSessionStatuses(modules, sessions, new Set(['session-3']));

    expect(Object.fromEntries(statuses)).toEqual({
      'session-1': 'AVAILABLE',
      'session-2': 'AVAILABLE',
      'session-3': 'COMPLETED',
      'session-4': 'AVAILABLE',
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

  it('requires a meaningful proof for required exercises', () => {
    const result = validateLearningSessionCompletion(
      [
        {
          type: 'lesson',
          content: {
            sections: [],
            exercises: [{ id: 'build-form' }],
          },
        },
      ],
      {
        checkedChecklistItems: {},
        exerciseProofs: {
          'build-form': 'x',
        },
      },
    );

    expect(result).toEqual({
      complete: false,
      missing_section_ids: [],
      missing_checklist_item_ids: [],
      missing_exercise_ids: ['build-form'],
    });
  });

  it('gates a resource-only session on completion of every assigned resource', () => {
    const requiredTasks = [
      {
        type: 'resources',
        items: [{ id: 'resource-1' }, { id: 'resource-2' }],
      },
    ];

    expect(
      validateLearningSessionCompletion(requiredTasks, {
        checkedChecklistItems: {
          'resource-1': ['__completed'],
        },
        exerciseProofs: {},
      }),
    ).toEqual({
      complete: false,
      missing_section_ids: ['resource-2'],
      missing_checklist_item_ids: [],
      missing_exercise_ids: [],
    });
    expect(
      validateLearningSessionCompletion(requiredTasks, {
        checkedChecklistItems: {
          'resource-1': ['__completed'],
          'resource-2': ['__completed'],
        },
        exerciseProofs: {},
      }),
    ).toEqual({
      complete: true,
      missing_section_ids: [],
      missing_checklist_item_ids: [],
      missing_exercise_ids: [],
    });
  });
});
