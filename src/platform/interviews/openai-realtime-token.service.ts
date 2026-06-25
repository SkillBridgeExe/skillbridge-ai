import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import OpenAI from 'openai';
import type { ClientSecretCreateParams } from 'openai/resources/realtime/client-secrets';
import {
  DEFAULT_INTERVIEW_SPEECH_SPEED,
  InterviewSessionEntity,
} from '../../database/entities/interview-session.entity';
import { RealtimeClientSecretDto } from './dto/interview.dto';
import { resolveInterviewVoice } from './interview-voice';

const DEFAULT_REALTIME_TRANSCRIPTION_MODEL = 'gpt-4o-mini-transcribe';
const SUPPORTED_REALTIME_TRANSCRIPTION_MODELS = [
  'whisper-1',
  'gpt-4o-mini-transcribe',
  'gpt-4o-mini-transcribe-2025-12-15',
  'gpt-4o-transcribe',
  'gpt-4o-transcribe-diarize',
  'gpt-realtime-whisper',
] as const;

@Injectable()
export class OpenAiRealtimeTokenService {
  private readonly logger = new Logger(OpenAiRealtimeTokenService.name);
  private client: OpenAI | null = null;

  constructor(private readonly config: ConfigService) {}

  async createClientSecret(
    userId: string,
    session: InterviewSessionEntity,
    instructions: string,
  ): Promise<RealtimeClientSecretDto> {
    const apiKey = this.config.get<string>('llm.openai.apiKey');
    const model = this.config.get<string>('llm.openai.realtimeModel') ?? 'gpt-realtime-2';
    if (!apiKey) {
      return {
        enabled: false,
        provider: 'openai',
        model,
        clientSecret: null,
        expiresAt: null,
        reason: 'OPENAI_API_KEY is not set',
      };
    }

    try {
      const transcriptionLanguage = session.language === 'vi' ? 'vi' : 'en';
      const transcriptionModel = this.transcriptionModel(
        this.config.get<string>('llm.openai.realtimeTranscriptionModel'),
      );
      const voice = resolveInterviewVoice(
        session.voice,
        this.config.get<string>('llm.openai.ttsVoice'),
      );
      const speed = this.speechSpeed(session.speechSpeed);
      const realtimeSession: ClientSecretCreateParams['session'] = {
        type: 'realtime',
        model,
        instructions,
        output_modalities: ['audio'],
        audio: {
          input: {
            transcription: {
              model: transcriptionModel,
              language: transcriptionLanguage,
            },
            turn_detection: {
              type: 'server_vad',
              create_response: false,
              interrupt_response: true,
            },
          },
          output: {
            voice,
            speed,
          },
        },
      };
      const payload = await this.getClient(apiKey).realtime.clientSecrets.create(
        {
          session: realtimeSession,
        },
        {
          headers: {
            'OpenAI-Safety-Identifier': this.safetyIdentifier(userId),
          },
        },
      );

      session.realtimeSessionId = payload.session?.id ?? session.realtimeSessionId;
      session.realtimeProvider = 'openai';
      session.realtimeModel = model;
      const expiresAt = payload.expires_at
        ? new Date(payload.expires_at * 1000).toISOString()
        : null;
      return {
        enabled: true,
        provider: 'openai',
        model,
        clientSecret: payload.value,
        expiresAt,
      };
    } catch (err) {
      this.logger.warn(JSON.stringify(this.safeErrorMetadata(err)));
      return {
        enabled: false,
        provider: 'openai',
        model,
        clientSecret: null,
        expiresAt: null,
        reason: 'OpenAI realtime token request failed',
      };
    }
  }

  private getClient(apiKey: string): OpenAI {
    if (!this.client) {
      this.client = new OpenAI({ apiKey, maxRetries: 2, timeout: 15_000 });
    }
    return this.client;
  }

  private safetyIdentifier(userId: string): string {
    return createHash('sha256').update(userId).digest('hex');
  }

  private speechSpeed(value: string | number | null | undefined): number {
    const numeric = Number(value ?? DEFAULT_INTERVIEW_SPEECH_SPEED);
    return Number.isFinite(numeric)
      ? Math.round(numeric * 100) / 100
      : DEFAULT_INTERVIEW_SPEECH_SPEED;
  }

  private transcriptionModel(value: string | null | undefined): string {
    return (SUPPORTED_REALTIME_TRANSCRIPTION_MODELS as readonly string[]).includes(value ?? '')
      ? (value as string)
      : DEFAULT_REALTIME_TRANSCRIPTION_MODEL;
  }

  private safeErrorMetadata(error: unknown): {
    event: 'openai_realtime_token_failed';
    status?: number;
    code?: string;
    param?: string;
    requestId?: string;
    message?: string;
  } {
    const value =
      error && typeof error === 'object' ? (error as Record<string, unknown>) : undefined;
    const nestedError =
      value?.error && typeof value.error === 'object'
        ? (value.error as Record<string, unknown>)
        : undefined;
    const status = typeof value?.status === 'number' ? value.status : undefined;
    const rawCode = value?.code ?? nestedError?.code;
    const code = typeof rawCode === 'string' ? rawCode : undefined;
    const rawParam = value?.param ?? nestedError?.param;
    const param = typeof rawParam === 'string' ? rawParam : undefined;
    const rawRequestId =
      value?.request_id ?? value?.requestId ?? nestedError?.request_id ?? nestedError?.requestId;
    const requestId = typeof rawRequestId === 'string' ? rawRequestId : undefined;
    const rawMessage = value?.message ?? nestedError?.message;
    const message =
      typeof rawMessage === 'string'
        ? this.sanitizeErrorMessage(rawMessage, [value?.apiKey, nestedError?.apiKey])
        : undefined;

    return {
      event: 'openai_realtime_token_failed',
      ...(status === undefined ? {} : { status }),
      ...(code === undefined ? {} : { code }),
      ...(param === undefined ? {} : { param }),
      ...(requestId === undefined ? {} : { requestId }),
      ...(message === undefined ? {} : { message }),
    };
  }

  private sanitizeErrorMessage(message: string, explicitSecrets: unknown[]): string {
    let sanitized = message;
    for (const secret of explicitSecrets) {
      if (typeof secret === 'string' && secret.length >= 8) {
        sanitized = sanitized.split(secret).join('[REDACTED]');
      }
    }
    return sanitized
      .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
      .replace(/\bsk-[A-Za-z0-9_-]+/g, '[REDACTED]')
      .replace(/\bek_[A-Za-z0-9_-]+/g, '[REDACTED]')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 500);
  }
}
