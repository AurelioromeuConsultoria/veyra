import { Controller, Get } from '@nestjs/common';
import type { HealthDto } from '@veyra/contracts';
import { Public } from '../common/decorators';

@Controller('health')
export class HealthController {
  /** @Public justificado: healthcheck de docker/CI/monitoração (SECURITY.md §3). */
  @Public()
  @Get()
  check(): HealthDto {
    return {
      status: 'ok',
      service: 'veyra-api',
      timestamp: new Date().toISOString(),
    };
  }
}
