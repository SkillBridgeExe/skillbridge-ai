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
      const payload = await this.getClient(apiKey).realtime.clientSecrets.create(
        {
          session: ({
            type: 'realtime',
            model,
            instructions,
            output_modalities: ['audio'],
            speed,
            audio: {
              input: {
                transcription: {
                  model: 'gpt-4o-mini-transcribe',
                  language: transcriptionLanguage,
                  prompt:
                    transcriptionLanguage === 'vi'
                      ? 'Cuộc phỏng vấn bằng tiếng Việt. Giữ nguyên dấu tiếng Việt và các thuật ngữ kỹ thuật tiếng Anh như React, TypeScript và API.'
                      : 'English interview. Preserve technical terms such as React, TypeScript, and API exactly as spoken.',
                },
                turn_detection: {
                  type: 'server_vad',
                  create_response: false,
                  interrupt_response: true,
                },
              },
              output: {
                voice,
              },
            },
          } as unknown as ClientSecretCreateParams['session']),
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
      this.logger.warn(`OpenAI realtime token failed: ${(err as Error).message}`);
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
}
