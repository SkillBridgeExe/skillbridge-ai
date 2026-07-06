import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { MentorAvailabilityTemplateEntity } from '../../database/entities/mentor-availability-template.entity';
import { MentorAvailabilitySlotEntity } from '../../database/entities/mentor-availability-slot.entity';
import { MentorProfileEntity } from '../../database/entities/mentor-profile.entity';
import { MentorAvailabilityService } from './mentor-availability.service';

type RepoMock<T extends object> = Pick<
  Repository<T>,
  'create' | 'delete' | 'exist' | 'find' | 'findOne' | 'save'
> & {
  create: jest.Mock;
  delete: jest.Mock;
  exist: jest.Mock;
  find: jest.Mock;
  findOne: jest.Mock;
  save: jest.Mock;
};

function repo<T extends object>(): RepoMock<T> {
  return {
    create: jest.fn((input) => input),
    delete: jest.fn(),
    exist: jest.fn().mockResolvedValue(false),
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn(),
    save: jest.fn(async (input) => ({ id: 'slot-1', ...input })),
  } as unknown as RepoMock<T>;
}

const profile = {
  id: 'profile-1',
  userId: 'mentor-1',
  slug: 'mentor-one',
  status: 'APPROVED',
  isAcceptingBookings: true,
  sessionDurationMinutes: 60,
} as MentorProfileEntity;

describe('MentorAvailabilityService', () => {
  function setup(now = new Date('2026-06-21T00:00:00.000Z')) {
    const profiles = repo<MentorProfileEntity>();
    const slots = repo<MentorAvailabilitySlotEntity>();
    const templates = repo<MentorAvailabilityTemplateEntity>();
    const service = new MentorAvailabilityService(
      profiles as unknown as Repository<MentorProfileEntity>,
      slots as unknown as Repository<MentorAvailabilitySlotEntity>,
      templates as unknown as Repository<MentorAvailabilityTemplateEntity>,
      () => now,
    );
    return { service, profiles, slots, templates };
  }

  it('creates a future slot for an approved accepting mentor', async () => {
    const { service, profiles, slots } = setup();
    profiles.findOne.mockResolvedValue(profile);

    const result = await service.createSlot('mentor-1', {
      startsAt: '2026-06-22T01:00:00.000Z',
      endsAt: '2026-06-22T02:00:00.000Z',
    });

    expect(slots.save).toHaveBeenCalledWith(
      expect.objectContaining({ mentorProfileId: 'profile-1', status: 'OPEN' }),
    );
    expect(result).toEqual(
      expect.objectContaining({ id: 'slot-1', startsAt: '2026-06-22T01:00:00.000Z' }),
    );
  });

  it('rejects slot creation for a mentor who is not approved and accepting bookings', async () => {
    const { service, profiles } = setup();
    profiles.findOne.mockResolvedValue({ ...profile, status: 'PENDING_REVIEW' });

    await expect(
      service.createSlot('mentor-1', {
        startsAt: '2026-06-22T01:00:00.000Z',
        endsAt: '2026-06-22T02:00:00.000Z',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('requires a slot to start at least 24 hours ahead and match the session duration', async () => {
    const { service, profiles } = setup();
    profiles.findOne.mockResolvedValue(profile);

    await expect(
      service.createSlot('mentor-1', {
        startsAt: '2026-06-21T23:00:00.000Z',
        endsAt: '2026-06-22T00:00:00.000Z',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    await expect(
      service.createSlot('mentor-1', {
        startsAt: '2026-06-22T01:00:00.000Z',
        endsAt: '2026-06-22T01:30:00.000Z',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects overlapping mentor slots', async () => {
    const { service, profiles, slots } = setup();
    profiles.findOne.mockResolvedValue(profile);
    slots.exist.mockResolvedValue(true);

    await expect(
      service.createSlot('mentor-1', {
        startsAt: '2026-06-22T01:00:00.000Z',
        endsAt: '2026-06-22T02:00:00.000Z',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('lists only public open slots in the requested range', async () => {
    const { service, profiles, slots } = setup();
    profiles.findOne.mockResolvedValue(profile);
    slots.find.mockResolvedValue([
      {
        id: 'slot-1',
        mentorProfileId: profile.id,
        status: 'OPEN',
        startsAt: new Date('2026-06-22T01:00:00.000Z'),
        endsAt: new Date('2026-06-22T02:00:00.000Z'),
        holdExpiresAt: null,
        heldByBookingId: null,
        createdAt: new Date('2026-06-20T00:00:00.000Z'),
        updatedAt: null,
      },
    ]);

    const result = await service.listPublicSlots(
      'mentor-one',
      '2026-06-22T00:00:00.000Z',
      '2026-06-23T00:00:00.000Z',
    );

    expect(slots.find).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: 'OPEN' }) }),
    );
    expect(result).toEqual([
      expect.objectContaining({ id: 'slot-1', startsAt: '2026-06-22T01:00:00.000Z' }),
    ]);
  });

  it('rejects availability ranges longer than 60 days', async () => {
    const { service, profiles } = setup();
    profiles.findOne.mockResolvedValue(profile);

    await expect(
      service.listPublicSlots('mentor-one', '2026-06-01T00:00:00.000Z', '2026-08-01T00:00:00.001Z'),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        errorCode: 'VALIDATION_ERROR',
        message: 'Mentor slot range cannot exceed 60 days',
      }),
    });
  });

  it('rejects invalid availability dates before querying slots', async () => {
    const { service, profiles, slots } = setup();
    profiles.findOne.mockResolvedValue(profile);

    await expect(
      service.listPublicSlots('mentor-one', 'invalid', '2026-06-10T00:00:00.000Z'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(slots.find).not.toHaveBeenCalled();
  });

  it('deletes only an owned open slot', async () => {
    const { service, profiles, slots } = setup();
    profiles.findOne.mockResolvedValue(profile);
    slots.findOne.mockResolvedValue({
      id: 'slot-1',
      mentorProfileId: 'another-profile',
      status: 'OPEN',
    });

    await expect(service.deleteSlot('mentor-1', 'slot-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(slots.delete).not.toHaveBeenCalled();
  });

  it('saves a weekly template and generates open slots for the next 60 days', async () => {
    const { service, profiles, slots, templates } = setup(new Date('2026-06-21T00:00:00.000Z'));
    profiles.findOne.mockResolvedValue(profile);
    templates.save.mockImplementation(async (input) => ({
      id: `template-${input.dayOfWeek}-${input.startMinute}`,
      ...input,
      createdAt: new Date('2026-06-21T00:00:00.000Z'),
      updatedAt: null,
    }));
    templates.find.mockResolvedValue([]);
    slots.find.mockResolvedValue([]);
    slots.exist.mockResolvedValue(false);
    slots.save.mockImplementation(async (input) => ({
      id: `slot-${input.startsAt.toISOString()}`,
      ...input,
    }));

    const result = await service.saveWeeklyTemplate('mentor-1', {
      timezone: 'Asia/Ho_Chi_Minh',
      bufferMinutes: 15,
      windows: [{ dayOfWeek: 1, startMinute: 9 * 60, endMinute: 12 * 60 }],
    });

    expect(templates.save).toHaveBeenCalledWith(
      expect.objectContaining({
        mentorProfileId: 'profile-1',
        dayOfWeek: 1,
        startMinute: 540,
        endMinute: 720,
        bufferMinutes: 15,
        timezone: 'Asia/Ho_Chi_Minh',
        isActive: true,
      }),
    );
    expect(slots.save).toHaveBeenCalledWith(
      expect.objectContaining({
        mentorProfileId: 'profile-1',
        availabilityTemplateId: 'template-1-540',
        source: 'TEMPLATE',
        status: 'OPEN',
        startsAt: new Date('2026-06-22T02:00:00.000Z'),
        endsAt: new Date('2026-06-22T03:00:00.000Z'),
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        timezone: 'Asia/Ho_Chi_Minh',
        bufferMinutes: 15,
        windows: [expect.objectContaining({ dayOfWeek: 1, startMinute: 540, endMinute: 720 })],
      }),
    );
  });

  it('rejects overlapping weekly windows and windows shorter than one session', async () => {
    const { service, profiles } = setup();
    profiles.findOne.mockResolvedValue(profile);

    await expect(
      service.saveWeeklyTemplate('mentor-1', {
        timezone: 'Asia/Ho_Chi_Minh',
        bufferMinutes: 0,
        windows: [
          { dayOfWeek: 2, startMinute: 540, endMinute: 660 },
          { dayOfWeek: 2, startMinute: 600, endMinute: 720 },
        ],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    await expect(
      service.saveWeeklyTemplate('mentor-1', {
        timezone: 'Asia/Ho_Chi_Minh',
        bufferMinutes: 0,
        windows: [{ dayOfWeek: 3, startMinute: 540, endMinute: 570 }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('does not regenerate duplicate template slots and preserves manual slots', async () => {
    const { service, profiles, slots, templates } = setup(new Date('2026-06-21T00:00:00.000Z'));
    profiles.findOne.mockResolvedValue(profile);
    templates.find.mockResolvedValue([
      template({ id: 'template-old', dayOfWeek: 1, startMinute: 540, endMinute: 720 }),
    ]);
    templates.save.mockResolvedValue(
      template({ id: 'template-1', dayOfWeek: 1, startMinute: 540, endMinute: 720 }),
    );
    slots.find.mockResolvedValue([
      slot({
        id: 'manual-slot',
        source: 'MANUAL',
        status: 'OPEN',
        startsAt: new Date('2026-06-22T02:00:00.000Z'),
        endsAt: new Date('2026-06-22T03:00:00.000Z'),
      }),
      slot({
        id: 'generated-block',
        source: 'TEMPLATE',
        availabilityTemplateId: 'template-old',
        status: 'BLOCKED',
        startsAt: new Date('2026-06-22T03:15:00.000Z'),
        endsAt: new Date('2026-06-22T04:15:00.000Z'),
      }),
    ]);
    slots.exist.mockResolvedValue(false);

    await service.saveWeeklyTemplate('mentor-1', {
      timezone: 'Asia/Ho_Chi_Minh',
      bufferMinutes: 15,
      windows: [{ dayOfWeek: 1, startMinute: 540, endMinute: 720 }],
    });

    expect(slots.delete).toHaveBeenCalledWith(
      expect.objectContaining({
        mentorProfileId: 'profile-1',
        source: 'TEMPLATE',
        status: 'OPEN',
      }),
    );
    expect(slots.delete).not.toHaveBeenCalledWith(expect.objectContaining({ source: 'MANUAL' }));
    expect(slots.save).not.toHaveBeenCalledWith(
      expect.objectContaining({ startsAt: new Date('2026-06-22T02:00:00.000Z') }),
    );
    expect(slots.save).not.toHaveBeenCalledWith(
      expect.objectContaining({ startsAt: new Date('2026-06-22T03:15:00.000Z') }),
    );
  });

  it('blocks and restores generated open slots without allowing manual slot unblock', async () => {
    const { service, profiles, slots } = setup();
    profiles.findOne.mockResolvedValue(profile);
    slots.findOne
      .mockResolvedValueOnce(slot({ id: 'generated-slot', source: 'TEMPLATE', status: 'OPEN' }))
      .mockResolvedValueOnce(slot({ id: 'blocked-slot', source: 'TEMPLATE', status: 'BLOCKED' }))
      .mockResolvedValueOnce(slot({ id: 'manual-slot', source: 'MANUAL', status: 'OPEN' }));
    slots.exist.mockResolvedValue(false);

    await expect(service.blockGeneratedSlot('mentor-1', 'generated-slot')).resolves.toEqual(
      expect.objectContaining({ id: 'generated-slot', status: 'BLOCKED', source: 'TEMPLATE' }),
    );
    await expect(service.unblockGeneratedSlot('mentor-1', 'blocked-slot')).resolves.toEqual(
      expect.objectContaining({ id: 'blocked-slot', status: 'OPEN', source: 'TEMPLATE' }),
    );
    await expect(service.blockGeneratedSlot('mentor-1', 'manual-slot')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

function template(
  overrides: Partial<MentorAvailabilityTemplateEntity>,
): MentorAvailabilityTemplateEntity {
  return {
    id: 'template-1',
    mentorProfileId: 'profile-1',
    dayOfWeek: 1,
    startMinute: 540,
    endMinute: 720,
    bufferMinutes: 0,
    timezone: 'Asia/Ho_Chi_Minh',
    isActive: true,
    createdAt: new Date('2026-06-20T00:00:00.000Z'),
    updatedAt: null,
    ...overrides,
  } as MentorAvailabilityTemplateEntity;
}

function slot(overrides: Partial<MentorAvailabilitySlotEntity>): MentorAvailabilitySlotEntity {
  return {
    id: 'slot-1',
    mentorProfileId: 'profile-1',
    startsAt: new Date('2026-06-22T02:00:00.000Z'),
    endsAt: new Date('2026-06-22T03:00:00.000Z'),
    status: 'OPEN',
    source: 'MANUAL',
    availabilityTemplateId: null,
    heldByBookingId: null,
    holdExpiresAt: null,
    createdAt: new Date('2026-06-20T00:00:00.000Z'),
    updatedAt: null,
    ...overrides,
  } as MentorAvailabilitySlotEntity;
}
