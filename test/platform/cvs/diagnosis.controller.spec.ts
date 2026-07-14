import { DiagnosisController } from '../../../src/platform/cvs/diagnosis.controller';

describe('DiagnosisController', () => {
  it('always lists uploaded CVs for diagnosis history', async () => {
    const cvs = {
      list: jest.fn().mockResolvedValue({ items: [], total: 0, page: 2, limit: 5 }),
    };
    const controller = new DiagnosisController(cvs as never);

    await controller.history({ userId: 'u1' } as never, {
      page: 2,
      limit: 5,
      cvKind: 'BUILT',
    });

    expect(cvs.list).toHaveBeenCalledWith('u1', {
      page: 2,
      limit: 5,
      cvKind: 'UPLOADED',
    });
  });
});
