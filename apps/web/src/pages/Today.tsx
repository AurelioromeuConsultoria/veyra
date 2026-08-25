import { useQuery } from '@tanstack/react-query';
import type {
  AiProposalDto,
  BoardDto,
  ConversationDto,
  ConversationPageDto,
  Paginated,
  TaskDto,
  UsageOverviewDto,
} from '@veyra/contracts';
import { clsx } from 'clsx';
import { ArrowRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AiSeal } from '../components/ui/ai';
import { WindowMeter } from '../components/ui/window-meter';
import { api } from '../lib/api';
import { formatCents, windowState, type WindowUrgency } from '../lib/format';
import { hasPermission, useSession } from '../lib/session';

/**
 * HOJE — a visão executiva prometida no §1 do DESIGN_DIRECTION e nunca
 * construída. O produto abria numa tabela: a identidade não tinha um só lugar
 * para respirar, e por isso lia como "sem personalidade".
 *
 * Três regras duras nesta tela, contra o anti-padrão "dashboard genérico" (§2):
 *
 * 1. Nenhum número que não venha de um endpoint que já existe. Nada de taxa de
 *    conversão, nada de série temporal, nada de donut.
 * 2. Cada bloco responde uma PERGUNTA e leva ao lugar onde se age sobre ela.
 * 3. Nada dispara chamada que voltaria 403 — o `enabled` de cada query carrega
 *    a mesma permissão que o servidor exige na rota (a lição do inbox).
 *
 * O herói é a janela de 24h, e não por acaso: é a coisa mais característica do
 * produto e a única com relógio correndo. Aqui o tempo restante VIRA o número
 * grande — o papel "display" da escala tipográfica finalmente tem onde existir.
 */

const dayLong = new Intl.DateTimeFormat('pt-BR', {
  weekday: 'long',
  day: '2-digit',
  month: 'long',
});
const dueFormat = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit' });

/** Urgência colore o número-herói — semântico com função, nunca decoração. */
const heroTone: Record<WindowUrgency, string> = {
  none: 'text-muted-fg',
  calm: 'text-foreground',
  attention: 'text-warning',
  urgent: 'text-negative',
  closed: 'text-muted-fg',
};

const channelLabel: Record<ConversationDto['channelType'], string> = {
  internal: 'Interno',
  email: 'E-mail',
  whatsapp: 'WhatsApp',
};

const proposalLabel: Record<AiProposalDto['type'], string> = {
  send_message: 'Rascunho de resposta',
  create_task: 'Tarefa proposta',
};

function endOfToday(): number {
  const date = new Date();
  date.setHours(23, 59, 59, 999);
  return date.getTime();
}

export function TodayPage() {
  const { data: user } = useSession();
  const canReadConversations = hasPermission(user, 'conversations:read');
  const canReadTasks = hasPermission(user, 'tasks:read');
  const canReadPipelines = hasPermission(user, 'pipelines:read');
  const canReadWorkspace = hasPermission(user, 'workspace:read');
  /** a fila de propostas exige as DUAS no servidor (intelligence.controller) */
  const canSeeProposals =
    hasPermission(user, 'intelligence:approve') && hasPermission(user, 'contacts:read');

  const conversations = useQuery({
    queryKey: ['today', 'conversations'],
    queryFn: () => api.get<ConversationPageDto>('/api/conversations?status=open&limit=50'),
    enabled: canReadConversations,
    // o medidor conta sozinho, mas a LISTA pode ganhar conversa nova
    refetchInterval: 120_000,
  });
  const proposals = useQuery({
    queryKey: ['today', 'proposals'],
    queryFn: () => api.get<AiProposalDto[]>('/api/intelligence/proposals?status=pending'),
    enabled: canSeeProposals,
  });
  const tasks = useQuery({
    queryKey: ['today', 'tasks'],
    queryFn: () => api.get<Paginated<TaskDto>>('/api/tasks?status=open&pageSize=100'),
    enabled: canReadTasks,
  });
  const board = useQuery({
    queryKey: ['today', 'board'],
    queryFn: () => api.get<BoardDto>('/api/deals/board'),
    enabled: canReadPipelines,
  });
  const usage = useQuery({
    queryKey: ['today', 'usage'],
    queryFn: () => api.get<UsageOverviewDto>('/api/usage'),
    enabled: canReadWorkspace,
  });

  /**
   * Só canal EXTERNO com janela conhecida: no canal interno não existe janela
   * de 24h, e uma linha "sem janela" aqui seria ruído. Ordem por tempo restante
   * crescente entre as abertas; as já FECHADAS vão para o fim — elas não estão
   * fechando, já fecharam, e o que resta nelas é template, não urgência.
   */
  const windows = (conversations.data?.items ?? [])
    .filter((c) => c.channelType !== 'internal' && c.windowExpiresAt !== null)
    .map((c) => ({ conversation: c, state: windowState(c.windowExpiresAt) }))
    .sort((a, b) => {
      const aClosed = a.state.urgency === 'closed';
      const bClosed = b.state.urgency === 'closed';
      if (aClosed !== bClosed) return aClosed ? 1 : -1;
      return a.state.remainingMs - b.state.remainingMs;
    });
  const apertadas = windows.filter(
    (w) => w.state.urgency === 'urgent' || w.state.urgency === 'attention',
  ).length;

  const limite = endOfToday();
  const comPrazo = (tasks.data?.items ?? [])
    .filter((task) => task.dueAt !== null)
    .sort((a, b) => new Date(a.dueAt!).getTime() - new Date(b.dueAt!).getTime());
  const tarefasDoDia = comPrazo.filter((task) => new Date(task.dueAt!).getTime() <= limite);
  /**
   * "Nenhuma tarefa vence hoje" sozinho esconde que existe prazo amanhã. O
   * vazio aponta a PRÓXIMA data real — nunca uma estimativa, nunca um "em
   * breve": é o `dueAt` da primeira tarefa aberta depois de hoje.
   */
  const proximaComPrazo = comPrazo.find((task) => new Date(task.dueAt!).getTime() > limite);
  const propostas = proposals.data ?? [];
  const aguardando = propostas.length + tarefasDoDia.length;

  /**
   * A frase de abertura é COMPOSTA do que se leu, nunca redigida em cima de uma
   * métrica inventada — e só menciona o que a permissão desta pessoa alcança.
   */
  const carregando =
    (canReadConversations && conversations.isPending) ||
    (canSeeProposals && proposals.isPending) ||
    (canReadTasks && tasks.isPending);
  const partes: string[] = [];
  if (canReadConversations && apertadas > 0) {
    partes.push(
      apertadas === 1
        ? 'uma janela de 24h fecha em menos de 6 horas'
        : `${apertadas} janelas de 24h fecham em menos de 6 horas`,
    );
  }
  if (aguardando > 0) {
    partes.push(
      aguardando === 1 ? 'um item aguarda sua decisão' : `${aguardando} itens aguardam sua decisão`,
    );
  }
  const frase = carregando
    ? 'Lendo o dia…'
    : partes.length === 0
      ? 'Nenhuma janela apertada e nada aguardando decisão.'
      : `${partes.join(' e ')[0].toUpperCase()}${partes.join(' e ').slice(1)}.`;

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="mx-auto w-full max-w-5xl px-8 pb-16 pt-10">
        <header className="rise" style={{ animationDelay: '0ms' }}>
          <p className="eyebrow text-muted-fg">{dayLong.format(new Date())}</p>
          <h1 className="mt-2 text-display-lg">Hoje</h1>
          <p className="mt-2 max-w-2xl text-display-sm font-normal text-muted-fg">{frase}</p>
        </header>

        <div className="mt-10 space-y-10">
          {canReadConversations ? (
            <Block
              /* o título não pode prometer urgência que não existe: "fechando"
                 só quando alguma janela está de fato abaixo de 6 horas */
              title={apertadas > 0 ? 'Janelas fechando' : 'Janelas de 24h'}
              question="Onde ainda dá para responder com texto livre?"
              to="/inbox"
              linkLabel="Ver conversas"
              delay={60}
            >
              {conversations.isPending ? (
                <Quiet>Lendo as conversas abertas…</Quiet>
              ) : windows.length === 0 ? (
                <Quiet>Nenhuma janela de 24h aberta agora — nada correndo contra o relógio.</Quiet>
              ) : (
                <ul className="divide-y divide-border">
                  {windows.map(({ conversation, state }) => {
                    const closed = state.urgency === 'closed';
                    return (
                      <li key={conversation.id}>
                        <Link
                          to={`/inbox?c=${conversation.id}`}
                          className="flex items-center gap-6 px-5 py-4 transition-colors duration-150 hover:bg-surface-2/50"
                        >
                          {/* NÚMERO-HERÓI: o tempo restante em display + mono */}
                          <span
                            className={clsx(
                              'num w-[5.5rem] shrink-0 text-right',
                              closed ? 'text-display-sm' : 'text-display-lg',
                              heroTone[state.urgency],
                            )}
                          >
                            {closed ? 'fechada' : state.label}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-baseline gap-2">
                              <span className="truncate text-body font-medium">
                                {conversation.contactName ?? conversation.subject ?? 'Sem contato'}
                              </span>
                              <span className="eyebrow shrink-0 text-muted-fg">
                                {channelLabel[conversation.channelType]}
                              </span>
                            </div>
                            {/* a assinatura do produto continua aqui: a hairline
                                que se esvazia, sem repetir o tempo ao lado.
                                FECHADA não desenha medidor — o trilho cheio e
                                apagado lia igual a uma janela quase inteira, e
                                aqui não há o rótulo que desfaz o engano */}
                            {closed ? null : (
                              <div className="mt-2">
                                <WindowMeter
                                  expiresAt={conversation.windowExpiresAt}
                                  variant="inline"
                                />
                              </div>
                            )}
                          </div>
                          <span className="shrink-0 text-data text-muted-fg">
                            {closed ? 'só template' : 'responder'}
                          </span>
                          <ArrowRight size={14} aria-hidden className="shrink-0 text-muted-fg" />
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Block>
          ) : null}

          {canSeeProposals || canReadTasks ? (
            <section className="rise" style={{ animationDelay: '120ms' }}>
              <SectionTitle
                title="Aguardando você"
                question="O que não anda sem um gesto humano?"
              />
              <div className="grid items-start gap-4 lg:grid-cols-2">
                {canSeeProposals ? (
                  <Card
                    title="Propostas da IA"
                    to="/signals"
                    linkLabel="Ver a fila"
                    meta={propostas.length > 0 ? String(propostas.length) : undefined}
                  >
                    {proposals.isPending ? (
                      <Quiet>Lendo a fila…</Quiet>
                    ) : propostas.length === 0 ? (
                      <Quiet>
                        Nada proposto. A IA sugere próximas ações no contexto de uma conversa ou de
                        um contato — e nada é executado sem aprovação.
                      </Quiet>
                    ) : (
                      <ul className="divide-y divide-border">
                        {propostas.slice(0, 5).map((proposal) => (
                          <li key={proposal.id}>
                            <Link
                              to={
                                proposal.type === 'send_message' && proposal.conversationId
                                  ? `/inbox?c=${proposal.conversationId}`
                                  : '/signals'
                              }
                              className="ai-mark flex items-start gap-3 px-4 py-3 transition-colors duration-150 hover:bg-ai/10"
                            >
                              <AiSeal />
                              <div className="min-w-0 flex-1">
                                <span className="eyebrow block text-ai">
                                  {proposalLabel[proposal.type]}
                                </span>
                                <span className="mt-1 block truncate text-body-sm">
                                  {proposal.type === 'send_message'
                                    ? String(proposal.payload.body ?? proposal.rationale)
                                    : String(proposal.payload.title ?? proposal.rationale)}
                                </span>
                              </div>
                              <ArrowRight
                                size={13}
                                aria-hidden
                                className="mt-0.5 shrink-0 text-muted-fg"
                              />
                            </Link>
                          </li>
                        ))}
                      </ul>
                    )}
                  </Card>
                ) : null}

                {canReadTasks ? (
                  <Card
                    title="Tarefas para hoje"
                    to="/tasks"
                    linkLabel="Ver todas"
                    meta={tarefasDoDia.length > 0 ? String(tarefasDoDia.length) : undefined}
                  >
                    {tasks.isPending ? (
                      <Quiet>Lendo as tarefas…</Quiet>
                    ) : tarefasDoDia.length === 0 ? (
                      <Quiet>
                        {proximaComPrazo ? (
                          <>
                            Nenhuma tarefa vence hoje — a próxima é{' '}
                            <span className="num text-foreground">
                              {dueFormat.format(new Date(proximaComPrazo.dueAt!))}
                            </span>
                            , {proximaComPrazo.title}.
                          </>
                        ) : (
                          'Nenhuma tarefa com prazo. Prazo só existe se alguém marcar — anote o próximo passo em Tarefas.'
                        )}
                      </Quiet>
                    ) : (
                      <ul className="divide-y divide-border">
                        {tarefasDoDia.slice(0, 5).map((task) => {
                          const atrasada = new Date(task.dueAt!).getTime() < Date.now();
                          return (
                            <li
                              key={task.id}
                              className="flex items-baseline gap-3 px-4 py-2.5 text-body-sm"
                            >
                              <span
                                className={clsx(
                                  'num w-12 shrink-0 text-data',
                                  atrasada ? 'text-negative' : 'text-muted-fg',
                                )}
                              >
                                {dueFormat.format(new Date(task.dueAt!))}
                              </span>
                              <span className="min-w-0 flex-1 truncate">{task.title}</span>
                              {atrasada ? (
                                <span className="eyebrow shrink-0 text-negative">atrasada</span>
                              ) : null}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </Card>
                ) : null}
              </div>
            </section>
          ) : null}

          {canReadPipelines ? (
            <section className="rise" style={{ animationDelay: '180ms' }}>
              <SectionTitle title="Funil" question="Onde o valor em aberto está parado?" />
              {board.isPending ? (
                <Panelish>
                  <Quiet>Lendo o board…</Quiet>
                </Panelish>
              ) : (board.data?.columns.length ?? 0) === 0 ? (
                <Panelish>
                  <Quiet>Nenhuma etapa configurada neste pipeline.</Quiet>
                </Panelish>
              ) : (
                <Link
                  to="/pipeline"
                  aria-label="Abrir o funil por etapa"
                  className="flex overflow-x-auto rounded-card border border-border bg-surface transition-colors duration-150 hover:border-border-strong"
                >
                  {board.data!.columns.map((column) => (
                    <div
                      key={column.stageId}
                      className="min-w-[9rem] flex-1 border-r border-border px-4 py-3 last:border-r-0"
                    >
                      <p className="eyebrow truncate text-muted-fg">{column.stageName}</p>
                      <p className="num mt-1.5 text-body text-foreground">
                        {formatCents(column.totalCents)}
                      </p>
                      <p className="num mt-0.5 text-data-sm text-muted-fg">
                        {column.deals.length}{' '}
                        {column.deals.length === 1 ? 'oportunidade' : 'oportunidades'}
                      </p>
                    </div>
                  ))}
                </Link>
              )}
            </section>
          ) : null}

          {canReadWorkspace ? <PlanLine usage={usage.data} loading={usage.isPending} /> : null}
        </div>
      </div>
    </div>
  );
}

/**
 * Só o que está PERTO do teto. Mostrar as cinco métricas transformaria a tela
 * numa página de configuração — o plano só interessa aqui quando é o que vai
 * travar o trabalho de alguém hoje.
 */
function PlanLine({ usage, loading }: { usage: UsageOverviewDto | undefined; loading: boolean }) {
  const perto = (usage?.metrics ?? []).filter(
    (metric) => metric.usedRatio !== null && metric.usedRatio >= 0.8,
  );
  if (loading) return null;
  return (
    <section className="rise" style={{ animationDelay: '240ms' }}>
      {perto.length === 0 ? (
        <p className="flex items-center gap-2 border-t border-border pt-5 text-data text-muted-fg">
          Nenhuma métrica perto do teto do plano.
          <SeeAll to="/settings/usage">Ver o plano</SeeAll>
        </p>
      ) : (
        <>
          <SectionTitle title="Perto do teto" question="O que pode travar o trabalho hoje?" />
          <ul className="overflow-hidden rounded-card border border-border bg-surface">
            {perto.map((metric) => (
              <li key={metric.metric} className="border-b border-border px-4 py-3 last:border-b-0">
                <div className="flex items-baseline gap-3">
                  <span className="text-body-sm font-medium">{metric.label}</span>
                  <span className="num ml-auto text-data text-warning">
                    {Math.round(metric.usedRatio! * 100)}% do limite
                  </span>
                </div>
                <div className="mt-2 h-0.5 w-full overflow-hidden rounded-full bg-border">
                  <div
                    className="h-full rounded-full bg-warning"
                    style={{ width: `${Math.min(metric.usedRatio! * 100, 100)}%` }}
                  />
                </div>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-data text-muted-fg">
            <SeeAll to="/settings/usage">Ver o plano</SeeAll>
          </p>
        </>
      )}
    </section>
  );
}

/**
 * "Ver tudo" de um bloco: cinza com seta, nunca verde. O acento é UMA cor e
 * já é gasta no wordmark, no marcador da seção ativa e na ação primária —
 * quatro links verdes numa tela só a transformariam em decoração (§4).
 */
function SeeAll({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link
      to={to}
      className="ml-auto flex shrink-0 items-center gap-1 text-data text-muted-fg transition-colors duration-150 hover:text-foreground"
    >
      {children}
      <ArrowRight size={12} aria-hidden />
    </Link>
  );
}

/** Título de bloco: a pergunta que o bloco responde vem junto — se um bloco não
 *  tem pergunta, ele não deveria estar na tela (§2). */
function SectionTitle({ title, question }: { title: string; question: string }) {
  return (
    <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <h2 className="text-display-sm">{title}</h2>
      <p className="text-data text-muted-fg">{question}</p>
    </div>
  );
}

function Block({
  title,
  question,
  to,
  linkLabel,
  delay,
  children,
}: {
  title: string;
  question: string;
  to: string;
  linkLabel: string;
  delay: number;
  children: ReactNode;
}) {
  return (
    <section className="rise" style={{ animationDelay: `${delay}ms` }}>
      <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-display-sm">{title}</h2>
        <p className="text-data text-muted-fg">{question}</p>
        <SeeAll to={to}>{linkLabel}</SeeAll>
      </div>
      <div className="overflow-hidden rounded-card border border-border bg-surface">{children}</div>
    </section>
  );
}

function Card({
  title,
  meta,
  to,
  linkLabel,
  children,
}: {
  title: string;
  meta?: string;
  to: string;
  linkLabel: string;
  children: ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-card border border-border bg-surface">
      <header className="flex items-center gap-3 border-b border-border px-4 py-2.5">
        <h3 className="eyebrow text-muted-fg">{title}</h3>
        {meta ? <span className="num text-data-sm text-muted-fg">{meta}</span> : null}
        <SeeAll to={to}>{linkLabel}</SeeAll>
      </header>
      {children}
    </div>
  );
}

function Panelish({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-card border border-border bg-surface">{children}</div>
  );
}

/** Vazio orienta a próxima ação (§7) — e no respiro da visão executiva ele é
 *  uma frase, não um ícone gigante nem um esqueleto piscando. */
function Quiet({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-3 px-5 py-6 text-body-sm text-muted-fg">
      <span aria-hidden className="mt-2.5 h-px w-6 shrink-0 bg-border-strong" />
      <span className="max-w-prose">{children}</span>
    </p>
  );
}
