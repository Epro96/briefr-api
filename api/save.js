// api/save.js — Vercel Serverless Function
// 환경변수 필요: UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN

export default async function handler(req, res) {
  // ── CORS 헤더 (모든 출처 허용) ──────────────────────────────
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");

  // CORS preflight 요청 처리
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  // ── 환경변수 확인 ──────────────────────────────────────────
  const { UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN } = process.env;
  if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
    console.error("[save] Missing Upstash env vars");
    return res.status(500).json({ error: "서버 환경변수 미설정 (UPSTASH)" });
  }

  // ── 요청 바디 파싱 ─────────────────────────────────────────
  let data;
  try {
    data = req.body;
    if (typeof data === "string") data = JSON.parse(data);
  } catch (e) {
    return res.status(400).json({ error: "Invalid JSON body" });
  }

  if (!data || typeof data !== "object") {
    return res.status(400).json({ error: "Empty or invalid data" });
  }

  // ── 6자리 코드 생성 ────────────────────────────────────────
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const key = `briefr:${code}`;
  const payload = JSON.stringify({ data, savedAt: new Date().toISOString() });

  // ── Upstash Redis에 저장 (TTL: 24시간 = 86400초) ──────────
  try {
    const upstashRes = await fetch(
      `${UPSTASH_REDIS_REST_URL}/set/${key}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify([payload, "EX", 86400]),
      }
    );

    if (!upstashRes.ok) {
      const errText = await upstashRes.text();
      console.error("[save] Upstash error:", upstashRes.status, errText);
      return res.status(500).json({ error: `Redis 저장 실패 (${upstashRes.status})` });
    }

    return res.status(200).json({ code, expiresIn: "24h" });
  } catch (e) {
    console.error("[save] Fetch to Upstash failed:", e.message);
    return res.status(500).json({ error: `Redis 연결 실패: ${e.message}` });
  }
}
