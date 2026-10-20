import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import './index.css';
import { SessionQueryProvider } from './lib/session-query';
import { bootstrapTheme } from './lib/theme';

// aplica a paleta escolhida ANTES do primeiro render: sem isto, a tela pisca
// clara antes de virar escura para quem escolheu o noturno
bootstrapTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* um cache por sessão (ADR-050): a troca de sessão remonta o que está abaixo */}
    <SessionQueryProvider>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </SessionQueryProvider>
  </StrictMode>,
);
