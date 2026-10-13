export type SaleStatus = 'upcoming' | 'active' | 'sold_out' | 'ended' | 'no_sale';

export interface SaleStatusView {
  saleId: string | null;
  status: SaleStatus;
  startsAt: string | null;
  endsAt: string | null;
  totalStock: number;
  stockRemaining: number;
  serverTime: string;
}

export type PurchaseOutcome =
  | 'SUCCESS'
  | 'ALREADY_PURCHASED'
  | 'SOLD_OUT'
  | 'NOT_STARTED'
  | 'ENDED'
  | 'NO_SALE'
  | 'INVALID_USER'
  | 'UNAVAILABLE';

export interface PurchaseResponse {
  outcome: PurchaseOutcome;
  message: string;
  purchasedAt: string | null;
}

export interface PurchaseLookup {
  userId: string;
  purchased: boolean;
  purchasedAt: string | null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function fetchSaleStatus(): Promise<SaleStatusView> {
  const res = await fetch('/api/sale');
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.json();
}

/**
 * Retries transient failures (503 / network) with jittered backoff. This is
 * safe because the server treats a repeat purchase by the same user as
 * ALREADY_PURCHASED rather than buying a second item.
 */
export async function purchase(userId: string, retries = 3): Promise<PurchaseResponse> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch('/api/purchases', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId }),
      });
      if (res.status === 400) {
        return { outcome: 'INVALID_USER', message: 'Use letters, numbers or . _ @ + - (max 128).', purchasedAt: null };
      }
      if (res.status < 500) return res.json();
    } catch {
      // network error: fall through to retry
    }
    if (attempt >= retries) {
      return { outcome: 'UNAVAILABLE', message: 'The store is very busy. Please try again.', purchasedAt: null };
    }
    await sleep(200 * 2 ** attempt + Math.random() * 200);
  }
}

export async function lookupPurchase(userId: string): Promise<PurchaseLookup> {
  const res = await fetch(`/api/purchases/${encodeURIComponent(userId)}`);
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.json();
}
