import { RoleInferenceService } from './role-inference.service';
import { RoleRubricService } from '../../common/services/role-rubric.service';
import { SkillTaxonomyService } from '../../common/services/skill-taxonomy.service';

function buildService(): RoleInferenceService {
  const taxonomy = new SkillTaxonomyService();
  // SkillTaxonomyService loads data/skills-pilot.json in onModuleInit.
  (taxonomy as unknown as { onModuleInit: () => void }).onModuleInit();
  const rubric = new RoleRubricService();
  // RoleRubricService also loads its data (data/role-rubrics-pilot.json) in onModuleInit.
  (rubric as unknown as { onModuleInit: () => void }).onModuleInit();
  return new RoleInferenceService(rubric, taxonomy);
}

describe('RoleInferenceService', () => {
  it('infers business_analyst from a BA story and resolves the display name', async () => {
    const svc = buildService();
    await (svc as unknown as { onModuleInit: () => Promise<void> }).onModuleInit();
    const story =
      'Mình làm phân tích nghiệp vụ: thu thập và phân tích yêu cầu, viết tài liệu BRD và user stories, mô hình hóa quy trình bằng BPMN.';
    const r = svc.inferFromStory(story, 'vi');
    expect(r.role_code).toBe('business_analyst');
    expect(r.display_name).toBe('Chuyên viên Phân tích Nghiệp vụ');
    expect(r.needs_user_input).toBe(false);
    expect(r.reason).toBe('ok');
    expect(r.candidates[0].display_name).toBeTruthy();
  });

  it('returns en display names when language=en', () => {
    const svc = buildService();
    const story = 'Frontend developer: React, TypeScript, responsive design, CSS.';
    // sync use after onModuleInit caching happens lazily on first call too
    const r = svc.inferFromStory(story, 'en');
    expect(r.role_code).toBe('frontend_developer');
    expect(r.display_name).toBe('Frontend Developer');
  });

  it('abstains (needs_user_input, null role) on a too-weak story', () => {
    const svc = buildService();
    const r = svc.inferFromStory('Mình thích máy tính.', 'vi');
    expect(r.role_code).toBeNull();
    expect(r.display_name).toBeNull();
    expect(r.needs_user_input).toBe(true);
    expect(['too_weak', 'ambiguous', 'no_roles']).toContain(r.reason);
  });
});
