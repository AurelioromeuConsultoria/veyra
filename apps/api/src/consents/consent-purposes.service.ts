import { Injectable, NotFoundException } from '@nestjs/common';
import type { CreateConsentPurposeInput } from '@veyra/contracts';
import { ClsService } from 'nestjs-cls';
import { AuditService } from '../audit/audit.service';
import { PrismaService, type Db } from '../prisma/prisma.service';

type TxRunner = { $transaction: <T>(fn: (tx: Db) => Promise<T>) => Promise<T> };

/**
 * A versão nova de uma finalidade (ADR-052 item 5, F4.1b), só pela CLI
 * administrativa: imutável (append-only no client), auditada, e a versão é a
 * seguinte à maior da mesma chave. O único de (workspace, chave, versão) recusa
 * duas criações simultâneas da mesma versão.
 */
@Injectable()
export class ConsentPurposesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly cls: ClsService,
  ) {}

  async criarVersao(
    slug: string,
    input: CreateConsentPurposeInput,
  ): Promise<{ workspaceId: string; purposeId: string; version: number }> {
    // `raw` justificado: rotina administrativa (CLAUDE.md §3.3) que resolve o
    // workspace pelo slug, antes de existir contexto; a escrita vai pelo client
    // protegido, no contexto dele
    const workspace = await this.prisma.raw.workspace.findFirst({
      where: { slug },
      select: { id: true },
    });
    if (!workspace) throw new NotFoundException(`Workspace ${slug} não encontrado`);
    return this.cls.run(async () => {
      this.cls.set('workspaceId', workspace.id);
      const db = this.prisma.db as unknown as TxRunner;
      return db.$transaction(async (tx) => {
        const ultima = await tx.consentPurpose.findFirst({
          where: { key: input.key },
          orderBy: { version: 'desc' },
          select: { version: true },
        });
        const version = (ultima?.version ?? 0) + 1;
        const criada = (await tx.consentPurpose.create({
          data: { ...input, version },
          select: { id: true },
        } as never)) as unknown as { id: string };
        await this.audit.record(tx, workspace.id, 'consent_purpose.created', {
          entityType: 'consentPurpose',
          entityId: criada.id,
          actor: { type: 'system', id: 'cli:consents-purpose' },
          after: { key: input.key, version, category: input.category, fields: input.fields },
        });
        return { workspaceId: workspace.id, purposeId: criada.id, version };
      });
    });
  }
}
