import { IsDateString } from 'class-validator';

export class CreateMentorSlotDto {
  @IsDateString()
  startsAt!: string;

  @IsDateString()
  endsAt!: string;
}

export class ListMentorSlotsQueryDto {
  @IsDateString()
  from!: string;

  @IsDateString()
  to!: string;
}

export interface MentorSlotDto {
  id: string;
  startsAt: string;
  endsAt: string;
  status: string;
  holdExpiresAt?: string | null;
}
