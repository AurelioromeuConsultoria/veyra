import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  ClinicsPatientDto,
  ListClinicsPatientsInput,
} from '@veyra/contracts/verticals/clinics';
import { AuditService } from '../../audit/audit.service';
import type { AuthContext } from '../../common/decorators';
import { ContactsService } from '../../contacts/contacts.service';
import { MudancasDeRestricao, type OpcoesDaTransacao } from '../../content-use/restriction-changes';
import { PrismaService, type Db } from '../../prisma/prisma.service';
import { ClinicsReleasesService } from './clinics-releases.service';

type TxRunner = {
  $transaction: <T>(fn: (tx: Db) => Promise<T>, options?: OpcoesDaTransacao) => Promise<T>;
};
type PatientRow = {
  id: string;
  contactId: string;
  createdAt: Date;
  contact?: { name: string } | null;
};

const COM_NOME = { contact: { select: { name: true } } } as const;

/**
 * Perfil de PACIENTE (ADR-048 §4 e adendo 2, itens 1 a 3). Classe S: só o
 * vínculo com o contato, quem criou e quando.
 *
 * Tornar paciente é ato EXPLÍCITO e MUDA A RESTRIÇÃO do contato: pega as
 * travas de restrição dele antes de escrever, pela primitiva do Core, que
 * marca os usos órfãos (ADR-047 adendo 6 §6), e na MESMA transação a liberação
 * de IA deixa de valer — a linha é apagada, com trilha (§6.3, item 6). A
 * garantia é a regra derivada na porta (paciente é restrito com ou sem
 * liberação); a expiração do conteúdo de IA, depois do commit, é limpeza.
 */
@Injectable()
export class ClinicsPatientsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly contacts: ContactsService,
    private readonly releases: ClinicsReleasesService,
    private readonly restricao: MudancasDeRestricao,
  ) {}

  /**
   * `withContactId` vem da rota: o id do contato só sai para quem lê contatos
   * (o papel `Profissional` vê o paciente pela clínica, não pelo CRM).
   */
  async list(
    { contactIds, search, limit }: ListClinicsPatientsInput,
    withContactId: boolean,
  ): Promise<ClinicsPatientDto[]> {
    const rows = (await this.prisma.db.clinicsPatient.findMany({
      where: {
        ...(contactIds ? { contactId: { in: contactIds } } : {}),
        ...(search ? { contact: { name: { contains: search, mode: 'insensitive' } } } : {}),
      },
      include: COM_NOME,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      // teto com AVISO na tela e busca pelo nome; o cursor completo é dívida
      // com gatilho (technical-debt.md)
      take: limit,
    } as never)) as unknown as PatientRow[];
    return rows.map((row) => toDto(row, withContactId));
  }

  /** Idempotente: repetir devolve o perfil existente, sem nova trilha. */
  async create(auth: AuthContext, contactId: string): Promise<ClinicsPatientDto> {
    await this.contacts.get(contactId); // 404 para id inexistente ou de outro workspace
    const workspaceId = auth.workspaceId as string;
    const { row, novo } = await this.restricao.naTransacaoInterativa(
      this.prisma.db as unknown as TxRunner,
      async (tx) => {
        await this.restricao.porContato(tx, { workspaceId, contactIds: [contactId] });
        // DEPOIS das travas: uma exclusão concorrente segura a mesma trava
        // exclusiva, e o contato que ela apagou não vira paciente
        if (!(await tx.contact.findFirst({ where: { id: contactId }, select: { id: true } }))) {
          throw new NotFoundException('Contato não encontrado');
        }
        const existente = (await tx.clinicsPatient.findFirst({
          where: { contactId },
          include: COM_NOME,
        } as never)) as unknown as PatientRow | null;
        if (existente) return { row: existente, novo: false };

        const criado = (await tx.clinicsPatient.create({
          data: { contactId, createdByMembershipId: auth.membershipId as string },
          include: COM_NOME,
        } as never)) as unknown as PatientRow;
        await this.audit.record(tx, workspaceId, 'clinics.patient.created', {
          entityType: 'clinicsPatient',
          entityId: criado.id,
          actor: this.audit.actorFrom(auth),
          after: { contactId },
        });

        // a liberação de IA DEIXA DE VALER na mesma transação (§6.3, item 6)
        const liberacoes = (await tx.clinicsContactRelease.findMany({
          where: { contactId },
        })) as unknown as { id: string; consumer: string; reason: string }[];
        for (const liberacao of liberacoes) {
          await tx.clinicsContactRelease.deleteMany({ where: { id: liberacao.id } });
          await this.audit.record(tx, workspaceId, 'clinics.ai_release.revoked_by_patient', {
            entityType: 'clinicsContactRelease',
            entityId: liberacao.id,
            actor: this.audit.actorFrom(auth),
            before: { contactId, consumer: liberacao.consumer, reason: liberacao.reason },
            after: null,
          });
        }
        return { row: criado, novo: true };
      },
    );
    // limpeza COMPLEMENTAR depois do commit (aprovada com a prova de
    // concorrência do ADR-047 adendo 5): quem protege é a porta
    if (novo) await this.releases.expirar([contactId]);
    return toDto(row, true); // criar exige `contacts:read`
  }
}

function toDto(row: PatientRow, withContactId: boolean): ClinicsPatientDto {
  return {
    id: row.id,
    ...(withContactId ? { contactId: row.contactId } : {}),
    name: row.contact?.name ?? '',
    createdAt: row.createdAt.toISOString(),
  };
}
