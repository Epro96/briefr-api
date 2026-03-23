// api/report.js
// Vercel이 시장 데이터 수집 + Claude 분석을 모두 처리하고
// 완성된 리포트 JSON을 앱에 반환합니다.
//
// 환경변수 설정 필요:
//   ANTHROPIC_API_KEY = sk-ant-...

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다.' });
  }

  // ── 1. 시장 데이터 수집 ─────────────────────────────────
  const live = {};

  // 주가 지수 (Yahoo Finance)
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
          { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) }
        );
        if (!r.ok) return;
        const data = await r.json();
        const meta = data?.chart?.result?.[0]?.meta;
        if (!meta) return;
        const price  = meta.regularMarketPrice;
        const prev   = meta.chartPreviousClose || meta.previousClose || price;
        const chgPct = ((price - prev) / prev) * 100;
        live[key] = {
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

  // 비트코인 · 이더리움 (CoinGecko)
  try {
    const r = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd&include_24hr_change=true',
      { signal: AbortSignal.timeout(8000) }
    );
    if (r.ok) {
      const d = await r.json();
      if (d.bitcoin) {
        const chg = d.bitcoin.usd_24h_change || 0;
        live.BTC = {
          name: 'BTC/USD', value: '$' + d.bitcoin.usd.toLocaleString(),
          change: (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%',
          up: chg >= 0, raw: d.bitcoin.usd, isReal: true,
        };
      }
      if (d.ethereum) {
        const chg = d.ethereum.usd_24h_change || 0;
        live.ETH = {
          name: 'ETH/USD', value: '$' + d.ethereum.usd.toLocaleString(),
          change: (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%',
          up: chg >= 0, raw: d.ethereum.usd, isReal: true,
        };
      }
    }
  } catch (e) {}

  // 공포탐욕지수 (Alternative.me)
  try {
    const r = await fetch('https://api.alternative.me/fng/?limit=1', { signal: AbortSignal.timeout(8000) });
    if (r.ok) {
      const d = await r.json();
      const item = d.data?.[0];
      if (item) live.fearGreed = { value: parseInt(item.value), status: item.value_classification, isReal: true };
    }
  } catch (e) {}

  // 달러/원 환율 (ExchangeRate API)
  try {
    const r = await fetch('https://open.er-api.com/v6/latest/USD', { signal: AbortSignal.timeout(8000) });
    if (r.ok) {
      const d = await r.json();
      if (d.rates?.KRW) {
        const krw = Math.round(d.rates.KRW);
        live.usdKrw = { name: 'USD/KRW', value: krw.toLocaleString() + '원', change: '±0.3%', up: false, raw: krw, isReal: true };
      }
    }
  } catch (e) {}

  // ── 2. 컨텍스트 텍스트 구성 ────────────────────────────
  const today = new Date().toLocaleDateString('ko-KR', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long'
  });

  const lines = [];
  if (live.KOSPI?.value)     lines.push('KOSPI ' + live.KOSPI.value + ' ' + live.KOSPI.change);
  if (live.KOSDAQ?.value)    lines.push('KOSDAQ ' + live.KOSDAQ.value + ' ' + live.KOSDAQ.change);
  if (live.SP500?.value)     lines.push('S&P500 ' + live.SP500.value + ' ' + live.SP500.change);
  if (live.NASDAQ?.value)    lines.push('NASDAQ ' + live.NASDAQ.value + ' ' + live.NASDAQ.change);
  if (live.VIX?.value)       lines.push('VIX ' + live.VIX.value + ' ' + live.VIX.change);
  if (live.BTC?.value)       lines.push('BTC ' + live.BTC.value + ' ' + live.BTC.change);
  if (live.ETH?.value)       lines.push('ETH ' + live.ETH.value);
  if (live.fearGreed?.value) lines.push('공포탐욕지수 ' + live.fearGreed.value + '점(' + live.fearGreed.status + ')');
  if (live.usdKrw?.value)    lines.push('달러원 ' + live.usdKrw.value);
  const dataStr = lines.length ? lines.join(', ') : '데이터 수집 실패';

  const markets = [
    live.KOSPI  || { name:'KOSPI',   value:'N/A', change:'N/A', up:true,  isReal:false },
    live.KOSDAQ || { name:'KOSDAQ',  value:'N/A', change:'N/A', up:true,  isReal:false },
    live.SP500  ? {...live.SP500, name:'S&P 500'} : { name:'S&P 500', value:'N/A', change:'N/A', up:true,  isReal:false },
    live.NASDAQ || { name:'NASDAQ',  value:'N/A', change:'N/A', up:true,  isReal:false },
    live.BTC    ? {...live.BTC,   name:'BTC/USD'} : { name:'BTC/USD',  value:'N/A', change:'N/A', up:true,  isReal:false },
    live.usdKrw ? {...live.usdKrw,name:'USD/KRW'}: { name:'USD/KRW',  value:'N/A', change:'N/A', up:false, isReal:false },
  ];

  const vixVal  = live.VIX?.raw      || 16;
  const fgVal   = live.fearGreed?.value || 50;
  const fgStat  = live.fearGreed?.status || '중립';
  const vixStat = vixVal < 15 ? '안정' : vixVal < 25 ? '경계' : '위험';

  // ── 3. Claude API 호출 ──────────────────────────────────
  const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content:
          '당신은 투자 애널리스트입니다. 오늘(' + today + ') 실시간 데이터: ' + dataStr + '\n\n' +
          '이 데이터를 바탕으로 저녁 투자 브리핑을 작성하세요.\n' +
          '반드시 JSON 객체만 출력하세요. 설명 없이, 마크다운 없이.\n\n' +
          '{"date":"' + today + '",' +
          '"headline":"한줄요약20자",' +
          '"sentiment":"강세",' +
          '"sentiment_reason":"근거한줄",' +
          '"markets":' + JSON.stringify(markets) + ',' +
          '"vix":{"value":' + vixVal + ',"status":"' + vixStat + '","description":"VIX해석한줄","isReal":' + (live.VIX ? 'true' : 'false') + '},' +
          '"fear_greed":{"value":' + fgVal + ',"status":"' + fgStat + '","description":"공포탐욕해석한줄","isReal":' + (live.fearGreed ? 'true' : 'false') + '},' +
          '"news":[' +
          '{"title":"뉴스1","summary":"2문장요약","impact":"high","category":"카테고리","source":"출처"},' +
          '{"title":"뉴스2","summary":"2문장요약","impact":"medium","category":"카테고리","source":"출처"},' +
          '{"title":"뉴스3","summary":"2문장요약","impact":"low","category":"카테고리","source":"출처"}' +
          '],' +
          '"key_points":["인사이트1","인사이트2","인사이트3"],' +
          '"watchout":"리스크한줄",' +
          '"tomorrow_focus":"내일주목이벤트"}'
      }],
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!claudeRes.ok) {
    const errText = await claudeRes.text().catch(() => '');
    return res.status(502).json({ error: 'Claude API 오류: ' + claudeRes.status, detail: errText.slice(0, 200) });
  }

  const claudeData = await claudeRes.json();
  const rawText = (claudeData.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');

  // JSON 파싱
  const clean = rawText.replace(/```json|```/gi, '').trim();
  const s = clean.indexOf('{'), e = clean.lastIndexOf('}');
  let report = null;
  if (s > -1 && e > s) {
    try { report = JSON.parse(clean.slice(s, e + 1)); } catch(err) {}
  }

  if (!report) {
    return res.status(502).json({ error: 'JSON 파싱 실패', raw: rawText.slice(0, 300) });
  }

  return res.status(200).json({ ...report, _generatedAt: new Date().toISOString() });
}
