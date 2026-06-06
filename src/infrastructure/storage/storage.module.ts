import { Module } from '@nestjs/common';
import { GcsStorageService } from './gcs-storage.service';

@Module({
  providers: [GcsStorageService],
  exports: [GcsStorageService],
})
export class StorageModule {}
