import { Injectable } from '@nestjs/common';
import { CLINICS_OUTREACH_PURPOSES, horaLocal } from '@veyra/contracts/verticals/clinics';
import type {
  LeitorDaPreCondicao,
  OutboundPreconditionAnswer,
  OutboundPreconditionProvider,
} from '../../../extensions/outbound-precondition';

/** O prefixo da origem do envio: o pedido do Clinics (`clinics.outreach:<id>`). */
export const PREFIXO_DO_PEDIDO = 'clinics.outreach';

/** A confirmação deixa de ser elegível a duas horas do início (adendo 9, decisão 4). */
export const ANTECEDENCIA_DA_CONFIRMACAO_MS = 2 * 60 * 60_000;
/** A reativação vale 24 horas a partir do pedido (relógio do banco). */
export const PRAZO_DA_REATIVACAO_MS = 24 * 60 * 60_000;

/** As chaves de validade: ids estáveis, sem horário (adendo 8, item 3). */
export const chaveDoAgendamento = (id: string) => `clinics.appointment:${id}`;
export const chaveDoRetorno = (id: string) => `clinics.return:${id}`;

export const origemDoPedido = (id: string) => `${PREFIXO_DO_PEDIDO}:${id}`;

/** `AAAA-MM-DD` → `DD/MM/AAAA`, como a pessoa lê. */
function dataDaMensagem(data: string): string {
  const [ano, mes, dia] = data.split('-');
  return `${dia}/${mes}/${ano}`;
}

const NAO_VALE: OutboundPreconditionAnswer = { valid: false };

/**
 * A PORTA do E7 do Clinics (ADR-048 adendo 9, F4.2). O Core pergunta, sob as
 * travas, se o pedido ainda vale e quais são os valores dos campos do vertical.
 * Só lê, e só pelo leitor de quem chama (a transação da aprovação ou da
 * guarda, no workspace do pedido). O pedido vale com:
 * - o vertical ativo no workspace;
 * - a marca de ativo — o pedido que deixou de contar nunca mais vale;
 * - na confirmação, o agendamento marcado ou confirmado, com o MESMO início
 *   fixado no pedido. A data e a hora vão no fuso da unidade;
 * - na reativação, o retorno pendente e sem agendamento. Nenhum valor do
 *   vertical: só o primeiro nome, que é campo do Core.
 *
 * O limite do prazo: o início menos duas horas, na confirmação; a criação mais
 * 24 horas, na reativação. O Core usa o menor entre ele e o teto dele.
 */
@Injectable()
export class ClinicsOutreachPrecondition implements OutboundPreconditionProvider {
  readonly prefix = PREFIXO_DO_PEDIDO;
  // a prévia e a aprovação leem a agenda e escrevem sobre ela (adendo 9, decisão 3)
  readonly requiredPermissions = ['clinics:schedule:read', 'clinics:schedule:write'] as const;
  // a data e a hora do horário, no fuso da unidade (o conteúdo mínimo, adendo 9)
  readonly fields = ['clinics.data', 'clinics.hora'] as const;
  // as finalidades da clínica só valem por esta origem: nunca pelo Inbox
  readonly purposeKeys = [
    CLINICS_OUTREACH_PURPOSES.confirmation.key,
    CLINICS_OUTREACH_PURPOSES.reactivation.key,
  ];

  async check(
    leitor: LeitorDaPreCondicao,
    _workspaceId: string,
    requestId: string,
  ): Promise<OutboundPreconditionAnswer> {
    const ativo = await leitor.clinicsSettings.findFirst({ select: { status: true } });
    if (ativo?.status !== 'active') return NAO_VALE;
    const pedido = await leitor.clinicsOutreachRequest.findFirst({
      where: { id: requestId },
      select: {
        kind: true,
        appointmentId: true,
        startsAt: true,
        returnId: true,
        activeMark: true,
        createdAt: true,
      },
    });
    if (!pedido || pedido.activeMark !== true) return NAO_VALE;

    if (pedido.kind === 'confirmation') {
      if (!pedido.appointmentId || !pedido.startsAt) return NAO_VALE;
      const agendamento = await leitor.clinicsAppointment.findFirst({
        where: { id: pedido.appointmentId },
        select: { id: true, status: true, startsAt: true, unitId: true, patientId: true },
      });
      if (
        !agendamento ||
        (agendamento.status !== 'scheduled' && agendamento.status !== 'confirmed') ||
        agendamento.startsAt.getTime() !== pedido.startsAt.getTime()
      ) {
        return NAO_VALE;
      }
      const unidade = await leitor.clinicsUnit.findFirst({
        where: { id: agendamento.unitId },
        select: { timezone: true },
      });
      const contactId = await contatoDoPaciente(leitor, agendamento.patientId);
      if (!unidade || !contactId) return NAO_VALE;
      const local = horaLocal(agendamento.startsAt, unidade.timezone);
      return {
        valid: true,
        contactId,
        values: { 'clinics.data': dataDaMensagem(local.data), 'clinics.hora': local.hora },
        validityKeys: [chaveDoAgendamento(agendamento.id)],
        expiresAt: new Date(agendamento.startsAt.getTime() - ANTECEDENCIA_DA_CONFIRMACAO_MS),
      };
    }

    if (!pedido.returnId) return NAO_VALE;
    const retorno = await leitor.clinicsReturn.findFirst({
      where: { id: pedido.returnId },
      select: { id: true, status: true, appointmentId: true, patientId: true },
    });
    if (!retorno || retorno.status !== 'pending' || retorno.appointmentId !== null) return NAO_VALE;
    const contactId = await contatoDoPaciente(leitor, retorno.patientId);
    if (!contactId) return NAO_VALE;
    return {
      valid: true,
      contactId,
      values: {},
      validityKeys: [chaveDoRetorno(retorno.id)],
      expiresAt: new Date(pedido.createdAt.getTime() + PRAZO_DA_REATIVACAO_MS),
    };
  }
}

async function contatoDoPaciente(
  leitor: LeitorDaPreCondicao,
  patientId: string,
): Promise<string | null> {
  const paciente = await leitor.clinicsPatient.findFirst({
    where: { id: patientId },
    select: { contactId: true },
  });
  return paciente?.contactId ?? null;
}
