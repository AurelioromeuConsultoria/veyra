import { useInfiniteQuery } from '@tanstack/react-query';
import type { ClinicsLeadDto, ClinicsLeadsPageDto } from '@veyra/contracts/verticals/clinics';
import { UserPlus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button } from '../../components/ui/button';
import { Drawer } from '../../components/ui/drawer';
import { Input } from '../../components/ui/input';
import { EmptyState, PageHeader, Panel } from '../../components/ui/page';
import { api, toQuery } from '../../lib/api';
import { alcanca, useSession } from '../../lib/session';
import { useClinicsStatus } from './access';
import { fichaDoPaciente, pessoaDoContato } from './nav';
import { DadosDoContato } from './pessoa/DadosDoContato';
import { TornarPaciente } from './pessoa/TornarPaciente';

const LEADS_KEY = ['clinics', 'leads'] as const;
const POR_PAGINA = 50;
const DATA = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

/**
 * Interessados (ADR-055, adendos 3 e 4): quem ainda não tem ficha de paciente,
 * paginado no servidor. As DUAS chaves da rota (`contacts:read` e
 * `clinics:schedule:read`): a lista é o complemento da de pacientes. Abrir a
 * ficha é decisão de quem atende, pelo "Tornar paciente" — nunca automática.
 */
export function ClinicsLeadsPage() {
  const { data: user } = useSession();
  const status = useClinicsStatus();
  const pode = alcanca(user, { permissions: ['contacts:read', 'clinics:schedule:read'] });
  if (!pode) {
    return (
      <Moldura>
        <EmptyState
          title="Você não tem acesso aos interessados da clínica."
          hint="Peça a quem administra o workspace."
        />
      </Moldura>
    );
  }
  if (status.isError) {
    return (
      <Moldura>
        <EmptyState
          title="Não foi possível verificar o Clinics agora."
          hint="Tente de novo em instantes."
        />
      </Moldura>
    );
  }
  if (!status.data) return <p className="p-6 text-body-sm text-muted-fg">Carregando…</p>;
  if (!status.data.active) {
    return (
      <Moldura>
        <EmptyState title="O Clinics não está ativo neste workspace." />
      </Moldura>
    );
  }
  return <Interessados />;
}

function Moldura({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col">
      <PageHeader eyebrow="Captação" title="Interessados" />
      {children}
    </div>
  );
}

function Interessados() {
  const { data: user } = useSession();
  const navigate = useNavigate();
  const criaContato = alcanca(user, { permission: 'contacts:write' });
  const criaFicha = alcanca(user, { permissions: ['clinics:schedule:write', 'contacts:read'] });
  const [termo, setTermo] = useState('');
  const [busca, setBusca] = useState('');
  const [novo, setNovo] = useState(false);
  const [tornando, setTornando] = useState<ClinicsLeadDto | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setBusca(termo.trim()), 250);
    return () => clearTimeout(timer);
  }, [termo]);
  const buscaValida = busca.length >= 2 ? busca : undefined;

  const lista = useInfiniteQuery({
    queryKey: [...LEADS_KEY, buscaValida ?? ''],
    queryFn: ({ pageParam }) =>
      api.get<ClinicsLeadsPageDto>(
        `/api/clinics/leads${toQuery({
          search: buscaValida,
          limit: POR_PAGINA,
          cursor: pageParam || undefined,
        })}`,
      ),
    initialPageParam: '',
    getNextPageParam: (ultima) => ultima.nextCursor ?? undefined,
  });
  const itens = lista.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        eyebrow="Captação"
        title="Interessados"
        meta="Quem ainda não tem ficha de paciente. Abrir a ficha é decisão de quem atende."
      >
        {criaContato ? (
          <Button size="sm" variant="primary" onClick={() => setNovo(true)}>
            <UserPlus size={14} aria-hidden /> Novo interessado
          </Button>
        ) : null}
      </PageHeader>
      <div className="min-h-0 flex-1 space-y-4 overflow-auto p-6">
        <div className="max-w-sm">
          <Input
            aria-label="Buscar interessado pelo nome"
            placeholder="Buscar pelo nome…"
            maxLength={80}
            value={termo}
            onChange={(e) => setTermo(e.target.value)}
          />
        </div>
        {lista.isError ? (
          <p role="alert" className="text-data text-negative">
            Não foi possível carregar os interessados.
          </p>
        ) : !lista.data ? (
          <p className="text-body-sm text-muted-fg">Carregando…</p>
        ) : itens.length === 0 ? (
          <EmptyState
            title={buscaValida ? 'Ninguém com esse nome.' : 'Nenhum interessado agora.'}
            hint="Quem chega por conversa, pelo funil ou pela recepção aparece aqui até ter ficha."
          />
        ) : (
          <Panel>
            <ul className="divide-y divide-border">
              {itens.map((i) => (
                <li key={i.id} className="flex items-center gap-3 px-4 py-2.5">
                  <Link
                    to={pessoaDoContato(i.id)}
                    className="min-w-0 flex-1 truncate text-body-sm hover:underline"
                  >
                    {i.name}
                  </Link>
                  <span className="num shrink-0 text-data text-muted-fg">
                    chegou em {DATA.format(new Date(i.createdAt))}
                  </span>
                  {criaFicha ? (
                    <Button size="sm" variant="secondary" onClick={() => setTornando(i)}>
                      Tornar paciente
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          </Panel>
        )}
        {lista.hasNextPage ? (
          <Button
            variant="secondary"
            size="sm"
            disabled={lista.isFetchingNextPage}
            onClick={() => void lista.fetchNextPage()}
          >
            {lista.isFetchingNextPage ? 'Carregando…' : 'Carregar mais'}
          </Button>
        ) : null}
      </div>
      <Drawer open={novo} onOpenChange={setNovo} title="Novo interessado">
        {novo ? (
          <DadosDoContato
            rotuloDoBotao="Criar interessado"
            onDone={(c) => {
              setNovo(false);
              navigate(pessoaDoContato(c.id));
            }}
          />
        ) : null}
      </Drawer>
      <Drawer
        open={tornando !== null}
        onOpenChange={(aberto) => !aberto && setTornando(null)}
        title="Tornar paciente"
      >
        {tornando ? (
          <TornarPaciente
            contactId={tornando.id}
            nome={tornando.name}
            onDone={(p) => navigate(fichaDoPaciente(p.id))}
          />
        ) : null}
      </Drawer>
    </div>
  );
}
