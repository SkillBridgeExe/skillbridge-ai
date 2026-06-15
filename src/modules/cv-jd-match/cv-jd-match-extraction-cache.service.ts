import { createHash } from 'node:crypto';
import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { LlmExtractionCacheEntity } from '../../database/entities/llm-extraction-cache.entity';
import { maskPiiDeep } from '../../common/services/pii-mask';
import { JdDimension, normalizeJdDimensions } from '../gap-engine/jd-dimensions';
import { RawCvSkill, RawJdRequirement } from './skill-diff.service';

export interface CvJdMatchCachedExtraction {
  cv_skills_raw: RawCvSkill[];
  jd_requirements_raw: RawJdRequirement[];
  jd_dimensions_raw: unknown[];
  jd_dimensions: JdDimension[];
}

export interface CvJdMatchExtractionCacheKeyInput {
  cvText: string;
  jdText?: string | null;
  templateCode: string;
  provider: string;
  modelCode: string;
}

export interface CvJdMatchExtractionCacheMetadata {
  provider: string;
  modelCode: string;
  templateCode: string;
  promptTemplateVersion: number;
}

@Injectable()
export class CvJdMatchExtractionCacheService {
  constructor(
    private readonly config: ConfigService,
    @Optional()
    @InjectRepository(LlmExtractionCacheEntity)
    private readonly repo?: Repository<LlmExtractionCacheEntity>,
  ) {}

  hashKey(input: CvJdMatchExtractionCacheKeyInput): string {
    const parts = [
      normalizeCacheText(input.cvText),
      normalizeCacheText(input.jdText ?? ''),
      input.templateCode,
      input.provider,
      input.modelCode,
    ];
    return createHash('sha256').update(parts.join('\0')).digest('hex');
  }

  async read(cacheKey: string): Promise<CvJdMatchCachedExtraction | null> {
    if (!this.canUseCache()) return null;
    const row = await this.repo!.findOne({ where: { cacheKey } });
    if (!row) return null;
    return coerceCachedExtraction(row.payload);
  }

  async write(
    cacheKey: string,
    extraction: CvJdMatchCachedExtraction,
    metadata: CvJdMatchExtractionCacheMetadata,
  ): Promise<void> {
    if (!this.canUseCache()) return;
    const payload = {
      cv_skills_raw: extraction.cv_skills_raw,
      jd_requirements_raw: extraction.jd_requirements_raw,
      jd_dimensions_raw: extraction.jd_dimensions_raw,
    };
    await this.repo!.upsert(
      {
        cacheKey,
        payload: maskPiiDeep(payload),
        provider: metadata.provider,
        modelCode: metadata.modelCode,
        templateCode: metadata.templateCode,
        promptTemplateVersion: metadata.promptTemplateVersion,
      },
      ['cacheKey'],
    );
  }

  async recordHit(cacheKey: string): Promise<void> {
    if (!this.canUseCache()) return;
    await this.repo!.increment({ cacheKey }, 'hitCount', 1);
    await this.repo!.update({ cacheKey }, { lastHitAt: new Date() });
  }

  private canUseCache(): boolean {
    return this.config.get<boolean>('cvJdMatch.extractionCacheEnabled') !== false && !!this.repo;
  }
}

function normalizeCacheText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .trim();
}

function coerceCachedExtraction(payload: unknown): CvJdMatchCachedExtraction | null {
  if (!payload || typeof payload !== 'object') return null;
  const obj = payload as Record<string, unknown>;
  return {
    cv_skills_raw: Array.isArray(obj.cv_skills_raw) ? (obj.cv_skills_raw as RawCvSkill[]) : [],
    jd_requirements_raw: Array.isArray(obj.jd_requirements_raw)
      ? (obj.jd_requirements_raw as RawJdRequirement[])
      : [],
    jd_dimensions_raw: Array.isArray(obj.jd_dimensions_raw) ? obj.jd_dimensions_raw : [],
    jd_dimensions: normalizeJdDimensions(
      Array.isArray(obj.jd_dimensions_raw) ? obj.jd_dimensions_raw : obj.jd_dimensions,
    ),
  };
}
