import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

/** The diagnosis sections the FE can be viewing — used ONLY to emphasize, never to change facts. */
export const DIAGNOSIS_FOCUS_VALUES = [
  'cv_audit',
  'skills_analysis',
  'market_careers',
  'gap_results',
] as const;
export type DiagnosisFocus = (typeof DIAGNOSIS_FOCUS_VALUES)[number];

const MAX_THREAD_TURNS = 20;
const MAX_TURN_LEN = 4000;

/** One prior conversation turn the FE replays for context. role + text ONLY — NEVER a score/citation
 *  (the BE rebuilds all facts server-side; the client can never inject numbers). */
export class DiagnosisChatTurnDto {
  @IsIn(['user', 'assistant'])
  role!: 'user' | 'assistant';

  @IsString()
  @MaxLength(MAX_TURN_LEN)
  text!: string;
}

export class DiagnosisChatRequestDto {
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  question!: string;

  /** CV-only fallback when there is no JD match attached to the conversation. */
  @IsOptional()
  @IsUUID()
  cvId?: string;

  /** Section the user is viewing → emphasis only (the BE never trusts it for facts). */
  @IsOptional()
  @IsIn(DIAGNOSIS_FOCUS_VALUES)
  focus?: DiagnosisFocus;

  /** "vi" | "en" (or any short language tag) — answer language. */
  @IsOptional()
  @IsString()
  @MaxLength(8)
  language?: string;

  /** Optional prior turns, bounded. The BE also loads persisted history; this is the FE-provided window. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_THREAD_TURNS)
  @ValidateNested({ each: true })
  @Type(() => DiagnosisChatTurnDto)
  thread?: DiagnosisChatTurnDto[];
}
