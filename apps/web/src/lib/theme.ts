import { useCallback, useEffect, useState } from 'react';

/**
 * Claro mineral é o PADRÃO (docs/DESIGN_DIRECTION.md §1); o escuro é uma
 * paleta noturna própria, não uma inversão. A preferência é estado de UI —
 * mora no localStorage, nunca no servidor e nunca junto de sessão (o token é
 * cookie httpOnly e não passa por aqui).
 */
export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'veyra:theme';

function read(): Theme {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle('dark', theme === 'dark');
  document.documentElement.style.colorScheme = theme;
}

/** Chamado antes do render para não piscar a paleta errada. */
export function bootstrapTheme() {
  applyTheme(read());
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(read);

  useEffect(() => {
    applyTheme(theme);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      /* modo privado: a preferência vale só para esta aba */
    }
  }, [theme]);

  const toggle = useCallback(() => setTheme((t) => (t === 'dark' ? 'light' : 'dark')), []);
  return { theme, toggle };
}
