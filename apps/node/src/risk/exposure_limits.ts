import { RiskLimits } from '../types';

export const DEFAULT_LIMITS: RiskLimits = {
  maxPositionSize: 100,
  maxExposurePerMarket: 200,
  maxDailyLoss: 100,
  maxOpenTrades: 5,
  maxDrawdown: 0.2,
};
