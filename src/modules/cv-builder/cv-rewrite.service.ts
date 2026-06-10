import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { LlmService } from '../../infrastructure/llm/llm.service';
import { PromptsService } from '../prompts/prompts.service';
import { TracingService } from '../tracing/tracing.service';
import { RewriteRequestDto, RewriteResponseDto, TailorActionInputDto } from './dto/rewrite.dto';
import { assessRewriteInput } from './rewrite-input-gate';

const PROMPT_CODE = 'cv_rewrite_v1';
/** Cache entries are tiny; cap protects memory under a busy session. */
const CACHE_MAX = 2000;

/** Deterministic tailor instruction — server-built from a checklist item, never user free-text.
 *  Only evidence-backed actions reach here (the checklist gates rewrite_eligible). */
export function buildTailorInstruction(
  a: Pick<TailorActionInputDto, 'action_type' | 'skill_display' | 'required_level'>,
): string {
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
    private readonly tracing: TracingService,
  ) {}

  /**
   * Rewrite a CV field with AI.
   *
   * @param req   - The rewrite request (mode, text, options).
   * @param userId - Optional user id for tracing. Pass null for anonymous/platform calls.
   *                 The platform layer (`/api/cvs/:id/builder/rewrite`) MUST pass the real
   *                 userId so cost/token/latency is attributed correctly.
   */
  async rewrite(req: RewriteRequestDto, userId: string | null = null): Promise<RewriteResponseDto> {
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

    // Deterministic input-quality gate: garbage must never reach the LLM (cost) nor consume
    // the user's quota (platform records usage only after success — a gate rejection here is free).
    const verdict = assessRewriteInput(text);
    if (!verdict.ok) {
      throw new BadRequestException({
        code: 'INSUFFICIENT_CONTEXT',
        message:
          'Cần nội dung thật (bạn đã làm gì, công nghệ nào, kết quả ra sao) trước khi AI có thể viết lại. / ' +
          'Provide real content (what you did, which tech, what outcome) before AI can rewrite.',
      });
    }

    const instruction =
      req.mode === 'tailor' && req.tailor_action
        ? buildTailorInstruction(req.tailor_action)
        : req.instruction;

    const key = this.cacheKey(req, text, instruction);
    const hit = this.cache.get(key);
    // Cache hit → return immediately. No tracing row: there is no LLM call, so no cost to record.
    if (hit) return hit;

    const template = this.prompts.get(PROMPT_CODE);
    const userPrompt = this.prompts.render(PROMPT_CODE, {
      text,
      mode: req.mode,
      target_lang: req.target_lang ?? '(n/a)',
      instruction: instruction ?? '(n/a)',
      role_code: req.role_code ?? '(none)',
      section: req.section ?? '(none)',
    });
    const system = template.meta.system ?? '';

    // PRIVACY: requestPayload must NOT contain the raw CV text or instruction — lengths/modes only.
    // userId='' means anonymous/platform (X-User-Id header absent); stored as-is for tracing.
    const aiRequestId = await this.tracing.startAiRequest({
      userId: userId ?? '',
      modelCode: '',
      promptTemplateCode: template.code,
      promptTemplateVersion: template.version,
      requestType: 'cv_rewrite',
      requestPayload: {
        mode: req.mode,
        section: req.section ?? null,
        target_lang: req.target_lang ?? null,
        text_length: text.length,
      },
    });

    const startedAt = Date.now();
    try {
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

      // ON-TOPIC guard: the prompt instructs the model to answer the literal sentinel OFF_TOPIC
      // for non-CV input (weather, chat, lyrics…). Map it to a deterministic 400 so the FE can
      // guide the user. The trace is completed as SUCCESS first — the LLM call really happened
      // and its cost must stay visible; the catch below re-throws BadRequest WITHOUT markFailed.
      if (/^OFF[\s_-]?TOPIC[.!]?$/i.test(suggestion)) {
        await this.tracing.completeAiRequest(aiRequestId, {
          promptTokens: result.tokenUsage.promptTokens,
          completionTokens: result.tokenUsage.completionTokens,
          totalTokens: result.tokenUsage.totalTokens,
          estimatedCost: result.estimatedCostUsd,
          latencyMs: result.latencyMs,
          status: 'SUCCESS',
        });
        throw new BadRequestException({
          code: 'OFF_TOPIC',
          message:
            'Nội dung chưa phải nội dung CV (kinh nghiệm, dự án, kỹ năng, kết quả). Hãy mô tả việc bạn đã làm. / ' +
            "The text doesn't look like CV content (experience, project, skills, outcomes). Describe what you actually did.",
        });
      }

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

      // No saveAiResult: the rewrite suggestion is ephemeral (not persisted to the CV until the
      // user accepts it). Tracing the request covers cost/token/latency visibility without
      // duplicating storage. Precedent: interview `answer` flow.
      await this.tracing.completeAiRequest(aiRequestId, {
        promptTokens: result.tokenUsage.promptTokens,
        completionTokens: result.tokenUsage.completionTokens,
        totalTokens: result.tokenUsage.totalTokens,
        estimatedCost: result.estimatedCostUsd,
        latencyMs: result.latencyMs,
        status: 'SUCCESS',
      });

      const out: RewriteResponseDto = { suggestion, fallback };
      this.remember(key, out);
      return out;
    } catch (err) {
      // OFF_TOPIC (BadRequest) is a SUCCESSFUL call whose trace is already completed above —
      // only genuine LLM/infra failures get a FAILED row.
      if (err instanceof BadRequestException) throw err;
      await this.tracing.markFailed(aiRequestId, startedAt, err);
      throw err;
    }
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
   * signature. Normalizes:
   *   - thousands commas ("5,000" → "5000")
   *   - trailing period ("50." → "50")
   *   - trailing zeros after a decimal point ("3.500" → "3.5", "100.0" → "100")
   *   - dangling dot after zero-strip ("100." → "100")
   * This prevents false positives when the model reformats a decimal (e.g. "3.5" → "3.500")
   * without inventing a new value. Internal dots are preserved so "1.5.0" stays "1.5.0"
   * (distinct from "150"). Idiomatic emphasis (24/7, 100%, 365) is excluded entirely to avoid
   * false fallbacks on common phrases.
   */
  private inventedNumber(input: string, out: string): boolean {
    const EMPHASIS = /\b24\/7\b|\b100\s?%|\b365\b/g;
    const digits = (s: string): string[] =>
      (s.replace(EMPHASIS, ' ').match(/\d[\d.,]*/g) ?? [])
        .map((n) =>
          n
            .replace(/,/g, '')
            .replace(/\.+$/, '')
            .replace(/(\.\d*?)0+$/, '$1')
            .replace(/\.$/, ''),
        )
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
