import { BadRequestException, ValidationPipe } from '@nestjs/common';
import {
  AssistantAnalyzeRequestDto,
  AssistantRewriteRequestDto,
  AssistantSmartQuestionsRequestDto,
} from './cv-assistant.dto';

/**
 * P3.1 — FE↔BE request-contract lock for the CV Builder assistant.
 *
 * Every fixture below mirrors EXACTLY what the FE sends (CvBuilderSkill.tsx via
 * use-cv-builder.ts, which strips draftId into the URL path). The pipe mirrors main.ts
 * (whitelist + forbidNonWhitelisted), so an unknown field or enum value here means a
 * REAL 400 in prod. If a test in this file breaks, the FE contract broke — fix the DTO
 * or the FE, never delete the fixture.
 */
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: true },
});

function accept(metatype: new () => object, body: Record<string, unknown>) {
  return pipe.transform(body, { type: 'body', metatype, data: undefined });
}

describe('AssistantAnalyzeRequestDto / AssistantSmartQuestionsRequestDto (Turn-1)', () => {
  // What the FE sends for the rule analyze AND (± requested_action) for smart-questions.
  const base = {
    current_value: 'Worked on the project.',
    section: 'summary',
    field_path: 'summary',
    locale: 'vi',
  };

  it('accepts the analyze body the FE sends', async () => {
    await expect(accept(AssistantAnalyzeRequestDto, base)).resolves.toMatchObject(base);
  });

  it.each(['projects', 'experience'] as const)('accepts section %s', async (section) => {
    await expect(
      accept(AssistantAnalyzeRequestDto, {
        ...base,
        section,
        field_path: `${section}[0].bullets[0]`,
      }),
    ).resolves.toBeDefined();
  });

  // The 4 question chips: Analyze omits requested_action; evidence/ats/impact send it.
  it.each(['analyze', 'add_evidence', 'make_ats_friendly', 'turn_into_impact'] as const)(
    'accepts smart-questions with requested_action=%s',
    async (requested_action) => {
      await expect(
        accept(AssistantSmartQuestionsRequestDto, { ...base, requested_action }),
      ).resolves.toMatchObject({ requested_action });
    },
  );

  it('rejects an unknown requested_action', async () => {
    await expect(
      accept(AssistantSmartQuestionsRequestDto, { ...base, requested_action: 'explain' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an unknown top-level field (forbidNonWhitelisted is live)', async () => {
    // Documents that P3-6 (JD-aware matchId) REQUIRES a DTO change first — today it would 400.
    await expect(
      accept(AssistantAnalyzeRequestDto, { ...base, match_id: 'm-1' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an empty current_value', async () => {
    await expect(
      accept(AssistantAnalyzeRequestDto, { ...base, current_value: '' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('AssistantRewriteRequestDto (Turn-2)', () => {
  const base = {
    before: 'Worked on the project.',
    answers: [],
    target: 'experience[0].description',
    kind: 'bullet',
    locale: 'en',
  };

  // Improve/Shorten chips: FE fires a direct rewrite with EMPTY answers + an intent.
  it.each(['improve', 'shorten'] as const)(
    'accepts the direct transform body the FE sends for intent=%s',
    async (intent) => {
      await expect(accept(AssistantRewriteRequestDto, { ...base, intent })).resolves.toMatchObject({
        intent,
        answers: [],
      });
    },
  );

  // Submit-answers path: chip answers (+ the intent that started the session).
  it.each(['add_evidence', 'make_ats_friendly', 'turn_into_impact'] as const)(
    'accepts chip answers with intent=%s',
    async (intent) => {
      await expect(
        accept(AssistantRewriteRequestDto, {
          ...base,
          intent,
          answers: [
            { gap: 'action', option_id: 'built' },
            { gap: 'tech', option_id: 'other', detail: 'Node.js, Redis' },
            { gap: 'result', option_id: 'faster', detail: 'cut latency 30%' },
          ],
        }),
      ).resolves.toBeDefined();
    },
  );

  it('accepts a summary rewrite with summary-gap answers', async () => {
    await expect(
      accept(AssistantRewriteRequestDto, {
        ...base,
        target: 'summary',
        kind: 'summary',
        answers: [
          { gap: 'role', option_id: 'backend' },
          { gap: 'strength', option_id: 'other', detail: 'NestJS, PostgreSQL' },
          { gap: 'evidence', option_id: '1_2y' },
        ],
      }),
    ).resolves.toBeDefined();
  });

  it('accepts tone=softer ("Viết lại nhẹ hơn" follow-up)', async () => {
    await expect(
      accept(AssistantRewriteRequestDto, { ...base, tone: 'softer' }),
    ).resolves.toMatchObject({ tone: 'softer' });
  });

  it('accepts the user_clarify answer the FE "ask more" flow sends', async () => {
    // CvBuilderSkill EXTRA_CLARIFY_GAP — this exact body 400'd before P3.1.
    await expect(
      accept(AssistantRewriteRequestDto, {
        ...base,
        answers: [{ gap: 'user_clarify', option_id: 'other', detail: 'Tôi đã giảm 30% độ trễ' }],
      }),
    ).resolves.toBeDefined();
  });

  it('accepts output_lang separate from locale (UI language vs CV language)', async () => {
    await expect(
      accept(AssistantRewriteRequestDto, { ...base, locale: 'vi', output_lang: 'en' }),
    ).resolves.toMatchObject({ locale: 'vi', output_lang: 'en' });
  });

  it('rejects an unknown gap value', async () => {
    await expect(
      accept(AssistantRewriteRequestDto, {
        ...base,
        answers: [{ gap: 'vibes', option_id: 'other' }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an unknown field inside an answer item', async () => {
    await expect(
      accept(AssistantRewriteRequestDto, {
        ...base,
        answers: [{ gap: 'action', option_id: 'built', freeText: 'x' }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an answer detail over 200 chars (documented ceiling — FE must clamp)', async () => {
    await expect(
      accept(AssistantRewriteRequestDto, {
        ...base,
        answers: [{ gap: 'user_clarify', option_id: 'other', detail: 'a'.repeat(201) }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an unknown intent', async () => {
    await expect(
      accept(AssistantRewriteRequestDto, { ...base, intent: 'explanation' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a missing before/target', async () => {
    await expect(
      accept(AssistantRewriteRequestDto, { answers: [], kind: 'bullet', locale: 'en' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
