import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class PlatformCvReviewRequestDto {
  @ApiProperty({
    description: 'ID of an already-uploaded CV to re-run diagnosis for.',
    example: '00000000-0000-0000-0000-000000000101',
    format: 'uuid',
  })
  @IsUUID()
  cvId!: string;
}
