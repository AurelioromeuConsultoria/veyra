import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AuthUserDto, LoginInput } from '@veyra/contracts';
import { api, ApiError } from './api';

const ME_KEY = ['auth', 'me'] as const;

/** Sessão atual (null = não autenticado). Fonte: GET /auth/me, nunca storage. */
export function useSession() {
  return useQuery({
    queryKey: ME_KEY,
    queryFn: async (): Promise<AuthUserDto | null> => {
      try {
        return await api.get<AuthUserDto>('/api/auth/me');
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) return null;
        throw error;
      }
    },
    staleTime: 60_000,
    retry: false,
  });
}

export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: LoginInput) => api.post<AuthUserDto>('/api/auth/login', input),
    onSuccess: (user) => queryClient.setQueryData(ME_KEY, user),
  });
}

export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ ok: true }>('/api/auth/logout'),
    onSettled: () => {
      queryClient.setQueryData(ME_KEY, null);
      queryClient.clear();
    },
  });
}

export function hasPermission(user: AuthUserDto | null | undefined, key: string): boolean {
  return user?.permissions.includes(key as AuthUserDto['permissions'][number]) ?? false;
}
