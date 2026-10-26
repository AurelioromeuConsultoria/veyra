/**
 * POLÍTICA DE ENVIO (ADR-038), como função pura: a decisão é a mesma na criação
 * da mensagem e no worker, imediatamente antes de chamar o provedor.
 *
 * Ser pura é o que permite revalidar duas vezes sem duplicar regra — e revalidar
 * é obrigatório: entre criar a mensagem e o outbox entregá-la, a janela pode
 * fechar e o consentimento pode ser revogado.
 */
export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * As recusas pelo REMETENTE (ADR-052 item 2, decisões de 2026-10-23), iguais
 * em toda ponta: a conversa "remetente a identificar" não recebe resposta, e a
 * identificada só recebe com o número do cadastro do contato de forma EXATA.
 */
export const MENSAGEM_REMETENTE_A_IDENTIFICAR =
  'O remetente desta conversa ainda não foi identificado. Identifique quem escreveu antes de responder.';
export const MENSAGEM_NUMERO_NAO_CONFERE =
  'O número desta conversa não confere, de forma exata, com um telefone do cadastro do contato. Confira o contato antes de responder.';

/**
 * Os templates na transição (ADR-052 item 5, F4.1b): consentimento antigo não
 * autoriza template, e a finalidade verificável só chega na F4.1c. Até lá, o
 * template é recusado no compositor, na API e no worker — com um motivo de
 * indisponibilidade do fluxo, nunca como se a pessoa tivesse revogado.
 */
export const MENSAGEM_TEMPLATE_INDISPONIVEL =
  'O envio por template está indisponível nesta versão, até a finalidade verificável (F4.1c)';

/**
 * O remetente diante do envio: a conversa RAI, a identificada cujo número não
 * confere de forma exata com o cadastro do contato, ou a que confere.
 */
export type RemetenteDoEnvio = 'a_identificar' | 'numero_nao_confere' | 'confere';

export interface SendContext {
  /** última mensagem DO CONTATO; null = o negócio está iniciando a conversa */
  lastInboundAt: Date | null;
  /** o remetente da conversa (ADR-052 item 2) */
  remetente: RemetenteDoEnvio;
  /** há pedido de parar ATIVO para o número, no workspace (C16, F4.1b) */
  bloqueado: boolean;
  /** o envio pede template — indisponível na transição da F4.1b */
  templatePedido: boolean;
  /** endereço externo do destinatário (E.164 que falou com a gente) */
  externalAddress: string | null;
  now: Date;
}

export type SendDecision =
  | { allowed: true; kind: 'free_form' }
  | {
      allowed: false;
      reason:
        | 'window_closed_needs_template'
        | 'template_flow_unavailable'
        | 'no_external_address'
        | 'stop_requested'
        | 'sender_unidentified'
        | 'number_not_exact';
    };

export function decideSend(context: SendContext): SendDecision {
  // sem endereço não há para onde enviar — e escolher um telefone qualquer do
  // contato seria responder para quem não falou com a gente
  if (!context.externalAddress) return { allowed: false, reason: 'no_external_address' };
  // a pessoa pediu para parar: nada sai para o número, em canal nenhum, por
  // contato nenhum (C16). Vem antes do resto para a tela mostrar o bloqueio. A
  // resposta depois do pedido ainda é proposta (ADR-052, F4.1b item 4)
  if (context.bloqueado) return { allowed: false, reason: 'stop_requested' };
  // nem template: sem saber quem escreveu, ou sem o número EXATO no cadastro do
  // contato, responder pode ir a outra pessoa. Aproximação não autoriza envio
  if (context.remetente === 'a_identificar') {
    return { allowed: false, reason: 'sender_unidentified' };
  }
  if (context.remetente === 'numero_nao_confere') {
    return { allowed: false, reason: 'number_not_exact' };
  }

  // template, dentro ou fora da janela: indisponível na transição (F4.1b)
  if (context.templatePedido) return { allowed: false, reason: 'template_flow_unavailable' };

  const insideWindow =
    context.lastInboundAt !== null &&
    context.now.getTime() - context.lastInboundAt.getTime() < SERVICE_WINDOW_MS;

  // dentro da janela, resposta livre é permitida — e não exige consentimento:
  // o contato acabou de falar com a gente (ADR-038)
  if (insideWindow) return { allowed: true, kind: 'free_form' };
  return { allowed: false, reason: 'window_closed_needs_template' };
}

/** Tempo restante da janela, para a interface mostrar antes de o usuário digitar. */
export function windowRemainingMs(lastInboundAt: Date | null, now = new Date()): number {
  if (!lastInboundAt) return 0;
  return Math.max(0, SERVICE_WINDOW_MS - (now.getTime() - lastInboundAt.getTime()));
}
