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
 * O minuto de AGORA no fuso da unidade, só quando o dia mostrado é hoje lá.
 * Relógio do navegador, só para desenhar a linha: nada aqui é comparado pelo
 * banco. Relido a cada minuto.
 */
function minutoDeAgora(fuso: string, dia: string): number | null {
  const agora = horaLocal(new Date(), fuso);
  return agora.data === dia ? agora.minutoDoDia : null;
}
function useAgora(fuso: string, dia: string): number | null {
  const [minuto, setMinuto] = useState(() => minutoDeAgora(fuso, dia));
  useEffect(() => {
    setMinuto(minutoDeAgora(fuso, dia));
    const relogio = setInterval(() => setMinuto(minutoDeAgora(fuso, dia)), 60_000);
    return () => clearInterval(relogio);
  }, [fuso, dia]);
  return minuto;
}

/**
 * A grade do dia (ADR-062): horas à esquerda, uma coluna por profissional, cada
 * agendamento posicionado pela hora LOCAL de início e com a altura da duração,
 * na cor do estado. Fora do expediente fica apagado; a linha do agora só no
 * dia de hoje da unidade. Setas andam entre os blocos; Enter abre o agendamento.
 */
export function GradeDoDia({
  colunas,
  carregado,
  dia,
  fuso,
  onAbrir,
}: {
  colunas: ColunaDaGrade[];
  /** a agenda do dia chegou sem erro (antes disso, nem "Nenhum agendamento") */
  carregado: boolean;
  dia: string;
  fuso: string;
  onAbrir: (id: string) => void;
}) {
  const rolagem = useRef<HTMLDivElement>(null);
  const agora = useAgora(fuso, dia);
  const blocos = colunas.map((c) =>
    c.agendamentos
      .map((a) => ({ id: a.id, agendamento: a, ...intervaloDoAgendamento(a) }))
      .sort((a, b) => a.inicio - b.inicio || a.fim - b.fim),
  );
  const faixa = faixaDoDia([...colunas.flatMap((c) => c.expediente ?? []), ...blocos.flat()]);
  const altura = (faixa.fim - faixa.inicio) * PX_POR_MINUTO;
  const horas: number[] = [];
  for (let h = faixa.inicio; h < faixa.fim; h += 60) horas.push(h);
  const agoraNaFaixa = agora !== null && agora >= faixa.inicio && agora <= faixa.fim;

  // ao abrir um dia, a grade rola até o agora (hoje) ou o primeiro horário, uma vez
  const rolado = useRef<string | null>(null);
  const primeiro = Math.min(...blocos.flat().map((b) => b.inicio));
  useEffect(() => {
    if (!carregado || rolado.current === dia || !rolagem.current) return;
    rolado.current = dia;
    const alvo = agoraNaFaixa ? agora : Number.isFinite(primeiro) ? primeiro : faixa.inicio;
    rolagem.current.scrollTop = Math.max(0, (alvo - faixa.inicio - 60) * PX_POR_MINUTO);
  }, [carregado, dia, agoraNaFaixa, agora, primeiro, faixa.inicio]);

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
              className="min-w-[14rem] flex-1 border-l border-border"
            >
              <header className="sticky top-0 z-10 flex h-[4.5rem] items-center gap-3 border-b border-border bg-surface px-4">
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
                          onAbrir={() => onAbrir(b.id)}
                          onKeyDown={navegar}
                        />
                      );
                    });
                  })()}
                </div>
                {agoraNaFaixa ? (
                  <div
                    aria-hidden
                    data-testid="linha-do-agora"
                    className="pointer-events-none absolute inset-x-0 z-[5] h-0.5 bg-negative"
                    style={{ top: (agora - faixa.inicio) * PX_POR_MINUTO - 1 }}
                  >
                    {indice === 0 ? (
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

function BlocoDeAgendamento({
  agendamento,
  coluna,
  inicio,
  top,
  altura,
  esquerda,
  largura,
  dividido,
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
  onAbrir: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
}) {
  const id = useId();
  const tom = TOM_DO_ESTADO[agendamento.status];
  const quem = quemDoAgendamento(agendamento);
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
        title={`${horario} · ${agendamento.patientName} · ${agendamento.serviceName} · ${estado}`}
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
              {agendamento.serviceName}
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
                  {agendamento.serviceName}
                </span>
              ) : null}
            </span>
            {linhas === 3 ? (
              <span id={`${id}-servico`} className="w-full truncate text-[12px] text-muted-fg">
                {agendamento.serviceName}
              </span>
            ) : null}
          </>
        )}
      </button>
    </article>
  );
}
