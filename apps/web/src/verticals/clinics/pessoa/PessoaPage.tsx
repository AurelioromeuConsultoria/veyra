import { useQuery } from '@tanstack/react-query';
import type { ContactDto } from '@veyra/contracts';
import type { ClinicsPatientDto } from '@veyra/contracts/verticals/clinics';
import { useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '../../../components/ui/button';
import { Drawer } from '../../../components/ui/drawer';
import { EmptyState, PageHeader } from '../../../components/ui/page';
import { api, toQuery } from '../../../lib/api';
import { alcanca, useSession } from '../../../lib/session';
import { fichaDoPaciente } from '../nav';
import { ContatoDaPessoa } from './ContatoDaPessoa';
import { TornarPaciente } from './TornarPaciente';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A pessoa (`/clinics/person?id=<contato>`, ADR-055, adendos 3 e 4): o destino
 * ÚNICO de um contato na clínica, que decide pela permissão de quem abre.
 *
 * - sem `contacts:read`: nada é consultado nem mostrado;
 * - com `contacts:read`, `clinics:schedule:read` e `clinics:catalog:read` (as
 *   chaves da ficha): se for paciente, segue para a ficha; se não, é
 *   interessado, com "Tornar paciente" para quem pode criar a ficha;
 * - sem elas (só `contacts:read`, por exemplo): o contato, sem nenhuma consulta nem sinal do
 *   vínculo — nem redirecionamento, nem erro, nem título, nem estado
 *   intermediário diferente para paciente e não paciente.
 */
export function ClinicsPersonPage() {
  const { data: user } = useSession();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const id = params.get('id') ?? '';
  const idValido = UUID.test(id);
  const leContato = alcanca(user, { permission: 'contacts:read' });
  // consulta o vínculo quem pode abrir a ficha (a agenda E o catálogo)
  const consultaVinculo =
    leContato && alcanca(user, { permissions: ['clinics:schedule:read', 'clinics:catalog:read'] });
  const criaFicha = alcanca(user, { permissions: ['clinics:schedule:write', 'contacts:read'] });
  const [tornando, setTornando] = useState(false);

  const vinculo = useQuery({
    queryKey: ['clinics', 'patients', 'by-contact', [id]],
    queryFn: () =>
      api.get<ClinicsPatientDto[]>(`/api/clinics/patients${toQuery({ contactIds: id })}`),
    enabled: idValido && consultaVinculo,
  });
  const contato = useQuery({
    queryKey: ['contact', id],
    queryFn: () => api.get<ContactDto>(`/api/contacts/${id}`),
    enabled: idValido && leContato,
  });

  if (!leContato) {
    return (
      <Moldura titulo="Pessoa">
        <EmptyState
          title="Você não tem acesso aos dados deste contato."
          hint="Peça a quem administra o workspace."
        />
      </Moldura>
    );
  }
  if (!idValido || contato.isError) {
    return (
      <Moldura titulo="Pessoa">
        <EmptyState title="Pessoa não encontrada." hint="Confira o link ou use a busca." />
      </Moldura>
    );
  }
  // quem consulta o vínculo espera por ele ANTES de qualquer coisa: o mesmo
  // carregamento para paciente e não paciente
  if (consultaVinculo && vinculo.isError) {
    return (
      <Moldura titulo="Pessoa">
        <EmptyState title="Não foi possível abrir agora." hint="Tente de novo em instantes." />
      </Moldura>
    );
  }
  if (!contato.data || (consultaVinculo && !vinculo.data)) {
    return <p className="p-6 text-body-sm text-muted-fg">Carregando…</p>;
  }
  const paciente = consultaVinculo ? vinculo.data?.[0] : undefined;
  if (paciente) return <Navigate to={fichaDoPaciente(paciente.id)} replace />;
  // arquivado não é interessado (a lista dos interessados é a dos ativos)
  const arquivado = contato.data.status === 'archived';

  return (
    <Moldura
      titulo={contato.data.name}
      eyebrow={
        arquivado ? 'Clínica · Arquivado' : consultaVinculo ? 'Clínica · Interessado' : 'Clínica'
      }
      meta={
        arquivado
          ? 'Contato arquivado.'
          : consultaVinculo
            ? 'Ainda sem ficha de paciente.'
            : undefined
      }
      acao={
        consultaVinculo && criaFicha && !arquivado ? (
          <Button size="sm" variant="primary" onClick={() => setTornando(true)}>
            Tornar paciente
          </Button>
        ) : null
      }
    >
      <div className="min-h-0 flex-1 overflow-auto p-6">
        <ContatoDaPessoa contactId={id} />
      </div>
      <Drawer open={tornando} onOpenChange={setTornando} title="Tornar paciente">
        {tornando ? (
          <TornarPaciente
            contactId={id}
            nome={contato.data.name}
            onDone={(p) => navigate(fichaDoPaciente(p.id), { replace: true })}
          />
        ) : null}
      </Drawer>
    </Moldura>
  );
}

function Moldura({
  titulo,
  eyebrow = 'Clínica',
  meta,
  acao,
  children,
}: {
  titulo: string;
  eyebrow?: string;
  meta?: string;
  acao?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-full flex-col">
      <PageHeader eyebrow={eyebrow} title={titulo} meta={meta}>
        {acao}
      </PageHeader>
      {children}
    </div>
  );
}
