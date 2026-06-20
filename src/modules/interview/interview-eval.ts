import {
  aggregateInterviewScore,
  AnswerScore,
  Dimension,
  RoleFamily,
  ScoreBand,
} from './interview-scoring';

export interface InterviewEvalCase {
  id: string;
  role: string;
  seniority: string;
  answers: AnswerScore[];
  expected_overall_band: ScoreBand;
  expected_dimension_bands: Partial<Record<Dimension, ScoreBand>>;
  expected_role_family?: RoleFamily; // optional: pins the role/seniority → rubric-column resolution
}

export interface InterviewEvalResult {
  id: string;
  overall: number;
  overall_band_match: boolean;
  dimension_bands_match: boolean;
  role_family_match: boolean;
  pass: boolean;
}

/**
 * Deterministic eval: run the case through aggregateInterviewScore and check the overall band + every
 * EXPECTED dimension band. Self-consistent golden — proves the aggregator's banding is stable; calibrate
 * against real graded interviews once a labelled corpus exists (mirrors learning/curation eval).
 */
export function scoreInterviewCase(c: InterviewEvalCase): InterviewEvalResult {
  const out = aggregateInterviewScore({ answers: c.answers, role: c.role, seniority: c.seniority });
  const overall_band_match = out.overall_band === c.expected_overall_band;
  const byDim = new Map(out.dimensions.map((d) => [d.dimension, d.band]));
  const dimension_bands_match = (Object.keys(c.expected_dimension_bands) as Dimension[]).every(
    (d) => byDim.get(d) === c.expected_dimension_bands[d],
  );
  const role_family_match =
    c.expected_role_family == null || out.role_family === c.expected_role_family;
  return {
    id: c.id,
    overall: out.overall,
    overall_band_match,
    dimension_bands_match,
    role_family_match,
    pass: overall_band_match && dimension_bands_match && role_family_match,
  };
}
