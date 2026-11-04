import type { ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { classeDaAba } from '../../../components/ui/page';
import { useExperienceOpcional } from '../../../lib/experience';
import { itemAlcancavel } from '../../../lib/nav';
import { useSession } from '../../../lib/session';

/**
 * As abas entre os indicadores (ADR-062): os itens do MESMO grupo do menu em
 * que a tela está ("Indicadores": Faltas e Envios), com a mesma regra de
 * alcance da lateral — TODAS as chaves de cada destino. Com um só ao alcance,
 * nenhuma aba (`null`): a aba única não leva a lugar nenhum, e o cabeçalho
 * volta ao respiro de sempre.
 */
export function useAbasDosIndicadores(): ReactNode | null {
  const { data: user } = useSession();
  const manifesto = useExperienceOpcional();
  const { pathname } = useLocation();
  const grupo = manifesto?.grupos.find((g) => g.items.some((i) => i.to === pathname));
  const itens = (grupo?.items ?? []).filter((i) => itemAlcancavel(user, i));
  if (!grupo || itens.length < 2) return null;
  return (
    <nav aria-label={`Abas de ${grupo.label}`} className="flex gap-6">
      {itens.map((item) => (
        <NavLink key={item.to} to={item.to} className={({ isActive }) => classeDaAba(isActive)}>
          {item.label}
        </NavLink>
      ))}
    </nav>
  );
}
