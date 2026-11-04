/**
 * A marca do Veyra na moldura (ADR-062): o ladrilho do "V" de peso assimétrico
 * — braço esquerdo cheio, direito em hairline, o mesmo desenho do
 * `public/favicon.svg` — mais o nome do produto em display. Sobre a moldura
 * escura vale a variante NOTURNA da marca (ladrilho recalibrado, tinta
 * escura): o ladrilho verde-abissal sumiria no fundo verde.
 */
export function Marca({
  nome,
  subtitulo,
  tom = 'noite',
}: {
  nome: string;
  subtitulo?: string;
  /** `dia` sobre superfície clara (o ladrilho verde-abissal, tinta clara) */
  tom?: 'noite' | 'dia';
}) {
  const dia = tom === 'dia';
  return (
    <div className="flex items-center gap-2.5">
      <svg
        role="img"
        aria-label="Veyra"
        width="30"
        height="30"
        viewBox="0 0 32 32"
        className="shrink-0"
      >
        <rect width="32" height="32" rx="7.5" fill={dia ? '#1c5a56' : '#2f8079'} />
        <g
          fill="none"
          stroke={dia ? '#f6f3ed' : '#08100f'}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M9.6 8.6 L16 23.4" strokeWidth="4.2" />
          <path d="M16 23.4 L22.4 8.6" strokeWidth="1.7" />
        </g>
      </svg>
      <div className="min-w-0 leading-tight">
        <span
          className={`block truncate font-display text-[16px] font-semibold tracking-[-0.01em] ${dia ? 'text-foreground' : 'text-white'}`}
        >
          {nome}
        </span>
        {subtitulo ? (
          <span
            className={`block truncate text-[12px] ${dia ? 'text-muted-fg' : 'text-frame-muted'}`}
          >
            {subtitulo}
          </span>
        ) : null}
      </div>
    </div>
  );
}
