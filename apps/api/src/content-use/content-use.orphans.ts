import { Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import type { Prisma } from '../generated/prisma/client';
import type { Db } from '../prisma/prisma.service';
import { UsageService } from '../usage/usage.service';

export type TipoDeUso = 'ai_generation' | 'ai_message_dispatch' | 'webhook_delivery';
export type Detector =
  | 'commit'
  | 'change'
  | 'workspace_change'
  | 'reconciliation'
  | 'missing_record'
  /** a chamada passou do prazo sem responder e pode começar depois (adendo 7, G1) */
  | 'overran_deadline';

/** O registro de um uso, como os detectores o leem. */
export interface UsoRegistrado {
  id: string;
  workspaceId: string;
  kind: TipoDeUso;
  contactIds: string[];
  entityKeys: string[];
  origin: Prisma.JsonValue;
  reservationIds: string[];
  runMetadata: Prisma.JsonValue | null;
}

/**
 * O que cada TIPO de uso faz com o registro de origem quando o uso vira
 * `in_doubt` (adendo 7 §3.6): o despacho vai a `unknown_after_dispatch`; o run
 * da IA e a entrega do webhook são CRIADOS incertos com o id pré-gerado, se
 * ainda não existirem. A transação pode ser do client filtrado (M, a guarda,
 * a recuperação, a reconciliação) OU do `raw`: a ativação e a desativação de
 * um vertical marcam os órfãos numa transação administrativa sem contexto.
 * Por isso TODO `where` e TODO `data` levam `workspaceId` explícito, sem
 * depender do filtro (ADR-047 adendo 7 §8). A G3 testa cada tratador numa
 * transação `raw` com linhas de outro workspace presentes.
 */
export interface OrigemDoUso {
  marcarIncerta(tx: Db, uso: UsoRegistrado): Promise<void>;
}

/**
 * A ESPECIFICAÇÃO de um tipo de uso (ADR-047 adendo 7 §9): o que o registro
 * aceita e o tratador de origem. O módulo do uso a registra antes de existir;
 * a guarda recusa uso de tipo sem registro, e chave ou valor fora dela.
 */
export interface EspecificacaoDoUso extends OrigemDoUso {
  /** chaves de `origem` aceitas; os valores são sempre uuid ou null */
  origem: readonly string[];
  /** chaves dos metadados do run, cada uma com o validador do VALOR: lista fechada ou formato estrito */
  metadados: Readonly<Record<string, (valor: unknown) => boolean>>;
}

/** As especificações dos tipos de uso, registradas pelos módulos dos usos (G3). */
@Injectable()
export class OrigensDosUsos {
  private readonly porTipo = new Map<TipoDeUso, EspecificacaoDoUso>();

  registrar(tipo: TipoDeUso, especificacao: EspecificacaoDoUso): void {
    // duas especificações para o mesmo tipo é engano de composição: recusa
    if (this.porTipo.has(tipo)) throw new Error(`Tratador de origem duplicado para ${tipo}.`);
    this.porTipo.set(tipo, especificacao);
  }

  de(tipo: TipoDeUso): EspecificacaoDoUso | undefined {
    return this.porTipo.get(tipo);
  }
}

const CAMPOS_DO_USO = {
  id: true,
  workspaceId: true,
  kind: true,
  contactIds: true,
  entityKeys: true,
  origin: true,
  reservationIds: true,
  runMetadata: true,
} as const;

/**
 * Os DETECTORES de uso órfão (ADR-047 adendo 7 §3.3). Só marca `in_doubt`
 * quem tem PROVA de que a guarda do uso acabou: o próprio processo (o `COMMIT`
 * falhou), a mudança que segura as travas exclusivas, ou a reconciliação que
 * obteve a trava própria do uso. A marcação mora aqui, no Core, para que a
 * mudança de um vertical nunca toque nas tabelas de run, despacho ou reserva.
 */
@Injectable()
export class UsosOrfaos {
  private readonly logger = new Logger(UsosOrfaos.name);

  constructor(
    private readonly usage: UsageService,
    private readonly audit: AuditService,
    private readonly origens: OrigensDosUsos,
  ) {}

  /**
   * Transição CONDICIONAL `authorized → in_doubt`. A linha do uso muda
   * PRIMEIRO: as reservas e a origem só mudam se ela afetou a linha — assim
   * dois detectores no mesmo órfão não cobram duas vezes nem se travam.
   */
  async marcarEmDuvida(tx: Db, uso: UsoRegistrado, detectedBy: Detector): Promise<boolean> {
    const { count } = await tx.contentUse.updateMany({
      where: { id: uso.id, workspaceId: uso.workspaceId, status: 'authorized' },
      data: { status: 'in_doubt', detectedBy, finishedAt: new Date() },
    });
    if (count === 0) return false;
    await this.depoisDeEmDuvida(tx, uso, detectedBy);
    return true;
  }

  /** O que segue à marcação: reservas pelo teto, origem incerta e o incidente. */
  async depoisDeEmDuvida(tx: Db, uso: UsoRegistrado, detectedBy: Detector): Promise<void> {
    for (const reserva of uso.reservationIds) {
      // a varredura de reservas não toca reserva de uso `authorized`; se ela já
      // não existe, outro caminho a acertou — registra para investigação
      if (!(await this.usage.chargeCeilingWithin(tx, uso.workspaceId, reserva))) {
        this.logger.warn(`Uso ${uso.id}: reserva já acertada ao marcar em dúvida`);
      }
    }
    const especificacao = this.origens.de(uso.kind);
    // um uso não começa sem especificação; a falta dela aqui é erro de composição
    if (!especificacao) this.logger.warn(`Uso ${uso.id}: tipo ${uso.kind} sem tratador de origem`);
    await especificacao?.marcarIncerta(tx, uso);
    await this.audit.record(tx, uso.workspaceId, 'content_use.in_doubt', {
      entityType: 'contentUse',
      entityId: uso.id,
      actor: { type: 'system', id: `content-use:${detectedBy}` },
      after: { status: 'in_doubt', kind: uso.kind, detectedBy },
    });
  }

  /**
   * Mudança por contato ou de titularidade (M). Chamada DEPOIS de
   * `travarParaMudanca`, na mesma transação: com as travas exclusivas, todo uso
   * ainda `authorized` desses contatos ou entidades é órfão — uma guarda viva
   * seguraria a trava compartilhada. A busca é depois das travas, em READ
   * COMMITTED, e enxerga todo registro comitado.
   */
  async marcarOrfaosDaMudanca(
    tx: Db,
    escopo: { workspaceId: string; contactIds?: readonly string[]; entityKeys?: readonly string[] },
  ): Promise<number> {
    const contatos = [...(escopo.contactIds ?? [])];
    const entidades = [...(escopo.entityKeys ?? [])];
    if (contatos.length === 0 && entidades.length === 0) return 0;
    const orfaos = (await tx.contentUse.findMany({
      where: {
        workspaceId: escopo.workspaceId,
        status: 'authorized',
        OR: [
          ...(contatos.length > 0 ? [{ contactIds: { hasSome: contatos } }] : []),
          ...(entidades.length > 0 ? [{ entityKeys: { hasSome: entidades } }] : []),
        ],
      },
      // ordem estável: duas mudanças marcando os mesmos órfãos não se travam em cruz
      orderBy: { id: 'asc' },
      select: CAMPOS_DO_USO,
    })) as unknown as UsoRegistrado[];
    let marcados = 0;
    for (const uso of orfaos) {
      if (await this.marcarEmDuvida(tx, uso, 'change')) marcados += 1;
    }
    return marcados;
  }

  /** Mudança do workspace inteiro: depois de `travarWorkspaceInteiro`, todo `authorized` é órfão. */
  async marcarOrfaosDoWorkspace(tx: Db, workspaceId: string): Promise<number> {
    const orfaos = (await tx.contentUse.findMany({
      where: { workspaceId, status: 'authorized' },
      orderBy: { id: 'asc' },
      select: CAMPOS_DO_USO,
    })) as unknown as UsoRegistrado[];
    let marcados = 0;
    for (const uso of orfaos) {
      if (await this.marcarEmDuvida(tx, uso, 'workspace_change')) marcados += 1;
    }
    return marcados;
  }

  /** A conclusão tardia de um uso já `in_doubt`: o indício vai para a auditoria. */
  async registrarTentativaTardia(tx: Db, uso: UsoRegistrado): Promise<void> {
    await this.audit.record(tx, uso.workspaceId, 'content_use.late_conclusion', {
      entityType: 'contentUse',
      entityId: uso.id,
      actor: { type: 'system', id: 'content-use:late' },
      after: { status: 'in_doubt', kind: uso.kind },
    });
  }

  /** Leitura de um uso pelo id, com o workspace explícito. */
  async ler(
    tx: Db,
    workspaceId: string,
    id: string,
  ): Promise<(UsoRegistrado & { status: string }) | null> {
    return (await tx.contentUse.findFirst({
      where: { id, workspaceId },
      select: { ...CAMPOS_DO_USO, status: true },
    })) as unknown as (UsoRegistrado & { status: string }) | null;
  }
}
