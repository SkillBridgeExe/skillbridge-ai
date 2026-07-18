import { IsNull, Not } from 'typeorm';
import { InterviewHistoryAdapter } from './interview-history.adapter';

function makeAdapter(find: jest.Mock) {
  return new InterviewHistoryAdapter({ find } as never);
}

describe('InterviewHistoryAdapter', () => {
  it('accepts any args shape as {} — no model-supplied arguments', () => {
    const adapter = makeAdapter(jest.fn());
    expect(adapter.argsSchema(undefined)).toEqual({});
    expect(adapter.argsSchema({ session_id: 'someone-elses' })).toEqual({});
  });

  it('returns shaped-empty without a userId', async () => {
    const find = jest.fn();
    const result = await makeAdapter(find).invoke({}, {});
    expect(result).toEqual({ has_history: false, sessions: [] });
    expect(find).not.toHaveBeenCalled();
  });

  it('returns shaped-empty when the repository is absent (@Optional NODE_ENV=test boot), even with a userId', async () => {
    const result = await new InterviewHistoryAdapter().invoke({}, { userId: 'u1' });
    expect(result).toEqual({ has_history: false, sessions: [] });
  });

  it('queries only scored COMPLETED sessions for the ctx user, newest first, capped at 3', async () => {
    const find = jest.fn().mockResolvedValue([]);
    await makeAdapter(find).invoke({}, { userId: 'u1' });
    expect(find).toHaveBeenCalledWith({
      where: { userId: 'u1', status: 'COMPLETED', overallScore: Not(IsNull()) },
      order: { startedAt: 'DESC' },
      take: 3,
    });
  });

  it('converts numeric-string scores to numbers and dates to YYYY-MM-DD', async () => {
    const find = jest.fn().mockResolvedValue([
      {
        targetRole: 'Data Analyst',
        interviewType: 'MIXED',
        overallScore: '82.00',
        startedAt: new Date('2026-07-10T09:30:00Z'),
      },
      {
        targetRole: 'Data Analyst',
        interviewType: 'HR',
        overallScore: 'not-a-number',
        startedAt: new Date('2026-07-01T09:30:00Z'),
      },
    ]);
    const result = await makeAdapter(find).invoke({}, { userId: 'u1' });
    expect(result.has_history).toBe(true);
    expect(result.sessions).toEqual([
      {
        target_role: 'Data Analyst',
        interview_type: 'MIXED',
        overall_score: 82,
        when: '2026-07-10',
      },
      {
        target_role: 'Data Analyst',
        interview_type: 'HR',
        overall_score: null,
        when: '2026-07-01',
      },
    ]);
  });
});
