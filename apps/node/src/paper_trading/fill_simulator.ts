import { SlippageModel } from './slippage_model';
import { consoleLog } from '../reporting/console_log';
import { logger } from '../reporting/logs';
import { OrderbookStream } from '../data/orderbook_stream';
import { ClobFetcher, OrderBookLevel } from '../data/clob_fetcher';

export class FillSimulator {
  private readonly fallbackSlippage = new SlippageModel();

  constructor(
    private readonly stream?: OrderbookStream,
    private readonly clobFetcher?: ClobFetcher
  ) { }

  async simulate(request: {
    marketId: string;
    outcome: 'YES' | 'NO';
    side: 'BUY' | 'SELL';
    price: number;
    size: number;
  }): Promise<{
    orderId: string;
    marketId: string;
    outcome: 'YES' | 'NO';
    side: 'BUY' | 'SELL';
    price: number;
    size: number;
    fee: number;
    feeAsset: 'USDC' | 'SHARES';
    timestamp: number;
  }> {
    // Artificial latency estimate:
    // RPC Network latency (~20ms) + Algorithm processing (~10ms) + Relayer/CLOB logic (~50ms)
    // We add some random jitter (±20ms) to simulate real-world network variance.
    const baseLatencyMs = 80;
    const jitterMs = Math.floor((Math.random() * 40) - 20);
    const latency = Math.max(10, baseLatencyMs + jitterMs);
    await new Promise((resolve) => setTimeout(resolve, latency));

    let finalPrice = request.price;
    let fallbackUsed = true;
    let actualSize = request.size;
    let fee = 0;
    let feeAsset: 'USDC' | 'SHARES' = request.side === 'BUY' ? 'SHARES' : 'USDC';

    // Attempt VWAP from real L2 book
    if (this.stream && this.clobFetcher) {
      const market = this.stream.getMarket(request.marketId);
      if (market && market.clobTokenIds.length > 0) {
        // Polymarket YES is always index 0, NO is index 1
        const tokenId = request.outcome === 'YES' ? market.clobTokenIds[0] : market.clobTokenIds[1];
        if (tokenId) {
          const [book, feeInfo] = await Promise.all([
            this.clobFetcher.fetchOrderBook(tokenId),
            this.clobFetcher.fetchFeeRate(tokenId)
          ]);

          if (book) {
            fallbackUsed = false;
            // For a BUY order, we lift the ASKs (sellers).
            // For a SELL order, we hit the BIDs (buyers).
            const levels = request.side === 'BUY' ? book.asks : book.bids;

            let executedSize = 0;
            let totalCost = 0;

            for (const level of levels) {
              const remainingVal = request.size - executedSize;
              if (remainingVal <= 0) break;

              const fillAmount = Math.min(remainingVal, level.size);
              executedSize += fillAmount;
              totalCost += fillAmount * level.price;
            }

            if (executedSize >= request.size) {
              finalPrice = totalCost / request.size;
            } else if (executedSize > 0) {
              // Partial fill based on available depth
              finalPrice = totalCost / executedSize;
              actualSize = executedSize;
              logger.warn({
                marketId: request.marketId,
                requested: request.size,
                filled: executedSize
              }, 'Partial paper fill due to insufficient L2 liquidity');
            } else {
              // Complete lack of liquidity
              logger.error({ marketId: request.marketId }, 'Zero liquidity for paper trade. Failing fill.');
              throw new Error(`Insufficient liquidity to paper trade ${request.size} ${request.outcome}`);
            }

            // Calculate precise maker/taker execution fee
            if (feeInfo && feeInfo.rate > 0) {
              const p = finalPrice;
              // fee = C * feeRate * (p * (1 - p))^exponent
              const rawFee = actualSize * feeInfo.rate * Math.pow(p * (1 - p), feeInfo.exponent);

              const minFeeThreshold = 0.0001; // Polymarket threshold
              if (rawFee >= minFeeThreshold) {
                // Round to 4 decimal places as per Polymarket docs
                fee = Math.round(rawFee * 10000) / 10000;
              }
            }
          }
        }
      }
    }

    if (fallbackUsed) {
      finalPrice = this.fallbackSlippage.apply(request.price, request.size, request.side);
    }

    const fill = {
      orderId: `paper-${Date.now()}`,
      marketId: request.marketId,
      outcome: request.outcome,
      side: request.side,
      price: Number(finalPrice.toFixed(4)),
      size: actualSize,
      fee,
      feeAsset,
      timestamp: Date.now(),
    };

    const slippageBps = Math.abs(fill.price - request.price) / request.price * 10000;
    consoleLog.info('FILL', `Paper fill: ${fill.side} ${fill.outcome} ×${fill.size} @ $${fill.price} (slip ${slippageBps.toFixed(1)} bps${fallbackUsed ? ' [MATH]' : ' [VWAP]'}) — ${fill.orderId}`, {
      orderId: fill.orderId,
      marketId: fill.marketId,
      outcome: fill.outcome,
      side: fill.side,
      requestedPrice: request.price,
      filledPrice: fill.price,
      size: fill.size,
      slippageBps: Number(slippageBps.toFixed(1)),
      cost: Number((fill.price * fill.size).toFixed(4)),
      vwap: !fallbackUsed,
    });

    return fill;
  }
}
