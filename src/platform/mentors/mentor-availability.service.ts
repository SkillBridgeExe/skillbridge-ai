import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, MoreThan, MoreThanOrEqual, Repository } from 'typeorm';
import { ERROR_CODES } from '../../common/constants/error-codes';
import { MentorAvailabilitySlotEntity } from '../../database/entities/mentor-availability-slot.entity';
import { MentorProfileEntity } from '../../database/entities/mentor-profile.entity';
import { CreateMentorSlotDto, MentorSlotDto } from './dto/mentor-availability.dto';

export const MENTOR_AVAILABILITY_CLOCK = Symbol('MENTOR_AVAILABILITY_CLOCK');
const MINIMUM_LEAD_TIME_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class MentorAvailabilityService {
  constructor(
    @InjectRepository(MentorProfileEntity)
    private readonly profiles: Repository<MentorProfileEntity>,
    @InjectRepository(MentorAvailabilitySlotEntity)
    private readonly slots: Repository<MentorAvailabilitySlotEntity>,
    @Optional()
    @Inject(MENTOR_AVAILABILITY_CLOCK)
    private readonly clock?: () => Date,
  ) {}

  async listPublicSlots(
    slug: string,
    fromInput: string,
    toInput: string,
  ): Promise<MentorSlotDto[]> {
    const profile = await this.profiles.findOne({
      where: { slug, status: 'APPROVED', isAcceptingBookings: true },
    });
    if (!profile) throw new NotFoundException('Mentor profile not found');
    const { from, to } = this.parseRange(fromInput, toInput);
    const slots = await this.slots.find({
      where: {
        mentorProfileId: profile.id,
        status: 'OPEN',
        startsAt: MoreThanOrEqual(from),
        endsAt: LessThan(to),
      },
      order: { startsAt: 'ASC' },
    });
    return slots.map((slot) => this.toDto(slot, false));
  }

  async listMySlots(userId: string, fromInput: string, toInput: string): Promise<MentorSlotDto[]> {
    const profile = await this.requireProfile(userId);
    const { from, to } = this.parseRange(fromInput, toInput);
    const slots = await this.slots.find({
      where: {
        mentorProfileId: profile.id,
        startsAt: MoreThanOrEqual(from),
        endsAt: LessThan(to),
      },
      order: { startsAt: 'ASC' },
    });
    return slots.map((slot) => this.toDto(slot, true));
  }

  async createSlot(userId: string, dto: CreateMentorSlotDto): Promise<MentorSlotDto> {
    const profile = await this.requireProfile(userId);
    if (profile.status !== 'APPROVED' || !profile.isAcceptingBookings) {
      throw new ForbiddenException({
        errorCode: ERROR_CODES.FORBIDDEN,
        message: 'Only approved mentors accepting bookings can create slots',
      });
    }

    const startsAt = new Date(dto.startsAt);
    const endsAt = new Date(dto.endsAt);
    if (startsAt.getTime() < this.now().getTime() + MINIMUM_LEAD_TIME_MS) {
      throw this.validationError('Mentor slots must start at least 24 hours from now');
    }
    const durationMinutes = (endsAt.getTime() - startsAt.getTime()) / 60000;
    if (durationMinutes !== profile.sessionDurationMinutes) {
      throw this.validationError('Slot duration must match the mentor session duration');
    }

    const overlaps = await this.slots.exist({
      where: {
        mentorProfileId: profile.id,
        startsAt: LessThan(endsAt),
        endsAt: MoreThan(startsAt),
      },
    });
    if (overlaps) throw this.validationError('Mentor slot overlaps an existing slot');

    const saved = await this.slots.save(
      this.slots.create({
        mentorProfileId: profile.id,
        startsAt,
        endsAt,
        status: 'OPEN',
        heldByBookingId: null,
        holdExpiresAt: null,
      }),
    );
    return this.toDto(saved, true);
  }

  async deleteSlot(userId: string, slotId: string): Promise<{ deleted: true }> {
    const profile = await this.requireProfile(userId);
    const slot = await this.slots.findOne({ where: { id: slotId } });
    if (!slot || slot.mentorProfileId !== profile.id) {
      throw new NotFoundException('Mentor slot not found');
    }
    if (slot.status !== 'OPEN' || slot.startsAt.getTime() <= this.now().getTime()) {
      throw this.validationError('Only future open slots can be deleted');
    }
    await this.slots.delete({ id: slot.id });
    return { deleted: true };
  }

  private async requireProfile(userId: string): Promise<MentorProfileEntity> {
    const profile = await this.profiles.findOne({ where: { userId } });
    if (!profile) throw new NotFoundException('Mentor profile not found');
    return profile;
  }

  private parseRange(fromInput: string, toInput: string): { from: Date; to: Date } {
    const from = new Date(fromInput);
    const to = new Date(toInput);
    if (to.getTime() <= from.getTime()) throw this.validationError('to must be after from');
    return { from, to };
  }

  private toDto(slot: MentorAvailabilitySlotEntity, includeHold: boolean): MentorSlotDto {
    return {
      id: slot.id,
      startsAt: slot.startsAt.toISOString(),
      endsAt: slot.endsAt.toISOString(),
      status: slot.status,
      ...(includeHold ? { holdExpiresAt: slot.holdExpiresAt?.toISOString() ?? null } : {}),
    };
  }

  private validationError(message: string): BadRequestException {
    return new BadRequestException({ errorCode: ERROR_CODES.VALIDATION_ERROR, message });
  }

  private now(): Date {
    return this.clock?.() ?? new Date();
  }
}
