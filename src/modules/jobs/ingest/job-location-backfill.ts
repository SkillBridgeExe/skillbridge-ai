import {
  JobLocationRecord,
  normalizeJobLocationRecords,
  RawJobLocationInput,
} from './job-location';

export interface JobLocationBackfillCandidate {
  id: string;
  title: string | null;
  location: string | null;
  existingLocations: JobLocationRecord[] | null;
  sourceLocations: RawJobLocationInput[];
}

export interface JobLocationBackfillChange {
  id: string;
  title: string;
  records: JobLocationRecord[];
  primaryCityCode: string | null;
  cityCodes: string[];
  districtCodes: string[];
}

/**
 * Compute enrichment changes without I/O. Existing structured locations always win;
 * the backfill is intentionally additive and cannot overwrite a source-confirmed record.
 */
export function computeJobLocationBackfill(
  candidates: JobLocationBackfillCandidate[],
): JobLocationBackfillChange[] {
  const changes: JobLocationBackfillChange[] = [];
  for (const candidate of candidates) {
    if (Array.isArray(candidate.existingLocations) && candidate.existingLocations.length > 0) {
      continue;
    }

    const normalized = normalizeJobLocationRecords(candidate.sourceLocations, candidate.location);
    if (normalized.records.length === 0) continue;

    changes.push({
      id: candidate.id,
      title: candidate.title ?? '',
      records: normalized.records,
      primaryCityCode: normalized.primaryCityCode,
      cityCodes: normalized.cityCodes,
      districtCodes: normalized.districtCodes,
    });
  }
  return changes;
}
