import type { AuthUserDto } from '@veyra/contracts';
import { createContext, useContext, type ComponentType } from 'react';
import type { NavGroup, VerticalRoute } from './nav';

/**
 * A EXPERIÊNCIA DE PRODUTO no web (ADR-055, adendo 2). Cada produto declara o
 * que mostra — início, menu, rotas, configurações, links e busca — e o Core
 * monta só a experiência do workspace ativo. O menu deixa de ser a soma do CRM
 * com as extensões: o Core declara o `crm`; um vertical declara o seu pela raiz
 * de composição. O Core nunca escolhe uma experiência no lugar de outra.
 */

/** Uma seção da página de configurações (`/settings`). */
export type SettingsSection = {
  to: string;
  label: string;
  description: string;
  icon: ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;
  /** a MESMA chave que o servidor exige na rota da seção */
  permission?: string;
};

/**
 * Os destinos dos registros da base, por experiência. Sem resolvedor (ou sem a
 * permissão), não há link: um destino de outro produto nunca é oferecido.
 */
export type LinkResolvers = {
  contato?: (contactId: string, user: AuthUserDto | null | undefined) => string | null;
};

/** Um resultado de registro na busca global. */
export type SearchHit = { id: string; to: string; label: string; hint: string };

/**
 * O provedor de registros da busca global (⌘K) de um produto, no máximo um. É
 * um HOOK, chamado sempre no mesmo ponto: o manifesto é fixo durante a sessão
 * (trocar de experiência é troca de sessão, ADR-050).
 */
export type SearchProvider = {
  /** o nome do grupo na lista de resultados ("Contatos") */
  label: string;
  /** o nome no campo de busca ("contato") */
  singular: string;
  /** só consulta com esta permissão: sem ela, nenhum 403 a cada tecla */
  permission: string;
  useResultados: (termo: string, ativo: boolean) => { resultados: SearchHit[]; buscando: boolean };
};

export type ExperienceManifest = {
  /** a chave declarada no servidor (`Workspace.experience`) */
  key: string;
  /** o nome do produto, no título da aba e no seletor de workspace */
  produto: string;
  /** a marca da lateral */
  marca: string;
  /** o caminho da página inicial do produto (o `/` leva a ela) */
  inicio: string;
  grupos: readonly NavGroup[];
  /** as rotas que o produto monta; nenhuma outra existe nele */
  rotas: readonly VerticalRoute[];
  configuracoes: readonly SettingsSection[];
  links: LinkResolvers;
  busca: SearchProvider | null;
};

const ExperienceContext = createContext<ExperienceManifest | null>(null);
export const ExperienceProvider = ExperienceContext.Provider;

/**
 * O manifesto da experiência ativa. Fora de um produto (as telas neutras, o
 * login) não há experiência — e quem pede uma ali é um erro de montagem, não um
 * motivo para cair no CRM.
 */
export function useExperience(): ExperienceManifest {
  const manifesto = useContext(ExperienceContext);
  if (!manifesto) throw new Error('Tela de produto montada fora de uma experiência (ADR-055).');
  return manifesto;
}

/** O manifesto, quando houver (componentes que também aparecem nas telas neutras). */
export function useExperienceOpcional(): ExperienceManifest | null {
  return useContext(ExperienceContext);
}

/** Os resolvedores de link da experiência ativa; sem experiência, nenhum link. */
export function useLinks(): LinkResolvers {
  return useContext(ExperienceContext)?.links ?? {};
}

/** O que a tela mostra para a sessão — nunca o CRM por omissão. */
export type EstadoDaExperiencia =
  | { tipo: 'sem-workspace' }
  | { tipo: 'desconhecida'; chave: string }
  | { tipo: 'indisponivel'; chave: string; produto: string | null }
  | { tipo: 'pronta'; manifesto: ExperienceManifest };

export function estadoDaExperiencia(
  user: AuthUserDto,
  manifestos: readonly ExperienceManifest[],
): EstadoDaExperiencia {
  if (!user.activeMembership || !user.experience) return { tipo: 'sem-workspace' };
  const { key, status } = user.experience;
  const manifesto = manifestos.find((m) => m.key === key) ?? null;
  // a chave que o servidor não conhece, OU que este web não monta: desconhecida
  if (status === 'unknown' || !manifesto) return { tipo: 'desconhecida', chave: key };
  if (status !== 'ready') return { tipo: 'indisponivel', chave: key, produto: manifesto.produto };
  return { tipo: 'pronta', manifesto };
}

/** O nome do produto de uma chave, para o seletor de workspace. */
export function produtoDa(chave: string, manifestos: readonly ExperienceManifest[]): string {
  return manifestos.find((m) => m.key === chave)?.produto ?? 'Produto desconhecido';
}
