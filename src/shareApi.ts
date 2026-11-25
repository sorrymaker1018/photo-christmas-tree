// 分享服务：照片上传到 Cloudflare Pages 后端（KV 存储），生成一次性随机链接
export const SHARE_API = 'https://photo-tree-share.pages.dev';

export type ShareItem = { i: number; t: string; s: number };
export type ShareManifest = { id: string; n: number; createdAt: number; items: ShareItem[] };

export const sharePhotoUrl = (id: string, i: number) =>
  `${SHARE_API}/api/photo?id=${encodeURIComponent(id)}&i=${i}`;

export const sharePageUrl = (id: string) => {
  const base = `${location.origin}${location.pathname}`;
  return `${base}?s=${encodeURIComponent(id)}`;
};

export const readShareIdFromUrl = () => {
  try {
    const v = new URLSearchParams(location.search).get('s') || '';
    return v.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);
  } catch {
    return '';
  }
};

export async function createShare(blobs: Blob[]): Promise<{ id: string; mk: string; count: number; expiresAt: number }> {
  const fd = new FormData();
  blobs.forEach((b, i) => {
    fd.append('photos', new File([b], `p${i}.jpg`, { type: b.type || 'image/jpeg' }));
  });
  const res = await fetch(`${SHARE_API}/api/share`, { method: 'POST', body: fd });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
  return data;
}

export async function fetchShare(id: string): Promise<ShareManifest> {
  const res = await fetch(`${SHARE_API}/api/share?id=${encodeURIComponent(id)}`, { cache: 'no-store' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data && data.error) || '分享不存在或已过期');
  return data as ShareManifest;
}

export async function deleteShare(id: string, mk: string): Promise<void> {
  const res = await fetch(
    `${SHARE_API}/api/share?id=${encodeURIComponent(id)}&k=${encodeURIComponent(mk)}`,
    { method: 'DELETE' },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

// --- 本机记录：每一条分享的 id + 管理密钥，只存在自己手机里，用来随时撤销 ---
type ShareRecord = { id: string; mk: string; at: number; count: number };
const LS_KEY = 'pt-share-records';

export const listShareRecords = (): ShareRecord[] => {
  try {
    const raw = localStorage.getItem(LS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
};

export const rememberShare = (r: ShareRecord) => {
  try {
    const arr = listShareRecords().filter((x) => x.id !== r.id);
    arr.unshift(r);
    localStorage.setItem(LS_KEY, JSON.stringify(arr.slice(0, 20)));
  } catch {
    // 无痕模式忽略
  }
};

export const forgetShare = (id: string) => {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(listShareRecords().filter((x) => x.id !== id)));
  } catch {
    // ignore
  }
};
