import { render, screen } from '@testing-library/react';
import { App } from './App';

describe('App', () => {
  it('renderiza o shell da fundação', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: 'Veyra' })).toBeInTheDocument();
  });
});
