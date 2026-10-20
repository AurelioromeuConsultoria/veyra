import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AuthUserDto } from '@veyra/contracts';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ME_KEY } from './session';
import { SessaoEncerradaError, ouvirTrocaDeSessao } from './session-scope';

type Criar = (semente?: AuthUserDto | null) => QueryClient;

/** O cache de UMA sessão; `semente` já põe nele quem é a sessão, se conhecida. */
export const criarQueryClient: Criar = (semente) => {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        // resposta de outra sessão não se retenta: ela não é desta
        retry: (falhas, erro) => !(erro instanceof SessaoEncerradaError) && falhas < 1,
        refetchOnWindowFocus: false,
      },
    },
  });
  if (semente !== undefined) client.setQueryData(ME_KEY, semente);
  return client;
};

/**
 * Um cache por sessão (ADR-050). A cada troca — login, logout, sessão perdida,
 * outra identidade ou outro workspace — nasce um `QueryClient` novo e a árvore
 * abaixo remonta: nada da sessão anterior (consulta, mutação ou estado local)
 * fica visível para a seguinte. A separação é física, sem depender de cada
 * chave de consulta levar identidade e workspace.
 */
export function SessionQueryProvider({
  children,
  criar = criarQueryClient,
}: {
  children: ReactNode;
  criar?: Criar;
}) {
  const [sessao, setSessao] = useState(() => ({ geracao: 0, client: criar() }));
  const atual = useRef(sessao.client);
  const descartar = useRef<QueryClient[]>([]);

  useEffect(
    () =>
      ouvirTrocaDeSessao((semente) => {
        descartar.current.push(atual.current);
        atual.current = criar(semente);
        const client = atual.current;
        setSessao((s) => ({ geracao: s.geracao + 1, client }));
      }),
    [criar],
  );

  // aba que volta a ficar visível relê quem é a sessão: a que perdeu a sessão,
  // ou cujo cookie mudou em outra aba, recomeça já, sem esperar o próximo clique
  useEffect(() => {
    const aoVoltar = () => {
      if (document.visibilityState === 'visible') {
        void atual.current.invalidateQueries({ queryKey: ME_KEY });
      }
    };
    document.addEventListener('visibilitychange', aoVoltar);
    return () => document.removeEventListener('visibilitychange', aoVoltar);
  }, []);

  // o anterior é limpo DEPOIS que a árvore nova montou: um observador do cache
  // velho, ainda montado, não recria nele consultas no meio da troca. `clear`
  // também cancela as retentativas.
  useEffect(() => {
    for (const anterior of descartar.current.splice(0)) anterior.clear();
  }, [sessao.geracao]);

  return (
    <QueryClientProvider key={sessao.geracao} client={sessao.client}>
      {children}
    </QueryClientProvider>
  );
}
