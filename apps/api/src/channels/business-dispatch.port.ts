import { Injectable } from '@nestjs/common';
import type { Db } from '../prisma/prisma.service';
import type { ParametrosDoTemplate } from './meta.transport';

/**
 * A PORTA do despacho do envio iniciado pelo negócio (`business_outbound`,
 * ADR-052 item 7, F4.1c-3). O worker de envio é dono da máquina de estados do
 * despacho — claim, quota, marcador, guarda e desfecho —, e não conhece
 * templates, consentimentos nem a aprovação: pergunta a este verificador, que
 * o módulo do envio do negócio registra no boot (`templates` importa
 * `channels`, e o contrário seria ciclo).
 *
 * Sem verificador registrado, nenhum despacho com aprovação sai.
 */

/**
 * O prazo ABSOLUTO da releitura do template na Meta (F4.1c-3), na aprovação e
 * no despacho: o `call` só tem o de ociosidade, e uma listagem de cinco
 * páginas lentas prenderia a aprovação e o lote.
 */
export const PRAZO_DA_RELEITURA_MS = 10_000;

/** O passo 2, FORA das travas: a releitura do template na Meta e o prazo. */
export type AntesDasTravas =
  | {
      tipo: 'segue';
      contactId: string;
      /** o número exato: o `address:` dele entra nas travas da guarda */
      numero: string;
      /** as chaves de validade do E7, fixadas na aprovação */
      validityKeys: readonly string[];
    }
  | {
      tipo: 'recusa';
      /** `failed_before_send` volta pelo outbox, e a nova tentativa relê */
      estado: 'failed_permanent' | 'failed_before_send';
      errorCode: string;
    };

/** O passo 4, SOB as travas da guarda, com leituras novas. */
export type ReconferenciaDoNegocio =
  | {
      tipo: 'liberado';
      envio: {
        /**
         * a credencial lida SOB as travas, a mesma cujo `phoneNumberId` entrou
         * no hash recalculado: o envio sai por ela, nunca por uma lida antes
         */
        credencial: { phoneNumberId: string; tokenCipher: string };
        to: string;
        template: { name: string; language: string };
        params: ParametrosDoTemplate;
      };
    }
  /** comprovadamente não enviado, de vez: `failed_permanent` com o motivo */
  | { tipo: 'recusa'; errorCode: string }
  /** a pré-condição do vertical não respondeu: `failed_before_send`, e tenta de novo */
  | { tipo: 'indisponivel'; errorCode: string };

export interface VerificadorDoEnvioDoNegocio {
  antesDasTravas(
    workspaceId: string,
    messageId: string,
    signal: AbortSignal,
  ): Promise<AntesDasTravas>;
  /** na transação da guarda, já com as travas */
  reconferir(tx: Db, workspaceId: string, messageId: string): Promise<ReconferenciaDoNegocio>;
}

@Injectable()
export class PortaDoEnvioDoNegocio {
  private registrado: VerificadorDoEnvioDoNegocio | null = null;

  registrar(verificador: VerificadorDoEnvioDoNegocio): void {
    // dois verificadores é engano de composição: recusa, como as origens dos usos
    if (this.registrado) throw new Error('Verificador do envio do negócio duplicado.');
    this.registrado = verificador;
  }

  get verificador(): VerificadorDoEnvioDoNegocio | null {
    return this.registrado;
  }
}
