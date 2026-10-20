import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import { reiniciarSessaoParaTestes } from '../lib/session-scope';

afterEach(() => {
  cleanup();
  // o escopo da sessão é do módulo (ADR-050): cada teste começa com a aba recém-aberta
  reiniciarSessaoParaTestes();
});
