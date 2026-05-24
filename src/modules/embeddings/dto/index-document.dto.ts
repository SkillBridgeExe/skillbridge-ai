import { IsIn, IsNotEmpty, IsObject, IsOptional, IsString, IsUUID } from 'class-validator';

export type DocumentSourceType =
  | 'CV'
  | 'JOB_DESCRIPTION'
  | 'COURSE'
  | 'USER_PROFILE'
  | 'INTERVIEW';

const SOURCE_TYPES: DocumentSourceType[] = [
  'CV',
  'JOB_DESCRIPTION',
  'COURSE',
  'USER_PROFILE',
  'INTERVIEW',
];

export class IndexDocumentRequestDto {
  @IsUUID()
  document_id!: string;

  @IsIn(SOURCE_TYPES)
  source_type!: DocumentSourceType;

  @IsOptional()
  @IsUUID()
  source_id?: string;

  @IsString()
  @IsNotEmpty()
  content!: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

export interface IndexDocumentResponseDto {
  document_id: string;
  embedding_job_id: string;
  chunks_count: number;
  vector_document_id: string | null;
  status: 'PENDING' | 'PROCESSING' | 'SUCCESS' | 'FAILED';
}
