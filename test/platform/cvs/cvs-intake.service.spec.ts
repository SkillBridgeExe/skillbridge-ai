import { NotFoundException } from '@nestjs/common';
import { CvsService } from '../../../src/platform/cvs/cvs.service';
import type { CvIntakeResult } from '../../../src/modules/cv-intake/cv-intake.service';
import type { ExtractRequestDto } from '../../../src/platform/cvs/dto/cv-assistant.dto';

function grounded(): CvIntakeResult {
  return {
    fields: {
      company: {
        value: 'SmartAI Solutions',
        found: true,
        confidence: 'high',
        source_span: 'ở SmartAI Solutions',
      },
      position: {
        value: 'AI Engineer',
        found: true,
        confidence: 'high',
        source_span: 'vị trí AI Engineer',
      },
      start: { value: '05/2023', found: true, confidence: 'high', source_span: '05/2023' },
      end: { value: 'present', found: false, confidence: 'low', source_span: '' },
      description: {
        value: ['Xây chatbot bằng GPT-4o.'],
        found: true,
        confidence: 'high',
        source_span: 'xây chatbot bằng GPT-4o',
      },
      achievements: { value: '', found: false, confidence: 'low', source_span: '' },
    },
    missing: ['end', 'achievements'],
    degraded: false,
  };
}

function degraded(): CvIntakeResult {
  return {
    fields: {
      company: { value: '', found: false, confidence: 'low', source_span: '' },
      position: { value: '', found: false, confidence: 'low', source_span: '' },
      start: { value: '', found: false, confidence: 'low', source_span: '' },
      end: { value: '', found: false, confidence: 'low', source_span: '' },
      description: { value: '', found: false, confidence: 'low', source_span: '' },
      achievements: { value: '', found: false, confidence: 'low', source_span: '' },
    },
    missing: ['company', 'position', 'start', 'end', 'description', 'achievements'],
    degraded: true,
  };
}

function build(opts: { owned?: boolean; result?: CvIntakeResult } = {}) {
  const cv = { id: 'cv1', userId: 'u1', cvKind: 'BUILT', parsedJson: null };
  const cvsRepo = { findOne: jest.fn().mockResolvedValue(opts.owned === false ? null : cv) };
  const entitlements = {
    assertCanUse: jest.fn().mockResolvedValue(undefined),
    recordUsage: jest.fn().mockResolvedValue(undefined),
  };
  const cvIntake = {
    extract: jest.fn().mockResolvedValue(opts.result ?? grounded()),
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
    any, // 14-15
    entitlements as never, // 16
    undefined, // 17 interviewPlan
    undefined, // 18 githubEvidence
    undefined, // 19 tailorVerifier
    undefined, // 20 cvAssistant
    cvIntake as never, // 21 cvIntake
  );
  return { service, cvsRepo, entitlements, cvIntake };
}

const extractDto: ExtractRequestDto = {
  section: 'experience',
  narrative:
    'Tôi làm ở SmartAI Solutions vị trí AI Engineer từ 05/2023 tới nay, xây chatbot bằng GPT-4o.',
  locale: 'vi',
  output_lang: 'vi',
};

describe('CvsService — assistantExtract (narrative intake)', () => {
  it('rejects a CV the user does not own (before any quota/LLM)', async () => {
    const { service, entitlements, cvIntake } = build({ owned: false });
    await expect(service.assistantExtract('u1', 'cvX', extractDto)).rejects.toThrow(
      NotFoundException,
    );
    expect(entitlements.assertCanUse).not.toHaveBeenCalled();
    expect(cvIntake.extract).not.toHaveBeenCalled();
  });

  it('checks quota and records usage when extraction is not degraded', async () => {
    const { service, entitlements, cvIntake } = build();
    const r = await service.assistantExtract('u1', 'cv1', extractDto);
    expect(entitlements.assertCanUse).toHaveBeenCalledTimes(1);
    expect(cvIntake.extract).toHaveBeenCalledTimes(1);
    expect(r.degraded).toBe(false);
    expect(r.fields.company.found).toBe(true);
    expect(entitlements.recordUsage).toHaveBeenCalledTimes(1);
  });

  it('does NOT record usage on a degraded extraction (no value delivered)', async () => {
    const { service, entitlements } = build({ result: degraded() });
    const r = await service.assistantExtract('u1', 'cv1', extractDto);
    expect(r.degraded).toBe(true);
    expect(entitlements.assertCanUse).toHaveBeenCalledTimes(1);
    expect(entitlements.recordUsage).not.toHaveBeenCalled();
  });
});
