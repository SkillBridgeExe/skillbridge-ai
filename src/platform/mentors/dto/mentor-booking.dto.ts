import {
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateMentorBookingDto {
  @IsUUID()
  mentorProfileId!: string;

  @IsUUID()
  slotId!: string;
}

export class UpdateMeetingUrlDto {
  @IsUrl({ protocols: ['https'], require_protocol: true })
  meetingUrl!: string;
}

export class CancelMentorBookingDto {
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

export class CreateMentorReviewDto {
  @IsInt()
  @Min(1)
  @Max(5)
  rating!: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  comment?: string;
}
