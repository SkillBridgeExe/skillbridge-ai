import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class SkillListQueryDto {
  @ApiPropertyOptional({ example: 'react' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  query?: string;

  @ApiPropertyOptional({ example: 'frontend_framework' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  category?: string;

  @ApiPropertyOptional({ example: 20, minimum: 1, maximum: 50 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}
