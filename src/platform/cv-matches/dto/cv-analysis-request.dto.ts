import { Transform } from 'class-transformer';
import { Equals, IsBoolean, IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { RubricBand } from '../../../common/services/role-rubric.service';

/** Multipart request for the single-charge CV analysis orchestration endpoint. */
export class CvAnalysisRequestDto {
  @IsOptional()
  @IsUUID()
  cvId?: string;

  @IsString()
  @MaxLength(80)
  targetRole!: string;

  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  @Equals(true)
  consentAccepted!: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  title?: string;

  @IsOptional()
  @IsIn(['vi', 'en'])
  lang?: 'vi' | 'en';

  @IsOptional()
  @IsString()
  jdText?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  jdTitle?: string;

  @IsOptional()
  @IsIn(['intern', 'fresher', 'mid'])
  targetBand?: RubricBand;
}
