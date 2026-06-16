import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateMentorProfileDto } from './mentor-profile.dto';

describe('UpdateMentorProfileDto', () => {
  it('accepts the default 1:1 pricing shape used by mentor cards', async () => {
    const dto = plainToInstance(UpdateMentorProfileDto, {
      sessionPriceVnd: 380000,
      sessionDurationMinutes: 60,
      domainTags: ['Technology & Software'],
      skillIds: ['11111111-1111-4111-8111-111111111111'],
    });

    await expect(validate(dto)).resolves.toEqual([]);
  });

  it('rejects prices outside the mentor profile range', async () => {
    const dto = plainToInstance(UpdateMentorProfileDto, {
      sessionPriceVnd: 10000,
      sessionDurationMinutes: 60,
    });

    const errors = await validate(dto);

    expect(errors.map((error) => error.property)).toContain('sessionPriceVnd');
  });

  it('rejects unsupported mentor session durations', async () => {
    const dto = plainToInstance(UpdateMentorProfileDto, {
      sessionPriceVnd: 380000,
      sessionDurationMinutes: 75,
    });

    const errors = await validate(dto);

    expect(errors.map((error) => error.property)).toContain('sessionDurationMinutes');
  });
});
