import { Controller, Get } from '@nestjs/common';
import type { HealthDto } from '@veyra/contracts';

/**
 * Healthcheck público (docker/CI/monitoração). Quando o JwtAuthGuard global
 * existir (Entrega 2), esta rota recebe @Public() explícito — é a exceção
 * não autenticada prevista em docs/SECURITY.md §3.
 */
@Controller('health')
export class HealthController {
  @Get()
  check(): HealthDto {
    return {
      status: 'ok',
      service: 'veyra-api',
      timestamp: new Date().toISOString(),
    };
  }
}
