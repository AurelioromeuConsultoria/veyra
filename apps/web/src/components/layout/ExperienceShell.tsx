import { useIsFetching, useQueryClient } from '@tanstack/react-query';
import { LogOut } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Button } from '../ui/button';
import {
  ExperienceProvider,
  estadoDaExperiencia,
  type ExperienceManifest,
} from '../../lib/experience';
import { ME_KEY, logoutFalhou, useLogout, useSession } from '../../lib/session';
import { ouvirIncompatibilidade, sessaoIncompativel } from '../../lib/session-scope';
import { AppShell } from './AppShell';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';

/**
 * O shell da experiência (ADR-055, adendo 2, itens 2 e 3). Decide pela SESSÃO —
 * nunca pelo CRM por omissão:
 * - sem workspace, a tela neutra com o seletor;
 * - chave que o servidor ou este web não conhecem, a tela de desconhecida;
 * - experiência indisponível, a tela de indisponível;
 * - só `ready` com um manifesto conhecido monta o produto, e só as rotas dele.
 *
 * As telas neutras não têm menu de produto, busca de registros nem dado do
 * workspace. A mudança de estado é troca de sessão (cache novo), então nada da
 * tela anterior sobrevive a ela.
 */
export function ExperienceShell({ manifestos }: { manifestos: readonly ExperienceManifest[] }) {
  const { data: user } = useSession();
  if (!user) return null; // o `Protected` cuida do "sem sessão" e do "carregando"

  const estado = estadoDaExperiencia(user, manifestos);
  if (estado.tipo === 'sem-workspace') {
    return (
      <TelaNeutra manifestos={manifestos} titulo="Você não tem um workspace ativo">
        O acesso a este workspace acabou, ou você ainda não faz parte de nenhum.
      </TelaNeutra>
    );
  }
  if (estado.tipo === 'desconhecida') {
    return (
      <TelaNeutra manifestos={manifestos} titulo="Este workspace usa um produto desconhecido">
        Esta versão do Veyra não reconhece o produto deste workspace. Atualize a página; se
        continuar, fale com quem administra o workspace.
      </TelaNeutra>
    );
  }
  if (estado.tipo === 'indisponivel') {
    return (
      <TelaNeutra
        manifestos={manifestos}
        titulo={`${estado.produto ?? 'O produto'} está indisponível`}
        acao={<VerificarDeNovo />}
      >
        O produto deste workspace está desativado no momento, ou não pôde ser confirmado. Quem
        administra o workspace pode reativá-lo.
      </TelaNeutra>
    );
  }

  const m = estado.manifesto;
  return (
    <ExperienceProvider value={m}>
      <Routes>
        <Route element={<AppShell manifestos={manifestos} />}>
          {m.inicio !== '/' ? (
            <Route path="/" element={<Navigate to={m.inicio} replace />} />
          ) : null}
          {m.rotas.map((rota) => (
            <Route key={rota.path} path={rota.path} element={rota.element} />
          ))}
          <Route path="*" element={<ForaDaExperiencia inicio={m.inicio} />} />
        </Route>
      </Routes>
    </ExperienceProvider>
  );
}

/** Uma rota que o produto não monta: o início dele, com o aviso. */
function ForaDaExperiencia({ inicio }: { inicio: string }) {
  const { pathname } = useLocation();
  return <Navigate to={inicio} replace state={{ foraDaExperiencia: pathname }} />;
}

/**
 * O título da aba fora de um produto: nada da tela anterior (seção, workspace ou
 * produto) fica nele — só o `AppHeader` de um produto escreve o título.
 */
export function useTituloNeutro(): void {
  useEffect(() => {
    document.title = 'Veyra';
  }, []);
}

/** A aba parou por incompatibilidade de sessão? (o `App` mostra a tela, acima de tudo) */
export function useIncompativel(): boolean {
  const [incompativel, setIncompativel] = useState(sessaoIncompativel);
  useEffect(() => {
    const parar = ouvirIncompatibilidade(() => setIncompativel(true));
    // a que disparou entre o render e a assinatura não se perde
    if (sessaoIncompativel()) setIncompativel(true);
    return () => {
      parar();
    };
  }, []);
  return incompativel;
}

/**
 * A saída da tela de indisponível (adendo 2, item 7): a pessoa pede, a sessão é
 * relida uma vez. Se voltou a `ready`, é troca de sessão e o produto volta, com
 * cache novo. Nada automático: a tela neutra não faz requisição sozinha (a
 * volta da aba relê a sessão, como em qualquer tela).
 */
function VerificarDeNovo() {
  const queryClient = useQueryClient();
  const relendo = useIsFetching({ queryKey: ME_KEY }) > 0;
  return (
    <Button
      size="sm"
      variant="secondary"
      disabled={relendo}
      onClick={() => void queryClient.invalidateQueries({ queryKey: ME_KEY })}
    >
      {relendo ? 'Verificando…' : 'Verificar de novo'}
    </Button>
  );
}

/**
 * A divergência de sessão que persiste (adendo 2, item 8): a aba parou. Só a
 * pessoa recarrega — nada de recarga automática, nova tentativa ou reenvio de
 * escrita.
 */
export function Incompativel() {
  useTituloNeutro();
  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <div role="alert" className="max-w-md space-y-3 text-center">
        <span className="block text-display-lg leading-none text-accent">veyra</span>
        <h1 className="text-display-sm">Atualize a página para continuar</h1>
        <p className="text-body-sm text-muted-fg">
          Esta página foi aberta numa versão anterior do Veyra e não consegue mais conversar com o
          servidor. Nada foi enviado depois disso. Atualize a página; o que não tinha sido salvo
          precisa ser feito de novo.
        </p>
        <Button variant="primary" onClick={() => window.location.reload()}>
          Atualizar a página
        </Button>
      </div>
    </main>
  );
}

function TelaNeutra({
  manifestos,
  titulo,
  acao,
  children,
}: {
  manifestos: readonly ExperienceManifest[];
  titulo: string;
  acao?: ReactNode;
  children: ReactNode;
}) {
  useTituloNeutro();
  const { data: user } = useSession();
  const logout = useLogout();
  const outros = (user?.memberships ?? []).filter(
    (m) => m.status === 'active' && m.membershipId !== user?.activeMembership?.membershipId,
  );
  return (
    <main className="flex min-h-screen items-center justify-center px-6 py-12">
      <div className="w-full max-w-md space-y-5" data-testid="tela-neutra">
        <span className="block text-display-lg leading-none text-accent">veyra</span>
        <div className="space-y-2">
          <h1 className="text-display-sm">{titulo}</h1>
          <p className="text-body-sm text-muted-fg">{children}</p>
          {user?.activeMembership ? (
            <p className="text-data text-muted-fg">
              Workspace: <span className="font-medium">{user.activeMembership.workspaceName}</span>
            </p>
          ) : null}
          {acao}
        </div>
        {outros.length > 0 ? <WorkspaceSwitcher manifestos={manifestos} variante="lista" /> : null}
        <div className="flex items-center gap-3 border-t border-border pt-4">
          <span className="text-data text-muted-fg">{user?.email}</span>
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => logout.mutate()}>
            <LogOut size={13} aria-hidden /> Sair
          </Button>
        </div>
        {logoutFalhou(logout.error) ? (
          <p role="alert" className="text-data-sm text-negative">
            Não foi possível sair — você continua conectado neste navegador. Tente de novo.
          </p>
        ) : null}
      </div>
    </main>
  );
}
