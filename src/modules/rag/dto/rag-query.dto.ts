import { IsInt, IsNotEmpty, IsObject, IsOptional, IsString, Max, Min } from 'class-validator';

export class RagQueryRequestDto {
  @IsString()
  @IsNotEmpty()
  query_text!: string;

  @IsOptional()
  @IsObject()
  filter?: Record<string, unknown>;

  @IsInt()
  @Min(1)
  @Max(50)
  top_k = 5;
}

export interface RagChunkDto {
  chunk_id: string;
  document_id: string;
  content: string;
  score: number;
  metadata: Record<string, unknown> | null;
}

export interface RagQueryResponseDto {
  retrieval_log_id: string;
  chunks: RagChunkDto[];
}
