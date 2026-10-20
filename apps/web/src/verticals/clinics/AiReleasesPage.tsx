import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ContactDto, Paginated } from '@veyra/contracts';
import type {
  ClinicsAiReleaseDto,
  ClinicsAiReleasePageDto,
  ClinicsAiReleaseReason,
  ClinicsPatientDto,
} from '@veyra/contracts/verticals/clinics';
import { clsx } from 'clsx';
import { Plus, ShieldOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '../../components/ui/button';
import { Drawer } from '../../components/ui/drawer';
import { Field, Input, Select } from '../../components/ui/input';
import { EmptyState, PageHeader, Panel } from '../../components/ui/page';
import { api, ApiError, toQuery } from '../../lib/api';
import { fullStamp } from '../../lib/format';
import { hasPermission, useSession } from '../../lib/session';
import { useClinicsAccess } from './access';

export const RELEASES_KEY = ['clinics', 'ai-releases'] as const;

/** Rótulos da lista FECHADA de motivos (ADR-047 adendo 2, item 5). */
export const RELEASE_REASON_LABELS: Record<ClinicsAiReleaseReason, string> = {
  supplier: 'Fornecedor',
  partner: 'Parceiro',
  staff: 'Equipe da clínica',
  non_clinical_business: 'Assunto comercial não clínico',
};

const SEARCH_MIN = 2;
const SEARCH_DEBOUNCE_MS = 250;
const SEARCH_MAX = 8;

/**
 * Liberação de contatos para IA (ADR-048 §6.4, adendo 2). No workspace com o
 * Clinics, a IA não lê nenhum contato por padrão; liberar diz "este contato
 * não tem relação clínica". PORTA antes de tudo, como no catálogo: nada é
 * consultado sem o status ATIVO confirmado e as DUAS permissões da rota
 * (`clinics:restriction:manage` + `contacts:read`, porque a lista traz nomes).
 */
export function ClinicsAiReleasesPage() {
  const { data: user } = useSession();
  const access = useClinicsAccess('clinics:restriction:manage');
  if (access === 'loading') {
    return <p className="p-6 text-body-sm text-muted-fg">Carregando…</p>;
  }
  const efetivo =
    access === 'ready' && !hasPermission(user, 'contacts:read') ? 'forbidden' : access;
  if (efetivo !== 'ready') {
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
        title: 'Você não tem acesso à liberação para IA.',
        hint: 'Exige gerenciar a restrição da clínica e ver contatos. Peça a quem administra o workspace.',
      },
    }[efetivo];
    return (
      <div className="flex h-full flex-col">
        <PageHeader eyebrow="Clínica" title="Liberação para IA" />
        <EmptyState title={mensagem.title} hint={mensagem.hint} />
      </div>
    );
  }
  return <ReleasesReady />;
}

function ReleasesReady() {
  const queryClient = useQueryClient();
  const [granting, setGranting] = useState(false);
  const releases = useInfiniteQuery({
    queryKey: RELEASES_KEY,
    queryFn: ({ pageParam }) =>
      api.get<ClinicsAiReleasePageDto>(`/api/clinics/ai-releases${toQuery({ cursor: pageParam })}`),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = releases.data?.pages.flatMap((page) => page.items);
  const revoke = useMutation({
    mutationFn: (contactId: string) =>
      api.delete<{ ok: true }>(`/api/clinics/contacts/${contactId}/ai-release`),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: RELEASES_KEY }),
  });

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        eyebrow="Clínica"
        title="Liberação para IA"
        meta="Contatos sem relação clínica que a inteligência pode ler."
      >
        <Button variant="primary" size="sm" onClick={() => setGranting(true)}>
          <Plus size={14} /> Liberar contato
        </Button>
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-auto p-6">
        <div className="mb-4 max-w-3xl space-y-1.5 text-body-sm text-muted-fg">
          <p>
            Com o Clinics ativo, a IA não lê conversas nem dados de nenhum contato. Libere apenas
            quem não tem relação clínica — fornecedores, parceiros, a própria equipe.
          </p>
          <p>
            Paciente nunca é liberável: ao virar paciente, a liberação é revogada e o que a IA
            produziu sobre o contato deixa de valer. Webhooks continuam sem conteúdo para todos.
          </p>
        </div>
        {releases.isError ? (
          <p role="alert" className="mb-3 text-data text-negative">
            Não foi possível carregar as liberações.{' '}
            {releases.error instanceof ApiError ? releases.error.message : 'Tente de novo.'}
          </p>
        ) : null}
        {revoke.isError ? (
          <p role="alert" className="mb-3 text-data text-negative">
            Não foi possível revogar.{' '}
            {revoke.error instanceof ApiError ? revoke.error.message : 'Tente de novo.'}
          </p>
        ) : null}
        <Panel>
          <table className="w-full border-collapse text-body-sm">
            <thead>
              <tr className="border-b border-border bg-surface-2/50">
                {['Contato', 'Motivo', 'Liberado em', ''].map((header, index) => (
                  <th
                    key={`${header}-${index}`}
                    className="eyebrow px-4 py-2 text-left text-muted-fg"
                  >
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(rows ?? []).map((release) => (
                <tr key={release.contactId} className="border-b border-border/60 last:border-b-0">
                  <td className="px-4 py-2">{release.contactName}</td>
                  <td className="px-4 py-2">{RELEASE_REASON_LABELS[release.reason]}</td>
                  <td className="px-4 py-2 num text-data text-muted-fg">
                    {fullStamp(release.createdAt)}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Revogar liberação de ${release.contactName}`}
                      disabled={revoke.isPending}
                      onClick={() => revoke.mutate(release.contactId)}
                    >
                      <ShieldOff size={14} /> Revogar
                    </Button>
                  </td>
                </tr>
              ))}
              {rows && rows.length === 0 ? (
                <tr>
                  <td colSpan={4}>
                    <EmptyState
                      title="Nenhum contato liberado."
                      hint="Sem liberação, a IA não lê nenhum contato deste workspace."
                    />
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </Panel>
        {releases.hasNextPage ? (
          <Button
            variant="ghost"
            size="sm"
            className="mt-3"
            disabled={releases.isFetchingNextPage}
            onClick={() => void releases.fetchNextPage()}
          >
            {releases.isFetchingNextPage ? 'Carregando…' : 'Carregar mais'}
          </Button>
        ) : null}
      </div>

      <Drawer open={granting} onOpenChange={setGranting} title="Liberar contato para IA">
        {granting ? (
          <GrantForm
            released={new Set((rows ?? []).map((r) => r.contactId))}
            onDone={() => {
              setGranting(false);
              void queryClient.invalidateQueries({ queryKey: RELEASES_KEY });
            }}
          />
        ) : null}
      </Drawer>
    </div>
  );
}

function GrantForm({ released, onDone }: { released: Set<string>; onDone: () => void }) {
  const { data: user } = useSession();
  // marcar paciente como "não liberável" exige ler pacientes; sem a chave, o
  // 409 do servidor é quem avisa (ele decide de qualquer forma)
  const canReadPatients = hasPermission(user, 'clinics:schedule:read');
  const [term, setTerm] = useState('');
  const [debounced, setDebounced] = useState('');
  const [chosen, setChosen] = useState<ContactDto | null>(null);
  const [reason, setReason] = useState<ClinicsAiReleaseReason | ''>('');

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(term.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [term]);

  const contacts = useQuery({
    queryKey: ['clinics', 'release-contact-search', debounced],
    queryFn: () =>
      api.get<Paginated<ContactDto>>(
        `/api/contacts${toQuery({ search: debounced, pageSize: SEARCH_MAX, status: 'active' })}`,
      ),
    enabled: debounced.length >= SEARCH_MIN,
    staleTime: 30_000,
  });
  // só os contatos da busca: a tela nunca baixa a lista inteira de pacientes
  const resultIds = (contacts.data?.items ?? []).map((contact) => contact.id);
  const patients = useQuery({
    queryKey: ['clinics', 'patients', 'by-contact', resultIds],
    queryFn: () =>
      api.get<ClinicsPatientDto[]>(
        `/api/clinics/patients${toQuery({ contactIds: resultIds.join(',') })}`,
      ),
    enabled: canReadPatients && resultIds.length > 0,
    staleTime: 30_000,
  });
  const patientIds = new Set((patients.data ?? []).map((p) => p.contactId));
  // enquanto a conferência de pacientes não volta, nenhuma opção é escolhível
  const checkingPatients = canReadPatients && resultIds.length > 0 && patients.isPending;
  const grant = useMutation({
    mutationFn: () =>
      api.post<ClinicsAiReleaseDto>(`/api/clinics/contacts/${chosen!.id}/ai-release`, { reason }),
    onSuccess: onDone,
  });

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (chosen && reason) grant.mutate();
      }}
    >
      <Field label="Buscar contato" hint="Pelo nome, e-mail ou telefone (mínimo 2 letras).">
        <Input
          autoFocus
          value={term}
          onChange={(event) => {
            setTerm(event.target.value);
            setChosen(null); // a escolha nunca sobrevive a uma busca nova
          }}
        />
      </Field>
      {contacts.isError ? (
        <p role="alert" className="text-data text-negative">
          Não foi possível buscar contatos.
        </p>
      ) : null}
      {patients.isError ? (
        <p className="text-data text-muted-fg">
          Não foi possível conferir quem é paciente agora. Paciente continua não liberável: o
          servidor recusa.
        </p>
      ) : null}
      {contacts.data ? (
        <fieldset className="space-y-1">
          <legend className="sr-only">Contato a liberar</legend>
          {contacts.data.items.length === 0 ? (
            <p className="text-body-sm text-muted-fg">Nenhum contato encontrado.</p>
          ) : null}
          {contacts.data.items.map((contact) => {
            const patient = patientIds.has(contact.id);
            return (
              <label
                key={contact.id}
                className={clsx('flex items-center gap-2 text-body-sm', patient && 'text-muted-fg')}
              >
                <input
                  type="radio"
                  name="contato"
                  disabled={patient || checkingPatients}
                  checked={chosen?.id === contact.id}
                  onChange={() => setChosen(contact)}
                />
                {contact.name}
                {patient ? (
                  <span className="text-data">· paciente — não liberável</span>
                ) : released.has(contact.id) ? (
                  <span className="text-data text-muted-fg">· já liberado</span>
                ) : null}
              </label>
            );
          })}
        </fieldset>
      ) : null}
      <Field label="Motivo" hint="Lista fechada: sem texto livre.">
        <Select
          full
          value={reason}
          onChange={(event) => setReason(event.target.value as ClinicsAiReleaseReason)}
        >
          <option value="" disabled>
            Escolha o motivo
          </option>
          {(Object.keys(RELEASE_REASON_LABELS) as ClinicsAiReleaseReason[]).map((key) => (
            <option key={key} value={key}>
              {RELEASE_REASON_LABELS[key]}
            </option>
          ))}
        </Select>
      </Field>
      {grant.error ? (
        <p role="alert" className="text-data text-negative">
          {grant.error instanceof ApiError ? grant.error.message : 'Não foi possível liberar.'}
        </p>
      ) : null}
      <Button type="submit" variant="primary" disabled={!chosen || !reason || grant.isPending}>
        {grant.isPending ? 'Liberando…' : 'Liberar para IA'}
      </Button>
    </form>
  );
}
