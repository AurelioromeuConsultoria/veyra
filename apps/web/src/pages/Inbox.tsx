import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AiConsentDto,
  ConsentStatus,
  ConversationSummaryDto,
  ConversationDto,
  ConversationPageDto,
  ConversationStatus,
  FileObjectDto,
  MessageDispatchState,
  MessageDto,
  MessagePageDto,
  ReplySuggestionDto,
  SendPolicyDto,
} from '@veyra/contracts';
import { clsx } from 'clsx';
import { Check, MessageSquarePlus, Paperclip, Send, Sparkles, WandSparkles, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AiPanel, AiSeal } from '../components/ui/ai';
import { Button } from '../components/ui/button';
import { Input, Select, Textarea } from '../components/ui/input';
import { EmptyState } from '../components/ui/page';
import { WindowChip, WindowMeter } from '../components/ui/window-meter';
import { api, ApiError, toQuery } from '../lib/api';
import { dayLabel, fullStamp, relativeStamp, timeOfDay } from '../lib/format';
import { hasPermission, useSession } from '../lib/session';

const statusLabels: Record<ConversationStatus, string> = {
  open: 'Aberta',
  pending: 'Pendente',
  closed: 'Fechada',
};

/**
 * Estado do despacho externo. Sem isto, uma mensagem que a Meta recusou (ou que
 * ficou incerta) parecia enviada para quem a escreveu. `unknown_after_dispatch`
 * é o caso que mais pede olho humano — nunca reenviamos por conta própria.
 */
const DISPATCH_LABEL: Record<MessageDispatchState, { texto: string; tom: string } | null> = {
  reserved: { texto: 'Enviando…', tom: 'text-muted-fg' },
  sending: { texto: 'Enviando…', tom: 'text-muted-fg' },
  sent: null, // o caminho feliz não merece ruído visual
  failed_before_send: { texto: 'Aguardando nova tentativa', tom: 'text-muted-fg' },
  failed_permanent: { texto: 'Não enviada', tom: 'text-negative' },
  unknown_after_dispatch: { texto: 'Entrega não confirmada', tom: 'text-warning' },
};

/**
 * Estado do canal externo acima do compositor: opt-in e o motivo quando o envio
 * está bloqueado. É o que evita o atendente descobrir a regra pelo erro.
 *
 * O TEMPO restante não se repete aqui: ele é o medidor de janela sob o
 * cabeçalho da conversa (assinatura visual). Só a janela FECHADA reaparece
 * junto do compositor, porque nesse estado ela é a condição que bloqueia.
 */
function PolicyBanner({ policy }: { policy: SendPolicyDto }) {
  const fechada =
    policy.windowExpiresAt === null || new Date(policy.windowExpiresAt).getTime() - Date.now() <= 0;
  return (
    <div
      className="mb-2.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-data-sm"
      data-testid="send-policy"
    >
      {fechada ? (
        <span className="num rounded-sm bg-warning/12 px-1.5 py-0.5 text-warning">
          janela fechada
        </span>
      ) : null}
      <ConsentBadge status={policy.consentStatus} />
      {policy.reason ? (
        <span className={clsx(policy.mode === 'blocked' ? 'text-negative' : 'text-muted-fg')}>
          {policy.reason}
        </span>
      ) : null}
    </div>
  );
}

/** Opt-in é evidência SEPARADA da janela (ADR-038) — a tela não pode fundir os dois. */
function ConsentBadge({ status }: { status: ConsentStatus | null }) {
  if (status === null) return null;
  const rotulo =
    status === 'granted'
      ? { texto: 'opt-in registrado', tom: 'text-positive' }
      : status === 'revoked'
        ? { texto: 'opt-in revogado', tom: 'text-negative' }
        : { texto: 'sem opt-in', tom: 'text-muted-fg' };
  return (
    <span className={clsx('num rounded-sm bg-surface-2 px-1.5 py-0.5', rotulo.tom)}>
      {rotulo.texto}
    </span>
  );
}

/** Código do provedor não é mensagem: quem atende lê a frase, não o número. */
const DISPATCH_ERROR_LABEL: Record<string, string> = {
  window_closed_needs_template: 'janela de 24h fechada — use um template',
  template_requires_consent: 'falta consentimento registrado',
  template_unknown: 'template não aprovado',
  template_params_mismatch: 'parâmetros não correspondem ao template',
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
};

/**
 * O incerto que a guarda PROVOU não ter saído (ADR-047 adendo 7 §9, G3.2): o
 * estado continua `unknown_after_dispatch` — sem reenvio automático, limite
 * aceito —, mas quem tria não pode confundi-lo com uma entrega desconhecida.
 */
const NAO_SAIU = { texto: 'Não saiu', tom: 'text-negative' };

export function DispatchBadge({
  state,
  error,
}: {
  state: MessageDispatchState;
  error: string | null;
}) {
  const rotulo =
    state === 'unknown_after_dispatch' && error === 'not_sent_guard_aborted'
      ? NAO_SAIU
      : DISPATCH_LABEL[state];
  if (!rotulo) return null;
  // código desconhecido não vira texto na cara do usuário: some em silêncio
  const motivo = error ? DISPATCH_ERROR_LABEL[error] : undefined;
  return (
    <span className={clsx('num text-data-xs', rotulo.tom)}>
      {rotulo.texto}
      {motivo ? ` · ${motivo}` : ''}
    </span>
  );
}

export function InboxPage() {
  const { data: user } = useSession();
  const canWrite = hasPermission(user, 'conversations:write');
  const canUseAi = hasPermission(user, 'intelligence:use');
  /**
   * O rascunho nasce do corpo das mensagens: TODA consulta de sugestão exige
   * `conversations:read` no servidor. Sem checar aqui, um papel customizado com
   * `intelligence:use` e sem leitura de conversa disparava consultas que
   * voltavam 403 — erro silencioso, que a tela não sabia explicar.
   */
  const canReadConversations = hasPermission(user, 'conversations:read');
  const canReadWorkspace = hasPermission(user, 'workspace:read');
  /** enviar rascunho de IA exige as DUAS: aprovar IA e responder (ADR-044.9) */
  const canApproveReply = hasPermission(user, 'intelligence:approve') && canWrite;
  /**
   * GERAR também exige responder: o rascunho novo supersede o pendente e
   * invalida o trabalho que outra pessoa poderia aprovar (ADR-044, adendo 3).
   */
  const canSuggestReply = canUseAi && canReadConversations && canWrite;
  const queryClient = useQueryClient();

  /**
   * `?c=<id>` é o caminho de ENTRADA vindo de fora do inbox (a visão Hoje leva
   * a janela que está fechando direto para a conversa dela). Sem isso, "abrir
   * o inbox" deixava a pessoa procurando na lista aquilo que a tela anterior
   * já sabia apontar.
   */
  const [searchParams, setSearchParams] = useSearchParams();
  const deepLink = searchParams.get('c');
  const [status, setStatus] = useState<'open' | 'pending' | 'closed' | 'all'>('open');
  const [selectedId, setSelectedId] = useState<string | null>(deepLink);
  /** id vindo de fora que ainda não foi localizado na lista carregada */
  const [linking, setLinking] = useState<string | null>(deepLink);
  const [draft, setDraft] = useState('');
  /** template escolhido no compositor, quando a janela exige um */
  const [templateName, setTemplateName] = useState('');
  const [templateParams, setTemplateParams] = useState<string[]>([]);
  const [attachments, setAttachments] = useState<FileObjectDto[]>([]);
  const [summary, setSummary] = useState<ConversationSummaryDto | null>(null);
  /** rascunho da IA em revisão: editável ANTES de aprovar (ADR-044) */
  const [reply, setReply] = useState<{
    proposalId: string;
    body: string;
    injection: boolean;
  } | null>(null);
  /** motivo de indisponibilidade — sempre o texto que o SERVIDOR mandou */
  const [replyNotice, setReplyNotice] = useState<string | null>(null);
  const [subject, setSubject] = useState('');
  const [error, setError] = useState<string | null>(null);

  /**
   * O parâmetro é consumido UMA vez e sai da URL: mantido, ele reabriria a
   * conversa antiga a cada troca de seleção, e a barra de endereços passaria a
   * mentir sobre o que está na tela.
   */
  useEffect(() => {
    if (!deepLink) return;
    setSelectedId(deepLink);
    setLinking(deepLink);
    setSearchParams(
      (params) => {
        params.delete('c');
        return params;
      },
      { replace: true },
    );
  }, [deepLink, setSearchParams]);

  const listParams = { status, limit: 50 };
  const conversations = useQuery({
    queryKey: ['conversations', listParams],
    queryFn: () => api.get<ConversationPageDto>(`/api/conversations${toQuery(listParams)}`),
    placeholderData: keepPreviousData,
  });
  const items = conversations.data?.items ?? [];
  const selected = items.find((c) => c.id === selectedId) ?? null;

  /**
   * A conversa apontada de fora pode não caber no filtro corrente — uma proposta
   * de IA vive numa conversa que talvez esteja "pendente". Em vez de abrir uma
   * área vazia sem explicação, o filtro se abre para "todas" UMA vez, e só
   * enquanto o link de entrada ainda não foi resolvido: trocar de filtro à mão
   * depois disso continua valendo.
   */
  useEffect(() => {
    if (!linking || !conversations.isSuccess) return;
    if (items.some((c) => c.id === linking) || status === 'all') {
      setLinking(null);
      return;
    }
    setStatus('all');
  }, [linking, conversations.isSuccess, items, status]);

  /** resumo já GRAVADO da conversa: aparece sem custar um run novo */
  const savedSummary = useQuery({
    queryKey: ['ai-summary', selectedId],
    queryFn: () =>
      api.get<ConversationSummaryDto | null>(
        `/api/intelligence/conversations/${selectedId}/summary`,
      ),
    // mesma regra do rascunho: a rota do resumo é `intelligence:use` +
    // `conversations:read`, e a tela não pode pedir o que o servidor negará
    enabled: selectedId !== null && canUseAi && canReadConversations,
  });

  /**
   * Consentimento de conteúdo é fato do SERVIDOR (ADR-028): a tela precisa dele
   * para explicar a indisponibilidade ANTES do clique, em vez de deixar o
   * atendente descobrir pelo resultado de um run recusado.
   */
  const aiConsent = useQuery({
    queryKey: ['ai-consent'],
    queryFn: () => api.get<AiConsentDto>('/api/intelligence/consent'),
    // a rota de consentimento é `workspace:read` — não presuma que todo papel a tem
    enabled: canUseAi && canReadWorkspace,
  });

  /** rascunho pendente já gerado: a tela reabre onde parou, sem custar token */
  const pendingReply = useQuery({
    queryKey: ['ai-reply', selectedId],
    queryFn: () =>
      api.get<ReplySuggestionDto | null>(
        `/api/intelligence/conversations/${selectedId}/reply-suggestion`,
      ),
    enabled: selectedId !== null && canUseAi && canReadConversations,
  });

  const messages = useQuery({
    queryKey: ['messages', selectedId],
    queryFn: () => api.get<MessagePageDto>(`/api/conversations/${selectedId}/messages?limit=50`),
    enabled: selectedId !== null,
  });

  /**
   * O que pode ser enviado agora vem do SERVIDOR. A tela não recalcula janela
   * nem consentimento: ela não vê opt-in revogado nem recibo atrasado, e uma
   * segunda implementação da política divergiria da que o worker aplica.
   */
  const policy = useQuery({
    queryKey: ['send-policy', selectedId],
    queryFn: () => api.get<SendPolicyDto>(`/api/conversations/${selectedId}/send-policy`),
    enabled: selectedId !== null && canWrite,
    /**
     * Revalida quando a janela expira — é por isso que o servidor manda o
     * INSTANTE. Sem isto, quem abrisse a conversa com 4 minutos restantes
     * escrevia com calma, via "janela 0h01" na tela, e recebia 400 no envio:
     * o botão era governado por um cache que não envelhecia.
     */
    /**
     * Revalida PERTO da expiração, não de minuto em minuto: com 23h de janela
     * restante, pesquisar a cada 60s eram cinco consultas por minuto no servidor
     * sem nenhuma decisão nova. Perto do fim, o intervalo aperta.
     */
    refetchInterval: (query) => {
      const expira = query.state.data?.windowExpiresAt;
      if (!expira) return false;
      const restante = new Date(expira).getTime() - Date.now();
      if (restante <= 0) return false;
      if (restante < 60_000) return restante + 1_000;
      return Math.min(Math.max(restante / 4, 60_000), 15 * 60_000);
    },
    // a aba que volta do background pode estar mostrando janela já fechada
    refetchOnWindowFocus: true,
  });
  /**
   * FAIL-CLOSED enquanto a política não chegou: em canal externo, `free_form`
   * por omissão mostrava compositor livre e botão habilitado numa conversa de
   * janela fechada, e o 400 vinha depois. Canal interno não tem política a
   * esperar.
   */
  const externo = selected !== null && selected.channelType !== 'internal';
  const modo: SendPolicyDto['mode'] = policy.data?.mode ?? (externo ? 'blocked' : 'free_form');
  /**
   * Chave é (nome, IDIOMA). O catálogo da Meta permite o mesmo nome em idiomas
   * diferentes (`@@unique(workspaceId, channelId, name, language)`), e resolver
   * só pelo nome tornava a segunda opção inselecionável, mandava o idioma do
   * primeiro achado e podia renderizar a quantidade errada de parâmetros.
   */
  const template =
    policy.data?.templates.find((t) => `${t.name}:${t.language}` === templateName) ?? null;
  /**
   * Itera os ÍNDICES do template, não o array: ele é preenchido por posição e
   * tem buracos (preencher o campo 2 antes do 1 deixa `[undefined, 'x']`).
   * `filter(p => p.trim())` estourava `TypeError` no render e derrubava o inbox.
   */
  const paramsCompletos =
    template === null ||
    Array.from({ length: template.paramCount }).every((_, i) => templateParams[i]?.trim());

  /**
   * Trocar de conversa ZERA o compositor. Sem isto, o template e o parâmetro da
   * conversa A chegavam prontos e habilitados na conversa B — um Enter mandaria
   * para o contato B o horário combinado com o contato A. O rascunho e os anexos
   * são a mesma classe de erro e vão junto.
   */
  useEffect(() => {
    setTemplateName('');
    setTemplateParams([]);
    setDraft('');
    setAttachments([]);
    setError(null);
    setReply(null);
    setReplyNotice(null);
  }, [selectedId]);

  /**
   * Semeia o painel com o rascunho que o servidor já tem. Só quando NÃO há um
   * em revisão: sobrescrever apagaria a edição em curso do atendente.
   */
  useEffect(() => {
    const pendente = pendingReply.data;
    if (!pendente || pendente.status !== 'proposed' || !pendente.proposalId) return;
    setReply((atual) =>
      atual
        ? atual
        : {
            proposalId: pendente.proposalId as string,
            body: pendente.draft ?? '',
            injection: pendente.injectionAttempt ?? false,
          },
    );
  }, [pendingReply.data]);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['conversations'] });
    void queryClient.invalidateQueries({ queryKey: ['messages'] });
    /**
     * A política muda com o que acabou de acontecer: um envio pode ter esgotado
     * a cota. Registro MANUAL de mensagem recebida NÃO reabre a janela — só a
     * ingestão assinada escreve `lastInboundAt`, porque um texto digitado por um
     * atendente não é evidência de que o contato falou no canal (ADR-038).
     */
    void queryClient.invalidateQueries({ queryKey: ['send-policy'] });
  };

  const createConversation = useMutation({
    mutationFn: () => api.post<ConversationDto>('/api/conversations', { subject: subject.trim() }),
    onSuccess: (created) => {
      setSubject('');
      setError(null);
      setSelectedId(created.id);
      invalidate();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Falha ao criar conversa'),
  });

  const attach = useMutation({
    mutationFn: (file: File) => api.upload<FileObjectDto>('/api/files', file),
    onSuccess: (file) => {
      setAttachments((current) => [...current, file]);
      setError(null);
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Falha ao enviar arquivo'),
  });

  const send = useMutation({
    mutationFn: (direction: 'inbound' | 'outbound') =>
      api.post<MessageDto>(`/api/conversations/${selectedId}/messages`, {
        direction,
        body: draft.trim(),
        ...(modo === 'template' && template
          ? {
              template: {
                name: template.name,
                language: template.language,
                params: templateParams.slice(0, template.paramCount),
              },
            }
          : {}),
        attachmentIds: attachments.map((file) => file.id),
      }),
    onSuccess: () => {
      setDraft('');
      setAttachments([]);
      setError(null);
      invalidate();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Falha ao registrar mensagem'),
  });

  /** Predicado ÚNICO de "pode enviar": botão e submissão do form usam este. */
  const podeEnviar =
    draft.trim().length > 0 &&
    !send.isPending &&
    modo !== 'blocked' &&
    (modo !== 'template' || (template !== null && paramsCompletos));

  /** Resumo é sinal, não chat: aparece no contexto da conversa e some com ela. */
  const summarize = useMutation({
    mutationFn: () =>
      api.post<ConversationSummaryDto>(`/api/intelligence/conversations/${selectedId}/summary`),
    onSuccess: (result) => {
      setSummary(result);
      void queryClient.invalidateQueries({ queryKey: ['ai-summary'] });
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Falha ao resumir'),
  });

  /**
   * Gera o rascunho. A IA não envia nada: o resultado é uma PROPOSTA pendente
   * que uma pessoa lê, edita e aprova (ADR-044).
   */
  const suggestReply = useMutation({
    mutationFn: () =>
      api.post<ReplySuggestionDto>(
        `/api/intelligence/conversations/${selectedId}/reply-suggestion`,
      ),
    onSuccess: (result) => {
      if (result.status === 'proposed' && result.proposalId) {
        setReply({
          proposalId: result.proposalId,
          body: result.draft ?? '',
          injection: result.injectionAttempt ?? false,
        });
        setReplyNotice(null);
      } else {
        setReply(null);
        // o motivo vem do servidor: a tela não deduz janela, consentimento nem cota
        setReplyNotice(result.reason ?? 'Sugestão indisponível agora');
      }
      void queryClient.invalidateQueries({ queryKey: ['ai-reply'] });
      void queryClient.invalidateQueries({ queryKey: ['ai-proposals'] });
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Falha ao sugerir resposta'),
  });

  const approveReply = useMutation({
    // o corpo enviado é o que está NA TELA: o servidor compara com o rascunho
    // original e decide a autoria da mensagem (IA ou quem editou)
    mutationFn: () =>
      api.post<{ messageId: string }>(
        `/api/intelligence/proposals/${reply?.proposalId}/approve-reply`,
        { body: reply?.body.trim() },
      ),
    onSuccess: () => {
      setReply(null);
      setReplyNotice(null);
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['ai-reply'] });
      void queryClient.invalidateQueries({ queryKey: ['ai-proposals'] });
      invalidate();
    },
    onError: (e) => {
      // política pode ter mudado entre gerar e aprovar: a proposta CONTINUA
      // pendente, e o motivo do servidor é o que aparece
      setError(e instanceof ApiError ? e.message : 'Falha ao enviar a resposta sugerida');
      void queryClient.invalidateQueries({ queryKey: ['send-policy'] });
      // pode ter sido superseded por um rascunho novo: recarrega o pendente
      // atual em vez de deixar a tela segurando um id morto
      setReply(null);
      void queryClient.invalidateQueries({ queryKey: ['ai-reply'] });
    },
  });

  const rejectReply = useMutation({
    // rota própria: descartar rascunho exige as MESMAS permissões cumulativas
    // de aprová-lo (ADR-044, adendo 2)
    mutationFn: () =>
      api.post<{ ok: true }>(`/api/intelligence/proposals/${reply?.proposalId}/reject-reply`),
    onSuccess: () => {
      setReply(null);
      setReplyNotice(null);
      void queryClient.invalidateQueries({ queryKey: ['ai-reply'] });
      void queryClient.invalidateQueries({ queryKey: ['ai-proposals'] });
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Falha ao descartar o rascunho'),
  });

  const changeStatus = useMutation({
    mutationFn: (next: ConversationStatus) =>
      api.patch<ConversationDto>(`/api/conversations/${selectedId}`, { status: next }),
    onSuccess: () => invalidate(),
  });

  // rola para a mensagem mais recente quando a conversa muda ou chega mensagem
  const threadRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight });
  }, [messages.data]);

  // do mais recente para o mais antigo no servidor; a leitura é cronológica
  const thread = [...(messages.data?.items ?? [])].reverse();
  // o resumo recém-gerado tem precedência sobre o gravado
  const shownSummary =
    summary ?? (savedSummary.data && savedSummary.data.status === 'ok' ? savedSummary.data : null);

  /**
   * Agrupamento por AUTOR: repetir nome e data completa em toda mensagem
   * transformava a thread num relatório. Um bloco por autor, hora por mensagem
   * — e a quebra também acontece quando passa muito tempo ou vira o dia.
   */
  const groups: {
    key: string;
    day: string;
    direction: MessageDto['direction'];
    authorType: MessageDto['authorType'];
    authorName: string | null;
    messages: MessageDto[];
  }[] = [];
  for (const message of thread) {
    const anterior = groups.at(-1);
    const mesmoDia =
      anterior !== undefined &&
      new Date(anterior.messages.at(-1)!.createdAt).toDateString() ===
        new Date(message.createdAt).toDateString();
    const proximoNoTempo =
      anterior !== undefined &&
      new Date(message.createdAt).getTime() -
        new Date(anterior.messages.at(-1)!.createdAt).getTime() <
        15 * 60_000;
    if (
      anterior &&
      mesmoDia &&
      proximoNoTempo &&
      anterior.direction === message.direction &&
      anterior.authorType === message.authorType &&
      anterior.authorName === message.authorName
    ) {
      anterior.messages.push(message);
    } else {
      groups.push({
        key: message.id,
        day: new Date(message.createdAt).toDateString(),
        direction: message.direction,
        authorType: message.authorType,
        authorName: message.authorName,
        messages: [message],
      });
    }
  }

  return (
    <div className="flex h-full">
      {/* ── lista densa ─────────────────────────────────────────────────── */}
      <div className="flex w-[19.5rem] shrink-0 flex-col border-r border-border bg-surface">
        <header className="flex items-center gap-2 border-b border-border px-4 py-3.5">
          <h1 className="mr-auto text-display-sm">Inbox</h1>
          <Select
            size="sm"
            value={status}
            onChange={(e) => setStatus(e.target.value as typeof status)}
            aria-label="Filtrar por status"
          >
            <option value="open">Abertas</option>
            <option value="pending">Pendentes</option>
            <option value="closed">Fechadas</option>
            <option value="all">Todas</option>
          </Select>
        </header>

        {canWrite ? (
          <form
            className="flex gap-1.5 border-b border-border px-3 py-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (subject.trim()) createConversation.mutate();
            }}
          >
            <Input
              className="h-8 text-data"
              placeholder="Nova conversa…"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              aria-label="Assunto da nova conversa"
            />
            <Button
              type="submit"
              size="icon"
              variant="secondary"
              disabled={!subject.trim() || createConversation.isPending}
              aria-label="Criar conversa"
            >
              <MessageSquarePlus size={14} />
            </Button>
          </form>
        ) : null}

        <ul className="min-h-0 flex-1 overflow-auto">
          {items.map((conversation) => {
            const ativa = conversation.id === selectedId;
            const titulo = conversation.contactName ?? conversation.subject ?? 'Sem assunto';
            // legenda: o assunto quando há contato, o aviso quando não há
            const legenda = conversation.contactName
              ? conversation.subject
              : conversation.subject
                ? 'Sem contato'
                : null;
            return (
              <li key={conversation.id}>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedId(conversation.id);
                    setSummary(null);
                  }}
                  aria-current={ativa}
                  className={clsx(
                    'relative w-full border-b border-border/70 py-2.5 pl-4 pr-3 text-left transition-colors duration-150',
                    ativa ? 'bg-surface-2' : 'hover:bg-surface-2/60',
                  )}
                >
                  <span
                    aria-hidden
                    className={clsx(
                      'absolute inset-y-0 left-0 w-0.5',
                      ativa ? 'bg-accent' : 'bg-transparent',
                    )}
                  />
                  <div className="flex items-baseline gap-2">
                    <span className="min-w-0 flex-1 truncate text-body-sm font-medium">
                      {titulo}
                    </span>
                    {/* UM carimbo de tempo, relativo: data completa competia
                        com o nome do contato */}
                    <span className="num shrink-0 text-data-sm text-muted-fg">
                      {relativeStamp(conversation.lastMessageAt)}
                    </span>
                  </div>
                  {legenda ? (
                    <p className="mt-0.5 truncate text-data text-muted-fg">{legenda}</p>
                  ) : null}
                  <div className="mt-1.5 flex items-center gap-1.5">
                    {conversation.channelType !== 'internal' ? (
                      <span className="eyebrow rounded-sm bg-surface-2 px-1 py-px text-muted-fg">
                        {conversation.channelType}
                      </span>
                    ) : null}
                    {/* janela na LINHA serve triagem: quem está perto de fechar
                        é quem precisa de resposta agora */}
                    <WindowChip expiresAt={conversation.windowExpiresAt} />
                    {conversation.status !== 'open' ? (
                      <span className="eyebrow ml-auto text-muted-fg">
                        {statusLabels[conversation.status]}
                      </span>
                    ) : null}
                  </div>
                </button>
              </li>
            );
          })}
          {conversations.data && items.length === 0 ? (
            <li>
              <EmptyState
                title="Nenhuma conversa aqui."
                hint="Troque o filtro de status ou abra uma conversa nova."
              />
            </li>
          ) : null}
        </ul>
      </div>

      {/* ── conversa ────────────────────────────────────────────────────── */}
      {selected ? (
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex items-center gap-3 border-b border-border bg-surface px-6 py-3">
            <div className="mr-auto min-w-0">
              <h2 className="truncate text-display-sm">
                {selected.contactName ?? selected.subject ?? 'Conversa'}
              </h2>
              <p className="mt-0.5 flex items-center gap-2 truncate text-data text-muted-fg">
                {selected.contactName && selected.subject ? (
                  <span className="truncate">{selected.subject}</span>
                ) : null}
                <span className="eyebrow rounded-sm bg-surface-2 px-1 py-px">
                  {selected.channelType}
                </span>
                {selected.assigneeName ? <span>{selected.assigneeName}</span> : null}
              </p>
            </div>
            {canUseAi && canReadConversations ? (
              <Button
                size="sm"
                variant="ai"
                disabled={summarize.isPending}
                onClick={() => summarize.mutate()}
              >
                <Sparkles size={13} /> {summarize.isPending ? 'Resumindo…' : 'Resumir'}
              </Button>
            ) : null}
            {canWrite ? (
              <Select
                size="sm"
                value={selected.status}
                onChange={(e) => changeStatus.mutate(e.target.value as ConversationStatus)}
                aria-label="Status da conversa"
              >
                {Object.entries(statusLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </Select>
            ) : null}
          </header>

          {/* ASSINATURA: a janela de 24h como medidor, não como texto de debug */}
          {policy.data && policy.data.channelType !== 'internal' ? (
            <WindowMeter expiresAt={policy.data.windowExpiresAt} />
          ) : null}

          {shownSummary ? (
            shownSummary.status === 'ok' ? (
              <AiPanel
                title={`Resumo · ${shownSummary.sentiment}`}
                className="border-b border-border"
              >
                <p className="text-body-sm">{shownSummary.summary}</p>
                {shownSummary.pendencies && shownSummary.pendencies.length > 0 ? (
                  <ul className="mt-2 space-y-1">
                    {shownSummary.pendencies.map((item) => (
                      <li key={item} className="flex gap-2 text-data text-muted-fg">
                        <span aria-hidden className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-ai" />
                        {item}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {shownSummary.injectionAttempt ? (
                  <p className="mt-2 text-data text-warning">
                    Atenção: o conteúdo desta conversa tentou dar instruções ao assistente.
                  </p>
                ) : null}
              </AiPanel>
            ) : (
              <AiPanel title="Resumo indisponível" className="border-b border-border">
                <p className="text-body-sm text-muted-fg">
                  {shownSummary.status === 'no_consent'
                    ? 'Resumo indisponível: o workspace não autorizou o uso de conteúdo de conversa (ajuste em Sinais).'
                    : shownSummary.status === 'content_restricted'
                      ? 'Resumo indisponível: a IA não é usada com o conteúdo deste contato.'
                      : 'Resumo indisponível no momento.'}
                </p>
              </AiPanel>
            )
          ) : null}

          {/* mensagens ancoradas embaixo (convenção de conversa); o topo do
              bloco é um MARCO REAL — quando toda a história está carregada, a
              data em que a conversa nasceu; quando não está, o aviso de que só
              a página mais recente está em tela. Sem isso, a thread curta
              começava no meio de um vazio sem explicação. */}
          <div ref={threadRef} className="min-h-0 flex-1 overflow-auto px-6 py-5">
            <div className="flex min-h-full flex-col justify-end gap-4">
              {thread.length > 0 ? (
                <div className="flex flex-col items-center gap-0.5 text-center">
                  {messages.data?.nextCursor ? (
                    <>
                      <span className="text-body-sm text-muted-fg">
                        Histórico mais antigo não carregado
                      </span>
                      <span className="num text-data text-muted-fg">
                        em tela: as {thread.length} mensagens mais recentes
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="text-body-sm text-muted-fg">Início da conversa</span>
                      <span className="num text-data text-muted-fg">
                        criada em {fullStamp(selected.createdAt)}
                        {selected.channelType !== 'internal' ? ` · ${selected.channelType}` : ''}
                      </span>
                    </>
                  )}
                </div>
              ) : null}
              {groups.map((group, index) => {
                const saida = group.direction === 'outbound';
                const daIa = group.authorType === 'ai';
                const novoDia = index === 0 || groups[index - 1].day !== group.day;
                return (
                  <div key={group.key} className="space-y-2">
                    {novoDia ? (
                      <div className="flex items-center gap-3 pb-1 pt-2">
                        <span aria-hidden className="h-px flex-1 bg-border" />
                        <span className="eyebrow text-muted-fg">
                          {dayLabel(group.messages[0].createdAt)}
                        </span>
                        <span aria-hidden className="h-px flex-1 bg-border" />
                      </div>
                    ) : null}
                    <div
                      className={clsx('flex flex-col gap-1', saida ? 'items-end' : 'items-start')}
                    >
                      <div className="flex items-center gap-1.5 px-0.5">
                        <span className="text-data-sm font-medium text-muted-fg">
                          {group.authorName ?? (saida ? 'Você' : 'Contato')}
                        </span>
                        {/* UMA hora por bloco: a thread agrupa por autor, e a hora de
                            cada frase virava uma coluna de ruído */}
                        <span className="num text-data-xs text-muted-fg">
                          {timeOfDay(group.messages[0].createdAt)}
                        </span>
                        {/* o texto é do modelo, aprovado por uma pessoa: sem este
                          selo, "quanto do que saiu daqui foi escrito por IA" só
                          existia na auditoria (ADR-044.8) */}
                        {daIa ? <AiSeal /> : null}
                      </div>
                      {group.messages.map((message) => (
                        <div
                          key={message.id}
                          className={clsx(
                            'flex max-w-[76%] items-end gap-2',
                            saida && 'flex-row-reverse',
                          )}
                        >
                          <div
                            title={fullStamp(message.createdAt)}
                            className={clsx(
                              'min-w-24 rounded-card border px-3.5 py-2.5',
                              saida
                                ? 'rounded-br-sm border-accent/25 bg-accent/8'
                                : 'rounded-bl-sm border-border bg-surface shadow-raised',
                              // proveniência: filete de cobre à esquerda do que a IA escreveu
                              daIa && 'border-l-2 border-l-ai',
                            )}
                          >
                            {/* React escapa por padrão: corpo de mensagem nunca vira HTML */}
                            <p className="whitespace-pre-wrap text-body-sm">{message.body}</p>
                            {message.attachments.length > 0 ? (
                              <ul className="mt-2 space-y-1 border-t border-border/70 pt-2">
                                {message.attachments.map((file) => (
                                  <li key={file.fileObjectId}>
                                    {/* download passa pelo endpoint autorizado, nunca por URL pública */}
                                    <a
                                      className="flex items-center gap-1.5 text-data text-accent hover:underline"
                                      href={`/api/files/${file.fileObjectId}/content`}
                                    >
                                      <Paperclip size={11} />
                                      <span className="truncate">{file.fileName}</span>
                                      <span className="num text-data-sm text-muted-fg">
                                        {Math.ceil(file.sizeBytes / 1024)} kB
                                      </span>
                                    </a>
                                  </li>
                                ))}
                              </ul>
                            ) : null}
                          </div>
                          {message.dispatchState ? (
                            <DispatchBadge
                              state={message.dispatchState}
                              error={message.dispatchError}
                            />
                          ) : null}
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
              {messages.data && thread.length === 0 ? (
                <EmptyState
                  title="Nenhuma mensagem registrada ainda."
                  hint="Escreva abaixo para registrar a primeira mensagem desta conversa."
                />
              ) : null}
            </div>
          </div>

          {/* ── rascunho de resposta da IA (ADR-044) ───────────────────── */}
          {canUseAi && canReadConversations && externo ? (
            <div
              className="ai-mark border-t border-border px-6 py-3"
              data-testid="reply-suggestion"
            >
              {reply ? (
                <>
                  <div className="flex items-center gap-2">
                    <AiSeal />
                    <span className="eyebrow text-ai">
                      Rascunho sugerido · revise antes de enviar
                    </span>
                  </div>
                  <Textarea
                    className="mt-2 bg-surface"
                    rows={3}
                    value={reply.body}
                    aria-label="Rascunho sugerido pela IA"
                    onChange={(e) =>
                      setReply((atual) => (atual ? { ...atual, body: e.target.value } : atual))
                    }
                  />
                  {reply.injection ? (
                    <p className="mt-1.5 text-data text-warning">
                      Atenção: o conteúdo desta conversa tentou dar instruções ao assistente — leia
                      o rascunho com cuidado.
                    </p>
                  ) : null}
                  <div className="mt-2 flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="primary"
                      /* enviar exige aprovar IA E responder; o veredito de
                         política continua sendo do servidor */
                      disabled={
                        !canApproveReply ||
                        reply.body.trim().length === 0 ||
                        modo !== 'free_form' ||
                        approveReply.isPending
                      }
                      title={
                        !canApproveReply
                          ? 'Enviar rascunho da IA exige aprovar sugestões e responder conversas'
                          : modo !== 'free_form'
                            ? (policy.data?.reason ?? 'Envio bloqueado agora')
                            : undefined
                      }
                      onClick={() => approveReply.mutate()}
                    >
                      <Check size={13} />{' '}
                      {approveReply.isPending ? 'Enviando…' : 'Aprovar e enviar'}
                    </Button>
                    {/* descartar é decisão sobre a conversa, como aprovar:
                        sem as duas permissões não há ação utilizável aqui */}
                    {canApproveReply ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={rejectReply.isPending}
                        onClick={() => rejectReply.mutate()}
                      >
                        <X size={13} /> Descartar
                      </Button>
                    ) : null}
                    <span className="num ml-auto text-data-sm text-muted-fg">
                      {canApproveReply
                        ? 'a IA não envia nada por conta própria'
                        : 'somente leitura: decidir sobre este rascunho exige aprovar IA e responder conversas'}
                    </span>
                  </div>
                </>
              ) : (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  <Button
                    size="sm"
                    variant="ai"
                    /* indisponibilidade vem do SERVIDOR: modo de envio e
                       consentimento de conteúdo — a tela não recalcula política */
                    disabled={
                      !canSuggestReply ||
                      suggestReply.isPending ||
                      modo !== 'free_form' ||
                      aiConsent.data?.conversationContent !== true
                    }
                    /* MESMA ORDEM do servidor: ele avalia a política de envio
                       antes do consentimento (ADR-044). Invertida, a tela
                       culpava a autorização de IA numa conversa cujo problema
                       era a janela fechada. */
                    title={
                      !canSuggestReply
                        ? 'Gerar rascunho substitui o pendente: exige poder responder a conversa'
                        : modo !== 'free_form'
                          ? (policy.data?.reason ?? 'Fora da janela livre: sugestão indisponível')
                          : aiConsent.data?.conversationContent !== true
                            ? 'O workspace não autorizou usar conteúdo de conversa na IA (ajuste em Sinais)'
                            : undefined
                    }
                    onClick={() => suggestReply.mutate()}
                  >
                    <WandSparkles size={13} />{' '}
                    {suggestReply.isPending ? 'Rascunhando…' : 'Sugerir resposta'}
                  </Button>
                  <span className="text-data text-muted-fg">
                    {!canSuggestReply
                      ? 'Somente leitura: gerar rascunho substitui o pendente e exige responder conversas'
                      : modo !== 'free_form'
                        ? (policy.data?.reason ?? 'Sugestão só dentro da janela livre de 24h')
                        : aiConsent.data?.conversationContent !== true
                          ? 'Sugestão indisponível: falta autorização de uso de conteúdo de conversa'
                          : (replyNotice ?? 'A IA rascunha; você revisa e envia')}
                  </span>
                </div>
              )}
            </div>
          ) : null}

          {error ? (
            <p role="alert" className="border-t border-border px-6 pt-2 text-body-sm text-negative">
              {error}
            </p>
          ) : null}

          {canWrite ? (
            <form
              className="border-t border-border bg-surface px-6 py-3"
              onSubmit={(e) => {
                e.preventDefault();
                // MESMO predicado do botão: os campos de parâmetro estão dentro
                // do form, e Enter num deles submetia por cima da garantia
                if (podeEnviar) send.mutate('outbound');
              }}
            >
              {externo && !policy.data ? (
                <p className="mb-2 text-data text-muted-fg">
                  {policy.isError
                    ? 'Não foi possível verificar a política de envio deste canal'
                    : 'Verificando política de envio…'}
                </p>
              ) : null}
              {policy.data && policy.data.channelType !== 'internal' ? (
                <PolicyBanner policy={policy.data} />
              ) : null}
              {modo === 'template' ? (
                <div className="mb-2.5 space-y-1.5" data-testid="template-composer">
                  <Select
                    full
                    aria-label="Template aprovado"
                    value={templateName}
                    onChange={(e) => {
                      setTemplateName(e.target.value);
                      setTemplateParams([]);
                    }}
                  >
                    <option value="">Escolha um template aprovado…</option>
                    {policy.data?.templates.map((t) => (
                      <option key={`${t.name}:${t.language}`} value={`${t.name}:${t.language}`}>
                        {t.name} ({t.language}) · {t.paramCount} parâmetro(s)
                      </option>
                    ))}
                  </Select>
                  {template
                    ? Array.from({ length: template.paramCount }).map((_, index) => (
                        <Input
                          key={index}
                          aria-label={`Parâmetro ${index + 1}`}
                          placeholder={`Parâmetro ${index + 1}`}
                          value={templateParams[index] ?? ''}
                          onChange={(e) =>
                            setTemplateParams((current) => {
                              const proximo = [...current];
                              proximo[index] = e.target.value;
                              return proximo;
                            })
                          }
                        />
                      ))
                    : null}
                </div>
              ) : null}
              {attachments.length > 0 ? (
                <ul className="mb-2 flex flex-wrap gap-1.5">
                  {attachments.map((file) => (
                    <li
                      key={file.id}
                      className="flex items-center gap-1.5 rounded-sm border border-border bg-surface-2 px-1.5 py-0.5 text-data"
                    >
                      <Paperclip size={10} />
                      <span className="max-w-40 truncate">{file.fileName}</span>
                      <button
                        type="button"
                        aria-label={`Remover ${file.fileName}`}
                        onClick={() =>
                          setAttachments((current) => current.filter((f) => f.id !== file.id))
                        }
                      >
                        <X size={10} className="text-muted-fg hover:text-negative" />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              <div className="flex items-end gap-2">
                <Textarea
                  className="min-h-[38px] flex-1"
                  rows={1}
                  placeholder="Registrar mensagem…"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  aria-label="Corpo da mensagem"
                />
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={!draft.trim() || send.isPending || !selected.contactId}
                  onClick={() => send.mutate('inbound')}
                  title={
                    selected.contactId
                      ? 'Registrar como recebida do contato'
                      : 'Vincule um contato para registrar mensagens recebidas'
                  }
                >
                  Recebida
                </Button>
                <label className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-control text-muted-fg transition-colors hover:bg-surface-2 hover:text-foreground">
                  <Paperclip size={14} />
                  <span className="sr-only">Anexar arquivo</span>
                  <input
                    type="file"
                    className="hidden"
                    aria-label="Anexar arquivo"
                    disabled={attach.isPending || attachments.length >= 5}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) attach.mutate(file);
                      e.target.value = '';
                    }}
                  />
                </label>
                <Button
                  type="submit"
                  variant="primary"
                  size="sm"
                  /* o veredito é do servidor: `blocked` não envia, e `template`
                     exige template escolhido com os parâmetros completos */
                  disabled={!podeEnviar}
                  title={
                    modo === 'blocked' ? (policy.data?.reason ?? 'Envio bloqueado') : undefined
                  }
                >
                  <Send size={13} /> {modo === 'template' ? 'Enviar template' : 'Enviada'}
                </Button>
              </div>
            </form>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center">
          <EmptyState
            title="Selecione uma conversa."
            hint="A lista à esquerda mostra o canal e quanto resta da janela de 24h de cada uma."
          />
        </div>
      )}
    </div>
  );
}
