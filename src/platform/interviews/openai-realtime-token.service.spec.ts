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
      'llm.openai.realtimeModel': 'gpt-realtime-2.1',
      ...overrides,
    };
    const config = {
      get: jest.fn((key: string) => values[key]),
    } as unknown as ConfigService;
    return new OpenAiRealtimeTokenService(config);
  }

  it('creates a v3 realtime client secret with accurate transcription and confidence data', async () => {
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
          model: 'gpt-realtime-2.1',
          instructions: expect.stringContaining('Interview instructions'),
          output_modalities: ['audio'],
          audio: expect.objectContaining({
            input: expect.objectContaining({
              transcription: expect.objectContaining({
                model: 'gpt-4o-transcribe',
                language: 'vi',
                prompt: expect.any(String),
              }),
              turn_detection: expect.objectContaining({
                type: 'semantic_vad',
                eagerness: 'low',
                create_response: false,
                interrupt_response: false,
              }),
            }),
            output: expect.objectContaining({
              voice: 'marin',
              speed: 1.15,
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
    const request = mockClientSecretsCreate.mock.calls[0][0] as {
      session: {
        audio?: {
          input?: {
            transcription?: Record<string, unknown>;
          };
        };
      };
    };
    expect(request.session).not.toHaveProperty('speed');
    expect(request.session).toEqual(
      expect.objectContaining({
        tool_choice: 'none',
        tools: [],
        include: ['item.input_audio_transcription.logprobs'],
      }),
    );
    expect(result).toEqual({
      enabled: true,
      provider: 'openai',
      model: 'gpt-realtime-2.1',
      protocolVersion: 'interview-realtime-v3',
      transcriptionModel: 'gpt-4o-transcribe',
      clientSecret: 'ek_test_secret',
      expiresAt: '2026-06-15T05:06:40.000Z',
    });
    expect(session.realtimeSessionId).toBe('sess_realtime_1');
  });

  it('sets the transcription language without sending prompt guidance', async () => {
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
              }),
            }),
          }),
        }),
      }),
      expect.any(Object),
    );
    const request = mockClientSecretsCreate.mock.calls[0][0] as {
      session: { audio?: { input?: { transcription?: Record<string, unknown> } } };
    };
    expect(request.session).toEqual(
      expect.objectContaining({
        tool_choice: 'none',
        tools: [],
        include: ['item.input_audio_transcription.logprobs'],
      }),
    );
    expect(mockClientSecretsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        session: expect.objectContaining({
          audio: expect.objectContaining({
            input: expect.objectContaining({
              turn_detection: expect.objectContaining({
                type: 'semantic_vad',
                eagerness: 'auto',
                create_response: false,
                interrupt_response: false,
              }),
            }),
          }),
        }),
      }),
      expect.any(Object),
    );
  });

  it('uses the configured realtime transcription model override', async () => {
    mockClientSecretsCreate.mockResolvedValue({
      value: 'ek_test_secret',
      expires_at: 1781500000,
      session: { id: 'sess_realtime_override' },
    });

    await serviceWithConfig({
      'llm.openai.realtimeTranscriptionModel': 'gpt-4o-mini-transcribe',
    }).createClientSecret(userId, session, 'Interview instructions');

    expect(mockClientSecretsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        session: expect.objectContaining({
          audio: expect.objectContaining({
            input: expect.objectContaining({
              transcription: expect.objectContaining({
                model: 'gpt-4o-mini-transcribe',
              }),
            }),
          }),
        }),
      }),
      expect.any(Object),
    );
  });

  it('falls back when the configured realtime transcription model is unsupported', async () => {
    mockClientSecretsCreate.mockResolvedValue({
      value: 'ek_test_secret',
      expires_at: 1781500000,
      session: { id: 'sess_realtime_fallback' },
    });

    await serviceWithConfig({
      'llm.openai.realtimeTranscriptionModel': 'unsupported-transcription-model',
    }).createClientSecret(userId, session, 'Interview instructions');

    expect(mockClientSecretsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        session: expect.objectContaining({
          audio: expect.objectContaining({
            input: expect.objectContaining({
              transcription: {
                model: 'gpt-4o-transcribe',
                language: 'vi',
                prompt: expect.any(String),
              },
            }),
          }),
        }),
      }),
      expect.any(Object),
    );
  });

  it('uses the configured default voice when the session has no saved voice', async () => {
    mockClientSecretsCreate.mockResolvedValue({
      value: 'ek_test_secret',
      expires_at: 1781500000,
      session: { id: 'sess_realtime_voice' },
    });
    const sessionWithoutVoice = {
      ...session,
      voice: undefined,
      realtimeSessionId: null,
    } as unknown as InterviewSessionEntity;

    await serviceWithConfig({ 'llm.openai.realtimeVoice': 'cedar' }).createClientSecret(
      userId,
      sessionWithoutVoice,
      'Interview instructions',
    );

    expect(mockClientSecretsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        session: expect.objectContaining({
          audio: expect.objectContaining({
            output: expect.objectContaining({
              voice: 'cedar',
            }),
          }),
        }),
      }),
      expect.any(Object),
    );
  });

  it('configures realtime with semantic VAD and no classification tool', async () => {
    mockClientSecretsCreate.mockResolvedValue({
      value: 'ek_realtime_secret',
      expires_at: 1781500000,
      session: { id: 'sess_realtime' },
    });
    const realtimeSession = {
      ...session,
      experienceMode: 'PRACTICE',
      realtimeSessionId: null,
    } as InterviewSessionEntity;

    const result = await serviceWithConfig({
      'llm.openai.realtimeModel': undefined,
    }).createClientSecret(userId, realtimeSession, 'Realtime interview instructions');

    expect(mockClientSecretsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        session: expect.objectContaining({
          model: 'gpt-realtime-2.1',
          reasoning: { effort: 'low' },
          tool_choice: 'none',
          tools: [],
          audio: expect.objectContaining({
            input: expect.objectContaining({
              turn_detection: expect.objectContaining({
                type: 'semantic_vad',
                eagerness: 'low',
                create_response: false,
                interrupt_response: false,
              }),
            }),
          }),
        }),
      }),
      expect.any(Object),
    );
    expect(result.model).toBe('gpt-realtime-2.1');
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
      model: 'gpt-realtime-2.1',
      clientSecret: null,
      reason: 'OPENAI_API_KEY is not set',
    });
  });

  it('logs only safe OpenAI metadata when client-secret creation fails', async () => {
    mockClientSecretsCreate.mockRejectedValue({
      message:
        'Invalid value for session.audio.input.transcription.model using sk-must-not-be-logged, ek_must-not-be-logged, and Bearer secret-token',
      status: 400,
      code: 'invalid_value',
      param: 'session.audio.input.transcription.model',
      request_id: 'req_realtime_123',
      apiKey: 'sk-must-not-be-logged',
    });
    const service = serviceWithConfig();
    const warn = jest
      .spyOn(
        (service as unknown as { logger: { warn: (message: unknown) => void } }).logger,
        'warn',
      )
      .mockImplementation(() => undefined);

    const result = await service.createClientSecret(userId, session, 'Interview instructions');

    expect(warn).toHaveBeenCalledTimes(1);
    const logLine = warn.mock.calls[0][0];
    expect(typeof logLine).toBe('string');
    expect(logLine).not.toContain('\n');
    const metadata = JSON.parse(logLine as string);
    expect(metadata).toEqual({
      event: 'openai_realtime_token_failed',
      status: 400,
      code: 'invalid_value',
      param: 'session.audio.input.transcription.model',
      requestId: 'req_realtime_123',
      message:
        'Invalid value for session.audio.input.transcription.model using [REDACTED], [REDACTED], and Bearer [REDACTED]',
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('sk-must-not-be-logged');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('ek_must-not-be-logged');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-token');
    expect(result).toMatchObject({
      enabled: false,
      clientSecret: null,
      reason: 'OpenAI realtime token request failed',
    });
  });
});
