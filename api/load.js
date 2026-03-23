// api/load.js
// 6자리 코드로 저장된 리포트를 Upstash Redis에서 불러오기

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
  const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!REDIS_URL || !REDIS_TOKEN) {
    return res.status(500).json({ error: 'Upstash 환경변수가 설정되지 않았습니다.' });
  }

  const code = (req.query?.code || '').toUpperCase().trim();
  if (!code || code.length !== 6) {
    return res.status(400).json({ error: '올바른 6자리 코드를 입력해주세요.' });
  }

  try {
    const getRes = await fetch(`${REDIS_URL}/get/report:${code}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
    });

    if (!getRes.ok) throw new Error('Redis 조회 실패');

    const result = await getRes.json();

    if (!result.result) {
      return res.status(404).json({ error: '리포트를 찾을 수 없습니다. 코드를 확인하거나 24시간이 지났을 수 있습니다.' });
    }

    const report = JSON.parse(result.result);
    return res.status(200).json(report);
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
