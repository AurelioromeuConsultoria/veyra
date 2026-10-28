import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';

/**
 * A pré-condição do envio do negócio (ADR-047 E7, ADR-052 item 9, C10
 * aprovado em 2026-10-26). O Core não conhece o pedido do vertical (o
 * agendamento a confirmar, o paciente a reativar), mas precisa saber, sob as
 * travas, se ele ainda vale e quais são os valores atuais dos campos do
 * vertical. A porta responde por PREFIXO da origem do pedido.
 *
 * O contrato de isolamento:
 * - a porta SÓ LÊ: sem escrita, sem `FOR UPDATE`, sem trava consultiva — quem
 *   chama já segura as travas, inclusive a `validity:` das chaves fixadas;
 * - roda no CLS do workspace do pedido, com o client filtrado: uma referência
 *   de outro workspace "não vale" (teste P0);
 * - responde no prazo (2 s, abaixo do orçamento da reconferência da guarda),
 *   ou é "indisponível".
 *
 * As três respostas não se confundem: "não vale" recusa de vez; "indisponível"
 * deixa tentar de novo; o prefixo sem porta recusa de vez. NENHUMA delas
 * autoriza envio — só `vale`, com as chaves iguais às fixadas.
 */

/**
 * A resposta da porta: vale — com o CONTATO a quem o pedido se destina, os
 * valores e as chaves de validade —, ou não vale. O contato liga o pedido ao
 * destinatário: o Core recusa o alvo que não for ele (revisão da F4.1c-3; sem
 * isso, o pedido de A, com os valores de A, iria a B).
 */
export type OutboundPreconditionAnswer =
  | { valid: true; contactId: string; values: Record<string, string>; validityKeys: string[] }
  | { valid: false };

/** Porta implementada pelo vertical. */
export interface OutboundPreconditionProvider {
  /** o prefixo da origem que ela responde (`<extensão>.<pedido>`), único */
  readonly prefix: string;
  /**
   * O pedido `originId` (a parte depois do prefixo) ainda vale, no workspace
   * EXPLÍCITO? Os valores são os dos campos do vertical que a finalidade
   * permite, e só eles.
   */
  check(workspaceId: string, originId: string): Promise<OutboundPreconditionAnswer>;
}

export const OUTBOUND_PRECONDITION_PROVIDERS = Symbol('OUTBOUND_PRECONDITION_PROVIDERS');

/** O que o Core conclui da porta, para a aprovação e para o despacho. */
export type VereditoDaPreCondicao =
  /** a origem é do Core (`conversation:`): não há porta a consultar */
  | { tipo: 'core' }
  | { tipo: 'vale'; contactId: string; valores: Record<string, string>; chaves: string[] }
  | { tipo: 'nao_vale' }
  /** erro, prazo ou resposta fora do contrato: nada sai agora, e tenta de novo */
  | { tipo: 'indisponivel' }
  /** o prefixo não tem porta: nada sai, nunca */
  | { tipo: 'desconhecida' };

/** A origem do Core: o Inbox. Nenhuma porta pode reivindicar este prefixo. */
export const PREFIXO_DO_CORE = 'conversation';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PREFIXO_RE = /^[a-z][a-z0-9_.-]{0,40}$/;
/** uma chave de validade é uma referência `prefixo:uuid`, como a origem */
const CHAVE_RE =
  /^[a-z][a-z0-9_.-]{0,40}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CHAVES_NO_MAXIMO = 10;
/**
 * Menor que o orçamento da reconferência da guarda (3 s): a porta lenta dá
 * "indisponível" pela porta, e não pelo prazo da guarda inteira.
 */
const PRAZO_DA_PORTA_MS = 2_000;

/** A origem `prefixo:uuid` em partes; fora do formato, `null`. */
export function partesDaOrigem(originRef: string): { prefixo: string; id: string } | null {
  const i = originRef.lastIndexOf(':');
  if (i <= 0) return null;
  const prefixo = originRef.slice(0, i);
  const id = originRef.slice(i + 1);
  return PREFIXO_RE.test(prefixo) && UUID_RE.test(id) ? { prefixo, id } : null;
}

function comPrazo<T>(promessa: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const prazo = new Promise<never>((_, rejeitar) => {
    timer = setTimeout(() => rejeitar(new Error('prazo da porta')), ms);
  });
  return Promise.race([promessa, prazo]).finally(() => clearTimeout(timer));
}

/**
 * Fachada do Core sobre as portas do E7. FALHA FECHADA em tudo que não for
 * resposta bem-formada. Sem cache. Sem nenhuma porta composta, só a origem do
 * Core é aceita.
 */
@Injectable()
export class OutboundPreconditionService {
  private readonly logger = new Logger(OutboundPreconditionService.name);
  private readonly porPrefixo = new Map<string, OutboundPreconditionProvider>();

  constructor(
    @Inject(OUTBOUND_PRECONDITION_PROVIDERS)
    providers: readonly OutboundPreconditionProvider[],
    // o contexto do pedido: a porta só roda no workspace dele (defesa em
    // profundidade). Obrigatório: sem ele, a defesa sumiria em silêncio
    private readonly cls: ClsService,
  ) {
    for (const porta of providers) {
      // o boot recusa a composição ambígua: roteamento é por prefixo, para UMA porta
      if (!PREFIXO_RE.test(porta.prefix) || porta.prefix === PREFIXO_DO_CORE) {
        throw new Error(`Prefixo de pré-condição inválido: ${porta.prefix}`);
      }
      if (this.porPrefixo.has(porta.prefix)) {
        throw new Error(`Prefixo de pré-condição repetido: ${porta.prefix}`);
      }
      this.porPrefixo.set(porta.prefix, porta);
    }
  }

  async consultar(workspaceId: string, originRef: string): Promise<VereditoDaPreCondicao> {
    const partes = partesDaOrigem(originRef);
    if (!partes) return { tipo: 'desconhecida' };
    if (partes.prefixo === PREFIXO_DO_CORE) return { tipo: 'core' };
    const porta = this.porPrefixo.get(partes.prefixo);
    if (!porta) return { tipo: 'desconhecida' };
    if (!UUID_RE.test(workspaceId)) return { tipo: 'indisponivel' };
    // o client filtrado da porta lê o workspace do CONTEXTO: outro que o explícito, nada roda
    if (this.cls.get<string>('workspaceId') !== workspaceId) {
      this.logger.error(`Pré-condição fora do contexto do workspace (${partes.prefixo})`);
      return { tipo: 'indisponivel' };
    }

    let resposta: OutboundPreconditionAnswer;
    try {
      resposta = await comPrazo(porta.check(workspaceId, partes.id), PRAZO_DA_PORTA_MS);
    } catch (erro) {
      // só o NOME do erro: a mensagem do Prisma traria ids e valores
      this.logger.error(
        `Pré-condição indisponível (${partes.prefixo}): ${
          erro instanceof Error ? erro.name : 'erro desconhecido'
        }`,
      );
      return { tipo: 'indisponivel' };
    }
    if (!resposta || typeof resposta !== 'object' || typeof resposta.valid !== 'boolean') {
      this.logger.error(`Pré-condição respondeu fora do contrato (${partes.prefixo})`);
      return { tipo: 'indisponivel' };
    }
    if (!resposta.valid) return { tipo: 'nao_vale' };
    const { contactId, values, validityKeys } = resposta;
    const valoresOk =
      values !== null &&
      typeof values === 'object' &&
      !Array.isArray(values) &&
      Object.values(values).every((v) => typeof v === 'string');
    const chavesOk =
      Array.isArray(validityKeys) &&
      validityKeys.length <= CHAVES_NO_MAXIMO &&
      validityKeys.every((k) => typeof k === 'string' && CHAVE_RE.test(k));
    if (!valoresOk || !chavesOk || typeof contactId !== 'string' || !UUID_RE.test(contactId)) {
      this.logger.error(`Pré-condição respondeu fora do contrato (${partes.prefixo})`);
      return { tipo: 'indisponivel' };
    }
    return {
      tipo: 'vale',
      contactId,
      // cópias: nada do que a porta devolveu é mutado aqui nem por quem chama
      valores: { ...values },
      chaves: [...new Set(validityKeys)].sort(),
    };
  }
}
