import {
  applyJobMetadataBackfill,
  computeJobMetadataBackfill,
} from '../../src/tools/backfill-job-metadata';

describe('computeJobMetadataBackfill', () => {
  it('fills only missing city/work-mode metadata', () => {
    expect(
      computeJobMetadataBackfill([
        {
          id: '1',
          title: 'Backend Developer',
          location: 'Remote - Ho Chi Minh City',
          primary_city_code: null,
          location_city_codes: [],
          work_mode: null,
        },
      ]),
    ).toEqual([
      {
        id: '1',
        title: 'Backend Developer',
        primaryCityCode: 'HCM',
        cityCodes: ['HCM'],
        workMode: 'REMOTE',
      },
    ]);
  });

  it('never overrides explicit stored metadata', () => {
    expect(
      computeJobMetadataBackfill([
        {
          id: '1',
          title: 'Backend Developer',
          location: 'Remote - Ho Chi Minh City',
          primary_city_code: 'HAN',
          location_city_codes: ['HAN'],
          work_mode: 'ONSITE',
        },
      ]),
    ).toEqual([]);
  });

  it('uses explicit work-mode words in the title when location is only a city', () => {
    expect(
      computeJobMetadataBackfill([
        {
          id: 'remote-job',
          title: 'Remote Backend Engineer',
          location: 'Ho Chi Minh City',
          primary_city_code: 'HCM',
          location_city_codes: ['HCM'],
          work_mode: null,
        },
      ]),
    ).toEqual([
      {
        id: 'remote-job',
        title: 'Remote Backend Engineer',
        workMode: 'REMOTE',
      },
    ]);
  });

  it('leaves unknown text honest-null and is idempotent after fill', () => {
    expect(
      computeJobMetadataBackfill([
        {
          id: '1',
          title: 'Backend Developer',
          location: 'Vietnam',
          primary_city_code: null,
          location_city_codes: [],
          work_mode: null,
        },
      ]),
    ).toEqual([]);
  });
});

describe('applyJobMetadataBackfill', () => {
  it('executes UPDATE safely mapping empty strings with NULLIF', async () => {
    const manager = { query: jest.fn().mockResolvedValue(true) };

    const changes = [
      {
        id: 'job-1',
        title: 'A',
        primaryCityCode: 'HCM',
        cityCodes: ['HCM'],
        workMode: 'REMOTE' as const,
      },
    ];

    await applyJobMetadataBackfill(manager, changes);

    expect(manager.query).toHaveBeenCalledTimes(1);
    const sql = manager.query.mock.calls[0][0];
    const params = manager.query.mock.calls[0][1];

    // Verifies the user requirement: test SQL empty-string apply
    expect(sql).toContain("work_mode = COALESCE(NULLIF(BTRIM(work_mode), ''), $3)");
    expect(params).toEqual(['HCM', ['HCM'], 'REMOTE', 'job-1']);
  });
});
