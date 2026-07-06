import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThan, MoreThan, MoreThanOrEqual, Not, Repository } from 'typeorm';
import { ERROR_CODES } from '../../common/constants/error-codes';
import { MentorAvailabilityTemplateEntity } from '../../database/entities/mentor-availability-template.entity';
import { MentorAvailabilitySlotEntity } from '../../database/entities/mentor-availability-slot.entity';
import { MentorProfileEntity } from '../../database/entities/mentor-profile.entity';
import {
  CreateMentorSlotDto,
  MentorAvailabilityTemplateDto,
  MentorAvailabilityWindowDto,
  MentorSlotDto,
  SaveMentorAvailabilityTemplateDto,
} from './dto/mentor-availability.dto';

export const MENTOR_AVAILABILITY_CLOCK = Symbol('MENTOR_AVAILABILITY_CLOCK');
const MINIMUM_LEAD_TIME_MS = 24 * 60 * 60 * 1000;
const MAXIMUM_RANGE_MS = 60 * 24 * 60 * 60 * 1000;
const GENERATION_HORIZON_DAYS = 60;
const DEFAULT_TEMPLATE_TIMEZONE = 'Asia/Ho_Chi_Minh';
const VIETNAM_OFFSET_MS = 7 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

@Injectable()
export class MentorAvailabilityService {
  constructor(
    @InjectRepository(MentorProfileEntity)
    private readonly profiles: Repository<MentorProfileEntity>,
    @InjectRepository(MentorAvailabilitySlotEntity)
    private readonly slots: Repository<MentorAvailabilitySlotEntity>,
    @InjectRepository(MentorAvailabilityTemplateEntity)
    private readonly templates: Repository<MentorAvailabilityTemplateEntity>,
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
        source: 'MANUAL',
        availabilityTemplateId: null,
        heldByBookingId: null,
        holdExpiresAt: null,
      }),
    );
    return this.toDto(saved, true);
  }

  async getWeeklyTemplate(userId: string): Promise<MentorAvailabilityTemplateDto> {
    const profile = await this.requireProfile(userId);
    const rows = await this.templates.find({
      where: { mentorProfileId: profile.id },
      order: { dayOfWeek: 'ASC', startMinute: 'ASC' },
    });
    return this.toTemplateDto(rows);
  }

  async saveWeeklyTemplate(
    userId: string,
    dto: SaveMentorAvailabilityTemplateDto,
  ): Promise<MentorAvailabilityTemplateDto> {
    const profile = await this.requireProfile(userId);
    if (profile.status !== 'APPROVED' || !profile.isAcceptingBookings) {
      throw new ForbiddenException({
        errorCode: ERROR_CODES.FORBIDDEN,
        message: 'Only approved mentors accepting bookings can manage weekly availability',
      });
    }

    const timezone = dto.timezone ?? DEFAULT_TEMPLATE_TIMEZONE;
    const bufferMinutes = dto.bufferMinutes ?? 0;
    const windows = this.cleanTemplateWindows(dto.windows ?? [], profile.sessionDurationMinutes);
    if (timezone !== DEFAULT_TEMPLATE_TIMEZONE) {
      throw this.validationError(`Only ${DEFAULT_TEMPLATE_TIMEZONE} timezone is supported`);
    }
    if (![0, 15, 30].includes(bufferMinutes)) {
      throw this.validationError('Buffer minutes must be 0, 15, or 30');
    }

    await this.templates.delete({ mentorProfileId: profile.id });
    const savedTemplates: MentorAvailabilityTemplateEntity[] = [];
    for (const window of windows) {
      const saved = await this.templates.save(
        this.templates.create({
          mentorProfileId: profile.id,
          dayOfWeek: window.dayOfWeek,
          startMinute: window.startMinute,
          endMinute: window.endMinute,
          bufferMinutes,
          timezone,
          isActive: window.isActive ?? true,
        }),
      );
      savedTemplates.push(saved);
    }

    const now = this.now();
    await this.slots.delete({
      mentorProfileId: profile.id,
      source: 'TEMPLATE',
      status: 'OPEN',
      startsAt: MoreThanOrEqual(now),
    });
    const horizon = new Date(now.getTime() + GENERATION_HORIZON_DAYS * 24 * 60 * 60 * 1000);
    const existingSlots = await this.slots.find({
      where: {
        mentorProfileId: profile.id,
        startsAt: LessThan(horizon),
        endsAt: MoreThan(now),
      },
      order: { startsAt: 'ASC' },
    });

    await this.generateTemplateSlots(profile, savedTemplates, existingSlots, now, horizon);

    return this.toTemplateDto(savedTemplates);
  }

  async blockGeneratedSlot(userId: string, slotId: string): Promise<MentorSlotDto> {
    const profile = await this.requireProfile(userId);
    const slot = await this.requireOwnedSlot(profile.id, slotId);
    if (slot.source !== 'TEMPLATE' || slot.status !== 'OPEN') {
      throw this.validationError('Only generated open slots can be blocked');
    }
    if (slot.startsAt.getTime() <= this.now().getTime()) {
      throw this.validationError('Only future generated slots can be blocked');
    }
    slot.status = 'BLOCKED';
    slot.heldByBookingId = null;
    slot.holdExpiresAt = null;
    return this.toDto(await this.slots.save(slot), true);
  }

  async unblockGeneratedSlot(userId: string, slotId: string): Promise<MentorSlotDto> {
    const profile = await this.requireProfile(userId);
    const slot = await this.requireOwnedSlot(profile.id, slotId);
    if (slot.source !== 'TEMPLATE' || slot.status !== 'BLOCKED') {
      throw this.validationError('Only generated blocked slots can be restored');
    }
    if (slot.startsAt.getTime() <= this.now().getTime()) {
      throw this.validationError('Only future generated slots can be restored');
    }
    const overlaps = await this.slots.exist({
      where: {
        id: Not(slot.id),
        mentorProfileId: profile.id,
        status: In(['OPEN', 'HELD', 'BOOKED']),
        startsAt: LessThan(slot.endsAt),
        endsAt: MoreThan(slot.startsAt),
      },
    });
    if (overlaps) throw this.validationError('Generated slot overlaps an active slot');
    slot.status = 'OPEN';
    return this.toDto(await this.slots.save(slot), true);
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
    if (slot.source === 'TEMPLATE') {
      throw this.validationError('Generated slots must be blocked instead of deleted');
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
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw this.validationError('from and to must be valid dates');
    }
    if (to.getTime() <= from.getTime()) throw this.validationError('to must be after from');
    if (to.getTime() - from.getTime() > MAXIMUM_RANGE_MS) {
      throw this.validationError('Mentor slot range cannot exceed 60 days');
    }
    return { from, to };
  }

  private cleanTemplateWindows(
    input: MentorAvailabilityWindowDto[],
    sessionDurationMinutes: number,
  ): MentorAvailabilityWindowDto[] {
    const windows = input.map((window) => ({
      dayOfWeek: window.dayOfWeek,
      startMinute: window.startMinute,
      endMinute: window.endMinute,
      isActive: window.isActive ?? true,
    }));

    for (const window of windows) {
      if (window.dayOfWeek < 1 || window.dayOfWeek > 7) {
        throw this.validationError('Availability day must be between 1 and 7');
      }
      if (
        window.startMinute < 0 ||
        window.startMinute >= 1440 ||
        window.endMinute <= window.startMinute ||
        window.endMinute > 1440
      ) {
        throw this.validationError('Availability window time range is invalid');
      }
      if (window.isActive && window.endMinute - window.startMinute < sessionDurationMinutes) {
        throw this.validationError('Availability window must fit at least one session');
      }
    }

    for (const day of [1, 2, 3, 4, 5, 6, 7]) {
      const dayWindows = windows
        .filter((window) => window.isActive && window.dayOfWeek === day)
        .sort((a, b) => a.startMinute - b.startMinute);
      for (let index = 1; index < dayWindows.length; index += 1) {
        if (dayWindows[index - 1].endMinute > dayWindows[index].startMinute) {
          throw this.validationError('Availability windows cannot overlap');
        }
      }
    }

    return windows;
  }

  private async generateTemplateSlots(
    profile: MentorProfileEntity,
    templates: MentorAvailabilityTemplateEntity[],
    existingSlots: MentorAvailabilitySlotEntity[],
    now: Date,
    horizon: Date,
  ): Promise<void> {
    const activeTemplates = templates.filter((template) => template.isActive);
    const leadCutoff = new Date(now.getTime() + MINIMUM_LEAD_TIME_MS);
    const generatedCandidates: Array<{
      template: MentorAvailabilityTemplateEntity;
      startsAt: Date;
      endsAt: Date;
    }> = [];

    for (let offset = 0; offset <= GENERATION_HORIZON_DAYS; offset += 1) {
      const localMidnight = this.localMidnightUtcForOffset(now, offset);
      const dayOfWeek = this.isoDayOfWeek(localMidnight);
      for (const template of activeTemplates.filter((row) => row.dayOfWeek === dayOfWeek)) {
        for (
          let startMinute = template.startMinute;
          startMinute + profile.sessionDurationMinutes <= template.endMinute;
          startMinute += profile.sessionDurationMinutes + template.bufferMinutes
        ) {
          const startsAt = new Date(localMidnight.getTime() + startMinute * MINUTE_MS);
          const endsAt = new Date(startsAt.getTime() + profile.sessionDurationMinutes * MINUTE_MS);
          if (startsAt < leadCutoff || endsAt > horizon) continue;
          generatedCandidates.push({ template, startsAt, endsAt });
        }
      }
    }

    const occupiedSlots = [...existingSlots];
    for (const candidate of generatedCandidates) {
      if (occupiedSlots.some((slot) => this.overlaps(slot, candidate.startsAt, candidate.endsAt))) {
        continue;
      }
      const saved = await this.slots.save(
        this.slots.create({
          mentorProfileId: profile.id,
          startsAt: candidate.startsAt,
          endsAt: candidate.endsAt,
          status: 'OPEN',
          source: 'TEMPLATE',
          availabilityTemplateId: candidate.template.id,
          heldByBookingId: null,
          holdExpiresAt: null,
        }),
      );
      occupiedSlots.push(saved);
    }
  }

  private localMidnightUtcForOffset(from: Date, dayOffset: number): Date {
    const local = new Date(from.getTime() + VIETNAM_OFFSET_MS);
    const localMidnightTimestamp = Date.UTC(
      local.getUTCFullYear(),
      local.getUTCMonth(),
      local.getUTCDate() + dayOffset,
    );
    return new Date(localMidnightTimestamp - VIETNAM_OFFSET_MS);
  }

  private isoDayOfWeek(localMidnightUtc: Date): number {
    const local = new Date(localMidnightUtc.getTime() + VIETNAM_OFFSET_MS);
    const day = local.getUTCDay();
    return day === 0 ? 7 : day;
  }

  private overlaps(slot: MentorAvailabilitySlotEntity, startsAt: Date, endsAt: Date): boolean {
    return slot.startsAt < endsAt && slot.endsAt > startsAt;
  }

  private async requireOwnedSlot(
    mentorProfileId: string,
    slotId: string,
  ): Promise<MentorAvailabilitySlotEntity> {
    const slot = await this.slots.findOne({ where: { id: slotId } });
    if (!slot || slot.mentorProfileId !== mentorProfileId) {
      throw new NotFoundException('Mentor slot not found');
    }
    return slot;
  }

  private toTemplateDto(rows: MentorAvailabilityTemplateEntity[]): MentorAvailabilityTemplateDto {
    const sorted = [...rows].sort(
      (a, b) => a.dayOfWeek - b.dayOfWeek || a.startMinute - b.startMinute,
    );
    return {
      timezone: sorted[0]?.timezone ?? DEFAULT_TEMPLATE_TIMEZONE,
      bufferMinutes: sorted[0]?.bufferMinutes ?? 0,
      windows: sorted.map((row) => ({
        id: row.id,
        dayOfWeek: row.dayOfWeek,
        startMinute: row.startMinute,
        endMinute: row.endMinute,
        isActive: row.isActive,
      })),
    };
  }

  private toDto(slot: MentorAvailabilitySlotEntity, includeHold: boolean): MentorSlotDto {
    return {
      id: slot.id,
      startsAt: slot.startsAt.toISOString(),
      endsAt: slot.endsAt.toISOString(),
      status: slot.status,
      source: slot.source ?? 'MANUAL',
      availabilityTemplateId: slot.availabilityTemplateId ?? null,
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
