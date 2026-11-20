// /api/doc/<uuid> の読み書きだけを行う。それ以外のパスは静的アセットが返す。
// UUID を知っていれば誰でも読み書きできる(UUID が鍵の代わり)。

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const MAX_BYTES = 256 * 1024

const json = (data, status = 200) => Response.json(data, { status, headers: { 'cache-control': 'no-store' } })

// version は R2 に書きこまれた時刻(ms)。クライアントはこれを覚えておき、次の保存時に送る
const info = o => ({
  version: o.uploaded.getTime(),
  name: o.customMetadata?.name ?? '', // encodeURIComponent 済み
  updated: Number(o.customMetadata?.updated) || o.uploaded.getTime(),
})

export default {
  async fetch(req, env) {
    const m = new URL(req.url).pathname.match(/^\/api\/doc\/([^/]+)$/)
    if (!m || !UUID.test(m[1])) return json({ error: 'not found' }, 404)
    const key = 'doc/' + m[1]

    if (req.method === 'GET') {
      const o = await env.BUCKET.get(key)
      if (!o) return json({ error: 'not found' }, 404)
      const i = info(o)
      return new Response(o.body, {
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store',
          'x-version': i.version,
          'x-name': i.name,
          'x-updated': i.updated,
        },
      })
    }

    if (req.method === 'PUT') {
      // 書きこみは IP ごとに回数を制限する(wrangler.jsonc の ratelimits)。
      // 正規の利用は 10 秒に 1 回程度。RATE_LIMIT=off はローカルのテスト用
      if (env.RATE_LIMIT !== 'off') {
        const ip = req.headers.get('cf-connecting-ip') ?? 'unknown'
        const { success } = await env.WRITE_LIMIT.limit({ key: ip })
        if (!success) return json({ error: 'rate limited' }, 429)
      }
      if (Number(req.headers.get('content-length')) > MAX_BYTES) return json({ error: 'too large' }, 413)
      const body = await req.arrayBuffer()
      if (body.byteLength > MAX_BYTES) return json({ error: 'too large' }, 413)

      // クライアントが最後に同期した version と、いまの R2 上の version が違えば、
      // 別の場所で更新されているので上書きさせない
      const base = Number(req.headers.get('x-base')) || 0
      const head = await env.BUCKET.head(key)
      if (head && head.uploaded.getTime() !== base) return json(info(head), 409)

      let o
      try {
        o = await env.BUCKET.put(key, body, {
          // head と put の間に別の書きこみが入った場合も失敗させる。
          // 新規のときは「まだ存在しないこと」を条件にする
          onlyIf: head ? { etagMatches: head.etag } : new Headers({ 'if-none-match': '*' }),
          httpMetadata: { contentType: 'text/plain; charset=utf-8' },
          customMetadata: {
            name: (req.headers.get('x-name') ?? '').slice(0, 1024),
            updated: String(Number(req.headers.get('x-updated')) || Date.now()),
          },
        })
      } catch {
        // 同じキーへの同時書きこみなど。クライアントが再試行する
        return json({ error: 'retry' }, 503)
      }
      if (!o) {
        const cur = await env.BUCKET.head(key)
        return cur ? json(info(cur), 409) : json({ error: 'retry' }, 503)
      }
      return json(info(o))
    }

    return json({ error: 'method not allowed' }, 405)
  },
}
