import { Controller, Get } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator';

/**
 * Health check — the only unauthenticated route.
 * Used by Cloud Run / Docker for liveness + readiness probes.
 */
@Controller('health')
export class HealthController {
  @Public()
  @Get()
  check() {
    return {
      status: 'ok',
      service: 'skillbridge-ai',
      timestamp: new Date().toISOString(),
    };
  }
}
