import { useMutation } from '@tanstack/react-query';
import { acceptInviteSchema, type AuthUserDto } from '@veyra/contracts';
import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { Button } from '../components/ui/button';
import { Field, Input } from '../components/ui/input';
import { api, ApiError } from '../lib/api';
import { useSession } from '../lib/session';

/**
 * Aceite do convite (ADR-054 item 4), pela rota que já existe. O token chega no
 * FRAGMENTO (`/convite#<token>`), que o navegador nunca envia ao servidor, e
 * sai do endereço logo depois do primeiro render. A página não sabe se o e-mail
 * do convite tem conta: a pessoa diz, e a mensagem de erro do servidor é única.
 *
 * O aceite emite sessão, e o `lib/api.ts` troca de sessão ao vê-la (ADR-050):
 * a árvore remonta, o fragmento já não existe, e a sessão nova leva à visão do
 * dia.
 */
export function AcceptInvitePage() {
  const { data: user, isLoading } = useSession();
  // leitura pura: o StrictMode chama o inicializador duas vezes
  const [token] = useState(() => window.location.hash.replace(/^#/, ''));
  const [modo, setModo] = useState<'conta' | 'nova'>('nova');
  const [nome, setNome] = useState('');
  const [senha, setSenha] = useState('');
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    document.title = 'Aceitar convite · Veyra';
    if (window.location.hash) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    }
  }, []);

  const aceitar = useMutation({
    mutationFn: (corpo: { token: string; name?: string; password: string }) =>
      api.post<AuthUserDto>('/api/invites/accept', corpo),
    onError: (e) => setErro(e instanceof ApiError ? e.message : 'Não foi possível aceitar.'),
  });

  // sem token (inclusive depois do aceite, com a árvore remontada): quem tem
  // sessão vai para o produto, e quem não tem, para o login
  if (!token) return isLoading ? null : <Navigate to={user ? '/' : '/login'} replace />;

  const tokenValido = acceptInviteSchema.shape.token.safeParse(token).success;

  const enviar = () => {
    const corpo =
      modo === 'nova' ? { token, name: nome.trim(), password: senha } : { token, password: senha };
    const entrada = acceptInviteSchema.safeParse(corpo);
    if (!entrada.success || (modo === 'nova' && !nome.trim())) {
      setErro(
        modo === 'nova'
          ? 'Informe seu nome e uma senha com pelo menos 8 caracteres.'
          : 'Informe a senha da sua conta (pelo menos 8 caracteres).',
      );
      return;
    }
    setErro(null);
    aceitar.mutate(corpo);
  };

  return (
    <main className="flex min-h-screen items-center justify-center px-6 py-12">
      <div className="w-full max-w-sm rise">
        <span className="block text-display-lg leading-none text-accent">veyra</span>
        <h1 className="mt-8 text-display-sm">Aceitar o convite</h1>

        {!tokenValido ? (
          <p role="alert" className="mt-5 text-body-sm text-negative">
            Este link de convite está incompleto. Peça um novo link a quem convidou você.
          </p>
        ) : (
          <>
            {user ? (
              <p className="mt-4 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-data">
                Você está conectado como {user.email}. Aceitar o convite encerra essa sessão neste
                navegador e entra com a conta do convite.
              </p>
            ) : null}
            <fieldset className="mt-5 space-y-2">
              <legend className="eyebrow mb-1.5 text-muted-fg">Sua conta no Veyra</legend>
              <label className="flex items-center gap-2 text-body-sm">
                <input
                  type="radio"
                  name="modo"
                  checked={modo === 'nova'}
                  onChange={() => setModo('nova')}
                />
                Ainda não tenho conta: criar agora
              </label>
              <label className="flex items-center gap-2 text-body-sm">
                <input
                  type="radio"
                  name="modo"
                  checked={modo === 'conta'}
                  onChange={() => setModo('conta')}
                />
                Já tenho conta com o e-mail do convite
              </label>
            </fieldset>
            <form
              className="mt-4 space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                enviar();
              }}
              noValidate
            >
              {modo === 'nova' ? (
                <Field label="Seu nome">
                  <Input
                    autoComplete="name"
                    value={nome}
                    onChange={(e) => setNome(e.target.value)}
                  />
                </Field>
              ) : null}
              <Field
                label={modo === 'nova' ? 'Crie uma senha' : 'Senha da sua conta'}
                hint="Pelo menos 8 caracteres."
              >
                <Input
                  type="password"
                  autoComplete={modo === 'nova' ? 'new-password' : 'current-password'}
                  value={senha}
                  onChange={(e) => setSenha(e.target.value)}
                />
              </Field>
              {erro ? (
                <p role="alert" className="text-body-sm text-negative">
                  {erro}
                </p>
              ) : null}
              <Button
                type="submit"
                variant="primary"
                className="w-full"
                disabled={aceitar.isPending}
              >
                {aceitar.isPending ? 'Entrando…' : 'Aceitar e entrar'}
              </Button>
            </form>
            <p className="mt-6 border-t border-border pt-4 text-data text-muted-fg">
              Se o e-mail do convite já tem conta no Veyra, use a senha dela. O convite vale uma
              única vez.
            </p>
          </>
        )}
      </div>
    </main>
  );
}
