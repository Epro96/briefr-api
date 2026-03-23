// api/report.js — Briefr 2.0
// Claude 2회 호출: ①시장분석+캘린더 ②뉴스요약
// 이렇게 분리해야 JSON 잘림 없이 완전한 응답 가능

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const KEY = process.env.ANTHROPIC_API_KEY;
  if (!KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY 없음' });

  const to = (ms) => AbortSignal.timeout(ms);
  const live = {};

  // ── 1. Yahoo Finance 시세 ────────────────────────────────
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

  // ── 2. 암호화폐 상위 10개 (CoinGecko) ───────────────────
  try {
    const r = await fetch(
      'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=10&page=1&price_change_percentage=24h',
      { signal: to(8000) }
    );
    if (r.ok) {
      const coins = await r.json();
      live.CRYPTO_LIST = coins.map(c => ({
        name: c.name, symbol: c.symbol?.toUpperCase(),
        value: '$' + c.current_price?.toLocaleString(),
        change: (c.price_change_percentage_24h >= 0 ? '+' : '') + (c.price_change_percentage_24h||0).toFixed(2) + '%',
        up: (c.price_change_percentage_24h||0) >= 0,
        raw: c.current_price, marketCap: c.market_cap, isReal: true,
      }));
    }
  } catch(e) {}

  // ── 3. BTC 펀딩비 (Binance) ──────────────────────────────
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

  // ── 4. 공포탐욕 7일 히스토리 ─────────────────────────────
  try {
    const r = await fetch('https://api.alternative.me/fng/?limit=7', { signal: to(7000) });
    if (r.ok) {
      const d = await r.json();
      const items = d.data || [];
      if (items[0]) live.FEAR_GREED = { value: parseInt(items[0].value), status: items[0].value_classification, isReal: true };
      live.FEAR_GREED_HISTORY = items.map(i => ({ value: parseInt(i.value), status: i.value_classification }));
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

  // ── 6. 뉴스 대량 수집 (9개 RSS) ─────────────────────────
  const rssFeeds = [
    { url:'https://www.yna.co.kr/rss/economy.xml',           type:'domestic',      source:'연합뉴스' },
    { url:'https://rss.hankyung.com/economy.xml',            type:'domestic',      source:'한국경제' },
    { url:'https://www.mk.co.kr/rss/50200030/',              type:'domestic',      source:'매일경제' },
    { url:'https://www.sedaily.com/RSS',                     type:'domestic',      source:'서울경제' },
    { url:'https://finance.yahoo.com/rss/topfinstories',     type:'international', source:'Yahoo Finance' },
    { url:'https://feeds.a.dj.com/rss/RSSMarketsMain.xml',   type:'international', source:'WSJ' },
    { url:'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114', type:'international', source:'CNBC' },
    { url:'https://www.coindesk.com/arc/outboundfeeds/rss/', type:'crypto',        source:'CoinDesk' },
    { url:'https://cointelegraph.com/rss',                   type:'crypto',        source:'CoinTelegraph' },
  ];

  const rawNews = [];
  await Promise.allSettled(rssFeeds.map(async ({ url, type, source }) => {
    try {
      const apiUrl = `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(url)}&count=8`;
      const r = await fetch(apiUrl, { signal: to(9000) });
      if (!r.ok) return;
      const d = await r.json();
      (d.items || []).forEach(item => {
        const title = (item.title || '').replace(/<[^>]*>/g,'').trim();
        if (!title || title.length < 5) return;
        rawNews.push({ title, link: item.link||item.url||'', pubDate: item.pubDate||'', type, source });
      });
    } catch(e) {}
  }));

  // 중복 제거
  const seen = new Set();
  const uniqueNews = rawNews.filter(n => {
    const k = n.title.slice(0,25);
    if (seen.has(k)) return false;
    seen.add(k); return true;
  }).slice(0, 35);

  live.RAW_NEWS = uniqueNews;

  // ── 7. 컨텍스트 구성 ─────────────────────────────────────
  const today = new Date().toLocaleDateString('ko-KR', { year:'numeric', month:'long', day:'numeric', weekday:'long' });
  const M = (k,l) => live[k] ? `${l}:${live[k].value}(${live[k].change})` : null;
  const cryptoSummary = (live.CRYPTO_LIST||[]).slice(0,6).map(c=>`${c.symbol}:${c.value}(${c.change})`).join(' ');

  const marketCtx = [
    `날짜:${today}`,
    `[주식] ${[M('KOSPI','KOSPI'),M('KOSDAQ','KOSDAQ'),M('SP500','SP500'),M('NASDAQ','NASDAQ'),M('NIKKEI','닛케이'),M('SHANGHAI','상하이')].filter(Boolean).join(' ')}`,
    `[채권] ${[M('US10Y','10년'),M('US2Y','2년'),live.US10Y&&live.US2Y?`스프레드:${(live.US10Y.raw-live.US2Y.raw).toFixed(2)}%`:null].filter(Boolean).join(' ')}`,
    `[환율] ${[M('USDKRW','달러원'),M('USDJPY','달러엔'),M('DXY','DXY'),M('EURUSD','유로')].filter(Boolean).join(' ')}`,
    `[원자재] ${[M('GOLD','금'),M('OIL','WTI'),M('BRENT','브렌트'),M('COPPER','구리'),M('SILVER','은')].filter(Boolean).join(' ')}`,
    `[변동성] ${[M('VIX','VIX'),M('MOVE','MOVE'),live.FEAR_GREED?`공포탐욕:${live.FEAR_GREED.value}점(${live.FEAR_GREED.status})`:null,live.BTC_FUNDING?`BTC펀딩비:${live.BTC_FUNDING.value}`:null].filter(Boolean).join(' ')}`,
    `[코인] ${cryptoSummary}`,
  ].join('\n');

  // ── 8. Claude 1차 호출: 시장분석 + 캘린더 + 실적 + 증권사 ─
  let analysis = null;
  let claudeError = null;

  try {
    const r1 = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'x-api-key':KEY, 'anthropic-version':'2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4096,
        messages: [{
          role: 'user',
          content: `전문 투자 애널리스트로서 아래 실시간 시장 데이터를 분석하세요.

${marketCtx}

순수 JSON만 출력 (마크다운 없이):
{
  "headline":"20자 이내 오늘 시장 핵심",
  "sentiment":"강세또는약세또는중립또는주의",
  "sentimentReason":"근거 한줄",
  "riskLevel":"리스크 온또는중립또는리스크 오프",
  "riskReason":"근거 한줄",
  "strategy":"오늘 투자 전략 한줄",
  "sectorAnalysis":"섹터 동향 분석 3줄",
  "cryptoAnalysis":"크립토 시장 분석 2줄",
  "bondAnalysis":"채권·금리 분석 2줄",
  "fxAnalysis":"환율·원자재 분석 2줄",
  "volatilityAnalysis":"변동성 분석 2줄",
  "keyPoints":["핵심인사이트1","핵심인사이트2","핵심인사이트3","핵심인사이트4","핵심인사이트5"],
  "watchout":"주목할 리스크 한줄",
  "tomorrowFocus":"내일 주목 이벤트 한줄",
  "calendar":[
    {"date":"2026-03-24","event":"이벤트명","country":"US","importance":"high","description":"예상치 포함 설명"},
    {"date":"2026-03-25","event":"이벤트명","country":"KR","importance":"medium","description":"설명"},
    {"date":"2026-03-26","event":"이벤트명","country":"US","importance":"high","description":"설명"},
    {"date":"2026-03-27","event":"이벤트명","country":"EU","importance":"medium","description":"설명"},
    {"date":"2026-03-28","event":"이벤트명","country":"US","importance":"high","description":"설명"},
    {"date":"2026-03-29","event":"이벤트명","country":"US","importance":"medium","description":"설명"},
    {"date":"2026-03-30","event":"이벤트명","country":"KR","importance":"low","description":"설명"}
  ],
  "earnings":[
    {"company":"기업명","ticker":"티커","market":"US또는KR","date":"날짜","epsEstimate":"예상","result":"예정또는발표","signal":"upcoming또는beat또는miss또는meet","importance":"high또는medium"},
    {"company":"기업명2","ticker":"티커2","market":"KR","date":"날짜","epsEstimate":"예상","result":"예정","signal":"upcoming","importance":"high"},
    {"company":"기업명3","ticker":"티커3","market":"US","date":"날짜","epsEstimate":"예상","result":"예정","signal":"upcoming","importance":"medium"},
    {"company":"기업명4","ticker":"티커4","market":"KR","date":"날짜","epsEstimate":"예상","result":"예정","signal":"upcoming","importance":"medium"},
    {"company":"기업명5","ticker":"티커5","market":"US","date":"날짜","epsEstimate":"예상","result":"예정","signal":"upcoming","importance":"medium"},
    {"company":"기업명6","ticker":"티커6","market":"KR","date":"날짜","epsEstimate":"예상","result":"예정","signal":"upcoming","importance":"medium"},
    {"company":"기업명7","ticker":"티커7","market":"US","date":"날짜","epsEstimate":"예상","result":"예정","signal":"upcoming","importance":"low"},
    {"company":"기업명8","ticker":"티커8","market":"KR","date":"날짜","epsEstimate":"예상","result":"예정","signal":"upcoming","importance":"low"},
    {"company":"기업명9","ticker":"티커9","market":"US","date":"날짜","epsEstimate":"예상","result":"예정","signal":"upcoming","importance":"low"},
    {"company":"기업명10","ticker":"티커10","market":"KR","date":"날짜","epsEstimate":"예상","result":"예정","signal":"upcoming","importance":"low"}
  ],
  "brokerageReports":[
    {"company":"기업명","ticker":"티커","broker":"증권사","rating":"매수","targetPrice":"목표가","prevTarget":"이전목표가","change":"상향또는하향또는유지","summary":"한줄요약","importance":"high"},
    {"company":"기업명2","ticker":"티커2","broker":"증권사2","rating":"중립","targetPrice":"목표가","prevTarget":"이전목표가","change":"하향","summary":"한줄요약","importance":"high"},
    {"company":"기업명3","ticker":"티커3","broker":"증권사3","rating":"매수","targetPrice":"목표가","prevTarget":"이전목표가","change":"유지","summary":"한줄요약","importance":"medium"},
    {"company":"기업명4","ticker":"티커4","broker":"증권사4","rating":"매수","targetPrice":"목표가","prevTarget":"이전목표가","change":"상향","summary":"한줄요약","importance":"medium"},
    {"company":"기업명5","ticker":"티커5","broker":"증권사5","rating":"매도","targetPrice":"목표가","prevTarget":"이전목표가","change":"하향","summary":"한줄요약","importance":"medium"}
  ]
}

calendar는 오늘(${today})부터 7일간 실제 주요 경제지표 일정을 high 우선 정렬해서 작성.
earnings는 이번 주 국내+해외 주요 기업 실적 발표 일정을 importance 순으로 10개 이상 작성.
brokerageReports는 최근 주요 증권사 목표가 변경을 importance 순으로 5개 작성.`
        }]
      }),
      signal: to(50000),
    });

    if (r1.ok) {
      const d = await r1.json();
      if (d.error) {
        claudeError = d.error.message;
      } else {
        const raw = (d.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('');
        const clean = raw.replace(/```json|```/gi,'').trim();
        const s = clean.indexOf('{'), e = clean.lastIndexOf('}');
        if (s>-1 && e>s) {
          try { analysis = JSON.parse(clean.slice(s,e+1)); }
          catch(err) { claudeError = 'JSON 파싱 실패: ' + err.message; }
        } else {
          claudeError = 'JSON 없음';
        }
      }
    } else {
      const t = await r1.text().catch(()=>'');
      try { claudeError = JSON.parse(t).error?.message || `HTTP ${r1.status}`; }
      catch(e) { claudeError = `HTTP ${r1.status}`; }
    }
  } catch(e) {
    claudeError = e.message || 'Claude 1차 호출 실패';
  }

  // ── 9. Claude 2차 호출: 뉴스 요약 ───────────────────────
  let newsSummaries = [];

  if (live.RAW_NEWS.length > 0 && !claudeError) {
    const newsLines = live.RAW_NEWS.map((n,i) => `${i}.[${n.source}] ${n.title}`).join('\n');
    try {
      const r2 = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type':'application/json', 'x-api-key':KEY, 'anthropic-version':'2023-06-01' },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 4096,
          messages: [{
            role: 'user',
            content: `아래 뉴스 헤드라인 ${live.RAW_NEWS.length}개를 분석하여 각각을 한국어로 요약하세요.

${newsLines}

각 뉴스에 대해 순수 JSON 배열만 출력 (마크다운 없이):
[
  {"index":0,"summary":"2문장 한국어 요약","category":"매크로또는반도체또는금리또는환율또는암호화폐또는기업실적또는정치또는에너지또는기타","importance":"high또는medium또는low"},
  {"index":1,"summary":"요약","category":"카테고리","importance":"importance"}
]

모든 ${live.RAW_NEWS.length}개 뉴스를 빠짐없이 포함하세요. importance는 투자에 미치는 영향도 기준으로 분류하세요.`
          }]
        }),
        signal: to(50000),
      });

      if (r2.ok) {
        const d2 = await r2.json();
        if (!d2.error) {
          const raw2 = (d2.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('');
          const clean2 = raw2.replace(/```json|```/gi,'').trim();
          const s2 = clean2.indexOf('['), e2 = clean2.lastIndexOf(']');
          if (s2>-1 && e2>s2) {
            try { newsSummaries = JSON.parse(clean2.slice(s2,e2+1)); } catch(e) {}
          }
        }
      }
    } catch(e) {}
  }

  // ── 10. fallback ─────────────────────────────────────────
  if (!analysis) {
    analysis = {
      headline:'시장 데이터 수집 완료', sentiment:'중립',
      sentimentReason: claudeError || 'AI 분석 실패',
      riskLevel:'중립', riskReason:'AI 분석 실패',
      strategy: claudeError ? `오류: ${claudeError}` : 'AI 분석 실패',
      sectorAnalysis:'AI 분석 실패', cryptoAnalysis:'AI 분석 실패',
      bondAnalysis:'AI 분석 실패', fxAnalysis:'AI 분석 실패',
      volatilityAnalysis:'AI 분석 실패',
      keyPoints:[claudeError||'AI 분석 실패'],
      watchout:'AI 분석 실패', tomorrowFocus:'AI 분석 실패',
      calendar:[], earnings:[], brokerageReports:[],
    };
  }

  // ── 11. 뉴스 + 요약 결합 → 중요도 순 정렬 ───────────────
  const enrichedNews = live.RAW_NEWS.map((n, i) => {
    const s = newsSummaries.find(x => x.index === i);
    return { ...n, summary: s?.summary||'', category: s?.category||'일반', importance: s?.importance||'medium' };
  }).sort((a,b) => ({ high:0, medium:1, low:2 }[a.importance]||1) - ({ high:0, medium:1, low:2 }[b.importance]||1));

  // 캘린더·실적·증권사 중요도 순 정렬
  const imp = (x) => ({ high:0, medium:1, low:2 }[x.importance]||1);
  const sortedCal  = (analysis.calendar||[]).sort((a,b) => imp(a)-imp(b));
  const sortedEarn = (analysis.earnings||[]).sort((a,b) => imp(a)-imp(b));
  const sortedBrok = (analysis.brokerageReports||[]).sort((a,b) => imp(a)-imp(b));

  // ── 12. 최종 응답 ─────────────────────────────────────────
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
      list: live.CRYPTO_LIST || [],
      fundingRate: live.BTC_FUNDING,
      fearGreed: live.FEAR_GREED,
      fearGreedHistory: live.FEAR_GREED_HISTORY || [],
      analysis: analysis.cryptoAnalysis,
    },
    bonds: {
      US10Y:live.US10Y, US2Y:live.US2Y, US30Y:live.US30Y,
      spread: (live.US10Y&&live.US2Y) ? {
        value: (live.US10Y.raw-live.US2Y.raw).toFixed(2)+'%',
        signal: (live.US10Y.raw-live.US2Y.raw)<0 ? '역전 (경기침체 경고)' : '정상',
        up: (live.US10Y.raw-live.US2Y.raw)>=0,
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
      analysis: analysis.volatilityAnalysis,
    },
    calendar:         sortedCal,
    earnings:         sortedEarn,
    brokerageReports: sortedBrok,
    news:             enrichedNews,
    insights: {
      keyPoints:     analysis.keyPoints     || [],
      watchout:      analysis.watchout      || '',
      tomorrowFocus: analysis.tomorrowFocus || '',
    },
  });
}
