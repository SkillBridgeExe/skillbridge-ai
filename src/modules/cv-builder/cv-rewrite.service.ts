import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { LlmService } from '../../infrastructure/llm/llm.service';
import { PromptsService } from '../prompts/prompts.service';
import { RewriteRequestDto, RewriteResponseDto, TailorActionInputDto } from './dto/rewrite.dto';

const PROMPT_CODE = 'cv_rewrite_v1';
/** Cache entries are tiny; cap protects memory under a busy session. */
const CACHE_MAX = 2000;

/** Deterministic tailor instruction — server-built from a checklist item, never user free-text.
 *  Only evidence-backed actions reach here (the checklist gates rewrite_eligible). */
export function buildTailorInstruction(a: Pick<TailorActionInputDto, 'action_type' | 'skill_display' | 'required_level'>): string {
  if (a.action_type === 'emphasize') {
    return (
      `Rework the text to explicitly foreground the skill "${a.skill_display}" — it is VERIFIED ` +
      `present elsewhere in this candidate's CV, so you may name it here. Keep every existing ` +
      `fact; add NO other technology, number, or claim.`
    );
  }
  return (
    `Strengthen the wording about "${a.skill_display}" (stronger action verb, clearer scope and ` +
    `outcome)${a.required_level ? ` toward what a level-${a.required_level}/5 practitioner sounds like` : ''}. ` +
    `Do NOT inflate scope (helped is not led), do NOT add numbers or technologies not already in the text.`
  );
}

/**
 * R1b — single-field AI rewrite (spec §9.1). LLM (OpenAI), STATELESS.
 *
 *  - 3 modes: harvard (IT bullet polish) · translate (vi↔en, keep tech terms) · custom (user instruction).
 *  - GUARDRAIL (defense-in-depth): the prompt forbids fabrication; on top, a deterministic
 *    post-check verifies the suggestion did not INVENT a number/percent that was not in the
 *    input (the most damaging hallucination on a CV). If it did, we fall back to the original
 *    text + flag `fallback` rather than ship a fabricated metric.
 *  - Cached by hash(text|mode|target_lang|instruction|role) so re-clicking "Viết lại" on the
 *    SAME input is free; "Viết lại" with intent to vary is a different call only if input changed
 *    (the FE's regenerate sends the same input → same suggestion, which is acceptable & cheap).
 */
@Injectable()
export class CvRewriteService {
  private readonly logger = new Logger(CvRewriteService.name);
  private readonly cache = new Map<string, RewriteResponseDto>();

  constructor(
    private readonly llm: LlmService,
    private readonly prompts: PromptsService,
  ) {}

  async rewrite(req: RewriteRequestDto): Promise<RewriteResponseDto> {
    const text = (req.text ?? '').trim();
    if (text.length === 0) {
      throw new BadRequestException({ code: 'EMPTY_TEXT', message: 'text is required' });
    }
    if (req.mode === 'translate' && !req.target_lang) {
      throw new BadRequestException({
        code: 'NO_TARGET_LANG',
        message: 'target_lang required for translate',
      });
    }
    if (req.mode === 'custom' && !req.instruction?.trim()) {
      throw new BadRequestException({
        code: 'NO_INSTRUCTION',
        message: 'instruction required for custom',
      });
    }
    if (req.mode === 'tailor' && !req.tailor_action) {
      throw new BadRequestException({
        code: 'NO_TAILOR_ACTION',
        message: 'tailor_action required for tailor',
      });
    }

    const instruction =
      req.mode === 'tailor' && req.tailor_action
        ? buildTailorInstruction(req.tailor_action)
        : req.instruction;

    const key = this.cacheKey(req, text, instruction);
    const hit = this.cache.get(key);
    if (hit) return hit;

    const userPrompt = this.prompts.render(PROMPT_CODE, {
      text,
      mode: req.mode,
      target_lang: req.target_lang ?? '(n/a)',
      instruction: instruction ?? '(n/a)',
      role_code: req.role_code ?? '(none)',
      section: req.section ?? '(none)',
    });
    const system = this.prompts.get(PROMPT_CODE).meta.system ?? '';

    const result = await this.llm.complete(
      [
        { role: 'system', content: system },
        { role: 'user', content: userPrompt },
      ],
      // 1024 gives a summary/translate rewrite clear headroom (512 could truncate a paragraph).
      { provider: 'openai', temperature: 0.3, maxOutputTokens: 1024 },
    );

    let suggestion = this.clean(result.text);
    let fallback = false;

    // Guardrail: translate may legitimately keep all numbers; harvard/custom must not INVENT one.
    if (req.mode !== 'translate' && this.inventedNumber(text, suggestion)) {
      this.logger.warn(
        `cv_rewrite produced a number absent from the input (mode=${req.mode}) — falling back to original.`,
      );
      suggestion = text;
      fallback = true;
    }
    // Empty / refusal → fall back to original rather than blank the field.
    if (suggestion.length === 0) {
      suggestion = text;
      fallback = true;
    }

    const out: RewriteResponseDto = { suggestion, fallback };
    this.remember(key, out);
    return out;
  }

  /**
   * Strip ONLY a balanced wrapping quote pair spanning the WHOLE string (the model's "…"
   * wrapping), plus a leading "Here is…/Đây là…" preamble. Does NOT trim a legit boundary
   * quote on a product name ("QuickPay" launched… / …TypeScript "v5") — review finding.
   */
  private clean(raw: string): string {
    let s = (raw ?? '').trim();
    let m: RegExpExecArray | null;
    while ((m = /^(["'`])([\s\S]+)\1$/.exec(s)) !== null) s = m[2].trim();
    s = s.replace(/^(?:here(?:'s| is)[^:]*:|đây là[^:]*:)\s*/i, '').trim();
    return s;
  }

  /**
   * Returns true if `out` contains a number NOT present in `input` — the hallucinated-metric
   * signature. Normalizes thousands commas + trailing period ONLY (keeps internal dots so a
   * version/IP "1.5.0" is distinct from "150", and "3.5" from "35"); idiomatic emphasis
   * (24/7, 100%, 365) is not a CV metric and is ignored to avoid false fallbacks (review).
   */
  private inventedNumber(input: string, out: string): boolean {
    const EMPHASIS = /\b24\/7\b|\b100\s?%|\b365\b/g;
    const digits = (s: string): string[] =>
      (s.replace(EMPHASIS, ' ').match(/\d[\d.,]*/g) ?? [])
        .map((n) => n.replace(/,/g, '').replace(/\.+$/, ''))
        .filter(Boolean);
    const inSet = new Set(digits(input));
    return digits(out).some((n) => !inSet.has(n));
  }

  private cacheKey(req: RewriteRequestDto, text: string, instruction: string | undefined): string {
    return createHash('sha256')
      .update(
        // `section` is rendered into the prompt → part of the cache identity (review finding).
        [
          text,
          req.mode,
          req.target_lang ?? '',
          instruction ?? '',
          req.role_code ?? '',
          req.section ?? '',
        ].join(' '),
      )
      .digest('hex');
  }

  private remember(key: string, val: RewriteResponseDto): void {
    if (this.cache.size >= CACHE_MAX) {
      const first = this.cache.keys().next().value;
      if (first !== undefined) this.cache.delete(first);
    }
    this.cache.set(key, val);
  }
}
