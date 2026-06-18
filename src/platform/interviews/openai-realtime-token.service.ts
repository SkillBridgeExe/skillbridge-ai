import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import OpenAI from 'openai';
import type { ClientSecretCreateParams } from 'openai/resources/realtime/client-secrets';
import {
  DEFAULT_INTERVIEW_SPEECH_SPEED,
  DEFAULT_INTERVIEW_VOICE,
  InterviewSessionEntity,
} from '../../database/entities/interview-session.entity';
import { RealtimeClientSecretDto } from './dto/interview.dto';

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
      const voice = session.voice ?? DEFAULT_INTERVIEW_VOICE;
      const speed = this.speechSpeed(session.speechSpeed);
      const realtimeSession: ClientSecretCreateParams['session'] = {
        type: 'realtime',
        model,
        instructions,
        output_modalities: ['audio'],
        audio: {
          input: {
            transcription: {
              model: 'gpt-4o-mini-transcribe',
              language: transcriptionLanguage,
            },
            turn_detection: {
              type: 'server_vad',
              create_response: session.mode === 'VOICE',
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
      this.logger.warn(this.safeErrorMetadata(err));
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

  private safeErrorMetadata(error: unknown): {
    event: 'openai_realtime_token_failed';
    status?: number;
    code?: string;
    requestId?: string;
  } {
    const value =
      error && typeof error === 'object' ? (error as Record<string, unknown>) : undefined;
    const status = typeof value?.status === 'number' ? value.status : undefined;
    const code = typeof value?.code === 'string' ? value.code : undefined;
    const rawRequestId = value?.request_id ?? value?.requestId;
    const requestId = typeof rawRequestId === 'string' ? rawRequestId : undefined;

    return {
      event: 'openai_realtime_token_failed',
      ...(status === undefined ? {} : { status }),
      ...(code === undefined ? {} : { code }),
      ...(requestId === undefined ? {} : { requestId }),
    };
  }
}
