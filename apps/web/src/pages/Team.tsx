import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createInviteSchema,
  type InviteCreatedDto,
  type InviteDto,
  type MemberDto,
  type RoleDto,
} from '@veyra/contracts';
import { Copy, UserPlus } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { Button } from '../components/ui/button';
import { Drawer } from '../components/ui/drawer';
import { Field, Input, Select } from '../components/ui/input';
import { EmptyState, PageBody, PageHeader, Panel, PanelHeader } from '../components/ui/page';
import { api, ApiError } from '../lib/api';
import { hasPermission, useSession } from '../lib/session';

/**
 * Equipe (ADR-054, F5.1a): a tela do Core sobre as rotas que já existem. Quem
 * decide é o servidor — a não-elevação, o último Owner, a queda das sessões. A
 * tela só orienta: oferece os papéis que a pessoa administra, pela comparação
 * das PERMISSÕES (nunca pelo nome do papel, ADR-017), e mostra o efeito de cada
 * ação antes da confirmação. A recusa do servidor aparece como veio.
 */

const ESTADO: Record<MemberDto['status'], string> = {
  active: 'Ativo',
  suspended: 'Suspenso',
  removed: 'Removido',
};

/** O papel cabe nas permissões de quem opera? Só orientação: o servidor confere. */
export function administra(minhas: readonly string[], papel: Pick<RoleDto, 'permissions'>) {
  const set = new Set(minhas);
  return papel.permissions.every((p) => set.has(p));
}

/** O que a pessoa ganha e perde ao trocar de papel, pelas descrições do catálogo. */
export function diferenca(de: RoleDto, para: RoleDto): { ganha: string[]; perde: string[] } {
  const antes = new Set(de.permissions);
  const depois = new Set(para.permissions);
  return {
    ganha: para.permissions
      .filter((p) => !antes.has(p))
      .map((p) => para.permissionDescriptions[p] ?? p),
    perde: de.permissions
      .filter((p) => !depois.has(p))
      .map((p) => de.permissionDescriptions[p] ?? p),
  };
}

/** O link do convite. O token vai no FRAGMENTO: o navegador não o manda ao
 *  servidor nem no `Referer`, e ele não cai em log de acesso (ADR-054 item 3). */
export function linkDoConvite(token: string, origem = window.location.origin): string {
  return `${origem}/convite#${token}`;
}

type Acao =
  | { tipo: 'papel'; membro: MemberDto }
  | { tipo: 'remover'; membro: MemberDto }
  | { tipo: 'revogar'; convite: InviteDto };

const data = (iso: string) => new Date(iso).toLocaleDateString('pt-BR');
const dataHora = (iso: string) =>
  new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
const motivo = (erro: unknown, padrao: string) =>
  erro instanceof ApiError ? erro.message : padrao;

export function TeamPage() {
  const { data: user } = useSession();
  const queryClient = useQueryClient();
  const podeGerir = hasPermission(user, 'members:manage');
  const minhas = useMemo(() => user?.permissions ?? [], [user]);
  const eu = user?.activeMembership?.membershipId ?? null;

  const membros = useQuery({
    // a mesma chave de quem mais lê os membros (`Contacts.tsx`): uma lista só
    queryKey: ['members'],
    queryFn: () => api.get<MemberDto[]>('/api/members'),
  });
  const papeis = useQuery({
    queryKey: ['roles'],
    queryFn: () => api.get<RoleDto[]>('/api/roles'),
  });
  const convites = useQuery({
    queryKey: ['invites'],
    queryFn: () => api.get<InviteDto[]>('/api/invites'),
    enabled: podeGerir,
  });

  const porId = useMemo(() => new Map((papeis.data ?? []).map((r) => [r.id, r])), [papeis.data]);
  const nomeDoMembro = useMemo(
    () => new Map((membros.data ?? []).map((m) => [m.membershipId, m.name || m.email])),
    [membros.data],
  );
  const concediveis = useMemo(
    () => (papeis.data ?? []).filter((r) => administra(minhas, r)),
    [papeis.data, minhas],
  );

  const [acao, setAcao] = useState<Acao | null>(null);
  const [feito, setFeito] = useState<string | null>(null);

  // remover e trocar o papel também revogam convites no servidor (ADR-054 itens
  // 10 e 12): as duas listas são relidas
  const concluir = (texto: string, chaves: readonly string[]) => {
    setAcao(null);
    setFeito(texto);
    for (const chave of chaves) void queryClient.invalidateQueries({ queryKey: [chave] });
  };

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Equipe"
        meta="Quem acessa este workspace, com que papel, e os convites em aberto."
      />
      <PageBody className="space-y-6">
        {feito ? (
          <p
            role="status"
            className="max-w-4xl rounded-md border border-positive/40 bg-positive/10 px-3 py-2 text-data"
          >
            {feito}
          </p>
        ) : null}

        {podeGerir ? (
          <NovoConvite
            concediveis={concediveis}
            membros={membros.data ?? []}
            aoCriar={() => {
              setFeito(null);
              void queryClient.invalidateQueries({ queryKey: ['invites'] });
            }}
          />
        ) : null}

        <Panel className="max-w-4xl">
          <PanelHeader title="Membros" meta={membros.data ? String(membros.data.length) : ''} />
          {membros.isError ? (
            <p role="alert" className="px-4 py-3 text-body-sm text-negative">
              {motivo(membros.error, 'Não foi possível carregar os membros.')}
            </p>
          ) : null}
          {papeis.isError ? (
            <p role="alert" className="px-4 py-3 text-body-sm text-negative">
              {motivo(papeis.error, 'Não foi possível carregar os papéis.')} Sem eles, nenhuma ação
              é oferecida.
            </p>
          ) : null}
          <table className="w-full border-collapse text-body-sm">
            <thead>
              <tr className="border-b border-border bg-surface-2/50">
                {['Pessoa', 'Papel', 'Estado', 'Desde', ''].map((h, i) => (
                  <th key={`${h}-${i}`} className="px-4 py-2 text-left eyebrow text-muted-fg">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(membros.data ?? []).map((m) => {
                const papel = porId.get(m.roleId);
                const sou = m.membershipId === eu;
                const alcance = papel ? administra(minhas, papel) : false;
                return (
                  <tr key={m.membershipId} className="border-b border-border/60 last:border-b-0">
                    <td className="px-4 py-2">
                      <span className="font-medium">{m.name || m.email}</span>
                      {sou ? <span className="ml-2 text-data-sm text-muted-fg">(você)</span> : null}
                      <span className="block num text-data-sm text-muted-fg">{m.email}</span>
                    </td>
                    <td className="px-4 py-2">{m.roleName}</td>
                    <td className="px-4 py-2 text-data">{ESTADO[m.status]}</td>
                    <td className="px-4 py-2 num text-data text-muted-fg">{data(m.createdAt)}</td>
                    <td className="px-4 py-2 text-right">
                      {!podeGerir || !papeis.data ? null : sou ? (
                        <span className="text-data-sm text-muted-fg">
                          Seu acesso é alterado por outra pessoa
                        </span>
                      ) : !alcance ? (
                        <span className="text-data-sm text-muted-fg">
                          Papel acima das suas permissões
                        </span>
                      ) : (
                        <>
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={`Trocar o papel de ${m.name || m.email}`}
                            onClick={() => setAcao({ tipo: 'papel', membro: m })}
                          >
                            Trocar papel
                          </Button>
                          <Button
                            size="sm"
                            variant="danger"
                            aria-label={`Remover o acesso de ${m.name || m.email} ao workspace`}
                            onClick={() => setAcao({ tipo: 'remover', membro: m })}
                          >
                            Remover acesso ao workspace
                          </Button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Panel>

        {podeGerir ? (
          <Panel className="max-w-4xl">
            <PanelHeader
              title="Convites em aberto"
              meta={convites.data ? String(convites.data.length) : ''}
            />
            {convites.isError ? (
              <p role="alert" className="px-4 py-3 text-body-sm text-negative">
                {motivo(convites.error, 'Não foi possível carregar os convites.')}
              </p>
            ) : null}
            {convites.data && convites.data.length === 0 ? (
              <EmptyState
                title="Nenhum convite em aberto."
                hint="Um convite aceito vira membro e sai desta lista."
              />
            ) : (
              <table className="w-full border-collapse text-body-sm">
                <thead>
                  <tr className="border-b border-border bg-surface-2/50">
                    {['E-mail', 'Papel', 'Convidado por', 'Situação', ''].map((h, i) => (
                      <th key={`${h}-${i}`} className="px-4 py-2 text-left eyebrow text-muted-fg">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(convites.data ?? []).map((c) => {
                    const expirado = new Date(c.expiresAt).getTime() <= Date.now();
                    const papel = porId.get(c.roleId);
                    return (
                      <tr key={c.id} className="border-b border-border/60 last:border-b-0">
                        <td className="px-4 py-2 num text-data">{c.email}</td>
                        <td className="px-4 py-2">{c.roleName}</td>
                        <td className="px-4 py-2 text-data text-muted-fg">
                          {c.issuedByProvisioning
                            ? 'Operação (provisionamento)'
                            : c.createdByMembershipId
                              ? (nomeDoMembro.get(c.createdByMembershipId) ?? 'Ex-membro')
                              : '—'}
                        </td>
                        <td className="px-4 py-2 text-data">
                          {expirado ? (
                            <span className="text-warning">Expirou em {dataHora(c.expiresAt)}</span>
                          ) : (
                            <>Aguardando aceite até {dataHora(c.expiresAt)}</>
                          )}
                        </td>
                        <td className="px-4 py-2 text-right">
                          {!papeis.data ? null : papel && administra(minhas, papel) ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              aria-label={`Revogar o convite de ${c.email}`}
                              onClick={() => setAcao({ tipo: 'revogar', convite: c })}
                            >
                              Revogar
                            </Button>
                          ) : (
                            <span className="text-data-sm text-muted-fg">
                              Papel acima das suas permissões
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </Panel>
        ) : null}

        <Papeis papeis={papeis.data ?? []} membros={membros.data ?? []} />
      </PageBody>

      <Drawer
        open={acao !== null}
        onOpenChange={(aberto) => {
          if (!aberto) setAcao(null);
        }}
        title={
          acao?.tipo === 'papel'
            ? 'Trocar o papel'
            : acao?.tipo === 'remover'
              ? 'Remover acesso ao workspace'
              : 'Revogar o convite'
        }
      >
        {acao?.tipo === 'papel' ? (
          <TrocarPapel
            key={acao.membro.membershipId}
            membro={acao.membro}
            atual={porId.get(acao.membro.roleId) ?? null}
            concediveis={concediveis}
            aoConcluir={(texto) => concluir(texto, ['members', 'invites'])}
            aoCancelar={() => setAcao(null)}
          />
        ) : acao?.tipo === 'remover' ? (
          <RemoverMembro
            key={acao.membro.membershipId}
            membro={acao.membro}
            aoConcluir={(texto) => concluir(texto, ['members', 'invites'])}
            aoCancelar={() => setAcao(null)}
          />
        ) : acao?.tipo === 'revogar' ? (
          <RevogarConvite
            key={acao.convite.id}
            convite={acao.convite}
            aoConcluir={(texto) => concluir(texto, ['invites'])}
            aoCancelar={() => setAcao(null)}
          />
        ) : null}
      </Drawer>
    </div>
  );
}

function NovoConvite({
  concediveis,
  membros,
  aoCriar,
}: {
  concediveis: RoleDto[];
  membros: MemberDto[];
  aoCriar: () => void;
}) {
  const [email, setEmail] = useState('');
  const [roleId, setRoleId] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  /** O link aparece UMA vez: fica só no estado local, nunca é buscado de novo. */
  const [criado, setCriado] = useState<{ link: string; email: string; ate: string } | null>(null);

  const criar = useMutation({
    mutationFn: (entrada: { email: string; roleId: string }) =>
      api.post<InviteCreatedDto>('/api/invites', entrada),
    onSuccess: (convite) => {
      setCriado({
        link: linkDoConvite(convite.token),
        email: convite.email,
        ate: convite.expiresAt,
      });
      setEmail('');
      setRoleId('');
      setErro(null);
      aoCriar();
    },
    onError: (e) => setErro(motivo(e, 'Não foi possível criar o convite.')),
  });

  const enviar = () => {
    const entrada = createInviteSchema.safeParse({ email: email.trim(), roleId });
    if (!entrada.success) {
      const campo = entrada.error.issues[0]?.path[0];
      setErro(campo === 'email' ? 'Informe um e-mail válido.' : 'Escolha o papel do convite.');
      return;
    }
    const jaMembro = membros.some(
      (m) => m.email.toLowerCase() === entrada.data.email.toLowerCase(),
    );
    if (jaMembro) {
      setErro('Esta pessoa já é membro deste workspace. Para mudar o acesso, troque o papel.');
      return;
    }
    criar.mutate(entrada.data);
  };

  return (
    <Panel className="max-w-4xl">
      <PanelHeader title="Convidar" />
      <div className="space-y-3 p-4">
        {criado ? (
          <div
            data-testid="link-do-convite"
            className="rounded-md border border-accent/40 bg-accent/5 p-3"
          >
            <p className="text-xs font-medium uppercase tracking-wider text-accent">
              Link do convite para {criado.email}: copie agora
            </p>
            <p className="mt-1 text-data text-muted-fg">
              O Veyra não envia o convite. Entregue este link à pessoa por um canal seu. Ele vale
              uma única vez, até {dataHora(criado.ate)}, e não será exibido de novo.
            </p>
            <div className="mt-2 flex items-center gap-2">
              <code className="flex-1 truncate rounded bg-surface-2 px-2 py-1 num text-data">
                {criado.link}
              </code>
              <Button
                size="sm"
                aria-label="Copiar o link do convite"
                onClick={() => void navigator.clipboard?.writeText(criado.link)}
              >
                <Copy size={13} />
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setCriado(null)}>
                Fechar
              </Button>
            </div>
          </div>
        ) : null}
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            enviar();
          }}
          noValidate
        >
          <div className="min-w-64 flex-1">
            <Field label="E-mail">
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                aria-label="E-mail do convite"
                placeholder="pessoa@empresa.com.br"
              />
            </Field>
          </div>
          <Field label="Papel">
            <Select
              value={roleId}
              onChange={(e) => setRoleId(e.target.value)}
              aria-label="Papel do convite"
            >
              <option value="">Escolha o papel…</option>
              {concediveis.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </Select>
          </Field>
          <Button type="submit" variant="primary" disabled={criar.isPending}>
            <UserPlus size={14} /> Criar convite
          </Button>
        </form>
        <p className="text-data-sm text-muted-fg">
          Só aparecem os papéis cujas permissões você também tem. A pessoa entra com o papel do
          convite, na primeira vez que abrir o link.
        </p>
        {erro ? (
          <p role="alert" className="text-body-sm text-negative">
            {erro}
          </p>
        ) : null}
      </div>
    </Panel>
  );
}

function Efeitos({ children }: { children: ReactNode }) {
  return <ul className="list-disc space-y-1.5 pl-5 text-body-sm">{children}</ul>;
}

function Rodape({
  confirmar,
  variante,
  pendente,
  erro,
  aoConfirmar,
  aoCancelar,
  desabilitado = false,
}: {
  confirmar: string;
  variante: 'primary' | 'danger';
  pendente: boolean;
  erro: unknown;
  aoConfirmar: () => void;
  aoCancelar: () => void;
  desabilitado?: boolean;
}) {
  return (
    <div className="mt-5 space-y-3">
      {erro ? (
        <p role="alert" className="text-body-sm text-negative">
          {motivo(erro, 'Não foi possível concluir. Nada foi alterado.')}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button variant={variante} disabled={pendente || desabilitado} onClick={aoConfirmar}>
          {confirmar}
        </Button>
        <Button variant="ghost" disabled={pendente} onClick={aoCancelar}>
          Cancelar
        </Button>
      </div>
    </div>
  );
}

function TrocarPapel({
  membro,
  atual,
  concediveis,
  aoConcluir,
  aoCancelar,
}: {
  membro: MemberDto;
  atual: RoleDto | null;
  concediveis: RoleDto[];
  aoConcluir: (texto: string) => void;
  aoCancelar: () => void;
}) {
  const nome = membro.name || membro.email;
  const opcoes = concediveis.filter((r) => r.id !== membro.roleId);
  const [roleId, setRoleId] = useState('');
  const novo = opcoes.find((r) => r.id === roleId) ?? null;
  const mudanca = atual && novo ? diferenca(atual, novo) : null;

  const trocar = useMutation({
    mutationFn: () =>
      api.patch<{ ok: true }>(`/api/members/${membro.membershipId}/role`, { roleId }),
    onSuccess: () =>
      aoConcluir(
        `${nome} agora tem o papel ${novo?.name ?? ''}. O acesso emitido com o papel anterior deixou de valer.`,
      ),
  });

  return (
    <div>
      <p className="text-body-sm">
        <span className="font-medium">{nome}</span> tem hoje o papel{' '}
        <span className="font-medium">{membro.roleName}</span>.
      </p>
      <div className="mt-4">
        <Field label="Novo papel">
          <Select
            full
            value={roleId}
            onChange={(e) => setRoleId(e.target.value)}
            aria-label="Novo papel"
            disabled={trocar.isPending}
          >
            <option value="">Escolha o papel…</option>
            {opcoes.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {mudanca ? (
        <div className="mt-4 space-y-3" data-testid="efeito-da-troca">
          <p className="eyebrow text-muted-fg">O que muda</p>
          {mudanca.ganha.length === 0 && mudanca.perde.length === 0 ? (
            <p className="text-body-sm">As permissões são as mesmas; muda só o papel.</p>
          ) : null}
          {mudanca.ganha.length > 0 ? (
            <div>
              <p className="text-data font-medium">Passa a poder</p>
              <Efeitos>
                {mudanca.ganha.map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </Efeitos>
            </div>
          ) : null}
          {mudanca.perde.length > 0 ? (
            <div>
              <p className="text-data font-medium">Deixa de poder</p>
              <Efeitos>
                {mudanca.perde.map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </Efeitos>
            </div>
          ) : null}
          <p className="text-body-sm">
            Na próxima ação de {nome}, o acesso emitido com o papel antigo deixa de valer, inclusive
            nas sessões abertas, e a sessão segue já com as permissões do novo papel. A troca fica
            na auditoria.
          </p>
          <p className="text-body-sm">
            Os convites em aberto que {nome} emitiu e que o novo papel não autoriza são revogados
            junto, e não voltam a valer.
          </p>
        </div>
      ) : null}
      <Rodape
        confirmar="Confirmar a troca"
        variante="primary"
        pendente={trocar.isPending}
        erro={trocar.error}
        desabilitado={!novo}
        aoConfirmar={() => trocar.mutate()}
        aoCancelar={aoCancelar}
      />
    </div>
  );
}

function RemoverMembro({
  membro,
  aoConcluir,
  aoCancelar,
}: {
  membro: MemberDto;
  aoConcluir: (texto: string) => void;
  aoCancelar: () => void;
}) {
  const nome = membro.name || membro.email;
  const remover = useMutation({
    mutationFn: () => api.delete<{ ok: true }>(`/api/members/${membro.membershipId}`),
    onSuccess: () => aoConcluir(`${nome} não tem mais acesso a este workspace.`),
  });
  return (
    <div data-testid="efeito-da-remocao">
      <p className="text-body-sm">
        Remover o acesso de <span className="font-medium">{nome}</span> ({membro.roleName}) a este
        workspace:
      </p>
      <div className="mt-3">
        <Efeitos>
          <li>
            O acesso acaba na próxima requisição dessa pessoa, inclusive nas sessões já abertas.
          </li>
          <li>A conta da pessoa no Veyra não é excluída: só o acesso a este workspace acaba.</li>
          <li>O que ela registrou continua no workspace.</li>
          <li>
            Os convites em aberto para o e-mail dessa pessoa, e os que ela emitiu, são revogados
            junto. Readmiti-la depois não os traz de volta.
          </li>
          <li>
            A volta é só por um novo convite, que reativa o mesmo cadastro com o papel do convite.
          </li>
          <li>A remoção fica na auditoria.</li>
        </Efeitos>
      </div>
      <Rodape
        confirmar="Confirmar a remoção do acesso"
        variante="danger"
        pendente={remover.isPending}
        erro={remover.error}
        aoConfirmar={() => remover.mutate()}
        aoCancelar={aoCancelar}
      />
    </div>
  );
}

function RevogarConvite({
  convite,
  aoConcluir,
  aoCancelar,
}: {
  convite: InviteDto;
  aoConcluir: (texto: string) => void;
  aoCancelar: () => void;
}) {
  const revogar = useMutation({
    mutationFn: () => api.delete<{ ok: true }>(`/api/invites/${convite.id}`),
    onSuccess: () => aoConcluir(`O convite de ${convite.email} foi revogado.`),
  });
  return (
    <div>
      <p className="text-body-sm">
        Revogar o convite de <span className="font-medium">{convite.email}</span> (
        {convite.roleName}):
      </p>
      <div className="mt-3">
        <Efeitos>
          <li>O link enviado deixa de funcionar.</li>
          <li>Para convidar de novo, crie outro convite.</li>
          <li>A revogação fica na auditoria.</li>
        </Efeitos>
      </div>
      <Rodape
        confirmar="Confirmar a revogação"
        variante="danger"
        pendente={revogar.isPending}
        erro={revogar.error}
        aoConfirmar={() => revogar.mutate()}
        aoCancelar={aoCancelar}
      />
    </div>
  );
}

function Papeis({ papeis, membros }: { papeis: RoleDto[]; membros: MemberDto[] }) {
  return (
    <Panel className="max-w-4xl">
      <PanelHeader title="Papéis e permissões" />
      <p className="px-4 pt-3 text-data text-muted-fg">
        Cada membro tem um papel. As permissões dos papéis não são editadas pela interface.
      </p>
      <ul className="divide-y divide-border/60">
        {papeis.map((r) => {
          const quantos = membros.filter((m) => m.roleId === r.id).length;
          return (
            <li key={r.id} className="px-4 py-2.5">
              <details>
                <summary className="cursor-pointer text-body-sm">
                  <span className="font-medium">{r.name}</span>
                  <span className="ml-2 text-data-sm text-muted-fg">
                    {r.permissions.length} permissões · {quantos}{' '}
                    {quantos === 1 ? 'membro' : 'membros'}
                    {r.isSystem ? ' · padrão do sistema' : ''}
                  </span>
                </summary>
                {r.description ? (
                  <p className="mt-2 text-data text-muted-fg">{r.description}</p>
                ) : null}
                <ul className="mt-2 space-y-1">
                  {[...r.permissions].sort().map((p) => (
                    <li key={p} className="text-data">
                      {r.permissionDescriptions[p] ?? p}{' '}
                      <code className="num text-data-sm text-muted-fg">{p}</code>
                    </li>
                  ))}
                </ul>
              </details>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
