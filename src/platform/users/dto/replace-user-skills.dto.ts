import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsInt, IsUUID, Max, Min, ValidateNested } from 'class-validator';

export class ReplaceUserSkillItemDto {
  @ApiProperty({ example: '4d4041db-f2e1-4e71-9b7b-7806f98d07e8' })
  @IsUUID()
  skillId!: string;

  @ApiProperty({ example: 3, minimum: 1, maximum: 5 })
  @IsInt()
  @Min(1)
  @Max(5)
  level!: number;
}

export class ReplaceUserSkillsDto {
  @ApiProperty({ type: [ReplaceUserSkillItemDto] })
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ReplaceUserSkillItemDto)
  skills!: ReplaceUserSkillItemDto[];
}
