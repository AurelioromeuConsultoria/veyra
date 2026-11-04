import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  ClinicsAppointmentDto,
  ClinicsCancelReason,
  ClinicsProfessionalDto,
} from '@veyra/contracts/verticals/clinics';
import { useRef, useState } from 'react';
import { Avatar } from '../../../components/ui/avatar';
import { Button } from '../../../components/ui/button';
import { Drawer } from '../../../components/ui/drawer';
import { Field, Select } from '../../../components/ui/input';
import { StatusChip } from '../../../components/ui/status';
import { api, ApiError } from '../../../lib/api';
import { CorrecaoDeConsumo } from './CorrecaoDeConsumo';
import { RegistroDeAtendimento } from './RegistroDeAtendimento';
import {
  AGENDA_KEY,
  ATENDIVEIS,
  ROTULO_DO_ESTADO,
  ROTULO_DO_MOTIVO,
  TOM_DO_ESTADO,
  TRANSICOES,
} from './slots';
import { VinculoComOportunidade } from './VinculoComOportunidade';

const ROTULO_DA_ACAO = {
  // confirmar à mão não é enviar a confirmação por WhatsApp (ADR-055, adendo 4)
  confirmed: 'Marcar como confirmado',
  arrived: 'Registrar chegada',
  no_show: 'Marcar falta',
} as const;

/** Como o agendamento se identifica em todo rótulo: hora, paciente e profissional. */
export function quemDoAgendamento(a: ClinicsAppointmentDto): string {
  return `${a.localStart} ${a.patientName} (${a.professionalName})`;
}

/** Devolve o foco ao bloco do agendamento na grade (o teclado continua de onde parou). */
export function focarBloco(id: string) {
  const alvo = Array.from(document.querySelectorAll<HTMLElement>('[data-bloco]')).find(
    (b) => b.dataset.bloco === id,
  );
  alvo?.focus();
}

type Painel = 'detalhe' | 'registro' | 'correcao' | 'oportunidade';

/**
 * O agendamento aberto da grade (ADR-062): o bloco é pequeno demais para as
 * ações, então elas vivem aqui — todas as que o cartão tinha, com os mesmos
 * rótulos. Registrar, corrigir e a oportunidade trocam este painel pelo deles;
 * remarcar usa o drawer da página. Fechar qualquer um volta à grade.
 */
export function PainelDoAgendamento({
  agendamento,
  podeMarcar,
  podeAtender,
  podeCorrigir,
  podeVerOportunidade,
  fuso,
  podeRemarcar,
  onRemarcar,
  profissionais,
  onFechar,
}: {
  agendamento: ClinicsAppointmentDto;
  podeMarcar: boolean;
  podeAtender: boolean;
  podeCorrigir: boolean;
  podeVerOportunidade: boolean;
  fuso: string | null;
  podeRemarcar: boolean;
  onRemarcar: () => void;
  /** os ativos: a cobertura depois da chegada escolhe entre os habilitados */
  profissionais: ClinicsProfessionalDto[];
  onFechar: () => void;
}) {
  const queryClient = useQueryClient();
  const [painel, setPainel] = useState<Painel>('detalhe');
  const recarregar = () => void queryClient.invalidateQueries({ queryKey: AGENDA_KEY });
  // o foco só volta ao bloco quando a pessoa FECHA; trocar de painel não conta
  const fechando = useRef(false);
  const fechar = () => {
    fechando.current = true;
    onFechar();
  };
  const devolverFoco = (event: Event) => {
    event.preventDefault();
    if (fechando.current) focarBloco(agendamento.id);
  };
  const aoMudarAberto = (aberto: boolean) => {
    if (!aberto) fechar();
  };

  const [cancelando, setCancelando] = useState(false);
  const [trocando, setTrocando] = useState(false);
  const [novoProfissional, setNovoProfissional] = useState('');
  // a cobertura depois da chegada (ADR-061): só quem faz o serviço, menos o atual
  const cobrem = profissionais.filter(
    (p) => p.id !== agendamento.professionalId && p.serviceIds.includes(agendamento.serviceId),
  );
  const trocar = useMutation({
    mutationFn: (professionalId: string) =>
      api.post<ClinicsAppointmentDto>(`/api/clinics/appointments/${agendamento.id}/professional`, {
        professionalId,
      }),
    onSuccess: () => {
      setTrocando(false);
      setNovoProfissional('');
    },
    onSettled: recarregar,
  });
  const [motivo, setMotivo] = useState<ClinicsCancelReason | ''>('');
  const mudar = useMutation({
    mutationFn: (corpo: { to: string; cancelReason?: ClinicsCancelReason }) =>
      api.post<ClinicsAppointmentDto>(`/api/clinics/appointments/${agendamento.id}/status`, corpo),
    onSuccess: () => {
      setCancelando(false);
      setMotivo('');
    },
    onSettled: recarregar,
  });
  const erro = mudar.error ?? trocar.error;
  const quem = quemDoAgendamento(agendamento);
  const transicoes = TRANSICOES[agendamento.status];
  const tom = TOM_DO_ESTADO[agendamento.status];

  return (
    <>
      <Drawer
        open={painel === 'detalhe'}
        onOpenChange={aoMudarAberto}
        title="Agendamento"
        onCloseAutoFocus={devolverFoco}
      >
        <div className="space-y-5">
          <header className="flex items-center gap-3">
            <Avatar nome={agendamento.patientName} chave={agendamento.patientId} tamanho="lg" />
            <div className="min-w-0">
              <p className="truncate text-[16px] font-semibold">{agendamento.patientName}</p>
              <p className="truncate text-[13px] text-muted-fg">
                {agendamento.serviceName} · {agendamento.professionalName}
              </p>
            </div>
          </header>
          <dl className="grid grid-cols-[auto_1fr] items-center gap-x-5 gap-y-2.5 text-[13.5px]">
            <dt className="text-muted-fg">Horário</dt>
            <dd className="num">
              {agendamento.localStart}–{agendamento.localEnd}
            </dd>
            <dt className="text-muted-fg">Estado</dt>
            <dd>
              <StatusChip tom={tom}>
                {ROTULO_DO_ESTADO[agendamento.status]}
                {agendamento.cancelReason ? ` · ${ROTULO_DO_MOTIVO[agendamento.cancelReason]}` : ''}
              </StatusChip>
            </dd>
          </dl>
          {erro ? (
            <p role="alert" className="text-data text-negative">
              {erro instanceof ApiError ? erro.message : 'Não foi possível concluir.'}
            </p>
          ) : null}
          {cancelando ? null : (
            <div className="flex flex-wrap gap-2">
              {podeAtender &&
              ATENDIVEIS.includes(agendamento.status) &&
              // D8 (ADR-061): só o horário no alcance clínico de quem atende
              agendamento.careInScope === true ? (
                <Button
                  size="sm"
                  variant="primary"
                  aria-label={`Registrar atendimento: ${quem}`}
                  onClick={() => {
                    mudar.reset();
                    setPainel('registro');
                  }}
                >
                  Registrar atendimento
                </Button>
              ) : null}
              {podeMarcar
                ? transicoes
                    .filter((t) => t !== 'canceled')
                    .map((t) => (
                      <Button
                        key={t}
                        size="sm"
                        variant="secondary"
                        disabled={mudar.isPending}
                        aria-label={`${ROTULO_DA_ACAO[t]}: ${quem}`}
                        onClick={() => mudar.mutate({ to: t })}
                      >
                        {ROTULO_DA_ACAO[t]}
                      </Button>
                    ))
                : null}
              {podeRemarcar &&
              (agendamento.status === 'scheduled' || agendamento.status === 'confirmed') ? (
                <Button
                  size="sm"
                  variant="secondary"
                  aria-label={`Remarcar: ${quem}`}
                  onClick={onRemarcar}
                >
                  Remarcar
                </Button>
              ) : null}
              {podeCorrigir && agendamento.attendanceId && agendamento.careInScope === true ? (
                <Button
                  size="sm"
                  variant="secondary"
                  aria-label={`Corrigir consumo: ${quem}`}
                  onClick={() => setPainel('correcao')}
                >
                  Corrigir consumo
                </Button>
              ) : null}
              {podeVerOportunidade ? (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Oportunidade: ${quem}`}
                  onClick={() => setPainel('oportunidade')}
                >
                  Oportunidade
                </Button>
              ) : null}
              {podeMarcar && transicoes.includes('canceled') ? (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Cancelar: ${quem}`}
                  onClick={() => setCancelando(true)}
                >
                  Cancelar
                </Button>
              ) : null}
            </div>
          )}
          {podeMarcar && agendamento.status === 'arrived' && !cancelando ? (
            trocando ? (
              <div className="flex flex-wrap items-end gap-2">
                <Field label="Quem vai atender">
                  <Select
                    size="sm"
                    aria-label={`Quem vai atender: ${quem}`}
                    value={novoProfissional}
                    onChange={(e) => setNovoProfissional(e.target.value)}
                  >
                    <option value="" disabled>
                      {cobrem.length === 0
                        ? 'Ninguém mais faz este serviço'
                        : 'Escolha o profissional'}
                    </option>
                    {cobrem.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Button
                  size="sm"
                  variant="primary"
                  aria-label={`Confirmar troca: ${quem}`}
                  disabled={!novoProfissional || trocar.isPending}
                  onClick={() => trocar.mutate(novoProfissional)}
                >
                  Confirmar troca
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setTrocando(false);
                    setNovoProfissional('');
                  }}
                >
                  Voltar
                </Button>
              </div>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Trocar profissional: ${quem}`}
                onClick={() => {
                  trocar.reset();
                  setTrocando(true);
                }}
              >
                Trocar profissional
              </Button>
            )
          ) : null}
          {cancelando ? (
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Motivo do cancelamento">
                <Select
                  size="sm"
                  aria-label={`Motivo do cancelamento: ${quem}`}
                  value={motivo}
                  onChange={(e) => setMotivo(e.target.value as ClinicsCancelReason)}
                >
                  <option value="" disabled>
                    Escolha o motivo
                  </option>
                  {(Object.keys(ROTULO_DO_MOTIVO) as ClinicsCancelReason[]).map((m) => (
                    <option key={m} value={m}>
                      {ROTULO_DO_MOTIVO[m]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Button
                size="sm"
                variant="danger"
                aria-label={`Confirmar cancelamento: ${quem}`}
                disabled={!motivo || mudar.isPending}
                onClick={() => motivo && mudar.mutate({ to: 'canceled', cancelReason: motivo })}
              >
                Confirmar cancelamento
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setCancelando(false);
                  setMotivo('');
                }}
              >
                Voltar
              </Button>
            </div>
          ) : null}
        </div>
      </Drawer>
      <Drawer
        open={painel === 'registro'}
        onOpenChange={aoMudarAberto}
        title="Registrar atendimento"
        onCloseAutoFocus={devolverFoco}
      >
        {painel === 'registro' ? (
          <RegistroDeAtendimento
            agendamento={agendamento}
            fuso={fuso}
            onAgendaMudou={recarregar}
            onDone={fechar}
          />
        ) : null}
      </Drawer>
      <Drawer
        open={painel === 'correcao'}
        onOpenChange={aoMudarAberto}
        title="Corrigir consumo"
        onCloseAutoFocus={devolverFoco}
      >
        {painel === 'correcao' ? (
          <CorrecaoDeConsumo
            agendamento={agendamento}
            fuso={fuso}
            onAgendaMudou={recarregar}
            onDone={fechar}
          />
        ) : null}
      </Drawer>
      <Drawer
        open={painel === 'oportunidade'}
        onOpenChange={aoMudarAberto}
        title="Oportunidade"
        onCloseAutoFocus={devolverFoco}
      >
        {painel === 'oportunidade' ? (
          <VinculoComOportunidade agendamento={agendamento} podeMudar={podeMarcar} />
        ) : null}
      </Drawer>
    </>
  );
}
