import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  ContactDto,
  CreateContactInput,
  ImportContactsInput,
  ListContactsInput,
  Paginated,
  UpdateContactInput,
} from '@veyra/contracts';
import { ClsService } from 'nestjs-cls';
import { ActivitiesService } from '../activities/activities.service';
import { UsageService } from '../usage/usage.service';
import { AuditService } from '../audit/audit.service';
import { OutboxService } from '../outbox/outbox.service';
import { AuthContext } from '../common/decorators';
import { TravasDeIdentidade } from '../content-use/identity-locks';
import { MudancasDeRestricao, type OpcoesDaTransacao } from '../content-use/restriction-changes';
import { CustomFieldsService } from '../custom-fields/custom-fields.service';
import { FilesService } from '../files/files.service';
import { PrismaService, type Db } from '../prisma/prisma.service';
import { TagsService } from '../tags/tags.service';
import { revogarNumerosQueSairam } from '../consents/consent-records';
import {
  chavesQueMudam,
  coincidenciaEstrita,
  derivadosDosTelefones,
  mesmosTelefones,
  numerosExatos,
} from './phone-identity';

/**
 * Um contato mudou de telefone entre a leitura e a trava: os telefones relidos
 * não são os lidos antes, de onde saíram as travas. Seguir mexeria num número
 * sem a trava dele.
 */
const MENSAGEM_TELEFONE_MUDOU =
  'Os telefones deste contato acabaram de mudar. Recarregue e tente de novo.';

type ContactRow = {
  id: string;
  name: string;
  emails: string[];
  phones: string[];
  status: 'active' | 'archived';
  companyId: string | null;
  ownerMembershipId: string | null;
  source: string | null;
  createdAt: Date;
  updatedAt: Date;
  company: { name: string } | null;
  tags: { tag: { id: string; name: string; color: string } }[];
};

const CONTACT_INCLUDE = {
  company: true, // protegido→protegido: permitido (FK composta)
  tags: { include: { tag: true } },
} as const;

type TxRunner = {
  $transaction: <T>(fn: (tx: Db) => Promise<T>, options?: OpcoesDaTransacao) => Promise<T>;
};

@Injectable()
export class ContactsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tags: TagsService,
    private readonly customFields: CustomFieldsService,
    private readonly activities: ActivitiesService,
    private readonly usage: UsageService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly restricao: MudancasDeRestricao,
    private readonly travas: TravasDeIdentidade,
    private readonly files: FilesService,
    private readonly cls: ClsService,
  ) {}

  /**
   * A região do workspace para normalizar telefone (C17). `raw` justificado, e
   * registrado como exceção (SECURITY.md §2): o `Workspace` é a raiz do tenant
   * e fica fora do client filtrado. Só a região, por `findUnique` do id. Com
   * CLS, o id tem de ser o do contexto; sem CLS (a ingestão do webhook), ele
   * vem da credencial do canal. Um teste estático fixa este único `raw`.
   */
  async regiaoDoWorkspace(workspaceId: string): Promise<string> {
    const doContexto = this.cls.get<string | undefined>('workspaceId');
    if (doContexto && doContexto !== workspaceId) {
      throw new Error('regiaoDoWorkspace: workspace diferente do contexto');
    }
    const workspace = await this.prisma.raw.workspace.findUnique({
      where: { id: workspaceId },
      select: { phoneRegion: true },
    });
    if (!workspace) throw new NotFoundException('Workspace não encontrado');
    return workspace.phoneRegion;
  }

  async list(input: ListContactsInput): Promise<Paginated<ContactDto>> {
    const where = {
      status: input.status,
      ...(input.companyId ? { companyId: input.companyId } : {}),
      ...(input.ownerMembershipId ? { ownerMembershipId: input.ownerMembershipId } : {}),
      ...(input.tagId ? { tags: { some: { tagId: input.tagId } } } : {}),
      ...(input.search
        ? {
            OR: [
              { name: { contains: input.search, mode: 'insensitive' as const } },
              { emails: { has: input.search.toLowerCase() } },
            ],
          }
        : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.db.contact.count({ where } as never),
      this.prisma.db.contact.findMany({
        where,
        include: CONTACT_INCLUDE,
        orderBy: { [input.sortBy]: input.sortDir },
        skip: (input.page - 1) * input.pageSize,
        take: input.pageSize,
      } as never) as unknown as Promise<ContactRow[]>,
    ]);
    return {
      items: await this.toDtos(rows),
      total,
      page: input.page,
      pageSize: input.pageSize,
    };
  }

  async get(id: string): Promise<ContactDto> {
    const row = (await this.prisma.db.contact.findFirst({
      where: { id },
      include: CONTACT_INCLUDE,
    } as never)) as ContactRow | null;
    if (!row) throw new NotFoundException('Contato não encontrado');
    const [dto] = await this.toDtos([row]);
    return dto;
  }

  async create(auth: AuthContext, input: CreateContactInput): Promise<ContactDto> {
    await this.validateReferences(input);
    // fora da transação, de propósito (ver UsageService.consume): garante a
    // linha E resolve o teto sem pedir conexão com a transação aberta
    const contactsLimit = await this.usage.prepareConsume(auth.workspaceId as string, 'contacts');
    const validated = await this.customFields.validateValues('contact', input.customFields, {
      requireAll: true,
    });
    const regiao = await this.regiaoDoWorkspace(auth.workspaceId as string);
    const derivados = derivadosDosTelefones(input.phones, regiao);
    const id = await this.restricao.naTransacaoInterativa(
      this.prisma.db as unknown as TxRunner,
      async (tx) => {
        // quem escreve telefone trava o endereço de cada número ANTES de qualquer
        // linha (ADR-052 item 3): a ingestão do mesmo número espera
        const chaves = chavesQueMudam([], input.phones, regiao);
        if (chaves) {
          await this.travas.paraTelefones(tx, {
            workspaceId: auth.workspaceId as string,
            contactId: null,
            chaves,
          });
        }
        const contact = await tx.contact.create({
          data: {
            name: input.name,
            emails: input.emails,
            phones: input.phones,
            phonesNormalized: derivados.phonesNormalized,
            phoneMatchKeys: derivados.phoneMatchKeys,
            companyId: input.companyId ?? null,
            ownerMembershipId: input.ownerMembershipId ?? null,
            source: input.source ?? null,
          },
        } as never);
        if (input.tagIds.length > 0) {
          await tx.contactTag.createMany({
            data: input.tagIds.map((tagId) => ({ contactId: contact.id, tagId })),
          } as never);
        }
        await this.customFields.syncValues(tx, 'contact', contact.id, validated);
        // quota DENTRO da transação (ADR-032): estourou, o 402 derruba tudo e o
        // contador volta pelo rollback — contato nasce sempre `active`
        await this.usage.consume(tx, auth.workspaceId as string, 'contacts', 1, contactsLimit);
        // ajuste #6: o tipo declarado no catálogo é emitido de fato
        await this.activities.record(tx, auth.workspaceId as string, 'contact_created', {
          actorMembershipId: auth.membershipId,
          payload: { name: input.name },
          targets: { contactId: contact.id, companyId: input.companyId },
        });
        // outbox NA MESMA transação: se ela abortar, o evento externo some junto
        await this.outbox.enqueue(
          tx,
          auth.workspaceId as string,
          'contact.created',
          { id: contact.id, name: input.name },
          `contact.created:${contact.id}`,
          { subjectContactIds: [contact.id] },
        );
        return contact.id;
      },
    );
    return this.get(id);
  }

  /**
   * Criação a partir de CANAL EXTERNO (ADR-040), dentro da transação de quem
   * chama. Existe para que a ingestão não contorne o domínio: sem isto, o
   * contato nascia sem consumir quota, sem `Activity` e sem `contact.created`
   * no outbox — ou seja, sem disparar automação, que é justamente o ponto de
   * um lead chegando por WhatsApp.
   *
   * A quota é consumida SEM barrar: recusar a mensagem de um paciente por
   * limite de plano é dano irrecuperável para ele, enquanto ultrapassar o teto
   * é problema de cobrança, visível no medidor.
   *
   * AS TRAVAS são de quem chama (ADR-052 item 3): a ingestão já segura o nível
   * 0 e o endereço do número. É a exceção do contato de id FRESCO — o criado
   * aqui, nesta transação, que ninguém mais conhece. Não serve para editar
   * contato existente, que sempre passa por `update`.
   */
  async createFromExternalChannel(
    tx: Db,
    workspaceId: string,
    input: { name: string; phone: string; source: string; regiao: string },
  ): Promise<string> {
    const derivados = derivadosDosTelefones([input.phone], input.regiao);
    const contact = await tx.contact.create({
      data: {
        workspaceId,
        name: input.name,
        phones: [input.phone],
        phonesNormalized: derivados.phonesNormalized,
        phoneMatchKeys: derivados.phoneMatchKeys,
        source: input.source,
      },
    } as never);
    const contactId = (contact as unknown as { id: string }).id;

    await this.usage.consumeOverLimit(tx, workspaceId, 'contacts', 1);
    await this.activities.record(tx, workspaceId, 'contact_created', {
      actorMembershipId: null,
      actorType: 'system',
      payload: { name: input.name },
      targets: { contactId },
    });
    await this.outbox.enqueue(
      tx,
      workspaceId,
      'contact.created',
      { id: contactId, name: input.name },
      `contact.created:${contactId}`,
      { subjectContactIds: [contactId] },
    );
    return contactId;
  }

  /**
   * O contato NOVO da identificação do remetente (ADR-052 item 2), na transação
   * de quem identifica — que já segura o nível 0 e o endereço do número. É a
   * exceção do id FRESCO: o contato nasce aqui e ninguém mais o conhece, então
   * não pega o nível 2 depois do 3. A cota é a de qualquer contato criado por
   * uma pessoa, COM barreira: o 402 derruba a identificação inteira.
   */
  async criarPelaIdentificacao(
    tx: Db,
    auth: AuthContext,
    input: { name: string; phone: string; regiao: string },
    contactsLimit: number | null,
  ): Promise<string> {
    const workspaceId = auth.workspaceId as string;
    const derivados = derivadosDosTelefones([input.phone], input.regiao);
    const contact = await tx.contact.create({
      data: {
        name: input.name,
        phones: [input.phone],
        phonesNormalized: derivados.phonesNormalized,
        phoneMatchKeys: derivados.phoneMatchKeys,
        source: 'whatsapp',
      },
    } as never);
    const contactId = (contact as unknown as { id: string }).id;
    await this.usage.consume(tx, workspaceId, 'contacts', 1, contactsLimit);
    await this.activities.record(tx, workspaceId, 'contact_created', {
      actorMembershipId: auth.membershipId,
      payload: { name: input.name },
      targets: { contactId },
    });
    await this.outbox.enqueue(
      tx,
      workspaceId,
      'contact.created',
      { id: contactId, name: input.name },
      `contact.created:${contactId}`,
      { subjectContactIds: [contactId] },
    );
    return contactId;
  }

  /**
   * Os telefones de um contato que SÃO o número, em qualquer formato em que
   * estejam escritos — os que "tirar o número" retira. Pela classificação
   * ESTRITA: o telefone que só divide a chave, sem forma que o explique (outro
   * DDD no formato antigo), não sai (revisão da F4.1a).
   */
  private telefonesDoNumero(
    telefones: readonly string[],
    numero: string,
    regiao: string,
  ): string[] {
    return telefones.filter(
      (telefone) =>
        coincidenciaEstrita(numero, {
          phones: [telefone],
          phonesNormalized: derivadosDosTelefones([telefone], regiao).phonesNormalized,
        }) !== 'nenhuma',
    );
  }

  /**
   * O que "tirar o número" vai mexer, lido ANTES das travas (ADR-052 item 3):
   * os telefones atuais do contato e as chaves dos que saem — que entram nas
   * travas da religação. `tirarNumeroNaTransacao` confere os telefones de novo.
   */
  async saidaDoNumero(
    contactId: string,
    numero: string,
    regiao: string,
  ): Promise<{ lidos: string[]; chaves: string[] }> {
    const contato = (await this.prisma.db.contact.findFirst({
      where: { id: contactId },
      select: { phones: true },
    })) as unknown as { phones: string[] } | null;
    if (!contato) throw new NotFoundException('Contato não encontrado');
    const saem = this.telefonesDoNumero(contato.phones, numero, regiao);
    const ficam = contato.phones.filter((t) => !saem.includes(t));
    return { lidos: contato.phones, chaves: chavesQueMudam(contato.phones, ficam, regiao) ?? [] };
  }

  /**
   * Tira de um contato EXISTENTE o número, em qualquer formato em que esteja
   * escrito, na transação de quem já segura o contato e os endereços dos
   * telefones que saem, exclusivos — o rejeitar do remetente (ADR-052 item 2).
   * Não é atalho de edição: quem não segura essas travas edita por `update`.
   * Telefones diferentes dos lidos antes das travas são 409. O consentimento do
   * número que saiu é revogado (`number_removed`, F4.1b). Devolve se algo
   * mudou.
   */
  async tirarNumeroNaTransacao(
    tx: Db,
    auth: AuthContext,
    contactId: string,
    numero: string,
    regiao: string,
    lidos: readonly string[],
  ): Promise<boolean> {
    const atual = await this.lockAndRead(tx, contactId);
    if (!mesmosTelefones(atual.phones, lidos)) {
      throw new ConflictException(MENSAGEM_TELEFONE_MUDOU);
    }
    const saem = this.telefonesDoNumero(atual.phones, numero, regiao);
    if (saem.length === 0) return false;
    const ficam = atual.phones.filter((t) => !saem.includes(t));
    const derivados = derivadosDosTelefones(ficam, regiao);
    await tx.contact.updateMany({
      where: { id: contactId },
      data: {
        phones: ficam,
        phonesNormalized: derivados.phonesNormalized,
        phoneMatchKeys: derivados.phoneMatchKeys,
      },
    });
    await revogarNumerosQueSairam(
      tx,
      this.audit,
      auth,
      contactId,
      numerosExatos({ phones: ficam, phonesNormalized: derivados.phonesNormalized }),
    );
    return true;
  }

  /**
   * Trava a linha do contato na transação e devolve o estado ATUAL dela. Dois
   * pedidos sobre o mesmo contato passam a ser seriais: o segundo espera o
   * primeiro e lê o que ele deixou. Linha que sumiu enquanto se esperava (uma
   * exclusão venceu) vira 404, antes de qualquer efeito — inclusive na cota.
   */
  private async lockAndRead(
    tx: Db,
    id: string,
  ): Promise<{ name: string; status: string; phones: string[] }> {
    const travado = await tx.contact.updateMany({ where: { id }, data: { updatedAt: new Date() } });
    if (travado.count === 0) throw new NotFoundException('Contato não encontrado');
    const atual = (await tx.contact.findFirst({
      where: { id },
      select: { name: true, status: true, phones: true },
    })) as unknown as { name: string; status: string; phones: string[] } | null;
    if (!atual) throw new NotFoundException('Contato não encontrado');
    return atual;
  }

  async update(auth: AuthContext, id: string, input: UpdateContactInput): Promise<ContactDto> {
    const existing = await this.prisma.db.contact.findFirst({ where: { id } });
    if (!existing) throw new NotFoundException('Contato não encontrado');
    const contactsLimit = await this.usage.prepareConsume(auth.workspaceId as string, 'contacts');
    await this.validateReferences(input);
    const validated = input.customFields
      ? await this.customFields.validateValues('contact', input.customFields, {
          requireAll: false,
        })
      : null;
    const regiao = await this.regiaoDoWorkspace(auth.workspaceId as string);
    const telefonesAntes = (existing as unknown as { phones: string[] }).phones;
    const derivados = input.phones ? derivadosDosTelefones(input.phones, regiao) : null;
    await this.restricao.naTransacaoInterativa(
      this.prisma.db as unknown as TxRunner,
      async (tx) => {
        // telefone mudando: o contato e o endereço de cada NÚMERO acrescentado ou
        // removido, exclusivos, numa passada, ANTES da linha (ADR-052 item 3)
        const chaves = input.phones ? chavesQueMudam(telefonesAntes, input.phones, regiao) : null;
        if (chaves) {
          await this.travas.paraTelefones(tx, {
            workspaceId: auth.workspaceId as string,
            contactId: id,
            chaves,
          });
        }
        /**
         * TRAVA e RELÊ antes de decidir a cota: o `existing` acima foi lido fora
         * da transação, e um arquivamento ou exclusão concorrente o deixa velho —
         * descontar por ele fazia a cota de contatos cair duas vezes (e, repetido,
         * deixava passar contatos acima do teto do plano).
         */
        const atual = await this.lockAndRead(tx, id);
        // as travas saíram dos telefones lidos ANTES: relidos diferentes, a
        // diferença travada não é mais a verdadeira
        // e sempre que o PATCH traz telefones, mesmo iguais: sem nada travado, a
        // escrita poria de volta um número que outro escritor acabou de tirar
        if (input.phones && !mesmosTelefones(atual.phones, telefonesAntes)) {
          throw new ConflictException(MENSAGEM_TELEFONE_MUDOU);
        }
        await tx.contact.updateMany({
          where: { id },
          data: {
            name: input.name,
            emails: input.emails,
            phones: input.phones,
            ...(derivados
              ? {
                  phonesNormalized: derivados.phonesNormalized,
                  phoneMatchKeys: derivados.phoneMatchKeys,
                }
              : {}),
            status: input.status,
            companyId: input.companyId,
            ownerMembershipId: input.ownerMembershipId,
            source: input.source,
          },
        });
        // o número que deixou de ser exato leva o consentimento junto (F4.1b),
        // sob as mesmas travas da escrita: o contato e o `address:` dele
        if (chaves && input.phones && derivados) {
          await revogarNumerosQueSairam(
            tx,
            this.audit,
            auth,
            id,
            numerosExatos({ phones: input.phones, phonesNormalized: derivados.phonesNormalized }),
          );
        }
        if (input.tagIds) {
          await tx.contactTag.deleteMany({ where: { contactId: id } });
          if (input.tagIds.length > 0) {
            await tx.contactTag.createMany({
              data: input.tagIds.map((tagId) => ({ contactId: id, tagId })),
            } as never);
          }
        }
        if (validated) await this.customFields.syncValues(tx, 'contact', id, validated);

        // gauge segue o ciclo de vida (ADR-032): arquivar libera vaga, reativar
        // consome de novo — e reativar PODE esbarrar no teto, como criar
        if (input.status && input.status !== atual.status) {
          await this.usage.consume(
            tx,
            auth.workspaceId as string,
            'contacts',
            input.status === 'active' ? 1 : -1,
            contactsLimit,
          );
        }
      },
    );
    return this.get(id);
  }

  /**
   * Exclusão de contato — POLÍTICA EXPLÍCITA (ajuste #9, LGPD/SECURITY.md §9):
   *  - Deals e Tasks são PRESERVADOS, apenas desvinculados (contactId = null):
   *    são registro comercial/operacional do workspace, não dado do titular;
   *  - Notes e CustomFieldValues do contato são REMOVIDOS (conteúdo sobre ele);
   *  - Activities caem por cascade (histórico morre com o titular);
   *  - a MÍDIA RECEBIDA dele que fica sem vínculo é expurgada (ADR-052,
   *    revisão da F4.1a); o arquivo que um membro enviou fica na biblioteca;
   *  - a exclusão em si é registrada em AuditLog (fica após o expurgo).
   * Nada de 409 genérico: o contato sempre pode ser excluído.
   */
  async remove(auth: AuthContext, id: string): Promise<void> {
    const existing = (await this.prisma.db.contact.findFirst({
      where: { id },
    })) as unknown as ContactRow | null;
    if (!existing) throw new NotFoundException('Contato não encontrado');
    const contactsLimit = await this.usage.prepareConsume(auth.workspaceId as string, 'contacts');
    // a mídia recebida do titular sai com ele, e devolve o armazenamento
    const storageLimit = await this.usage.prepareConsume(
      auth.workspaceId as string,
      'storage_bytes',
    );
    const regiao = await this.regiaoDoWorkspace(auth.workspaceId as string);
    const chavesDoContato = chavesQueMudam(existing.phones, [], regiao) ?? [];
    await this.restricao.naTransacaoInterativa(
      this.prisma.db as unknown as TxRunner,
      async (tx) => {
        /**
         * A exclusão MUDA A RESTRIÇÃO (ADR-047 adendo 6 §6). As travas de
         * restrição vêm antes de qualquer linha, esperam os usos e as
         * aprovações em andamento e marcam os órfãos deste contato. Quem
         * recusa, depois do commit, o uso que esperava é a PORTA: com o
         * Clinics, contato apagado é restrito, e o uso não começa. SEM vertical
         * composto, a porta não restringe nada, e a exclusão só espera os usos
         * em andamento — o que já tinha sido montado antes dela ainda pode sair
         * (pendência registrada, ADR-047 adendo 7 §10).
         *
         * Os números do contato também saem (ADR-052): o endereço de cada um
         * entra NA MESMA passada, para a ordem global valer — o nível 3 nunca
         * depois da marcação dos órfãos, que já escreve linhas.
         */
        await this.travas.paraTelefones(tx, {
          workspaceId: auth.workspaceId as string,
          contactId: id,
          chaves: chavesDoContato,
        });
        /**
         * TRAVA a linha antes de qualquer efeito: duas exclusões do mesmo contato
         * passam a ser SERIAIS. A segunda espera a primeira; quando ela conclui,
         * o UPDATE reavalia a linha (já apagada), não toca nada e vira 404 —
         * em vez de seguir até o outbox e quebrar no unique de deduplicação (500),
         * ou de descontar a cota de contatos duas vezes.
         */
        const atual = await this.lockAndRead(tx, id);
        if (!mesmosTelefones(atual.phones, existing.phones)) {
          throw new ConflictException(MENSAGEM_TELEFONE_MUDOU);
        }
        await this.audit.record(tx, auth.workspaceId as string, 'contact.deleted', {
          entityType: 'contact',
          entityId: id,
          actor: this.audit.actorFrom(auth),
          // o estado de AGORA, relido sob a trava — não o de antes da transação
          before: { name: atual.name, status: atual.status },
          after: null,
        });
        // preserva o registro comercial, desvinculando o titular
        await tx.deal.updateMany({ where: { contactId: id }, data: { contactId: null } });
        await tx.task.updateMany({ where: { contactId: id }, data: { contactId: null } });
        // remove o que é conteúdo SOBRE o titular
        await tx.note.deleteMany({ where: { contactId: id } });
        // CustomFieldValue.entityId não tem FK (exceção documentada): limpeza aqui
        await this.customFields.deleteValues(tx, 'contact', id);
        await this.outbox.enqueue(
          tx,
          auth.workspaceId as string,
          'contact.deleted',
          { id },
          `contact.deleted:${id}`,
          // emitido ANTES do delete: a validação de isolamento ainda vê o contato
          { subjectContactIds: [id] },
        );
        // antes da cascata: depois dela, os vínculos da mídia já não existem
        const midiaRecebida = await this.files.midiaRecebidaDoContato(tx, id);
        await tx.contact.deleteMany({ where: { id } }); // junções/activities: cascade
        /**
         * A mídia RECEBIDA do titular que ficou sem vínculo sai junto (LGPD;
         * revisão da F4.1a): sem isso, ela voltaria a arquivo sem vínculo,
         * listável e baixável só com `files:read`. O anexo que um membro enviou
         * volta a ser arquivo da biblioteca, como antes da F4.1a.
         */
        await this.files.expurgarSemVinculoNaTransacao(tx, auth, midiaRecebida, storageLimit);
        // só quem contava é descontado: arquivado já tinha liberado a vaga
        if (atual.status === 'active') {
          await this.usage.consume(tx, auth.workspaceId as string, 'contacts', -1, contactsLimit);
        }
      },
    );
  }

  /** Import simples (linhas já parseadas pelo cliente). source = 'import'. */
  async import(auth: AuthContext, input: ImportContactsInput): Promise<{ imported: number }> {
    // import não carrega custom fields — com campo obrigatório definido, criar
    // sem ele furaria a invariante que o POST /contacts recusa com 400
    const required = await this.prisma.db.customFieldDefinition.count({
      where: { entityType: 'contact', required: true },
    });
    if (required > 0) {
      throw new BadRequestException(
        'Importação indisponível: há campos personalizados obrigatórios — importe pelo formulário ou torne-os opcionais',
      );
    }
    const contactsLimit = await this.usage.prepareConsume(auth.workspaceId as string, 'contacts');
    const regiao = await this.regiaoDoWorkspace(auth.workspaceId as string);
    const linhas = input.rows.map((row) => {
      const phones = row.phone ? [row.phone] : [];
      return { row, phones, derivados: derivadosDosTelefones(phones, regiao) };
    });
    // o LOTE inteiro entra na mesma transação e consome a quota de uma vez: ou
    // importa tudo, ou nada. Importação parcial por quota deixaria o usuário
    // sem saber quais linhas entraram (ajuste da revisão da 8).
    const count = await this.restricao.naTransacaoInterativa(
      this.prisma.db as unknown as TxRunner,
      async (tx) => {
        /**
         * SEM travas de endereço (ADR-052, resultados da F4.1a, desvio 7). A
         * importação só CRIA contatos: uma ingestão ou identificação concorrente
         * do mesmo número decide pelos candidatos que leu — se leu antes deste
         * commit, como se viesse antes da importação (um lead a mais, ou a
         * mensagem com o contato exato que já havia, e a próxima vira RAI). Não é
         * garantia absoluta contra atribuição; as ordens estão testadas. Com a
         * trava por número, um lote de até mil números ocuparia a tabela de
         * travas compartilhada do Postgres, que é de todos os workspaces.
         */
        const created = await tx.contact.createMany({
          data: linhas.map(({ row, phones, derivados }) => ({
            name: row.name,
            emails: row.email ? [row.email] : [],
            phones,
            phonesNormalized: derivados.phonesNormalized,
            phoneMatchKeys: derivados.phoneMatchKeys,
            source: 'import',
          })),
        } as never);
        const imported = (created as unknown as { count: number }).count;
        await this.usage.consume(
          tx,
          auth.workspaceId as string,
          'contacts',
          imported,
          contactsLimit,
        );
        return imported;
      },
    );
    return { imported: count };
  }

  private async validateReferences(input: {
    companyId?: string | null;
    ownerMembershipId?: string | null;
    tagIds?: string[];
  }): Promise<void> {
    if (input.companyId) {
      const company = await this.prisma.db.company.findFirst({ where: { id: input.companyId } });
      if (!company) throw new BadRequestException('Empresa inválida');
    }
    if (input.ownerMembershipId) {
      const owner = await this.prisma.db.membership.findFirst({
        where: { id: input.ownerMembershipId, status: 'active' },
      });
      if (!owner) throw new BadRequestException('Responsável inválido');
    }
    if (input.tagIds) await this.tags.assertTagsExist(input.tagIds);
  }

  private async toDtos(rows: ContactRow[]): Promise<ContactDto[]> {
    const [customFields, ownerNames] = await Promise.all([
      this.customFields.valuesByEntity(
        'contact',
        rows.map((r) => r.id),
      ),
      this.resolveOwnerNames(rows.map((r) => r.ownerMembershipId)),
    ]);
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      emails: row.emails,
      phones: row.phones,
      status: row.status,
      companyId: row.companyId,
      companyName: row.company?.name ?? null,
      ownerMembershipId: row.ownerMembershipId,
      ownerName: row.ownerMembershipId ? (ownerNames.get(row.ownerMembershipId) ?? null) : null,
      source: row.source,
      tags: row.tags.map((t) => ({ id: t.tag.id, name: t.tag.name, color: t.tag.color })),
      customFields: customFields.get(row.id) ?? {},
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  private async resolveOwnerNames(membershipIds: (string | null)[]): Promise<Map<string, string>> {
    const ids = [...new Set(membershipIds.filter((id): id is string => id !== null))];
    if (ids.length === 0) return new Map();
    const memberships = await this.prisma.db.membership.findMany({
      where: { id: { in: ids }, status: { not: 'removed' } }, // ex-membro: ownerName null
      select: { id: true, userId: true },
    });
    // raw justificado: nome (User é global) para exibição, restrito aos userIds
    // das memberships DESTE workspace (já filtradas pelo db)
    const users = await this.prisma.raw.user.findMany({
      where: { id: { in: memberships.map((m) => m.userId) } },
      select: { id: true, name: true },
    });
    const nameByUser = new Map(users.map((u) => [u.id, u.name]));
    return new Map(memberships.map((m) => [m.id, nameByUser.get(m.userId) ?? '']));
  }
}
