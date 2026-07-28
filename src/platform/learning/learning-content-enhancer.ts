import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LlmService } from '../../infrastructure/llm/llm.service';
import { PromptsService } from '../../modules/prompts/prompts.service';
import type { LearningRoadmapPreviewResponseDto } from './dto/roadmap.dto';

const PROMPT_CODE = 'learning_content_enhance_v1';
const TIMEOUT_MS = 8_000;

interface EnhancedLesson {
  id: string;
  title: string;
  summary: string;
  key_points: string[];
}

const RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['lessons'],
  properties: {
    lessons: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'summary', 'key_points'],
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          summary: { type: 'string' },
          key_points: { type: 'array', items: { type: 'string' }, maxItems: 5 },
        },
      },
    },
  },
};

@Injectable()
export class LearningContentEnhancer {
  private readonly logger = new Logger(LearningContentEnhancer.name);

  constructor(
    private readonly llm: LlmService,
    private readonly prompts: PromptsService,
    private readonly config: ConfigService,
  ) {}

  async enhance(
    preview: LearningRoadmapPreviewResponseDto,
  ): Promise<LearningRoadmapPreviewResponseDto> {
    if (!this.config.get<boolean>('learning.contentAiEnabled')) return preview;
    const included = preview.modules.flatMap((module) =>
      module.lessons
        .filter((lesson) => lesson.scope_status === 'INCLUDED')
        .map((lesson) => ({
          id: lesson.id,
          title: lesson.title,
          summary: lesson.summary,
          key_points: lesson.key_points,
        })),
    );
    if (included.length === 0) return preview;

    try {
      const template = this.prompts.get(PROMPT_CODE);
      const prompt = this.prompts.render(PROMPT_CODE, {
        lessons: JSON.stringify(included),
      });
      const result = await this.llm.complete(
        [
          { role: 'system', content: template.meta.system ?? '' },
          { role: 'user', content: prompt },
        ],
        {
          jsonMode: true,
          responseSchema: RESPONSE_SCHEMA,
          temperature: 0,
          maxOutputTokens: 2_500,
          timeoutMs: TIMEOUT_MS,
          maxRetries: 0,
          model: this.config.get<string>('learning.contentAiModel') || undefined,
        },
      );
      const enhanced = validateEnhancement(
        result.parsedJson,
        new Set(included.map((item) => item.id)),
      );
      const byId = new Map(enhanced.map((lesson) => [lesson.id, lesson]));
      return applyEnhancement(preview, byId, 'AI_ENHANCED');
    } catch (error) {
      this.logger.warn(`Learning content enhancement degraded: ${(error as Error).message}`);
      return applyEnhancement(preview, new Map(), 'DETERMINISTIC_FALLBACK');
    }
  }
}

function validateEnhancement(value: unknown, expectedIds: Set<string>): EnhancedLesson[] {
  if (
    !value ||
    typeof value !== 'object' ||
    !Array.isArray((value as { lessons?: unknown }).lessons)
  ) {
    throw new Error('Learning enhancement response has no lessons array.');
  }
  const lessons = (value as { lessons: unknown[] }).lessons;
  if (lessons.length !== expectedIds.size) {
    throw new Error('Learning enhancement response does not cover every included lesson.');
  }
  const seen = new Set<string>();
  return lessons.map((value): EnhancedLesson => {
    if (!value || typeof value !== 'object') throw new Error('Invalid enhanced lesson.');
    const lesson = value as Record<string, unknown>;
    const id = typeof lesson.id === 'string' ? lesson.id : '';
    const title = typeof lesson.title === 'string' ? lesson.title.trim() : '';
    const summary = typeof lesson.summary === 'string' ? lesson.summary.trim() : '';
    const keyPoints = Array.isArray(lesson.key_points)
      ? lesson.key_points.filter(
          (item): item is string => typeof item === 'string' && Boolean(item.trim()),
        )
      : [];
    if (!expectedIds.has(id) || seen.has(id) || !title || !summary || keyPoints.length === 0) {
      throw new Error(`Invalid enhanced lesson '${id || 'unknown'}'.`);
    }
    seen.add(id);
    return { id, title, summary, key_points: keyPoints.slice(0, 5) };
  });
}

function applyEnhancement(
  preview: LearningRoadmapPreviewResponseDto,
  enhancedById: Map<string, EnhancedLesson>,
  contentSource: 'AI_ENHANCED' | 'DETERMINISTIC_FALLBACK',
): LearningRoadmapPreviewResponseDto {
  return {
    ...preview,
    content_source: contentSource,
    modules: preview.modules.map((module) => ({
      ...module,
      lessons: module.lessons.map((lesson) => {
        if (lesson.scope_status !== 'INCLUDED') return lesson;
        const enhanced = enhancedById.get(lesson.id);
        return {
          ...lesson,
          ...(enhanced
            ? {
                title: enhanced.title,
                summary: enhanced.summary,
                key_points: enhanced.key_points,
              }
            : {}),
          content_source: contentSource,
        };
      }),
    })),
  };
}
