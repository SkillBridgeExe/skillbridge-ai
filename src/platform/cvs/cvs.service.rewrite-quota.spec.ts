import { RewriteRequestDto } from '../../modules/cv-builder/dto/rewrite.dto';
import { CvsService } from './cvs.service';

/**
 * Focused check for the rewrite quota rule: a fallback response (original text returned, no LLM
 * value) must be FREE — the reserved charge is refunded — while a real suggestion keeps the charge
 * and an LLM failure refunds it. Guards the "charge only for delivered value" norm.
 */
describe('CvsService.rewriteBuilderText quota', () => {
  function setup(rewrite: jest.Mock) {
    const reservation = {
      eventId: 'evt-1',
      confirm: jest.fn().mockResolvedValue(undefined),
      refund: jest.fn().mockResolvedValue(undefined),
    };
    const entitlements = { reserveUsage: jest.fn().mockResolvedValue(reservation) };
    const cvs = { findOne: jest.fn().mockResolvedValue({ id: 'cv-1', userId: 'user-1' }) };
    const service = new CvsService(
      cvs as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      { rewrite } as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      entitlements as never,
      undefined as never,
    );
    return { service, reservation, entitlements };
  }

  const dto = { text: 'Did stuff on the team', mode: 'harvard' } as RewriteRequestDto;

  it('refunds the charge when the rewriter falls back to the original text', async () => {
    const rewrite = jest
      .fn()
      .mockResolvedValue({ suggestion: 'Did stuff on the team', fallback: true });
    const { service, reservation } = setup(rewrite);

    const response = await service.rewriteBuilderText('user-1', 'cv-1', dto);

    expect(response.fallback).toBe(true);
    expect(reservation.refund).toHaveBeenCalledTimes(1);
  });

  it('keeps the charge for a delivered suggestion', async () => {
    const rewrite = jest.fn().mockResolvedValue({ suggestion: 'Led a 3-person team' });
    const { service, reservation, entitlements } = setup(rewrite);

    await service.rewriteBuilderText('user-1', 'cv-1', dto);

    expect(entitlements.reserveUsage).toHaveBeenCalledTimes(1);
    expect(reservation.refund).not.toHaveBeenCalled();
  });

  it('refunds the charge when the rewriter throws', async () => {
    const rewrite = jest.fn().mockRejectedValue(new Error('llm down'));
    const { service, reservation } = setup(rewrite);

    await expect(service.rewriteBuilderText('user-1', 'cv-1', dto)).rejects.toThrow('llm down');
    expect(reservation.refund).toHaveBeenCalledTimes(1);
  });
});

/**
 * P3.1 — assistant rewrite (Turn-2) quota + intent passthrough at the platform seam.
 * Locks: a transform intent (improve/shorten/…) RUNS a rewrite (so it reserves quota) and the
 * intent actually reaches the engine; a free re-ask (no facts, no intent) reserves nothing;
 * any non-ok result refunds.
 */
describe('CvsService.assistantRewrite quota + intent passthrough', () => {
  function setup(rewrite: jest.Mock) {
    const reservation = {
      eventId: 'evt-1',
      confirm: jest.fn().mockResolvedValue(undefined),
      refund: jest.fn().mockResolvedValue(undefined),
    };
    const entitlements = { reserveUsage: jest.fn().mockResolvedValue(reservation) };
    const cvs = { findOne: jest.fn().mockResolvedValue({ id: 'cv-1', userId: 'user-1' }) };
    const args: unknown[] = new Array(21).fill(undefined);
    args[0] = cvs;
    args[15] = entitlements;
    args[20] = { rewrite };
    const service = new CvsService(...(args as ConstructorParameters<typeof CvsService>));
    return { service, reservation, entitlements, rewrite };
  }

  const okPatch = {
    ok: true,
    field_patch: { target: 'experience[0].description', before: 'a', after: 'b', why: 'w' },
  };

  it('reserves quota for a transform intent with empty answers and passes the intent through', async () => {
    const rewrite = jest.fn().mockResolvedValue(okPatch);
    const { service, reservation, entitlements } = setup(rewrite);

    const result = await service.assistantRewrite('user-1', 'cv-1', {
      before: 'Worked on the project.',
      answers: [],
      target: 'experience[0].description',
      kind: 'bullet',
      locale: 'en',
      intent: 'improve',
    } as never);

    expect(entitlements.reserveUsage).toHaveBeenCalledTimes(1);
    expect(rewrite).toHaveBeenCalledWith(
      expect.objectContaining({ intent: 'improve', answers: [] }),
      'user-1',
    );
    expect(result).toBe(okPatch);
    expect(reservation.refund).not.toHaveBeenCalled();
  });

  it('reserves NOTHING for a free re-ask (no facts, no intent)', async () => {
    const rewrite = jest
      .fn()
      .mockResolvedValue({ ok: false, reason: 'NEEDS_DETAIL', message: 'more please' });
    const { service, entitlements } = setup(rewrite);

    const result = await service.assistantRewrite('user-1', 'cv-1', {
      before: 'Worked on the project.',
      answers: [],
      target: 'experience[0].description',
      kind: 'bullet',
      locale: 'en',
    } as never);

    expect(entitlements.reserveUsage).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, reason: 'NEEDS_DETAIL' });
  });

  it('refunds when an intent rewrite still comes back non-ok (e.g. result gate)', async () => {
    const rewrite = jest
      .fn()
      .mockResolvedValue({ ok: false, reason: 'NEEDS_DETAIL', gap: 'result', message: 'm' });
    const { service, reservation } = setup(rewrite);

    await service.assistantRewrite('user-1', 'cv-1', {
      before: 'Worked on the project.',
      answers: [],
      target: 'experience[0].description',
      kind: 'bullet',
      locale: 'en',
      intent: 'add_evidence',
    } as never);

    expect(reservation.refund).toHaveBeenCalledTimes(1);
  });

  it('a user_clarify answer counts as facts → reserves, and keeps the charge on success', async () => {
    const rewrite = jest.fn().mockResolvedValue(okPatch);
    const { service, reservation, entitlements } = setup(rewrite);

    await service.assistantRewrite('user-1', 'cv-1', {
      before: 'Worked on the project.',
      answers: [{ gap: 'user_clarify', option_id: 'other', detail: 'cut latency 30%' }],
      target: 'experience[0].description',
      kind: 'bullet',
      locale: 'en',
    } as never);

    expect(entitlements.reserveUsage).toHaveBeenCalledTimes(1);
    expect(reservation.refund).not.toHaveBeenCalled();
  });

  it('refunds and rethrows when the engine throws', async () => {
    const rewrite = jest.fn().mockRejectedValue(new Error('llm down'));
    const { service, reservation } = setup(rewrite);

    await expect(
      service.assistantRewrite('user-1', 'cv-1', {
        before: 'Worked on the project.',
        answers: [],
        target: 'experience[0].description',
        kind: 'bullet',
        locale: 'en',
        intent: 'improve',
      } as never),
    ).rejects.toThrow('llm down');
    expect(reservation.refund).toHaveBeenCalledTimes(1);
  });
});
