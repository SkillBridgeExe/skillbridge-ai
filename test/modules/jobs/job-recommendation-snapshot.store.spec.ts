import { JobRecommendationSnapshotStore } from '../../../src/modules/jobs/reco/job-recommendation-snapshot.store';

describe('JobRecommendationSnapshotStore', () => {
  it('returns a live persisted snapshot payload', async () => {
    const payload = { cv_target_role: 'backend_developer', recommendations: [] };
    const db = { query: jest.fn().mockResolvedValue([{ payload }]) };
    const store = new JobRecommendationSnapshotStore(db as never, { get: jest.fn() } as never);

    await expect(store.find('user-1', 'cv-1', 'fingerprint')).resolves.toEqual(payload);
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('expires_at > now()'), [
      'user-1',
      'cv-1',
      'fingerprint',
      'explorer-v1',
    ]);
  });

  it('claims a cold snapshot without holding a pooled connection', async () => {
    const db = { query: jest.fn().mockResolvedValue([{ claim_token: 'claim-1' }]) };
    const store = new JobRecommendationSnapshotStore(db as never, { get: jest.fn() } as never);

    await expect(store.tryClaim('user-1', 'cv-1', 'fingerprint')).resolves.toBe('claim-1');
    expect(db.query.mock.calls[0][0]).toContain('ON CONFLICT');
    expect(db.query.mock.calls[0][0]).not.toContain('pg_advisory');
    expect(db.query.mock.calls[0][0]).toContain('claim_token = EXCLUDED.claim_token');
  });

  it('reports an existing live claim instead of starting duplicate generation', async () => {
    const db = { query: jest.fn().mockResolvedValue([]) };
    const store = new JobRecommendationSnapshotStore(db as never, { get: jest.fn() } as never);

    await expect(store.tryClaim('user-1', 'cv-1', 'fingerprint')).resolves.toBeNull();
  });

  it('deletes only the caller-owned unfinished claim after generation failure', async () => {
    const db = { query: jest.fn().mockResolvedValue([]) };
    const store = new JobRecommendationSnapshotStore(db as never, { get: jest.fn() } as never);

    await store.releaseClaim('user-1', 'cv-1', 'fingerprint', 'claim-1');

    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('payload IS NULL'), [
      'user-1',
      'cv-1',
      'fingerprint',
      'explorer-v1',
      'claim-1',
    ]);
    expect(db.query.mock.calls[0][0]).toContain('claim_token = $5::uuid');
  });

  it('rejects a stale builder save after another request takes over the lease', async () => {
    const client = {
      query: jest.fn().mockResolvedValueOnce({ rowCount: 0 }),
    };
    const db = {
      transaction: jest.fn(async (callback: (value: typeof client) => Promise<boolean>) =>
        callback(client),
      ),
    };
    const store = new JobRecommendationSnapshotStore(db as never, { get: jest.fn() } as never);

    await expect(
      store.save(
        'user-1',
        'cv-1',
        'fingerprint',
        { cv_target_role: 'backend_developer', recommendations: [] },
        'stale-claim',
      ),
    ).resolves.toBe(false);

    expect(client.query).toHaveBeenCalledTimes(1);
    expect(client.query.mock.calls[0][0]).toContain('claim_token = $7::uuid');
    expect(client.query.mock.calls[0][1]).toContain('stale-claim');
    expect(client.query.mock.calls[0][0]).not.toContain('DELETE FROM');
  });
});
