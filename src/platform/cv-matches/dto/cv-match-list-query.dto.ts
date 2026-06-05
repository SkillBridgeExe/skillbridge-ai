import { Transform } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';

export class CvMatchListQueryDto {
  @Transform(({ value }) => Number(value ?? 1))
  @IsInt()
  @Min(1)
  page = 1;

  @Transform(({ value }) => Number(value ?? 20))
  @IsInt()
  @Min(1)
  @Max(50)
  limit = 20;
}
