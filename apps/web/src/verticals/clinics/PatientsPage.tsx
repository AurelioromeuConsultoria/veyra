import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ContactDto, Paginated } from '@veyra/contracts';
import type { ClinicsPatientDto } from '@veyra/contracts/verticals/clinics';
import { UserPlus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '../../components/ui/button';
import { Drawer } from '../../components/ui/drawer';
import { Field, Input } from '../../components/ui/input';
import { EmptyState, PageHeader, Panel } from '../../components/ui/page';
import { api, ApiError, toQuery } from '../../lib/api';
import { fullStamp } from '../../lib/format';
import { hasPermission, useSession } from '../../lib/session';
import { useClinicsAccess } from './access';

const PATIENTS_KEY = ['clinics', 'patients'] as const;
/** Teto da lista na tela; acima dele, a busca (ADR-048 adendo 5). */
export const TETO_DA_LISTA = 50;

/** As consequências de tornar paciente, ditas ANTES de confirmar (ADR-048 adendo 2, item 1). */
export const CONSEQUENCIAS_DO_PACIENTE = [
  'A inteligência deixa de ler este contato, mesmo que ele esteja liberado para IA — e a liberação é revogada.',
  'O contato não pode ser excluído enquanto for paciente.',
  'Não há como desfazer pela tela: o perfil de paciente permanece.',
] as const;

/** O mesmo atraso da busca de contatos: uma consulta por pausa na digitação. */
function useAtrasado(valor: string, ms = 250): string {
  const [atrasado, setAtrasado] = useState(valor);
  useEffect(() => {
    const timer = setTimeout(() => setAtrasado(valor.trim()), ms);
    return () => clearTimeout(timer);
  }, [valor, ms]);
  return atrasado;
}

/**
 * Pacientes da clínica (ADR-048 adendo 5, item 5). PORTA como nas outras telas
 * do vertical. Criar o perfil é ato EXPLÍCITO, com as consequências na tela.
 */
export function ClinicsPatientsPage() {
  const access = useClinicsAccess('clinics:schedule:read');
  if (access === 'loading') {
    return <p className="p-6 text-body-sm text-muted-fg">Carregando…</p>;
  }
  if (access !== 'ready') {
    const mensagem = {
      error: {
        title: 'Não foi possível verificar o Clinics agora.',
        hint: 'Tente de novo em instantes.',
      },
      inactive: {
        title: 'O Clinics não está ativo neste workspace.',
        hint: 'A ativação é feita pela equipe da Veyra.',
      },
      forbidden: {
        title: 'Você não tem acesso aos pacientes da clínica.',
        hint: 'Peça a quem administra o workspace.',
      },
    }[access];
    return (
      <div className="flex h-full flex-col">
        <PageHeader eyebrow="Clínica" title="Pacientes" />
        <EmptyState title={mensagem.title} hint={mensagem.hint} />
      </div>
    );
  }
  return <PatientsReady />;
}

function PatientsReady() {
  const { data: user } = useSession();
  const podeCriar =
    hasPermission(user, 'clinics:schedule:write') && hasPermission(user, 'contacts:read');
  const [criando, setCriando] = useState(false);
  const [termo, setTermo] = useState('');
  const busca = useAtrasado(termo);
  const buscando = busca.length >= 2;
  const pacientes = useQuery({
    queryKey: [...PATIENTS_KEY, 'list', buscando ? busca : ''],
    queryFn: () =>
      api.get<ClinicsPatientDto[]>(
        `/api/clinics/patients${toQuery({ search: buscando ? busca : undefined, limit: TETO_DA_LISTA })}`,
      ),
  });
  // com erro, NADA de dado antigo na tela (dado classe S)
  const linhas = pacientes.isError ? [] : (pacientes.data ?? []);

  return (
    <div className="flex h-full flex-col">
      <PageHeader eyebrow="Clínica" title="Pacientes" meta="Quem tem atendimento na clínica.">
        {podeCriar ? (
          <Button variant="primary" size="sm" onClick={() => setCriando(true)}>
            <UserPlus size={14} /> Novo paciente
          </Button>
        ) : null}
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-auto p-6">
        <div className="mb-3 max-w-sm">
          <Field label="Buscar paciente" hint="Pelo nome (mínimo 2 letras).">
            <Input maxLength={80} value={termo} onChange={(e) => setTermo(e.target.value)} />
          </Field>
        </div>
        {pacientes.isError ? (
          <p role="alert" className="mb-3 text-data text-negative">
            Não foi possível carregar os pacientes.
          </p>
        ) : null}
        {linhas.length === TETO_DA_LISTA ? (
          <p className="mb-3 text-data text-muted-fg">
            Mostrando os {TETO_DA_LISTA} {buscando ? 'primeiros resultados' : 'mais recentes'}.
            Busque pelo nome para encontrar outros.
          </p>
        ) : null}
        <Panel>
          <table className="w-full border-collapse text-body-sm">
            <thead>
              <tr className="border-b border-border bg-surface-2/50">
                {['Paciente', 'Desde'].map((h) => (
                  <th key={h} className="eyebrow px-4 py-2 text-left text-muted-fg">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {linhas.map((p) => (
                <tr key={p.id} className="border-b border-border/60 last:border-b-0">
                  <td className="px-4 py-2">{p.name}</td>
                  <td className="px-4 py-2 num text-data text-muted-fg">
                    {fullStamp(p.createdAt)}
                  </td>
                </tr>
              ))}
              {pacientes.data && !pacientes.isError && linhas.length === 0 ? (
                <tr>
                  <td colSpan={2}>
                    <EmptyState
                      title={buscando ? 'Nenhum paciente com esse nome.' : 'Nenhum paciente ainda.'}
                      hint="Torne paciente um contato do CRM."
                    />
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </Panel>
      </div>
      <Drawer open={criando} onOpenChange={setCriando} title="Novo paciente">
        {criando ? <NovoPaciente onDone={() => setCriando(false)} /> : null}
      </Drawer>
    </div>
  );
}

function NovoPaciente({ onDone }: { onDone: () => void }) {
  const queryClient = useQueryClient();
  const [termo, setTermo] = useState('');
  const busca = useAtrasado(termo);
  const [escolhido, setEscolhido] = useState<ContactDto | null>(null);

  const contatos = useQuery({
    queryKey: ['clinics', 'patient-contact-search', busca],
    queryFn: () =>
      api.get<Paginated<ContactDto>>(
        `/api/contacts${toQuery({ search: busca, pageSize: 8, status: 'active' })}`,
      ),
    enabled: busca.length >= 2,
    staleTime: 30_000,
  });
  // quem já é paciente, só entre os contatos da busca (sem baixar a lista inteira)
  const idsDaBusca = (contatos.data?.items ?? []).map((c) => c.id);
  const jaPacientes = useQuery({
    queryKey: [...PATIENTS_KEY, 'by-contact', idsDaBusca],
    queryFn: () =>
      api.get<ClinicsPatientDto[]>(
        `/api/clinics/patients${toQuery({ contactIds: idsDaBusca.join(',') })}`,
      ),
    enabled: idsDaBusca.length > 0,
  });
  const marcados = new Set((jaPacientes.data ?? []).map((p) => p.contactId));
  // sem a conferência (carregando ou com erro), ninguém é escolhível
  const conferindo = idsDaBusca.length > 0 && (jaPacientes.isPending || jaPacientes.isError);

  const criar = useMutation({
    mutationFn: () =>
      api.post<ClinicsPatientDto>('/api/clinics/patients', { contactId: escolhido!.id }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PATIENTS_KEY });
      onDone();
    },
  });

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (escolhido) criar.mutate();
      }}
    >
      <Field label="Buscar contato" hint="Pelo nome, e-mail ou telefone (mínimo 2 letras).">
        <Input
          autoFocus
          maxLength={120}
          value={termo}
          onChange={(e) => {
            setTermo(e.target.value);
            setEscolhido(null);
          }}
        />
      </Field>
      {contatos.isError || jaPacientes.isError ? (
        <p role="alert" className="text-data text-negative">
          {contatos.isError
            ? 'Não foi possível buscar contatos.'
            : 'Não foi possível conferir quem já é paciente. Tente de novo.'}
        </p>
      ) : null}
      {contatos.data && !contatos.isError ? (
        <fieldset className="space-y-1">
          <legend className="sr-only">Contato que vira paciente</legend>
          {contatos.data.items.length === 0 ? (
            <p className="text-body-sm text-muted-fg">Nenhum contato encontrado.</p>
          ) : null}
          {contatos.data.items.map((c) => {
            const ja = marcados.has(c.id);
            return (
              <label key={c.id} className="flex items-center gap-2 text-body-sm">
                <input
                  type="radio"
                  name="contato"
                  disabled={ja || conferindo}
                  checked={escolhido?.id === c.id}
                  onChange={() => setEscolhido(c)}
                />
                {c.name}
                {ja ? <span className="text-data text-muted-fg">· já é paciente</span> : null}
              </label>
            );
          })}
        </fieldset>
      ) : null}
      <section aria-label="Consequências" className="rounded-control border border-border p-3">
        <p className="mb-1.5 text-body-sm font-medium">Ao tornar paciente:</p>
        <ul className="list-disc space-y-1 pl-5 text-body-sm text-muted-fg">
          {CONSEQUENCIAS_DO_PACIENTE.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      </section>
      {criar.error ? (
        <p role="alert" className="text-data text-negative">
          {criar.error instanceof ApiError
            ? criar.error.message
            : 'Não foi possível criar o paciente.'}
        </p>
      ) : null}
      <Button type="submit" variant="primary" disabled={!escolhido || criar.isPending}>
        {criar.isPending ? 'Salvando…' : 'Tornar paciente'}
      </Button>
    </form>
  );
}
