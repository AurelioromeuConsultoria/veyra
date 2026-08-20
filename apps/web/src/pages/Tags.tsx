import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { tagColorSchema, type TagColor, type TagDto } from '@veyra/contracts';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../components/ui/button';
import { Input, Select } from '../components/ui/input';
import { TagBadge } from '../components/ui/tag-badge';
import { api, ApiError } from '../lib/api';
import { hasPermission, useSession } from '../lib/session';

const colors = tagColorSchema.options;

export function TagsPage() {
  const { data: user } = useSession();
  const canWrite = hasPermission(user, 'contacts:write');
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [color, setColor] = useState<TagColor>('slate');
  const [error, setError] = useState<string | null>(null);

  const tags = useQuery({ queryKey: ['tags'], queryFn: () => api.get<TagDto[]>('/api/tags') });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['tags'] });

  const create = useMutation({
    mutationFn: () => api.post<TagDto>('/api/tags', { name, color }),
    onSuccess: () => {
      setName('');
      setError(null);
      void invalidate();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Falha ao criar'),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete<{ ok: true }>(`/api/tags/${id}`),
    onSuccess: () => void invalidate(),
  });

  return (
    <div className="flex h-screen flex-col">
      <header className="border-b border-border px-5 py-3">
        <h1 className="text-sm font-semibold">Tags</h1>
        <p className="font-mono text-xs tabular-nums text-muted-fg">
          {tags.data?.length ?? 0} no total
        </p>
      </header>

      <div className="flex-1 overflow-auto p-5">
        {canWrite ? (
          <form
            className="mb-6 flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim()) create.mutate();
            }}
          >
            <div className="w-56">
              <Input
                placeholder="Nome da tag"
                value={name}
                onChange={(e) => setName(e.target.value)}
                aria-label="Nome da nova tag"
                maxLength={40}
              />
            </div>
            <Select
              className="w-36"
              value={color}
              onChange={(e) => setColor(e.target.value as TagColor)}
              aria-label="Cor da tag"
            >
              {colors.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </Select>
            <Button type="submit" variant="primary" disabled={create.isPending || !name.trim()}>
              <Plus size={14} /> Criar
            </Button>
            {error ? (
              <p role="alert" className="text-sm text-negative">
                {error}
              </p>
            ) : null}
          </form>
        ) : null}

        <table className="w-full max-w-2xl border-collapse text-[13px]">
          <thead>
            <tr className="border-b border-border">
              <th className="py-2 text-left text-[11px] font-medium uppercase tracking-wider text-muted-fg">
                Tag
              </th>
              <th className="py-2 text-left text-[11px] font-medium uppercase tracking-wider text-muted-fg">
                Em uso
              </th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(tags.data ?? []).map((tag) => (
              <tr key={tag.id} className="border-b border-border/60">
                <td className="py-2">
                  <TagBadge name={tag.name} color={tag.color} />
                </td>
                <td className="py-2 font-mono text-xs tabular-nums text-muted-fg">
                  {tag.usageCount}
                </td>
                <td className="py-2 text-right">
                  {canWrite ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Excluir tag ${tag.name}`}
                      onClick={() => {
                        if (window.confirm(`Excluir a tag "${tag.name}"?`)) remove.mutate(tag.id);
                      }}
                    >
                      <Trash2 size={14} />
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
            {tags.data && tags.data.length === 0 ? (
              <tr>
                <td colSpan={3} className="py-10 text-center text-sm text-muted-fg">
                  Nenhuma tag ainda.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
