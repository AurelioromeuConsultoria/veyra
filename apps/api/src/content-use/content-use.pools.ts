import { Inject, Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { ClsService } from 'nestjs-cls';
import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { CORE_REGISTRY, EXTENSION_REGISTRY, type ComposedRegistry } from '../extensions/registry';
import { PrismaClient } from '../generated/prisma/client';
import { comOpcoesDeSessao } from '../prisma/prisma-adapter';
import { createWorkspaceClient, type Db } from '../prisma/prisma.service';

/**
 * Prazos e tamanhos da guarda de uso externo (ADR-047 adendo 6 §4 e adendo 7
 * §3.1). Os testes injetam valores pequenos; a produção usa os padrões.
 */
export interface ConfigDaGuarda {
  /** sessões de guarda simultâneas por instância (adendo 6 §8) */
  tamanhoDoPoolDaGuarda: number;
  /** conexões curtas do registro (adendo 7 §3.1) */
  tamanhoDoPoolDeRegistro: number;
  /** espera por uma sessão de guarda com o pool cheio (`maxWait`) */
  esperaPorSessaoMs: number;
  /** espera pela conexão de registro */
  registroConexaoMs: number;
  /** `statement_timeout` do registro */
  registroInstrucaoMs: number;
  /** `lock_timeout` de CADA trava de uso */
  travaMs: number;
  /** prazo da reconferência da porta, sob as travas */
  reconferenciaMs: number;
  /** `lock_timeout` de cada candidato da reconciliação (a linha presa por M) */
  reconciliacaoMs: number;
  /** mudança interativa por contato e aprovação: espera pelas travas (adendo 6 §4) */
  mudancaTravaMs: number;
  /** ... e o prazo da transação dela */
  mudancaTransacaoMs: number;
  /** ativar e desativar (CLI): espera pela trava do workspace */
  workspaceTravaMs: number;
  /** ... e o prazo da transação */
  workspaceTransacaoMs: number;
  /** prazos ABSOLUTOS dos usos (adendo 6 §4, aprovados): IA, envio Meta, webhook por destino */
  prazoDaIaMs: number;
  prazoDaMetaMs: number;
  prazoDoWebhookMs: number;
  /** `statement_timeout` da persistência */
  persistenciaMs: number;
  /** margem do `idle_in_transaction_session_timeout` sobre o prazo do tipo */
  margemOciosaMs: number;
  /** margem do `deadlineAt` sobre o prazo do tipo (só filtro da varredura) */
  margemDoPrazoMs: number;
  /** folga da transação interativa sobre a soma dos prazos internos */
  folgaDaTransacaoMs: number;
}

export const CONFIG_DA_GUARDA = Symbol('CONFIG_DA_GUARDA');

export const CONFIG_PADRAO_DA_GUARDA: ConfigDaGuarda = {
  tamanhoDoPoolDaGuarda: 5,
  tamanhoDoPoolDeRegistro: 5,
  esperaPorSessaoMs: 5_000,
  registroConexaoMs: 2_000,
  registroInstrucaoMs: 2_000,
  travaMs: 5_000,
  reconferenciaMs: 3_000,
  reconciliacaoMs: 5_000,
  mudancaTravaMs: 10_000,
  mudancaTransacaoMs: 30_000,
  workspaceTravaMs: 90_000,
  workspaceTransacaoMs: 120_000,
  prazoDaIaMs: 60_000,
  prazoDaMetaMs: 20_000,
  prazoDoWebhookMs: 10_000,
  persistenciaMs: 5_000,
  margemOciosaMs: 30_000,
  margemDoPrazoMs: 30_000,
  folgaDaTransacaoMs: 5_000,
};

/** Quem registrou o uso: a opção 3 do adendo 7 precisaria provar que ele reiniciou. */
export const ID_DA_INSTANCIA = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

/**
 * Os dois pools da guarda (ADR-047 adendo 7 §3.1), separados do pool do Prisma:
 *
 * - **guarda:** a sessão que segura as travas durante a chamada externa. É um
 *   segundo PrismaClient, com o MESMO filtro de tenant do `prisma.db`, para a
 *   persistência do resultado acontecer DENTRO da transação da guarda.
 *   Keepalive curto: um host sumido não segura uma mudança de restrição por 2 h.
 * - **registro:** conexões curtas, que não seguram trava nenhuma; cada uma faz
 *   uma transação comitada (`synchronous_commit = on`) e volta. Esperar este
 *   pool segurando as travas da guarda não gera espera circular.
 */
@Injectable()
export class PoolsDaGuarda implements OnModuleDestroy {
  private readonly logger = new Logger(PoolsDaGuarda.name);
  private readonly poolDaGuarda: Pool;
  /** sem filtro de tenant: só existe para o filtrado abaixo; nunca exposto */
  private readonly guardaRaw: PrismaClient;
  /** o client da guarda, filtrado por tenant como o `prisma.db` — o único exposto */
  readonly guarda: Db;
  /** SQL próprio com `workspaceId` explícito (exceção do adendo 7 §3.8); privado */
  private readonly registro: Pool;
  readonly config: ConfigDaGuarda;

  constructor(
    cls: ClsService,
    @Optional() @Inject(EXTENSION_REGISTRY) registry: ComposedRegistry = CORE_REGISTRY,
    @Inject(CONFIG_DA_GUARDA) config: ConfigDaGuarda,
  ) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL ausente — os pools da guarda não podem iniciar.');
    this.config = config;
    this.poolDaGuarda = new Pool({
      connectionString: comOpcoesDeSessao(url, [
        '-c tcp_keepalives_idle=10',
        '-c tcp_keepalives_interval=5',
        '-c tcp_keepalives_count=3',
        '-c tcp_user_timeout=30000',
      ]),
      max: config.tamanhoDoPoolDaGuarda,
      connectionTimeoutMillis: config.esperaPorSessaoMs,
      application_name: 'veyra-guard',
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
    });
    // uma sessão derrubada pelo servidor (prazo ocioso, término) não pode
    // derrubar o processo: vira perda da guarda, tratada pelos detectores
    this.poolDaGuarda.on('error', (erro) => this.avisar('guarda', erro));
    this.guardaRaw = new PrismaClient({
      adapter: new PrismaPg(this.poolDaGuarda, {
        onPoolError: (erro) => this.avisar('guarda', erro),
      }),
    });
    this.guarda = createWorkspaceClient(this.guardaRaw, () => cls.get('workspaceId'), registry);
    this.registro = new Pool({
      connectionString: comOpcoesDeSessao(url, [
        '-c synchronous_commit=on',
        `-c statement_timeout=${config.registroInstrucaoMs}`,
        // uma transação de registro abandonada (partição) não segura a linha
        // nem a vaga: o servidor a derruba sozinho
        `-c idle_in_transaction_session_timeout=${2 * config.registroInstrucaoMs}`,
        '-c tcp_keepalives_idle=10',
        '-c tcp_keepalives_interval=5',
        '-c tcp_keepalives_count=3',
        '-c tcp_user_timeout=30000',
      ]),
      max: config.tamanhoDoPoolDeRegistro,
      connectionTimeoutMillis: config.registroConexaoMs,
      application_name: 'veyra-content-use-registro',
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
    });
    this.registro.on('error', (erro) => this.avisar('registro', erro));
  }

  /** Uma conexão curta do registro (passo 5 e transição do passo 6). */
  conectarRegistro(): Promise<PoolClient> {
    return this.registro.connect();
  }

  private avisar(pool: string, erro: Error): void {
    // só o nome e o código: a mensagem do pg pode carregar dados da conexão
    const codigo = (erro as { code?: string }).code ?? 'sem código';
    this.logger.warn(`Conexão do pool de ${pool} caiu (${erro.name}, ${codigo})`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.guardaRaw.$disconnect().catch(() => undefined);
    await this.poolDaGuarda.end().catch(() => undefined);
    await this.registro.end().catch(() => undefined);
  }
}
