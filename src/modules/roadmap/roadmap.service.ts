import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import { ERROR_CODES } from '../../common/constants/error-codes';
import { LlmService } from '../../infrastructure/llm/llm.service';
import { PromptsService } from '../prompts/prompts.service';
import { TracingService } from '../tracing/tracing.service';
import { RoadmapGenerateRequestDto, RoadmapSkillRequirementDto } from './dto/roadmap-request.dto';
import {
  RoadmapGenerateResponseDto,
  RoadmapParsedResponse,
  RoadmapPhase,
  RoadmapStep,
} from './dto/roadmap-response.dto';
import { CourseMatcherService, CourseMatchRequest } from './course-matcher.service';

interface LlmRoadmapStructure {
  title: string;
  total_weeks: number;
  phases: RoadmapPhase[];
  steps: Omit<RoadmapStep, 'recommended_courses'>[];
  ai_summary: string;
  ai_advice: string;
}

/**
 * Refactored roadmap generation:
 *
 *   1. Input is the PRE-COMPUTED gap (missing_skills + partial_skills) from cv-jd-match.
 *      Roadmap doesn't re-do skill extraction.
 *
 *   2. LLM generates STRUCTURE only: phases, step ordering, weeks, learning objectives.
 *      The prompt forbids LLM from inventing course names or "resource keywords".
 *
 *   3. CourseMatcherService maps each step's `skill_canonical_names` to real courses
 *      from the catalog (with deterministic scoring). NO LLM hallucination of courses.
 *
 *   4. Merge: LLM structure + real courses per step → final roadmap.
 *
 * Result: structurally personalized by LLM, but every course is real and traceable.
 */
@Injectable()
export class RoadmapService {
  private readonly logger = new Logger(RoadmapService.name);

  constructor(
    private readonly llm: LlmService,
    private readonly prompts: PromptsService,
    private readonly tracing: TracingService,
    private readonly courseMatcher: CourseMatcherService,
  ) {}

  async generate(
    userId: string,
    input: RoadmapGenerateRequestDto,
  ): Promise<RoadmapGenerateResponseDto> {
    const template = this.prompts.get(input.prompt_template_code);

    // ─── Step 1: build prompt with normalized gap data ──────────────────────
    const userPrompt = this.prompts.render(input.prompt_template_code, {
      target_role: input.target_role,
      hours_per_week: input.hours_per_week,
      missing_skills_json: JSON.stringify(input.missing_skills),
      partial_skills_json: JSON.stringify(input.partial_skills ?? []),
      user_profile: JSON.stringify(input.user_profile ?? {}),
    });

    const aiRequestId = await this.tracing.startAiRequest({
      userId,
      modelCode: '',
      promptTemplateCode: template.code,
      promptTemplateVersion: template.version,
      requestType: 'roadmap_generate',
      requestPayload: {
        target_role: input.target_role,
        hours_per_week: input.hours_per_week,
        missing_count: input.missing_skills.length,
        partial_count: (input.partial_skills ?? []).length,
      },
    });

    // ─── Step 2: LLM generates structure (NO courses) ───────────────────────
    const llmResult = await this.llm.complete(
      [
        { role: 'system', content: template.meta.system ?? '' },
        { role: 'user', content: userPrompt },
      ],
      // Slightly higher temp than scoring tasks — designing learning paths benefits
      // from minor creativity (sequencing, phase naming), but still anchored by rubric.
      { jsonMode: true, temperature: 0.3, maxOutputTokens: 3500 },
    );

    await this.tracing.completeAiRequest(aiRequestId, {
      promptTokens: llmResult.tokenUsage.promptTokens,
      completionTokens: llmResult.tokenUsage.completionTokens,
      totalTokens: llmResult.tokenUsage.totalTokens,
      latencyMs: llmResult.latencyMs,
      status: 'SUCCESS',
    });

    const structure = this.parseLlmStructure(llmResult.parsedJson);

    // ─── Step 3: sanity-check skill references against the input gap ────────
    const allInputSkills = new Set([
      ...input.missing_skills.map((s) => s.skill_canonical_name),
      ...(input.partial_skills ?? []).map((s) => s.skill_canonical_name),
    ]);

    const uncoveredSkillsByLlm: Set<string> = new Set();
    for (const step of structure.steps) {
      for (const sk of step.skill_canonical_names ?? []) {
        if (!allInputSkills.has(sk)) uncoveredSkillsByLlm.add(sk);
      }
    }
    if (uncoveredSkillsByLlm.size > 0) {
      this.logger.warn(
        `Roadmap LLM referenced skills not in the input gap: ${[...uncoveredSkillsByLlm].join(', ')}. ` +
          `These will still be matched against catalog but are signal of prompt drift.`,
      );
    }

    // ─── Step 4: CourseMatcher fills real courses per step ──────────────────
    const allRequests = this.buildMatchRequests(
      structure,
      input.missing_skills,
      input.partial_skills,
    );
    const matcherResult = this.courseMatcher.matchCourses(allRequests);

    // Index by skill for quick lookup
    const coursesBySkill = new Map<string, (typeof matcherResult.per_skill)[number]['courses']>();
    for (const entry of matcherResult.per_skill) {
      coursesBySkill.set(entry.skill_canonical_name, entry.courses);
    }

    const steps: RoadmapStep[] = structure.steps.map((s) => {
      // Aggregate courses across all skills this step addresses, dedupe by course id, take top 3.
      const aggregated = (s.skill_canonical_names ?? [])
        .flatMap((sk) => coursesBySkill.get(sk) ?? [])
        .filter((c, idx, arr) => arr.findIndex((cc) => cc.id === c.id) === idx)
        .sort((a, b) => b.match_score - a.match_score)
        .slice(0, 3);
      return {
        ...s,
        recommended_courses: aggregated,
      };
    });

    const parsed: RoadmapParsedResponse = {
      title: structure.title,
      total_weeks: structure.total_weeks,
      phases: structure.phases,
      steps,
      ai_summary: structure.ai_summary,
      ai_advice: structure.ai_advice,
      uncovered_skills: [...uncoveredSkillsByLlm],
      skills_without_courses: matcherResult.uncovered_skills,
    };

    await this.tracing.saveAiResult({
      aiRequestId,
      userId,
      resultType: 'roadmap_generate',
      rawResponse: llmResult.rawResponse,
      parsedResponse: parsed,
      tokenUsage: llmResult.tokenUsage.totalTokens,
    });

    return {
      ai_request_id: aiRequestId,
      parsed_response: parsed,
      retrieval_log_id: null,
      retrieved_chunks_count: 0,
      token_usage: llmResult.tokenUsage.totalTokens,
    };
  }

  /**
   * Build a flat list of (skill, required_level, weight) to query catalog.
   * Required level for matching = the input gap's required_level.
   * If LLM step references a skill not in input gap, we use level 3 as default.
   */
  private buildMatchRequests(
    structure: LlmRoadmapStructure,
    missing: RoadmapSkillRequirementDto[],
    partial: RoadmapSkillRequirementDto[] | undefined,
  ): CourseMatchRequest[] {
    const levelLookup = new Map<string, number>();
    const weightLookup = new Map<string, number>();
    for (const m of missing) {
      levelLookup.set(m.skill_canonical_name, m.required_level);
      if (m.weight !== undefined) weightLookup.set(m.skill_canonical_name, m.weight);
    }
    for (const p of partial ?? []) {
      levelLookup.set(p.skill_canonical_name, p.required_level);
      if (p.weight !== undefined) weightLookup.set(p.skill_canonical_name, p.weight);
    }

    const requestedSkills = new Set<string>();
    for (const step of structure.steps) {
      for (const sk of step.skill_canonical_names ?? []) {
        requestedSkills.add(sk);
      }
    }

    return [...requestedSkills].map((sk) => ({
      skill_canonical_name: sk,
      required_level: levelLookup.get(sk) ?? 3,
      weight: weightLookup.get(sk),
    }));
  }

  private parseLlmStructure(raw: unknown): LlmRoadmapStructure {
    if (!raw || typeof raw !== 'object') {
      throw new BadGatewayException({
        code: ERROR_CODES.AI_ANALYSIS_FAILED,
        message: 'Roadmap LLM returned non-object',
      });
    }
    const obj = raw as Record<string, unknown>;
    return {
      title: typeof obj.title === 'string' ? (obj.title as string) : 'Learning Roadmap',
      total_weeks: typeof obj.total_weeks === 'number' ? (obj.total_weeks as number) : 8,
      phases: Array.isArray(obj.phases) ? (obj.phases as RoadmapPhase[]) : [],
      steps: Array.isArray(obj.steps) ? (obj.steps as LlmRoadmapStructure['steps']) : [],
      ai_summary: typeof obj.ai_summary === 'string' ? (obj.ai_summary as string) : '',
      ai_advice: typeof obj.ai_advice === 'string' ? (obj.ai_advice as string) : '',
    };
  }
}
