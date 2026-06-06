/** R1b — rewrite contract (R1b-cv-builder-spec.md §6, §9.1). One field in → one suggestion out. */
import { BuilderSection } from './evaluate-section.dto';

export type RewriteMode = 'harvard' | 'translate' | 'custom';

export class RewriteRequestDto {
  /** The single field text the user is editing (a bullet, summary, etc.). */
  text!: string;
  mode!: RewriteMode;
  /** Required for mode='translate' — the language to translate INTO. */
  target_lang?: 'vi' | 'en';
  /** Required for mode='custom' — the user's free-form instruction. */
  instruction?: string;
  /** Optional context — tone only, never a fact source. */
  role_code?: string;
  section?: BuilderSection;
}

export class RewriteResponseDto {
  /** The rewritten text — FE shows it as "AI đề xuất" with [Viết lại] / [Sử dụng]. */
  suggestion!: string;
  /** True when a deterministic guard had to fall back to the original (see CvRewriteService). */
  fallback?: boolean;
}
