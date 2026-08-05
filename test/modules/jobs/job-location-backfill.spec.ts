import { computeJobLocationBackfill } from '../../../src/modules/jobs/ingest/job-location-backfill';

describe('computeJobLocationBackfill', () => {
  it('creates structured city/district records from source locations', () => {
    const changes = computeJobLocationBackfill([
      {
        id: 'job-1',
        title: 'Backend Engineer',
        location: 'Hồ Chí Minh',
        existingLocations: [],
        sourceLocations: [{ cityName: 'Hồ Chí Minh', districtName: 'Quận 7' }],
      },
    ]);

    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      id: 'job-1',
      primaryCityCode: 'HCM',
      cityCodes: ['HCM'],
      districtCodes: ['QUAN_7'],
    });
    expect(changes[0].records[0].granularity).toBe('district');
  });

  it('does not overwrite an existing structured location', () => {
    const changes = computeJobLocationBackfill([
      {
        id: 'job-1',
        title: 'Backend Engineer',
        location: 'Hồ Chí Minh',
        existingLocations: [
          {
            countryCode: 'VN',
            cityCode: 'HCM',
            cityName: 'Hồ Chí Minh',
            districtCode: null,
            districtName: null,
            addressLine: null,
            isPrimary: true,
            granularity: 'city',
          },
        ],
        sourceLocations: [{ cityName: 'Hà Nội' }],
      },
    ]);

    expect(changes).toEqual([]);
  });

  it('keeps an unknown location out of the backfill instead of guessing', () => {
    const changes = computeJobLocationBackfill([
      {
        id: 'job-1',
        title: 'Backend Engineer',
        location: 'Flexible location',
        existingLocations: [],
        sourceLocations: [],
      },
    ]);

    expect(changes).toHaveLength(1);
    expect(changes[0].records[0].granularity).toBe('unknown');
    expect(changes[0].primaryCityCode).toBeNull();
    expect(changes[0].cityCodes).toEqual([]);
  });
});
