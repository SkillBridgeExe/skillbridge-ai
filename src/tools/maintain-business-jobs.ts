import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { BusinessJobsMaintenanceService } from '../platform/business-jobs/business-jobs-maintenance.service';

async function main(): Promise<void> {
  const logger = new Logger('maintain-business-jobs');
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  try {
    const maintenance = app.get(BusinessJobsMaintenanceService);
    const expired = await maintenance.expireDueEmployerJobs();
    const scheduled = await maintenance.scheduleEndedJobRetention();
    const purged = await maintenance.purgeDueApplicationPii();
    const notificationsSent = await maintenance.processPendingNotifications();
    logger.log(
      `Business jobs maintenance complete expired=${expired} scheduled=${scheduled} purged=${purged} notificationsSent=${notificationsSent}`,
    );
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(`maintain-business-jobs failed: ${(error as Error).message}`);
  process.exit(1);
});
