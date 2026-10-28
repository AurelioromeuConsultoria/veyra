import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  ClinicsAppointmentDealDto,
  ClinicsDealOptionDto,
} from '@veyra/contracts/verticals/clinics';
import { AuditService } from '../../../audit/audit.service';
import type { AuthContext } from '../../../common/decorators';
import {
  MudancasDeRestricao,
  type ExecutorDeTransacao,
} from '../../../content-use/restriction-changes';
import { PrismaService, type Db } from '../../../prisma/prisma.service';

/** Os deals que a lista de escolha mostra: o teto é defesa. */
const TETO_DE_OPCOES = 100;

const DEPOIS_DO_ATENDIMENTO = 'O vínculo com a oportunidade não muda depois do atendimento';

/**
 * O vínculo do agendamento com um deal do Core (ADR-048 adendos 8 e 10, F4.3).
 * No máximo um deal por agendamento; vários agendamentos por deal. Vincular,
 * trocar e desvincular só ANTES do atendimento, com trilha.
 *
 * A serialização com o registro do atendimento: a mudança trava a LINHA do
 * agendamento, recusando o atendido, antes de qualquer outra leitura; o
 * registro do atendimento trava a mesma linha ao passar a `attended`. Um
 * espera o outro, e a mudança que chega depois do atendimento é recusada. O
 * gatilho do banco recusa de novo, para qualquer caminho.
 *
 * O deal precisa ser do contato do paciente na hora do vínculo. Se o contato
 * do deal mudar depois, a referência fica, mas não é vínculo válido: a leitura
 * diz `valid: false` e as métricas não o contam (adendo 10, decisão 3).
 */
@Injectable()
export class ClinicsDealLinksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly restricao: MudancasDeRestricao,
  ) {}

  async ler(appointmentId: string): Promise<ClinicsAppointmentDealDto> {
    const contactId = await this.contatoDoPaciente(this.prisma.db, appointmentId);
    const vinculo = (await this.prisma.db.clinicsAppointmentDeal.findFirst({
      where: { appointmentId },
      select: { dealId: true },
    })) as { dealId: string } | null;
    if (!vinculo) return { appointmentId, dealId: null, dealTitle: null, valid: null };
    const deal = (await this.prisma.db.deal.findFirst({
      where: { id: vinculo.dealId },
      select: { title: true, contactId: true },
    })) as { title: string; contactId: string | null } | null;
    const valid = !!deal && deal.contactId === contactId;
    // o deal que mudou de contato não aparece como vínculo válido: só a referência
    return { appointmentId, dealId: vinculo.dealId, dealTitle: valid ? deal.title : null, valid };
  }

  /** Os deals do MESMO contato do paciente, em qualquer pipeline. */
  async opcoes(appointmentId: string): Promise<ClinicsDealOptionDto[]> {
    const contactId = await this.contatoDoPaciente(this.prisma.db, appointmentId);
    const deals = (await this.prisma.db.deal.findMany({
      where: { contactId },
      select: { id: true, title: true, pipelineId: true, createdAt: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: TETO_DE_OPCOES,
    })) as { id: string; title: string; pipelineId: string; createdAt: Date }[];
    return deals.map((d) => ({ ...d, createdAt: d.createdAt.toISOString() }));
  }

  /** Vincular ou trocar. Repetir o mesmo deal não muda nada nem audita de novo. */
  async vincular(
    auth: AuthContext,
    appointmentId: string,
    dealId: string,
  ): Promise<ClinicsAppointmentDealDto> {
    const workspaceId = auth.workspaceId as string;
    // a transação das mudanças: a espera pela linha tem prazo no banco (409),
    // e a conexão do pool não fica presa atrás de um atendimento longo
    await this.restricao.naTransacaoInterativa(this.mudancas(), async (tx) => {
      await travarAntesDoAtendimento(tx, appointmentId);
      const contactId = await this.contatoDoPaciente(tx, appointmentId);
      const deal = (await tx.deal.findFirst({
        where: { id: dealId },
        select: { contactId: true },
      })) as { contactId: string | null } | null;
      if (!deal) throw new NotFoundException('Oportunidade não encontrada');
      if (deal.contactId !== contactId) {
        throw new BadRequestException('A oportunidade é de outro contato');
      }
      const atual = (await tx.clinicsAppointmentDeal.findFirst({
        where: { appointmentId },
        select: { dealId: true },
      })) as { dealId: string } | null;
      if (atual?.dealId === dealId) return;
      if (atual) {
        await tx.clinicsAppointmentDeal.updateMany({
          where: { appointmentId },
          data: { dealId, linkedByMembershipId: auth.membershipId as string },
        });
      } else {
        await tx.clinicsAppointmentDeal.create({
          data: { appointmentId, dealId, linkedByMembershipId: auth.membershipId as string },
        } as never);
      }
      await this.audit.record(tx, workspaceId, 'clinics.appointment.deal_linked', {
        entityType: 'clinicsAppointmentDeal',
        entityId: appointmentId,
        actor: this.audit.actorFrom(auth),
        before: atual ? { appointmentId, dealId: atual.dealId } : null,
        after: { appointmentId, dealId },
      });
    });
    return this.ler(appointmentId);
  }

  /** Desvincular. Sem vínculo, nada muda. */
  async desvincular(auth: AuthContext, appointmentId: string): Promise<ClinicsAppointmentDealDto> {
    const workspaceId = auth.workspaceId as string;
    // a transação das mudanças: a espera pela linha tem prazo no banco (409),
    // e a conexão do pool não fica presa atrás de um atendimento longo
    await this.restricao.naTransacaoInterativa(this.mudancas(), async (tx) => {
      await travarAntesDoAtendimento(tx, appointmentId);
      const atual = (await tx.clinicsAppointmentDeal.findFirst({
        where: { appointmentId },
        select: { dealId: true },
      })) as { dealId: string } | null;
      if (!atual) return;
      await tx.clinicsAppointmentDeal.deleteMany({ where: { appointmentId } });
      await this.audit.record(tx, workspaceId, 'clinics.appointment.deal_unlinked', {
        entityType: 'clinicsAppointmentDeal',
        entityId: appointmentId,
        actor: this.audit.actorFrom(auth),
        before: { appointmentId, dealId: atual.dealId },
        after: null,
      });
    });
    return this.ler(appointmentId);
  }

  private mudancas(): ExecutorDeTransacao {
    return this.prisma.db as unknown as ExecutorDeTransacao;
  }

  /** O contato do paciente do agendamento; o agendamento de outro workspace é 404. */
  private async contatoDoPaciente(db: Db, appointmentId: string): Promise<string> {
    const agendamento = (await db.clinicsAppointment.findFirst({
      where: { id: appointmentId },
      select: { patientId: true },
    })) as { patientId: string } | null;
    if (!agendamento) throw new NotFoundException('Agendamento não encontrado');
    const paciente = (await db.clinicsPatient.findFirst({
      where: { id: agendamento.patientId },
      select: { contactId: true },
    })) as { contactId: string };
    return paciente.contactId;
  }
}

/**
 * Trava a linha do agendamento AINDA NÃO ATENDIDO, antes de qualquer leitura:
 * o registro do atendimento trava a mesma linha, e quem chega depois dele vê
 * o `attended` e é recusado (409).
 */
async function travarAntesDoAtendimento(tx: Db, appointmentId: string): Promise<void> {
  const { count } = await tx.clinicsAppointment.updateMany({
    where: { id: appointmentId, status: { not: 'attended' } },
    data: { updatedAt: new Date() },
  } as never);
  if (count > 0) return;
  const existe = await tx.clinicsAppointment.findFirst({
    where: { id: appointmentId },
    select: { id: true },
  });
  if (!existe) throw new NotFoundException('Agendamento não encontrado');
  throw new ConflictException(DEPOIS_DO_ATENDIMENTO);
}
