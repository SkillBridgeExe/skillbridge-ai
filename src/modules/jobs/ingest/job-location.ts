import { normalizeJobLocation } from './ingest-normalizers';

export type JobLocationGranularity = 'exact' | 'district' | 'city' | 'unknown';

export interface RawJobLocationInput {
  countryCode?: string | null;
  cityCode?: string | null;
  cityName?: string | null;
  districtCode?: string | null;
  districtName?: string | null;
  addressLine?: string | null;
  isPrimary?: boolean;
}

export interface JobLocationRecord {
  countryCode: string | null;
  cityCode: string | null;
  cityName: string | null;
  districtCode: string | null;
  districtName: string | null;
  addressLine: string | null;
  isPrimary: boolean;
  granularity: JobLocationGranularity;
}

export interface NormalizedJobLocations {
  primaryCityCode: string | null;
  cityCodes: string[];
  districtCodes: string[];
  records: JobLocationRecord[];
}

function cleanText(value: string | null | undefined): string | null {
  const cleaned = value?.trim();
  return cleaned ? cleaned : null;
}

function normalizeCode(value: string | null | undefined): string | null {
  const cleaned = cleanText(value);
  if (!cleaned) return null;
  const code = cleaned
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, 'd')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return code || null;
}

function normalizeCountryCode(value: string | null | undefined): string | null {
  const cleaned = cleanText(value);
  if (!cleaned) return null;
  const folded = cleaned
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, 'd')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
  if (/^(?:VN|VNM|VIETNAM|VIET NAM)$/.test(folded)) return 'VN';
  if (/^[A-Z]{2,3}$/.test(folded)) return folded;
  // Keep unknown country provenance as a normalized token rather than silently dropping it.
  return normalizeCode(cleaned);
}

/**
 * A locality-only JSON-LD value can be a district (for example, "Quận 7")
 * rather than a city. Keep that distinction explicit instead of displaying a
 * district as the city name or pretending we know an exact address.
 */
export function isDistrictLikeName(value: string | null | undefined): boolean {
  const text = cleanText(value);
  if (!text) return false;
  return /^(?:q\.?\s*\d+|qu[aậ]n\b|quan\b|district\b|huy[eệ]n\b|huyen\b|th[aà]nh\s*ph[oố]\s+th[uủ]\s+đ[ứu]c\b|thu\s+duc\b)/i.test(
    text,
  );
}

function inferCityCode(input: RawJobLocationInput): string | null {
  const explicit = normalizeCode(input.cityCode);
  if (explicit) return explicit;

  const sourceText = [input.cityName, input.districtName, input.addressLine]
    .map(cleanText)
    .filter((value): value is string => value !== null)
    .join(', ');
  return normalizeJobLocation(sourceText).primaryCityCode;
}

function hasVietnameseCityCode(cityCode: string | null): boolean {
  return cityCode != null && ['HCM', 'HAN', 'DAD', 'HPH', 'CTO', 'BDG', 'DNI'].includes(cityCode);
}

function recordGranularity(
  addressLine: string | null,
  districtCode: string | null,
  districtName: string | null,
  cityCode: string | null,
): JobLocationGranularity {
  if (addressLine) return 'exact';
  if (districtCode || districtName) return 'district';
  if (cityCode) return 'city';
  return 'unknown';
}

function recordKey(record: Omit<JobLocationRecord, 'isPrimary'>): string {
  return [
    record.countryCode ?? '',
    record.cityCode ?? '',
    record.cityName ?? '',
    record.districtCode ?? '',
    record.districtName ?? '',
    record.addressLine ?? '',
  ]
    .join('|')
    .toLowerCase();
}

function normalizeRecord(input: RawJobLocationInput): Omit<JobLocationRecord, 'isPrimary'> | null {
  const cityCode = inferCityCode(input);
  const rawCityName = cleanText(input.cityName);
  const districtName =
    cleanText(input.districtName) ?? (isDistrictLikeName(rawCityName) ? rawCityName : null);
  const districtCode =
    normalizeCode(input.districtCode) ?? (districtName ? normalizeCode(districtName) : null);
  const addressLine = cleanText(input.addressLine);
  const cityName = isDistrictLikeName(rawCityName) ? null : rawCityName;
  const countryCode =
    normalizeCountryCode(input.countryCode) ?? (hasVietnameseCityCode(cityCode) ? 'VN' : null);

  if (!countryCode && !cityCode && !districtCode && !districtName && !addressLine && !cityName) {
    return null;
  }

  return {
    countryCode,
    cityCode,
    cityName,
    districtCode,
    districtName,
    addressLine,
    granularity: recordGranularity(addressLine, districtCode, districtName, cityCode),
  };
}

export function normalizeJobLocationRecords(
  inputs: RawJobLocationInput[],
  fallbackText: string | null | undefined,
): NormalizedJobLocations {
  const deduped: Array<Omit<JobLocationRecord, 'isPrimary'> & { requestedPrimary: boolean }> = [];
  const seen = new Set<string>();

  for (const input of inputs) {
    const normalized = normalizeRecord(input);
    if (!normalized) continue;
    const key = recordKey(normalized);
    const existing = deduped.findIndex((record) => recordKey(record) === key);
    if (existing >= 0) {
      deduped[existing].requestedPrimary ||= input.isPrimary === true;
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push({ ...normalized, requestedPrimary: input.isPrimary === true });
  }

  if (deduped.length === 0) {
    const fallback = cleanText(fallbackText);
    const inferredCodes = normalizeJobLocation(fallback ?? '').cityCodes;
    if (inferredCodes.length > 0) {
      deduped.push(
        ...inferredCodes.map((cityCode) => ({
          countryCode: 'VN',
          cityCode,
          cityName: null,
          districtCode: null,
          districtName: null,
          addressLine: null,
          granularity: 'city' as const,
          requestedPrimary: false,
        })),
      );
    } else if (fallback) {
      deduped.push({
        countryCode: null,
        cityCode: null,
        cityName: fallback,
        districtCode: null,
        districtName: null,
        addressLine: null,
        granularity: 'unknown',
        requestedPrimary: false,
      });
    }
  }

  const primaryIndex = Math.max(
    deduped.findIndex((record) => record.requestedPrimary),
    0,
  );
  const records = deduped.map(({ requestedPrimary: _requestedPrimary, ...record }, index) => ({
    ...record,
    isPrimary: index === primaryIndex,
  }));

  return {
    primaryCityCode: records[primaryIndex]?.cityCode ?? null,
    cityCodes: [
      ...new Set(
        records.map((record) => record.cityCode).filter((code): code is string => Boolean(code)),
      ),
    ],
    districtCodes: [
      ...new Set(
        records
          .map((record) => record.districtCode)
          .filter((code): code is string => Boolean(code)),
      ),
    ],
    records,
  };
}
