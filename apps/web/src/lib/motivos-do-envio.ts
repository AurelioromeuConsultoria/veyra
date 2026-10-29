import type { BusinessOutboundReason } from '@veyra/contracts';

/**
 * Os motivos do envio e do despacho, em pt-BR, num lugar só: o Inbox e as
 * telas dos verticais leem os mesmos códigos do Core (F4.4).
 */

/**
 * Por que o template não foi aprovado — ou por que o despacho não saiu. A
 * lista é a do contrato: o web traduz, e nenhum motivo traz dado do contato.
 */
export const MOTIVO_DO_ENVIO_DO_NEGOCIO: Record<BusinessOutboundReason, string> = {
  address_changed: 'o número não é mais, de forma exata, um telefone do contato',
  address_ambiguous: 'o número coincide com mais de um contato: confira o cadastro',
  consent_revoked: 'sem consentimento vigente desta finalidade para este número',
  opted_out: 'a pessoa pediu para parar: nada é enviado a este número',
  conversation_relinked: 'a conversa mudou de contato ou de número desde a escolha',
  template_changed: 'o template mudou na Meta: a versão revisada não vale mais',
  template_unavailable: 'o template está indisponível na Meta agora',
  template_unverified: 'não foi possível reler o template na Meta — tente de novo',
  template_not_reviewed: 'esta versão não foi revisada para esta finalidade',
  approval_stale: 'algo mudou desde a prévia (o nome, o consentimento ou a versão): veja de novo',
  approval_expired: 'o prazo da aprovação venceu: veja a prévia de novo',
  field_value_invalid:
    'um campo do contato não serve como parâmetro (vazio, longo ou com quebra de linha)',
  precondition_failed: 'o pedido de origem não vale mais',
  precondition_unavailable: 'a conferência do pedido de origem não respondeu — tente de novo',
  precondition_unknown: 'a origem do pedido não é reconhecida',
  no_credential: 'canal sem credencial configurada',
  quota_exceeded: 'limite do plano atingido',
  busy: 'uma mudança deste contato estava em andamento — tente de novo em instantes',
  not_processed: 'falha inesperada neste envio: nada foi gravado — tente de novo',
  origin_already_approved: 'este pedido de origem já foi aprovado: nada sai de novo por ele',
};

/** Código do provedor não é mensagem: quem atende lê a frase, não o número. */
export const DISPATCH_ERROR_LABEL: Record<string, string> = {
  // o envio do negócio (F4.1c-3): os mesmos motivos da prévia e da aprovação
  ...MOTIVO_DO_ENVIO_DO_NEGOCIO,
  window_closed_needs_template: 'janela de 24h fechada',
  // os três seguintes só aparecem em despacho anterior à F4.1b
  template_requires_consent: 'falta consentimento registrado',
  template_unknown: 'template não aprovado',
  template_params_mismatch: 'parâmetros não correspondem ao template',
  template_flow_unavailable: 'o template não sai pelo envio comum',
  stop_requested: 'a pessoa pediu para parar: nada é enviado a este número',
  // o vertical cancela quando o pedido de origem deixa de valer (F4.2)
  origin_invalidated: 'o pedido de origem deixou de valer antes do envio',
  cancel_requested: 'cancelado antes de sair',
  quota_exceeded: 'limite do plano atingido',
  no_credential: 'canal sem credencial configurada',
  conversation_missing: 'conversa não encontrada',
  message_missing: 'mensagem não encontrada',
  network: 'falha de rede',
  retries_exhausted: 'tentativas esgotadas',
  retries_exhausted_in_flight: 'tentativas esgotadas durante o envio',
  abandoned_before_send: 'envio interrompido antes de sair',
  abandoned_in_flight: 'envio interrompido em andamento',
  no_retrier: 'envio interrompido sem nova tentativa',
  lease_expired_in_flight: 'resultado não confirmado pelo provedor',
  content_restricted: 'mensagem de origem da IA bloqueada: o conteúdo deste contato é restrito',
  restriction_unavailable: 'conferência de restrição indisponível — nova tentativa agendada',
  not_sent_guard_aborted: 'a guarda interrompeu antes do envio, sem cobrança',
  business_outbound_unavailable: 'envio por template indisponível agora',
};
