// src/modules/cv-intake/cv-intake.ts
import { parseDateRange } from './intake-dates';
import { isGrounded } from './intake-grounding';

export type ExtractedField = {
  value: string | string[];
  found: boolean;
  confidence: 'high' | 'low';
  source_span: string;
};

export type ExperienceFieldKey =
  | 'company'
  | 'position'
  | 'start'
  | 'end'
  | 'description'
  | 'achievements';

export interface ExperienceExtraction {
  fields: Record<ExperienceFieldKey, ExtractedField>;
  missing: string[];
}

export type IntakeLlmOutput = {
  fields: Partial<Record<string, { value: string | string[]; source_span?: string }>>;
};

// The order is stable so `missing` is deterministic.
const FIELD_ORDER: ExperienceFieldKey[] = [
  'company',
  'position',
  'start',
  'end',
  'description',
  'achievements',
];
const DATE_FIELDS = new Set<ExperienceFieldKey>(['start', 'end']);

function emptyField(): ExtractedField {
  return { value: '', found: false, confidence: 'low', source_span: '' };
}

/** Flatten a field value into a single string the grounding gate can scan. */
function stringify(value: string | string[]): string {
  return Array.isArray(value) ? value.join(' ') : value;
}

/**
 * Pure: merge the LLM output with the deterministic dates and the grounding
 * gate into the response shape. Never invents — an ungrounded atom is dropped
 * to `found:false` and listed in `missing`.
 */
export function assembleExtraction(narrative: string, llm: IntakeLlmOutput): ExperienceExtraction {
  const fields = {} as Record<ExperienceFieldKey, ExtractedField>;

  // Non-date fields: take the LLM value, then gate it against the narrative.
  for (const key of FIELD_ORDER) {
    if (DATE_FIELDS.has(key)) {
      fields[key] = emptyField();
      continue;
    }
    const raw = llm.fields[key];
    if (!raw || raw.value === undefined || raw.value === null) {
      fields[key] = emptyField();
      continue;
    }
    const sourceSpan = raw.source_span ?? '';
    const grounded = isGrounded(stringify(raw.value), narrative);
    fields[key] = {
      value: grounded ? raw.value : '',
      found: grounded,
      confidence: grounded && sourceSpan.trim() !== '' ? 'high' : 'low',
      source_span: grounded ? sourceSpan : '',
    };
  }

  // Dates are deterministic — they override anything the LLM returned.
  const { start, end, ongoing } = parseDateRange(narrative);
  fields.start = start
    ? { value: start, found: true, confidence: 'high', source_span: start }
    : emptyField();
  if (ongoing) {
    // Open-ended role: surface "present" but not as a discovered end-date fact.
    fields.end = {
      value: 'present',
      found: false,
      confidence: 'low',
      source_span: '',
    };
  } else {
    fields.end = end
      ? { value: end, found: true, confidence: 'high', source_span: end }
      : emptyField();
  }

  const missing = FIELD_ORDER.filter((key) => !fields[key].found);
  return { fields, missing };
}
