import { ConflictException, BadRequestException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { LearningRoadmapEntity } from '../../../src/database/entities/learning-roadmap.entity';
import { CvEntity } from '../../../src/database/entities/cv.entity';
import { LearningRoadmapDraftService } from '../../../src/platform/learning/roadmap-draft.service';

type RoadmapRepo = Pick<
  Repository<LearningRoadmapEntity>,
  'create' | 'save' | 'findOne' | 'update' | 'find'
> & {
  create: jest.Mock;
  save: jest.Mock;
  findOne: jest.Mock;
  update: jest.Mock;
  find: jest.Mock;
};

function roadmapRepo(): RoadmapRepo {
  return {
    create: jest.fn((value) => value),
    save: jest.fn((value) =>
      Promise.resolve({
        id: 'roadmap-1',
        revision: 0,
        status: 'DRAFT',
        createdAt: new Date('2026-07-21T00:00:00.000Z'),
        updatedAt: new Date('2026-07-21T00:00:00.000Z'),
        ...value,
      }),
    ),
    findOne: jest.fn(),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    find: jest.fn(),
  } as RoadmapRepo;
}

function serviceSetup() {
  const roadmaps = roadmapRepo();
  const cvs = {
    findOne: jest.fn().mockResolvedValue({
      id: 'cv-1',
      userId: 'user-1',
      parsedJson: {
        skills: { technical: ['React'], soft: [], languages: [], tools: [] },
      },
    }),
  };
  const skillNormalizer = {
    normalizeMany: jest.fn().mockReturnValue([
      {
        canonical_name: 'react',
        display_name: 'React',
        confidence: 1,
        matched_via: 'exact',
      },
    ]),
  };
  const cvMatches = {
    getGapReport: jest.fn().mockResolvedValue({
      target_role: 'frontend_developer',
      gap_items: [
        {
          canonical_name: 'react',
          display_name: 'React',
          type: 'hard_skill',
          importance: 'REQUIRED',
          severity: 0.9,
          fixability: 'learn',
          recommended_next_action: 'Build a React project.',
        },
        {
          canonical_name: 'cv_wording',
          display_name: 'CV wording',
          type: 'other',
          importance: 'PREFERRED',
          severity: 0.5,
          fixability: 'rewrite',
          recommended_next_action: 'Rewrite CV bullets.',
        },
      ],
    }),
  };
  const roleRubrics = {
    getRubric: jest.fn((role: string) =>
      role === 'frontend_developer'
        ? {
            role_code: role,
            display_name_en: 'Frontend Developer',
            skills: [
              {
                skill_canonical_name: 'react',
                required_level: 3,
                importance: 'REQUIRED',
                weight: 0.6,
              },
              {
                skill_canonical_name: 'typescript',
                required_level: 2,
                importance: 'PREFERRED',
                weight: 0.4,
              },
            ],
          }
        : null,
    ),
  };
  const service = new LearningRoadmapDraftService(
    roadmaps as unknown as Repository<LearningRoadmapEntity>,
    cvs as unknown as Repository<CvEntity>,
    cvMatches as never,
    roleRubrics as never,
    skillNormalizer as never,
  );
  return { service, roadmaps, cvs, cvMatches, roleRubrics, skillNormalizer };
}

describe('LearningRoadmapDraftService', () => {
  it('creates a JD draft with server-derived learning candidates', async () => {
    const { service, roadmaps, cvMatches } = serviceSetup();

    const result = await service.createDraft('user-1', {
      intent: 'JD_APPLICATION',
      cv_match_id: 'match-1',
      language_pref: 'vi',
    });

    expect(cvMatches.getGapReport).toHaveBeenCalledWith('user-1', 'match-1', 'vi');
    expect(roadmaps.create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        intent: 'JD_APPLICATION',
        cvMatchId: 'match-1',
        targetRole: null,
        status: 'DRAFT',
        draftConfig: expect.objectContaining({
          language_pref: 'vi',
          source_target_role: 'frontend_developer',
          candidate_skills: [
            expect.objectContaining({
              skill_canonical: 'react',
              system_priority: 0.9,
            }),
          ],
        }),
      }),
    );
    expect(result.id).toBe('roadmap-1');
    expect(result.candidate_skills.map((item) => item.skill_canonical)).toEqual(['react']);
  });

  it('attaches curated prerequisites when both skills are learning candidates', async () => {
    const { service, cvMatches } = serviceSetup();
    cvMatches.getGapReport.mockResolvedValue({
      target_role: 'frontend_developer',
      gap_items: [
        {
          canonical_name: 'react',
          display_name: 'React',
          type: 'hard_skill',
          importance: 'REQUIRED',
          severity: 0.9,
          fixability: 'learn',
          recommended_next_action: 'Learn React.',
        },
        {
          canonical_name: 'javascript',
          display_name: 'JavaScript',
          type: 'hard_skill',
          importance: 'REQUIRED',
          severity: 0.8,
          fixability: 'learn',
          recommended_next_action: 'Learn JavaScript.',
        },
      ],
    });

    const result = await service.createDraft('user-1', {
      intent: 'JD_APPLICATION',
      cv_match_id: 'match-1',
    });

    expect(
      result.candidate_skills.find((item) => item.skill_canonical === 'react')?.prerequisites,
    ).toContain('javascript');
  });

  it('requires exactly the context belonging to the selected intent', async () => {
    const { service } = serviceSetup();

    await expect(
      service.createDraft('user-1', {
        intent: 'JD_APPLICATION',
        target_role: 'frontend_developer',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    await expect(
      service.createDraft('user-1', {
        intent: 'CAREER_ROLE',
        cv_match_id: 'match-1',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('derives career gaps from the selected owned CV instead of assigning every role skill', async () => {
    const { service, cvs } = serviceSetup();

    const result = await service.createDraft('user-1', {
      intent: 'CAREER_ROLE',
      target_role: 'frontend_developer',
      target_level: 'fresher',
      cv_id: 'cv-1',
    });

    expect(cvs.findOne).toHaveBeenCalledWith({ where: { id: 'cv-1', userId: 'user-1' } });
    expect(result.candidate_skills.map((item) => item.skill_canonical)).toEqual(['typescript']);
  });

  it('rejects career roles that have no curated rubric', async () => {
    const { service } = serviceSetup();

    await expect(
      service.createDraft('user-1', {
        intent: 'CAREER_ROLE',
        target_role: 'unknown_role',
        target_level: 'fresher',
        cv_id: 'cv-1',
      }),
    ).rejects.toThrow("Career role 'unknown_role' is not supported.");
  });

  it('updates a draft only when expected_revision matches', async () => {
    const { service, roadmaps } = serviceSetup();
    roadmaps.findOne.mockResolvedValue({
      id: 'roadmap-1',
      userId: 'user-1',
      status: 'DRAFT',
      revision: 2,
      draftConfig: { language_pref: 'vi', candidate_skills: [] },
    });
    roadmaps.update.mockResolvedValue({ affected: 0 });

    await expect(
      service.updateDraft('user-1', 'roadmap-1', {
        expected_revision: 2,
        deadline: '2026-09-01',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('lists only roadmaps owned by the current user', async () => {
    const { service, roadmaps } = serviceSetup();
    roadmaps.find.mockResolvedValue([
      {
        id: 'roadmap-1',
        userId: 'user-1',
        intent: 'CAREER_ROLE',
        status: 'DRAFT',
        revision: 0,
        cvMatchId: null,
        targetRole: 'frontend_developer',
        targetLevel: 'fresher',
        draftConfig: {
          language_pref: 'both',
          candidate_skills: [],
        },
      },
    ]);

    const result = await service.list('user-1');

    expect(roadmaps.find).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      order: { updatedAt: 'DESC' },
    });
    expect(result.map((item) => item.id)).toEqual(['roadmap-1']);
  });
});
