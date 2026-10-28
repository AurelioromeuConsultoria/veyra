import { Inject, Injectable, Logger } from '@nestjs/common';
import { CAMPOS_DO_CORE } from '@veyra/contracts';
import { ClsService } from 'nestjs-cls';
import type { Db } from '../prisma/prisma.service';

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
 * - lê pelo LEITOR que recebe, nunca por um cliente próprio (F4.2): na
 *   aprovação, é a transação de quem chama, e uma segunda conexão do pool
 *   principal por aprovação travaria o pool numa rajada;
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
  | {
      valid: true;
      contactId: string;
      values: Record<string, string>;
      validityKeys: string[];
      /**
       * O LIMITE do prazo da aprovação, pela regra da origem (F4.2): a
       * confirmação até o início menos duas horas, por exemplo. O Core usa o
       * menor entre ele e o teto dele, e nunca o prorroga.
       */
      expiresAt: Date;
    }
  | { valid: false };

/**
 * O que a porta pode usar do cliente de quem chama: só as leituras dos
 * modelos — sem `$transaction`, sem SQL cru, sem escrita. Defesa em
 * profundidade no tipo; o contrato é o comentário acima.
 */
type MetodoDeLeitura = 'findFirst' | 'findMany' | 'count';
export type LeitorDaPreCondicao = {
  readonly [
    K in keyof Db as Db[K] extends { findFirst: unknown; findMany: unknown } ? K : never
  ]: Pick<Db[K], Extract<keyof Db[K], MetodoDeLeitura>>;
};

/** Porta implementada pelo vertical. */
export interface OutboundPreconditionProvider {
  /** o prefixo da origem que ela responde (`<extensão>.<pedido>`), único */
  readonly prefix: string;
  /**
   * As permissões do vertical que a prévia e a aprovação desta origem exigem,
   * além das do Core (F4.2). Registradas no servidor, nunca vindas do cliente:
   * o Core as confere ANTES de consultar a origem ou devolver conteúdo.
   */
  readonly requiredPermissions: readonly string[];
  /**
   * Os campos do vertical que a porta fornece (F4.2): `<extensão>.<campo>`, na
   * extensão do prefixo. É o catálogo fechado que um parâmetro de template
   * pode usar além dos campos do Core, registrado no servidor; os valores que
   * a porta devolve são só destes campos.
   */
  readonly fields: readonly string[];
  /**
   * As finalidades (pela chave, `<extensão>_<nome>`) que são DESTA origem
   * (F4.2): o Core as recusa em qualquer outra origem — inclusive a do Inbox —
   * e as tira das opções do compositor. Sem isso, o template revisado para a
   * finalidade do vertical sairia pela conversa sem as regras dele.
   */
  readonly purposeKeys: readonly string[];
  /**
   * O pedido `originId` (a parte depois do prefixo) ainda vale, no workspace
   * EXPLÍCITO? Os valores são os dos campos do vertical que a finalidade
   * permite, e só eles. Lê só por `leitor`.
   */
  check(
    leitor: LeitorDaPreCondicao,
    workspaceId: string,
    originId: string,
  ): Promise<OutboundPreconditionAnswer>;
}

export const OUTBOUND_PRECONDITION_PROVIDERS = Symbol('OUTBOUND_PRECONDITION_PROVIDERS');

/** O que o Core conclui da porta, para a aprovação e para o despacho. */
export type VereditoDaPreCondicao =
  /** a origem é do Core (`conversation:`): não há porta a consultar */
  | { tipo: 'core' }
  | {
      tipo: 'vale';
      contactId: string;
      valores: Record<string, string>;
      chaves: string[];
      /** o limite do prazo pela regra da origem */
      limite: Date;
    }
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
/** uma permissão do vertical: `<extensão>:<recurso>:<ação>` */
const PERMISSAO_RE = /^[a-z][a-z0-9]*(:[a-z][a-z0-9_]*)+$/;
/** a chave de uma finalidade do vertical: `<extensão>_<nome>` */
const FINALIDADE_RE = /^[a-z][a-z0-9]*_[a-z0-9_]{1,50}$/;
/** um campo do vertical: `<extensão>.<campo>`, no formato dos campos da finalidade */
const CAMPO_RE = /^[a-z][a-z0-9]*\.[a-z][a-zA-Z0-9_]{0,50}$/;
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
  private readonly campos = new Set<string>();
  /** a finalidade do vertical → o prefixo da origem dona dela */
  private readonly donoDa = new Map<string, string>();

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
      // a porta sem permissão própria abriria a origem a qualquer um do Core
      const permissoes = porta.requiredPermissions;
      if (
        !Array.isArray(permissoes) ||
        permissoes.length === 0 ||
        !permissoes.every((p) => typeof p === 'string' && PERMISSAO_RE.test(p))
      ) {
        throw new Error(`Permissões de pré-condição inválidas: ${porta.prefix}`);
      }
      // os campos são da extensão do prefixo, e nenhum é de outra porta nem do Core
      const extensao = porta.prefix.split('.')[0];
      const campos = porta.fields;
      if (
        extensao === 'contato' ||
        !Array.isArray(campos) ||
        !campos.every(
          (c) =>
            typeof c === 'string' &&
            CAMPO_RE.test(c) &&
            c.startsWith(`${extensao}.`) &&
            !(CAMPOS_DO_CORE as readonly string[]).includes(c) &&
            !this.campos.has(c),
        ) ||
        new Set(campos).size !== campos.length
      ) {
        throw new Error(`Campos de pré-condição inválidos: ${porta.prefix}`);
      }
      // as finalidades também: da extensão, e de UMA porta só
      const finalidades = porta.purposeKeys;
      if (
        !Array.isArray(finalidades) ||
        !finalidades.every(
          (f) =>
            typeof f === 'string' &&
            FINALIDADE_RE.test(f) &&
            f.startsWith(`${extensao}_`) &&
            !this.donoDa.has(f),
        ) ||
        new Set(finalidades).size !== finalidades.length
      ) {
        throw new Error(`Finalidades de pré-condição inválidas: ${porta.prefix}`);
      }
      for (const campo of campos) this.campos.add(campo);
      for (const finalidade of finalidades) this.donoDa.set(finalidade, porta.prefix);
      this.porPrefixo.set(porta.prefix, porta);
    }
  }

  /**
   * As permissões do vertical que a origem exige, pela porta registrada; a
   * origem do Core, `[]`; a origem sem porta (ou malformada), `null` — quem
   * chama a recusa como inexistente.
   */
  permissoesDaOrigem(originRef: string): readonly string[] | null {
    const partes = partesDaOrigem(originRef);
    if (!partes) return null;
    if (partes.prefixo === PREFIXO_DO_CORE) return [];
    return this.porPrefixo.get(partes.prefixo)?.requiredPermissions ?? null;
  }

  /** Os campos que as portas registradas fornecem: os de vertical que um template pode usar. */
  camposDasPortas(): readonly string[] {
    return [...this.campos].sort();
  }

  /**
   * A finalidade pode ser usada por esta origem? A finalidade declarada por
   * uma porta, só pela origem dela; a que nenhuma porta declara, por qualquer
   * uma (a do vertical que a aceita é decisão dele).
   */
  finalidadeDaOrigem(purposeKey: string, originRef: string): boolean {
    const dono = this.donoDa.get(purposeKey);
    return dono === undefined || dono === partesDaOrigem(originRef)?.prefixo;
  }

  /** As finalidades declaradas pelas portas: fora das opções do compositor do Inbox. */
  finalidadesDasPortas(): readonly string[] {
    return [...this.donoDa.keys()].sort();
  }

  /**
   * `leitor` é o cliente de quem chama: o filtrado, na prévia; a transação, na
   * aprovação e no despacho. A porta lê por ele, e não abre outra conexão.
   */
  async consultar(
    leitor: LeitorDaPreCondicao,
    workspaceId: string,
    originRef: string,
  ): Promise<VereditoDaPreCondicao> {
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
      resposta = await comPrazo(porta.check(leitor, workspaceId, partes.id), PRAZO_DA_PORTA_MS);
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
    const { contactId, values, validityKeys, expiresAt } = resposta;
    const valoresOk =
      values !== null &&
      typeof values === 'object' &&
      !Array.isArray(values) &&
      Object.entries(values).every(
        ([campo, v]) => typeof v === 'string' && porta.fields.includes(campo),
      );
    const chavesOk =
      Array.isArray(validityKeys) &&
      validityKeys.length <= CHAVES_NO_MAXIMO &&
      validityKeys.every((k) => typeof k === 'string' && CHAVE_RE.test(k));
    const limiteOk = expiresAt instanceof Date && !Number.isNaN(expiresAt.getTime());
    if (
      !valoresOk ||
      !chavesOk ||
      !limiteOk ||
      typeof contactId !== 'string' ||
      !UUID_RE.test(contactId)
    ) {
      this.logger.error(`Pré-condição respondeu fora do contrato (${partes.prefixo})`);
      return { tipo: 'indisponivel' };
    }
    return {
      tipo: 'vale',
      contactId,
      // cópias: nada do que a porta devolveu é mutado aqui nem por quem chama
      valores: { ...values },
      chaves: [...new Set(validityKeys)].sort(),
      limite: new Date(expiresAt.getTime()),
    };
  }
}
