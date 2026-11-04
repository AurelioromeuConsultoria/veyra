import { Controller, Get, Query } from '@nestjs/common';
import { AuditPageDto, ListAuditInput, listAuditSchema } from '@veyra/contracts';
import { AuthContext, CurrentAuth, RequirePermissions } from '../common/decorators';
import { ProtectedContentService } from '../extensions/protected-content';
import { ZodPipe } from '../common/zod.pipe';
import { AuditService } from './audit.service';
import { ConteudoDaTrilha } from './conteudo-da-trilha';

/** Trilha é READ-ONLY por API (append-only garantido no PrismaService). */
@Controller('audit')
export class AuditController {
  constructor(
    private readonly audit: AuditService,
    private readonly protegido: ProtectedContentService,
    private readonly trilha: ConteudoDaTrilha,
  ) {}

  /**
   * A trilha sob o E8 (ADR-061, adendo 7): as ações que revelam a
   * classificação não saem para quem não pode sabê-la, e o conteúdo protegido
   * (títulos, nomes de arquivo) sai mascarado quando a entidade é oculta.
   */
  @RequirePermissions('audit:read')
  @Get()
  async list(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodPipe(listAuditSchema)) query: ListAuditInput,
  ): Promise<AuditPageDto> {
    const revela = await this.protegido.trilhaQueRevela(auth);
    const pagina = await this.audit.list(query, { fora: revela?.where ?? null });
    const items = revela ? pagina.items.filter((i) => !revela.revela(i)) : pagina.items;
    return { ...pagina, items: await this.trilha.mascarar(auth, items) };
  }
}
