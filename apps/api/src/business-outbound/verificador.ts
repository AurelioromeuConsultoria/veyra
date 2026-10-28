import { Injectable, NotFoundException, type OnModuleInit } from '@nestjs/common';
import {
  PortaDoEnvioDoNegocio,
  type AntesDasTravas,
  type ReconferenciaDoNegocio,
  type VerificadorDoEnvioDoNegocio,
} from '../channels/business-dispatch.port';
import { PrismaService, type Db } from '../prisma/prisma.service';
import { TemplateVersionsService } from '../templates/template-versions.service';
import { mesmoHash } from './approval-hash';
import { ConferenciaDoEnvio } from './conferencia';

function mesmasChaves(a: readonly string[], b: readonly string[]): boolean {
  const x = [...a].sort();
  const y = [...b].sort();
  return x.length === y.length && x.every((k, i) => k === y[i]);
}

/**
 * O lado do DESPACHO do envio do negócio (ADR-052 item 7, F4.1c-3), que o
 * worker de envio chama pela porta: a releitura e o prazo antes das travas, e a
 * reconferência sob elas — a MESMA conferência da prévia e da aprovação, com
 * leituras novas e o hash recalculado contra o aprovado. Recusa de vez o que
 * divergiu; deixa tentar de novo só o que não pôde ser lido.
 */
@Injectable()
export class VerificadorDoNegocio implements VerificadorDoEnvioDoNegocio, OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly conferencia: ConferenciaDoEnvio,
    private readonly versoes: TemplateVersionsService,
    private readonly porta: PortaDoEnvioDoNegocio,
  ) {}

  onModuleInit(): void {
    this.porta.registrar(this);
  }

  async antesDasTravas(
    _workspaceId: string,
    messageId: string,
    signal: AbortSignal,
  ): Promise<AntesDasTravas> {
    const aprovacao = await this.prisma.db.outboundApproval.findFirst({
      where: { messageId },
      select: {
        templateVersionId: true,
        contactId: true,
        number: true,
        validityKeys: true,
        expiresAt: true,
      },
    });
    if (!aprovacao) {
      return { tipo: 'recusa', estado: 'failed_permanent', errorCode: 'approval_stale' };
    }
    // o prazo pelo relógio do banco (ADR-049): vencido, nem relê
    if (aprovacao.expiresAt.getTime() <= (await this.conferencia.agora()).getTime()) {
      return { tipo: 'recusa', estado: 'failed_permanent', errorCode: 'approval_expired' };
    }
    let releitura: Awaited<ReturnType<TemplateVersionsService['reler']>>;
    try {
      releitura = await this.versoes.reler(aprovacao.templateVersionId, signal);
    } catch (erro) {
      if (erro instanceof NotFoundException) {
        return { tipo: 'recusa', estado: 'failed_permanent', errorCode: 'template_unavailable' };
      }
      throw erro;
    }
    switch (releitura) {
      case 'divergente':
        // final para este despacho e esta aprovação; a releitura já gravou a divergência
        return { tipo: 'recusa', estado: 'failed_permanent', errorCode: 'template_changed' };
      case 'indisponivel':
        // pausado na Meta: cada nova tentativa relê, até o prazo da aprovação
        return { tipo: 'recusa', estado: 'failed_before_send', errorCode: 'template_unavailable' };
      case 'falha':
        return { tipo: 'recusa', estado: 'failed_before_send', errorCode: 'template_unverified' };
      case 'confere':
        return {
          tipo: 'segue',
          contactId: aprovacao.contactId,
          numero: aprovacao.number,
          validityKeys: aprovacao.validityKeys,
        };
    }
  }

  async reconferir(
    tx: Db,
    workspaceId: string,
    messageId: string,
  ): Promise<ReconferenciaDoNegocio> {
    const aprovacao = await tx.outboundApproval.findFirst({ where: { messageId } });
    if (!aprovacao) return { tipo: 'recusa', errorCode: 'approval_stale' };
    const c = await this.conferencia.conferir(tx, workspaceId, {
      originRef: aprovacao.originRef,
      channelId: aprovacao.channelId,
      contactId: aprovacao.contactId,
      number: aprovacao.number,
      templateVersionId: aprovacao.templateVersionId,
      purposeId: aprovacao.purposeId,
    });
    if (!c.ok) {
      // só a pré-condição que não respondeu deixa tentar de novo
      return c.motivo === 'precondition_unavailable'
        ? { tipo: 'indisponivel', errorCode: c.motivo }
        : { tipo: 'recusa', errorCode: c.motivo };
    }
    if (aprovacao.expiresAt.getTime() <= (await this.conferencia.agora()).getTime()) {
      return { tipo: 'recusa', errorCode: 'approval_expired' };
    }
    // as chaves fixadas na aprovação, e o hash com os dados de agora
    if (
      !mesmasChaves(c.conferido.forma.validityKeys, aprovacao.validityKeys) ||
      !mesmoHash(
        this.conferencia.hash(c.conferido.forma, aprovacao.expiresAt),
        aprovacao.approvalHash,
      )
    ) {
      return { tipo: 'recusa', errorCode: 'approval_stale' };
    }
    return {
      tipo: 'liberado',
      envio: { credencial: c.conferido.credencial, ...c.conferido.envio },
    };
  }
}
