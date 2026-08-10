import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LlmService } from '../../infrastructure/llm/llm.service';
import { PromptsService } from '../../modules/prompts/prompts.service';
import type { LearningRoadmapPreviewResponseDto } from './dto/roadmap.dto';
import { isSkillBridgeLessonContent } from '../../modules/roadmap/skillbridge-lesson-content';

const PROMPT_CODE = 'learning_content_enhance_v1';
const TIMEOUT_MS = 8_000;
const MODULE_CONCURRENCY = 3;

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

type PreviewModule = LearningRoadmapPreviewResponseDto['modules'][number];
type EnhancementSource = 'AI_ENHANCED' | 'DETERMINISTIC_FALLBACK';

interface EnhancementResult {
  module: PreviewModule;
  source: EnhancementSource;
}

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

    let hasEnhancedModule = false;
    let hasFallbackModule = false;
    const modules: LearningRoadmapPreviewResponseDto['modules'] = [];

    for (let start = 0; start < preview.modules.length; start += MODULE_CONCURRENCY) {
      const batch = preview.modules.slice(start, start + MODULE_CONCURRENCY);
      const settled = await Promise.allSettled(
        batch.map((module) => this.enhanceModule(preview, module)),
      );

      settled.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          modules.push(result.value.module);
          if (result.value.source === 'AI_ENHANCED') hasEnhancedModule = true;
          else hasFallbackModule = true;
          return;
        }

        const module = batch[index];
        this.logger.error(
          'Learning content enhancement failed unexpectedly for ' +
            module.skill_canonical +
            ': ' +
            (result.reason instanceof Error ? result.reason.message : String(result.reason)),
        );
        modules.push(
          applyEnhancement({ ...preview, modules: [module] }, new Map(), 'DETERMINISTIC_FALLBACK')
            .modules[0],
        );
        hasFallbackModule = true;
      });
    }

    return {
      ...preview,
      content_source: hasFallbackModule
        ? 'DETERMINISTIC_FALLBACK'
        : hasEnhancedModule
          ? 'AI_ENHANCED'
          : preview.content_source,
      modules,
    };
  }

  private async enhanceModule(
    preview: LearningRoadmapPreviewResponseDto,
    module: PreviewModule,
  ): Promise<EnhancementResult> {
    const included = module.lessons
      .filter((lesson) => lesson.scope_status === 'INCLUDED')
      .map((lesson) => ({
        id: lesson.id,
        title: lesson.title,
        summary: lesson.summary,
        key_points: lesson.key_points,
      }));

    if (included.length === 0) {
      return {
        module: applyEnhancement(
          { ...preview, modules: [module] },
          new Map(),
          'DETERMINISTIC_FALLBACK',
        ).modules[0],
        source: 'DETERMINISTIC_FALLBACK',
      };
    }

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
      return {
        module: applyEnhancement({ ...preview, modules: [module] }, byId, 'AI_ENHANCED').modules[0],
        source: 'AI_ENHANCED',
      };
    } catch (error) {
      this.logger.warn(
        'Learning content enhancement degraded for ' +
          module.skill_canonical +
          ': ' +
          (error instanceof Error ? error.message : String(error)),
      );
      return {
        module: applyEnhancement(
          { ...preview, modules: [module] },
          new Map(),
          'DETERMINISTIC_FALLBACK',
        ).modules[0],
        source: 'DETERMINISTIC_FALLBACK',
      };
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
    const rawKeyPoints = lesson.key_points;
    if (!Array.isArray(rawKeyPoints) || rawKeyPoints.length === 0 || rawKeyPoints.length > 5) {
      throw new Error(`Invalid enhanced lesson '${id || 'unknown'}'.`);
    }
    const keyPoints = rawKeyPoints.map((item) => (typeof item === 'string' ? item.trim() : ''));
    if (
      !expectedIds.has(id) ||
      seen.has(id) ||
      !title ||
      !summary ||
      title.length > 160 ||
      summary.length > 1000 ||
      keyPoints.length === 0 ||
      keyPoints.some((point) => !point || point.length > 240)
    ) {
      throw new Error(`Invalid enhanced lesson '${id || 'unknown'}'.`);
    }
    seen.add(id);
    return { id, title, summary, key_points: keyPoints };
  });
}

function materializeLessonContent(
  raw: Record<string, unknown> | null,
  skillCanonical: string,
  enhancedById: Map<string, EnhancedLesson>,
): Record<string, unknown> | null {
  if (!isSkillBridgeLessonContent(raw)) return raw;
  const lesson = raw;
  return {
    ...lesson,
    sections: lesson.sections.map((section) => {
      const enhanced = enhancedById.get(skillCanonical + ':section:' + section.id);
      if (!enhanced) return section;
      return {
        ...section,
        title: enhanced.title,
        body: enhanced.summary,
        checklist: section.checklist.map((item, index) => ({
          ...item,
          label: enhanced.key_points[index] ?? item.label,
        })),
      };
    }),
    exercises: lesson.exercises.map((exercise) => {
      const enhanced = enhancedById.get(skillCanonical + ':exercise:' + exercise.id);
      if (!enhanced) return exercise;
      return {
        ...exercise,
        title: enhanced.title,
        prompt: enhanced.summary,
        acceptance_criteria: exercise.acceptance_criteria.map(
          (item, index) => enhanced.key_points[index] ?? item,
        ),
      };
    }),
  };
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
      lesson_content: materializeLessonContent(
        module.lesson_content,
        module.skill_canonical,
        enhancedById,
      ),
      lessons: module.lessons.map((lesson) => {
        if (lesson.scope_status !== 'INCLUDED') {
          return contentSource === 'DETERMINISTIC_FALLBACK'
            ? { ...lesson, content_source: contentSource }
            : lesson;
        }
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
