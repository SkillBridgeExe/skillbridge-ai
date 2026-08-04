import { DiagnosisController } from '../../../src/platform/cvs/diagnosis.controller';

describe('DiagnosisController', () => {
  it('always lists uploaded CVs for diagnosis history', async () => {
    const cvs = {
      list: jest.fn().mockResolvedValue({ items: [], total: 0, page: 2, limit: 5 }),
    };
    const controller = new DiagnosisController(cvs as never, {} as never);

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

  it('serves the diagnosis target-role registry from the curated rubrics', () => {
    const rubrics = {
      listRubrics: jest.fn().mockReturnValue([
        {
          role_code: 'frontend_developer',
          display_name_vi: 'Lập trình viên Frontend',
          display_name_en: 'Frontend Developer',
        },
        {
          role_code: 'security_engineer',
          display_name_vi: 'Kỹ sư An ninh mạng',
          display_name_en: 'Security Engineer',
        },
      ]),
    };
    const controller = new DiagnosisController({} as never, rubrics as never);

    expect(controller.roles()).toEqual([
      {
        code: 'frontend_developer',
        label_vi: 'Lập trình viên Frontend',
        label_en: 'Frontend Developer',
      },
      {
        code: 'security_engineer',
        label_vi: 'Kỹ sư An ninh mạng',
        label_en: 'Security Engineer',
      },
    ]);
  });
});
