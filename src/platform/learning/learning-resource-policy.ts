import type { LearningTrack } from './learning-content-planner';

type ResourceRole = 'PRIMARY' | 'SUPPLEMENTARY';
type DurationKind = 'EXACT' | 'ESTIMATED' | 'UNKNOWN';
type LanguageVerification = 'AUDIO_METADATA' | 'PUBLISHER_METADATA' | 'MANUAL' | 'UNKNOWN';

interface ResourceChapter {
  id: string;
  title: string;
  start_seconds: number;
}

interface LearningResourceView extends Record<string, unknown> {
  id: string;
  source_type: string;
  title: string;
  language: string;
  duration_minutes?: number;
  validation_status: string;
  video_chapters?: ResourceChapter[];
}

export interface LearningResourcePresentation {
  resource_role: ResourceRole;
  duration_kind: DurationKind;
  language_verification: LanguageVerification;
  recommended_minutes?: number;
  recommended_segment?: {
    label: string;
    chapter_ids: string[];
    start_seconds: number;
  };
}

const CJK_SCRIPT = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/u;

export function presentLearningResources<T extends Record<string, unknown>>(
  rawResources: T[],
  track: LearningTrack,
): Array<T & LearningResourcePresentation> {
  const eligible = rawResources
    .map((original) => ({ original, resource: asResource(original) }))
    .filter(
      (
        item,
      ): item is {
        original: T;
        resource: LearningResourceView;
      } => Boolean(item.resource),
    )
    .filter(
      ({ resource }) =>
        resource.validation_status === 'verified' &&
        resource.language === 'en' &&
        !CJK_SCRIPT.test(resource.title),
    )
    .filter(
      ({ resource }) =>
        track !== 'FAST_TRACK' ||
        resource.duration_minutes === undefined ||
        resource.duration_minutes <= 180 ||
        Boolean(resource.video_chapters?.length),
    );
  const primaryMaxMinutes = track === 'FAST_TRACK' ? 180 : 480;
  const primaryIndex = eligible.findIndex(
    ({ resource }) =>
      (resource.duration_minutes !== undefined && resource.duration_minutes <= primaryMaxMinutes) ||
      Boolean(resource.video_chapters?.length),
  );
  const ordered =
    primaryIndex < 0
      ? eligible
      : [eligible[primaryIndex], ...eligible.filter((_resource, index) => index !== primaryIndex)];

  return ordered.slice(0, 3).map(({ original, resource }, index) => {
    const chapter = resource.video_chapters?.[0];
    return {
      ...original,
      resource_role: primaryIndex >= 0 && index === 0 ? 'PRIMARY' : 'SUPPLEMENTARY',
      duration_kind: durationKind(resource),
      language_verification: languageVerification(resource),
      ...(chapter
        ? {
            recommended_minutes: Math.min(60, resource.duration_minutes ?? 60),
            recommended_segment: {
              label: chapter.title,
              chapter_ids: [chapter.id],
              start_seconds: chapter.start_seconds,
            },
          }
        : {}),
    };
  });
}

function asResource(value: Record<string, unknown>): LearningResourceView | undefined {
  if (
    typeof value.id !== 'string' ||
    typeof value.source_type !== 'string' ||
    typeof value.title !== 'string' ||
    typeof value.language !== 'string' ||
    typeof value.validation_status !== 'string'
  ) {
    return undefined;
  }
  const chapters = Array.isArray(value.video_chapters)
    ? value.video_chapters
        .map((chapter) => {
          if (!chapter || typeof chapter !== 'object' || Array.isArray(chapter)) return undefined;
          const row = chapter as Record<string, unknown>;
          return typeof row.id === 'string' &&
            typeof row.title === 'string' &&
            typeof row.start_seconds === 'number'
            ? { id: row.id, title: row.title, start_seconds: row.start_seconds }
            : undefined;
        })
        .filter((chapter): chapter is ResourceChapter => Boolean(chapter))
    : undefined;
  return {
    ...value,
    id: value.id,
    source_type: value.source_type,
    title: value.title,
    language: value.language,
    validation_status: value.validation_status,
    ...(typeof value.duration_minutes === 'number' && Number.isFinite(value.duration_minutes)
      ? { duration_minutes: value.duration_minutes }
      : {}),
    ...(chapters?.length ? { video_chapters: chapters } : {}),
  };
}

function durationKind(resource: LearningResourceView): DurationKind {
  if (resource.duration_minutes === undefined) return 'UNKNOWN';
  return resource.source_type === 'video' ? 'EXACT' : 'ESTIMATED';
}

function languageVerification(resource: LearningResourceView): LanguageVerification {
  const value = resource.language_verification;
  if (
    value === 'AUDIO_METADATA' ||
    value === 'PUBLISHER_METADATA' ||
    value === 'MANUAL' ||
    value === 'UNKNOWN'
  ) {
    return value;
  }
  return resource.source_type === 'video' ? 'MANUAL' : 'PUBLISHER_METADATA';
}
