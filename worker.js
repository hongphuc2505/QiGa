// ============================================================
//  Sổ Tay — máy chủ đồng bộ lịch (Cloudflare Worker)
//  Dán TOÀN BỘ file này vào Worker. Cần 1 KV binding tên: SOTAY
// ============================================================

// File lời chúc trên GitHub (mỗi dòng một câu). Sửa file này là lời chúc đổi theo.
import { DurableObject } from 'cloudflare:workers';
const SERVER_V = 6; // phiên bản máy chủ, app hiện ở tab Khác

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
  const dates = Object.values(room.dates || {}).filter(e => !e.deleted && e.title).map(e => Object.assign({}, e, { title: '💌 ' + e.title.replace(/^📌\s*/, ''), note: [e.place, e.note].filter(Boolean).join(' · '), date2: true }));
  for (const e of Object.values(room.events || {}).concat(dates)) {
    if (e.deleted || !e.date || e.date < from) continue;
    const d = e.date.replace(/-/g, '');
    const tt = e.date2 ? e.title : '📌 ' + e.title, uidp = e.date2 ? 'hd' : 'ev';
    if (e.time) out.push({ uid: `${uidp}-${e.id}@sotay`, date: d, time: e.time.replace(':', ''), dur: e.date2 ? 120 : 30, title: tt, desc: e.note || '', alarms: [e.date2 ? '-PT2H' : '-PT30M'] });
    else {
      const t = new Date(Date.UTC(+e.date.slice(0, 4), +e.date.slice(5, 7) - 1, +e.date.slice(8, 10) + 1));
      out.push({ uid: `${uidp}-${e.id}@sotay`, date: d, end: ymdOf(t).replace(/-/g, ''), title: tt, desc: e.note || '', alarms: ['PT8H'] });
    }
  }
  return out;
}

const lww = (a, b) => { // gộp từng mục theo thời gian sửa, mục mới nhất thắng
  const out = Object.assign({}, a || {});
  for (const [id, e] of Object.entries(b || {})) {
    if (!e || typeof e !== 'object') continue;
    if (!out[id] || (+e.updated || 0) > (+out[id].updated || 0)) out[id] = e;
  }
  return out;
};
const newer = (a, b) => (b && typeof b === 'object' && (+b.at || 0) > ((a && +a.at) || 0)) ? b : a;
const cleanStr = (v, n) => String(v == null ? '' : v).slice(0, n);
function cleanPerson(p) {
  const o = { name: cleanStr(p.name, 40), at: +p.at || 0 };
  if (p.mood && p.mood.v) o.mood = { v: cleanStr(p.mood.v, 12), emo: cleanStr(p.mood.emo, 8), label: cleanStr(p.mood.label, 40), tip: cleanStr(p.mood.tip, 80), note: cleanStr(p.mood.note, 120), at: +p.mood.at || 0 };
  if (p.loc && p.loc.hidden) o.loc = { hidden: true, until: +p.loc.until || 0, at: +p.loc.at || 0 };
  else if (p.loc && isFinite(p.loc.lat) && isFinite(p.loc.lng)) o.loc = { lat: +(+p.loc.lat).toFixed(5), lng: +(+p.loc.lng).toFixed(5), acc: Math.round(+p.loc.acc || 0), at: +p.loc.at || 0, auto: !!p.loc.auto };
  if (p.home && p.home.at) o.home = { at: +p.home.at };
  if (typeof p.avatar === 'string') { o.avatar = cleanStr(p.avatar, 40); o.avatarAt = +p.avatarAt || 0; }
  if (p.place && p.place.at) o.place = isFinite(p.place.lat) && isFinite(p.place.lng) ? { lat: +(+p.place.lat).toFixed(5), lng: +(+p.place.lng).toFixed(5), at: +p.place.at } : { at: +p.place.at };
  return o;
}
function onlyAnnounced(inc, ann) {
  const out = { meta: {} };
  for (const c of COLLS) { out[c] = {}; for (const [id, e] of Object.entries(inc[c] || {})) if (e && ann.has(`${c}:${id}:${e.updated}`)) out[c][id] = e; }
  const st = inc.meta && inc.meta.start; if (st && ann.has(`meta:start:${st.updated}`)) out.meta.start = st;
  return out;
}
function withoutAnnounced(cur, ann) { // bản cũ của máy chủ có thể đã có mục này (lần báo trước bị lỗi) → vẫn coi là mới so với bản trước đó
  const out = Object.assign({}, cur);
  for (const c of COLLS) { if (!cur[c]) continue; const m = {}; for (const [id, e] of Object.entries(cur[c])) if (!(e && ann.has(`${c}:${id}:${e.updated}`))) m[id] = e; out[c] = m; }
  return out;
}
function lockLetters(room, dev) { // trước giờ mở, máy nhận chỉ thấy phong thư khóa
  if (!room.letters) return room;
  const out = Object.assign({}, room, { letters: {} }), now = Date.now();
  for (const [id, l] of Object.entries(room.letters)) out.letters[id] = l && !l.deleted && l.dev !== dev && +l.openAt > now ? Object.assign({}, l, { body: '', locked: true }, l.hideTitle ? { title: '' } : {}) : l;
  return out;
}
async function runLetters(env, when) {
  const raw = await env.SOTAY.get('letter-index'); if (!raw) return;
  const li = JSON.parse(raw), due = li.filter(x => x.at <= when), rest = li.filter(x => x.at > when);
  if (!due.length) return;
  for (const x of due) await sendToRoom(env, x.room, x.dev, { title: `💌 Thư của ${x.from || 'người ấy'} mở được rồi!`, body: x.title ? `"${x.title}" · bấm để đọc` : 'Bấm để đọc nha', tab: 'us', usp: 'letters' });
  await env.SOTAY.put('letter-index', JSON.stringify(rest));
}
const COLLS = ['events', 'specials', 'dates', 'bucket', 'jar', 'moods', 'foods', 'letters', 'coupons', 'days'];
function mergeRoom(cur, inc) {
  inc = inc || {};
  const out = { meta: lww(cur.meta, inc.meta) };
  const cutoff = Date.now() - 60 * 864e5; // dọn các mục đã xóa quá 60 ngày
  for (const c of COLLS) {
    const m = lww(cur[c], inc[c]);
    if (c === 'letters') for (let [id, e] of Object.entries(m)) { const o = (cur.letters || {})[id]; if (e && !e.deleted && o) { if (!e.body && o.body) m[id] = e = Object.assign({}, e, { body: o.body }); if (!e.title && o.title) m[id] = Object.assign({}, e, { title: o.title }); } }
    for (const [id, e] of Object.entries(m)) if (e.deleted && (+e.updated || 0) < cutoff) delete m[id];
    out[c] = m;
  }
  const people = Object.assign({}, cur.people || {});
  for (const [dev, p] of Object.entries(inc.people || {})) {
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(dev) || !p || typeof p !== 'object') continue;
    const c = cleanPerson(p), o = people[dev] || {};
    const m = { name: c.name || o.name || '', at: c.at - (o.at || 0) > 15 * 60000 ? c.at : (o.at || c.at) }; // chỉ ghi lại giờ mở app mỗi 15 phút cho đỡ tốn lượt ghi
    for (const f of ['mood', 'loc', 'home', 'place']) { const v = newer(o[f], c[f]); if (v) m[f] = v; }
    if (c.avatar !== undefined && (c.avatarAt || 0) >= (o.avatarAt || 0)) { m.avatar = c.avatar; m.avatarAt = c.avatarAt; } else if (o.avatar !== undefined) { m.avatar = o.avatar; m.avatarAt = o.avatarAt; }
    people[dev] = m;
  }
  const ids = Object.keys(people).sort((a, b) => (people[b].at || 0) - (people[a].at || 0));
  for (const id of ids.slice(6)) delete people[id]; // giữ tối đa 6 máy
  const mk = Object.keys(out.moods || {});
  if (mk.length > 600) { mk.sort((a, b) => (+out.moods[b].at || 0) - (+out.moods[a].at || 0)); for (const id of mk.slice(600)) delete out.moods[id]; } // chat giữ 600 mục mới nhất
  const dk = Object.keys(out.days || {});
  if (dk.length > 500) { dk.sort().reverse(); for (const id of dk.slice(500)) delete out.days[id]; }
  out.people = people;
  return out;
}

async function buildCalendar(data, env) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const out = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//SoTay//VI', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'X-WR-CALNAME:' + icsEsc(data.name || 'Sổ Tay'), 'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H'];

  for (const e of data.events || []) out.push(...vevent(e, stamp));
  if (data.room && /^[A-Za-z0-9_-]{8,64}$/.test(data.room)) {
    const room = await readRoom(env, data.room);
    if (room) for (const e of roomEvents(room, data)) out.push(...vevent(e, stamp));
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
const fmtD = d => { if (!d) return ''; const [y, m, dd] = String(d).split('-'); return `${+dd}/${+m}/${y}`; };
function describeUs(cur, inc) {
  const recent = Date.now() - 10 * 60000, out = [];
  for (const [id, e] of Object.entries((inc && inc.specials) || {})) {
    if (!e || (+e.updated || 0) < recent) continue;
    const old = (cur.specials || {})[id];
    if (old && (+e.updated || 0) <= (+old.updated || 0)) continue;
    if (e.deleted) { if (old && !old.deleted) out.push(`đã xóa ngày đặc biệt: ${old.name}`); }
    else out.push(`${old && !old.deleted ? 'đã sửa' : 'vừa thêm'} ngày đặc biệt: ${e.name} · ${fmtD(e.date)}`);
  }
  const st = inc && inc.meta && inc.meta.start, ost = cur.meta && cur.meta.start;
  if (st && (+st.updated || 0) >= recent && (!ost || (+st.updated || 0) > (+ost.updated || 0)) && (!ost || ost.v !== st.v))
    out.push(st.v ? `đã đặt ngày bắt đầu yêu: ${fmtD(st.v)}` : 'đã xóa ngày bắt đầu yêu');
  return out;
}
const dm = d => { if (!d) return ''; const [, m, dd] = String(d).split('-'); return `${+dd}/${+m}`; };
const clip = (t, n = 60) => { t = String(t || ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
function describeColls(cur, inc) {
  const recent = Date.now() - 10 * 60000, out = [];
  const walk = (c, fn) => {
    for (const [id, e] of Object.entries((inc && inc[c]) || {})) {
      if (!e || (+e.updated || 0) < recent) continue;
      const old = (cur[c] || {})[id];
      if (old && (+e.updated || 0) <= (+old.updated || 0)) continue;
      const line = fn(e, old && !old.deleted ? old : null);
      if (line) out.push(line);
    }
  };
  walk('dates', (e, o) => {
    if (e.deleted) return o ? { icon: '💌', text: `đã hủy buổi hẹn: ${clip(o.title)}` } : null;
    if (!o) return { icon: '💌', text: `vừa hẹn: ${clip(e.title)} · ${dm(e.date)}${e.time ? ' ' + e.time : ''}` };
    if (e.photo && e.photo !== o.photo) return { icon: '📸', text: `vừa thêm ảnh kỷ niệm: ${clip(e.title)}` };
    const nn = e.notes || {}, on = o.notes || {};
    for (const k of Object.keys(nn)) if (nn[k] && nn[k] !== on[k]) return { icon: '📝', text: `viết kỷ niệm "${clip(e.title, 30)}": ${clip(nn[k])}` };
    if (e.date !== o.date || e.time !== o.time) return { icon: '💌', text: `đã dời buổi hẹn: ${clip(e.title)} → ${dm(e.date)}${e.time ? ' ' + e.time : ''}` };
    return { icon: '💌', text: `đã sửa buổi hẹn: ${clip(e.title)}` };
  });
  walk('bucket', (e, o) => {
    if (e.deleted) return null;
    if (!o) return { icon: '✨', text: `thêm vào "Cùng nhau làm": ${clip(e.text)}` };
    if (e.done && !o.done) return { icon: '🎉', text: `đánh dấu đã cùng làm: ${clip(e.text)}` };
    return null;
  });
  walk('jar', (e, o) => {
    if (e.deleted) return null;
    if (!o) return { icon: '🫙', text: `vừa bỏ vào hũ: ${clip(e.text)}` };
    if (e.done && !o.done) return { icon: '🎁', text: `đã thực hiện điều trong hũ: ${clip(e.text)}` };
    if ((+e.count || 0) > (+o.count || 0)) return { icon: '🎁', text: `đã thực hiện điều trong hũ (lần ${+e.count}): ${clip(e.text)} · vẫn để trong hũ` };
    return null;
  });
  walk('letters', (e, o) => {
    if (e.deleted || o) return null;
    const d = new Date(+e.openAt + 7 * 3600e3);
    return { icon: '💌', text: `gửi một lá thư hẹn giờ 🔒 · mở được lúc ${d.getUTCHours()}:${pad(d.getUTCMinutes())} ${d.getUTCDate()}/${d.getUTCMonth() + 1}` };
  });
  walk('coupons', (e, o) => {
    if (e.deleted) return null;
    const q = Math.max(1, +e.qty || 1), nu = Array.isArray(e.uses) ? e.uses.length : (e.used ? 1 : 0), ou = o ? (Array.isArray(o.uses) ? o.uses.length : (o.used ? 1 : 0)) : 0;
    if (!o) return { icon: '🎟️', text: `tặng một phiếu: ${e.icon || ''} ${clip(e.title, 50)}${q > 1 ? ' ×' + q : ''}` };
    const oq = o ? Math.max(1, +o.qty || 1) : 0;
    if (o && q > oq) return { icon: '🎟️', text: `tặng thêm ${q - oq} lần phiếu: ${e.icon || ''} ${clip(e.title, 50)} · còn ${q - nu} lần` };
    if (nu > ou) return { icon: '🎟️', text: `vừa dùng phiếu: ${e.icon || ''} ${clip(e.title, 50)}${q > 1 ? ` (lần ${nu}/${q})` : ''}` };
    return null;
  });
  walk('foods', (e, o) => {
    if (e.deleted || o) return null;
    return { icon: '🍜', text: `vừa đăng món: ${clip(e.name)}${e.place ? ' · ' + clip(e.place, 30) : ''} ${'❤️'.repeat(Math.min(5, +e.rate || 0))}` };
  });
  return out;
}
const R = 6371;
function distKm(a, b) {
  const t = x => x * Math.PI / 180, dLa = t(b.lat - a.lat), dLo = t(b.lng - a.lng);
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(t(a.lat)) * Math.cos(t(b.lat)) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const fmtKm = d => d < 1 ? `${Math.round(d * 1000 / 10) * 10} m` : `${d < 10 ? d.toFixed(1).replace('.', ',') : Math.round(d)} km`;
function describePeople(cur, merged, dev, name, inc, ann) {
  const recent = Date.now() - 10 * 60000, out = [];
  const ok = (f, x) => ann ? ann.has(`p:${f}:${x.at}`) : true; // máy gửi báo mục nào thì mới thông báo mục đó
  const before = (cur.people || {})[dev] || {}, now = (merged.people || {})[dev] || {};
  const who = name || now.name || 'Người ấy';
  if (now.mood && now.mood.at >= recent && ok('mood', now.mood) && (ann || !before.mood || now.mood.at > before.mood.at))
    out.push({ title: `${now.mood.emo || '💗'} ${who} ${now.mood.label || 'vừa gửi tâm trạng'}`, body: now.mood.note ? `“${now.mood.note}”` : (now.mood.tip || 'Mở Sổ Tay xem nha'), tab: 'today' });
  if (now.loc && !now.loc.hidden && !now.loc.auto && now.loc.at >= recent && ok('loc', now.loc) && (ann || !before.loc || now.loc.at > before.loc.at)) {
    const others = Object.entries(merged.people || {}).filter(([id, p]) => id !== dev && p.loc && !p.loc.hidden).map(([, p]) => p.loc);
    const d = others.length ? distKm(now.loc, others.sort((a, b) => b.at - a.at)[0]) : null;
    out.push({ title: `📍 ${who} vừa gửi vị trí`, body: d != null ? `Đang cách nhau khoảng ${fmtKm(d)} · bấm để xem` : 'Bấm để xem trên bản đồ', tab: 'us', usp: 'loc' });
  }
  if (now.home && now.home.at >= recent && ok('home', now.home) && (ann || !before.home || now.home.at > before.home.at))
    out.push({ title: `🏠 ${who} về tới nhà rồi`, body: 'Yên tâm nha 💕', tab: 'today' });
  if (out.length) { // gửi kèm dữ liệu mới để app đang mở hiện ngay, không phải chờ máy chủ
    const peer = { dev, name: now.name, at: now.at };
    for (const f of ['mood', 'loc', 'home']) if (now[f]) peer[f] = now[f];
    const hist = Object.values((inc && inc.moods) || {}).filter(x => x && !x.deleted && x.dev === dev && (+x.at || 0) >= recent)
      .sort((a, b) => b.at - a.at).slice(0, 3).map(x => ({ id: cleanStr(x.id, 40), kind: cleanStr(x.kind, 8), dev, name: cleanStr(x.name, 40), v: cleanStr(x.v, 12), note: cleanStr(x.note, 120), at: +x.at, updated: +x.updated || +x.at }));
    for (const m of out) { m.peer = peer; m.hist = hist; }
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

async function updateMedIndex(env, key, on) {
  const idx = JSON.parse((await env.SOTAY.get('mp-index')) || '[]');
  const has = idx.includes(key);
  if (on && !has) { idx.push(key); await env.SOTAY.put('mp-index', JSON.stringify(idx)); }
  if (!on && has) await env.SOTAY.put('mp-index', JSON.stringify(idx.filter(k => k !== key)));
}

async function sendToRoom(env, room, exceptDevice, msg) {
  if (!room) return;
  const raw = await env.SOTAY.get('push:' + room);
  if (!raw) return;
  const reg = JSON.parse(raw), vapid = await getVapid(env);
  let dirty = false;
  for (const [id, d] of Object.entries(reg.devices || {})) {
    if (id === exceptDevice || !d.sub) continue;
    try { const r = await sendPush(d.sub, msg, vapid); if (r.status === 404 || r.status === 410) { delete reg.devices[id]; dirty = true; } } catch (err) {}
  }
  if (dirty) await env.SOTAY.put('push:' + room, JSON.stringify(reg));
}

async function runMedReminders(env, when) {
  const idx = JSON.parse((await env.SOTAY.get('mp-index')) || '[]');
  if (!idx.length) return;
  const vapid = await getVapid(env);
  for (const key of idx) {
    const raw = await env.SOTAY.get('cal:' + key);
    if (!raw) continue;
    const data = JSON.parse(raw), sub = data.medPush && data.medPush.sub;
    const off = typeof data.tzOffset === 'number' ? data.tzOffset : -420;
    const stamp = mins => { const t = new Date(when - mins * 60000 - off * 60000);
      return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}T${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`; };
    const [s0, s15, s30, s60] = [0, 15, 30, 60].map(stamp);
    const who = data.me || 'Người ấy';
    for (const d of data.doses || []) {
      const own = async msg => { if (!sub) return; try { const r = await sendPush(sub, msg, vapid); if (r.status === 404 || r.status === 410) { /* hết hạn */ } } catch (err) {} };
      if (d.at === s0) await own({ title: '💊 Đến giờ uống thuốc', body: `${d.meds} · ${d.time} · bấm để đánh dấu đã uống` });
      else if (d.at === s15 || d.at === s30) await own({ title: '⏰ Nhớ uống thuốc nha', body: `${d.meds} · từ ${d.time} · chưa đánh dấu đã uống` });
      else if (d.at === s60) {
        await own({ title: '⏰ Đã quá giờ uống thuốc 1 tiếng', body: `${d.meds} · ${d.time} · uống xong nhớ tick nha` });
        await sendToRoom(env, data.room, data.device, { title: `⚠️ ${who} chưa uống thuốc`, body: `${d.meds} · ${d.time} · đã quá 1 tiếng chưa tick`, tab: 'us', usp: 'moods' });
        if (data.room && /^[A-Za-z0-9_-]{8,64}$/.test(data.room)) { // ghi vào chat chung
          const id = 'late-' + key.slice(0, 8) + d.at.replace(/[^0-9]/g, '');
          await appendRoom(env, data.room, { id, kind: 'act', icon: '⚠️', text: `chưa tick thuốc ${d.meds} (${d.time}) sau 1 tiếng`, dev: data.device || '', name: who, at: when, updated: when });
        }
      }
    }
  }
}

// ---- phòng chung của hai máy: đọc/ghi qua một "store" (Durable Object, hoặc KV nếu chưa có) ----
async function roomRequest(env, code, req, store) {
  const cur = (await store.get()) || { events: {} };
    if (req.method === 'PUT') {
    const body = await req.text();
    if (body.length > 600000) return new Response('Dữ liệu quá lớn', { status: 413, headers: CORS });
    let inc; try { inc = JSON.parse(body); } catch (err) { return new Response('Sai định dạng', { status: 400, headers: CORS }); }
    const dev = String(inc.device || ''), who = String(inc.name || '').slice(0, 40);
    const ann = Array.isArray(inc.announce) ? new Set(inc.announce.slice(0, 200).map(String)) : null;
    const incA = ann ? onlyAnnounced(inc, ann) : inc, curA = ann ? withoutAnnounced(cur, ann) : cur;
    const changes = describeChanges(curA, incA), usLines = describeUs(curA, incA), collLines = describeColls(curA, incA);
    const merged = mergeRoom(cur, inc);
    const pplMsgs = describePeople(cur, merged, dev, who, inc, ann);
    if (JSON.stringify(merged) !== JSON.stringify(cur)) await store.put(merged);
    const jobs = [];
    if (changes.length) jobs.push(notifyRoom(env, code, dev, who, changes));
    if (usLines.length) jobs.push(sendToRoom(env, code, dev, { title: `💞 ${who || 'Người ấy'} ${usLines[0]}`, body: usLines.length > 1 ? usLines.slice(1, 4).join('\n') : 'Mở tab Hai đứa xem nha' }));
    if (collLines.length && collLines.length <= 3) for (const l of collLines) jobs.push(sendToRoom(env, code, dev, { title: `${l.icon} ${who || 'Người ấy'} ${l.text}`, body: 'Bấm để xem trong Chat' }));
    else if (collLines.length) jobs.push(sendToRoom(env, code, dev, collLines.length === 1
      ? { title: `${collLines[0].icon} ${who || 'Người ấy'} ${collLines[0].text}`, body: 'Mở tab Hai đứa xem nha' }
      : { title: `${collLines[0].icon} ${who || 'Người ấy'} vừa cập nhật ${collLines.length} mục`, body: collLines.slice(0, 4).map(l => l.icon + ' ' + l.text).join('\n') }));
    for (const m of pplMsgs) jobs.push(sendToRoom(env, code, dev, m));
    const recentT = Date.now() - 10 * 60000;
    const chats = Object.values(inc.moods || {}).filter(x => x && (x.kind === 'msg' || x.kind === 'touch') && !x.deleted && x.dev === dev && (+x.at || 0) >= recentT && (ann ? ann.has(`moods:${x.id}:${x.updated}`) : !(cur.moods || {})[x.id])).sort((a, b) => a.at - b.at).slice(-3);
    for (const x of chats) jobs.push(sendToRoom(env, code, dev, x.kind === 'touch'
      ? { title: `${x.t === 'hug' ? '🤗' : '💗'} ${who || 'Người ấy'} ${clip(x.text, 60)}`, body: 'Mở app nhận nha', tab: 'today',
          hist: [{ id: cleanStr(x.id, 40), kind: 'touch', t: cleanStr(x.t, 8), sec: +x.sec || 0, text: cleanStr(x.text, 80), dev, name: who, at: +x.at, updated: +x.updated || +x.at }] }
      : { title: `💬 ${who || 'Người ấy'}`, body: clip(x.note, 160), tab: 'us', usp: 'moods',
          hist: [{ id: cleanStr(x.id, 40), kind: 'msg', dev, name: who, note: cleanStr(x.note, 300), at: +x.at, updated: +x.updated || +x.at }] }));
    if (jobs.length) await Promise.all(jobs.map(j => j.catch(() => {})));
    { // thêm thư mới vào lịch mở
      const fresh = Object.values(inc.letters || {}).filter(l => l && !l.deleted && l.dev === dev && +l.openAt > Date.now() && !(cur.letters || {})[l.id]);
      if (fresh.length) { const li = JSON.parse((await env.SOTAY.get('letter-index')) || '[]'); for (const l of fresh) li.push({ room: code, id: l.id, at: +l.openAt, dev, from: who, title: l.hideTitle ? '' : clip(l.title || '', 40) }); await env.SOTAY.put('letter-index', JSON.stringify(li)); }
    }
    return new Response(JSON.stringify(Object.assign(lockLetters(merged, dev), { sv: SERVER_V })), { headers: { ...CORS, 'Content-Type': 'application/json' } });
  }
  return new Response(JSON.stringify(Object.assign(lockLetters(cur, ''), { sv: SERVER_V })), { headers: { ...CORS, 'Content-Type': 'application/json' } });
}
const kvStore = (env, code) => ({ get: async () => JSON.parse((await env.SOTAY.get('room:' + code)) || 'null'), put: v => env.SOTAY.put('room:' + code, JSON.stringify(v)) });
const roomStub = (env, code) => env.ROOM.get(env.ROOM.idFromName(code));
async function readRoom(env, code) { // dùng cho lịch iPhone
  if (env.ROOM) { const r = await roomStub(env, code).fetch(`https://room/get/${code}`); return r.ok ? r.json() : null; }
  return kvStore(env, code).get();
}
async function appendRoom(env, code, item) { // ghi thêm 1 dòng vào chat chung (từ lịch nhắc thuốc)
  if (env.ROOM) return roomStub(env, code).fetch(`https://room/append/${code}`, { method: 'POST', body: JSON.stringify(item) });
  const st = kvStore(env, code), room = (await st.get()) || { events: {} }; room.moods = room.moods || {};
  if (!room.moods[item.id]) { room.moods[item.id] = item; await st.put(room); }
}

// Mỗi cặp một Durable Object: ghi tuần tự, không bao giờ đọc phải bản cũ → không mất dữ liệu
export class Room extends DurableObject {
  async fetch(req) {
    const url = new URL(req.url), [, op, code] = url.pathname.split('/');
    const storage = this.ctx.storage, env = this.env;
    const store = { get: async () => { let v = await storage.get('room'); if (!v && env.SOTAY) { const raw = await env.SOTAY.get('room:' + code); v = raw ? JSON.parse(raw) : null; if (v) await storage.put('room', v); } return v; }, put: v => storage.put('room', v) };
    if (op === 'get') return new Response(JSON.stringify((await store.get()) || { events: {} }), { headers: { 'Content-Type': 'application/json' } });
    if (op === 'append') { const item = await req.json(), room = (await store.get()) || { events: {} }; room.moods = room.moods || {}; if (!room.moods[item.id]) { room.moods[item.id] = item; await store.put(room); } return new Response('ok'); }
    return roomRequest(env, code, req, store);
  }
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(Promise.all([runMedReminders(env, event.scheduledTime || Date.now()), runLetters(env, event.scheduledTime || Date.now())]));
  },

  async fetch(req, env, ctx) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });
    if (url.pathname === '/vapid') {
      if (!env.SOTAY) return new Response('Thiếu KV binding tên SOTAY', { status: 500, headers: CORS });
      return json({ publicKey: (await getVapid(env)).publicKey });
    }
    if (url.pathname === '/test-push' && req.method === 'PUT') {
      let b; try { b = JSON.parse(await req.text()); } catch (err) { return new Response('Sai định dạng', { status: 400, headers: CORS }); }
      if (!b.sub || !b.sub.endpoint) return new Response('Thiếu sub', { status: 400, headers: CORS });
      const r = await sendPush(b.sub, { title: 'Sổ Tay', body: 'Đã bật thông báo 🔔' }, await getVapid(env));
      return json({ ok: r.ok, status: r.status });
    }
    const nm = url.pathname.match(/^\/notify\/([A-Za-z0-9_-]{8,64})\/([A-Za-z0-9_-]{8,64})$/);
    if (nm && req.method === 'PUT') {
      let b; try { b = JSON.parse(await req.text()); } catch (err) { return new Response('Sai định dạng', { status: 400, headers: CORS }); }
      const msg = { title: String(b.title || 'Sổ Tay').slice(0, 80), body: String(b.body || '').slice(0, 200) };
      const p = sendToRoom(env, nm[1], nm[2], msg);
      if (ctx && ctx.waitUntil) ctx.waitUntil(p); else await p;
      return json({ ok: true });
    }
    const ph = url.pathname.match(/^\/photo\/([A-Za-z0-9_-]{8,64})\/([A-Za-z0-9_-]{6,40})$/);
    if (ph) {
      const pk = `ph:${ph[1]}:${ph[2]}`;
      if (req.method === 'PUT') {
        const buf = await req.arrayBuffer();
        if (buf.byteLength > 1500000) return new Response('Ảnh quá lớn', { status: 413, headers: CORS });
        const type = /^image\/(jpeg|png|webp)$/.test(req.headers.get('Content-Type') || '') ? req.headers.get('Content-Type') : 'image/jpeg';
        await env.SOTAY.put(pk, buf, { metadata: { type } });
        return json({ ok: true });
      }
      if (req.method === 'DELETE') { await env.SOTAY.delete(pk); return json({ ok: true }); }
      const got = await env.SOTAY.getWithMetadata(pk, 'arrayBuffer');
      if (!got || !got.value) return new Response('Không có ảnh', { status: 404, headers: CORS });
      return new Response(got.value, { headers: { ...CORS, 'Content-Type': (got.metadata && got.metadata.type) || 'image/jpeg', 'Cache-Control': 'public, max-age=31536000, immutable' } });
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
      if (env.ROOM) { const body = req.method === 'PUT' ? await req.text() : undefined; return roomStub(env, r[1]).fetch(`https://room/room/${r[1]}`, { method: req.method, body }); }
      return roomRequest(env, r[1], req, kvStore(env, r[1]));
    }
    const m = url.pathname.match(/^\/cal\/([A-Za-z0-9_-]{20,64})(?:\.ics)?$/);
    if (!m) return new Response('Sổ Tay sync đang chạy ✅', { headers: { ...CORS, 'Content-Type': 'text/plain; charset=utf-8' } });
    if (!env.SOTAY) return new Response('Thiếu KV binding tên SOTAY', { status: 500, headers: CORS });
    const key = 'cal:' + m[1];

    if (req.method === 'PUT') {
      const body = await req.text();
      if (body.length > 300000) return new Response('Dữ liệu quá lớn', { status: 413, headers: CORS });
      let parsed; try { parsed = JSON.parse(body); } catch (err) { return new Response('Sai định dạng', { status: 400, headers: CORS }); }
      await env.SOTAY.put(key, body);
      await updateMedIndex(env, m[1], !!((parsed.medPush && parsed.medPush.sub) || parsed.room) && Array.isArray(parsed.doses) && parsed.doses.length > 0);
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
