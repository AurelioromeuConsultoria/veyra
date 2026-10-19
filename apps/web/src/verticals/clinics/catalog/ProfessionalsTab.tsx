import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { MemberDto } from '@veyra/contracts';
import {
  clinicsProfessionalProfileSchema,
  type ClinicsProfessionalDto,
  type ClinicsServiceDto,
  type ClinicsUnitDto,
} from '@veyra/contracts/verticals/clinics';
import { Archive, ArchiveRestore, Pencil, Plus, X } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../../components/ui/button';
import { Drawer } from '../../../components/ui/drawer';
import { Field, Input, Select } from '../../../components/ui/input';
import { EmptyState, Panel } from '../../../components/ui/page';
import { api, ApiError } from '../../../lib/api';
import { hasPermission, useSession } from '../../../lib/session';
import {
  endInputToMinutes,
  hhmmToMinutes,
  minutesToEndInput,
  minutesToHHMM,
  WEEKDAYS,
} from '../format';
import { SERVICES_KEY } from './ServicesTab';
import { UNITS_KEY } from './UnitTab';

const PROFESSIONALS_KEY = ['clinics', 'catalog', 'professionals'] as const;
/** a mesma chave da aba Serviços sem arquivados: um cache só */
const ACTIVE_SERVICES_KEY = [...SERVICES_KEY, false] as const;

/** Aviso exigido pela aprovação da entrega 2 (ADR-048 adendo 1, item 22). */
export const ACCOUNT_LINK_NOTICE =
  'Vincular uma conta não muda o papel nem concede permissões. O que a pessoa pode fazer continua definido pelo papel dela, na gestão de membros.';

const erroDe = (error: unknown) =>
  error instanceof ApiError ? error.message : 'Tente de novo em instantes.';

function horariosResumo(professional: ClinicsProfessionalDto): string {
  const dias = new Set(professional.workingHours.map((interval) => interval.weekday));
  return WEEKDAYS.filter((day) => dias.has(day.iso))
    .map((day) => day.short)
    .join(', ');
}

export function ProfessionalsTab() {
  const { data: user } = useSession();
  const canManage = hasPermission(user, 'clinics:catalog:manage');
  const canReadMembers = hasPermission(user, 'members:read');
  const queryClient = useQueryClient();
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<ClinicsProfessionalDto | 'new' | null>(null);
  // uma SESSÃO por abertura do drawer: criar o profissional não remonta o
  // editor (a confirmação continua à vista e o próximo salvar vai ao perfil)
  const [sessao, setSessao] = useState(0);
  const abrir = (alvo: ClinicsProfessionalDto | 'new') => {
    setSessao((n) => n + 1);
    setEditing(alvo);
  };

  const professionals = useQuery({
    queryKey: [...PROFESSIONALS_KEY, showArchived],
    queryFn: () =>
      api.get<ClinicsProfessionalDto[]>(
        `/api/clinics/professionals${showArchived ? '?includeArchived=true' : ''}`,
      ),
  });
  const services = useQuery({
    queryKey: ACTIVE_SERVICES_KEY,
    queryFn: () => api.get<ClinicsServiceDto[]>('/api/clinics/services'),
  });
  // membros só para quem pode vê-los E vincular: nome e e-mail vêm daqui, nunca
  // do catálogo. O cache da chave ['members'] é compartilhado com outras telas,
  // então a PERMISSÃO decide se o dado é usado — não só se a consulta sai
  const podeVerMembros = canManage && canReadMembers;
  const members = useQuery({
    queryKey: ['members'],
    queryFn: () => api.get<MemberDto[]>('/api/members'),
    enabled: podeVerMembros,
  });
  const listaDeMembros = podeVerMembros ? members.data : undefined;
  const archive = useMutation({
    mutationFn: ({ id, archived }: { id: string; archived: boolean }) =>
      api.post<ClinicsProfessionalDto>(
        `/api/clinics/professionals/${id}/${archived ? 'archive' : 'unarchive'}`,
      ),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['clinics', 'catalog'] }),
  });

  const nomeDoServico = new Map((services.data ?? []).map((s) => [s.id, s.name]));
  const contaLegivel = (professional: ClinicsProfessionalDto) => {
    if (!professional.account) return '—';
    const membro = listaDeMembros?.find(
      (m) => m.membershipId === professional.account?.membershipId,
    );
    const base = membro ? membro.name : 'Conta vinculada';
    return professional.account.active ? base : `${base} (conta removida)`;
  };

  return (
    <>
      <div className="mb-3 flex items-center gap-3">
        <label className="flex items-center gap-2 text-body-sm text-muted-fg">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(event) => setShowArchived(event.target.checked)}
          />
          Mostrar arquivados
        </label>
        {canManage ? (
          <Button variant="primary" size="sm" className="ml-auto" onClick={() => abrir('new')}>
            <Plus size={14} /> Novo profissional
          </Button>
        ) : null}
      </div>
      {professionals.isError ? (
        <p role="alert" className="mb-3 text-data text-negative">
          Não foi possível carregar os profissionais. {erroDe(professionals.error)}
        </p>
      ) : null}
      {archive.isError ? (
        <p role="alert" className="mb-3 text-data text-negative">
          Não foi possível arquivar ou desarquivar. {erroDe(archive.error)}
        </p>
      ) : null}
      <Panel>
        <table className="w-full border-collapse text-body-sm">
          <thead>
            <tr className="border-b border-border bg-surface-2/50">
              {['Profissional', 'Conta', 'Serviços', 'Atende', 'Situação', ''].map(
                (header, index) => (
                  <th
                    key={`${header}-${index}`}
                    className="eyebrow px-4 py-2 text-left text-muted-fg"
                  >
                    {header}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {(professionals.data ?? []).map((professional) => (
              <tr key={professional.id} className="border-b border-border/60 last:border-b-0">
                <td className="px-4 py-2">{professional.name}</td>
                <td className="px-4 py-2 text-muted-fg">{contaLegivel(professional)}</td>
                <td className="max-w-xs truncate px-4 py-2 text-muted-fg">
                  {professional.serviceIds
                    .map((id) => nomeDoServico.get(id))
                    .filter(Boolean)
                    .join(', ') || '—'}
                </td>
                <td className="px-4 py-2 text-data text-muted-fg">
                  {horariosResumo(professional) || '—'}
                </td>
                <td className="px-4 py-2 text-muted-fg">
                  {professional.archivedAt ? 'Arquivado' : 'Ativo'}
                </td>
                <td className="px-4 py-2 text-right">
                  {canManage ? (
                    <span className="inline-flex gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Editar ${professional.name}`}
                        onClick={() => abrir(professional)}
                      >
                        <Pencil size={14} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`${professional.archivedAt ? 'Desarquivar' : 'Arquivar'} ${professional.name}`}
                        onClick={() =>
                          archive.mutate({
                            id: professional.id,
                            archived: !professional.archivedAt,
                          })
                        }
                      >
                        {professional.archivedAt ? (
                          <ArchiveRestore size={14} />
                        ) : (
                          <Archive size={14} />
                        )}
                      </Button>
                    </span>
                  ) : null}
                </td>
              </tr>
            ))}
            {professionals.data && professionals.data.length === 0 ? (
              <tr>
                <td colSpan={6}>
                  <EmptyState
                    title="Nenhum profissional cadastrado."
                    hint="Profissional é quem atende na agenda; não precisa ter conta no Veyra."
                  />
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </Panel>

      <Drawer
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        title={editing === 'new' ? 'Novo profissional' : 'Editar profissional'}
      >
        {editing !== null ? (
          <ProfessionalEditorGate
            key={sessao}
            professional={editing === 'new' ? null : editing}
            members={listaDeMembros}
            canLinkAccount={canReadMembers}
            onSaved={(saved) => {
              setEditing(saved);
              void queryClient.invalidateQueries({ queryKey: ['clinics', 'catalog'] });
            }}
          />
        ) : null}
      </Drawer>
    </>
  );
}

/**
 * O editor só monta com serviços E unidades CARREGADOS. Montado antes, o estado
 * inicial nasceria de listas vazias, e "Salvar perfil" substituiria o conjunto
 * de serviços por nada — perda de dado dita como sucesso (achado da revisão).
 */
function ProfessionalEditorGate(props: {
  professional: ClinicsProfessionalDto | null;
  members: MemberDto[] | undefined;
  canLinkAccount: boolean;
  onSaved: (saved: ClinicsProfessionalDto) => void;
}) {
  const services = useQuery({
    queryKey: ACTIVE_SERVICES_KEY,
    queryFn: () => api.get<ClinicsServiceDto[]>('/api/clinics/services'),
  });
  const units = useQuery({
    queryKey: UNITS_KEY,
    queryFn: () => api.get<ClinicsUnitDto[]>('/api/clinics/units'),
  });
  // o erro só importa SEM dados: uma recarga que falha depois de um salvamento
  // (os dados já carregados continuam valendo) não desmonta o editor
  if (!services.data || !units.data) {
    if (services.isError || units.isError) {
      return (
        <p role="alert" className="text-data text-negative">
          Não foi possível carregar serviços e unidades. {erroDe(services.error ?? units.error)}
        </p>
      );
    }
    return <p className="text-body-sm text-muted-fg">Carregando…</p>;
  }
  return <ProfessionalEditor {...props} services={services.data} units={units.data} />;
}

type IntervalRow = { key: number; unitId: string; start: string; end: string };
let nextKey = 1;

/**
 * Duas partes, com LIMITES de salvamento explícitos (ADR-048 adendo 1, item 23):
 * 1. PERFIL — nome, serviços e horários — salvos JUNTOS, numa transação: ou
 *    tudo, ou nada. A mensagem de erro diz que nada foi salvo.
 * 2. CONTA VINCULADA — ação separada, porque exige outra permissão.
 */
function ProfessionalEditor({
  professional,
  services,
  units,
  members,
  canLinkAccount,
  onSaved,
}: {
  professional: ClinicsProfessionalDto | null;
  services: ClinicsServiceDto[];
  units: ClinicsUnitDto[];
  members: MemberDto[] | undefined;
  canLinkAccount: boolean;
  onSaved: (saved: ClinicsProfessionalDto) => void;
}) {
  const defaultUnit = units[0]?.id ?? '';
  const [name, setName] = useState(professional?.name ?? '');
  // parte do que o profissional TEM, sem filtrar; o filtro de ativos é no envio
  const [serviceIds, setServiceIds] = useState<string[]>(professional?.serviceIds ?? []);
  const ativos = new Set(services.map((s) => s.id));
  const arquivados = serviceIds.filter((id) => !ativos.has(id));
  const [rows, setRows] = useState<Record<number, IntervalRow[]>>(() => {
    const porDia: Record<number, IntervalRow[]> = {};
    for (const interval of professional?.workingHours ?? []) {
      (porDia[interval.weekday] ??= []).push({
        key: nextKey++,
        unitId: interval.unitId,
        start: minutesToHHMM(interval.startMinute),
        end: minutesToEndInput(interval.endMinute),
      });
    }
    return porDia;
  });
  const [problema, setProblema] = useState<string | null>(null);
  const [salvo, setSalvo] = useState(false);

  const save = useMutation({
    mutationFn: (body: unknown) =>
      professional
        ? api.put<ClinicsProfessionalDto>(
            `/api/clinics/professionals/${professional.id}/profile`,
            body,
          )
        : api.post<ClinicsProfessionalDto>('/api/clinics/professionals', body),
    onSuccess: (saved) => {
      setSalvo(true);
      setServiceIds(saved.serviceIds);
      onSaved(saved);
    },
    onError: (error) => setProblema(`Nada foi salvo. ${erroDe(error)}`),
  });

  const salvarPerfil = () => {
    setSalvo(false);
    setProblema(null);
    const intervals = [];
    for (const day of WEEKDAYS) {
      for (const row of rows[day.iso] ?? []) {
        const startMinute = hhmmToMinutes(row.start);
        const endMinute = endInputToMinutes(row.end);
        if (startMinute === undefined || endMinute === undefined) {
          setProblema(`Nada foi salvo. Horário inválido: ${day.label.toLowerCase()}.`);
          return;
        }
        intervals.push({
          unitId: row.unitId || defaultUnit,
          weekday: day.iso,
          startMinute,
          endMinute,
        });
      }
    }
    // a MESMA validação do servidor (contrato compartilhado). Vínculo com
    // serviço arquivado sai no envio, como avisado abaixo (adendo 1, item 19)
    const parsed = clinicsProfessionalProfileSchema.safeParse({
      name,
      serviceIds: serviceIds.filter((id) => ativos.has(id)),
      intervals,
    });
    if (!parsed.success) {
      setProblema(`Nada foi salvo. ${parsed.error.issues[0]?.message ?? 'Verifique os campos.'}`);
      return;
    }
    save.mutate(parsed.data);
  };

  const mudarDia = (iso: number, fn: (atual: IntervalRow[]) => IntervalRow[]) => {
    setSalvo(false);
    setRows((atual) => ({ ...atual, [iso]: fn(atual[iso] ?? []) }));
  };

  return (
    <div className="space-y-6">
      <section aria-labelledby="perfil" className="space-y-4">
        <h2 id="perfil" className="eyebrow text-muted-fg">
          Perfil — nome, serviços e horários são salvos juntos
        </h2>
        <Field label="Nome">
          <Input
            value={name}
            onChange={(event) => {
              setSalvo(false);
              setName(event.target.value);
            }}
          />
        </Field>

        <fieldset>
          <legend className="eyebrow mb-1.5 text-muted-fg">Serviços que faz</legend>
          {services.length === 0 ? (
            <p className="text-data text-muted-fg">Cadastre serviços na aba Serviços.</p>
          ) : (
            <div className="space-y-1">
              {services.map((service) => (
                <label key={service.id} className="flex items-center gap-2 text-body-sm">
                  <input
                    type="checkbox"
                    checked={serviceIds.includes(service.id)}
                    onChange={(event) => {
                      setSalvo(false);
                      setServiceIds((atual) =>
                        event.target.checked
                          ? [...atual, service.id]
                          : atual.filter((id) => id !== service.id),
                      );
                    }}
                  />
                  {service.name}
                </label>
              ))}
            </div>
          )}
          {arquivados.length > 0 ? (
            <p className="mt-1.5 text-data text-muted-fg">
              {arquivados.length === 1
                ? '1 serviço arquivado deixa de estar habilitado ao salvar.'
                : `${arquivados.length} serviços arquivados deixam de estar habilitados ao salvar.`}
            </p>
          ) : null}
        </fieldset>

        <fieldset>
          <legend className="eyebrow mb-1.5 text-muted-fg">Horários de atendimento</legend>
          <p className="mb-2 text-data text-muted-fg">
            Hora local da unidade. Para atender até o fim do dia, use 00:00 no fim.
          </p>
          <div className="space-y-2">
            {WEEKDAYS.map((day) => (
              <div key={day.iso} className="flex flex-wrap items-center gap-2">
                <span className="w-16 text-body-sm">{day.short}</span>
                {(rows[day.iso] ?? []).map((row) => (
                  <span key={row.key} className="inline-flex items-center gap-1">
                    <Input
                      type="time"
                      step={300}
                      aria-label={`${day.label}: início`}
                      className="w-24"
                      value={row.start}
                      onChange={(event) =>
                        mudarDia(day.iso, (atual) =>
                          atual.map((r) =>
                            r.key === row.key ? { ...r, start: event.target.value } : r,
                          ),
                        )
                      }
                    />
                    <span className="text-muted-fg">–</span>
                    <Input
                      type="time"
                      step={300}
                      aria-label={`${day.label}: fim`}
                      className="w-24"
                      value={row.end}
                      onChange={(event) =>
                        mudarDia(day.iso, (atual) =>
                          atual.map((r) =>
                            r.key === row.key ? { ...r, end: event.target.value } : r,
                          ),
                        )
                      }
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Remover intervalo de ${day.label.toLowerCase()}`}
                      onClick={() =>
                        mudarDia(day.iso, (atual) => atual.filter((r) => r.key !== row.key))
                      }
                    >
                      <X size={14} />
                    </Button>
                  </span>
                ))}
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Acrescentar intervalo na ${day.label.toLowerCase()}`}
                  onClick={() =>
                    mudarDia(day.iso, (atual) => [
                      ...atual,
                      { key: nextKey++, unitId: defaultUnit, start: '08:00', end: '12:00' },
                    ])
                  }
                >
                  <Plus size={14} />
                </Button>
              </div>
            ))}
          </div>
        </fieldset>

        {problema ? (
          <p role="alert" className="text-data text-negative">
            {problema}
          </p>
        ) : null}
        {salvo && !problema ? (
          <p role="status" className="text-data text-positive">
            Perfil salvo: nome, serviços e horários.
          </p>
        ) : null}
        <Button variant="primary" onClick={salvarPerfil} disabled={save.isPending}>
          {save.isPending ? 'Salvando…' : 'Salvar perfil'}
        </Button>
      </section>

      {professional ? (
        <AccountLink
          professional={professional}
          members={members}
          canLink={canLinkAccount}
          onSaved={onSaved}
        />
      ) : (
        <p className="text-data text-muted-fg">
          Depois de salvar o perfil, você pode vincular uma conta ao profissional.
        </p>
      )}
    </div>
  );
}

/** Ação SEPARADA do perfil: exige também `members:read` (adendo 1, itens 12 e 22). */
function AccountLink({
  professional,
  members,
  canLink,
  onSaved,
}: {
  professional: ClinicsProfessionalDto;
  members: MemberDto[] | undefined;
  canLink: boolean;
  onSaved: (saved: ClinicsProfessionalDto) => void;
}) {
  const [membershipId, setMembershipId] = useState(professional.account?.membershipId ?? '');
  const [mensagem, setMensagem] = useState<{ ok: boolean; texto: string } | null>(null);
  const link = useMutation({
    mutationFn: () =>
      api.put<ClinicsProfessionalDto>(`/api/clinics/professionals/${professional.id}/account`, {
        membershipId: membershipId || null,
      }),
    onSuccess: (saved) => {
      setMensagem({ ok: true, texto: 'Vínculo salvo.' });
      onSaved(saved);
    },
    onError: (error) =>
      setMensagem({
        ok: false,
        texto: `O vínculo não foi salvo. ${erroDe(error)} O perfil não foi alterado.`,
      }),
  });

  return (
    <section aria-labelledby="conta" className="space-y-3 border-t border-border pt-5">
      <h2 id="conta" className="eyebrow text-muted-fg">
        Conta vinculada — salva à parte
      </h2>
      <p className="text-data text-muted-fg">{ACCOUNT_LINK_NOTICE}</p>
      {!canLink ? (
        <p className="text-data text-muted-fg">
          Vincular uma conta exige também permissão para ver os membros do workspace.
        </p>
      ) : (
        <>
          <Field label="Conta">
            <Select
              full
              value={membershipId}
              onChange={(event) => {
                setMensagem(null);
                setMembershipId(event.target.value);
              }}
            >
              <option value="">Nenhuma</option>
              {(members ?? [])
                .filter((m) => m.status === 'active' || m.membershipId === membershipId)
                .map((m) => (
                  <option key={m.membershipId} value={m.membershipId}>
                    {m.name} · {m.email}
                  </option>
                ))}
            </Select>
          </Field>
          {mensagem ? (
            <p
              role={mensagem.ok ? 'status' : 'alert'}
              className={mensagem.ok ? 'text-data text-positive' : 'text-data text-negative'}
            >
              {mensagem.texto}
            </p>
          ) : null}
          <Button onClick={() => link.mutate()} disabled={link.isPending}>
            {link.isPending ? 'Salvando…' : 'Salvar vínculo'}
          </Button>
        </>
      )}
    </section>
  );
}
