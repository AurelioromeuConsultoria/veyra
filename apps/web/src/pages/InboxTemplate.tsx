import { useMutation, useQuery } from '@tanstack/react-query';
import type {
  BusinessOutboundPreviewDto,
  BusinessOutboundReason,
  BusinessOutboundResultDto,
  TemplateOptionDto,
} from '@veyra/contracts';
import { useState } from 'react';
import { Button } from '../components/ui/button';
import { Select } from '../components/ui/input';
import { api, ApiError } from '../lib/api';

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
};

const chaveDaOpcao = (o: TemplateOptionDto) => `${o.templateVersionId}:${o.purposeId}`;

/**
 * O template com a janela fechada (ADR-052 itens 6 a 8, F4.1c-3): só as
 * versões revisadas para uma finalidade que o número da conversa consentiu, e
 * só pela PRÉVIA — o texto exato que sai, com o nome do contato vindo do
 * servidor. Aprovar manda o hash da prévia: se algo mudou desde então, o
 * servidor recusa com o motivo, e nada é atualizado em silêncio. O alvo vem
 * pronto do servidor; a tela não monta destinatário nem digita parâmetro.
 *
 * A chave de idempotência nasce com a prévia: repetir a aprovação da MESMA
 * prévia (a rede caiu) devolve o resultado guardado, sem segunda mensagem.
 */
export function TemplatePanel({
  conversationId,
  podeVer,
  onSent,
}: {
  conversationId: string;
  /** `contacts:read` e `consents:read`: a prévia mostra o nome e revela a finalidade */
  podeVer: boolean;
  onSent: () => void;
}) {
  const [escolhida, setEscolhida] = useState('');
  const [previa, setPrevia] = useState<{
    opcao: TemplateOptionDto;
    item: Extract<BusinessOutboundPreviewDto['items'][number], { ok: true }>;
    chave: string;
  } | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  /**
   * A aprovação falhou sem resposta definitiva (rede, 5xx, ainda em
   * processamento): ela PODE ter comitado. Uma prévia nova teria outro hash e
   * outra chave, e sairia uma segunda mensagem — então a tela só deixa repetir
   * a MESMA aprovação, que o servidor deduplica.
   */
  const [incerto, setIncerto] = useState(false);

  const opcoes = useQuery({
    queryKey: ['template-options', conversationId],
    queryFn: () =>
      api.get<TemplateOptionDto[]>(
        `/api/business-outbound/options?conversationId=${conversationId}`,
      ),
    enabled: podeVer,
  });
  const opcao = opcoes.data?.find((o) => chaveDaOpcao(o) === escolhida) ?? null;

  const verPrevia = useMutation({
    mutationFn: (o: TemplateOptionDto) =>
      api.post<BusinessOutboundPreviewDto>('/api/business-outbound/preview', {
        items: [o.target],
      }),
    onSuccess: (res, o) => {
      const [item] = res.items;
      if (item.ok) {
        setPrevia({ opcao: o, item, chave: crypto.randomUUID() });
        setAviso(null);
      } else {
        setPrevia(null);
        setAviso(MOTIVO_DO_ENVIO_DO_NEGOCIO[item.reason]);
      }
    },
    onError: (e) => setAviso(e instanceof ApiError ? e.message : 'Falha ao gerar a prévia'),
  });

  const aprovar = useMutation({
    mutationFn: (p: NonNullable<typeof previa>) =>
      api.postIdempotente<BusinessOutboundResultDto>(
        '/api/business-outbound',
        {
          items: [
            { ...p.opcao.target, expiresAt: p.item.expiresAt, approvalHash: p.item.approvalHash },
          ],
        },
        p.chave,
      ),
    onSuccess: (res, p) => {
      const [r] = res.items;
      setIncerto(false);
      if (r.state === 'approved') {
        setPrevia(null);
        setEscolhida('');
        setAviso('Aprovado: o envio sai em instantes, com a conferência de novo antes de sair.');
        onSent();
        return;
      }
      setAviso(r.reason ? MOTIVO_DO_ENVIO_DO_NEGOCIO[r.reason] : 'Envio não aprovado');
      /**
       * A recusa TRANSITÓRIA (a espera pela trava, a falha inesperada) mantém a
       * mesma prévia, só com chave nova: o servidor tem uma aprovação por
       * prévia, e repetir não gera segunda mensagem. As outras pedem uma
       * prévia nova, porque algo do que a pessoa viu mudou.
       */
      if (r.reason === 'busy' || r.reason === 'not_processed') {
        setPrevia({ ...p, chave: crypto.randomUUID() });
      } else {
        setPrevia(null);
      }
    },
    onError: (e) => {
      // 4xx definitivo (a não ser o 409 de "em processamento"): nada foi gravado
      const definitivo =
        e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 409;
      setIncerto(!definitivo);
      // incerto: recarrega a conversa, para a pessoa ver se a mensagem saiu
      if (!definitivo) onSent();
      setAviso(
        definitivo
          ? e.message
          : 'O resultado da aprovação não chegou. Repita a aprovação desta prévia: ela não gera uma segunda mensagem.',
      );
    },
  });

  if (!podeVer) {
    return (
      <p className="mb-2.5 text-data text-muted-fg" data-testid="template-composer">
        Com a janela fechada, o envio é por template — e a prévia exige ver o contato e os
        consentimentos.
      </p>
    );
  }
  return (
    <div className="mb-2.5 space-y-1.5" data-testid="template-composer">
      {opcoes.isError ? (
        <p className="text-data text-negative">Não foi possível carregar os templates.</p>
      ) : opcoes.data && opcoes.data.length === 0 ? (
        <p className="text-data text-muted-fg">
          Nenhum template revisado para uma finalidade que este número consentiu.
        </p>
      ) : (
        <div className="flex items-center gap-2">
          <Select
            full
            aria-label="Template revisado"
            value={escolhida}
            disabled={incerto}
            onChange={(e) => {
              setEscolhida(e.target.value);
              setPrevia(null);
              setAviso(null);
            }}
          >
            <option value="">Escolha um template revisado…</option>
            {opcoes.data?.map((o) => (
              <option key={chaveDaOpcao(o)} value={chaveDaOpcao(o)}>
                {o.name} ({o.language}) v{o.version} · {o.purposeDescription}
              </option>
            ))}
          </Select>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={!opcao || verPrevia.isPending || incerto}
            onClick={() => opcao && verPrevia.mutate(opcao)}
          >
            Ver prévia
          </Button>
        </div>
      )}
      {previa ? (
        <div className="space-y-1.5 rounded-sm border border-border bg-surface-2 px-2.5 py-2">
          <p className="whitespace-pre-wrap text-data" data-testid="template-preview">
            {previa.item.text}
          </p>
          <div className="flex items-center justify-between gap-2">
            <span className="text-data text-muted-fg">
              Vale até {new Date(previa.item.expiresAt).toLocaleTimeString('pt-BR')}
            </span>
            <Button
              type="button"
              size="sm"
              variant="primary"
              disabled={aprovar.isPending}
              onClick={() => aprovar.mutate(previa)}
            >
              Aprovar e enviar
            </Button>
          </div>
        </div>
      ) : null}
      {aviso ? (
        <p className="text-data text-muted-fg" role="status">
          {aviso}
        </p>
      ) : null}
    </div>
  );
}
