// ============================================================
//  Sổ Tay — máy chủ đồng bộ lịch (Cloudflare Worker)
//  Dán TOÀN BỘ file này vào Worker. Cần 1 KV binding tên: SOTAY
// ============================================================

// File lời chúc trên GitHub (mỗi dòng một câu). Sửa file này là lời chúc đổi theo.
const LOVE_URL = 'https://hongphuc2505.github.io/QiGa/loichuc.txt';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

const pad = n => String(n).padStart(2, '0');
const icsEsc = s => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

function fold(line) {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const parts = []; let cur = ''; let limit = 75;
  for (const ch of line) {
    if (enc.encode(cur + ch).length > limit) { parts.push(cur); cur = ch; limit = 74; }
    else cur += ch;
  }
  parts.push(cur);
  return parts.join('\r\n ');
}

function vevent(e, stamp) {
  const L = ['BEGIN:VEVENT', 'UID:' + e.uid, 'DTSTAMP:' + stamp];
  if (e.time) L.push(`DTSTART:${e.date}T${e.time}00`, `DURATION:PT${e.dur || 10}M`);
  else L.push(`DTSTART;VALUE=DATE:${e.date}`, `DTEND;VALUE=DATE:${e.end || e.date}`, 'TRANSP:TRANSPARENT');
  if (e.rrule) L.push('RRULE:' + e.rrule);
  L.push('SUMMARY:' + icsEsc(e.title));
  if (e.desc) L.push('DESCRIPTION:' + icsEsc(e.desc));
  for (const a of e.alarms || []) L.push('BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:' + icsEsc(e.title), 'TRIGGER:' + a, 'END:VALARM');
  L.push('END:VEVENT');
  return L;
}

function fillLove(t, lv) {
  const cap = x => x ? x[0].toUpperCase() + x.slice(1) : x;
  const a = lv.from || 'anh', e = lv.to || 'em';
  return cap(String(t).replace(/\{a\}/g, a).replace(/\{A\}/g, cap(a)).replace(/\{e\}/g, e).replace(/\{E\}/g, cap(e)));
}

async function loveLines(fallback) {
  try {
    const r = await fetch(LOVE_URL, { cf: { cacheTtl: 300 } });
    if (r.ok) {
      const lines = (await r.text()).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      if (lines.length) return lines;
    }
  } catch (err) { /* dùng danh sách dự phòng */ }
  return Array.isArray(fallback) ? fallback : [];
}

const ymdOf = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

function roomEvents(room, data) {
  const out = [];
  const offset = typeof data.tzOffset === 'number' ? data.tzOffset : -420;
  const now = new Date(Date.now() - offset * 60000);
  const from = ymdOf(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1)));
  for (const e of Object.values(room.events || {})) {
    if (e.deleted || !e.date || e.date < from) continue;
    const d = e.date.replace(/-/g, '');
    if (e.time) out.push({ uid: `ev-${e.id}@sotay`, date: d, time: e.time.replace(':', ''), dur: 30, title: '📌 ' + e.title, desc: e.note || '', alarms: ['-PT30M'] });
    else {
      const t = new Date(Date.UTC(+e.date.slice(0, 4), +e.date.slice(5, 7) - 1, +e.date.slice(8, 10) + 1));
      out.push({ uid: `ev-${e.id}@sotay`, date: d, end: ymdOf(t).replace(/-/g, ''), title: '📌 ' + e.title, desc: e.note || '', alarms: ['PT8H'] });
    }
  }
  return out;
}

function mergeRoom(cur, inc) {
  const ev = Object.assign({}, cur.events || {});
  for (const [id, e] of Object.entries((inc && inc.events) || {})) {
    if (!e || typeof e !== 'object') continue;
    if (!ev[id] || (+e.updated || 0) > (+ev[id].updated || 0)) ev[id] = e;
  }
  const cutoff = Date.now() - 60 * 864e5; // dọn các mục đã xóa quá 60 ngày
  for (const [id, e] of Object.entries(ev)) if (e.deleted && (+e.updated || 0) < cutoff) delete ev[id];
  return { events: ev };
}

async function buildCalendar(data, env) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const out = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//SoTay//VI', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'X-WR-CALNAME:' + icsEsc(data.name || 'Sổ Tay'), 'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H'];

  for (const e of data.events || []) out.push(...vevent(e, stamp));
  if (data.room && /^[A-Za-z0-9_-]{8,64}$/.test(data.room)) {
    const raw = await env.SOTAY.get('room:' + data.room);
    if (raw) for (const e of roomEvents(JSON.parse(raw), data)) out.push(...vevent(e, stamp));
  }

  const lv = data.love;
  if (lv && lv.enabled) {
    const lines = await loveLines(lv.fallback);
    if (lines.length) {
      const offset = typeof data.tzOffset === 'number' ? data.tzOffset : -420; // mặc định giờ Việt Nam
      const now = new Date(Date.now() - offset * 60000);
      const hm = (lv.time || '08:00').replace(':', '');
      for (let i = -1; i < 30; i++) {
        const t = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + i));
        const n = Math.round(t.getTime() / 864e5);
        const msg = fillLove(lines[((n * 7919) % lines.length + lines.length) % lines.length], lv);
        const ds = `${t.getUTCFullYear()}${pad(t.getUTCMonth() + 1)}${pad(t.getUTCDate())}`;
        out.push(...vevent({ uid: `love-${ds}@sotay`, date: ds, time: hm, dur: 5, title: `💌 ${lv.title || 'Lời chúc'}: ${msg}`, alarms: ['PT0M'] }, stamp));
      }
    }
  }
  out.push('END:VCALENDAR');
  return out.map(fold).join('\r\n') + '\r\n';
}

// ---------------- Thông báo đẩy (Web Push) ----------------
const PUSH_SUB = 'https://hongphuc2505.github.io/QiGa/';
const enc = new TextEncoder();
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const ub64 = s => { s = s.replace(/-/g, '+').replace(/_/g, '/'); s += '='.repeat((4 - s.length % 4) % 4); return Uint8Array.from(atob(s), c => c.charCodeAt(0)); };
const concat = (...arrs) => { const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0)); let o = 0; for (const a of arrs) { out.set(a, o); o += a.length; } return out; };

async function getVapid(env) {
  const raw = await env.SOTAY.get('vapid');
  if (raw) return JSON.parse(raw);
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const v = { publicKey: b64u(await crypto.subtle.exportKey('raw', kp.publicKey)), privateJwk: await crypto.subtle.exportKey('jwk', kp.privateKey) };
  await env.SOTAY.put('vapid', JSON.stringify(v));
  return v;
}

async function hkdf(salt, ikm, info, len) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, len * 8));
}

async function encryptPayload(sub, text) {
  const uaPub = ub64(sub.keys.p256dh), auth = ub64(sub.keys.auth);
  const as = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256));
  const ikm = await hkdf(auth, shared, concat(enc.encode('WebPush: info\0'), uaPub, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, concat(enc.encode(text), new Uint8Array([2]))));
  const header = new Uint8Array(21); header.set(salt, 0); new DataView(header.buffer).setUint32(16, 4096); header[20] = 65;
  return concat(header, asPub, ct);
}

async function vapidAuth(endpoint, vapid) {
  const aud = new URL(endpoint).origin;
  const h = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const p = b64u(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: PUSH_SUB })));
  const key = await crypto.subtle.importKey('jwk', vapid.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(h + '.' + p));
  return `vapid t=${h}.${p}.${b64u(sig)}, k=${vapid.publicKey}`;
}

async function sendPush(sub, msg, vapid) {
  const body = await encryptPayload(sub, JSON.stringify(msg));
  return fetch(sub.endpoint, { method: 'POST', body, headers: {
    'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: 'high',
    Authorization: await vapidAuth(sub.endpoint, vapid) } });
}

function describeChanges(cur, inc) {
  const recent = Date.now() - 10 * 60000, out = [];
  for (const [id, e] of Object.entries((inc && inc.events) || {})) {
    if (!e || (+e.updated || 0) < recent) continue;
    const old = (cur.events || {})[id];
    if (old && (+e.updated || 0) <= (+old.updated || 0)) continue;
    if (e.deleted) { if (old && !old.deleted) out.push({ verb: 'đã xóa', e: old }); }
    else out.push({ verb: old && !old.deleted ? 'đã sửa' : 'vừa thêm', e });
  }
  return out;
}
const fmtEv = e => { if (!e || !e.date) return ''; const [y, m, d] = e.date.split('-'); return `${e.title} · ${+d}/${+m}${e.time ? ' ' + e.time : ''}`; };

async function notifyRoom(env, room, fromDevice, name, changes) {
  const raw = await env.SOTAY.get('push:' + room);
  if (!raw || !changes.length) return;
  const reg = JSON.parse(raw), vapid = await getVapid(env);
  const who = name || 'Người ấy';
  const msg = changes.length === 1
    ? { title: `${who} ${changes[0].verb} sự kiện`, body: fmtEv(changes[0].e) }
    : { title: `${who} đã cập nhật ${changes.length} sự kiện`, body: changes.slice(0, 3).map(c => fmtEv(c.e)).join('\n') };
  let dirty = false;
  for (const [id, d] of Object.entries(reg.devices || {})) {
    if (id === fromDevice || !d.sub) continue;
    try {
      const r = await sendPush(d.sub, msg, vapid);
      if (r.status === 404 || r.status === 410) { delete reg.devices[id]; dirty = true; }
    } catch (err) { /* bỏ qua máy lỗi */ }
  }
  if (dirty) await env.SOTAY.put('push:' + room, JSON.stringify(reg));
}

export default {
  async fetch(req, env, ctx) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });
    if (url.pathname === '/vapid') {
      if (!env.SOTAY) return new Response('Thiếu KV binding tên SOTAY', { status: 500, headers: CORS });
      return json({ publicKey: (await getVapid(env)).publicKey });
    }
    const pm = url.pathname.match(/^\/push\/([A-Za-z0-9_-]{8,64})\/([A-Za-z0-9_-]{8,64})$/);
    if (pm) {
      const pkey = 'push:' + pm[1];
      const reg = JSON.parse((await env.SOTAY.get(pkey)) || '{"devices":{}}');
      if (req.method === 'PUT') {
        let b; try { b = JSON.parse(await req.text()); } catch (err) { return new Response('Sai định dạng', { status: 400, headers: CORS }); }
        if (!b.sub || !b.sub.endpoint || !b.sub.keys) return new Response('Thiếu sub', { status: 400, headers: CORS });
        reg.devices[pm[2]] = { sub: b.sub, name: String(b.name || '').slice(0, 40), at: Date.now() };
        await env.SOTAY.put(pkey, JSON.stringify(reg));
        if (b.test) {
          const r = await sendPush(b.sub, { title: 'Sổ Tay', body: 'Đã bật thông báo 🔔' }, await getVapid(env));
          return json({ ok: true, test: r.status });
        }
        return json({ ok: true });
      }
      if (req.method === 'DELETE') { delete reg.devices[pm[2]]; await env.SOTAY.put(pkey, JSON.stringify(reg)); return json({ ok: true }); }
      return json({ devices: Object.keys(reg.devices).length });
    }
    const r = url.pathname.match(/^\/room\/([A-Za-z0-9_-]{8,64})$/);
    if (r) {
      if (!env.SOTAY) return new Response('Thiếu KV binding tên SOTAY', { status: 500, headers: CORS });
      const rkey = 'room:' + r[1];
      const cur = JSON.parse((await env.SOTAY.get(rkey)) || '{"events":{}}');
      if (req.method === 'PUT') {
        const body = await req.text();
        if (body.length > 300000) return new Response('Dữ liệu quá lớn', { status: 413, headers: CORS });
        let inc; try { inc = JSON.parse(body); } catch (err) { return new Response('Sai định dạng', { status: 400, headers: CORS }); }
        const changes = describeChanges(cur, inc);
        const merged = mergeRoom(cur, inc);
        if (JSON.stringify(merged) !== JSON.stringify(cur)) await env.SOTAY.put(rkey, JSON.stringify(merged));
        if (changes.length) {
          const p = notifyRoom(env, r[1], String(inc.device || ''), String(inc.name || '').slice(0, 40), changes);
          if (ctx && ctx.waitUntil) ctx.waitUntil(p); else await p;
        }
        return new Response(JSON.stringify(merged), { headers: { ...CORS, 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify(cur), { headers: { ...CORS, 'Content-Type': 'application/json' } });
    }
    const m = url.pathname.match(/^\/cal\/([A-Za-z0-9_-]{20,64})(?:\.ics)?$/);
    if (!m) return new Response('Sổ Tay sync đang chạy ✅', { headers: { ...CORS, 'Content-Type': 'text/plain; charset=utf-8' } });
    if (!env.SOTAY) return new Response('Thiếu KV binding tên SOTAY', { status: 500, headers: CORS });
    const key = 'cal:' + m[1];

    if (req.method === 'PUT') {
      const body = await req.text();
      if (body.length > 300000) return new Response('Dữ liệu quá lớn', { status: 413, headers: CORS });
      try { JSON.parse(body); } catch (err) { return new Response('Sai định dạng', { status: 400, headers: CORS }); }
      await env.SOTAY.put(key, body);
      return new Response('ok', { headers: CORS });
    }

    if (req.method === 'GET') {
      const raw = await env.SOTAY.get(key);
      if (!raw) return new Response('Chưa có dữ liệu', { status: 404, headers: CORS });
      const ics = await buildCalendar(JSON.parse(raw), env);
      return new Response(ics, { headers: { ...CORS, 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'no-cache' } });
    }
    return new Response('Không hỗ trợ', { status: 405, headers: CORS });
  }
};
