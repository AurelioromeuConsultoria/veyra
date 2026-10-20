import { useMutation, useQuery } from '@tanstack/react-query';
import type { AuthUserDto, LoginInput } from '@veyra/contracts';
import { api, ApiError } from './api';
import { SessaoEncerradaError, adotarSessao, epocaAtual, trocarSessao } from './session-scope';

export const ME_KEY = ['auth', 'me'] as const;

/** Sessão atual (null = não autenticado). Fonte: GET /auth/me, nunca storage. */
export function useSession() {
  return useQuery({
    queryKey: ME_KEY,
    queryFn: async (): Promise<AuthUserDto | null> => {
      // como o refresh: a resposta de uma sessão que já trocou não adota nada
      const epoca = epocaAtual();
      const adotar = (user: AuthUserDto | null) => {
        if (epocaAtual() === epoca) adotarSessao(user);
      };
      try {
        const user = await api.get<AuthUserDto>('/api/auth/me');
        adotar(user);
        return user;
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          adotar(null);
          return null;
        }
        throw error;
      }
    },
    staleTime: 60_000,
    retry: false,
  });
}

/**
 * Login e logout são TROCA de sessão (ADR-050): o cache inteiro é descartado e
 * a árvore remonta com um cache novo — nunca só o usuário trocado no cache
 * velho. O login troca sempre, mesmo para a mesma identidade: quem troca é o
 * `lib/api.ts`, pela marca de sessão emitida na resposta.
 */
export function useLogin() {
  return useMutation({
    mutationFn: (input: LoginInput) => api.post<AuthUserDto>('/api/auth/login', input),
  });
}

/**
 * Só o logout que o servidor CONFIRMOU leva a aba a "sem sessão". Os outros não
 * fingem que o navegador saiu, com o cookie ainda vivo:
 * - aba desatualizada (o cookie é de OUTRA pessoa, de outra aba): recebe 409 e
 *   já recomeça na sessão do cookie;
 * - sessão que já tinha acabado: o refresh recusado já trocou a aba;
 * - rede ou 5xx: a sessão continua, e a tela diz que não foi possível sair.
 */
export function useLogout() {
  return useMutation({
    mutationFn: () => api.post<{ ok: true }>('/api/auth/logout'),
    onSuccess: () => trocarSessao(null),
  });
}

/** O logout falhou de verdade (e não por a sessão ter trocado no caminho)? */
export function logoutFalhou(erro: unknown): boolean {
  return erro !== null && erro !== undefined && !(erro instanceof SessaoEncerradaError);
}

export function hasPermission(user: AuthUserDto | null | undefined, key: string): boolean {
  return user?.permissions.includes(key as AuthUserDto['permissions'][number]) ?? false;
}
