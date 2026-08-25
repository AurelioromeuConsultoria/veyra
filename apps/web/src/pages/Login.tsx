import { zodResolver } from '@hookform/resolvers/zod';
import { loginSchema, type LoginInput } from '@veyra/contracts';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { Navigate } from 'react-router-dom';
import { Button } from '../components/ui/button';
import { Field, Input } from '../components/ui/input';
import { ApiError } from '../lib/api';
import { useLogin, useSession } from '../lib/session';

export function LoginPage() {
  const { data: user, isLoading } = useSession();
  const login = useLogin();
  const form = useForm<LoginInput>({ resolver: zodResolver(loginSchema) });

  /** sair devolve a aba ao estado neutro; sem isto o título fica preso na
   *  última seção (e no nome do workspace de quem acabou de sair) */
  useEffect(() => {
    document.title = 'Entrar · Veyra';
  }, []);

  // o destino do login é a visão do dia, não uma tabela
  if (!isLoading && user) return <Navigate to="/" replace />;

  return (
    <main className="flex min-h-screen">
      <div className="flex flex-1 items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm rise">
          <span className="block text-display-lg leading-none text-accent">veyra</span>
          <p className="eyebrow mt-2 text-muted-fg">CRM Core · plataforma</p>

          <h1 className="mt-8 text-display-sm">Entrar no workspace</h1>
          <form
            className="mt-5 space-y-4"
            onSubmit={form.handleSubmit((values) => login.mutate(values))}
            noValidate
          >
            <Field label="E-mail" error={form.formState.errors.email?.message}>
              <Input type="email" autoComplete="email" autoFocus {...form.register('email')} />
            </Field>
            <Field label="Senha" error={form.formState.errors.password?.message}>
              <Input
                type="password"
                autoComplete="current-password"
                {...form.register('password')}
              />
            </Field>
            {login.error ? (
              <p role="alert" className="text-body-sm text-negative">
                {login.error instanceof ApiError ? login.error.message : 'Falha no login'}
              </p>
            ) : null}
            <Button
              type="submit"
              variant="primary"
              className="w-full"
              disabled={login.isPending}
              size="md"
            >
              {login.isPending ? 'Entrando…' : 'Entrar'}
            </Button>
          </form>
          <p className="mt-6 border-t border-border pt-4 text-data text-muted-fg">
            Sem conta? A entrada é por convite do seu workspace.
          </p>
        </div>
      </div>

      {/*
       * Painel mineral: superfície, hairlines e uma frase. Nenhum gradiente,
       * nenhum glow — a profundidade vem do contraste entre superfícies (§5).
       */}
      <aside className="relative hidden w-[46%] max-w-2xl flex-col justify-between border-l border-border bg-surface px-12 py-12 lg:flex">
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.5]"
          style={{
            backgroundImage:
              'repeating-linear-gradient(90deg, var(--border) 0 1px, transparent 1px 96px)',
            maskImage: 'linear-gradient(to bottom, transparent, black 30%, black 70%, transparent)',
          }}
        />
        <p className="eyebrow relative text-muted-fg">Núcleo de relacionamento</p>
        <div className="relative max-w-md">
          <p className="text-display-lg">
            O trabalho do dia — contatos, oportunidades e conversas — num só instrumento.
          </p>
          <p className="mt-4 text-body text-muted-fg">
            A inteligência aparece como sinal, sugestão e próxima ação. Nada sai sem uma decisão
            humana.
          </p>
        </div>
        <dl className="relative flex gap-10">
          {[
            ['Isolamento', 'por workspace'],
            ['Permissões', 'default-deny'],
            ['Auditoria', 'de ponta a ponta'],
          ].map(([term, detail]) => (
            <div key={term}>
              <dt className="eyebrow text-muted-fg">{term}</dt>
              <dd className="mt-1 text-data text-foreground">{detail}</dd>
            </div>
          ))}
        </dl>
      </aside>
    </main>
  );
}
