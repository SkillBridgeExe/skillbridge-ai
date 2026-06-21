import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
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
    const service = new MentorAvailabilityService(
      profiles as unknown as Repository<MentorProfileEntity>,
      slots as unknown as Repository<MentorAvailabilitySlotEntity>,
      () => now,
    );
    return { service, profiles, slots };
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
});
