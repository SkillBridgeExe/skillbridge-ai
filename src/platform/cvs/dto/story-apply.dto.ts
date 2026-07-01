import { ApiProperty } from '@nestjs/swagger';
import { IsObject } from 'class-validator';
import { CanonicalCvDocument } from '../../../common/types/canonical-cv';
import { SelectedStoryItems } from '../../../modules/cv-builder/story-merge';

export class StoryApplyRequestDto {
  @ApiProperty({ description: 'The current full CanonicalCvDocument to merge into.' })
  @IsObject()
  doc!: CanonicalCvDocument;

  @ApiProperty({
    description: 'User-chosen items: { role_code?, projects?[], certifications?[] }.',
  })
  @IsObject()
  selected!: SelectedStoryItems;
}

export class StoryApplyResponseDto {
  @ApiProperty({
    description: 'The merged document (projects/certs appended, deduped). Persist via PUT.',
  })
  doc!: CanonicalCvDocument;

  @ApiProperty({ example: { projects: 1, certifications: 1 } })
  applied!: { projects: number; certifications: number };

  @ApiProperty({
    type: 'array',
    items: { type: 'object' },
    description: '[{section, name}] skipped as duplicates.',
  })
  skipped_duplicates!: Array<{ section: 'projects' | 'certifications'; name: string }>;
}
