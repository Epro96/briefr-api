// api/report.js — Briefr 2.0
// 철학: 최대한 많이 수집 → AI가 중요도 순 정렬

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY 없음' });

  const to = (ms) => AbortSignal.timeout(ms);
  const live = {};

  // ── 1. 시세 데이터 (Yahoo Finance) ───────────────────────
  const tickers = {
    KOSPI:'^KS11', KOSDAQ:'^KQ11', SP500:'^GSPC', NASDAQ:'^IXIC',
    NIKKEI:'^N225', SHANGHAI:'000001.SS', HANGSENG:'^HSI',
    VIX:'^VIX', MOVE:'^MOVE',
    US10Y:'^TNX', US2Y:'^IRX', US30Y:'^TYX',
    DXY:'DX-Y.NYB',
    USDKRW:'USDKRW=X', USDJPY:'USDJPY=X', EURUSD:'EURUSD=X', USDCNY:'USDCNY=X',
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
      const prev  = meta.chartPreviousClose || meta.previousClose || price;
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

  // ── 2. 암호화폐 (CoinGecko — 상위 10개) ─────────────────
  try {
    const r = await fetch(
      'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=10&page=1&price_change_percentage=24h',
      { signal: to(8000) }
    );
    if (r.ok) {
      const coins = await r.json();
      const keyMap = { bitcoin:'BTC', ethereum:'ETH', solana:'SOL', ripple:'XRP', 'binancecoin':'BNB', dogecoin:'DOGE', cardano:'ADA', avalanche:'AVAX', polkadot:'DOT', chainlink:'LINK' };
      coins.forEach(c => {
        const key = keyMap[c.id] || c.symbol?.toUpperCase();
        if (!key) return;
        const chg = c.price_change_percentage_24h || 0;
        live['CRYPTO_' + key] = {
          name: c.name, symbol: key,
          value: '$' + c.current_price.toLocaleString(),
          change: (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%',
          up: chg >= 0, raw: c.current_price,
          marketCap: c.market_cap, isReal: true,
        };
      });
    }
  } catch(e) {}

  // ── 3. BTC 펀딩비 + 청산 데이터 ──────────────────────────
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

  // ── 4. 공포탐욕지수 ──────────────────────────────────────
  try {
    const r = await fetch('https://api.alternative.me/fng/?limit=7', { signal: to(7000) });
    if (r.ok) {
      const d = await r.json();
      const items = d.data || [];
      if (items[0]) live.FEAR_GREED = { value: parseInt(items[0].value), status: items[0].value_classification, isReal: true };
      live.FEAR_GREED_HISTORY = items.slice(0,7).map(i => ({ value: parseInt(i.value), status: i.value_classification, timestamp: i.timestamp }));
    }
  } catch(e) {}

  // ── 5. 환율 백업 ─────────────────────────────────────────
  if (!live.USDKRW?.isReal) {
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

  // ── 6. 뉴스 대량 수집 (RSS 9개 소스) ─────────────────────
  const rssFeeds = [
    // 국내
    { url:'https://www.yna.co.kr/rss/economy.xml',           type:'domestic', source:'연합뉴스' },
    { url:'https://rss.hankyung.com/economy.xml',            type:'domestic', source:'한국경제' },
    { url:'https://www.mk.co.kr/rss/50200030/',              type:'domestic', source:'매일경제' },
    { url:'https://www.sedaily.com/RSS',                     type:'domestic', source:'서울경제' },
    // 해외
    { url:'https://finance.yahoo.com/rss/topfinstories',     type:'international', source:'Yahoo Finance' },
    { url:'https://feeds.a.dj.com/rss/RSSMarketsMain.xml',   type:'international', source:'WSJ' },
    { url:'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114', type:'international', source:'CNBC' },
    // 크립토
    { url:'https://www.coindesk.com/arc/outboundfeeds/rss/', type:'crypto', source:'CoinDesk' },
    { url:'https://cointelegraph.com/rss',                   type:'crypto', source:'CoinTelegraph' },
  ];

  const rawNews = [];
  await Promise.allSettled(rssFeeds.map(async ({ url, type, source }) => {
    try {
      const apiUrl = `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(url)}&count=8`;
      const r = await fetch(apiUrl, { signal: to(9000) });
      if (!r.ok) return;
      const d = await r.json();
      if (d.status !== 'ok' && d.status !== 'error') return;
      (d.items || []).forEach(item => {
        const title = (item.title || '').replace(/<[^>]*>/g,'').trim();
        if (!title || title.length < 5) return;
        rawNews.push({
          title,
          link:    item.link || item.url || '',
          pubDate: item.pubDate || item.published || '',
          type, source,
        });
      });
    } catch(e) {}
  }));

  // 중복 제거 (제목 기준)
  const seen = new Set();
  const uniqueNews = rawNews.filter(n => {
    const key = n.title.slice(0,30);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
  live.RAW_NEWS = uniqueNews.slice(0, 40); // 최대 40개 수집

  // ── 7. 컨텍스트 구성 ─────────────────────────────────────
  const today = new Date().toLocaleDateString('ko-KR', { year:'numeric', month:'long', day:'numeric', weekday:'long' });
  const M = (k,l) => live[k] ? `${l} ${live[k].value}(${live[k].change})` : null;

  const cryptoLines = ['BTC','ETH','SOL','XRP','BNB','DOGE'].map(s => {
    const c = live['CRYPTO_' + s];
    return c ? `${s} ${c.value}(${c.change})` : null;
  }).filter(Boolean);

  const ctx = [
    `날짜: ${today}`,
    '',
    '[주식]',
    M('KOSPI','KOSPI'), M('KOSDAQ','KOSDAQ'), M('SP500','S&P500'), M('NASDAQ','NASDAQ'), M('NIKKEI','닛케이'), M('SHANGHAI','상하이'), M('HANGSENG','항셍'),
    '',
    '[채권·금리]',
    M('US10Y','미10년'), M('US2Y','미2년'), M('US30Y','미30년'),
    live.US10Y && live.US2Y ? `장단기스프레드 ${(live.US10Y.raw - live.US2Y.raw).toFixed(2)}%` : null,
    '',
    '[환율·원자재]',
    M('USDKRW','달러원'), M('USDJPY','달러엔'), M('EURUSD','유로달러'), M('USDCNY','달러위안'), M('DXY','DXY'),
    M('GOLD','금'), M('OIL','WTI'), M('BRENT','브렌트'), M('COPPER','구리'), M('SILVER','은'), M('NATGAS','천연가스'),
    '',
    '[변동성·심리]',
    M('VIX','VIX'), M('MOVE','MOVE'),
    live.FEAR_GREED ? `공포탐욕지수 ${live.FEAR_GREED.value}점(${live.FEAR_GREED.status})` : null,
    live.BTC_FUNDING ? `BTC펀딩비 ${live.BTC_FUNDING.value}` : null,
    '',
    '[암호화폐]',
    ...cryptoLines,
    '',
    '[뉴스 헤드라인 전체]',
    ...live.RAW_NEWS.map((n,i) => `${i}.[${n.source}] ${n.title}`),
  ].filter(Boolean).join('\n');

  // ── 8. Claude AI 분석 ─────────────────────────────────────
  let analysis = null;
  let claudeError = null;

  const newsCount = live.RAW_NEWS.length;
  const summaryTemplate = live.RAW_NEWS.map((_,i) =>
    `{"index":${i},"summary":"2문장요약","category":"카테고리","importance":"high또는medium또는low"}`
  ).join(',\n    ');

  try {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4000,
        messages: [{
          role: 'user',
          content: `당신은 전문 투자 애널리스트입니다. 아래 실시간 데이터를 분석해서 데일리 브리핑 JSON을 작성하세요.

${ctx}

중요: 뉴스는 ${newsCount}개 전부 요약하고, 중요도를 high/medium/low로 분류하세요.
경제지표 캘린더는 오늘부터 7일간 최대한 많이 (10개 이상), 기업 실적은 이번주 주요 기업 최대한 많이 (국내+해외 15개 이상) 작성하세요.
모든 항목은 중요도가 높은 것이 먼저 오도록 정렬하세요.

순수 JSON만 출력. 마크다운 없이:
{
  "headline": "오늘 시장 20자 핵심",
  "sentiment": "강세또는약세또는중립또는주의",
  "sentimentReason": "근거 한줄",
  "riskLevel": "리스크 온또는중립또는리스크 오프",
  "riskReason": "근거 한줄",
  "strategy": "오늘 투자 전략 한줄",
  "sectorAnalysis": "섹터 동향 3줄",
  "cryptoAnalysis": "크립토 시장 분석 2줄",
  "bondAnalysis": "채권·금리 분석 2줄",
  "fxAnalysis": "환율·원자재 분석 2줄",
  "volatilityAnalysis": "변동성 분석 2줄",
  "calendar": [
    {"date":"날짜","event":"이벤트","importance":"high","description":"예상치 포함 설명","country":"US또는KR또는EU"}
  ],
  "earnings": [
    {"company":"기업명","ticker":"티커","market":"US또는KR","date":"날짜","epsEstimate":"예상EPS","revenueEstimate":"예상매출","result":"예정또는발표","signal":"upcoming또는beat또는miss또는meet","importance":"high또는medium"}
  ],
  "brokerageReports": [
    {"company":"기업명","ticker":"티커","broker":"증권사","rating":"매수또는중립또는매도","targetPrice":"목표가","prevTarget":"이전목표가","change":"상향또는하향또는유지","summary":"한줄요약","importance":"high또는medium"}
  ],
  "newsSummaries": [
    ${summaryTemplate}
  ],
  "keyPoints": ["인사이트1","인사이트2","인사이트3","인사이트4","인사이트5"],
  "watchout": "주목할 리스크 한줄",
  "tomorrowFocus": "내일 주목 이벤트 한줄"
}`,
        }],
      }),
      signal: to(55000),
    });

    if (claudeRes.ok) {
      const d = await claudeRes.json();
      if (d.error) {
        claudeError = d.error.message;
      } else {
        const raw = (d.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('');
        const clean = raw.replace(/```json|```/gi,'').trim();
        const s = clean.indexOf('{'), e = clean.lastIndexOf('}');
        if (s>-1 && e>s) {
          try { analysis = JSON.parse(clean.slice(s,e+1)); } catch(err) { claudeError = 'JSON 파싱 실패'; }
        }
      }
    } else {
      const errText = await claudeRes.text().catch(()=>'');
      try { claudeError = JSON.parse(errText).error?.message || `HTTP ${claudeRes.status}`; }
      catch(e) { claudeError = `HTTP ${claudeRes.status}`; }
    }
  } catch(e) {
    claudeError = e.message || 'Claude 연결 실패';
  }

  if (!analysis) {
    analysis = {
      headline:'시장 데이터 수집 완료', sentiment:'중립',
      sentimentReason: claudeError || 'AI 분석 실패',
      riskLevel:'중립', riskReason:'AI 분석 실패',
      strategy:'AI 분석 실패 — 잠시 후 다시 시도해주세요',
      sectorAnalysis:'AI 분석 실패', cryptoAnalysis:'AI 분석 실패',
      bondAnalysis:'AI 분석 실패', fxAnalysis:'AI 분석 실패',
      volatilityAnalysis:'AI 분석 실패',
      calendar:[], earnings:[], brokerageReports:[], newsSummaries:[],
      keyPoints:[claudeError||'AI 분석 실패'], watchout:'AI 분석 실패', tomorrowFocus:'AI 분석 실패',
    };
  }

  // ── 9. 뉴스 + AI요약 결합 → 중요도 순 정렬 ──────────────
  const enrichedNews = live.RAW_NEWS.map((n, i) => {
    const s = analysis.newsSummaries?.find(x => x.index === i);
    return { ...n, summary: s?.summary||'', category: s?.category||'일반', importance: s?.importance||'medium' };
  }).sort((a,b) => {
    const order = { high:0, medium:1, low:2 };
    return (order[a.importance]||1) - (order[b.importance]||1);
  });

  // 기업실적 중요도 순 정렬
  const sortedEarnings = (analysis.earnings||[]).sort((a,b) => {
    const order = { high:0, medium:1, low:2 };
    return (order[a.importance]||1) - (order[b.importance]||1);
  });

  // 증권사 리포트 중요도 순 정렬
  const sortedBrokerage = (analysis.brokerageReports||[]).sort((a,b) => {
    const order = { high:0, medium:1, low:2 };
    return (order[a.importance]||1) - (order[b.importance]||1);
  });

  // 캘린더 중요도 순 정렬
  const sortedCalendar = (analysis.calendar||[]).sort((a,b) => {
    const order = { high:0, medium:1, low:2 };
    return (order[a.importance]||1) - (order[b.importance]||1);
  });

  // ── 10. 크립토 배열 구성 ─────────────────────────────────
  const cryptoList = ['BTC','ETH','SOL','XRP','BNB','DOGE','ADA','AVAX','DOT','LINK']
    .map(s => live['CRYPTO_' + s])
    .filter(Boolean);

  // ── 11. 최종 응답 ─────────────────────────────────────────
  return res.status(200).json({
    date: today,
    generatedAt: new Date().toISOString(),
    claudeError: claudeError || null,
    newsCount: enrichedNews.length,

    headline:        analysis.headline,
    sentiment:       analysis.sentiment,
    sentimentReason: analysis.sentimentReason,
    riskLevel:       analysis.riskLevel,
    riskReason:      analysis.riskReason,
    strategy:        analysis.strategy,

    stocks: {
      KOSPI:live.KOSPI, KOSDAQ:live.KOSDAQ, SP500:live.SP500, NASDAQ:live.NASDAQ,
      NIKKEI:live.NIKKEI, SHANGHAI:live.SHANGHAI, HANGSENG:live.HANGSENG,
      analysis: analysis.sectorAnalysis,
    },
    crypto: {
      list:        cryptoList,
      fundingRate: live.BTC_FUNDING,
      fearGreed:   live.FEAR_GREED,
      fearGreedHistory: live.FEAR_GREED_HISTORY || [],
      analysis:    analysis.cryptoAnalysis,
    },
    bonds: {
      US10Y:live.US10Y, US2Y:live.US2Y, US30Y:live.US30Y,
      spread: (live.US10Y && live.US2Y) ? {
        value: (live.US10Y.raw - live.US2Y.raw).toFixed(2) + '%',
        signal: (live.US10Y.raw - live.US2Y.raw) < 0 ? '역전 (경기침체 경고)' : '정상',
        up: (live.US10Y.raw - live.US2Y.raw) >= 0,
      } : null,
      analysis: analysis.bondAnalysis,
    },
    fx: {
      USDKRW:live.USDKRW, USDJPY:live.USDJPY, EURUSD:live.EURUSD, USDCNY:live.USDCNY, DXY:live.DXY,
      GOLD:live.GOLD, OIL:live.OIL, BRENT:live.BRENT, COPPER:live.COPPER, SILVER:live.SILVER, NATGAS:live.NATGAS,
      analysis: analysis.fxAnalysis,
    },
    volatility: {
      VIX:live.VIX, MOVE:live.MOVE, fearGreed:live.FEAR_GREED,
      riskLevel: analysis.riskLevel,
      analysis:  analysis.volatilityAnalysis,
    },
    calendar:         sortedCalendar,
    earnings:         sortedEarnings,
    brokerageReports: sortedBrokerage,
    news:             enrichedNews,
    insights: {
      keyPoints:     analysis.keyPoints     || [],
      watchout:      analysis.watchout      || '',
      tomorrowFocus: analysis.tomorrowFocus || '',
    },
  });
}
