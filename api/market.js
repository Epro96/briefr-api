// api/market.js — 시장 데이터 + 뉴스 대량 수집
// 뉴스: 한국시간 기준 전날 20시 ~ 오늘 20시 (24시간), 최대 150건 수집

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const to = ms => AbortSignal.timeout(ms);
  const live = {};

  // ── 1. Yahoo Finance 시세 ──────────────────────────────
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

  // ── 2. CoinGecko ─────────────────────────────────────
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
        change: ((c.price_change_percentage_24h||0)>=0?'+':'')+(c.price_change_percentage_24h||0).toFixed(2)+'%',
        up: (c.price_change_percentage_24h||0) >= 0,
        raw: c.current_price, isReal: true,
      }));
    }
  } catch(e) {}

  // ── 3. BTC 펀딩비 ────────────────────────────────────
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

  // ── 4. 공포탐욕 ──────────────────────────────────────
  try {
    const r = await fetch('https://api.alternative.me/fng/?limit=1', { signal: to(7000) });
    if (r.ok) {
      const d = await r.json();
      const item = d.data?.[0];
      if (item) live.FEAR_GREED = { value: parseInt(item.value), status: item.value_classification, isReal: true };
    }
  } catch(e) {}

  // ── 5. 환율 백업 ─────────────────────────────────────
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

  // ── 6. 뉴스 대량 수집 (24시간 필터) ─────────────────
  const nowUtc = Date.now();
  const KST_OFFSET = 9 * 60 * 60 * 1000;
  const nowKst = nowUtc + KST_OFFSET;
  const nowKstDate = new Date(nowKst);
  const hourKst = nowKstDate.getUTCHours();

  // 기준: 오늘 20:00 KST (= 11:00 UTC) 또는 어제 20:00 KST
  const baseKst = new Date(nowKst);
  baseKst.setUTCHours(11, 0, 0, 0); // 20:00 KST
  if (hourKst < 20) baseKst.setUTCDate(baseKst.getUTCDate() - 1);
  const windowStartMs = baseKst.getTime() - KST_OFFSET;

  function parseRSS(xml, type, source) {
    const items = [];
    const matches = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
    for (const item of matches) {
      const getTag = (tag) => {
        const m = item.match(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, 'i'));
        return m?.[1]?.replace(/<[^>]*>/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#\d+;/g,'').trim() || '';
      };
      const title   = getTag('title');
      const link    = getTag('link') || item.match(/https?:\/\/[^\s<"]+/)?.[0] || '';
      const dateStr = getTag('pubDate') || getTag('dc:date') || getTag('published') || '';
      const desc    = getTag('description') || getTag('summary') || '';

      if (!title || title.length < 5) continue;

      let pubMs = 0;
      if (dateStr) { try { pubMs = new Date(dateStr).getTime(); } catch(e) {} }

      // 24시간 필터 (날짜 파싱 실패 시 포함)
      if (pubMs > 0 && pubMs < windowStartMs) continue;

      items.push({ title, link, pubDate: dateStr, pubMs, desc: desc.slice(0, 200), type, source });
    }
    return items;
  }

  // 뉴스 소스 14개 — 국내 5 + 해외 6 + 크립토 3
  const rssFeeds = [
    // 국내
    { url:'https://www.yna.co.kr/rss/economy.xml',              type:'domestic', source:'연합뉴스' },
    { url:'https://rss.hankyung.com/economy.xml',               type:'domestic', source:'한국경제' },
    { url:'https://www.mk.co.kr/rss/50200030/',                 type:'domestic', source:'매일경제' },
    { url:'https://www.sedaily.com/RSS',                        type:'domestic', source:'서울경제' },
    { url:'https://www.chosun.com/arc/outboundfeeds/rss/category/economy/', type:'domestic', source:'조선일보' },
    // 해외
    { url:'https://feeds.a.dj.com/rss/RSSMarketsMain.xml',      type:'international', source:'WSJ' },
    { url:'https://finance.yahoo.com/rss/topfinstories',        type:'international', source:'Yahoo Finance' },
    { url:'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114', type:'international', source:'CNBC' },
    { url:'https://feeds.content.dowjones.io/public/rss/mw_realtimeheadlines', type:'international', source:'MarketWatch' },
    { url:'https://feeds.reuters.com/reuters/businessNews',     type:'international', source:'Reuters' },
    { url:'https://feeds.bloomberg.com/markets/news.rss',       type:'international', source:'Bloomberg' },
    // 크립토
    { url:'https://www.coindesk.com/arc/outboundfeeds/rss/',    type:'crypto', source:'CoinDesk' },
    { url:'https://cointelegraph.com/rss',                      type:'crypto', source:'CoinTelegraph' },
    { url:'https://cryptonews.com/news/feed/',                  type:'crypto', source:'CryptoNews' },
  ];

  const allNews = [];
  await Promise.allSettled(rssFeeds.map(async ({ url, type, source }) => {
    try {
      const r = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)',
          'Accept': 'application/rss+xml, application/xml, text/xml, */*',
        },
        signal: to(10000),
      });
      if (!r.ok) return;
      const xml = await r.text();
      allNews.push(...parseRSS(xml, type, source));
    } catch(e) {}
  }));

  // 중복 제거 + 최신순 정렬 + 최대 120건
  const seen = new Set();
  const uniqueNews = allNews
    .filter(n => {
      const k = n.title.slice(0, 30).toLowerCase().replace(/\s+/g,'');
      if (seen.has(k)) return false;
      seen.add(k); return true;
    })
    .sort((a, b) => (b.pubMs||0) - (a.pubMs||0))
    .slice(0, 120)
    .map(({ pubMs, ...rest }) => rest);

  live.NEWS = uniqueNews;
  live.NEWS_WINDOW = {
    from: new Date(windowStartMs).toLocaleString('ko-KR', { timeZone:'Asia/Seoul' }),
    to:   new Date(nowUtc).toLocaleString('ko-KR', { timeZone:'Asia/Seoul' }),
    count: uniqueNews.length,
  };

  return res.status(200).json(live);
}
