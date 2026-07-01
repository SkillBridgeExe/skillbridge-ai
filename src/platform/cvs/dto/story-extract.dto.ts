import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

const LANGUAGES = ['vi', 'en'] as const;

export class StoryExtractRequestDto {
  @ApiProperty({
    example: 'Dự án Shop Online bằng React và Node.js, nhóm 4 người.',
    maxLength: 5000,
  })
  @IsString()
  @MaxLength(5000)
  story!: string;

  @ApiPropertyOptional({ enum: LANGUAGES, default: 'vi' })
  @IsOptional()
  @IsIn(LANGUAGES as unknown as string[])
  language?: (typeof LANGUAGES)[number];
}

export class ProjectDto {
  @ApiProperty() name!: string;
  @ApiProperty({ nullable: true, type: String }) role!: string | null;
  @ApiProperty({ type: [String] }) tech!: string[];
  @ApiProperty({ type: [String] }) bullets!: string[];
  @ApiProperty({ nullable: true, type: String }) link!: string | null;
  @ApiProperty({ type: [String] }) found_fields!: string[];
  @ApiProperty({ type: [String] }) missing_fields!: string[];
}
export class CertDto {
  @ApiProperty() name!: string;
  @ApiProperty({ nullable: true, type: String }) issuer!: string | null;
  @ApiProperty({ nullable: true, type: String }) date!: string | null;
  @ApiProperty({ nullable: true, type: String }) matched_pattern!: string | null;
}
export class StoryExtractResponseDto {
  @ApiProperty({ type: [ProjectDto] }) projects!: ProjectDto[];
  @ApiProperty({ type: [CertDto] }) certifications!: CertDto[];
  @ApiProperty() degraded!: boolean;
}
