import { Global, Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { UsageModule } from '../usage/usage.module';
import { ContentUseGuard, GANCHOS_DA_GUARDA } from './content-use.guard';
import { OrigensDosUsos, UsosOrfaos } from './content-use.orphans';
import { CONFIG_DA_GUARDA, CONFIG_PADRAO_DA_GUARDA, PoolsDaGuarda } from './content-use.pools';
import { ReconciliacaoDosUsos } from './content-use.reconciler';

/**
 * Usos externos de conteúdo de contato sob guarda (ADR-047, adendos 6 e 7):
 * a guarda, os detectores de órfãos, a reconciliação e o registro dos
 * tratadores de origem. Global: os usos (IA, mensagem, webhook) e as mudanças
 * de restrição — do Core e dos verticais — dependem dela.
 */
@Global()
@Module({
  imports: [UsageModule, AuditModule],
  providers: [
    // padrões de produção; os testes sobrescrevem com prazos curtos e pontos de falha
    { provide: CONFIG_DA_GUARDA, useValue: CONFIG_PADRAO_DA_GUARDA },
    { provide: GANCHOS_DA_GUARDA, useValue: null },
    PoolsDaGuarda,
    ContentUseGuard,
    UsosOrfaos,
    OrigensDosUsos,
    ReconciliacaoDosUsos,
  ],
  // os pools NÃO saem do módulo: a conexão crua de registro e o client sem
  // filtro são da guarda (docs/SECURITY.md §2)
  exports: [ContentUseGuard, UsosOrfaos, OrigensDosUsos, ReconciliacaoDosUsos],
})
export class ContentUseModule {}
