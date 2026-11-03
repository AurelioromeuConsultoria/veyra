import { useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ClinicsAppointmentDto,
  ClinicsAttendanceDto,
  ClinicsPackageCorrectionDto,
  ClinicsPackageCorrectionReason,
  ClinicsPackageDto,
} from '@veyra/contracts/verticals/clinics';
import { useState } from 'react';
import { Button } from '../../../components/ui/button';
import { Field, Select } from '../../../components/ui/input';
import { api } from '../../../lib/api';
import { useRegistroIdempotente } from '../../../lib/registro-idempotente';
import { PACKAGES_KEY, ROTULO_DO_MOTIVO_DA_CORRECAO, quandoLocal } from '../continuidade';

/** A escolha: `undefined` = nada escolhido; `null` = avulso; texto = o pacote. */
type Escolha = string | null | undefined;

export const ATTENDANCE_KEY = ['clinics', 'attendance'] as const;

/**
 * Correção do consumo de um atendimento JÁ registrado (ADR-059, F5.2b). A tela
 * mostra o consumo atual, a escolha nova, o saldo antes e depois dos dois
 * pacotes, o motivo e a confirmação. Valem as regras do registro:
 * - nada vem marcado, nem o motivo;
 * - enquanto o consumo atual ou os pacotes carregam, ou se a leitura falha, não
 *   se confirma: a falha nunca vira "avulso";
 * - o pedido leva a revisão do consumo que a pessoa viu: se outra pessoa
 *   corrigiu antes, o servidor recusa (409), e a tela relê tudo e desfaz a escolha;
 * - a mesma chave só para repetir o MESMO pedido quando o resultado não chegou.
 */
export function CorrecaoDeConsumo({
  agendamento,
  fuso,
  onDone,
  onAgendaMudou,
}: {
  agendamento: ClinicsAppointmentDto;
  fuso: string | null;
  onDone: () => void;
  onAgendaMudou: () => void;
}) {
  const queryClient = useQueryClient();
  const [escolha, setEscolha] = useState<Escolha>(undefined);
  const [motivo, setMotivo] = useState<ClinicsPackageCorrectionReason | ''>('');
  const atendimento = useQuery({
    queryKey: [...ATTENDANCE_KEY, agendamento.id],
    queryFn: () =>
      api.get<ClinicsAttendanceDto>(`/api/clinics/appointments/${agendamento.id}/attendance`),
  });
  const pacotes = useQuery({
    queryKey: [...PACKAGES_KEY, agendamento.patientId],
    queryFn: () =>
      api.get<ClinicsPackageDto[]>(
        `/api/clinics/packages?patientId=${encodeURIComponent(agendamento.patientId)}`,
      ),
  });
  const reler = () => {
    void queryClient.invalidateQueries({ queryKey: PACKAGES_KEY });
    void queryClient.invalidateQueries({ queryKey: [...ATTENDANCE_KEY, agendamento.id] });
    onAgendaMudou();
  };
  const correcao = useRegistroIdempotente(() => {
    // sucesso ou recusa: o consumo e os saldos vêm de novo do servidor, e a
    // escolha feita sobre os números antigos é desfeita
    setEscolha(undefined);
    setMotivo('');
    reler();
  });

  const pronto =
    atendimento.isSuccess && !atendimento.isFetching && pacotes.isSuccess && !pacotes.isFetching;
  const atual = pronto ? (atendimento.data.packageId ?? null) : undefined;
  const lista = pronto ? pacotes.data : [];
  const pacoteAtual = typeof atual === 'string' ? lista.find((p) => p.id === atual) : undefined;
  // as opções: avulso (se hoje consome um pacote) e os pacotes ativos do MESMO
  // serviço, com saldo, menos o atual
  const elegiveis = lista.filter(
    (p) =>
      p.id !== atual &&
      p.status === 'active' &&
      p.serviceId === agendamento.serviceId &&
      p.remainingSessions > 0,
  );
  const escolhido = elegiveis.find((p) => p.id === escolha);
  const criadoEm = (p: ClinicsPackageDto) => quandoLocal(p.createdAt, fuso);
  const nomeDoPacote = (p: ClinicsPackageDto) =>
    `pacote de ${p.totalSessions} sessões, criado em ${criadoEm(p)}`;
  // "cadastrado depois" só vale de avulso para pacote (o servidor confere as datas)
  const motivos = (
    Object.keys(ROTULO_DO_MOTIVO_DA_CORRECAO) as ClinicsPackageCorrectionReason[]
  ).filter((m) => m !== 'package_registered_late' || (atual === null && escolhido !== undefined));
  const podeConfirmar =
    pronto &&
    !correcao.ocupado &&
    motivo !== '' &&
    motivos.includes(motivo) &&
    (escolha === null ? atual !== null : escolhido !== undefined);
  const nome = `correcao-${agendamento.id}`;

  const escolher = (e: Escolha) => {
    setEscolha(e);
    // o motivo que deixou de valer para a escolha nova sai
    if (motivo === 'package_registered_late') setMotivo('');
  };
  const confirmar = () => {
    if (!podeConfirmar || !atendimento.data) return;
    const de = atual === null ? 'avulso' : 'o pacote';
    const para = escolha === null ? 'avulso' : 'o pacote escolhido';
    correcao.registrar({
      caminho: `/api/clinics/appointments/${agendamento.id}/attendance/package-correction`,
      corpo: {
        expectedRevision: atendimento.data.consumptionRevision ?? 0,
        packageId: escolha ?? null,
        reason: motivo,
      },
      rotulo: 'Correção do consumo',
      sucesso: (r) =>
        `Consumo corrigido: de ${de} para ${para} (correção nº ${(r as ClinicsPackageCorrectionDto).revision}).`,
    });
  };

  return (
    <div className="space-y-3 p-5">
      <p className="text-body-sm">
        {agendamento.localDate} {agendamento.localStart} · {agendamento.patientName} ·{' '}
        {agendamento.serviceName}
      </p>
      {correcao.feito ? (
        <p role="status" className="text-body-sm font-medium">
          {correcao.feito}
        </p>
      ) : null}
      {correcao.erro ? (
        <p role="alert" className="text-data text-negative">
          {correcao.erro}
        </p>
      ) : null}
      {correcao.incerta ? (
        <Button size="sm" variant="secondary" onClick={correcao.repetir} disabled={correcao.emVoo}>
          Repetir a mesma correção
        </Button>
      ) : null}
      {atendimento.isError || pacotes.isError ? (
        <div className="space-y-2">
          <p role="alert" className="text-data text-negative">
            Não foi possível carregar o consumo atual e os pacotes. Sem eles, nada é corrigido.
          </p>
          <Button size="sm" variant="ghost" onClick={reler}>
            Tentar de novo
          </Button>
        </div>
      ) : !pronto ? (
        <p className="text-data text-muted-fg">Carregando o consumo atual e os pacotes…</p>
      ) : (
        <>
          <section aria-label="Consumo atual" className="space-y-1">
            <p className="eyebrow text-muted-fg">Consumo atual</p>
            <p className="text-body-sm">
              {atual === null
                ? 'Avulso (sem pacote).'
                : pacoteAtual
                  ? `Uma sessão do ${nomeDoPacote(pacoteAtual)}: restam ${pacoteAtual.remainingSessions}.`
                  : 'Uma sessão de um pacote que não aparece na lista deste paciente.'}
            </p>
            {(atendimento.data.consumptionRevision ?? 0) > 0 ? (
              <p className="text-data text-muted-fg">
                Este consumo já foi corrigido {atendimento.data.consumptionRevision}{' '}
                {atendimento.data.consumptionRevision === 1 ? 'vez' : 'vezes'}.
              </p>
            ) : null}
          </section>
          <fieldset className="space-y-2">
            <legend className="eyebrow text-muted-fg">Corrigir para</legend>
            {elegiveis.map((p) => (
              <label key={p.id} className="flex items-start gap-2 text-body-sm">
                <input
                  type="radio"
                  name={nome}
                  checked={escolha === p.id}
                  onChange={() => escolher(p.id)}
                />
                <span>
                  Pacote de {p.totalSessions} sessões, criado em {criadoEm(p)}: restam{' '}
                  {p.remainingSessions}, ficam {p.remainingSessions - 1}
                </span>
              </label>
            ))}
            {atual !== null ? (
              <label className="flex items-start gap-2 text-body-sm">
                <input
                  type="radio"
                  name={nome}
                  checked={escolha === null}
                  onChange={() => escolher(null)}
                />
                <span>Avulso (sem pacote)</span>
              </label>
            ) : null}
            {elegiveis.length === 0 && atual === null ? (
              <p className="text-data text-muted-fg">
                Nenhum pacote ativo deste serviço com saldo: não há para onde corrigir.
              </p>
            ) : null}
          </fieldset>
          {escolha !== undefined && (escolha === null || escolhido) ? (
            <section aria-label="Saldos depois da correção" className="space-y-1">
              <p className="eyebrow text-muted-fg">Depois da correção</p>
              {pacoteAtual ? (
                <p className="text-body-sm">
                  O {nomeDoPacote(pacoteAtual)} recebe a sessão de volta: restam{' '}
                  {pacoteAtual.remainingSessions} → {pacoteAtual.remainingSessions + 1}.
                </p>
              ) : null}
              {escolhido ? (
                <p className="text-body-sm">
                  O {nomeDoPacote(escolhido)} passa a consumir esta sessão: restam{' '}
                  {escolhido.remainingSessions} → {escolhido.remainingSessions - 1}.
                </p>
              ) : (
                <p className="text-body-sm">O atendimento fica avulso.</p>
              )}
              <p className="text-data text-muted-fg">
                O saldo foi lido agora e não é uma reserva. O servidor confere de novo e, se o
                consumo ou o saldo mudou, recusa sem corrigir nada. O atendimento, os retornos e as
                faltas não mudam.
              </p>
            </section>
          ) : null}
          <Field label="Motivo">
            <Select
              size="sm"
              aria-label="Motivo da correção"
              value={motivo}
              onChange={(e) => setMotivo(e.target.value as ClinicsPackageCorrectionReason)}
            >
              <option value="" disabled>
                Escolha o motivo
              </option>
              {motivos.map((m) => (
                <option key={m} value={m}>
                  {ROTULO_DO_MOTIVO_DA_CORRECAO[m]}
                </option>
              ))}
            </Select>
          </Field>
        </>
      )}
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" size="sm" disabled={!podeConfirmar} onClick={confirmar}>
          Confirmar correção
        </Button>
        <Button variant="ghost" size="sm" onClick={onDone}>
          {correcao.feito ? 'Concluir' : 'Voltar'}
        </Button>
      </div>
    </div>
  );
}
