import { useState, type FormEvent } from 'react';
import { lookupPurchase, purchase, type PurchaseOutcome, type SaleStatus, type SaleStatusView } from './api';
import { useSaleStatus } from './useSaleStatus';

const STATUS_LABELS: Record<SaleStatus, string> = {
  upcoming: 'Starting soon',
  active: 'Live now',
  sold_out: 'Sold out',
  ended: 'Ended',
  no_sale: 'No sale',
};

type Tone = 'success' | 'info' | 'error';

const OUTCOME_TONES: Record<PurchaseOutcome, Tone> = {
  SUCCESS: 'success',
  ALREADY_PURCHASED: 'info',
  SOLD_OUT: 'error',
  NOT_STARTED: 'info',
  ENDED: 'error',
  NO_SALE: 'error',
  INVALID_USER: 'error',
  UNAVAILABLE: 'error',
};

interface Feedback {
  tone: Tone;
  message: string;
}

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
}

function Countdown({ sale, now }: { sale: SaleStatusView; now: number }) {
  if (sale.status === 'upcoming' && sale.startsAt) {
    return <p className="countdown">Starts in <strong>{formatDuration(Date.parse(sale.startsAt) - now)}</strong></p>;
  }
  if (sale.status === 'active' && sale.endsAt) {
    return <p className="countdown">Ends in <strong>{formatDuration(Date.parse(sale.endsAt) - now)}</strong></p>;
  }
  return null;
}

function StockBar({ sale }: { sale: SaleStatusView }) {
  const pct = sale.totalStock === 0 ? 0 : (sale.stockRemaining / sale.totalStock) * 100;
  return (
    <div className="stock">
      <div className="stock-bar" role="progressbar" aria-valuenow={sale.stockRemaining} aria-valuemax={sale.totalStock}>
        <div className="stock-fill" style={{ width: `${pct}%` }} />
      </div>
      <span>{sale.stockRemaining} of {sale.totalStock} left</span>
    </div>
  );
}

export function App() {
  const { sale, error, now, refresh } = useSaleStatus();
  const [userId, setUserId] = useState(() => localStorage.getItem('flash-sale-user') ?? '');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  const trimmed = userId.trim();
  const canBuy = sale?.status === 'active' && trimmed !== '' && !busy;

  async function onBuy(event: FormEvent) {
    event.preventDefault();
    if (!canBuy) return;
    setBusy(true);
    setFeedback(null);
    localStorage.setItem('flash-sale-user', trimmed);
    try {
      const result = await purchase(trimmed);
      setFeedback({ tone: OUTCOME_TONES[result.outcome], message: result.message });
      void refresh();
    } finally {
      setBusy(false);
    }
  }

  async function onCheck() {
    if (!trimmed) return;
    setBusy(true);
    try {
      const result = await lookupPurchase(trimmed);
      setFeedback(
        result.purchased
          ? { tone: 'success', message: `${result.userId} secured an item at ${new Date(result.purchasedAt!).toLocaleTimeString()}.` }
          : { tone: 'info', message: `${result.userId} has not purchased an item.` },
      );
    } catch {
      setFeedback({ tone: 'error', message: 'Could not check your order. Please try again.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="page">
      <section className="card">
        <p className="eyebrow">Limited edition drop</p>
        <h1>Aurora Mechanical Keyboard</h1>

        {!sale && !error && <p className="muted">Loading sale…</p>}
        {error && !sale && <p className="muted">Can't reach the store right now. Retrying…</p>}

        {sale && (
          <>
            <div className="status-row">
              <span className={`badge badge-${sale.status}`} data-testid="sale-status">{STATUS_LABELS[sale.status]}</span>
              <Countdown sale={sale} now={now} />
            </div>
            {sale.status !== 'no_sale' && <StockBar sale={sale} />}
          </>
        )}

        <form onSubmit={onBuy} className="buy-form">
          <label htmlFor="userId">Username or email</label>
          <input
            id="userId"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            placeholder="you@example.com"
            maxLength={128}
            autoComplete="email"
          />
          <div className="actions">
            <button type="submit" disabled={!canBuy}>{busy ? 'Processing…' : 'Buy now'}</button>
            <button type="button" className="secondary" onClick={onCheck} disabled={!trimmed || busy}>
              Check my order
            </button>
          </div>
        </form>

        {feedback && (
          <div className={`feedback feedback-${feedback.tone}`} role="status">
            {feedback.message}
          </div>
        )}
      </section>
      <p className="footnote">One per customer · While stocks last</p>
    </main>
  );
}
