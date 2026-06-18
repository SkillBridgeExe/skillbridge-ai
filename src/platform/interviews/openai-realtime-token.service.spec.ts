import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { InterviewSessionEntity } from '../../database/entities/interview-session.entity';
import { OpenAiRealtimeTokenService } from './openai-realtime-token.service';

const mockClientSecretsCreate = jest.fn();

jest.mock('openai', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    realtime: {
      clientSecrets: {
        create: mockClientSecretsCreate,
      },
    },
  })),
}));

describe('OpenAiRealtimeTokenService', () => {
  const userId = '11111111-1111-4111-8111-111111111111';
  const session = {
    id: 'interview-session-1',
    language: 'vi',
    mode: 'VOICE',
    voice: 'marin',
    speechSpeed: '1.15',
    realtimeSessionId: null,
    realtimeProvider: null,
    realtimeModel: null,
  } as unknown as InterviewSessionEntity;

  beforeEach(() => {
    jest.clearAllMocks();
    delete (globalThis as { fetch?: unknown }).fetch;
  });

  function serviceWithConfig(overrides: Record<string, string | undefined> = {}) {
    const values: Record<string, string | undefined> = {
      'llm.openai.apiKey': 'sk-test',
      'llm.openai.realtimeModel': 'gpt-realtime-2',
      ...overrides,
    };
    const config = {
      get: jest.fn((key: string) => values[key]),
    } as unknown as ConfigService;
    return new OpenAiRealtimeTokenService(config);
  }

  it('creates a realtime client secret using the current OpenAI SDK response shape', async () => {
    mockClientSecretsCreate.mockResolvedValue({
      value: 'ek_test_secret',
      expires_at: 1781500000,
      session: {
        id: 'sess_realtime_1',
      },
    });

    const result = await serviceWithConfig().createClientSecret(
      userId,
      session,
      'Interview instructions',
    );

    expect(OpenAI).toHaveBeenCalledWith({
      apiKey: 'sk-test',
      maxRetries: 2,
      timeout: 15_000,
    });
    expect(mockClientSecretsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        session: expect.objectContaining({
          type: 'realtime',
          model: 'gpt-realtime-2',
          instructions: 'Interview instructions',
          output_modalities: ['audio'],
          speed: 1.15,
          audio: expect.objectContaining({
            input: expect.objectContaining({
              transcription: expect.objectContaining({
                model: 'gpt-4o-mini-transcribe',
                language: 'vi',
                prompt: expect.stringContaining('tiếng Việt'),
              }),
            }),
            output: expect.objectContaining({
              voice: 'marin',
            }),
          }),
        }),
      }),
      expect.objectContaining({
        headers: expect.objectContaining({
          'OpenAI-Safety-Identifier': expect.any(String),
        }),
      }),
    );
    expect(result).toEqual({
      enabled: true,
      provider: 'openai',
      model: 'gpt-realtime-2',
      clientSecret: 'ek_test_secret',
      expiresAt: '2026-06-15T05:06:40.000Z',
    });
    expect(session.realtimeSessionId).toBe('sess_realtime_1');
  });

  it('configures English transcription guidance for English interview sessions', async () => {
    mockClientSecretsCreate.mockResolvedValue({
      value: 'ek_test_secret',
      expires_at: 1781500000,
      session: { id: 'sess_realtime_en' },
    });
    const englishSession = {
      ...session,
      language: 'en',
      realtimeSessionId: null,
    } as InterviewSessionEntity;

    await serviceWithConfig().createClientSecret(userId, englishSession, 'Interview instructions');

    expect(mockClientSecretsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        session: expect.objectContaining({
          audio: expect.objectContaining({
            input: expect.objectContaining({
              transcription: expect.objectContaining({
                language: 'en',
                prompt: expect.stringContaining('English interview'),
              }),
            }),
          }),
        }),
      }),
      expect.any(Object),
    );
  });

  it('returns a disabled token response when OPENAI_API_KEY is missing', async () => {
    const result = await serviceWithConfig({ 'llm.openai.apiKey': '' }).createClientSecret(
      userId,
      session,
      'Interview instructions',
    );

    expect(OpenAI).not.toHaveBeenCalled();
    expect(mockClientSecretsCreate).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      enabled: false,
      provider: 'openai',
      model: 'gpt-realtime-2',
      clientSecret: null,
      reason: 'OPENAI_API_KEY is not set',
    });
  });
});
