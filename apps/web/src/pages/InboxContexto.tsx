import type { ConversationDto, ConversationStatus } from '@veyra/contracts';
import { ArrowUpRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Avatar } from '../components/ui/avatar';
import { WindowMeter } from '../components/ui/window-meter';
import { useLinks } from '../lib/experience';
import { fullStamp } from '../lib/format';
import { useSession } from '../lib/session';

export const ROTULO_DO_STATUS: Record<ConversationStatus, string> = {
  open: 'Aberta',
  pending: 'Pendente',
  closed: 'Fechada',
};

export const ROTULO_DO_CANAL: Record<ConversationDto['channelType'], string> = {
  internal: 'Interno',
  email: 'E-mail',
  whatsapp: 'WhatsApp',
};

/**
 * Quem responde pela conversa: "você" quando é a membership desta sessão. Só
 * apresentação — o servidor não muda por isso.
 */
export function useResponsavel(
  conversa: Pick<ConversationDto, 'assigneeName' | 'assigneeMembershipId'> | null,
): string | null {
  const { data: user } = useSession();
  if (!conversa?.assigneeName) return null;
  return conversa.assigneeMembershipId !== null &&
    conversa.assigneeMembershipId === user?.activeMembership?.membershipId
    ? 'você'
    : conversa.assigneeName;
}

function Item({ rotulo, children }: { rotulo: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <dt className="shrink-0 text-[12.5px] text-muted-fg">{rotulo}</dt>
      <dd className="min-w-0 text-right text-[13px]">{children}</dd>
    </div>
  );
}

/**
 * A terceira coluna das Conversas (ADR-062): o contexto de quem escreve e da
 * própria conversa, para o cabeçalho ficar com o nome, a janela e as ações.
 *
 * Só INFORMAÇÃO que a conversa já mostrava, e só o que o DTO do Core traz — o
 * Core não conhece verticais (CLAUDE.md §3.8), então nada de agenda, pacote ou
 * "próximo horário" aqui. Nenhuma ação mora só neste painel: ele some em telas
 * estreitas, e tudo o que se faz na conversa continua no cabeçalho e no
 * compositor.
 *
 * A RAI (remetente a identificar) não ganha rosto nem nome: só o número, que a
 * lista já mostra — mascarado pelo servidor para quem não lê contatos.
 */
export function ContextoDaConversa({
  conversa,
  janelaExpiraEm,
}: {
  conversa: ConversationDto;
  /** o instante da política de envio quando houver (mais novo); senão, o do DTO */
  janelaExpiraEm: string | null;
}) {
  const { data: user } = useSession();
  const links = useLinks();
  const responsavel = useResponsavel(conversa);
  const rai = conversa.senderStatus === 'unidentified';
  // o destino é o do produto ativo (ADR-055): sem resolvedor ou sem a
  // permissão, nenhum link — o mesmo critério do painel de consentimento
  const fichaDoContato =
    !rai && conversa.contactId !== null
      ? (links.contato?.(conversa.contactId, user) ?? null)
      : null;

  return (
    <aside
      aria-label="Contexto da conversa"
      className="hidden w-72 shrink-0 flex-col gap-5 overflow-auto border-l border-border bg-surface p-5 min-[1360px]:flex"
    >
      <div className="flex flex-col gap-2">
        <h3 className="text-[12.5px] font-normal text-muted-fg">{rai ? 'Remetente' : 'Contato'}</h3>
        {rai ? (
          <>
            <p className="font-display text-[17px] font-semibold leading-tight">
              Remetente a identificar
            </p>
            {conversa.senderAddress ? (
              <p className="num text-[12.5px] text-muted-fg">{conversa.senderAddress}</p>
            ) : null}
            <p className="text-data text-muted-fg">
              Quem escreveu ainda não foi identificado: nada é atribuído sozinho.
            </p>
          </>
        ) : conversa.contactName ? (
          <>
            <div className="flex items-center gap-3">
              <Avatar
                nome={conversa.contactName}
                chave={conversa.contactId ?? conversa.id}
                tamanho="lg"
              />
              <p className="min-w-0 font-display text-[17px] font-semibold leading-tight">
                {conversa.contactName}
              </p>
            </div>
            {fichaDoContato ? (
              <Link
                to={fichaDoContato}
                className="mt-1 inline-flex items-center justify-center gap-1.5 rounded-control border border-border-strong px-3 py-2 text-[13px] font-medium text-foreground transition-colors duration-150 hover:bg-surface-2"
              >
                Abrir a ficha do contato <ArrowUpRight size={13} aria-hidden />
              </Link>
            ) : null}
          </>
        ) : (
          <p className="text-body-sm text-muted-fg">Sem contato vinculado.</p>
        )}
      </div>

      {conversa.channelType !== 'internal' && janelaExpiraEm !== null ? (
        <div className="rounded-[12px] bg-surface-2 p-3.5">
          <WindowMeter expiresAt={janelaExpiraEm} />
        </div>
      ) : null}

      <div className="flex flex-col">
        <h3 className="text-[12.5px] font-normal text-muted-fg">Conversa</h3>
        <dl className="mt-1 divide-y divide-border/70">
          {conversa.subject ? (
            <Item rotulo="Assunto">
              <span className="break-words">{conversa.subject}</span>
            </Item>
          ) : null}
          <Item rotulo="Canal">{ROTULO_DO_CANAL[conversa.channelType]}</Item>
          <Item rotulo="Status">{ROTULO_DO_STATUS[conversa.status]}</Item>
          <Item rotulo="Responsável">
            {responsavel ?? <span className="text-muted-fg">ninguém</span>}
          </Item>
          <Item rotulo="Criada em">
            <span className="num text-data">{fullStamp(conversa.createdAt)}</span>
          </Item>
          <Item rotulo="Última mensagem">
            <span className="num text-data">{fullStamp(conversa.lastMessageAt)}</span>
          </Item>
        </dl>
      </div>
    </aside>
  );
}
