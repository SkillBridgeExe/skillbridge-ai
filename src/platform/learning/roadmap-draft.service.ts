import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SkillNormalizerService } from '../../common/services/skill-normalizer.service';
import { CanonicalCvDocument } from '../../common/types/canonical-cv';
import { CvEntity } from '../../database/entities/cv.entity';
import {
  LearningCandidateSkill,
  LearningRoadmapDraftConfig,
  LearningRoadmapEntity,
} from '../../database/entities/learning-roadmap.entity';
import { RoleRubricService, RubricBand } from '../../common/services/role-rubric.service';
import { CvMatchesService } from '../cv-matches/cv-matches.service';
import { loadSkillEdges, MIN_CONFIDENCE } from '../../modules/cv-jd-match/skill-graph';
import { RoadmapComposerService } from '../../modules/roadmap/roadmap-composer.service';
import {
  CreateLearningRoadmapDraftDto,
  LearningRoadmapDraftResponseDto,
  UpdateLearningRoadmapDraftDto,
} from './dto/roadmap.dto';
import {
  assertValidResourceSelection,
  composeLearningCandidates,
} from './learning-roadmap-resources';
import { presentLearningResources } from './learning-resource-policy';

const IMPORTANCE_WEIGHT: Record<string, number> = {
  REQUIRED: 1,
  PREFERRED: 0.6,
  NICE_TO_HAVE: 0.3,
};

export interface DerivedLearningCandidates {
  targetRole: string;
  candidates: LearningCandidateSkill[];
  sourceGapSnapshot: Record<string, unknown>;
}

@Injectable()
export class LearningRoadmapDraftService {
  constructor(
    @InjectRepository(LearningRoadmapEntity)
    private readonly roadmaps: Repository<LearningRoadmapEntity>,
    @InjectRepository(CvEntity)
    private readonly cvs: Repository<CvEntity>,
    private readonly cvMatches: CvMatchesService,
    private readonly roleRubrics: RoleRubricService,
    private readonly skillNormalizer: SkillNormalizerService,
    private readonly composer: RoadmapComposerService,
  ) {}

  async createDraft(
    userId: string,
    dto: CreateLearningRoadmapDraftDto,
  ): Promise<LearningRoadmapDraftResponseDto> {
    this.assertIntentContext(dto);

    let derived: DerivedLearningCandidates;
    if (dto.intent === 'JD_APPLICATION') {
      derived = await this.deriveJdCandidates(
        userId,
        dto.cv_match_id as string,
        dto.language_pref ?? 'en',
      );
    } else {
      derived = await this.deriveCareerCandidates(
        userId,
        dto.target_role as string,
        (dto.target_level ?? 'fresher') as RubricBand,
        dto.cv_id as string,
      );
    }
    const { targetRole, candidates } = derived;

    const draftConfig: LearningRoadmapDraftConfig = {
      language_pref: dto.language_pref ?? 'en',
      source_target_role: targetRole || null,
      source_cv_id: dto.intent === 'CAREER_ROLE' ? (dto.cv_id as string) : null,
      candidate_skills: candidates,
    };
    const entity = this.roadmaps.create({
      userId,
      intent: dto.intent,
      status: 'DRAFT',
      cvMatchId: dto.intent === 'JD_APPLICATION' ? (dto.cv_match_id as string) : null,
      targetRole: dto.intent === 'CAREER_ROLE' ? targetRole : targetRole || null,
      targetLevel: dto.intent === 'CAREER_ROLE' ? (dto.target_level ?? 'fresher') : null,
      activeVersionId: null,
      revision: 0,
      draftConfig,
    });
    // The DB constraint requires target_role null for JD intent; the role remains in the source snapshot.
    if (dto.intent === 'JD_APPLICATION') entity.targetRole = null;
    const saved = await this.roadmaps.save(entity);
    return this.toResponse(saved, targetRole || null);
  }

  async rederiveCurrentCandidates(
    userId: string,
    roadmap: LearningRoadmapEntity,
  ): Promise<DerivedLearningCandidates> {
    if (roadmap.intent === 'JD_APPLICATION') {
      if (!roadmap.cvMatchId) throw new BadRequestException('Roadmap has no source CV/JD match.');
      return this.deriveJdCandidates(userId, roadmap.cvMatchId, roadmap.draftConfig.language_pref);
    }
    const cvId = roadmap.draftConfig.source_cv_id;
    if (!roadmap.targetRole || !cvId) {
      throw new BadRequestException('Career roadmap has incomplete source context.');
    }
    return this.deriveCareerCandidates(
      userId,
      roadmap.targetRole,
      (roadmap.targetLevel ?? 'fresher') as RubricBand,
      cvId,
    );
  }

  async updateDraft(
    userId: string,
    roadmapId: string,
    dto: UpdateLearningRoadmapDraftDto,
  ): Promise<LearningRoadmapDraftResponseDto> {
    const existing = await this.roadmaps.findOne({ where: { id: roadmapId, userId } });
    if (!existing || existing.status !== 'DRAFT') {
      throw new NotFoundException(`Learning roadmap draft '${roadmapId}' was not found.`);
    }
    if (existing.revision !== dto.expected_revision) {
      throw new ConflictException('Learning roadmap draft has changed; reload before saving.');
    }

    const nextConfig: LearningRoadmapDraftConfig = {
      ...existing.draftConfig,
      ...(dto.language_pref ? { language_pref: dto.language_pref } : {}),
      ...(dto.selected_priorities ? { selected_priorities: dto.selected_priorities } : {}),
      ...(dto.selected_resources ? { selected_resources: dto.selected_resources } : {}),
      ...(dto.cadence ? { cadence: dto.cadence } : {}),
      ...(dto.schedule ? { schedule: dto.schedule } : {}),
      ...(dto.deadline && existing.draftConfig.schedule
        ? { schedule: { ...existing.draftConfig.schedule, deadline: dto.deadline } }
        : {}),
    };
    this.assertSelectedCandidates(nextConfig);
    if (dto.selected_resources) {
      const validationBudget = nextConfig.schedule
        ? {
            available_days: Math.max(
              1,
              Math.floor(
                (Date.parse(`${nextConfig.schedule.deadline}T00:00:00.000Z`) - Date.now()) /
                  86_400_000,
              ) + 1,
            ),
            hours_per_week: Number(
              (
                nextConfig.schedule.slots.reduce((sum, slot) => sum + slot.duration_minutes, 0) / 60
              ).toFixed(2),
            ),
          }
        : { available_days: 1, hours_per_week: 0 };
      const composed = composeLearningCandidates(
        this.composer,
        nextConfig.candidate_skills,
        nextConfig.language_pref,
        validationBudget,
      );
      const learningTrack = existing.intent === 'JD_APPLICATION' ? 'FAST_TRACK' : 'FOUNDATION';
      const policyComposed = {
        ...composed,
        steps: composed.steps.map((step) => ({
          ...step,
          resources: presentLearningResources(step.resources, learningTrack),
        })),
      };
      assertValidResourceSelection(
        nextConfig.candidate_skills,
        policyComposed,
        dto.selected_resources,
      );
    }

    const updateResult = await this.roadmaps.update(
      { id: roadmapId, userId, status: 'DRAFT', revision: dto.expected_revision },
      { draftConfig: nextConfig, revision: dto.expected_revision + 1 },
    );
    if (updateResult.affected !== 1) {
      throw new ConflictException('Learning roadmap draft has changed; reload before saving.');
    }
    const updated = await this.roadmaps.findOne({ where: { id: roadmapId, userId } });
    if (!updated)
      throw new NotFoundException(`Learning roadmap draft '${roadmapId}' was not found.`);
    return this.toResponse(updated);
  }

  async list(userId: string): Promise<LearningRoadmapDraftResponseDto[]> {
    const rows = await this.roadmaps.find({ where: { userId }, order: { updatedAt: 'DESC' } });
    return rows.map((row) => this.toResponse(row));
  }

  private async deriveJdCandidates(
    userId: string,
    matchId: string,
    languagePref: 'vi' | 'en' | 'both',
  ): Promise<DerivedLearningCandidates> {
    const report = await this.cvMatches.getGapReport(
      userId,
      matchId,
      languagePref === 'en' ? 'en' : 'vi',
    );
    const targetRole = report.target_role ?? '';
    const learnableGaps = report.gap_items.filter(
      (item) =>
        item.fixability === 'learn' &&
        Boolean(item.canonical_name) &&
        ['hard_skill', 'soft_skill', 'language'].includes(item.type),
    );
    const candidates = learnableGaps
      .map((item) => ({
        skill_canonical: item.canonical_name,
        display_name: item.display_name,
        system_priority: round3(
          item.severity * (IMPORTANCE_WEIGHT[item.importance] ?? IMPORTANCE_WEIGHT.PREFERRED),
        ),
        rationale: item.recommended_next_action || `${item.display_name} is required.`,
        prerequisites: [],
      }))
      .sort((a, b) => b.system_priority - a.system_priority);
    return {
      targetRole,
      candidates: attachCandidatePrerequisites(candidates, targetRole),
      sourceGapSnapshot: { source: 'cv_match', target_role: targetRole, gaps: learnableGaps },
    };
  }

  private async deriveCareerCandidates(
    userId: string,
    targetRole: string,
    band: RubricBand,
    cvId: string,
  ): Promise<DerivedLearningCandidates> {
    const rubric = this.roleRubrics.getRubric(targetRole, band);
    if (!rubric) {
      throw new BadRequestException(`Career role '${targetRole}' is not supported.`);
    }
    const cv = await this.cvs.findOne({ where: { id: cvId, userId } });
    if (!cv) throw new BadRequestException(`CV '${cvId}' was not found.`);
    if (!cv.parsedJson) {
      throw new BadRequestException(`CV '${cvId}' has no parsed skill profile.`);
    }
    const knownSkills = new Set(
      this.skillNormalizer
        .normalizeMany(extractCvSkillMentions(cv.parsedJson))
        .map((skill) => skill.canonical_name)
        .filter(Boolean),
    );
    const candidates = rubric.skills
      .filter((skill) => !knownSkills.has(skill.skill_canonical_name))
      .map((skill) => ({
        skill_canonical: skill.skill_canonical_name,
        display_name: skill.skill_canonical_name,
        system_priority: round3(skill.weight),
        rationale: `${skill.importance} skill for ${rubric.display_name_en}.`,
        prerequisites: [],
      }))
      .sort((a, b) => b.system_priority - a.system_priority);
    return {
      targetRole,
      candidates: attachCandidatePrerequisites(candidates, targetRole),
      sourceGapSnapshot: {
        source: 'career_role',
        target_role: targetRole,
        target_level: band,
        cv_id: cvId,
        known_skills: [...knownSkills].sort(),
        missing_skills: candidates.map((candidate) => candidate.skill_canonical),
      },
    };
  }

  private assertIntentContext(dto: CreateLearningRoadmapDraftDto): void {
    const hasMatch = Boolean(dto.cv_match_id);
    const hasCv = Boolean(dto.cv_id);
    const hasRole = Boolean(dto.target_role);
    if (dto.intent === 'JD_APPLICATION' && (!hasMatch || hasRole || hasCv)) {
      throw new BadRequestException(
        'JD_APPLICATION requires cv_match_id and forbids target_role and cv_id.',
      );
    }
    if (dto.intent === 'CAREER_ROLE' && (!hasRole || !hasCv || hasMatch)) {
      throw new BadRequestException(
        'CAREER_ROLE requires target_role and cv_id, and forbids cv_match_id.',
      );
    }
  }

  private assertSelectedCandidates(config: LearningRoadmapDraftConfig): void {
    if (!config.selected_priorities) return;
    const candidates = new Set(config.candidate_skills.map((item) => item.skill_canonical));
    const selected = new Set<string>();
    for (const item of config.selected_priorities) {
      if (!candidates.has(item.skill_canonical)) {
        throw new BadRequestException(
          `Skill '${item.skill_canonical}' is not a roadmap candidate.`,
        );
      }
      if (selected.has(item.skill_canonical)) {
        throw new BadRequestException(
          `Skill '${item.skill_canonical}' is selected more than once.`,
        );
      }
      selected.add(item.skill_canonical);
    }
  }

  private toResponse(
    row: LearningRoadmapEntity,
    derivedTargetRole?: string | null,
  ): LearningRoadmapDraftResponseDto {
    return {
      id: row.id,
      intent: row.intent,
      status: row.status,
      revision: row.revision,
      cv_match_id: row.cvMatchId,
      cv_id: row.draftConfig.source_cv_id ?? null,
      target_role:
        row.targetRole ?? row.draftConfig.source_target_role ?? derivedTargetRole ?? null,
      target_level: row.targetLevel,
      language_pref: row.draftConfig.language_pref,
      candidate_skills: row.draftConfig.candidate_skills,
      selected_priorities: row.draftConfig.selected_priorities ?? [],
      selected_resources: row.draftConfig.selected_resources ?? {},
      cadence: row.draftConfig.cadence ?? null,
      schedule: row.draftConfig.schedule ?? null,
    };
  }
}

function extractCvSkillMentions(document: CanonicalCvDocument): string[] {
  const skills = document.skills;
  return [
    ...(skills?.technical ?? []),
    ...(skills?.soft ?? []),
    ...(skills?.languages ?? []),
    ...(skills?.tools ?? []),
    ...(document.projects ?? []).flatMap((project) => project.tech ?? []),
  ];
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function attachCandidatePrerequisites(
  candidates: LearningCandidateSkill[],
  targetRole: string,
): LearningCandidateSkill[] {
  const selected = new Set(candidates.map((item) => item.skill_canonical));
  const prerequisites = new Map<string, string[]>();
  for (const edge of loadSkillEdges()) {
    if (edge.type !== 'ecosystem' || edge.confidence < MIN_CONFIDENCE) continue;
    if (!edge.roles.includes('*') && !edge.roles.includes(targetRole)) continue;
    if (!selected.has(edge.from) || !selected.has(edge.to)) continue;
    const existing = prerequisites.get(edge.to) ?? [];
    if (!existing.includes(edge.from)) existing.push(edge.from);
    prerequisites.set(edge.to, existing);
  }
  return candidates.map((candidate) => ({
    ...candidate,
    prerequisites: prerequisites.get(candidate.skill_canonical) ?? [],
  }));
}
