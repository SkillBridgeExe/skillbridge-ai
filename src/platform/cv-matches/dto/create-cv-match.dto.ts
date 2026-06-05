import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class CreateCvMatchDto {
  @ApiPropertyOptional({
    description: 'Raw JD text when using paste mode. Omit when uploading a JD file.',
    example: 'We need a frontend developer with React and TypeScript experience.',
  })
  @IsOptional()
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  jdText?: string;

  @ApiPropertyOptional({ example: 'Frontend Developer JD' })
  @IsOptional()
  @IsString()
  @MaxLength(160)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  title?: string;

  @ApiPropertyOptional({ example: 'frontend_developer' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  targetRole?: string;
}
