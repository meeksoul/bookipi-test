import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchSaleStatus, type SaleStatusView } from './api';

/**
 * Polls the sale status and exposes a ticking "server now" so countdowns are
 * based on the server clock rather than the user's (possibly wrong) clock.
 */
export function useSaleStatus(pollMs = 2_000) {
  const [sale, setSale] = useState<SaleStatusView | null>(null);
  const [error, setError] = useState(false);
  const [now, setNow] = useState(Date.now());
  const clockOffset = useRef(0);

  const refresh = useCallback(async () => {
    try {
      const status = await fetchSaleStatus();
      clockOffset.current = Date.parse(status.serverTime) - Date.now();
      setSale(status);
      setError(false);
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const poll = setInterval(refresh, pollMs);
    const tick = setInterval(() => setNow(Date.now() + clockOffset.current), 1_000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [refresh, pollMs]);

  return { sale, error, now, refresh };
}
