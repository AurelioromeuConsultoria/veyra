import type { BusinessOutboundReason } from '@veyra/contracts';
import type {
  ClinicsMetricStageDto,
  ClinicsOutreachKind,
  ClinicsOutreachReason,
  ClinicsOutreachState,
} from '@veyra/contracts/verticals/clinics';
import { useTransporte } from '../../../components/envio-simulado';
import { DISPATCH_ERROR_LABEL } from '../../../lib/motivos-do-envio';

/**
 * Os rótulos do envio da clínica (F4.4; ADR-048 adendos 9 a 11). Nenhum traz
 * dado do paciente: o servidor manda códigos, e a tela traduz.
 */

export const ROTULO_DO_TIPO: Record<ClinicsOutreachKind, string> = {
  confirmation: 'Confirmação de horário',
  reactivation: 'Reativação de retorno',
};

/**
 * O envio é o simulado, pela rota do vertical: quem lê a agenda vê os estados
 * e as métricas do envio, e precisa saber que nada saiu (revisão da F4.4).
 */
export function useEnvioSimuladoDaClinica(): boolean | null {
  return useTransporte('/api/clinics/outreach/transport', 'clinics:schedule:read');
}

/**
 * O estado do pedido. `sent` diz "simulado" no transporte falso e, com o
 * transporte desconhecido (carregando, erro), não afirma que saiu.
 */
export function rotuloDoEstado(estado: ClinicsOutreachState, simulado: boolean | null): string {
  switch (estado) {
    case 'draft':
      return 'Preparado: aguarda a prévia e a aprovação';
    case 'pending':
      return 'Aprovado: aguardando o envio';
    case 'sent':
      return simulado === true
        ? 'Enviado (simulado)'
        : simulado === false
          ? 'Enviado'
          : 'Registrado como enviado';
    case 'not_sent':
      return 'Não enviado';
    case 'uncertain':
      return 'Incerto: pode ter saído, e nunca é reenviado';
  }
}

export const MOTIVO_DO_PEDIDO: Record<ClinicsOutreachReason, string> = {
  target_not_found: 'o agendamento ou o retorno não existe mais',
  target_invalid:
    'o agendamento não está marcado ou confirmado, ou o retorno não está pendente sem agendamento',
  starts_too_soon: 'faltam duas horas ou menos para o início: a confirmação não é mais elegível',
  request_exists: 'este horário (ou retorno) já tem um pedido que conta',
  request_not_found: 'o pedido não foi encontrado',
  request_not_draft: 'o pedido já não está em rascunho: veja o acompanhamento',
  purpose_not_allowed:
    'a finalidade escolhida não é a deste tipo de envio, ou permite mais que o conteúdo mínimo',
  catalog_name_in_text:
    'o texto contém o nome de um serviço ou profissional do catálogo: revise o template',
};

/**
 * O motivo de uma recusa da prévia ou da aprovação (do vertical ou do Core) ou
 * do desfecho do despacho que o pedido lido traz (o código do despacho, como no
 * Inbox). O que a tela não conhece não vira o código cru.
 */
export function motivoLegivel(
  motivo: ClinicsOutreachReason | BusinessOutboundReason | string,
): string {
  return (
    (MOTIVO_DO_PEDIDO as Record<string, string>)[motivo] ??
    DISPATCH_ERROR_LABEL[motivo] ??
    'motivo não detalhado'
  );
}

/** Por que uma etapa da métrica não tem o número completo. */
export const MOTIVO_DA_ETAPA: Record<Exclude<ClinicsMetricStageDto['reason'], null>, string> = {
  no_provider_confirmation: 'sem confirmação do provedor',
  confirmation_time_unknown: 'confirmações antigas, sem horário registrado',
  // sem `conversations:read`, ou sem acesso a alguma conversa da contagem
  no_conversation_access: 'exige ler as conversas da contagem',
  empty_base: 'base vazia',
};
