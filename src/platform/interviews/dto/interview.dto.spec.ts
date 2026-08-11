import { BadRequestException, ValidationPipe } from '@nestjs/common';
import {
  CommitRealtimeAssistantMessageDto,
  InterviewListQueryDto,
  RealtimeInterviewTurnDto,
  StartPlatformInterviewDto,
} from './interview.dto';

describe('InterviewListQueryDto', () => {
  const pipe = new ValidationPipe({
    transform: true,
    transformOptions: { enableImplicitConversion: true },
  });

  function transform(query: Record<string, string>) {
    return pipe.transform(query, {
      type: 'query',
      metatype: InterviewListQueryDto,
      data: undefined,
    });
  }

  it('transforms page and limit query strings into integers', async () => {
    await expect(transform({ page: '1', limit: '10' })).resolves.toEqual({
      page: 1,
      limit: 10,
    });
  });

  it('uses the documented pagination defaults when query parameters are omitted', async () => {
    await expect(transform({})).resolves.toEqual({
      page: 1,
      limit: 10,
    });
  });

  it.each([
    ['true', true],
    ['false', false],
  ])('transforms scoredOnly=%s into a boolean', async (value, expected) => {
    await expect(transform({ scoredOnly: value })).resolves.toEqual({
      page: 1,
      limit: 10,
      scoredOnly: expected,
    });
  });

  it.each([
    ['page zero', { page: '0' }],
    ['negative page', { page: '-1' }],
    ['decimal page', { page: '1.5' }],
    ['non-numeric page', { page: 'first' }],
    ['limit zero', { limit: '0' }],
    ['limit above 10', { limit: '11' }],
    ['invalid scored-only filter', { scoredOnly: 'yes' }],
  ])('rejects %s', async (_name, query) => {
    await expect(transform(query)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('StartPlatformInterviewDto voice settings', () => {
  const pipe = new ValidationPipe({
    transform: true,
    transformOptions: { enableImplicitConversion: true },
  });

  function transform(body: Record<string, unknown>) {
    return pipe.transform(body, {
      type: 'body',
      metatype: StartPlatformInterviewDto,
      data: undefined,
    });
  }

  const baseBody = {
    targetRole: 'frontend_developer',
  };

  it('leaves voice unset for server config resolution and defaults speech speed', async () => {
    await expect(transform(baseBody)).resolves.toMatchObject({
      voice: undefined,
      speechSpeed: 1.15,
    });
  });

  it('accepts a supported voice and rounds speech speed to two decimals', async () => {
    await expect(
      transform({
        ...baseBody,
        voice: 'coral',
        speechSpeed: '1.156',
      }),
    ).resolves.toMatchObject({
      voice: 'coral',
      speechSpeed: 1.16,
    });
  });

  it('rejects the removed hybrid interview mode', async () => {
    await expect(transform({ ...baseBody, mode: 'HYBRID' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('accepts the explicit experience modes', async () => {
    await expect(transform({ ...baseBody, experienceMode: 'PRACTICE' })).resolves.toMatchObject({
      experienceMode: 'PRACTICE',
    });
  });

  it('rejects an unknown experience mode', async () => {
    await expect(transform({ ...baseBody, experienceMode: 'COACH' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it.each([
    ['unsupported voice', { voice: 'nova' }],
    ['too slow', { speechSpeed: '0.74' }],
    ['too fast', { speechSpeed: '1.51' }],
    ['non-numeric speed', { speechSpeed: 'fast' }],
    ['NaN speed', { speechSpeed: Number.NaN }],
  ])('rejects %s', async (_name, patch) => {
    await expect(transform({ ...baseBody, ...patch })).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('Realtime interview DTOs', () => {
  const pipe = new ValidationPipe({ transform: true });

  it('normalizes a realtime turn and accepts client timing metadata', async () => {
    const result = await pipe.transform(
      {
        clientTurnId: 'turn-client-1',
        transcript: '  I do not know this answer yet.  ',
        modality: 'AUDIO',
        intent: 'NO_ANSWER',
        answerSignal: 'NO_ANSWER',
        speechEndedAt: '2026-08-10T10:00:00.000Z',
        responseDelayMs: 420,
      },
      { type: 'body', metatype: RealtimeInterviewTurnDto, data: undefined },
    );

    expect(result).toMatchObject({
      clientTurnId: 'turn-client-1',
      transcript: 'I do not know this answer yet.',
      modality: 'AUDIO',
      intent: 'NO_ANSWER',
      answerSignal: 'NO_ANSWER',
      responseDelayMs: 420,
    });
  });

  it('rejects malformed realtime turn enums and client ids', async () => {
    await expect(
      pipe.transform(
        {
          clientTurnId: '',
          transcript: 'answer',
          modality: 'VIDEO',
          intent: 'MAYBE',
          answerSignal: 'UNKNOWN',
        },
        { type: 'body', metatype: RealtimeInterviewTurnDto, data: undefined },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('validates the committed assistant message contract', async () => {
    await expect(
      pipe.transform(
        {
          responseId: 'resp_123',
          interviewerMessage: 'Thank you.',
          interviewerQuestion: 'How would you design this cache?',
          firstAudioAt: '2026-08-10T10:00:01.100Z',
          interrupted: false,
        },
        {
          type: 'body',
          metatype: CommitRealtimeAssistantMessageDto,
          data: undefined,
        },
      ),
    ).resolves.toMatchObject({
      responseId: 'resp_123',
      interrupted: false,
    });
  });
});
