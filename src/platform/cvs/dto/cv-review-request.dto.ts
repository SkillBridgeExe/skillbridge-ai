import { IsUUID } from 'class-validator';

export class PlatformCvReviewRequestDto {
  @IsUUID()
  cvId!: string;
}
