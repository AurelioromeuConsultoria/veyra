import { horaLocal, type ClinicsAppointmentDto } from '@veyra/contracts/verticals/clinics';
import { clsx } from 'clsx';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Avatar } from '../../../components/ui/avatar';
import { StatusChip } from '../../../components/ui/status';
import {
  PX_POR_HORA,
  PX_POR_MINUTO,
  faixaDoDia,
  foraDoExpediente,
  hhmm,
  intervaloDoAgendamento,
  raias,
  type Intervalo,
} from './grade';
import { quemDoAgendamento } from './PainelDoAgendamento';
import { ROTULO_DO_ESTADO, ROTULO_DO_MOTIVO, TOM_DO_ESTADO } from './slots';

export interface ColunaDaGrade {
  id: string;
  nome: string;
  /** o expediente do dia nesta unidade; `null` = profissional arquivado (não se sabe) */
  expediente: Intervalo[] | null;
  agendamentos: ClinicsAppointmentDto[];
  /**
   * a coluna é um DIA (a Semana, ADR-062 adendo 1): a data local da unidade.
   * Sem ela, a coluna é um profissional no dia da grade.
   */
  data?: string;
}

const formatoDaSemana = new Intl.DateTimeFormat('pt-BR', { weekday: 'short', timeZone: 'UTC' });
/** `seg.`, `ter.`… de uma data de calendário (sem fuso: a data já é local). */
function semanaCurta(data: string): string {
  const [ano, mes, dia] = data.split('-').map(Number);
  return formatoDaSemana.format(new Date(Date.UTC(ano, mes - 1, dia)));
}

/** O bloco tingido pelo estado (ADR-062): a barra e o fundo dizem o estado. */
const BLOCO_DO_TOM = {
  pending: 'border-state-pending-fg/25 border-l-state-pending-fg bg-state-pending',
  confirmed: 'border-state-confirmed-fg/20 border-l-state-confirmed-fg bg-state-confirmed',
  arrived: 'border-state-arrived-fg/20 border-l-state-arrived-fg bg-state-arrived',
  done: 'border-border-strong border-l-state-done-fg bg-state-done',
  missed: 'border-state-missed-fg/20 border-l-state-missed-fg bg-state-missed',
  neutral: 'border-border border-l-border-strong bg-surface-2 opacity-80',
} as const;
const TEXTO_DO_TOM = {
  pending: 'text-state-pending-fg',
  confirmed: 'text-state-confirmed-fg',
  arrived: 'text-state-arrived-fg',
  done: 'text-state-done-fg',
  missed: 'text-state-missed-fg',
  neutral: 'text-muted-fg',
} as const;
const LEGENDA = ['scheduled', 'confirmed', 'arrived', 'attended', 'no_show', 'canceled'] as const;

/**
 * O dia e o minuto de AGORA no fuso da unidade. Relógio do navegador, só para
 * desenhar a linha: nada aqui é comparado pelo banco. Relido a cada minuto.
 */
function agoraNaUnidade(fuso: string): { data: string; minuto: number } {
  const agora = horaLocal(new Date(), fuso);
  return { data: agora.data, minuto: agora.minutoDoDia };
}
function useAgora(fuso: string): { data: string; minuto: number } {
  const [agora, setAgora] = useState(() => agoraNaUnidade(fuso));
  useEffect(() => {
    setAgora(agoraNaUnidade(fuso));
    const relogio = setInterval(() => setAgora(agoraNaUnidade(fuso)), 60_000);
    return () => clearInterval(relogio);
  }, [fuso]);
  return agora;
}

/**
 * A grade de horários (ADR-062): horas à esquerda, uma coluna por profissional
 * (o Dia) ou por dia (a Semana, adendo 1), cada agendamento posicionado pela
 * hora LOCAL de início e com a altura da duração, na cor do estado. Fora do
 * expediente fica apagado; a linha do agora só no dia de hoje da unidade.
 * Setas andam entre os blocos; Enter abre o agendamento.
 */
export function GradeDoDia({
  colunas,
  carregado,
  dia,
  fuso,
  onAbrir,
  onAbrirDia,
  mostrarProfissional = false,
}: {
  colunas: ColunaDaGrade[];
  /** a agenda do período chegou sem erro (antes disso, nem "Nenhum agendamento") */
  carregado: boolean;
  /** o dia da grade; na Semana, a segunda-feira (a grade rola de novo ao trocá-lo) */
  dia: string;
  fuso: string;
  onAbrir: (id: string) => void;
  /** a Semana: o cabeçalho de cada dia abre o Dia */
  onAbrirDia?: (data: string) => void;
  /** a Semana com mais de um profissional: o bloco diz de quem é */
  mostrarProfissional?: boolean;
}) {
  const rolagem = useRef<HTMLDivElement>(null);
  const agora = useAgora(fuso);
  const ehHoje = (coluna: ColunaDaGrade) => agora.data === (coluna.data ?? dia);
  const blocos = colunas.map((c) =>
    c.agendamentos
      .map((a) => ({ id: a.id, agendamento: a, ...intervaloDoAgendamento(a) }))
      .sort((a, b) => a.inicio - b.inicio || a.fim - b.fim),
  );
  const faixa = faixaDoDia([...colunas.flatMap((c) => c.expediente ?? []), ...blocos.flat()]);
  const altura = (faixa.fim - faixa.inicio) * PX_POR_MINUTO;
  const horas: number[] = [];
  for (let h = faixa.inicio; h < faixa.fim; h += 60) horas.push(h);
  const agoraNaFaixa =
    colunas.some(ehHoje) && agora.minuto >= faixa.inicio && agora.minuto <= faixa.fim;

  // ao abrir um dia, a grade rola até o agora (hoje) ou o primeiro horário, uma vez
  const rolado = useRef<string | null>(null);
  const primeiro = Math.min(...blocos.flat().map((b) => b.inicio));
  useEffect(() => {
    if (!carregado || rolado.current === dia || !rolagem.current) return;
    rolado.current = dia;
    const alvo = agoraNaFaixa ? agora.minuto : Number.isFinite(primeiro) ? primeiro : faixa.inicio;
    rolagem.current.scrollTop = Math.max(0, (alvo - faixa.inicio - 60) * PX_POR_MINUTO);
  }, [carregado, dia, agoraNaFaixa, agora.minuto, primeiro, faixa.inicio]);

  const navegar = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      return;
    }
    const todos = Array.from(
      rolagem.current?.querySelectorAll<HTMLButtonElement>('[data-bloco]') ?? [],
    );
    const atual = event.currentTarget;
    const coluna = Number(atual.dataset.coluna);
    const daColuna = (c: number) => todos.filter((b) => Number(b.dataset.coluna) === c);
    const mesma = daColuna(coluna);
    let alvo: HTMLButtonElement | undefined;
    if (event.key === 'ArrowUp') alvo = mesma[mesma.indexOf(atual) - 1];
    else if (event.key === 'ArrowDown') alvo = mesma[mesma.indexOf(atual) + 1];
    else if (event.key === 'Home') alvo = mesma[0];
    else if (event.key === 'End') alvo = mesma.at(-1);
    else {
      // para o lado: a próxima coluna com horários, no bloco mais perto desta hora
      const passo = event.key === 'ArrowLeft' ? -1 : 1;
      const inicio = Number(atual.dataset.inicio);
      for (let c = coluna + passo; c >= 0 && c < colunas.length && !alvo; c += passo) {
        alvo = daColuna(c).sort(
          (a, b) =>
            Math.abs(Number(a.dataset.inicio) - inicio) -
            Math.abs(Number(b.dataset.inicio) - inicio),
        )[0];
      }
    }
    if (alvo) {
      event.preventDefault();
      alvo.focus();
    }
  };

  return (
    <>
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 text-[12.5px] text-muted-fg">
        <ul
          aria-label="Legenda dos estados"
          className="flex flex-wrap items-center gap-x-4 gap-y-1"
        >
          {LEGENDA.map((estado) => (
            <li key={estado} className="inline-flex items-center gap-1.5">
              <span
                aria-hidden
                className={clsx(
                  'h-2.5 w-2.5 rounded-[3px] border border-l-[3px]',
                  BLOCO_DO_TOM[TOM_DO_ESTADO[estado]],
                )}
              />
              {ROTULO_DO_ESTADO[estado]}
            </li>
          ))}
        </ul>
        <p className="ml-auto hidden md:block">Setas andam entre os horários · Enter abre</p>
      </div>
      <div
        ref={rolagem}
        className="min-h-[16rem] shrink overflow-auto rounded-card border border-border bg-surface"
      >
        <div className="flex min-w-max">
          {/* a coluna das horas: presa à esquerda ao rolar para o lado */}
          <div aria-hidden className="sticky left-0 z-20 w-16 shrink-0 bg-surface">
            <div className="sticky top-0 z-10 h-[4.5rem] border-b border-border bg-surface" />
            <div className="relative" style={{ height: altura }}>
              {horas.map((h) => (
                <span
                  key={h}
                  className="num absolute right-2.5 text-[11.5px] text-muted-fg"
                  style={{ top: (h - faixa.inicio) * PX_POR_MINUTO + 4 }}
                >
                  {hhmm(h)}
                </span>
              ))}
            </div>
          </div>
          {colunas.map((coluna, indice) => (
            <section
              key={coluna.id}
              aria-label={`Agenda de ${coluna.nome}`}
              className={clsx(
                'flex-1 border-l border-border',
                coluna.data ? 'min-w-[8.5rem]' : 'min-w-[14rem]',
              )}
            >
              <header
                className={clsx(
                  'sticky top-0 z-10 flex h-[4.5rem] items-center border-b border-border bg-surface',
                  coluna.data ? 'gap-2.5 px-3' : 'gap-3 px-4',
                )}
              >
                {coluna.data ? (
                  <CabecalhoDoDia
                    coluna={coluna as ColunaDaGrade & { data: string }}
                    hoje={ehHoje(coluna)}
                    onAbrirDia={onAbrirDia}
                  />
                ) : (
                  <>
                    <Avatar nome={coluna.nome} chave={coluna.id} />
                    <div className="min-w-0 flex-1">
                      <h2 className="truncate font-sans text-[14.5px] font-semibold tracking-normal">
                        {coluna.nome}
                      </h2>
                      {coluna.expediente ? (
                        <p className="truncate text-[12.5px] text-muted-fg">
                          {coluna.expediente.length > 0
                            ? `Expediente ${coluna.expediente
                                .map((e) => `${hhmm(e.inicio)}–${hhmm(e.fim)}`)
                                .join(', ')}`
                            : 'Sem expediente neste dia'}
                        </p>
                      ) : null}
                    </div>
                  </>
                )}
                {carregado ? (
                  <StatusChip tom="neutral">
                    {coluna.agendamentos.filter((a) => a.status !== 'canceled').length}
                  </StatusChip>
                ) : null}
              </header>
              <div className="relative" style={{ height: altura }}>
                {coluna.expediente
                  ? foraDoExpediente(faixa, coluna.expediente).map((f) => (
                      <div
                        key={f.inicio}
                        aria-hidden
                        className="absolute inset-x-0 bg-surface-2"
                        style={{
                          top: (f.inicio - faixa.inicio) * PX_POR_MINUTO,
                          height: (f.fim - f.inicio) * PX_POR_MINUTO,
                        }}
                      />
                    ))
                  : null}
                <div
                  aria-hidden
                  className="pointer-events-none absolute inset-0"
                  style={{
                    backgroundImage: `repeating-linear-gradient(to bottom, transparent 0, transparent ${PX_POR_HORA - 1}px, var(--color-border) ${PX_POR_HORA - 1}px, var(--color-border) ${PX_POR_HORA}px)`,
                  }}
                />
                {carregado && coluna.agendamentos.length === 0 ? (
                  <p className="absolute inset-x-0 top-3 text-center text-[13px] text-muted-fg">
                    Nenhum agendamento.
                  </p>
                ) : null}
                <div className="absolute inset-y-0 left-1.5 right-1.5">
                  {(() => {
                    const posicao = raias(blocos[indice]);
                    return blocos[indice].map((b) => {
                      const { raia, raias: total } = posicao.get(b.id) ?? { raia: 0, raias: 1 };
                      return (
                        <BlocoDeAgendamento
                          key={b.id}
                          agendamento={b.agendamento}
                          coluna={indice}
                          inicio={b.inicio}
                          top={(b.inicio - faixa.inicio) * PX_POR_MINUTO + 1}
                          altura={Math.max((b.fim - b.inicio) * PX_POR_MINUTO - 2, 18)}
                          esquerda={(raia / total) * 100}
                          largura={100 / total}
                          dividido={total > 1}
                          mostrarProfissional={mostrarProfissional}
                          onAbrir={() => onAbrir(b.id)}
                          onKeyDown={navegar}
                        />
                      );
                    });
                  })()}
                </div>
                {agoraNaFaixa && ehHoje(coluna) ? (
                  <div
                    aria-hidden
                    data-testid="linha-do-agora"
                    className="pointer-events-none absolute inset-x-0 z-[5] h-0.5 bg-negative"
                    style={{ top: (agora.minuto - faixa.inicio) * PX_POR_MINUTO - 1 }}
                  >
                    {/* no Dia, o ponto só na primeira coluna; na Semana, no dia de hoje */}
                    {indice === 0 || coluna.data ? (
                      <span className="absolute -left-[5px] -top-1 h-2.5 w-2.5 rounded-full bg-negative" />
                    ) : null}
                  </div>
                ) : null}
              </div>
            </section>
          ))}
        </div>
      </div>
    </>
  );
}

/** O cabeçalho de um dia da Semana: o número do dia, o dia da semana e o expediente. */
function CabecalhoDoDia({
  coluna,
  hoje,
  onAbrirDia,
}: {
  coluna: ColunaDaGrade & { data: string };
  hoje: boolean;
  onAbrirDia?: (data: string) => void;
}) {
  const expediente =
    coluna.expediente === null
      ? null
      : coluna.expediente.length > 0
        ? coluna.expediente.map((e) => `${hhmm(e.inicio)}–${hhmm(e.fim)}`).join(', ')
        : 'Sem expediente';
  return (
    <>
      <span
        aria-hidden
        className={clsx(
          'num flex h-9 w-9 shrink-0 items-center justify-center rounded-[9px] text-[15px] font-semibold',
          hoje ? 'bg-accent text-accent-fg' : 'bg-surface-2 text-foreground',
        )}
      >
        {coluna.data.slice(8)}
      </span>
      <div className="min-w-0 flex-1">
        <h2 className="truncate font-sans text-[14px] font-semibold capitalize tracking-normal">
          {onAbrirDia ? (
            <button
              type="button"
              aria-label={`Ver o dia ${coluna.nome}`}
              className="capitalize hover:underline"
              onClick={() => onAbrirDia(coluna.data)}
            >
              {semanaCurta(coluna.data)}
            </button>
          ) : (
            semanaCurta(coluna.data)
          )}
          {hoje ? <span className="sr-only"> (hoje)</span> : null}
        </h2>
        {expediente ? <p className="num truncate text-[12px] text-muted-fg">{expediente}</p> : null}
      </div>
    </>
  );
}

function BlocoDeAgendamento({
  agendamento,
  coluna,
  inicio,
  top,
  altura,
  esquerda,
  largura,
  dividido,
  mostrarProfissional,
  onAbrir,
  onKeyDown,
}: {
  agendamento: ClinicsAppointmentDto;
  coluna: number;
  inicio: number;
  top: number;
  altura: number;
  esquerda: number;
  largura: number;
  dividido: boolean;
  mostrarProfissional: boolean;
  onAbrir: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
}) {
  const id = useId();
  const tom = TOM_DO_ESTADO[agendamento.status];
  const quem = quemDoAgendamento(agendamento);
  // na Semana com vários profissionais, a linha do serviço diz também de quem é
  const servico = mostrarProfissional
    ? `${agendamento.serviceName} · ${agendamento.professionalName}`
    : agendamento.serviceName;
  const estado = `${ROTULO_DO_ESTADO[agendamento.status]}${
    agendamento.cancelReason ? ` · ${ROTULO_DO_MOTIVO[agendamento.cancelReason]}` : ''
  }`;
  const horario = `${agendamento.localStart}–${agendamento.localEnd}`;
  // quanto cabe: três linhas, duas ou uma só (o estado nunca sai)
  const linhas = altura >= 54 ? 3 : altura >= 34 ? 2 : 1;
  const linhaDoEstado = (
    <span
      className={clsx(
        'flex items-center justify-between gap-2 text-[11.5px] leading-4',
        TEXTO_DO_TOM[tom],
      )}
    >
      <span className="num">{horario}</span>
      <span id={`${id}-estado`} className="truncate font-semibold">
        {estado}
      </span>
    </span>
  );
  return (
    <article
      aria-label={`Agendamento ${quem}`}
      className={clsx('absolute', dividido && 'pr-1')}
      style={{ top, height: altura, left: `${esquerda}%`, width: `${largura}%` }}
    >
      <button
        type="button"
        data-bloco={agendamento.id}
        data-coluna={coluna}
        data-inicio={inicio}
        aria-label={`Abrir agendamento: ${quem}`}
        aria-describedby={`${id}-estado ${id}-servico`}
        aria-haspopup="dialog"
        title={`${horario} · ${agendamento.patientName} · ${servico} · ${estado}`}
        onClick={onAbrir}
        onKeyDown={onKeyDown}
        className={clsx(
          'flex h-full w-full flex-col overflow-hidden rounded-[9px] border border-l-4 px-2.5 text-left transition-shadow hover:shadow-raised',
          linhas === 1 ? 'justify-center py-0' : 'gap-0.5 py-1',
          BLOCO_DO_TOM[tom],
        )}
      >
        {linhas === 1 ? (
          <span className="flex min-w-0 items-center gap-2 text-[11.5px] leading-4">
            <span className={clsx('num shrink-0', TEXTO_DO_TOM[tom])}>
              {agendamento.localStart}
            </span>
            <span className="min-w-0 flex-1 truncate font-semibold text-foreground">
              {agendamento.patientName}
            </span>
            <span id={`${id}-estado`} className={clsx('shrink-0 font-semibold', TEXTO_DO_TOM[tom])}>
              {estado}
            </span>
            <span id={`${id}-servico`} className="sr-only">
              {servico}
            </span>
          </span>
        ) : (
          <>
            {linhaDoEstado}
            <span className="w-full truncate text-[13.5px] font-semibold leading-5 text-foreground">
              {agendamento.patientName}
              {linhas === 2 ? (
                <span id={`${id}-servico`} className="font-normal text-muted-fg">
                  {' · '}
                  {servico}
                </span>
              ) : null}
            </span>
            {linhas === 3 ? (
              <span id={`${id}-servico`} className="w-full truncate text-[12px] text-muted-fg">
                {servico}
              </span>
            ) : null}
          </>
        )}
      </button>
    </article>
  );
}
