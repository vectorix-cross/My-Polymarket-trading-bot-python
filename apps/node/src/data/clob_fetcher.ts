import { logger } from '../reporting/logs';

export interface OrderBookLevel {
    price: number;
    size: number;
}

export interface OrderBook {
    bids: OrderBookLevel[];
    asks: OrderBookLevel[];
}

export class ClobFetcher {
    private readonly clobApi: string;
    private readonly feeRateCache: Map<string, { rate: number; exponent: number }>;

    constructor(clobApi = 'https://clob.polymarket.com') {
        this.clobApi = clobApi;
        this.feeRateCache = new Map();
    }

    /**
     * Fetches the real-time Level 2 order book for a given CLOB token ID.
     * Both bids and asks are returned sorted by best price first:
     *  - bids: descending (highest price first)
     *  - asks: ascending (lowest price first)
     */
    async fetchOrderBook(clobTokenId: string): Promise<OrderBook | null> {
        const url = `${this.clobApi}/book?token_id=${clobTokenId}`;

        try {
            const response = await fetch(url);
            if (!response.ok) {
                logger.warn({ status: response.status, clobTokenId }, 'CLOB /book request failed');
                return null;
            }

            const data = await response.json() as {
                bids: Array<{ price: string; size: string }>;
                asks: Array<{ price: string; size: string }>;
            };

            const bids = (data.bids || [])
                .map(level => ({
                    price: parseFloat(level.price),
                    size: parseFloat(level.size),
                }))
                // Ensure strictly descending for bids (best bid at index 0)
                .sort((a, b) => b.price - a.price);

            const asks = (data.asks || [])
                .map(level => ({
                    price: parseFloat(level.price),
                    size: parseFloat(level.size),
                }))
                // Ensure strictly ascending for asks (best ask at index 0)
                .sort((a, b) => a.price - b.price);

            return { bids, asks };
        } catch (error) {
            logger.error({ error, clobTokenId }, 'Failed to fetch order book');
            return null;
        }
    }

    /**
     * Resolves the taker fee parameters for a given market token.
     * Caches the result to avoid spamming the Polymarket `/fee-rate` endpoint.
     */
    async fetchFeeRate(clobTokenId: string): Promise<{ rate: number; exponent: number }> {
        if (this.feeRateCache.has(clobTokenId)) {
            return this.feeRateCache.get(clobTokenId)!;
        }

        const url = `${this.clobApi}/fee-rate?token_id=${clobTokenId}`;
        try {
            const response = await fetch(url);
            if (!response.ok) {
                // Return 0 fees by default if the endpoint 404s or fails
                const defaultFee = { rate: 0, exponent: 0 };
                this.feeRateCache.set(clobTokenId, defaultFee);
                return defaultFee;
            }

            const data = await response.json() as { fee_rate: string; fee_exponent: string };
            const rate = parseFloat(data.fee_rate || '0');
            const exponent = parseFloat(data.fee_exponent || '0');

            const feeInfo = { rate, exponent };
            this.feeRateCache.set(clobTokenId, feeInfo);
            return feeInfo;
        } catch (error) {
            logger.error({ error, clobTokenId }, 'Failed to fetch fee rate');
            const defaultFee = { rate: 0, exponent: 0 };
            this.feeRateCache.set(clobTokenId, defaultFee);
            return defaultFee;
        }
    }
}
