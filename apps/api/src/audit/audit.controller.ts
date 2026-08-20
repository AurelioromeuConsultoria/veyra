import { Controller, Get, Query } from '@nestjs/common';
import { AuditPageDto, ListAuditInput, listAuditSchema } from '@veyra/contracts';
import { RequirePermissions } from '../common/decorators';
import { ZodPipe } from '../common/zod.pipe';
import { AuditService } from './audit.service';

/** Trilha é READ-ONLY por API (append-only garantido no PrismaService). */
@Controller('audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @RequirePermissions('audit:read')
  @Get()
  list(@Query(new ZodPipe(listAuditSchema)) query: ListAuditInput): Promise<AuditPageDto> {
    return this.audit.list(query);
  }
}
