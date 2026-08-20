import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ConversationDto,
  ConversationPageDto,
  ConversationStatus,
  FileObjectDto,
  MessageDto,
  MessagePageDto,
} from '@veyra/contracts';
import { clsx } from 'clsx';
import { MessageSquarePlus, Paperclip, Send, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../components/ui/button';
import { Input, Select } from '../components/ui/input';
import { api, ApiError, toQuery } from '../lib/api';
import { hasPermission, useSession } from '../lib/session';

const timeFormat = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

const statusLabels: Record<ConversationStatus, string> = {
  open: 'Aberta',
  pending: 'Pendente',
  closed: 'Fechada',
};

export function InboxPage() {
  const { data: user } = useSession();
  const canWrite = hasPermission(user, 'conversations:write');
  const queryClient = useQueryClient();

  const [status, setStatus] = useState<'open' | 'pending' | 'closed' | 'all'>('open');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<FileObjectDto[]>([]);
  const [subject, setSubject] = useState('');
  const [error, setError] = useState<string | null>(null);

  const listParams = { status, limit: 50 };
  const conversations = useQuery({
    queryKey: ['conversations', listParams],
    queryFn: () => api.get<ConversationPageDto>(`/api/conversations${toQuery(listParams)}`),
    placeholderData: keepPreviousData,
  });
  const items = conversations.data?.items ?? [];
  const selected = items.find((c) => c.id === selectedId) ?? null;

  const messages = useQuery({
    queryKey: ['messages', selectedId],
    queryFn: () => api.get<MessagePageDto>(`/api/conversations/${selectedId}/messages?limit=50`),
    enabled: selectedId !== null,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['conversations'] });
    void queryClient.invalidateQueries({ queryKey: ['messages'] });
  };

  const createConversation = useMutation({
    mutationFn: () => api.post<ConversationDto>('/api/conversations', { subject: subject.trim() }),
    onSuccess: (created) => {
      setSubject('');
      setError(null);
      setSelectedId(created.id);
      invalidate();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Falha ao criar conversa'),
  });

  const attach = useMutation({
    mutationFn: (file: File) => api.upload<FileObjectDto>('/api/files', file),
    onSuccess: (file) => {
      setAttachments((current) => [...current, file]);
      setError(null);
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Falha ao enviar arquivo'),
  });

  const send = useMutation({
    mutationFn: (direction: 'inbound' | 'outbound') =>
      api.post<MessageDto>(`/api/conversations/${selectedId}/messages`, {
        direction,
        body: draft.trim(),
        attachmentIds: attachments.map((file) => file.id),
      }),
    onSuccess: () => {
      setDraft('');
      setAttachments([]);
      setError(null);
      invalidate();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Falha ao registrar mensagem'),
  });

  const changeStatus = useMutation({
    mutationFn: (next: ConversationStatus) =>
      api.patch<ConversationDto>(`/api/conversations/${selectedId}`, { status: next }),
    onSuccess: () => invalidate(),
  });

  // rola para a mensagem mais recente quando a conversa muda ou chega mensagem
  const threadRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight });
  }, [messages.data]);

  // do mais recente para o mais antigo no servidor; a leitura é cronológica
  const thread = [...(messages.data?.items ?? [])].reverse();

  return (
    <div className="flex h-screen">
      {/* ── lista densa ─────────────────────────────────────────────────── */}
      <div className="flex w-80 shrink-0 flex-col border-r border-border">
        <header className="flex items-center gap-2 border-b border-border px-4 py-3">
          <h1 className="mr-auto text-sm font-semibold">Inbox</h1>
          <Select
            className="h-7 w-auto text-xs"
            value={status}
            onChange={(e) => setStatus(e.target.value as typeof status)}
            aria-label="Filtrar por status"
          >
            <option value="open">Abertas</option>
            <option value="pending">Pendentes</option>
            <option value="closed">Fechadas</option>
            <option value="all">Todas</option>
          </Select>
        </header>

        {canWrite ? (
          <form
            className="flex gap-1.5 border-b border-border px-3 py-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (subject.trim()) createConversation.mutate();
            }}
          >
            <Input
              className="h-8 text-xs"
              placeholder="Nova conversa…"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              aria-label="Assunto da nova conversa"
            />
            <Button
              type="submit"
              size="sm"
              variant="ghost"
              disabled={!subject.trim() || createConversation.isPending}
              aria-label="Criar conversa"
            >
              <MessageSquarePlus size={14} />
            </Button>
          </form>
        ) : null}

        <ul className="flex-1 overflow-auto">
          {items.map((conversation) => (
            <li key={conversation.id}>
              <button
                type="button"
                onClick={() => setSelectedId(conversation.id)}
                aria-current={conversation.id === selectedId}
                className={clsx(
                  'w-full border-b border-border/60 px-4 py-2.5 text-left hover:bg-surface-2',
                  conversation.id === selectedId && 'bg-surface-2',
                )}
              >
                <div className="flex items-baseline gap-2">
                  <span className="truncate text-[13px] font-medium">
                    {conversation.contactName ?? conversation.subject ?? 'Sem assunto'}
                  </span>
                  <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums text-muted-fg">
                    {timeFormat.format(new Date(conversation.lastMessageAt))}
                  </span>
                </div>
                <div className="mt-0.5 flex items-center gap-1.5">
                  <span className="truncate text-xs text-muted-fg">
                    {conversation.contactName ? (conversation.subject ?? '—') : 'Sem contato'}
                  </span>
                  {conversation.status !== 'open' ? (
                    <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wider text-warning">
                      {statusLabels[conversation.status]}
                    </span>
                  ) : null}
                </div>
              </button>
            </li>
          ))}
          {conversations.data && items.length === 0 ? (
            <li className="px-4 py-16 text-center text-sm text-muted-fg">Nenhuma conversa aqui.</li>
          ) : null}
        </ul>
      </div>

      {/* ── conversa ────────────────────────────────────────────────────── */}
      {selected ? (
        <div className="flex flex-1 flex-col">
          <header className="flex items-center gap-3 border-b border-border px-5 py-3">
            <div className="mr-auto min-w-0">
              <h2 className="truncate text-sm font-semibold">
                {selected.contactName ?? selected.subject ?? 'Conversa'}
              </h2>
              <p className="truncate text-xs text-muted-fg">
                {selected.subject ?? '—'} · canal {selected.channelType}
                {selected.assigneeName ? ` · ${selected.assigneeName}` : ''}
              </p>
            </div>
            {canWrite ? (
              <Select
                className="h-7 w-auto text-xs"
                value={selected.status}
                onChange={(e) => changeStatus.mutate(e.target.value as ConversationStatus)}
                aria-label="Status da conversa"
              >
                {Object.entries(statusLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </Select>
            ) : null}
          </header>

          <div ref={threadRef} className="flex-1 space-y-3 overflow-auto px-5 py-4">
            {thread.map((message) => (
              <div
                key={message.id}
                className={clsx(
                  'max-w-[70%] rounded-md border px-3 py-2',
                  message.direction === 'outbound'
                    ? 'ml-auto border-accent/30 bg-accent/5'
                    : 'border-border bg-surface',
                )}
              >
                <div className="flex items-baseline gap-2">
                  <span className="text-[11px] font-medium">{message.authorName ?? '—'}</span>
                  <span className="font-mono text-[10px] tabular-nums text-muted-fg">
                    {timeFormat.format(new Date(message.createdAt))}
                  </span>
                </div>
                {/* React escapa por padrão: corpo de mensagem nunca vira HTML */}
                <p className="mt-1 whitespace-pre-wrap text-[13px]">{message.body}</p>
                {message.attachments.length > 0 ? (
                  <ul className="mt-1.5 space-y-0.5">
                    {message.attachments.map((file) => (
                      <li key={file.fileObjectId}>
                        {/* download passa pelo endpoint autorizado, nunca por URL pública */}
                        <a
                          className="flex items-center gap-1 text-[11px] text-accent hover:underline"
                          href={`/api/files/${file.fileObjectId}/content`}
                        >
                          <Paperclip size={11} />
                          <span className="truncate">{file.fileName}</span>
                          <span className="font-mono tabular-nums text-muted-fg">
                            {Math.ceil(file.sizeBytes / 1024)} kB
                          </span>
                        </a>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ))}
            {messages.data && thread.length === 0 ? (
              <p className="py-16 text-center text-sm text-muted-fg">
                Nenhuma mensagem registrada ainda.
              </p>
            ) : null}
          </div>

          {error ? (
            <p role="alert" className="px-5 pb-1 text-sm text-negative">
              {error}
            </p>
          ) : null}

          {canWrite ? (
            <form
              className="border-t border-border px-5 py-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (draft.trim()) send.mutate('outbound');
              }}
            >
              {attachments.length > 0 ? (
                <ul className="mb-2 flex flex-wrap gap-1.5">
                  {attachments.map((file) => (
                    <li
                      key={file.id}
                      className="flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[11px]"
                    >
                      <Paperclip size={10} />
                      <span className="max-w-40 truncate">{file.fileName}</span>
                      <button
                        type="button"
                        aria-label={`Remover ${file.fileName}`}
                        onClick={() =>
                          setAttachments((current) => current.filter((f) => f.id !== file.id))
                        }
                      >
                        <X size={10} className="text-muted-fg hover:text-negative" />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              <div className="flex items-end gap-2">
                <textarea
                  className="min-h-[38px] flex-1 resize-y rounded-md border border-border bg-background px-3 py-2 text-[13px] outline-none focus:border-accent"
                  rows={1}
                  placeholder="Registrar mensagem…"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  aria-label="Corpo da mensagem"
                />
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={!draft.trim() || send.isPending || !selected.contactId}
                  onClick={() => send.mutate('inbound')}
                  title={
                    selected.contactId
                      ? 'Registrar como recebida do contato'
                      : 'Vincule um contato para registrar mensagens recebidas'
                  }
                >
                  Recebida
                </Button>
                <label className="cursor-pointer rounded px-2 py-1.5 text-muted-fg hover:bg-surface-2">
                  <Paperclip size={14} />
                  <span className="sr-only">Anexar arquivo</span>
                  <input
                    type="file"
                    className="hidden"
                    aria-label="Anexar arquivo"
                    disabled={attach.isPending || attachments.length >= 5}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) attach.mutate(file);
                      e.target.value = '';
                    }}
                  />
                </label>
                <Button
                  type="submit"
                  variant="primary"
                  size="sm"
                  disabled={!draft.trim() || send.isPending}
                >
                  <Send size={13} /> Enviada
                </Button>
              </div>
            </form>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-fg">
          Selecione uma conversa.
        </div>
      )}
    </div>
  );
}
