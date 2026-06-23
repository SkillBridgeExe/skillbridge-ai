import { Injectable, Logger } from '@nestjs/common';
import { LlmService } from '../../infrastructure/llm/llm.service';
import { PromptsService } from '../prompts/prompts.service';
import { TracingService } from '../tracing/tracing.service';
import { maskPii } from '../../common/services/pii-mask';
import {
  ExperienceExtraction,
  ExperienceFieldKey,
  IntakeLlmOutput,
  assembleExtraction,
} from './cv-intake';

const PROMPT_CODE = 'cv_intake_experience_v1';

/** The model may output exactly this shape — code grounds every atom against the narrative. */
const INTAKE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['fields'],
  properties: {
    fields: {
      type: 'object',
      additionalProperties: false,
      properties: {
        company: {
          type: 'object',
          additionalProperties: false,
          properties: {
            value: { type: 'string' },
            source_span: { type: 'string' },
          },
        },
        position: {
          type: 'object',
          additionalProperties: false,
          properties: {
            value: { type: 'string' },
            source_span: { type: 'string' },
          },
        },
        description: {
          type: 'object',
          additionalProperties: false,
          properties: {
            value: { type: 'array', items: { type: 'string' } },
            source_span: { type: 'string' },
          },
        },
        achievements: {
          type: 'object',
          additionalProperties: false,
          properties: {
            value: { type: 'array', items: { type: 'string' } },
            source_span: { type: 'string' },
          },
        },
      },
    },
  },
};

const FIELD_ORDER: ExperienceFieldKey[] = [
  'company',
  'position',
  'start',
  'end',
  'description',
  'achievements',
];

export interface CvIntakeInput {
  section: 'experience';
  /** the user's free-text story about ONE work-experience entry. */
  narrative: string;
  /** UI language (for any user-facing message). */
  locale: 'vi' | 'en';
  /** the CV's language (for the extracted text). */
  outputLang: 'vi' | 'en';
}

export type CvIntakeResult = ExperienceExtraction & { degraded?: boolean };

/** Every field absent / dropped — the honest, never-throw fallback. */
function degradedResult(): CvIntakeResult {
  const fields = {} as ExperienceExtraction['fields'];
  for (const key of FIELD_ORDER) {
    fields[key] = { value: '', found: false, confidence: 'low', source_span: '' };
  }
  return { fields, missing: [...FIELD_ORDER], degraded: true };
}

/**
 * Stage 1 of the narrative CV-intake pipeline: turn a free-text work-experience story into structured
 * fields. ONE schema-enforced, temp-0 LLM extraction → `assembleExtraction` (deterministic dates +
 * per-field grounding gate). Degrade-never-throw: any LLM/parse failure → all fields `found:false` +
 * `degraded:true`, never a fabricated value. Mirrors CvAssistantRewriteService.
 */
@Injectable()
export class CvIntakeService {
  private readonly logger = new Logger(CvIntakeService.name);

  constructor(
    private readonly llm: LlmService,
    private readonly prompts: PromptsService,
    private readonly tracing: TracingService,
  ) {}

  async extract(input: CvIntakeInput, userId = 'system'): Promise<CvIntakeResult> {
    const startedAt = Date.now();
    let aiRequestId: string | undefined;
    try {
      const template = this.prompts.get(PROMPT_CODE);
      aiRequestId = await this.tracing
        .startAiRequest({
          userId,
          modelCode: '',
          promptTemplateCode: template.code,
          promptTemplateVersion: template.version,
          requestType: 'cv_intake_experience',
          requestPayload: { section: input.section, output_lang: input.outputLang },
        })
        .catch(() => undefined);

      const userPrompt = this.prompts.render(PROMPT_CODE, {
        narrative: maskPii(input.narrative),
        output_lang: input.outputLang,
      });

      const llmResult = await this.llm.complete(
        [
          { role: 'system', content: template.meta.system ?? '' },
          { role: 'user', content: userPrompt },
        ],
        {
          provider: 'openai',
          jsonMode: true,
          responseSchema: INTAKE_SCHEMA,
          temperature: 0,
          maxOutputTokens: 600,
          model: process.env.CV_INTAKE_MODEL || undefined,
        },
      );

      const parsed = (llmResult.parsedJson ?? null) as Partial<IntakeLlmOutput> | null;
      if (!parsed || typeof parsed.fields !== 'object' || parsed.fields === null)
        throw new Error('cv_intake_experience: bad model output');

      // Ground against the RAW narrative (the model only ever saw maskPii'd text). This is
      // intentional: a value the model echoes as a redaction token ([redacted-email]) is absent from
      // the raw narrative → dropped to found:false rather than leaked into the CV. Prefer honest-missing
      // over surfacing a placeholder; PII never reaches the model in the first place (line above).
      const extraction = assembleExtraction(input.narrative, { fields: parsed.fields });

      if (aiRequestId) {
        await this.tracing
          .completeAiRequest(aiRequestId, {
            promptTokens: llmResult.tokenUsage.promptTokens,
            completionTokens: llmResult.tokenUsage.completionTokens,
            totalTokens: llmResult.tokenUsage.totalTokens,
            estimatedCost: llmResult.estimatedCostUsd,
            latencyMs: llmResult.latencyMs,
            status: 'SUCCESS',
            modelCode: llmResult.modelCode,
          })
          .catch(() => undefined);
      }

      return { ...extraction, degraded: false };
    } catch (err) {
      if (aiRequestId)
        await this.tracing.markFailed(aiRequestId, startedAt, err).catch(() => undefined);
      this.logger.warn(`cv_intake_experience degraded: ${(err as Error).message}`);
      return degradedResult();
    }
  }
}
