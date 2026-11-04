import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  diaDaSemana,
  type ClinicsAppointmentDto,
  type ClinicsRescheduleOptionDto,
  type ClinicsRescheduleOptionsDto,
} from '@veyra/contracts/verticals/clinics';
import { useState, type ReactNode } from 'react';
import { Button } from '../../components/ui/button';
import { api, ApiError } from '../../lib/api';
import { AGENDA_KEY } from './agenda/slots';
import { WEEKDAYS } from './format';

/** Quantos horários a sugestão oferece (o servidor aceita até 5). */
const QUANTOS = 3;

/** `2030-11-06` + `10:00` → `Qua, 06/11 · 10:00` (data e hora LOCAIS da unidade). */
export function rotuloDoHorario(data: string, hora: string, utcOffset?: string): string {
  const [, mes, dia] = data.split('-');
  const semana = WEEKDAYS.find((w) => w.iso === diaDaSemana(data))?.short ?? '';
  return `${semana}, ${dia}/${mes} · ${hora}${utcOffset ? ` (${utcOffset})` : ''}`;
}

/** A sobreposição barrada pelo banco (a mesma mensagem da rota de remarcação). */
const OCUPADO = 'Horário já ocupado para este profissional';

const ehOcupado = (erro: unknown) =>
  erro instanceof ApiError && erro.status === 409 && erro.message === OCUPADO;

/**
 * A mensagem do erro da remarcação. No horário ocupado, só diz que as opções
 * foram atualizadas DEPOIS que elas voltaram do servidor.
 */
function mensagemDoErro(
  erro: unknown,
  opcoes: 'atualizando' | 'atualizadas' | 'indisponiveis',
): string {
  if (ehOcupado(erro)) {
    if (opcoes === 'atualizando') {
      return 'Esse horário acabou de ser ocupado. Atualizando as opções…';
    }
    if (opcoes === 'indisponiveis') return 'Esse horário acabou de ser ocupado.';
    return 'Esse horário acabou de ser ocupado. As opções foram atualizadas: escolha outra.';
  }
  if (erro instanceof ApiError) return erro.message;
  return 'Não foi possível remarcar agora.';
}

/**
 * A sugestão "Remarcar" SEM IA (ADR-062 adendo 1, parte B), no contexto
 * clínico da conversa: o próximo agendamento remarcável do paciente e os
 * próximos horários livres do mesmo profissional, calculados no SERVIDOR pela
 * regra da agenda (`GET .../reschedule-options`, com `clinics:schedule:read`).
 *
 * Rótulo "Sugestão", na cor de acento: ninguém usou IA, e o selo de IA seria
 * proveniência falsa. Só montada para quem escreve na agenda
 * (`clinics:schedule:write`); o clique pede confirmação e remarca pela rota
 * que a Agenda já usa, com a auditoria dela. O horário pode ser tomado entre a
 * sugestão e o clique: o 409 recarrega as opções e diz o que houve, e os
 * botões ficam desabilitados até as opções novas chegarem.
 *
 * `fixar` prende o agendamento no pai do clique até o usuário dispensar o
 * resultado: a invalidação da agenda depois da remarcação (ou do 409 de
 * estado) pode trocar o "próximo remarcável" e remontar o cartão, e o
 * "Remarcado: …" ou o erro sumiriam sem ninguém ler. Só o 409 de horário
 * ocupado solta o agendamento: o fluxo volta às opções do mesmo agendamento.
 */
export function SugestaoDeRemarcacao({
  agendamento,
  fixar,
}: {
  agendamento: ClinicsAppointmentDto;
  fixar: (agendamento: ClinicsAppointmentDto | null) => void;
}) {
  const queryClient = useQueryClient();
  const [escolhida, setEscolhida] = useState<ClinicsRescheduleOptionDto | null>(null);
  const [feito, setFeito] = useState<ClinicsAppointmentDto | null>(null);
  // depois do 409 de horário ocupado: quantas atualizações as opções tinham
  // quando o erro chegou (dado ou erro); até passar disso, estão atualizando
  const [esperaDesde, setEsperaDesde] = useState<number | null>(null);
  // debaixo da chave da agenda: marcar, remarcar ou mudar o estado em
  // qualquer tela recarrega as opções
  const chaveDasOpcoes = [
    ...AGENDA_KEY,
    'reschedule-options',
    agendamento.id,
    agendamento.startsAt,
  ] as const;
  const atualizacoes = () => {
    const estado = queryClient.getQueryState(chaveDasOpcoes);
    return (estado?.dataUpdateCount ?? 0) + (estado?.errorUpdateCount ?? 0);
  };
  const remarcar = useMutation({
    mutationFn: (opcao: ClinicsRescheduleOptionDto) =>
      api.post<ClinicsAppointmentDto>(
        `/api/clinics/appointments/${encodeURIComponent(agendamento.id)}/reschedule`,
        {
          date: opcao.localDate,
          time: opcao.localStart,
          ...(opcao.utcOffset ? { utcOffset: opcao.utcOffset } : {}),
        },
      ),
    onSuccess: (dto) => {
      setFeito(dto);
      setEscolhida(null);
      void queryClient.invalidateQueries({ queryKey: AGENDA_KEY });
    },
    onError: (erro) => {
      setEscolhida(null);
      if (ehOcupado(erro)) {
        // tomado no meio do caminho: as opções recarregam e o fluxo continua
        setEsperaDesde(atualizacoes());
        fixar(null);
      }
      // os outros (o agendamento mudou de estado, por exemplo) ficam na tela,
      // presos, até o usuário dispensar
      void queryClient.invalidateQueries({ queryKey: AGENDA_KEY });
    },
  });
  // o resultado na tela até o usuário dispensar: nada de opções por trás
  const resultadoFinal = feito !== null || (remarcar.isError && !ehOcupado(remarcar.error));
  const opcoes = useQuery({
    queryKey: chaveDasOpcoes,
    queryFn: () =>
      api.get<ClinicsRescheduleOptionsDto>(
        `/api/clinics/appointments/${encodeURIComponent(agendamento.id)}/reschedule-options?limit=${QUANTOS}`,
      ),
    enabled: !resultadoFinal,
  });
  const atualizando = esperaDesde !== null && atualizacoes() <= esperaDesde;

  const dispensar = () => {
    setFeito(null);
    setEsperaDesde(null);
    remarcar.reset();
    fixar(null);
  };
  const confirmar = (opcao: ClinicsRescheduleOptionDto) => {
    // preso desde o clique: nem a resposta nem a invalidação trocam o cartão
    fixar(agendamento);
    remarcar.mutate(opcao);
  };

  if (feito) {
    return (
      <Cartao>
        <p role="status" className="text-[13.5px]">
          Remarcado: {feito.serviceName} para{' '}
          <span className="num">{rotuloDoHorario(feito.localDate, feito.localStart)}</span>, com{' '}
          {feito.professionalName}.
        </p>
        <Dispensar onClick={dispensar} />
      </Cartao>
    );
  }

  const de = rotuloDoHorario(agendamento.localDate, agendamento.localStart);
  if (resultadoFinal) {
    return (
      <Cartao>
        <p className="text-[13.5px]">
          Remarcar {agendamento.serviceName} de <span className="num">{de}</span>:
        </p>
        <p role="alert" className="text-data text-negative">
          {mensagemDoErro(remarcar.error, 'atualizadas')}
        </p>
        <Dispensar onClick={dispensar} />
      </Cartao>
    );
  }

  return (
    <Cartao>
      <p className="text-[13.5px]">
        Remarcar {agendamento.serviceName} de <span className="num">{de}</span> para:
      </p>
      {remarcar.isError ? (
        <p role="alert" className="text-data text-negative">
          {mensagemDoErro(
            remarcar.error,
            opcoes.isError ? 'indisponiveis' : atualizando ? 'atualizando' : 'atualizadas',
          )}
        </p>
      ) : null}
      {opcoes.isError ? (
        <p className="text-data text-negative">
          Sugestão indisponível agora
          {opcoes.error instanceof ApiError ? `: ${opcoes.error.message}` : '.'}
        </p>
      ) : !opcoes.data ? (
        <div aria-busy="true">
          <span
            aria-hidden
            className="block h-3.5 w-2/3 animate-pulse rounded bg-border motion-reduce:animate-none"
          />
          <p className="sr-only" role="status">
            Carregando os horários livres…
          </p>
        </div>
      ) : opcoes.data.options.length === 0 ? (
        <p className="text-[13px] text-muted-fg">
          Nenhum horário livre com {agendamento.professionalName} nos próximos dias.
        </p>
      ) : escolhida ? (
        <div className="flex flex-col gap-2">
          <p className="text-[13px]">
            Confirmar a remarcação para{' '}
            <span className="num font-semibold">
              {rotuloDoHorario(escolhida.localDate, escolhida.localStart, escolhida.utcOffset)}
            </span>
            ? A confirmação do horário antigo deixa de valer.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              size="sm"
              disabled={remarcar.isPending}
              onClick={() => confirmar(escolhida)}
            >
              {remarcar.isPending ? 'Remarcando…' : 'Confirmar remarcação'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={remarcar.isPending}
              onClick={() => setEscolhida(null)}
            >
              Voltar
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2" aria-busy={atualizando || undefined}>
          {opcoes.data.options.map((o) => (
            <Button
              key={o.startsAt}
              variant="secondary"
              size="sm"
              className="num"
              // as opções de antes do conflito podem incluir o horário tomado
              disabled={atualizando}
              onClick={() => {
                remarcar.reset();
                setEsperaDesde(null);
                setEscolhida(o);
              }}
            >
              {rotuloDoHorario(o.localDate, o.localStart, o.utcOffset)}
            </Button>
          ))}
        </div>
      )}
    </Cartao>
  );
}

function Dispensar({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="ghost" size="sm" className="self-start" onClick={onClick}>
      Dispensar
    </Button>
  );
}

/** O cartão do canvas, com o rótulo "Sugestão" e a cor de acento (nunca a de IA). */
function Cartao({ children }: { children: ReactNode }) {
  return (
    <div
      role="group"
      aria-label="Sugestão"
      className="flex gap-3 rounded-[12px] border border-accent/40 bg-accent/5 p-3.5"
    >
      <span aria-hidden className="mt-1.5 h-2 w-2 flex-none rounded-full bg-accent" />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <h3 className="text-[13px] font-semibold text-accent">Sugestão</h3>
        {children}
      </div>
    </div>
  );
}
