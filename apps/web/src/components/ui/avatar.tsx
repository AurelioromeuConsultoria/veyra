import { clsx } from 'clsx';

/**
 * Pessoas com rosto (ADR-062): iniciais sobre uma cor ESTÁVEL por pessoa — o
 * mesmo nome tem a mesma cor em toda tela. A paleta é fechada e cada par
 * passa 4.5:1; a cor identifica, não comunica estado (estado é o `StatusChip`).
 */
const PARES = [
  ['#e5dcf5', '#4b2e83'],
  ['#dcebf7', '#1f4f8f'],
  ['#e3f1e8', '#21653f'],
  ['#f7e2d6', '#8a3f14'],
  ['#f5dfe6', '#86294a'],
  ['#dcede9', '#15433f'],
  ['#f1e3d3', '#6b3d12'],
  ['#e9e6df', '#3e4540'],
] as const;

export function iniciais(nome: string | null | undefined): string {
  if (!nome) return '—';
  // o tratamento (Dra., Dr., Sr., Sra.) não é inicial de ninguém
  const partes = nome
    .trim()
    .split(/\s+/)
    .filter((p) => p && !/^(dra?|sra?)\.?$/i.test(p));
  if (partes.length === 0) return '—';
  const primeira = partes[0]?.[0] ?? '';
  const ultima = partes.length > 1 ? (partes.at(-1)?.[0] ?? '') : '';
  return (primeira + ultima).toUpperCase();
}

function parDe(chave: string) {
  let h = 0;
  for (const c of chave) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PARES[h % PARES.length];
}

const TAMANHOS = {
  sm: 'h-7 w-7 text-[11px]',
  md: 'h-9 w-9 text-[12.5px]',
  lg: 'h-12 w-12 text-[15px]',
  xl: 'h-16 w-16 text-[22px] font-display',
} as const;

export function Avatar({
  nome,
  chave,
  tamanho = 'md',
  className,
}: {
  nome: string | null | undefined;
  /** o que fixa a cor (o id da pessoa); sem ele, o próprio nome */
  chave?: string;
  tamanho?: keyof typeof TAMANHOS;
  className?: string;
}) {
  const [fundo, tinta] = parDe(chave ?? nome ?? '');
  return (
    <span
      aria-hidden
      style={{ backgroundColor: fundo, color: tinta }}
      className={clsx(
        'inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold',
        TAMANHOS[tamanho],
        className,
      )}
    >
      {iniciais(nome)}
    </span>
  );
}
