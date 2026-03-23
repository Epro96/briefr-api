// api/report.js
// Briefr 데일리 리포트 백엔드
// 모든 시장 데이터 수집 + Claude AI 분석 → 완성된 리포트 반환

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY 환경변수가 없습니다.' });
  }

  const t = (ms) => AbortSignal.timeout(ms);
  const live = {};

  // ── 1. Yahoo Finance (주식·채권·원자재·환율·변동성) ─────────
  const yahooTickers = {
    KOSPI:    '^KS11',
    KOSDAQ:   '^KQ11',
    SP500:    '^GSPC',
    NASDAQ:   '^IXIC',
    NIKKEI:   '^N225',
    SHANGHAI: '000001.SS',
    VIX:      '^VIX',
    MOVE:     '^MOVE',
    US10Y:    '^TNX',
    US2Y:     '^IRX',
    DXY:      'DX-Y.NYB',
    USDKRW:   'USDKRW=X',
    USDJPY:   'USDJPY=X',
    EURUSD:   'EURUSD=X',
    GOLD:     'GC=F',
    OIL:      'CL=F',
    COPPER:   'HG=F',
  };

  await Promise.allSettled(
    Object.entries(yahooTickers).map(async ([key, ticker]) => {
      try {
        const r = await fetch(
          `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=2d`,
          { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: t(7000) }
        );
        if (!r.ok) return;
        const d = await r.json();
        const meta = d?.chart?.result?.[0]?.meta;
        if (!meta) return;
        const price = meta.regularMarketPrice;
        const prev  = meta.chartPreviousClose || meta.previousClose || price;
        const chgPct = ((price - prev) / prev) * 100;
        const decimals = ['KOSPI','NIKKEI','SHANGHAI'].includes(key) ? 0 : 2;
        live[key] = {
          value:     price.toLocaleString('ko-KR', { maximumFractionDigits: decimals }),
          change:    (chgPct >= 0 ? '+' : '') + chgPct.toFixed(2) + '%',
          changePct: parseFloat(chgPct.toFixed(2)),
          up:        chgPct >= 0,
          raw:       price,
          isReal:    true,
        };
      } catch (e) {}
    })
  );

  // ── 2. 암호화폐 (CoinGecko) ──────────────────────────────
  try {
    const r = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=usd&include_24hr_change=true',
      { signal: t(7000) }
    );
    if (r.ok) {
      const d = await r.json();
      ['bitcoin','ethereum','solana'].forEach(id => {
        if (!d[id]) return;
        const chg = d[id].usd_24h_change || 0;
        const key = id === 'bitcoin' ? 'BTC' : id === 'ethereum' ? 'ETH' : 'SOL';
        live[key] = {
          value:  '$' + d[id].usd.toLocaleString(),
          change: (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%',
          up:     chg >= 0,
          raw:    d[id].usd,
          isReal: true,
        };
      });
    }
  } catch (e) {}

  // ── 3. 공포탐욕지수 (Alternative.me) ─────────────────────
  try {
    const r = await fetch('https://api.alternative.me/fng/?limit=1', { signal: t(7000) });
    if (r.ok) {
      const d = await r.json();
      const item = d.data?.[0];
      if (item) live.FEAR_GREED = { value: parseInt(item.value), status: item.value_classification, isReal: true };
    }
  } catch (e) {}

  // ── 4. BTC 펀딩비 (Binance) ───────────────────────────────
  try {
    const r = await fetch('https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT', { signal: t(7000) });
    if (r.ok) {
      const d = await r.json();
      if (d.lastFundingRate) {
        const rate = (parseFloat(d.lastFundingRate) * 100).toFixed(4);
        live.BTC_FUNDING = { value: rate + '%', raw: parseFloat(rate), isReal: true };
      }
    }
  } catch (e) {}

  // ── 5. 환율 백업 (ExchangeRate API) ──────────────────────
  if (!live.USDKRW) {
    try {
      const r = await fetch('https://open.er-api.com/v6/latest/USD', { signal: t(7000) });
      if (r.ok) {
        const d = await r.json();
        if (d.rates?.KRW) {
          const krw = Math.round(d.rates.KRW);
          live.USDKRW = { value: krw.toLocaleString(), change: '±0.3%', up: false, raw: krw, isReal: true };
        }
      }
    } catch (e) {}
  }

  // ── 6. 뉴스 RSS ──────────────────────────────────────────
  const rssFeeds = [
    { url: 'https://www.yna.co.kr/rss/economy.xml',        type: 'domestic',      source: '연합뉴스' },
    { url: 'https://rss.hankyung.com/economy.xml',         type: 'domestic',      source: '한국경제' },
    { url: 'https://finance.yahoo.com/rss/topfinstories',  type: 'international', source: 'Yahoo Finance' },
  ];

  const newsItems = [];
  await Promise.allSettled(
    rssFeeds.map(async ({ url, type, source }) => {
      try {
        const apiUrl = `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(url)}&count=5`;
        const r = await fetch(apiUrl, { signal: t(7000) });
        if (!r.ok) return;
        const d = await r.json();
        (d.items || []).slice(0, 5).forEach(item => {
          newsItems.push({
            title:   item.title?.replace(/<[^>]*>/g, '').trim() || '',
            link:    item.link || item.url || '',
            pubDate: item.pubDate || '',
            type,
            source,
          });
        });
      } catch (e) {}
    })
  );

  live.RAW_NEWS = newsItems.slice(0, 15);

  // ── 7. 컨텍스트 구성 ─────────────────────────────────────
  const today = new Date().toLocaleDateString('ko-KR', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long'
  });

  const mkt = (key, label) => live[key]
    ? `${label} ${live[key].value} (${live[key].change})`
    : `${label} 수집실패`;

  const context = [
    `오늘: ${today}`,
    '',
    '=== 주식 지수 ===',
    mkt('KOSPI', 'KOSPI'), mkt('KOSDAQ', 'KOSDAQ'),
    mkt('SP500', 'S&P500'), mkt('NASDAQ', 'NASDAQ'),
    mkt('NIKKEI', '닛케이'), mkt('SHANGHAI', '상하이'),
    '',
    '=== 채권·금리 ===',
    mkt('US10Y', '미국 10년물'), mkt('US2Y', '미국 2년물'),
    live.US10Y && live.US2Y ? `장단기 스프레드: ${(live.US10Y.raw - live.US2Y.raw).toFixed(2)}%` : '',
    '',
    '=== 환율·원자재 ===',
    mkt('USDKRW', '달러원'), mkt('USDJPY', '달러엔'),
    mkt('DXY', 'DXY'), mkt('EURUSD', '유로달러'),
    mkt('GOLD', '금'), mkt('OIL', '유가'), mkt('COPPER', '구리'),
    '',
    '=== 변동성 ===',
    mkt('VIX', 'VIX'), mkt('MOVE', 'MOVE'),
    live.FEAR_GREED ? `공포탐욕지수: ${live.FEAR_GREED.value}점 (${live.FEAR_GREED.status})` : '',
    '',
    '=== 암호화폐 ===',
    mkt('BTC', 'BTC'), mkt('ETH', 'ETH'), mkt('SOL', 'SOL'),
    live.BTC_FUNDING ? `BTC 펀딩비: ${live.BTC_FUNDING.value}` : '',
    '',
    '=== 뉴스 헤드라인 ===',
    ...live.RAW_NEWS.map((n, i) => `${i + 1}. [${n.source}] ${n.title}`),
  ].filter(l => l !== undefined).join('\n');

  // ── 8. Claude AI 분석 ─────────────────────────────────────
  let analysis = null;
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
        max_tokens: 2000,
        messages: [{
          role: 'user',
          content: `당신은 전문 투자 애널리스트입니다. 아래 실시간 시장 데이터를 분석하여 저녁 데일리 브리핑을 작성하세요.

${context}

반드시 아래 JSON만 출력하세요. 설명 없이, 마크다운 없이, JSON 객체만:
{
  "headline": "오늘 시장 20자 이내 핵심 요약",
  "sentiment": "강세 또는 약세 또는 중립 또는 주의",
  "sentimentReason": "시장 심리 근거 한 줄",
  "riskLevel": "리스크 온 또는 중립 또는 리스크 오프",
  "riskReason": "리스크 레벨 근거 한 줄",
  "strategy": "오늘의 전략 한 줄 (예: 단기 과열 → 눌림 대기)",
  "sectorAnalysis": "섹터 동향 2~3줄 분석",
  "cryptoAnalysis": "크립토 시장 분석 2줄",
  "bondAnalysis": "채권·금리 분석 2줄",
  "fxAnalysis": "환율·원자재 분석 2줄",
  "volatilityAnalysis": "변동성 지표 분석 2줄",
  "calendar": [
    {"date": "날짜", "event": "이벤트명", "importance": "high 또는 medium 또는 low", "description": "한 줄 설명"}
  ],
  "earnings": [
    {"company": "기업명", "date": "날짜", "expectation": "예상 내용", "result": "발표됨 또는 예정", "signal": "beat 또는 miss 또는 meet 또는 upcoming"}
  ],
  "brokerageReports": [
    {"company": "기업명", "broker": "증권사", "rating": "매수 또는 중립 또는 매도", "targetPrice": "목표가", "prevTarget": "이전목표가", "change": "상향 또는 하향 또는 유지", "summary": "한 줄 요약"}
  ],
  "newsSummaries": [
    {"index": 0, "summary": "뉴스 2문장 한국어 요약", "category": "카테고리", "importance": "high 또는 medium 또는 low"}
  ],
  "keyPoints": ["핵심 인사이트1", "핵심 인사이트2", "핵심 인사이트3"],
  "watchout": "오늘 주목할 리스크 한 줄",
  "tomorrowFocus": "내일 주목할 이벤트 한 줄"
}`
        }],
      }),
      signal: t(45000),
    });

    if (claudeRes.ok) {
      const d = await claudeRes.json();
      if (!d.error) {
        const raw = (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
        const clean = raw.replace(/```json|```/gi, '').trim();
        const s = clean.indexOf('{'), e = clean.lastIndexOf('}');
        if (s > -1 && e > s) {
          try { analysis = JSON.parse(clean.slice(s, e + 1)); } catch(e) {}
        }
      }
    }
  } catch (e) {}

  if (!analysis) {
    analysis = {
      headline: '데이터 분석 완료',
      sentiment: '중립',
      sentimentReason: 'AI 분석 실패 - 데이터만 표시',
      riskLevel: '중립',
      riskReason: 'AI 분석 실패',
      strategy: 'AI 분석을 다시 시도해주세요',
      sectorAnalysis: 'AI 분석 실패',
      cryptoAnalysis: 'AI 분석 실패',
      bondAnalysis: 'AI 분석 실패',
      fxAnalysis: 'AI 분석 실패',
      volatilityAnalysis: 'AI 분석 실패',
      calendar: [],
      earnings: [],
      brokerageReports: [],
      newsSummaries: [],
      keyPoints: ['AI 분석 실패'],
      watchout: 'AI 분석 실패',
      tomorrowFocus: 'AI 분석 실패',
    };
  }

  // ── 9. 뉴스 + AI 요약 결합 ───────────────────────────────
  const enrichedNews = live.RAW_NEWS.map((n, i) => {
    const summary = analysis.newsSummaries?.find(s => s.index === i);
    return {
      ...n,
      summary:    summary?.summary    || '',
      category:   summary?.category   || '일반',
      importance: summary?.importance || 'medium',
    };
  });

  // ── 10. 최종 응답 ─────────────────────────────────────────
  return res.status(200).json({
    date:        today,
    generatedAt: new Date().toISOString(),

    // AI 분석
    headline:        analysis.headline,
    sentiment:       analysis.sentiment,
    sentimentReason: analysis.sentimentReason,
    riskLevel:       analysis.riskLevel,
    riskReason:      analysis.riskReason,
    strategy:        analysis.strategy,

    // 시장 데이터
    stocks: {
      KOSPI:    live.KOSPI,
      KOSDAQ:   live.KOSDAQ,
      SP500:    live.SP500,
      NASDAQ:   live.NASDAQ,
      NIKKEI:   live.NIKKEI,
      SHANGHAI: live.SHANGHAI,
      analysis: analysis.sectorAnalysis,
    },
    crypto: {
      BTC:         live.BTC,
      ETH:         live.ETH,
      SOL:         live.SOL,
      fundingRate: live.BTC_FUNDING,
      fearGreed:   live.FEAR_GREED,
      analysis:    analysis.cryptoAnalysis,
    },
    bonds: {
      US10Y:    live.US10Y,
      US2Y:     live.US2Y,
      spread:   live.US10Y && live.US2Y ? {
        value:  (live.US10Y.raw - live.US2Y.raw).toFixed(2) + '%',
        signal: (live.US10Y.raw - live.US2Y.raw) < 0 ? '역전 (경기침체 경고)' : '정상',
        up:     (live.US10Y.raw - live.US2Y.raw) >= 0,
      } : null,
      analysis: analysis.bondAnalysis,
    },
    fx: {
      USDKRW:   live.USDKRW,
      USDJPY:   live.USDJPY,
      EURUSD:   live.EURUSD,
      DXY:      live.DXY,
      GOLD:     live.GOLD,
      OIL:      live.OIL,
      COPPER:   live.COPPER,
      analysis: analysis.fxAnalysis,
    },
    volatility: {
      VIX:        live.VIX,
      MOVE:       live.MOVE,
      fearGreed:  live.FEAR_GREED,
      riskLevel:  analysis.riskLevel,
      analysis:   analysis.volatilityAnalysis,
    },
    calendar:         analysis.calendar        || [],
    earnings:         analysis.earnings        || [],
    brokerageReports: analysis.brokerageReports|| [],
    news:             enrichedNews,
    insights: {
      keyPoints:     analysis.keyPoints     || [],
      watchout:      analysis.watchout      || '',
      tomorrowFocus: analysis.tomorrowFocus || '',
    },
  });
}
