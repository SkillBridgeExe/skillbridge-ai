import { NotFoundException } from '@nestjs/common';
import {
  buildJdMarketPosition,
  IMPLIED_CAP,
} from '../../../src/modules/jobs/trends/jd-market-position';
import { JdMarketPositionService } from '../../../src/modules/jobs/trends/jd-market-position.service';
import {
  SkillDemandRow,
  SkillTrendsResponse,
} from '../../../src/modules/jobs/trends/skill-demand.service';
import {
  MatchedSkill,
  MissingSkill,
  PartialSkill,
  BonusSkill,
} from '../../../src/modules/cv-jd-match/skill-diff.service';
import { CvJdMatchParsedResponse } from '../../../src/modules/cv-jd-match/dto/cv-jd-match-response.dto';

const matched = (c: string): MatchedSkill => ({
  skill_id: c,
  canonical_name: c,
  display_name: c.toUpperCase(),
  cv_level: 3,
  required_level: 3,
  importance: 'REQUIRED',
  weight: 0.2,
  skill_type: 'hard',
});
const partial = (c: string): PartialSkill => ({ ...matched(c), cv_level: 2, gap_levels: 1 });
const missingS = (c: string): MissingSkill => ({
  skill_id: c,
  canonical_name: c,
  display_name: c.toUpperCase(),
  required_level: 3,
  importance: 'REQUIRED',
  weight: 0.2,
  skill_type: 'hard',
  gap_levels: 3,
});
const row = (c: string, pct: number): SkillDemandRow => ({
  canonical_name: c,
  display_name: c.toUpperCase(),
  posting_count: Math.round(pct * 8),
  pct_of_postings: pct,
  salary_p50_vnd: null,
  trend_delta: 1,
});
const trendsOf = (skills: SkillDemandRow[]): SkillTrendsResponse => ({
  role_code: 'frontend_developer',
  period: '2026-06-10',
  total_active_jobs: 800,
  skills,
});
const baseMatch = (over: Partial<CvJdMatchParsedResponse>): CvJdMatchParsedResponse =>
  ({
    overall_score: 50,
    match_ratio: 50,
    required_coverage: 0.5,
    matched_skills: [],
    partial_skills: [],
    missing_skills: [],
    bonus_skills: [] as BonusSkill[],
    unnormalized_cv_skills: [],
    unnormalized_jd_requirements: [],
    scoring_breakdown: {
      total_requirements: 0,
      matched_count: 0,
      partial_count: 0,
      missing_count: 0,
      weight_sum: 0,
      achieved_weight: 0,
      required_total: 0,
      required_met: 0,
      raw_weighted_score: 0,
      cap_applied: false,
    },
    source_of_requirements: 'jd_extraction',
    target_role: 'frontend_developer',
    ...over,
  }) as CvJdMatchParsedResponse;

describe('buildJdMarketPosition (pure)', () => {
  it('buckets by the real thresholds: <10 niche · 10–39.99 common · >=40 standard', () => {
    const m = baseMatch({
      matched_skills: [matched('kafka'), matched('react'), matched('git'), matched('vue')],
    });
    const trends = trendsOf([
      row('kafka', 9.99),
      row('react', 40),
      row('git', 10),
      row('vue', 39.99),
    ]);
    const { jd_skills } = buildJdMarketPosition(m, trends, 'vi');
    const by = (c: string) => jd_skills.find((s) => s.skill_canonical === c)!;
    expect(by('kafka').position).toBe('niche');
    expect(by('react').position).toBe('standard');
    expect(by('git').position).toBe('common');
    expect(by('vue').position).toBe('common'); // 39.99 stays below the standard bar
    expect(by('kafka').why).toContain('9.99'); // real number surfaces
  });

  it('a JD skill absent from the snapshot → pct 0, niche, pool-honest copy', () => {
    const m = baseMatch({ missing_skills: [missingS('cobol')] });
    const { jd_skills } = buildJdMarketPosition(m, trendsOf([]), 'vi');
    expect(jd_skills[0]).toMatchObject({
      skill_canonical: 'cobol',
      pct_of_postings: 0,
      posting_count: 0,
      position: 'niche',
    });
    expect(jd_skills[0].why).toContain('pool');
  });

  it('implied: >=40% market skills the JD never names, capped, covered from matched∪partial∪bonus', () => {
    const bonus: BonusSkill = {
      canonical_name: 'docker',
      display_name: 'DOCKER',
      cv_level: 3,
    };
    const m = baseMatch({ matched_skills: [matched('react')], bonus_skills: [bonus] });
    const trends = trendsOf([
      row('react', 80), // in JD → NOT implied
      row('docker', 61), // implied + covered (bonus)
      row('typescript', 55), // implied, not covered
      row('html', 50),
      row('css', 49),
      row('git', 45),
      row('sql', 41), // → cap kicks in
      row('jquery', 12), // < 40 → not implied
    ]);
    const { implied } = buildJdMarketPosition(m, trends, 'vi');
    expect(implied.length).toBe(IMPLIED_CAP);
    expect(implied.map((i) => i.skill_canonical)).not.toContain('react');
    expect(implied.map((i) => i.skill_canonical)).not.toContain('jquery');
    expect(implied[0].skill_canonical).toBe('docker'); // pct desc
    expect(implied[0].covered).toBe(true);
    expect(implied[0].why).toContain('tự tin');
    const ts = implied.find((i) => i.skill_canonical === 'typescript')!;
    expect(ts.covered).toBe(false);
    expect(ts.why).toContain('chuẩn bị');
  });

  it('sorts jd_skills niche-first and dedups requirement canonicals', () => {
    const m = baseMatch({
      matched_skills: [matched('react')],
      partial_skills: [partial('react')], // duplicate canonical — must appear once
      missing_skills: [missingS('kafka')],
    });
    const trends = trendsOf([row('react', 80), row('kafka', 3)]);
    const { jd_skills } = buildJdMarketPosition(m, trends, 'vi');
    expect(jd_skills.map((s) => s.skill_canonical)).toEqual(['kafka', 'react']); // niche first
  });

  it('en lang produces English copy', () => {
    const m = baseMatch({ matched_skills: [matched('react')] });
    const { jd_skills } = buildJdMarketPosition(m, trendsOf([row('react', 80)]), 'en');
    expect(jd_skills[0].why).toMatch(/market/i);
  });
});

describe('JdMarketPositionService (never-throw degrade)', () => {
  const mkSvc = (getTrends: jest.Mock) => new JdMarketPositionService({ getTrends } as never);

  it('target_role null → available:false NO_ROLE, trends never queried', async () => {
    const getTrends = jest.fn();
    const res = await mkSvc(getTrends).build({ match: baseMatch({ target_role: null }) });
    expect(res).toEqual({ available: false, reason: 'NO_ROLE' });
    expect(getTrends).not.toHaveBeenCalled();
  });

  it('NO_SNAPSHOT from SkillDemandService → available:false NO_SNAPSHOT', async () => {
    const getTrends = jest
      .fn()
      .mockRejectedValue(new NotFoundException({ code: 'NO_SNAPSHOT', message: 'no snapshot' }));
    const res = await mkSvc(getTrends).build({ match: baseMatch({}) });
    expect(res).toEqual({ available: false, reason: 'NO_SNAPSHOT' });
  });

  it('happy path → available:true with period/total and computed blocks', async () => {
    const getTrends = jest.fn().mockResolvedValue(trendsOf([row('react', 80)]));
    const res = await mkSvc(getTrends).build({
      match: baseMatch({ matched_skills: [matched('react')] }),
    });
    expect(res.available).toBe(true);
    if (res.available) {
      expect(res.role_code).toBe('frontend_developer');
      expect(res.total_active_jobs).toBe(800);
      expect(res.jd_skills[0].position).toBe('standard');
    }
    expect(getTrends).toHaveBeenCalledWith('frontend_developer', 200);
  });
});
