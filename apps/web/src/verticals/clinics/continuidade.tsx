import {
  horaLocal,
  type ClinicsPackageStatus,
  type ClinicsReturnCancelReason,
  type ClinicsReturnStatus,
} from '@veyra/contracts/verticals/clinics';
import type { ReactNode } from 'react';
import { EmptyState, PageHeader } from '../../components/ui/page';
import { hasPermission, useSession } from '../../lib/session';
import { useClinicsAccess } from './access';

/**
 * O que as telas da continuidade (F3.3b: ficha, retornos e faltas) dividem.
 * O dado de servidor fica no TanStack Query; aqui, só rótulos, formatação e a
 * porta (ADR-048 adendo 7).
 */

export const RETURNS_KEY = ['clinics', 'returns'] as const;
export const PACKAGES_KEY = ['clinics', 'packages'] as const;

export const ROTULO_DO_RETORNO: Record<ClinicsReturnStatus, string> = {
  pending: 'Pendente',
  done: 'Concluído',
  canceled: 'Cancelado',
};

export const ROTULO_DO_MOTIVO_DO_RETORNO: Record<ClinicsReturnCancelReason, string> = {
  patient_declined: 'Paciente recusou',
  patient_unreachable: 'Paciente não encontrado',
  not_needed: 'Não é mais necessário',
  created_in_error: 'Criado por engano',
};

export const ROTULO_DO_PACOTE: Record<ClinicsPackageStatus, string> = {
  active: 'Ativo',
  completed: 'Concluído',
  canceled: 'Cancelado',
};

/**
 * Os motivos que ESTA pessoa pode usar neste retorno. Os operacionais são de
 * quem age sobre retornos (a agenda ou o atendimento); os clínicos, só do
 * atendimento. "Criado por engano" só aparece no retorno que se sabe manual
 * (a origem só vem para quem tem `care:read`). O servidor decide de novo.
 */
export function motivosPermitidos(
  podeAgenda: boolean,
  podeAtendimento: boolean,
  origem?: 'automatic' | 'manual',
): ClinicsReturnCancelReason[] {
  const motivos: ClinicsReturnCancelReason[] = [];
  if (podeAgenda || podeAtendimento) motivos.push('patient_declined', 'patient_unreachable');
  if (podeAtendimento) {
    motivos.push('not_needed');
    if (origem === 'manual') motivos.push('created_in_error');
  }
  return motivos;
}

/** `2030-11-04` → `04/11/2030` (data local, sem fuso). */
export function dataCurta(dia: string): string {
  const [ano, mes, d] = dia.split('-');
  return `${d}/${mes}/${ano}`;
}

/** Um instante na data e hora LOCAIS da unidade: `04/11/2030 09:00`. */
export function instanteLocal(iso: string, fuso: string): string {
  const h = horaLocal(new Date(iso), fuso);
  return `${dataCurta(h.data)} ${h.hora}`;
}

/** O instante na hora local da unidade; sem o fuso, em UTC, e dito. */
export function quandoLocal(iso: string, fuso: string | null): string {
  return fuso ? instanteLocal(iso, fuso) : `${iso.slice(0, 16).replace('T', ' ')} UTC`;
}

/**
 * A porta das telas da continuidade, como a da agenda: nada é montado nem
 * consultado sem o status ATIVO confirmado e as chaves da agenda e do
 * catálogo (os nomes de serviço e profissional e o fuso da unidade vêm do
 * catálogo). Esconder é usabilidade: quem garante é o servidor.
 */
export function PortaDaClinica({
  titulo,
  recusa,
  children,
}: {
  titulo: string;
  recusa: string;
  children: ReactNode;
}) {
  const { data: user } = useSession();
  const access = useClinicsAccess('clinics:schedule:read');
  if (access === 'loading') {
    return <p className="p-6 text-body-sm text-muted-fg">Carregando…</p>;
  }
  const efetivo =
    access === 'ready' && !hasPermission(user, 'clinics:catalog:read') ? 'forbidden' : access;
  if (efetivo === 'ready') return <>{children}</>;
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
      title: recusa,
      hint: 'Exige ler a agenda e o catálogo. Peça a quem administra o workspace.',
    },
  }[efetivo];
  return (
    <div className="flex h-full flex-col">
      <PageHeader eyebrow="Clínica" title={titulo} />
      <EmptyState title={mensagem.title} hint={mensagem.hint} />
    </div>
  );
}
