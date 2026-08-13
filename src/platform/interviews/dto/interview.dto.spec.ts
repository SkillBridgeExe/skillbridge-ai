import { BadRequestException, ValidationPipe } from '@nestjs/common';
import {
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

  it('normalizes a realtime exchange with nested speech metadata', async () => {
    const result = await pipe.transform(
      {
        kind: 'REALTIME_EXCHANGE',
        clientTurnId: 'turn-client-1',
        questionTurnId: '24bc0d94-37c6-4e9f-b356-b0c6bfad61d7',
        input: {
          type: 'ANSWER',
          modality: 'AUDIO',
          transcript: '  Tôi phụ trách phần nối API authen.  ',
          intent: 'ANSWER',
          intentSource: 'VOICE_LEXICAL',
          itemIds: ['item-1'],
          speechStartedAt: '2026-08-10T10:00:00.000Z',
          speechEndedAt: '2026-08-10T10:00:02.000Z',
          segmentCount: 2,
          meanLogprob: -0.42,
        },
        assistant: {
          responseId: 'resp_123',
          transcript: 'Bạn đã nối API auth. Bạn quản lý session như thế nào?',
          firstAudioAt: '2026-08-10T10:00:02.800Z',
          interrupted: false,
        },
      },
      { type: 'body', metatype: RealtimeInterviewTurnDto, data: undefined },
    );

    expect(result.input?.transcript).toBe('Tôi phụ trách phần nối API authen.');
    expect(result.input?.segmentCount).toBe(2);
    expect(result.assistant?.responseId).toBe('resp_123');
  });

  it('accepts text fallback without directive metadata', async () => {
    await expect(
      pipe.transform(
        {
          kind: 'TEXT_FALLBACK',
          clientTurnId: 'text-1',
          questionTurnId: '24bc0d94-37c6-4e9f-b356-b0c6bfad61d7',
          text: 'Tôi dùng JWT và refresh token.',
          intent: 'ANSWER',
        },
        { type: 'body', metatype: RealtimeInterviewTurnDto, data: undefined },
      ),
    ).resolves.toMatchObject({ kind: 'TEXT_FALLBACK', text: 'Tôi dùng JWT và refresh token.' });
  });

  it('rejects malformed exchange enums and client ids', async () => {
    await expect(
      pipe.transform(
        {
          kind: 'DIRECTIVE',
          clientTurnId: '',
          input: { type: 'CLASSIFY', modality: 'VIDEO', intentSource: 'MODEL' },
        },
        { type: 'body', metatype: RealtimeInterviewTurnDto, data: undefined },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
