import { WalletState } from '../types';
import { computePerformance, PerformanceSnapshot } from './dashboard_api';

export type { PerformanceSnapshot };

export function computeAllPerformance(wallets: WalletState[]): PerformanceSnapshot[] {
  return wallets.map((w) => computePerformance(w, [], 0));
}
