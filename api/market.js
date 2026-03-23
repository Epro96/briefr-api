export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const result = {
    KOSPI: null, KOSDAQ: null, SP500: null,
    NASDAQ: null, VIX: null,
    BTC: null, ETH: null,
    fearGreed: null, usdKrw: null,
    updatedAt: new Date().toISOString(),
  };

  // 1. 주가 지수 — Yahoo Finance
  const indexMap = {
    KOSPI: '^KS11', KOSDAQ: '^KQ11',
    SP500: '^GSPC', NASDAQ: '^IXIC', VIX: '^VIX',
  };

  await Promise.allSettled(
    Object.entries(indexMap).map(async ([key, ticker]) => {
      try {
        const r = await fetch(
          'https://query1.finance.yahoo.com/v8/finance/chart/' +
          encodeURIComponent(ticker) + '?interval=1d&range=2d',
          {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            signal: AbortSignal.timeout(8000),
          }
        );
        if (!r.ok) return;
        const data = await r.json();
        const meta = data?.chart?.result?.[0]?.meta;
        if (!meta) return;
        const price  = meta.regularMarketPrice;
        const prev   = meta.chartPreviousClose || meta.previousClose || price;
        const chgPct = ((price - prev) / prev) * 100;
        result[key] = {
          name:      key === 'SP500' ? 'S&P 500' : key,
          value:     price.toLocaleString('ko-KR', { maximumFractionDigits: key === 'KOSPI' ? 0 : 2 }),
          change:    (chgPct >= 0 ? '+' : '') + chgPct.toFixed(2) + '%',
          changePct: parseFloat(chgPct.toFixed(2)),
          up:        chgPct >= 0,
          raw:       price,
          isReal:    true,
        };
      } catch (e) {}
    })
  );

  // 2. 비트코인 · 이더리움 — CoinGecko
  try {
    const r = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd&include_24hr_change=true',
      { signal: AbortSignal.timeout(8000) }
    );
    if (r.ok) {
      const d = await r.json();
      if (d.bitcoin) {
        const chg = d.bitcoin.usd_24h_change || 0;
        result.BTC = {
          name: 'BTC/USD', value: '$' + d.bitcoin.usd.toLocaleString(),
          change: (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%',
          up: chg >= 0, raw: d.bitcoin.usd, isReal: true,
        };
      }
      if (d.ethereum) {
        const chg = d.ethereum.usd_24h_change || 0;
        result.ETH = {
          name: 'ETH/USD', value: '$' + d.ethereum.usd.toLocaleString(),
          change: (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%',
          up: chg >= 0, raw: d.ethereum.usd, isReal: true,
        };
      }
    }
  } catch (e) {}

  // 3. 공포탐욕지수 — Alternative.me
  try {
    const r = await fetch('https://api.alternative.me/fng/?limit=1',
      { signal: AbortSignal.timeout(8000) });
    if (r.ok) {
      const d = await r.json();
      const item = d.data?.[0];
      if (item) result.fearGreed = {
        value: parseInt(item.value),
        status: item.value_classification,
        isReal: true,
      };
    }
  } catch (e) {}

  // 4. 달러/원 환율 — ExchangeRate API
  try {
    const r = await fetch('https://open.er-api.com/v6/latest/USD',
      { signal: AbortSignal.timeout(8000) });
    if (r.ok) {
      const d = await r.json();
      if (d.rates?.KRW) {
        const krw = Math.round(d.rates.KRW);
        result.usdKrw = {
          name: 'USD/KRW', value: krw.toLocaleString() + '원',
          change: '±0.3%', up: false, raw: krw, isReal: true,
        };
      }
    }
  } catch (e) {}

  return res.status(200).json(result);
}
