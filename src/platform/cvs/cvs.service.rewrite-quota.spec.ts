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
