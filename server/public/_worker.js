// photo-tree-share — 分享用的极简后端（Pages Functions 高级模式）
// POST /api/share   multipart/form-data，字段 photos[] 多张图片 → 返回 {id, mk}
// GET  /api/share?id=xxx             → 分享清单（不含管理密钥）
// GET  /api/photo?id=xxx&i=n         → 单张照片二进制
// DELETE /api/share?id=xxx&k=mk      → 删除分享

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

const TTL = 30 * 24 * 3600; // 30 天
const MAX_PHOTOS = 40;
const MAX_TOTAL = 40 * 1024 * 1024;

const json = (o, s = 200, extra = {}) =>
  new Response(JSON.stringify(o), {
    status: s,
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
  });

function newId(n = 10) {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  let s = '';
  for (let i = 0; i < n; i++) s += alphabet[bytes[i] % alphabet.length];
  return s;
}

const cleanId = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    try {
      if (url.pathname === '/api/health') return json({ ok: true, kv: !!env.SHARE_KV, t: Date.now() });

      if (url.pathname === '/api/share' && request.method === 'POST') {
        if (!env.SHARE_KV) return json({ error: 'storage not configured' }, 503);
        const form = await request.formData();
        const files = form
          .getAll('photos')
          .filter((f) => f && typeof f.arrayBuffer === 'function' && f.size > 0);
        if (!files.length) return json({ error: '没有收到照片' }, 400);
        if (files.length > MAX_PHOTOS) return json({ error: `一次最多 ${MAX_PHOTOS} 张` }, 400);
        let total = 0;
        for (const f of files) total += f.size;
        if (total > MAX_TOTAL) return json({ error: '照片总量过大' }, 413);

        const id = newId(10);
        const mk = newId(16);
        const items = [];
        for (let i = 0; i < files.length; i++) {
          const f = files[i];
          const key = `p:${id}:${i}`;
          await env.SHARE_KV.put(key, await f.arrayBuffer(), {
            expirationTtl: TTL,
            metadata: { t: f.type || 'image/jpeg' },
          });
          items.push({ i, t: f.type || 'image/jpeg', s: f.size });
        }
        await env.SHARE_KV.put(
          `m:${id}`,
          JSON.stringify({ v: 1, id, n: items.length, createdAt: Date.now(), items, mk }),
          { expirationTtl: TTL },
        );
        return json({ id, mk, count: items.length, expiresAt: Date.now() + TTL * 1000 });
      }

      if (url.pathname === '/api/share' && request.method === 'GET') {
        if (!env.SHARE_KV) return json({ error: 'storage not configured' }, 503);
        const id = cleanId(url.searchParams.get('id'));
        if (!id) return json({ error: '链接不完整' }, 400);
        const raw = await env.SHARE_KV.get(`m:${id}`, { cacheTtl: 60 });
        if (!raw) return json({ error: '分享不存在或已过期' }, 404);
        const m = JSON.parse(raw);
        delete m.mk;
        return json(m, 200, { 'Cache-Control': 'public, max-age=60' });
      }

      if (url.pathname === '/api/photo' && request.method === 'GET') {
        const id = cleanId(url.searchParams.get('id'));
        const i = Number(url.searchParams.get('i'));
        if (!id || !Number.isInteger(i) || i < 0 || i >= MAX_PHOTOS) return json({ error: 'bad request' }, 400);
        const obj = await env.SHARE_KV.getWithMetadata(`p:${id}:${i}`, { type: 'arrayBuffer', cacheTtl: 3600 });
        if (!obj || !obj.value) return json({ error: 'not found' }, 404);
        return new Response(obj.value, {
          headers: {
            ...CORS,
            'Content-Type': (obj.metadata && obj.metadata.t) || 'image/jpeg',
            'Cache-Control': 'public, max-age=604800, immutable',
          },
        });
      }

      if (url.pathname === '/api/share' && request.method === 'DELETE') {
        const id = cleanId(url.searchParams.get('id'));
        const k = String(url.searchParams.get('k') || '');
        if (!id || !k) return json({ error: 'bad request' }, 400);
        const raw = await env.SHARE_KV.get(`m:${id}`);
        if (!raw) return json({ ok: true }, 200);
        const m = JSON.parse(raw);
        if (m.mk !== k) return json({ error: '无权删除' }, 403);
        await Promise.all(m.items.map((it) => env.SHARE_KV.delete(`p:${id}:${it.i}`)));
        await env.SHARE_KV.delete(`m:${id}`);
        return json({ ok: true }, 200);
      }
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 500);
    }

    if (env.ASSETS) return env.ASSETS.fetch(request);
    return json({ service: 'photo-tree-share', ok: true }, 200);
  },
};
