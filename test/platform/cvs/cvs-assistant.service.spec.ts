import { NotFoundException } from '@nestjs/common';
import { CvsService } from '../../../src/platform/cvs/cvs.service';
import type { CvAssistantRewriteResult } from '../../../src/modules/cv-assistant/cv-assistant.service';
import type {
  AssistantAnalyzeRequestDto,
  AssistantRewriteRequestDto,
} from '../../../src/platform/cvs/dto/cv-assistant.dto';

function build(
  opts: {
    owned?: boolean;
    rewriteResult?: CvAssistantRewriteResult;
    skills?: Record<string, string[]>;
  } = {},
) {
  const cv = {
    id: 'cv1',
    userId: 'u1',
    cvKind: 'BUILT',
    parsedJson: opts.skills ? { skills: opts.skills } : null,
  };
  const cvsRepo = { findOne: jest.fn().mockResolvedValue(opts.owned === false ? null : cv) };
  const entitlements = {
    assertCanUse: jest.fn().mockResolvedValue(undefined),
    recordUsage: jest.fn().mockResolvedValue(undefined),
  };
  const defaultPatch: CvAssistantRewriteResult = {
    ok: true,
    field_patch: {
      target: 'projects[0].bullets[0]',
      before: 'Worked on it.',
      after: 'Built the backend with Node.js.',
      why: 'from your answers',
    },
  };
  const cvAssistant = {
    rewrite: jest.fn().mockResolvedValue(opts.rewriteResult ?? defaultPatch),
  };
  const any = {} as never;
  const service = new CvsService(
    cvsRepo as never, // 1 cvs repo (findOwnedCv)
    any,
    any,
    any,
    any,
    any,
    any,
    any,
    any,
    any,
    any, // 2-11
    any, // 12 roleInference
    any, // 13 storyExtraction
    any,
    any, // 14 analysisQuota
    entitlements as never, // 15 entitlements
    any, // 16 skillDiff
    undefined, // 17 interviewPlan
    undefined, // 18 githubEvidence
    undefined, // 19 tailorVerifier
    cvAssistant as never, // 20 cvAssistant
  );
  return { service, cvsRepo, entitlements, cvAssistant };
}

const analyzeDto: AssistantAnalyzeRequestDto = {
  current_value: 'Worked on the project.',
  section: 'projects',
  locale: 'en',
};
const rewriteDto: AssistantRewriteRequestDto = {
  before: 'Worked on it.',
  answers: [
    { gap: 'action', option_id: 'built' },
    { gap: 'tech', option_id: 'backend', detail: 'Node.js' },
  ],
  target: 'projects[0].bullets[0]',
  locale: 'en',
};

describe('CvsService — Companion assistant endpoints', () => {
  describe('assistantAnalyze (Turn-1)', () => {
    it('rejects a CV the user does not own', async () => {
      const { service } = build({ owned: false });
      await expect(service.assistantAnalyze('u1', 'cvX', analyzeDto)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('returns Turn-1 questions for a weak bullet WITHOUT touching quota', async () => {
      const { service, entitlements } = build();
      const turn = await service.assistantAnalyze('u1', 'cv1', analyzeDto);
      expect(turn).not.toBeNull();
      expect(turn!.questions.length).toBeGreaterThan(0);
      expect(turn!.field_patch).toBeNull();
      expect(entitlements.assertCanUse).not.toHaveBeenCalled();
    });
  });

  describe('assistantRewrite (Turn-2)', () => {
    it('rejects a CV the user does not own (before any quota/LLM)', async () => {
      const { service, entitlements } = build({ owned: false });
      await expect(service.assistantRewrite('u1', 'cvX', rewriteDto)).rejects.toThrow(
        NotFoundException,
      );
      expect(entitlements.assertCanUse).not.toHaveBeenCalled();
    });

    it('checks quota and records usage when a patch is produced', async () => {
      const { service, entitlements, cvAssistant } = build();
      const r = await service.assistantRewrite('u1', 'cv1', rewriteDto);
      expect(entitlements.assertCanUse).toHaveBeenCalledTimes(1);
      expect(cvAssistant.rewrite).toHaveBeenCalledTimes(1);
      expect(r.ok).toBe(true);
      expect(entitlements.recordUsage).toHaveBeenCalledTimes(1);
    });

    it('does NOT record usage on a re-ask (no patch delivered)', async () => {
      const { service, entitlements } = build({
        rewriteResult: { ok: false, reason: 'NEEDS_DETAIL', message: 'more please' },
      });
      const r = await service.assistantRewrite('u1', 'cv1', rewriteDto);
      expect(r.ok).toBe(false);
      expect(entitlements.assertCanUse).toHaveBeenCalledTimes(1);
      expect(entitlements.recordUsage).not.toHaveBeenCalled();
    });

    it('does NOT gate quota on a re-ask (bare answer) — free even for an out-of-quota user', async () => {
      const { service, entitlements } = build({
        rewriteResult: { ok: false, reason: 'NEEDS_DETAIL', message: 'which tech?' },
      });
      const bareDto: AssistantRewriteRequestDto = {
        before: 'Worked on it.',
        answers: [{ gap: 'tech', option_id: 'backend' }], // no detail → re-ask, no LLM
        target: 'projects[0].bullets[0]',
        locale: 'en',
      };
      const r = await service.assistantRewrite('u1', 'cv1', bareDto);
      expect(r.ok).toBe(false);
      expect(entitlements.assertCanUse).not.toHaveBeenCalled();
      expect(entitlements.recordUsage).not.toHaveBeenCalled();
    });
  });

  describe('assistantSkillsNudge', () => {
    it('rejects a CV the user does not own', async () => {
      const { service } = build({ owned: false });
      await expect(service.assistantSkillsNudge('u1', 'cvX', 'en')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('returns deterministic nudges for a thin skills section, without touching quota', async () => {
      const { service, entitlements } = build({
        skills: { technical: ['React'], tools: [], languages: [] },
      });
      const nudges = await service.assistantSkillsNudge('u1', 'cv1', 'en');
      expect(nudges.map((n) => n.code)).toEqual(['too_few_technical', 'no_tools', 'no_languages']);
      expect(entitlements.assertCanUse).not.toHaveBeenCalled();
    });

    it('returns no nudges for a complete skills section', async () => {
      const { service } = build({
        skills: {
          technical: ['React', 'Node.js', 'SQL', 'Docker'],
          tools: ['Git'],
          languages: ['English'],
        },
      });
      expect(await service.assistantSkillsNudge('u1', 'cv1', 'en')).toEqual([]);
    });
  });
});
