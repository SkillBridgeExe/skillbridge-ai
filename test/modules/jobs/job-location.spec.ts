import {
  normalizeJobLocationRecords,
  RawJobLocationInput,
} from '../../../src/modules/jobs/ingest/job-location';

describe('normalizeJobLocationRecords', () => {
  it('preserves a source-provided exact location and derives its city/district facets', () => {
    const result = normalizeJobLocationRecords(
      [
        {
          countryCode: 'vn',
          cityCode: 'HCM',
          districtName: 'Quận 1',
          addressLine: '123 Nguyễn Huệ',
          isPrimary: true,
        },
      ],
      'Quận 1, Hồ Chí Minh',
    );

    expect(result).toEqual({
      primaryCityCode: 'HCM',
      cityCodes: ['HCM'],
      districtCodes: ['QUAN_1'],
      records: [
        {
          countryCode: 'VN',
          cityCode: 'HCM',
          districtCode: 'QUAN_1',
          districtName: 'Quận 1',
          addressLine: '123 Nguyễn Huệ',
          isPrimary: true,
          granularity: 'exact',
        },
      ],
    });
  });

  it('keeps multiple source locations in source order and chooses the first primary', () => {
    const locations: RawJobLocationInput[] = [
      { cityCode: 'HAN', cityName: 'Hà Nội', isPrimary: false },
      { cityCode: 'DAD', cityName: 'Đà Nẵng', isPrimary: true },
    ];

    const result = normalizeJobLocationRecords(locations, null);

    expect(result.cityCodes).toEqual(['HAN', 'DAD']);
    expect(result.primaryCityCode).toBe('DAD');
    expect(result.records.map((record) => record.cityCode)).toEqual(['HAN', 'DAD']);
    expect(result.records.every((record) => record.granularity === 'city')).toBe(true);
  });

  it('derives a city facet from legacy text without inventing a district', () => {
    const result = normalizeJobLocationRecords([], 'Đà Nẵng');

    expect(result.primaryCityCode).toBe('DAD');
    expect(result.cityCodes).toEqual(['DAD']);
    expect(result.districtCodes).toEqual([]);
    expect(result.records).toEqual([
      {
        countryCode: 'VN',
        cityCode: 'DAD',
        districtCode: null,
        districtName: null,
        addressLine: null,
        isPrimary: true,
        granularity: 'city',
      },
    ]);
  });

  it('preserves unknown source text as unknown and never guesses a nearby city', () => {
    const result = normalizeJobLocationRecords([], 'Remote - flexible location');

    expect(result).toEqual({
      primaryCityCode: null,
      cityCodes: [],
      districtCodes: [],
      records: [
        {
          countryCode: null,
          cityCode: null,
          districtCode: null,
          districtName: null,
          addressLine: 'Remote - flexible location',
          isPrimary: true,
          granularity: 'unknown',
        },
      ],
    });
  });

  it('deduplicates equivalent locations while retaining the explicit primary flag', () => {
    const result = normalizeJobLocationRecords(
      [
        { cityCode: 'HCM', districtName: 'Quận 1', addressLine: '123 Nguyễn Huệ' },
        { cityCode: ' hcm ', districtName: ' Quận 1 ', addressLine: ' 123 Nguyễn Huệ ', isPrimary: true },
      ],
      null,
    );

    expect(result.records).toHaveLength(1);
    expect(result.records[0].isPrimary).toBe(true);
    expect(result.districtCodes).toEqual(['QUAN_1']);
  });
});
