// api/load.js — Vercel Serverless Function
// GET /api/load?code=123456

export default async function handler(req, res) {
  // ── CORS 헤더 ────────────────────────────────────────────
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method Not Allowed" });

  const { UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN } = process.env;
  if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
    return res.status(500).json({ error: "서버 환경변수 미설정" });
  }

  const { code } = req.query;
  if (!code || !/^\d{6}$/.test(code)) {
    return res.status(400).json({ error: "올바른 6자리 코드를 입력하세요" });
  }

  const key = `briefr:${code}`;

  try {
    const upstashRes = await fetch(
      `${UPSTASH_REDIS_REST_URL}/get/${key}`,
      {
        headers: { Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}` },
      }
    );

    if (!upstashRes.ok) {
      return res.status(500).json({ error: `Redis 조회 실패 (${upstashRes.status})` });
    }

    const { result } = await upstashRes.json();
    if (!result) {
      return res.status(404).json({ error: "코드가 존재하지 않거나 만료됐어요 (24시간)" });
    }

    const { data } = JSON.parse(result);
    return res.status(200).json({ data });
  } catch (e) {
    return res.status(500).json({ error: `Redis 연결 실패: ${e.message}` });
  }
}
