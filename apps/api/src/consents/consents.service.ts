import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  ConsentDto,
  ConsentOrigin,
  ConsentPurposeDto,
  ContactConsentsDto,
  ConversationConsentsDto,
  GrantConsentInput,
  StopBlockDto,
} from '@veyra/contracts';
import { AuditService } from '../audit/audit.service';
import { WhatsappSendService } from '../channels/whatsapp-send.service';
import { AuthContext } from '../common/decorators';
import { chaveDeCoincidencia, coincideExatamente, numerosExatos } from '../contacts/phone-identity';
import { TravasDeIdentidade } from '../content-use/identity-locks';
import { MudancasDeRestricao, type ExecutorDeTransacao } from '../content-use/restriction-changes';
import { ConversationsService } from '../conversations/conversations.service';
import { PrismaService, type Db } from '../prisma/prisma.service';
import { bloqueioAtivo, emitirRecibo } from './consent-records';

const MENSAGEM_SOB_BLOQUEIO =
  'Há um pedido de parar ativo para este número: o consentimento não pode ser registrado. Só a nova solicitação da pessoa retira o pedido.';
const MENSAGEM_NUMERO_NAO_EXATO =
  'O número não é, de forma exata, um telefone do cadastro do contato.';
const MENSAGEM_SEM_NUMERO = 'Esta conversa não tem número.';
const MENSAGEM_CANAL = 'O consentimento por número vale para um canal de WhatsApp do negócio.';
const MENSAGEM_JA_REVOGADO = 'Este consentimento já foi revogado.';
const MENSAGEM_OUTRA_ORIGEM =
  'Já existe um consentimento ativo para esta finalidade, registrado com outra origem.';
const MENSAGEM_SEM_PEDIDO = 'Não há pedido de parar ativo para este número.';
const MENSAGEM_CONJUNTO_MUDOU =
  'Os contatos com este número acabaram de mudar. Recarregue e tente de novo.';

/** O pedido de parar relê os contatos do número sob as travas; cresceu, tenta de novo. */
const TENTATIVAS_DO_CONJUNTO = 3;
const NUMERO_RE = /^\+\d{8,20}$/;

type ContatoDoNumero = { id: string; phones: string[]; phonesNormalized: string[] };

type ConsentRow = {
  id: string;
  contactId: string;
  channelId: string;
  number: string;
  purposeId: string;
  purposeDescription: string;
  origin: ConsentOrigin;
  receipt: string;
  grantedAt: Date;
  revokedAt: Date | null;
  revocationReason: ConsentDto['revocationReason'];
  purpose: { key: string; version: number };
};

type StopBlockRow = {
  id: string;
  number: string;
  origin: ConsentOrigin;
  receipt: string;
  createdAt: Date;
  liftedAt: Date | null;
  liftReceipt: string | null;
};

const CONSENT_INCLUDE = { purpose: { select: { key: true, version: true } } } as const;

/** Sem resultado, a transação do conjunto que cresceu volta para nova leitura. */
const CRESCEU = Symbol('CRESCEU');

/**
 * Finalidades, consentimentos e o pedido de parar (ADR-052 item 5, F4.1b).
 *
 * - O NÚMERO é sempre um número exato do contato, ou o endereço da conversa:
 *   nada por aproximação, nada digitado.
 * - Conceder, revogar, parar e desbloquear pegam os contatos e o `address:`
 *   do número, exclusivos, numa passada (`TravasDeIdentidade.paraNumero`) — o
 *   mesmo `address:` de quem tira o número do contato. Tudo é relido sob as
 *   travas.
 * - O pedido de parar vale para (workspace, número), em todos os canais (C16):
 *   revoga os consentimentos do número e cancela os despachos não iniciados.
 *   Desbloquear exige a nova solicitação da pessoa e não restaura nada (C15).
 * - A resposta depois do pedido ainda é PROPOSTA (item 4): até a decisão,
 *   nada sai sob bloqueio.
 */
@Injectable()
export class ConsentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly restricao: MudancasDeRestricao,
    private readonly travas: TravasDeIdentidade,
    private readonly send: WhatsappSendService,
    private readonly conversations: ConversationsService,
  ) {}

  private get executor(): ExecutorDeTransacao {
    return this.prisma.db as unknown as ExecutorDeTransacao;
  }

  async purposes(): Promise<ConsentPurposeDto[]> {
    const rows = await this.prisma.db.consentPurpose.findMany({
      orderBy: [{ key: 'asc' }, { version: 'asc' }],
    });
    return rows.map((row) => ({
      id: row.id,
      key: row.key,
      version: row.version,
      description: row.description,
      category: row.category,
      fields: row.fields,
    }));
  }

  async forContact(contactId: string): Promise<ContactConsentsDto> {
    const contato = await this.lerContato(this.prisma.db, contactId);
    const [consents, blocks] = await Promise.all([
      this.prisma.db.consent.findMany({
        where: { contactId },
        include: CONSENT_INCLUDE,
        orderBy: [{ grantedAt: 'desc' }, { id: 'asc' }],
      }),
      this.prisma.db.stopBlock.findMany({
        where: { number: { in: numerosExatos(contato) }, activeMark: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      }),
    ]);
    return {
      consents: (consents as unknown as ConsentRow[]).map((c) => this.toConsentDto(c)),
      stopBlocks: (blocks as unknown as StopBlockRow[]).map((b) => this.toBlockDto(b)),
    };
  }

  async forConversation(
    auth: AuthContext,
    conversationId: string,
  ): Promise<ConversationConsentsDto> {
    const alvo = await this.conversations.alvoDoConsentimento(auth, conversationId);
    const numero = alvo.externalAddress;
    if (!numero) return { number: null, stopBlock: null, consents: [] };
    const mascara = this.mascara(alvo.mostraNumero);
    const [block, consents] = await Promise.all([
      this.prisma.db.stopBlock.findFirst({ where: { number: numero, activeMark: true } }),
      // na RAI não há contato: nenhum consentimento é dela
      alvo.senderStatus === 'identified' && alvo.contactId
        ? this.prisma.db.consent.findMany({
            where: { contactId: alvo.contactId, number: numero },
            include: CONSENT_INCLUDE,
            orderBy: [{ grantedAt: 'desc' }, { id: 'asc' }],
          })
        : Promise.resolve([]),
    ]);
    return {
      number: mascara(numero),
      stopBlock: block ? this.toBlockDto(block as unknown as StopBlockRow, mascara) : null,
      consents: (consents as unknown as ConsentRow[]).map((c) => this.toConsentDto(c, mascara)),
    };
  }

  /**
   * Conceder: só contato identificado (a rota é a do contato), só um número
   * exato dele, num canal de WhatsApp do negócio, numa versão da finalidade.
   * Recusado sob bloqueio (409). Repetir o mesmo pedido devolve o MESMO
   * consentimento, com o mesmo recibo.
   */
  async grant(auth: AuthContext, contactId: string, input: GrantConsentInput): Promise<ConsentDto> {
    const workspaceId = auth.workspaceId as string;
    await this.lerContato(this.prisma.db, contactId);
    const id = await this.restricao.naTransacaoInterativa(this.executor, async (tx) => {
      await this.travas.paraNumero(tx, {
        workspaceId,
        contactIds: [contactId],
        numero: input.number,
      });
      const contato = await this.lerContato(tx, contactId);
      if (!numerosExatos(contato).includes(input.number)) {
        throw new BadRequestException(MENSAGEM_NUMERO_NAO_EXATO);
      }
      // relido sob o `address:` do número, que o pedido de parar também pega
      if (await bloqueioAtivo(tx, input.number)) throw new ConflictException(MENSAGEM_SOB_BLOQUEIO);
      const [purpose, channel] = await Promise.all([
        tx.consentPurpose.findFirst({
          where: { id: input.purposeId },
          select: { description: true },
        }),
        tx.channel.findFirst({ where: { id: input.channelId }, select: { type: true } }),
      ]);
      if (!purpose) throw new NotFoundException('Finalidade não encontrada');
      if (!channel) throw new NotFoundException('Canal não encontrado');
      if (channel.type !== 'whatsapp') throw new BadRequestException(MENSAGEM_CANAL);

      const existente = await tx.consent.findFirst({
        where: {
          contactId,
          channelId: input.channelId,
          number: input.number,
          purposeId: input.purposeId,
          activeMark: true,
        },
        select: { id: true, origin: true },
      });
      // a repetição do MESMO pedido é o mesmo registro; com outra origem, não
      // é repetição, e devolver o antigo esconderia que a origem nova não ficou
      if (existente) {
        if (existente.origin !== input.origin) throw new ConflictException(MENSAGEM_OUTRA_ORIGEM);
        return existente.id;
      }

      const receipt = await emitirRecibo(tx, 'CON');
      const criado = (await tx.consent.create({
        data: {
          contactId,
          channelId: input.channelId,
          number: input.number,
          purposeId: input.purposeId,
          origin: input.origin,
          receipt,
          purposeDescription: purpose.description,
          grantedByMembershipId: auth.membershipId as string,
        },
        select: { id: true },
      } as never)) as unknown as { id: string };
      await this.audit.record(tx, workspaceId, 'consent.granted', {
        entityType: 'consent',
        entityId: criado.id,
        actor: this.audit.actorFrom(auth),
        after: {
          contactId,
          channelId: input.channelId,
          purposeId: input.purposeId,
          origin: input.origin,
          receipt,
        },
      });
      return criado.id;
    });
    return this.consentDto(id);
  }

  /** Revogar, uma vez só, com a origem da manifestação da pessoa (`manual`). */
  async revoke(
    auth: AuthContext,
    contactId: string,
    consentId: string,
    origin: ConsentOrigin,
  ): Promise<ConsentDto> {
    const workspaceId = auth.workspaceId as string;
    const atual = await this.prisma.db.consent.findFirst({
      where: { id: consentId, contactId },
      select: { number: true },
    });
    if (!atual) throw new NotFoundException('Consentimento não encontrado');
    await this.restricao.naTransacaoInterativa(this.executor, async (tx) => {
      await this.travas.paraNumero(tx, {
        workspaceId,
        contactIds: [contactId],
        numero: atual.number,
      });
      const [revogado] = await tx.consent.updateManyAndReturn({
        where: { id: consentId, contactId, activeMark: true },
        data: {
          revokedByMembershipId: auth.membershipId,
          revocationReason: 'manual',
          revocationOrigin: origin,
          activeMark: null,
        },
        select: { receipt: true },
      });
      if (!revogado) {
        // a cascata da exclusão do contato pode ter levado a linha
        const ainda = await tx.consent.findFirst({
          where: { id: consentId },
          select: { id: true },
        });
        throw ainda
          ? new ConflictException(MENSAGEM_JA_REVOGADO)
          : new NotFoundException('Consentimento não encontrado');
      }
      await this.audit.record(tx, workspaceId, 'consent.revoked', {
        entityType: 'consent',
        entityId: consentId,
        actor: this.audit.actorFrom(auth),
        after: { receipt: revogado.receipt, revocationReason: 'manual', revocationOrigin: origin },
      });
    });
    return this.consentDto(consentId);
  }

  /** O pedido de parar pela rota do contato: um número exato dele. */
  async stopByContact(
    auth: AuthContext,
    contactId: string,
    numero: string,
    origin: ConsentOrigin,
  ): Promise<StopBlockDto> {
    await this.lerContato(this.prisma.db, contactId);
    const id = await this.registrarParar(auth, numero, origin, (tx) =>
      this.conferirNumeroDoContato(tx, contactId, numero),
    );
    return this.blockDto(id, this.mascara(true));
  }

  /**
   * O pedido de parar pela rota da conversa: o número é o endereço dela,
   * inclusive na RAI, sem atribuí-la a um contato. A visibilidade é a da
   * conversa (C13), e o número volta mascarado sem `contacts:read`.
   */
  async stopByConversation(
    auth: AuthContext,
    conversationId: string,
    origin: ConsentOrigin,
  ): Promise<StopBlockDto> {
    const alvo = await this.conversations.alvoDoConsentimento(auth, conversationId);
    const numero = this.numeroDaConversa(alvo.externalAddress);
    const id = await this.registrarParar(auth, numero, origin);
    return this.blockDto(id, this.mascara(alvo.mostraNumero));
  }

  async liftByContact(
    auth: AuthContext,
    contactId: string,
    numero: string,
    origin: ConsentOrigin,
  ): Promise<StopBlockDto> {
    await this.lerContato(this.prisma.db, contactId);
    const id = await this.desbloquear(auth, numero, origin, (tx) =>
      this.conferirNumeroDoContato(tx, contactId, numero),
    );
    return this.blockDto(id, this.mascara(true));
  }

  async liftByConversation(
    auth: AuthContext,
    conversationId: string,
    origin: ConsentOrigin,
  ): Promise<StopBlockDto> {
    const alvo = await this.conversations.alvoDoConsentimento(auth, conversationId);
    const numero = this.numeroDaConversa(alvo.externalAddress);
    const id = await this.desbloquear(auth, numero, origin);
    return this.blockDto(id, this.mascara(alvo.mostraNumero));
  }

  // ── Internos ──────────────────────────────────────────────────────────────

  /**
   * Registrar o pedido de parar, na transação com os contatos do número e o
   * `address:` dele exclusivos. Já existe um ativo: devolve o mesmo, com o
   * mesmo recibo. Senão, numa transação: o pedido, a revogação de todo
   * consentimento ativo do número no workspace (`stop_requested`), o
   * cancelamento dos despachos não iniciados e a trilha — sem o número.
   */
  private async registrarParar(
    auth: AuthContext,
    numero: string,
    origin: ConsentOrigin,
    conferir?: (tx: Db) => Promise<void>,
  ): Promise<string> {
    const workspaceId = auth.workspaceId as string;
    return this.naTransacaoDoNumero(workspaceId, numero, async (tx) => {
      if (conferir) await conferir(tx);
      const ativo = await bloqueioAtivo(tx, numero);
      if (ativo) return ativo.id;

      const receipt = await emitirRecibo(tx, 'PAR');
      const bloqueio = (await tx.stopBlock.create({
        data: {
          number: numero,
          origin,
          receipt,
          createdByMembershipId: auth.membershipId as string,
        },
        select: { id: true },
      } as never)) as unknown as { id: string };
      const revogados = await tx.consent.updateManyAndReturn({
        where: { number: numero, activeMark: true },
        data: {
          revokedByMembershipId: auth.membershipId,
          revocationReason: 'stop_requested',
          activeMark: null,
        },
        select: { id: true, receipt: true },
      });
      for (const consentimento of revogados) {
        await this.audit.record(tx, workspaceId, 'consent.revoked', {
          entityType: 'consent',
          entityId: consentimento.id,
          actor: this.audit.actorFrom(auth),
          after: { receipt: consentimento.receipt, revocationReason: 'stop_requested' },
        });
      }
      const despachos = await this.send.cancelarNaoIniciadosDoNumero(tx, workspaceId, numero);
      await this.audit.record(tx, workspaceId, 'stop.registered', {
        entityType: 'stopBlock',
        entityId: bloqueio.id,
        actor: this.audit.actorFrom(auth),
        after: {
          receipt,
          origin,
          consentsRevoked: revogados.length,
          dispatchesCanceled: despachos.cancelados,
          // com o marcador de despacho: não volta, e a trilha diz isso. Conta
          // também o da IA à espera da guarda, que ainda reconfere e recusa:
          // "pode ter saído", nunca menos do que saiu
          dispatchesInFlight: despachos.emVoo,
        },
      });
      return bloqueio.id;
    });
  }

  /**
   * Desbloquear: a NOVA solicitação da pessoa, com a origem e o recibo `DES-`.
   * Sem pedido ativo, 409. Nenhum consentimento anterior volta (C15).
   */
  private async desbloquear(
    auth: AuthContext,
    numero: string,
    origin: ConsentOrigin,
    conferir?: (tx: Db) => Promise<void>,
  ): Promise<string> {
    const workspaceId = auth.workspaceId as string;
    return this.naTransacaoDoNumero(workspaceId, numero, async (tx) => {
      if (conferir) await conferir(tx);
      const ativo = await tx.stopBlock.findFirst({
        where: { number: numero, activeMark: true },
        select: { id: true, receipt: true },
      });
      if (!ativo) throw new ConflictException(MENSAGEM_SEM_PEDIDO);
      const liftReceipt = await emitirRecibo(tx, 'DES');
      await tx.stopBlock.updateMany({
        where: { id: ativo.id, activeMark: true },
        data: {
          liftedByMembershipId: auth.membershipId,
          liftOrigin: origin,
          liftReceipt,
          activeMark: null,
        },
      });
      await this.audit.record(tx, workspaceId, 'stop.lifted', {
        entityType: 'stopBlock',
        entityId: ativo.id,
        actor: this.audit.actorFrom(auth),
        after: { receipt: ativo.receipt, liftOrigin: origin, liftReceipt },
      });
      return ativo.id;
    });
  }

  /**
   * A transação com TODOS os contatos que têm o número de forma exata, e o
   * `address:` dele, exclusivos. O conjunto é lido antes das travas e relido
   * sob elas: se cresceu (um contato ganhou o número no meio), nada é feito e
   * a leitura recomeça, até o limite — depois, 409.
   */
  private async naTransacaoDoNumero<T>(
    workspaceId: string,
    numero: string,
    fn: (tx: Db) => Promise<T>,
  ): Promise<T> {
    for (let tentativa = 1; ; tentativa++) {
      const lidos = await this.contatosDoNumero(this.prisma.db, numero);
      const resultado = await this.restricao.naTransacaoInterativa(this.executor, async (tx) => {
        await this.travas.paraNumero(tx, { workspaceId, contactIds: lidos, numero });
        const relidos = await this.contatosDoNumero(tx, numero);
        if (relidos.some((id) => !lidos.includes(id))) return CRESCEU;
        return { valor: await fn(tx) };
      });
      if (resultado !== CRESCEU) return resultado.valor;
      if (tentativa >= TENTATIVAS_DO_CONJUNTO) throw new ConflictException(MENSAGEM_CONJUNTO_MUDOU);
    }
  }

  /** Os contatos com o número de forma exata: os candidatos pela chave, conferidos. */
  private async contatosDoNumero(db: Db, numero: string): Promise<string[]> {
    const chave = chaveDeCoincidencia(numero);
    if (!chave) return [];
    const candidatos = (await db.contact.findMany({
      where: { phoneMatchKeys: { has: chave } },
      select: { id: true, phones: true, phonesNormalized: true },
    })) as unknown as ContatoDoNumero[];
    return candidatos
      .filter((contato) => coincideExatamente(numero, contato))
      .map((contato) => contato.id)
      .sort();
  }

  private async conferirNumeroDoContato(tx: Db, contactId: string, numero: string): Promise<void> {
    const contato = await this.lerContato(tx, contactId);
    if (!numerosExatos(contato).includes(numero)) {
      throw new BadRequestException(MENSAGEM_NUMERO_NAO_EXATO);
    }
  }

  private async lerContato(db: Db, contactId: string): Promise<ContatoDoNumero> {
    const contato = (await db.contact.findFirst({
      where: { id: contactId },
      select: { id: true, phones: true, phonesNormalized: true },
    })) as unknown as ContatoDoNumero | null;
    if (!contato) throw new NotFoundException('Contato não encontrado');
    return contato;
  }

  private numeroDaConversa(endereco: string | null): string {
    if (!endereco || !NUMERO_RE.test(endereco)) throw new BadRequestException(MENSAGEM_SEM_NUMERO);
    return endereco;
  }

  private mascara(mostraNumero: boolean): (numero: string) => string {
    return (numero) => (mostraNumero ? numero : `•••• ${numero.slice(-4)}`);
  }

  private async consentDto(id: string): Promise<ConsentDto> {
    const row = await this.prisma.db.consent.findFirst({ where: { id }, include: CONSENT_INCLUDE });
    if (!row) throw new NotFoundException('Consentimento não encontrado');
    return this.toConsentDto(row as unknown as ConsentRow);
  }

  private async blockDto(id: string, mascara: (numero: string) => string): Promise<StopBlockDto> {
    const row = await this.prisma.db.stopBlock.findFirst({ where: { id } });
    if (!row) throw new NotFoundException('Pedido de parar não encontrado');
    return this.toBlockDto(row as unknown as StopBlockRow, mascara);
  }

  private toConsentDto(
    row: ConsentRow,
    mascara: (numero: string) => string = (n) => n,
  ): ConsentDto {
    return {
      id: row.id,
      contactId: row.contactId,
      channelId: row.channelId,
      number: mascara(row.number),
      purposeId: row.purposeId,
      purposeKey: row.purpose.key,
      purposeVersion: row.purpose.version,
      purposeDescription: row.purposeDescription,
      origin: row.origin,
      receipt: row.receipt,
      grantedAt: row.grantedAt.toISOString(),
      revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
      revocationReason: row.revocationReason,
    };
  }

  private toBlockDto(
    row: StopBlockRow,
    mascara: (numero: string) => string = (n) => n,
  ): StopBlockDto {
    return {
      id: row.id,
      number: mascara(row.number),
      origin: row.origin,
      receipt: row.receipt,
      createdAt: row.createdAt.toISOString(),
      liftedAt: row.liftedAt ? row.liftedAt.toISOString() : null,
      liftReceipt: row.liftReceipt,
    };
  }
}
