/**
 * POLÍTICA DE ENVIO (ADR-038), como função pura: a decisão é a mesma na criação
 * da mensagem e no worker, imediatamente antes de chamar o provedor.
 *
 * Ser pura é o que permite revalidar duas vezes sem duplicar regra — e revalidar
 * é obrigatório: entre criar a mensagem e o outbox entregá-la, a janela pode
 * fechar e o consentimento pode ser revogado.
 */
export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface SendContext {
  /** última mensagem DO CONTATO; null = o negócio está iniciando a conversa */
  lastInboundAt: Date | null;
  /** consentimento vigente para este contato e canal */
  hasActiveConsent: boolean;
  /** template pedido no envio, se houver */
  template: { name: string; language: string; paramCount: number } | null;
  /** parâmetros informados para o template */
  templateParams: string[];
  /** endereço externo do destinatário (E.164 que falou com a gente) */
  externalAddress: string | null;
  now: Date;
}

export type SendDecision =
  | { allowed: true; kind: 'free_form' }
  | { allowed: true; kind: 'template' }
  | {
      allowed: false;
      reason:
        | 'window_closed_needs_template'
        | 'template_requires_consent'
        | 'template_unknown'
        | 'template_params_mismatch'
        | 'no_external_address';
    };

export function decideSend(context: SendContext): SendDecision {
  // sem endereço não há para onde enviar — e escolher um telefone qualquer do
  // contato seria responder para quem não falou com a gente
  if (!context.externalAddress) return { allowed: false, reason: 'no_external_address' };

  const insideWindow =
    context.lastInboundAt !== null &&
    context.now.getTime() - context.lastInboundAt.getTime() < SERVICE_WINDOW_MS;

  // dentro da janela, resposta livre é permitida — e não exige consentimento:
  // o contato acabou de falar com a gente (ADR-038)
  if (insideWindow && !context.template) return { allowed: true, kind: 'free_form' };

  if (!context.template) return { allowed: false, reason: 'window_closed_needs_template' };

  // com template: exige consentimento, mesmo dentro da janela — template é
  // formato de mensagem iniciada pelo negócio
  if (!context.hasActiveConsent) return { allowed: false, reason: 'template_requires_consent' };
  if (context.templateParams.length !== context.template.paramCount) {
    return { allowed: false, reason: 'template_params_mismatch' };
  }
  return { allowed: true, kind: 'template' };
}

/** Tempo restante da janela, para a interface mostrar antes de o usuário digitar. */
export function windowRemainingMs(lastInboundAt: Date | null, now = new Date()): number {
  if (!lastInboundAt) return 0;
  return Math.max(0, SERVICE_WINDOW_MS - (now.getTime() - lastInboundAt.getTime()));
}
