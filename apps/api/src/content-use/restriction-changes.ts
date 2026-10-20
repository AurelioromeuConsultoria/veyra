import { ConflictException, Inject, Injectable } from '@nestjs/common';
import type { Db } from '../prisma/prisma.service';
import { UsosOrfaos } from './content-use.orphans';
import { CONFIG_DA_GUARDA, type ConfigDaGuarda } from './content-use.pools';
import {
  prazoDeTrava,
  travarParaMudanca,
  travarParaUso,
  travarWorkspaceInteiro,
  type EscopoDeTravas,
} from './restriction-locks';

/** O prazo da transação do chamador: cobre a espera das travas e o que vem depois. */
export interface OpcoesDaTransacao {
  timeout: number;
}

/** O client (protegido) que abre a transação interativa do chamador. */
export interface ExecutorDeTransacao {
  $transaction<T>(fn: (tx: Db) => Promise<T>, options?: OpcoesDaTransacao): Promise<T>;
}

/** A mesma resposta do 55P03 (filtro global): esperou demais, nada mudou. */
const MENSAGEM_DE_ESPERA = 'Uso em andamento para este contato; tente de novo em instantes.';

/**
 * As MUDANÇAS de restrição e as APROVAÇÕES (ADR-047 adendo 6 §6; adendo 7 §3.3
 * e §8). Fora da guarda, é o único caminho para as travas de restrição — e a
 * marcação dos usos órfãos mora AQUI, na mesma transação das travas: uma
 * mudança de vertical nunca toca run, despacho ou reserva.
 *
 * Toda operação vem no começo da transação do chamador, antes de qualquer
 * linha (nível 4 da ordem global), e fixa o próprio `lock_timeout` — que vale
 * POR TRAVA. A transação interativa (`naTransacaoInterativa`) tem o prazo do
 * adendo 6 §4; estourar qualquer um dos dois é 409, sem efeito: o 55P03 pelo
 * filtro global, o prazo da transação (P2028) aqui. Uma troca de tarefa pode
 * esperar seis travas, e a soma passaria do prazo da transação.
 */
@Injectable()
export class MudancasDeRestricao {
  constructor(
    private readonly orfaos: UsosOrfaos,
    @Inject(CONFIG_DA_GUARDA) private readonly config: ConfigDaGuarda,
  ) {}

  /**
   * A transação de uma mudança interativa por contato ou de uma aprovação:
   * 10 s de espera por trava, 30 s de transação. O prazo da transação vencido
   * (P2028) volta como 409, como a espera de trava — a transação inteira foi
   * desfeita.
   */
  async naTransacaoInterativa<T>(db: ExecutorDeTransacao, fn: (tx: Db) => Promise<T>): Promise<T> {
    try {
      return await db.$transaction(fn, { timeout: this.config.mudancaTransacaoMs });
    } catch (erro) {
      if ((erro as { code?: unknown } | null)?.code === 'P2028') {
        throw new ConflictException(MENSAGEM_DE_ESPERA);
      }
      throw erro;
    }
  }

  /** Ativar e desativar (CLI): 90 s de espera, 120 s de transação. */
  get transacaoDoWorkspace(): OpcoesDaTransacao {
    return { timeout: this.config.workspaceTransacaoMs };
  }

  /**
   * Mudança por contato ou de titularidade (paciente, liberação, exclusão de
   * contato, troca de contato de deal ou tarefa): workspace compartilhada,
   * contatos e entidades exclusivos. Com elas, todo uso ainda `authorized`
   * desses contatos ou entidades é órfão — uma guarda viva seguraria a trava
   * compartilhada — e é marcado `in_doubt` aqui. Devolve quantos marcou.
   */
  async porContato(tx: Db, escopo: EscopoDeTravas): Promise<number> {
    await prazoDeTrava(tx, this.config.mudancaTravaMs);
    await travarParaMudanca(tx, escopo);
    return this.orfaos.marcarOrfaosDaMudanca(tx, {
      workspaceId: escopo.workspaceId,
      contactIds: (escopo.contactIds ?? []).filter((id): id is string => typeof id === 'string'),
      entityKeys: escopo.entityKeys ?? [],
    });
  }

  /**
   * Mudança do workspace inteiro (ativar e desativar um vertical): a trava do
   * workspace exclusiva; todo uso `authorized` do workspace é órfão.
   */
  async doWorkspaceInteiro(tx: Db, workspaceId: string): Promise<number> {
    await prazoDeTrava(tx, this.config.workspaceTravaMs);
    await travarWorkspaceInteiro(tx, workspaceId);
    return this.orfaos.marcarOrfaosDoWorkspace(tx, workspaceId);
  }

  /**
   * Aprovação de proposta da IA: as travas COMPARTILHADAS, como um uso. A
   * reconferência da porta vem depois, sob elas — uma mudança que comitou
   * enquanto a aprovação esperava é vista, e a aprovação recusa.
   */
  async paraAprovacao(tx: Db, escopo: EscopoDeTravas): Promise<void> {
    await prazoDeTrava(tx, this.config.mudancaTravaMs);
    await travarParaUso(tx, escopo);
  }
}
