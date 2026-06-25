import { assertStrictSchema } from './strict-schema';

// Every production structured-output schema (passed to the OpenAI provider with strict:true).
import { DIAGNOSIS_CHAT_SCHEMA } from '../../modules/diagnosis-chat/diagnosis-chat.service';
import { INTAKE_SCHEMA } from '../../modules/cv-intake/cv-intake.service';
import { REWRITE_SCHEMA } from '../../modules/cv-assistant/cv-assistant.service';
import { ANSWER_INSIGHT_SCHEMA } from '../../modules/interview/answer-insight';
import { COACHING_SCHEMA } from '../../modules/interview/interview-coaching';
import { INTERVIEW_SCORING_RESPONSE_SCHEMA } from '../../modules/interview/interview.service';
import { CHAT_SCHEMA } from '../../modules/learning-chat/learning-chat.service';
import {
  INTERVIEW_ASSESS_SCHEMA,
  INTERVIEW_ASK_SCHEMA,
} from '../../platform/interviews/interview-chain-llm.service';

describe('assertStrictSchema (the validator itself)', () => {
  it('passes a fully strict object', () => {
    expect(() =>
      assertStrictSchema({
        type: 'object',
        additionalProperties: false,
        required: ['a', 'b'],
        properties: { a: { type: 'string' }, b: { type: ['string', 'null'] } },
      }),
    ).not.toThrow();
  });

  it('is a no-op for non-object leaves', () => {
    expect(() => assertStrictSchema({ type: 'string' })).not.toThrow();
    expect(() => assertStrictSchema({ type: ['number', 'null'] })).not.toThrow();
  });

  it('rejects an object missing additionalProperties:false', () => {
    expect(() =>
      assertStrictSchema({
        type: 'object',
        required: ['a'],
        properties: { a: { type: 'string' } },
      }),
    ).toThrow(/additionalProperties/);
  });

  it('rejects an object whose required omits a property (the cv_intake bug class)', () => {
    expect(() =>
      assertStrictSchema({
        type: 'object',
        additionalProperties: false,
        required: ['fields'],
        properties: {
          fields: {
            type: 'object',
            additionalProperties: false,
            required: ['company'],
            properties: { company: { type: 'object' } }, // company object has no properties/required
          },
        },
      }),
    ).toThrow(/\$\.fields\.company/);
  });

  it('rejects a nullable object with no properties (the interview_end body_language bug)', () => {
    expect(() =>
      assertStrictSchema({
        type: 'object',
        additionalProperties: false,
        required: ['body_language'],
        properties: { body_language: { type: ['object', 'null'] } },
      }),
    ).toThrow(/body_language/);
  });

  it('rejects when required lists a key not in properties', () => {
    expect(() =>
      assertStrictSchema({
        type: 'object',
        additionalProperties: false,
        required: ['a', 'b'],
        properties: { a: { type: 'string' } },
      }),
    ).toThrow(/required/);
  });

  it('recurses into array items', () => {
    expect(() =>
      assertStrictSchema({
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: { a: { type: 'string' } },
        },
      }),
    ).toThrow(/required/);
  });
});

describe('all production structured-output schemas are OpenAI strict-valid', () => {
  const SCHEMAS: Record<string, unknown> = {
    DIAGNOSIS_CHAT_SCHEMA,
    INTAKE_SCHEMA,
    REWRITE_SCHEMA,
    ANSWER_INSIGHT_SCHEMA,
    COACHING_SCHEMA,
    INTERVIEW_SCORING_RESPONSE_SCHEMA,
    CHAT_SCHEMA,
    INTERVIEW_ASSESS_SCHEMA,
    INTERVIEW_ASK_SCHEMA,
  };

  for (const [name, schema] of Object.entries(SCHEMAS)) {
    it(`${name} is strict-valid`, () => {
      expect(() => assertStrictSchema(schema)).not.toThrow();
    });
  }
});
