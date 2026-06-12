import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { InterviewSessionEntity } from '../../database/entities/interview-session.entity';
import { RealtimeClientSecretDto } from './dto/interview.dto';

interface OpenAiClientSecretResponse {
  id?: string;
  client_secret?: {
    value?: string;
    expires_at?: number;
  };
}

@Injectable()
export class OpenAiRealtimeTokenService {
  private readonly logger = new Logger(OpenAiRealtimeTokenService.name);

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
      const response = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'OpenAI-Safety-Identifier': this.safetyIdentifier(userId),
        },
        body: JSON.stringify({
          session: {
            type: 'realtime',
            model,
            instructions,
            audio: {
              output: {
                voice: 'alloy',
              },
            },
          },
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        this.logger.warn(`OpenAI realtime token failed (${response.status}): ${text}`);
        return {
          enabled: false,
          provider: 'openai',
          model,
          clientSecret: null,
          expiresAt: null,
          reason: `OpenAI realtime token failed with HTTP ${response.status}`,
        };
      }

      const payload = (await response.json()) as OpenAiClientSecretResponse;
      session.realtimeSessionId = payload.id ?? session.realtimeSessionId;
      session.realtimeProvider = 'openai';
      session.realtimeModel = model;
      const expiresAt = payload.client_secret?.expires_at
        ? new Date(payload.client_secret.expires_at * 1000).toISOString()
        : null;
      return {
        enabled: true,
        provider: 'openai',
        model,
        clientSecret: payload.client_secret?.value ?? null,
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

  private safetyIdentifier(userId: string): string {
    return createHash('sha256').update(userId).digest('hex');
  }
}
