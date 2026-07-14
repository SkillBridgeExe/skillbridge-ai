import { AnswerSignals, Conciseness } from './answer-analyzer';

/**
 * Communication Metrics — Wave I-VOICE: `buildCommunicationSignals`.
 *
 * A thin, PURE projection of the Layer-1 `AnswerSignals` (answer-analyzer owns every count — this
 * module deliberately re-implements NOTHING) plus the one metric L1 cannot know: speaking rate,
 * derived from client-reported answer duration. No LLM, no IO.
 *
 * Honesty rules (spec Wave I-VOICE):
 *  - These are COMMUNICATION SIGNALS, never psychology: no emotion, confidence, or personality
 *    fields exist on this shape, by design.
 *  - A metric that cannot be computed is REPORTED as unavailable (`unavailable_reason`) — never
 *    faked, never defaulted. Missing/zero duration → no `speaking_rate_wpm`.
 */

export interface CommunicationSignals {
  word_count: number;
  sentence_count: number;
  filler_count: number;
  filler_terms: string[];
  hedging_count: number;
  repeated_terms: string[];
  jd_term_hits: string[];
  jd_term_misses: string[];
  star: { situation: boolean; task: boolean; action: boolean; result: boolean };
  answer_length_band: Conciseness;
  /** words per minute — present only when a positive answer duration was reported. */
  speaking_rate_wpm?: number;
  /** filler occurrences per spoken minute (P3) — present only with a positive duration. */
  filler_per_minute?: number;
  /** seconds from mic-open to the first transcript segment (P3, client-measured). */
  response_delay_seconds?: number;
  /** STT transcript segments in this answer (P3) — a proxy for long pauses between bursts. */
  transcript_segments?: number;
  /** set when a metric group cannot be computed honestly (currently: timing metrics). */
  unavailable_reason?: 'no_timing_data';
}

export interface CommunicationTiming {
  /** answer duration in seconds as reported by the client; null/0/absent → no rate metrics. */
  duration_seconds?: number | null;
  /** milliseconds from mic-open to first speech (P3); negative/absent → dropped, never faked. */
  response_delay_ms?: number | null;
  /** count of STT transcript segments in the answer (P3); <1/absent → dropped. */
  transcript_segments?: number | null;
}

export function buildCommunicationSignals(
  signals: AnswerSignals,
  timing?: CommunicationTiming,
): CommunicationSignals {
  const duration = timing?.duration_seconds;
  const hasTiming = typeof duration === 'number' && Number.isFinite(duration) && duration > 0;

  const out: CommunicationSignals = {
    word_count: signals.word_count,
    sentence_count: signals.sentence_count,
    filler_count: signals.filler.count,
    filler_terms: [...signals.filler.terms],
    hedging_count: signals.hedging.count,
    repeated_terms: signals.repeated_terms.map((r) => r.term),
    jd_term_hits: [...signals.jd_term_hits.hit],
    jd_term_misses: [...signals.jd_term_hits.missed],
    star: {
      situation: signals.star.situation,
      task: signals.star.task,
      action: signals.star.action,
      result: signals.star.result,
    },
    answer_length_band: signals.conciseness,
  };

  if (hasTiming) {
    out.speaking_rate_wpm = Math.round((signals.word_count / duration) * 60);
    // one decimal — filler counts are small, whole numbers would round most answers to 0.
    out.filler_per_minute = Math.round((signals.filler.count / duration) * 60 * 10) / 10;
  } else {
    out.unavailable_reason = 'no_timing_data';
  }

  // client-measured P3 metrics validate independently — each is dropped (never defaulted)
  // when the client did not or could not measure it.
  const delay = timing?.response_delay_ms;
  if (hasTiming && typeof delay === 'number' && Number.isFinite(delay) && delay >= 0) {
    out.response_delay_seconds = Math.round(delay / 100) / 10;
  }
  const segments = timing?.transcript_segments;
  if (hasTiming && typeof segments === 'number' && Number.isInteger(segments) && segments >= 1) {
    out.transcript_segments = segments;
  }

  return out;
}
