import { NotFoundException } from '@nestjs/common';
import { CvsService } from '../../../src/platform/cvs/cvs.service';
import * as companionModule from '../../../src/modules/cv-assistant/cv-assistant';
import type { CvAssistantRewriteResult } from '../../../src/modules/cv-assistant/cv-assistant.service';
import type { CvAssistantTurn } from '../../../src/modules/cv-assistant/cv-assistant';
import type {
  AssistantAnalyzeRequestDto,
  AssistantRewriteRequestDto,
  AssistantSmartQuestionsRequestDto,
} from '../../../src/platform/cvs/dto/cv-assistant.dto';

const EMPTY_TURN: CvAssistantTurn = {
  message: '',
  questions: [],
  requires_user_confirmation: false,
  field_patch: null,
};

function build(
  opts: {
    owned?: boolean;
    rewriteResult?: CvAssistantRewriteResult;
    skills?: Record<string, string[]>;
    targetRole?: string | null;
  } = {},
) {
  const cv = {
    id: 'cv1',
    userId: 'u1',
    cvKind: 'BUILT',
    parsedJson: opts.skills ? { skills: opts.skills } : null,
    targetRole: opts.targetRole ?? null,
  };
  const cvsRepo = { findOne: jest.fn().mockResolvedValue(opts.owned === false ? null : cv) };
  const reservation = {
    eventId: 'evt-1',
    confirm: jest.fn().mockResolvedValue(undefined),
    refund: jest.fn().mockResolvedValue(undefined),
  };
  const entitlements = {
    reserveUsage: jest.fn().mockResolvedValue(reservation),
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
  const generator = {
    generate: jest.fn().mockResolvedValue(EMPTY_TURN),
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
    undefined, // 21 cvIntake
    generator as never, // 22 questionGenerator
  );
  return { service, cvsRepo, entitlements, reservation, cvAssistant, generator };
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
      expect(entitlements.reserveUsage).not.toHaveBeenCalled();
    });

    it('assistantAnalyze threads the CV record target_role into the companion context', async () => {
      const { service } = build({ targetRole: 'backend_developer' });
      const spy = jest.spyOn(companionModule, 'cvBuilderAssistantTurn1');
      await service.assistantAnalyze('u1', 'cv1', analyzeDto);
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({ target_role: 'backend_developer' }),
      );
      spy.mockRestore();
    });
  });

  describe('assistantRewrite (Turn-2)', () => {
    it('rejects a CV the user does not own (before any quota/LLM)', async () => {
      const { service, entitlements } = build({ owned: false });
      await expect(service.assistantRewrite('u1', 'cvX', rewriteDto)).rejects.toThrow(
        NotFoundException,
      );
      expect(entitlements.reserveUsage).not.toHaveBeenCalled();
    });

    it('reserves quota and keeps the charge when a patch is produced', async () => {
      const { service, entitlements, reservation, cvAssistant } = build();
      const r = await service.assistantRewrite('u1', 'cv1', rewriteDto);
      expect(entitlements.reserveUsage).toHaveBeenCalledTimes(1);
      expect(cvAssistant.rewrite).toHaveBeenCalledTimes(1);
      expect(r.ok).toBe(true);
      expect(reservation.refund).not.toHaveBeenCalled();
    });

    it('refunds the charge on a re-ask (no patch delivered)', async () => {
      const { service, entitlements, reservation } = build({
        rewriteResult: { ok: false, reason: 'NEEDS_DETAIL', message: 'more please' },
      });
      const r = await service.assistantRewrite('u1', 'cv1', rewriteDto);
      expect(r.ok).toBe(false);
      expect(entitlements.reserveUsage).toHaveBeenCalledTimes(1);
      expect(reservation.refund).toHaveBeenCalledTimes(1);
    });

    it('passes tone through to the rewrite engine when the caller asks for a softer rewrite', async () => {
      const { service, cvAssistant } = build();
      const softerDto: AssistantRewriteRequestDto = { ...rewriteDto, tone: 'softer' };
      await service.assistantRewrite('u1', 'cv1', softerDto);
      expect(cvAssistant.rewrite).toHaveBeenCalledWith(
        expect.objectContaining({ tone: 'softer' }),
        'u1',
      );
    });

    it('does NOT gate quota on a re-ask (bare answer) — free even for an out-of-quota user', async () => {
      const { service, entitlements, reservation } = build({
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
      expect(entitlements.reserveUsage).not.toHaveBeenCalled();
      expect(reservation.refund).not.toHaveBeenCalled();
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
      expect(entitlements.reserveUsage).not.toHaveBeenCalled();
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

  describe('assistantSmartQuestions (Turn-1.5, LLM-backed, rate-limited at the controller)', () => {
    const smartDto: AssistantSmartQuestionsRequestDto = {
      current_value: 'làm web',
      section: 'projects',
      locale: 'vi',
    };

    it('rejects a CV the user does not own (before calling the generator)', async () => {
      const { service, generator } = build({ owned: false });
      await expect(service.assistantSmartQuestions('u1', 'cvX', smartDto)).rejects.toThrow(
        NotFoundException,
      );
      expect(generator.generate).not.toHaveBeenCalled();
    });

    it('checks ownership, reads role, delegates to the generator', async () => {
      const { service, generator } = build({ targetRole: 'frontend_developer' });
      generator.generate.mockResolvedValue({
        message: '',
        questions: [{ gap: 'tech', prompt: 'x', options: [], allows_free_text: true }],
        requires_user_confirmation: false,
        field_patch: null,
      });
      const out = await service.assistantSmartQuestions('u1', 'cv1', smartDto);
      expect(generator.generate).toHaveBeenCalledWith(
        expect.objectContaining({ target_role: 'frontend_developer', current_value: 'làm web' }),
        'u1',
      );
      expect(out.questions[0].gap).toBe('tech');
    });

    it('reads target_role from the owned CV record, ignoring any client-sent target_role', async () => {
      const { service, generator } = build({ targetRole: 'backend_developer' });
      await service.assistantSmartQuestions('u1', 'cv1', {
        ...smartDto,
        target_role: 'frontend_developer', // client-sent — must be ignored server-side
      });
      expect(generator.generate).toHaveBeenCalledWith(
        expect.objectContaining({ target_role: 'backend_developer' }),
        'u1',
      );
    });
  });
});
