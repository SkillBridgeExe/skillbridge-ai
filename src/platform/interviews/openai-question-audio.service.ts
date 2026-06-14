import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { InterviewSessionEntity } from '../../database/entities/interview-session.entity';

export interface QuestionAudioResult {
  data: Buffer;
  contentType: string;
}

@Injectable()
export class OpenAiQuestionAudioService {
  private readonly logger = new Logger(OpenAiQuestionAudioService.name);

  constructor(private readonly config: ConfigService) {}

  async createQuestionAudio(
    userId: string,
    session: InterviewSessionEntity,
    question: string,
  ): Promise<QuestionAudioResult> {
    const apiKey = this.config.get<string>('llm.openai.apiKey');
    const model = this.config.get<string>('llm.openai.ttsModel') ?? 'gpt-4o-mini-tts';
    const voice = this.config.get<string>('llm.openai.ttsVoice') ?? 'alloy';
    if (!apiKey) {
      throw new ServiceUnavailableException('OPENAI_API_KEY is not set');
    }

    try {
      const response = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'OpenAI-Safety-Identifier': this.safetyIdentifier(userId),
        },
        body: JSON.stringify({
          model,
          voice,
          input: question,
          instructions: this.voiceInstructions(session),
          response_format: 'mp3',
        }),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        this.logger.warn(`OpenAI question audio failed (${response.status}): ${text}`);
        throw new ServiceUnavailableException(
          `OpenAI question audio failed with HTTP ${response.status}`,
        );
      }

      const arrayBuffer = await response.arrayBuffer();
      return {
        data: Buffer.from(arrayBuffer),
        contentType: response.headers.get('content-type') || 'audio/mpeg',
      };
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      this.logger.warn(`OpenAI question audio failed: ${(error as Error).message}`);
      throw new ServiceUnavailableException('OpenAI question audio request failed');
    }
  }

  private voiceInstructions(session: InterviewSessionEntity): string {
    const language =
      session.language === 'vi'
        ? 'Speak natural Vietnamese with a calm professional interviewer tone.'
        : 'Speak natural English with a calm professional interviewer tone.';
    return [
      language,
      'Read only the interview question. Do not add extra commentary, scoring, or advice.',
      `Target role: ${session.targetRole}. Interview type: ${session.interviewType}.`,
    ].join(' ');
  }

  private safetyIdentifier(userId: string): string {
    return createHash('sha256').update(userId).digest('hex');
  }
}
