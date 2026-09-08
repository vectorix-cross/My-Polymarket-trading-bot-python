import { MarketFetcher } from './src/data/market_fetcher';

async function findFeeMarkets() {
    const fetcher = new MarketFetcher('https://gamma-api.polymarket.com', 400);
    const markets = await fetcher.fetchSnapshot();

    let found = 0;
    console.log(`Scanning ${markets.length} markets for fee rates...`);

    for (const m of markets) {
        const tokenId = m.clobTokenIds[0];
        if (!tokenId) continue;

        const url = `https://clob.polymarket.com/fee-rate?token_id=${tokenId}`;
        try {
            const res = await fetch(url);
            if (res.ok) {
                const data = await res.json();
                console.log(`[FEE MARKET] ${m.question}`);
                console.log(data);
                found++;
                if (found >= 5) break;
            }
        } catch (e) {
            // Ignore fetch errors
        }
    }

    console.log(`Found ${found} fee markets`);
}

findFeeMarkets().catch(console.error);
