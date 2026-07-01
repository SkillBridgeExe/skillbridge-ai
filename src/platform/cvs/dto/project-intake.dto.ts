import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { ProjectDto } from './story-extract.dto';

const LANGUAGES = ['vi', 'en'] as const;

export class ProjectIntakeRequestDto {
  @ApiProperty({
    example: 'Mình làm dự án Shop Online bằng React và Node.js, nhóm 4 người.',
    maxLength: 5000,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  story!: string;

  @ApiPropertyOptional({ enum: LANGUAGES, default: 'vi' })
  @IsOptional()
  @IsIn(LANGUAGES as unknown as string[])
  language?: (typeof LANGUAGES)[number];
}

export class ProjectIntakeResponseDto {
  @ApiProperty({
    type: ProjectDto,
    nullable: true,
    description: 'The single grounded project, or null when nothing was grounded.',
  })
  project!: ProjectDto | null;

  @ApiProperty({
    description: 'true → LLM call/parse failed; nothing extracted, the UI should ask to retry.',
  })
  degraded!: boolean;

  @ApiProperty({
    description:
      'true → the story described more than one project; only the first grounded one was filled.',
  })
  multiple_detected!: boolean;
}
