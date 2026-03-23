// api/save.js
// 생성된 리포트를 Upstash Redis에 저장하고 6자리 코드 반환
// 24시간 유효

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
  const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!REDIS_URL || !REDIS_TOKEN) {
    return res.status(500).json({ error: 'Upstash 환경변수가 설정되지 않았습니다.' });
  }

  try {
    const report = await req.json ? req.json() : JSON.parse(await new Promise(resolve => {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => resolve(body));
    }));

    // 6자리 대문자 코드 생성
    const code = Math.random().toString(36).slice(2, 8).toUpperCase();

    // Upstash Redis REST API로 저장 (TTL 24시간 = 86400초)
    const saveRes = await fetch(`${REDIS_URL}/set/report:${code}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${REDIS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        value: JSON.stringify({ ...report, savedAt: new Date().toISOString() }),
        ex: 86400, // 24시간
      }),
    });

    if (!saveRes.ok) {
      const err = await saveRes.text();
      throw new Error('Redis 저장 실패: ' + err);
    }

    return res.status(200).json({ code });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
