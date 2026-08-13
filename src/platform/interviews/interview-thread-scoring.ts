export interface QuestionThreadScoringItem {
  id: string;
  threadId: string | null;
  order: number;
  scoreCap: number | null;
}

export interface QuestionThreadScoringGroup<T extends QuestionThreadScoringItem> {
  key: string;
  items: T[];
  representative: T;
  scoreCap: number | null;
}

export function collapseQuestionThreads<T extends QuestionThreadScoringItem>(
  items: T[],
): QuestionThreadScoringGroup<T>[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = item.threadId ? `thread:${item.threadId}` : `turn:${item.id}`;
    const existing = groups.get(key);
    if (existing) existing.push(item);
    else groups.set(key, [item]);
  }

  return [...groups.entries()].map(([key, members]) => {
    const sorted = [...members].sort((left, right) => left.order - right.order);
    const representative = sorted[sorted.length - 1];
    const caps = sorted
      .map((item) => item.scoreCap)
      .filter((cap): cap is number => typeof cap === 'number' && Number.isFinite(cap));
    return {
      key,
      items: sorted,
      representative,
      scoreCap: caps.length > 0 ? Math.min(...caps) : null,
    };
  });
}

export function applyScoreCap(score: number | null, scoreCap: number | null): number | null {
  if (score === null || scoreCap === null) return score;
  return Math.min(score, scoreCap);
}
