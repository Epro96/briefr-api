// api/market.js — 시장 데이터 수집 전용 (AI 없음, 완전 무료)
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const to = ms => AbortSignal.timeout(ms);
  const live = {};

  // Yahoo Finance 시세
  const tickers = {
    KOSPI:'^KS11', KOSDAQ:'^KQ11', SP500:'^GSPC', NASDAQ:'^IXIC',
    NIKKEI:'^N225', SHANGHAI:'000001.SS', HANGSENG:'^HSI',
    VIX:'^VIX', MOVE:'^MOVE', US10Y:'^TNX', US2Y:'^IRX', US30Y:'^TYX',
    DXY:'DX-Y.NYB', USDKRW:'USDKRW=X', USDJPY:'USDJPY=X',
    EURUSD:'EURUSD=X', USDCNY:'USDCNY=X',
    GOLD:'GC=F', OIL:'CL=F', BRENT:'BZ=F', COPPER:'HG=F', SILVER:'SI=F', NATGAS:'NG=F',
  };

  await Promise.allSettled(Object.entries(tickers).map(async ([key, ticker]) => {
    try {
      const r = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=2d`,
        { headers:{'User-Agent':'Mozilla/5.0'}, signal:to(8000) }
      );
      if (!r.ok) return;
      const d = await r.json();
      const meta = d?.chart?.result?.[0]?.meta;
      if (!meta) return;
      const price = meta.regularMarketPrice;
      const prev = meta.chartPreviousClose || meta.previousClose || price;
      const chgPct = ((price - prev) / prev) * 100;
      const dec = ['KOSPI','NIKKEI','SHANGHAI','HANGSENG'].includes(key) ? 0 : 2;
      live[key] = {
        value: price.toLocaleString('ko-KR', { maximumFractionDigits: dec }),
        change: (chgPct >= 0 ? '+' : '') + chgPct.toFixed(2) + '%',
        changePct: parseFloat(chgPct.toFixed(2)),
        up: chgPct >= 0, raw: price, isReal: true,
      };
    } catch(e) {}
  }));

  // CoinGecko 암호화폐
  try {
    const r = await fetch(
      'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=10&page=1&price_change_percentage=24h',
      { signal: to(8000) }
    );
    if (r.ok) {
      const coins = await r.json();
      live.CRYPTO_LIST = coins.map(c => ({
        name: c.name, symbol: c.symbol?.toUpperCase(),
        value: '$' + (c.current_price||0).toLocaleString(),
        change: ((c.price_change_percentage_24h||0) >= 0 ? '+' : '') + (c.price_change_percentage_24h||0).toFixed(2) + '%',
        up: (c.price_change_percentage_24h||0) >= 0,
        raw: c.current_price, isReal: true,
      }));
    }
  } catch(e) {}

  // BTC 펀딩비
  try {
    const r = await fetch('https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT', { signal: to(6000) });
    if (r.ok) {
      const d = await r.json();
      if (d.lastFundingRate) {
        const rate = (parseFloat(d.lastFundingRate) * 100).toFixed(4);
        live.BTC_FUNDING = { value: rate + '%', raw: parseFloat(rate), isReal: true };
      }
    }
  } catch(e) {}

  // 공포탐욕지수
  try {
    const r = await fetch('https://api.alternative.me/fng/?limit=1', { signal: to(7000) });
    if (r.ok) {
      const d = await r.json();
      const item = d.data?.[0];
      if (item) live.FEAR_GREED = { value: parseInt(item.value), status: item.value_classification, isReal: true };
    }
  } catch(e) {}

  // 환율 백업
  if (!live.USDKRW) {
    try {
      const r = await fetch('https://open.er-api.com/v6/latest/USD', { signal: to(7000) });
      if (r.ok) {
        const d = await r.json();
        if (d.rates?.KRW) {
          live.USDKRW = { value: Math.round(d.rates.KRW).toLocaleString(), change:'±0.3%', up:false, raw:Math.round(d.rates.KRW), isReal:true };
        }
      }
    } catch(e) {}
  }

  return res.status(200).json(live);
}
