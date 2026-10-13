import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

const HOUR = 60 * 60 * 1000;

function saleStatus(status: string, stockRemaining = 5) {
  return {
    saleId: 'launch',
    status,
    startsAt: new Date(Date.now() - HOUR).toISOString(),
    endsAt: new Date(Date.now() + HOUR).toISOString(),
    totalStock: 10,
    stockRemaining,
    serverTime: new Date().toISOString(),
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function mockApi(routes: { sale?: unknown; purchase?: () => Response; lookup?: unknown }) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/sale') return json(200, routes.sale ?? saleStatus('active'));
    if (url === '/api/purchases' && init?.method === 'POST') return routes.purchase!();
    if (url.startsWith('/api/purchases/')) return json(200, routes.lookup);
    throw new Error(`unexpected ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('App', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the sale status and remaining stock', async () => {
    mockApi({ sale: saleStatus('active', 3) });
    render(<App />);

    expect(await screen.findByTestId('sale-status')).toHaveTextContent('Live now');
    expect(screen.getByText('3 of 10 left')).toBeInTheDocument();
  });

  it('disables Buy now until the sale is active and a user id is entered', async () => {
    mockApi({ sale: saleStatus('active') });
    render(<App />);
    const button = await screen.findByRole('button', { name: 'Buy now' });

    expect(button).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Username or email'), 'alice');
    expect(button).toBeEnabled();
  });

  it('keeps Buy now disabled when sold out', async () => {
    mockApi({ sale: saleStatus('sold_out', 0) });
    render(<App />);
    await screen.findByText('Sold out');
    await userEvent.type(screen.getByLabelText('Username or email'), 'alice');

    expect(screen.getByRole('button', { name: 'Buy now' })).toBeDisabled();
  });

  it.each([
    [201, 'SUCCESS', 'Congratulations! You secured an item.'],
    [409, 'ALREADY_PURCHASED', 'You have already purchased this item.'],
    [410, 'SOLD_OUT', 'Sorry, the item is sold out.'],
  ])('shows feedback for HTTP %i (%s)', async (status, outcome, message) => {
    mockApi({ purchase: () => json(status, { outcome, message, purchasedAt: null }) });
    render(<App />);
    await screen.findByText('Live now');

    await userEvent.type(screen.getByLabelText('Username or email'), 'alice');
    await userEvent.click(screen.getByRole('button', { name: 'Buy now' }));

    expect(await screen.findByRole('status')).toHaveTextContent(message);
  });

  it('retries a purchase after a 503', async () => {
    let calls = 0;
    mockApi({
      purchase: () =>
        ++calls === 1
          ? json(503, { error: 'SERVICE_UNAVAILABLE' })
          : json(201, { outcome: 'SUCCESS', message: 'Congratulations! You secured an item.', purchasedAt: null }),
    });
    render(<App />);
    await screen.findByText('Live now');

    await userEvent.type(screen.getByLabelText('Username or email'), 'alice');
    await userEvent.click(screen.getByRole('button', { name: 'Buy now' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Congratulations'), { timeout: 2_000 });
    expect(calls).toBe(2);
  });

  it('checks whether the user already has an item', async () => {
    mockApi({ lookup: { userId: 'alice', purchased: false, purchasedAt: null } });
    render(<App />);
    await screen.findByText('Live now');

    await userEvent.type(screen.getByLabelText('Username or email'), 'alice');
    await userEvent.click(screen.getByRole('button', { name: 'Check my order' }));

    expect(await screen.findByRole('status')).toHaveTextContent('alice has not purchased an item.');
  });
});
