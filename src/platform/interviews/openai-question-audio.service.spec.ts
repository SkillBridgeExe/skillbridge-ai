import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { InterviewSessionEntity } from '../../database/entities/interview-session.entity';
import { OpenAiQuestionAudioService } from './openai-question-audio.service';

const mockSpeechCreate = jest.fn();

jest.mock('openai', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    audio: {
      speech: {
        create: mockSpeechCreate,
      },
    },
  })),
}));

describe('OpenAiQuestionAudioService', () => {
  const session = {
    language: 'vi',
    targetRole: 'frontend_developer',
    interviewType: 'TECHNICAL',
  } as InterviewSessionEntity;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function serviceWithConfig(overrides: Record<string, string | undefined> = {}) {
    const values: Record<string, string | undefined> = {
      'llm.openai.apiKey': 'sk-test',
      'llm.openai.ttsModel': 'gpt-4o-mini-tts',
      'llm.openai.ttsVoice': 'alloy',
      ...overrides,
    };
    const config = {
      get: jest.fn((key: string) => values[key]),
    } as unknown as ConfigService;
    return new OpenAiQuestionAudioService(config);
  }

  function audioResponse(bytes = [1, 2, 3], contentType: string | null = 'audio/mpeg') {
    const data = Uint8Array.from(bytes);
    return {
      arrayBuffer: jest.fn(async () =>
        data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
      ),
      headers: {
        get: jest.fn((name: string) =>
          name.toLowerCase() === 'content-type' ? contentType : null,
        ),
      },
    } as unknown as Response;
  }

  it('uses the OpenAI SDK speech API with interview voice instructions', async () => {
    mockSpeechCreate.mockResolvedValue(audioResponse([7, 8, 9]));
    const fetchSpy = jest.spyOn(globalThis, 'fetch');

    const result = await serviceWithConfig().createQuestionAudio(
      'user-1',
      session,
      'Tell me about your latest React project.',
    );

    expect(OpenAI).toHaveBeenCalledWith({
      apiKey: 'sk-test',
      maxRetries: 5,
      timeout: 60_000,
    });
    expect(mockSpeechCreate).toHaveBeenCalledWith({
      model: 'gpt-4o-mini-tts',
      voice: 'alloy',
      input: 'Tell me about your latest React project.',
      instructions: expect.stringContaining('Speak natural Vietnamese'),
      response_format: 'mp3',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result).toEqual({
      data: Buffer.from([7, 8, 9]),
      contentType: 'audio/mpeg',
    });

    fetchSpy.mockRestore();
  });

  it('defaults to audio/mpeg when the SDK response has no content type', async () => {
    mockSpeechCreate.mockResolvedValue(audioResponse([4, 5, 6], null));

    const result = await serviceWithConfig().createQuestionAudio(
      'user-1',
      session,
      'Question without explicit content type.',
    );

    expect(result.contentType).toBe('audio/mpeg');
  });

  it('throws a service unavailable error when OPENAI_API_KEY is missing', async () => {
    await expect(
      serviceWithConfig({ 'llm.openai.apiKey': '' }).createQuestionAudio(
        'user-1',
        session,
        'Question?',
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(OpenAI).not.toHaveBeenCalled();
    expect(mockSpeechCreate).not.toHaveBeenCalled();
  });

  it('wraps OpenAI SDK failures as service unavailable errors', async () => {
    mockSpeechCreate.mockRejectedValue(new Error('rate limit'));

    await expect(
      serviceWithConfig().createQuestionAudio('user-1', session, 'Question?'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
