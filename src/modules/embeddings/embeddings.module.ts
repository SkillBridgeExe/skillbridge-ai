import { Module } from '@nestjs/common';
import { EmbeddingsController } from './embeddings.controller';
import { EmbeddingsService } from './embeddings.service';
import { ChunkerService } from './chunker.service';

@Module({
  controllers: [EmbeddingsController],
  providers: [EmbeddingsService, ChunkerService],
  exports: [EmbeddingsService],
})
export class EmbeddingsModule {}
