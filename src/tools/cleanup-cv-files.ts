import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { CvsRetentionService } from '../platform/cvs/cv-retention.service';

async function main(): Promise<void> {
  const logger = new Logger('cleanup-cv-files');
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  try {
    const retention = app.get(CvsRetentionService);
    const [fileCleanup, rowPurge] = await Promise.all([
      retention.cleanupExpiredOriginalFiles(),
      retention.purgeSoftDeletedRows(),
    ]);
    logger.log(
      `CV retention complete filesDeleted=${fileCleanup.filesDeleted} rowsUpdated=${fileCleanup.rowsUpdated} rowsPurged=${rowPurge.rowsPurged}`,
    );
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  // Keep script output short; Nest global filters do not wrap CLI errors.
  console.error(`cleanup-cv-files failed: ${(error as Error).message}`);
  process.exit(1);
});
