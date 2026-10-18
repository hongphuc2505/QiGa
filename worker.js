// ============================================================
//  Sổ Tay — máy chủ đồng bộ lịch (Cloudflare Worker)
//  Dán TOÀN BỘ file này vào Worker. Cần 1 KV binding tên: SOTAY
// ============================================================

// File lời chúc trên GitHub (mỗi dòng một câu). Sửa file này là lời chúc đổi theo.
const LOVE_URL = 'https://hongphuc2505.github.io/QiGa/loichuc.txt';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
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

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    const r = url.pathname.match(/^\/room\/([A-Za-z0-9_-]{8,64})$/);
    if (r) {
      if (!env.SOTAY) return new Response('Thiếu KV binding tên SOTAY', { status: 500, headers: CORS });
      const rkey = 'room:' + r[1];
      const cur = JSON.parse((await env.SOTAY.get(rkey)) || '{"events":{}}');
      if (req.method === 'PUT') {
        const body = await req.text();
        if (body.length > 300000) return new Response('Dữ liệu quá lớn', { status: 413, headers: CORS });
        let inc; try { inc = JSON.parse(body); } catch (err) { return new Response('Sai định dạng', { status: 400, headers: CORS }); }
        const merged = mergeRoom(cur, inc);
        if (JSON.stringify(merged) !== JSON.stringify(cur)) await env.SOTAY.put(rkey, JSON.stringify(merged));
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
