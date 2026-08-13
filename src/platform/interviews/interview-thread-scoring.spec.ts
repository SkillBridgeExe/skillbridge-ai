import { collapseQuestionThreads } from './interview-thread-scoring';

describe('collapseQuestionThreads', () => {
  it('groups follow-ups from one question thread into one scoring unit', () => {
    const groups = collapseQuestionThreads([
      { id: 'turn-1', threadId: 'thread-a', order: 1, scoreCap: null },
      { id: 'turn-2', threadId: 'thread-a', order: 2, scoreCap: null },
      { id: 'turn-3', threadId: 'thread-b', order: 3, scoreCap: null },
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]?.items.map((item) => item.id)).toEqual(['turn-1', 'turn-2']);
    expect(groups[0]?.representative.id).toBe('turn-2');
  });

  it('keeps legacy turns without a thread id as independent scoring units', () => {
    const groups = collapseQuestionThreads([
      { id: 'turn-1', threadId: null, order: 1, scoreCap: null },
      { id: 'turn-2', threadId: null, order: 2, scoreCap: null },
    ]);

    expect(groups).toHaveLength(2);
  });

  it('uses the lowest assistance cap across the whole thread', () => {
    const [group] = collapseQuestionThreads([
      { id: 'turn-1', threadId: 'thread-a', order: 1, scoreCap: 75 },
      { id: 'turn-2', threadId: 'thread-a', order: 2, scoreCap: 60 },
    ]);

    expect(group?.scoreCap).toBe(60);
  });
});
