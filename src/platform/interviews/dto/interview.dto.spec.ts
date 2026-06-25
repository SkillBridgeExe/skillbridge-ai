import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { StartPlatformInterviewDto, InterviewListQueryDto } from './interview.dto';

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
    ['page zero', { page: '0' }],
    ['negative page', { page: '-1' }],
    ['decimal page', { page: '1.5' }],
    ['non-numeric page', { page: 'first' }],
    ['limit zero', { limit: '0' }],
    ['limit above 10', { limit: '11' }],
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
