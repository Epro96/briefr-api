export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const tickers = {
    KOSPI:  '^KS11',
    KOSDAQ: '^KQ11',
    SP500:  '^GSPC',
    NASDAQ: '^IXIC',
    VIX:    '^VIX',
  };

  const results = {};

  await Promise.allSettled(
    Object.entries(tickers).map(async ([name, ticker]) => {
      try {
        const url =
          'https://query1.finance.yahoo.com/v8/finance/chart/' +
          encodeURIComponent(ticker) +
          '?interval=1d&range=2d';

        const r = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0' },
          signal: AbortSignal.timeout(8000),
        });

        if (!r.ok) throw new Error('HTTP ' + r.status);

        const data = await r.json();
        const meta = data?.chart?.result?.[0]?.meta;
        if (!meta) throw new Error('데이터 없음');

        const price   = meta.regularMarketPrice;
        const prev    = meta.chartPreviousClose || meta.previousClose;
        const chgPct  = (((price - prev) / prev) * 100).toFixed(2);
        const decimals = name === 'KOSPI' ? 0 : name === 'KOSDAQ' ? 2 : 2;

        results[name] = {
          name:      name === 'SP500' ? 'S&P 500' : name,
          value:     price.toLocaleString('ko-KR', { maximumFractionDigits: decimals }),
          change:    (parseFloat(chgPct) >= 0 ? '+' : '') + chgPct + '%',
          changePct: parseFloat(chgPct),
          up:        parseFloat(chgPct) >= 0,
          raw:       price,
          isReal:    true,
        };
      } catch (e) {
        results[name] = { name, error: e.message, isReal: false };
      }
    })
  );

  return res.status(200).json({
    ...results,
    updatedAt: new Date().toISOString(),
  });
}
