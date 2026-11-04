import {
  NOME_PADRAO_DO_PAPEL_DE_SISTEMA,
  nomeDePapelComoSeLe,
  type AuthUserDto,
} from '@veyra/contracts';
import { createContext, useContext, type ComponentType } from 'react';
import type { NavGroup, VerticalRoute } from './nav';
import { alcanca } from './session';

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
  /** as demais chaves da rota, TODAS (ADR-055, adendo 4) */
  permissions?: readonly string[];
  /** outros destinos da mesma seção ("Etiquetas e campos": as Tags e os Campos) */
  destinos?: readonly { to: string; label: string }[];
  /**
   * o grupo da página de configurações ("Pessoas e acesso", "Dados"), ADR-062.
   * Só apresentação: os grupos aparecem na ordem da primeira seção de cada um,
   * e o grupo sem nenhuma seção ao alcance do papel não aparece.
   */
  grupo?: string;
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
 * Um provedor de registros da busca global (⌘K) de um produto. É um HOOK: a
 * lista do manifesto é fixa durante a sessão (trocar de experiência é troca de
 * sessão, ADR-050), então cada provedor é chamado sempre no mesmo ponto.
 */
export type SearchProvider = {
  /** o nome do grupo na lista de resultados ("Contatos") */
  label: string;
  /** o nome no campo de busca ("contato") */
  singular: string;
  /** só consulta com estas chaves, TODAS: sem elas, nenhum 403 a cada tecla */
  permission: string;
  permissions?: readonly string[];
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
  /** os provedores de registros da busca, na ordem dos resultados (nenhum = só seções) */
  busca: readonly SearchProvider[];
  /** os termos das telas compartilhadas que o produto chama do seu jeito */
  linguagem?: Partial<Linguagem>;
  /**
   * o nome de APRESENTAÇÃO de um papel de sistema padrão do CORE, pela chave
   * dele (ADR-056): o Clinics chama o Member de "Recepção". Só apresentação: o
   * papel persistido não muda, e um nome personalizado é preservado
   * (`nomeDoPapel`). Só vale para as chaves dos templates do Core (`owner`,
   * `admin`, `member`, `guest`): uma chave de vertical aqui não tem efeito
   */
  papeis?: Readonly<Record<string, string>>;
};

/**
 * Os termos que as telas COMPARTILHADAS mostram e que um produto pode trocar
 * (ADR-055, adendo 3, item 7): uma lista fechada, com o texto do CRM como
 * padrão. Não é tradução: só cresce quando uma tela compartilhada precisar.
 */
export type Linguagem = {
  /** o título do Inbox */
  conversas: string;
  /** o título do Pipeline quando o board ainda não tem nome */
  funil: string;
};

const LINGUAGEM_DO_CRM: Linguagem = { conversas: 'Inbox', funil: 'Pipeline' };

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

/** Um termo das telas compartilhadas, na linguagem do produto ativo. */
export function useTermo(termo: keyof Linguagem): string {
  return useContext(ExperienceContext)?.linguagem?.[termo] ?? LINGUAGEM_DO_CRM[termo];
}

/** O mínimo de um papel para a tela saber como chamá-lo. */
export type PapelApresentavel = { name: string; systemKey: string | null };

/**
 * Como a tela chama um papel (ADR-056): o nome persistido, ou o rótulo do
 * produto para o papel de sistema PADRÃO, com o nome padrão. Um papel
 * personalizado (sem `systemKey`) ou renomeado no workspace nunca aparece como o
 * padrão: se o nome dele se lê como um rótulo do produto ("Recepção"), ganha
 * "(personalizado)". Fora de um produto que rotule, vale o nome persistido.
 */
export function nomeDoPapel(
  papel: PapelApresentavel,
  manifesto: Pick<ExperienceManifest, 'papeis'> | null | undefined,
): string {
  const rotulo = papel.systemKey ? manifesto?.papeis?.[papel.systemKey] : undefined;
  if (
    rotulo &&
    papel.systemKey &&
    papel.name === NOME_PADRAO_DO_PAPEL_DE_SISTEMA[papel.systemKey]
  ) {
    return rotulo;
  }
  const pareceORotulo = Object.values(manifesto?.papeis ?? {}).some(
    (r) => nomeDePapelComoSeLe(r) === nomeDePapelComoSeLe(papel.name),
  );
  return pareceORotulo ? `${papel.name} (personalizado)` : papel.name;
}

/** `nomeDoPapel` na experiência ativa (sem experiência, o nome persistido). */
export function useNomeDoPapel(): (papel: PapelApresentavel) => string {
  const manifesto = useContext(ExperienceContext);
  return (papel) => nomeDoPapel(papel, manifesto);
}

/** As seções de configuração ao alcance do papel (TODAS as chaves de cada uma). */
export function secoesAlcancaveis(
  manifesto: ExperienceManifest,
  user: AuthUserDto | null | undefined,
): SettingsSection[] {
  return manifesto.configuracoes.filter((s) => alcanca(user, s));
}

/**
 * A seção de configuração em que o caminho está (o rastro "Configurações ›
 * Equipe" e a entrada do menu marcada), pelo destino principal ou um extra.
 */
export function secaoDeConfiguracao(
  manifesto: ExperienceManifest,
  pathname: string,
): { secao: SettingsSection; label: string } | null {
  const casa = (to: string) => pathname === to || pathname.startsWith(`${to}/`);
  // o destino nomeado primeiro: o rastro diz o nome da tela ("Tags", "Webhooks")
  for (const secao of manifesto.configuracoes) {
    const destino = secao.destinos?.find((d) => casa(d.to));
    if (destino) return { secao, label: destino.label };
  }
  for (const secao of manifesto.configuracoes) {
    if (casa(secao.to)) return { secao, label: secao.label };
  }
  return null;
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
