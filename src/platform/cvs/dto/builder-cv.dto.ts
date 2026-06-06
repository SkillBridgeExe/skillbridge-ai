import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsObject, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { CanonicalCvDocument } from '../../../common/types/canonical-cv';

export class CreateBuilderCvDto {
  @ApiPropertyOptional({
    format: 'uuid',
    example: '8c4d4f2d-55dd-42a4-b9c7-57b6bdfc8d7f',
    description:
      'Optional owned CV ID to seed the builder draft from. Omit to use latest parsed uploaded CV, or a blank document when none exists.',
  })
  @IsOptional()
  @IsUUID()
  sourceCvId?: string;

  @ApiPropertyOptional({
    maxLength: 160,
    example: 'Frontend Developer CV',
    description: 'Optional display title for the builder draft.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(160)
  title?: string;

  @ApiPropertyOptional({
    maxLength: 64,
    example: 'frontend_developer',
    description:
      'Optional IT role code used by scoring hints. Examples: frontend_developer, backend_developer, fullstack_developer, data_analyst, mobile_developer, devops_engineer, qa_tester, ai_ml_engineer.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  targetRole?: string;

  @ApiPropertyOptional({
    enum: ['vi', 'en'],
    example: 'vi',
    description: 'Optional builder language. Defaults from source CV, otherwise en.',
  })
  @IsOptional()
  @IsIn(['vi', 'en'])
  language?: 'vi' | 'en';
}

export class UpdateBuilderCvDto {
  @ApiProperty({
    description: 'Canonical CV document written by the builder form.',
    type: 'object',
    additionalProperties: true,
    example: {
      language: 'vi',
      contact: {
        name: 'Nguyen Van A',
        email: 'a@example.com',
        phone: '0900000000',
        location: 'Ho Chi Minh',
        links: [{ label: 'GitHub', url: 'https://github.com/example' }],
      },
      summary: 'Frontend developer with React and TypeScript experience.',
      education: [],
      experience: [],
      projects: [],
      skills: {
        technical: ['React', 'TypeScript'],
        soft: ['Communication'],
        languages: ['English'],
        tools: ['Git', 'Docker'],
      },
      certifications: [],
      activities: [],
    },
  })
  @IsObject()
  parsedJson!: CanonicalCvDocument;

  @ApiPropertyOptional({
    maxLength: 160,
    example: 'Updated Frontend CV',
    description: 'Optional new display title. Omit to keep current title.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(160)
  title?: string;

  @ApiPropertyOptional({
    maxLength: 64,
    example: 'frontend_developer',
    description: 'Optional role code. Omit to keep current targetRole.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  targetRole?: string;

  @ApiPropertyOptional({
    enum: ['vi', 'en'],
    example: 'vi',
    description: 'Optional language. Omit to use parsedJson.language or current language.',
  })
  @IsOptional()
  @IsIn(['vi', 'en'])
  language?: 'vi' | 'en';
}
