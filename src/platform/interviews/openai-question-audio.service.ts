import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import {
  DEFAULT_INTERVIEW_SPEECH_SPEED,
  DEFAULT_INTERVIEW_VOICE,
  InterviewSessionEntity,
} from '../../database/entities/interview-session.entity';

export interface QuestionAudioResult {
  data: Buffer;
  contentType: string;
}

@Injectable()
export class OpenAiQuestionAudioService {
  private readonly logger = new Logger(OpenAiQuestionAudioService.name);
  private client: OpenAI | null = null;

  constructor(private readonly config: ConfigService) {}

  async createQuestionAudio(
    _userId: string,
    session: InterviewSessionEntity,
    question: string,
  ): Promise<QuestionAudioResult> {
    const model = this.config.get<string>('llm.openai.ttsModel') ?? 'gpt-4o-mini-tts';
    const voice = session.voice ?? DEFAULT_INTERVIEW_VOICE;
    const speed = this.speechSpeed(session.speechSpeed);

    try {
      const response = await this.getClient().audio.speech.create({
        model,
        voice,
        input: question,
        instructions: this.voiceInstructions(session),
        response_format: 'mp3',
        speed,
      });

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

  private getClient(): OpenAI {
    if (!this.client) {
      const apiKey = this.config.get<string>('llm.openai.apiKey');
      if (!apiKey) {
        throw new ServiceUnavailableException('OPENAI_API_KEY is not set');
      }
      this.client = new OpenAI({ apiKey, maxRetries: 5, timeout: 60_000 });
    }
    return this.client;
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

  private speechSpeed(value: string | number | null | undefined): number {
    const numeric = Number(value ?? DEFAULT_INTERVIEW_SPEECH_SPEED);
    return Number.isFinite(numeric)
      ? Math.round(numeric * 100) / 100
      : DEFAULT_INTERVIEW_SPEECH_SPEED;
  }
}
