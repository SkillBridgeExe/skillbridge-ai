import 'reflect-metadata';
import { validate } from 'class-validator';
import {
  LearningCadenceDraftDto,
  RescheduleLearningRoadmapDto,
} from '../../../src/platform/learning/dto/roadmap.dto';

describe('Learning roadmap DTO validation', () => {
  it('rejects cadence dates with a time component and unsupported IANA timezones', async () => {
    const dto = Object.assign(new LearningCadenceDraftDto(), {
      timezone: 'Invalid/Timezone',
      start_date: '2026-08-03T10:00:00.000Z',
      study_days_per_week: 3,
      session_minutes: 60,
    });

    const errors = await validate(dto);

    expect(errors.map((error) => error.property)).toEqual(
      expect.arrayContaining(['timezone', 'start_date']),
    );
  });

  it('requires a calendar-only start date when rescheduling', async () => {
    const dto = Object.assign(new RescheduleLearningRoadmapDto(), {
      expected_revision: 2,
      start_date: '2026-08-03T10:00:00.000Z',
      study_days_per_week: 3,
    });

    const errors = await validate(dto);

    expect(errors.map((error) => error.property)).toContain('start_date');
  });
});
