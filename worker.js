// ============================================================
//  Sổ Tay — máy chủ đồng bộ lịch (Cloudflare Worker)
//  Dán TOÀN BỘ file này vào Worker. Cần 1 KV binding tên: SOTAY
// ============================================================

// File lời chúc trên GitHub (mỗi dòng một câu). Sửa file này là lời chúc đổi theo.
import { DurableObject } from 'cloudflare:workers';
const SERVER_V = 10; // phiên bản máy chủ, app hiện ở tab Khác

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
  if (+p.seenAt) o.seenAt = +p.seenAt;
  if (+p.typingAt) o.typingAt = +p.typingAt;
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
  const now = Date.now(), cutoff = now - 60 * 864e5; // dọn các mục đã xóa quá 60 ngày
  for (const c of COLLS) {
    const m = lww(cur[c], inc[c]);
    if (c === 'letters') for (let [id, e] of Object.entries(m)) { const o = (cur.letters || {})[id]; if (e && !e.deleted && o) { if (!e.body && o.body) m[id] = e = Object.assign({}, e, { body: o.body }); if (!e.title && o.title) m[id] = Object.assign({}, e, { title: o.title }); } }
    for (const [id, e] of Object.entries(m)) if (e.deleted && (+e.updated || 0) < cutoff) delete m[id];
    const old = cur[c] || {};
    for (const [id, e] of Object.entries(m)) if (e !== old[id] && e && typeof e === 'object') m[id] = Object.assign({}, e, { _s: now });
    out[c] = m;
  }
  const people = Object.assign({}, cur.people || {});
  for (const [dev, p] of Object.entries(inc.people || {})) {
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(dev) || !p || typeof p !== 'object') continue;
    const c = cleanPerson(p), o = people[dev] || {};
    const m = { name: c.name || o.name || '', at: c.at - (o.at || 0) > 15 * 60000 ? c.at : (o.at || c.at) }; // chỉ ghi lại giờ mở app mỗi 15 phút cho đỡ tốn lượt ghi
    for (const f of ['mood', 'loc', 'home', 'place']) { const v = newer(o[f], c[f]); if (v) m[f] = v; }
    if (c.seenAt || o.seenAt) m.seenAt = Math.max(c.seenAt || 0, o.seenAt || 0);
    if (c.typingAt || o.typingAt) m.typingAt = Math.max(c.typingAt || 0, o.typingAt || 0);
    if (c.avatar !== undefined && (c.avatarAt || 0) >= (o.avatarAt || 0)) { m.avatar = c.avatar; m.avatarAt = c.avatarAt; } else if (o.avatar !== undefined) { m.avatar = o.avatar; m.avatarAt = o.avatarAt; }
    people[dev] = m;
  }
  const ids = Object.keys(people).sort((a, b) => (people[b].at || 0) - (people[a].at || 0));
  for (const id of ids.slice(6)) delete people[id]; // giữ tối đa 6 máy
  const mk = Object.keys(out.moods || {});
  if (mk.length > 600) { // chat giữ 600 mục mới nhất trong phòng, phần cũ hơn chuyển vào kho lưu trữ theo tháng
    mk.sort((a, b) => (+out.moods[b].at || 0) - (+out.moods[a].at || 0));
    out._arc = mk.slice(600).map(id => out.moods[id]).filter(x => x && !x.deleted);
    for (const id of mk.slice(600)) delete out.moods[id];
  }
  const dk = Object.keys(out.days || {});
  if (dk.length > 2000) { dk.sort().reverse(); for (const id of dk.slice(2000)) delete out.days[id]; }
  if (cur.arcs) out.arcs = cur.arcs;
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
  walk('moods', (e, o) => {
    if (!o || e.deleted) return null;
    if (e.pinned && !o.pinned) return { icon: '📌', text: `ghim tin: "${clip(e.note || (Array.isArray(e.photos) && e.photos.length ? 'ảnh' : e.text || e.label || ''), 50)}"` };
    if (!e.reactBy || !e.reactEmo) return null;
    if ((e.react || {})[e.reactBy] !== e.reactEmo || (o.react || {})[e.reactBy] === e.reactEmo) return null;
    const what = e.note ? `"${clip(e.note, 40)}"` : Array.isArray(e.photos) && e.photos.length ? 'ảnh' : e.kind === 'mood' ? 'cảm xúc' : 'tin nhắn';
    return { icon: e.reactEmo, text: `thả ${e.reactEmo} vào ${what}` };
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
    const peer = { dev, name: now.name, at: now.at, seenAt: now.seenAt || 0 };
    for (const f of ['mood', 'loc', 'home']) if (now[f]) peer[f] = now[f];
    const hist = Object.values((inc && inc.moods) || {}).filter(x => x && !x.deleted && x.dev === dev && (+x.at || 0) >= recent)
      .sort((a, b) => b.at - a.at).slice(0, 3).map(x => ({ id: cleanStr(x.id, 40), kind: cleanStr(x.kind, 8), dev, name: cleanStr(x.name, 40), v: cleanStr(x.v, 12), note: cleanStr(x.note, 120), at: +x.at, updated: +x.updated || +x.at }));
    for (const m of out) { m.peer = peer; m.hist = hist; }
  }
  return out;
}
const fmtEv = e => { if (!e || !e.date) return ''; const [y, m, d] = e.date.split('-'); return `${e.title} · ${+d}/${+m}${e.time ? ' ' + e.time : ''}`; };

const skipDev = (ex, id) => ex instanceof Set ? ex.has(id) : id === ex; // ex: 1 máy hoặc tập máy không cần báo
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
    if (skipDev(fromDevice, id) || !d.sub) continue;
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
    if (skipDev(exceptDevice, id) || !d.sub) continue;
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
    if (body.length > 1800000) return new Response('Dữ liệu quá lớn', { status: 413, headers: CORS });
    let inc; try { inc = JSON.parse(body); } catch (err) { return new Response('Sai định dạng', { status: 400, headers: CORS }); }
    const dev = String(inc.device || ''), who = String(inc.name || '').slice(0, 40);
    const ann = Array.isArray(inc.announce) ? new Set(inc.announce.slice(0, 200).map(String)) : null;
    const incA = ann ? onlyAnnounced(inc, ann) : inc, curA = ann ? withoutAnnounced(cur, ann) : cur;
    const changes = describeChanges(curA, incA), usLines = describeUs(curA, incA), collLines = describeColls(curA, incA);
    const merged = mergeRoom(cur, inc), arcItems = merged._arc; delete merged._arc;
    if (arcItems && arcItems.length && store.archive) merged.arcs = await store.archive(arcItems, merged.arcs || []);
    const pplMsgs = describePeople(cur, merged, dev, who, inc, ann);
    if (JSON.stringify(merged) !== JSON.stringify(cur)) { await store.put(merged); if (store.broadcast) store.broadcast(dev); }
    const skip = new Set([dev].concat(store.liveChat ? [...store.liveChat()] : [])); // máy đang mở màn Chat thì khỏi thông báo
    const jobs = [];
    if (changes.length) jobs.push(notifyRoom(env, code, skip, who, changes));
    if (usLines.length) jobs.push(sendToRoom(env, code, skip, { title: `💞 ${who || 'Người ấy'} ${usLines[0]}`, body: usLines.length > 1 ? usLines.slice(1, 4).join('\n') : 'Mở tab Hai đứa xem nha' }));
    if (collLines.length && collLines.length <= 3) for (const l of collLines) jobs.push(sendToRoom(env, code, skip, { title: `${l.icon} ${who || 'Người ấy'} ${l.text}`, body: 'Bấm để xem trong Chat' }));
    else if (collLines.length) jobs.push(sendToRoom(env, code, skip, collLines.length === 1
      ? { title: `${collLines[0].icon} ${who || 'Người ấy'} ${collLines[0].text}`, body: 'Mở tab Hai đứa xem nha' }
      : { title: `${collLines[0].icon} ${who || 'Người ấy'} vừa cập nhật ${collLines.length} mục`, body: collLines.slice(0, 4).map(l => l.icon + ' ' + l.text).join('\n') }));
    for (const m of pplMsgs) jobs.push(sendToRoom(env, code, skip, m));
    const recentT = Date.now() - 10 * 60000;
    const chats = Object.values(inc.moods || {}).filter(x => x && (x.kind === 'msg' || x.kind === 'touch' || x.kind === 'gift') && !x.deleted && !x.edited && !x.recalled && x.dev === dev && (+x.at || 0) >= recentT && (ann ? ann.has(`moods:${x.id}:${x.updated}`) : !(cur.moods || {})[x.id])).sort((a, b) => a.at - b.at).slice(-3);
    for (const x of chats) jobs.push(sendToRoom(env, code, skip, x.kind === 'gift'
      ? { title: `💐 ${who || 'Người ấy'} tặng một bó hoa!`, body: x.note ? clip(x.note, 160) : 'Mở app nhận quà nha 🎁', tab: 'us', usp: 'moods',
          hist: [Object.assign({ id: cleanStr(x.id, 40), kind: 'gift', flower: cleanStr(x.flower, 12), note: cleanStr(x.note, 200), dev, name: who, at: +x.at, updated: +x.updated || +x.at }, x.photo ? { photo: cleanStr(x.photo, 40) } : {})] }
      : x.kind === 'touch'
      ? { title: `${x.t === 'hug' ? '🤗' : '💗'} ${who || 'Người ấy'} ${clip(x.text, 60)}`, body: 'Mở app nhận nha', tab: 'today',
          hist: [{ id: cleanStr(x.id, 40), kind: 'touch', t: cleanStr(x.t, 8), sec: +x.sec || 0, text: cleanStr(x.text, 80), dev, name: who, at: +x.at, updated: +x.updated || +x.at }] }
          : { title: `💬 ${who || 'Người ấy'}`, body: x.note ? clip(x.note, 160) : (Array.isArray(x.photos) && x.photos.length ? `📷 Đã gửi ${x.photos.length > 1 ? x.photos.length + ' ảnh' : 'ảnh'}` : '…'), tab: 'us', usp: 'moods',
              hist: [Object.assign({ id: cleanStr(x.id, 40), kind: 'msg', dev, name: who, note: cleanStr(x.note, 300), at: +x.at, updated: +x.updated || +x.at },
                Array.isArray(x.photos) ? { photos: x.photos.slice(0, 12).map(v => cleanStr(v, 40)) } : {}, x.fx ? { fx: cleanStr(x.fx, 10) } : {},
                x.reply && typeof x.reply === 'object' ? { reply: { id: cleanStr(x.reply.id, 40), name: cleanStr(x.reply.name, 40), text: cleanStr(x.reply.text, 80) } } : {})] }));
    if (jobs.length) await Promise.all(jobs.map(j => j.catch(() => {})));
    { // thêm thư mới vào lịch mở
      const fresh = Object.values(inc.letters || {}).filter(l => l && !l.deleted && l.dev === dev && +l.openAt > Date.now() && !(cur.letters || {})[l.id]);
      if (fresh.length) { const li = JSON.parse((await env.SOTAY.get('letter-index')) || '[]'); for (const l of fresh) li.push({ room: code, id: l.id, at: +l.openAt, dev, from: who, title: l.hideTitle ? '' : clip(l.title || '', 40) }); await env.SOTAY.put('letter-index', JSON.stringify(li)); }
    }
    const since = +inc.since || 0, view = lockLetters(merged, dev);
    return new Response(JSON.stringify(Object.assign(since > 0 ? deltaOf(view, since) : view, { sv: SERVER_V, now: Date.now() })), { headers: { ...CORS, 'Content-Type': 'application/json' } });
  }
  return new Response(JSON.stringify(Object.assign(lockLetters(cur, ''), { sv: SERVER_V })), { headers: { ...CORS, 'Content-Type': 'application/json' } });
}
function deltaOf(room, since) { // chỉ gửi lại những mục đổi sau lần hỏi trước (đỡ tốn dữ liệu di động)
  const out = { delta: true, meta: room.meta, events: room.events, specials: room.specials, people: room.people, arcs: room.arcs }, now = Date.now();
  for (const c of COLLS) { if (c === 'events' || c === 'specials') continue; const m = {};
    for (const [id, e] of Object.entries(room[c] || {})) if ((+e._s || 0) > since || (c === 'letters' && +e.openAt > since - 120000 && +e.openAt <= now + 1000)) m[id] = e;
    out[c] = m; }
  return out;
}
// ---- AI trong chat (Workers AI, miễn phí 10.000 neuron/ngày) ----
const AI_MODELS = ['@cf/google/gemma-4-26b-a4b-it', '@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/meta/llama-3.1-8b-instruct'];
const AI_DAILY = 200; // tối đa số câu AI trả lời mỗi ngày cho một cặp
async function askAI(env, messages) {
  for (const m of AI_MODELS) {
    try {
      const r = await env.AI.run(m, { messages, max_tokens: 400, temperature: 0.8 });
      let t = typeof r === 'string' ? r : (r && (r.response ?? (r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content))) || '';
      if (typeof t !== 'string') t = JSON.stringify(t);
      t = t.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/^\s*(AI|Bé AI)\s*:\s*/i, '').trim();
      if (t) return t;
    } catch (e) {}
  }
  return '';
}
const aiConf = room => { const a = room && room.meta && room.meta.ai && room.meta.ai.v; return { name: cleanStr(a && a.name, 40).trim() || 'Trợ lý tình yêu của HoPu và QiGa', emo: cleanStr(a && a.emo, 8) || '💞' }; };
const reEsc = t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function aiPrompt(room, asker) {
  const me = aiConf(room).name;
  const names = [...new Set(Object.values(room.people || {}).map(p => p && p.name).filter(Boolean))].slice(0, 2);
  const now = new Date(Date.now() + 7 * 3600e3), WD = ['Chủ nhật', 'Thứ hai', 'Thứ ba', 'Thứ tư', 'Thứ năm', 'Thứ sáu', 'Thứ bảy'];
  const hist = Object.values(room.moods || {}).filter(x => x && !x.deleted && x.kind === 'msg' && x.note).sort((a, b) => a.at - b.at).slice(-12)
    .map(x => `${x.ai ? me : (x.name || 'Ai đó')}: ${clip(x.note, 200)}`).join('\n');
  return `Bạn tên là "${me}" — một người bạn nhỏ vui tính sống trong app chat riêng của cặp đôi ${names.join(' và ') || 'hai bạn'}. ` +
    `Hôm nay là ${WD[now.getUTCDay()]}, ${now.getUTCDate()}/${now.getUTCMonth() + 1}/${now.getUTCFullYear()}, giờ Việt Nam ${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}. ` +
    `Trả lời bằng tiếng Việt tự nhiên như người Việt nói chuyện, thân thiện, hài hước nhẹ nhàng, ngắn gọn (thường 1–3 câu, không quá khoảng 80 chữ), dùng emoji vừa phải. ` +
    `Xưng "mình", gọi người hỏi bằng tên (${asker || 'bạn'}). Không viết tiêu đề hay gạch đầu dòng trừ khi được nhờ liệt kê. ` +
    `Nếu hai bạn trêu nhau hay cãi nhau thì đứng giữa, làm hoà dễ thương. Chuyện nghiêm túc (sức khoẻ, tiền bạc, pháp luật) thì trả lời cẩn thận và khuyên hỏi người có chuyên môn. ` +
    `Bạn không biết gì về hai bạn ngoài đoạn chat dưới đây, đừng bịa.` + (hist ? `\n\nĐoạn chat gần đây:\n${hist}` : '');
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
  constructor(ctx, env) { super(ctx, env); try { ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong')); } catch (e) {} } // ping/pong không đánh thức DO
  sockets() { try { return this.ctx.getWebSockets(); } catch (e) { return []; } }
  async webSocketMessage(ws, msg) {
    if (typeof msg !== 'string' || msg === 'ping') return;
    let m; try { m = JSON.parse(msg); } catch (e) { return; }
    if (m.t === 'state') ws.serializeAttachment(Object.assign(ws.deserializeAttachment() || {}, { chat: !!m.chat, vis: m.vis !== false, at: Date.now() }));
  }
  async webSocketClose(ws, code) { try { ws.close(code === 1005 || code === 1006 ? 1000 : code, 'bye'); } catch (e) {} }
  async webSocketError(ws) { try { ws.close(1011, 'err'); } catch (e) {} }
  async fetch(req) {
    const url = new URL(req.url), [, op, code] = url.pathname.split('/');
    const storage = this.ctx.storage, env = this.env;
    const store = { get: async () => { let v = await storage.get('room'); if (!v && env.SOTAY) { const raw = await env.SOTAY.get('room:' + code); v = raw ? JSON.parse(raw) : null; if (v) await storage.put('room', v); } return v; }, put: v => storage.put('room', v),
      archive: async (items, arcs) => { // kho chat cũ: mỗi tháng một phần (đầy ~1.2MB thì sang phần mới)
        arcs = arcs.slice(); const byM = {};
        for (const x of items) { const mo = new Date((+x.at || 0) + 7 * 3600e3).toISOString().slice(0, 7); (byM[mo] = byM[mo] || []).push(x); }
        for (const mo of Object.keys(byM).sort()) {
          const same = arcs.filter(a => a.m === mo); let e = same[same.length - 1];
          if (!e || e.sz > 1200000) { e = { k: `${mo}.${same.length}`, m: mo, n: 0, sz: 0 }; arcs.push(e); }
          const key = 'arc:' + e.k, obj = (await storage.get(key)) || {};
          for (const x of byM[mo]) { const y = Object.assign({}, x); delete y._s; obj[x.id] = y; }
          await storage.put(key, obj);
          arcs[arcs.indexOf(e)] = Object.assign({}, e, { n: Object.keys(obj).length, sz: JSON.stringify(obj).length });
        }
        return arcs.sort((a, b) => a.m.localeCompare(b.m) || (+a.k.split('.')[1]) - (+b.k.split('.')[1]));
      },
      liveChat: () => { const now = Date.now(), out = new Set(); // máy đang mở màn Chat (còn ping trong 35 giây)
        for (const ws of this.sockets()) { const a = ws.deserializeAttachment() || {}; let last = +a.at || 0;
          try { const t = this.ctx.getWebSocketAutoResponseTimestamp(ws); if (t) last = Math.max(last, +t); } catch (e) {}
          if (a.chat && a.vis && now - last < 35000) out.add(a.dev); }
        return out; },
      broadcast: from => { for (const ws of this.sockets()) { const a = ws.deserializeAttachment() || {}; if (a.dev && a.dev === from) continue; try { ws.send('{"t":"changed"}'); } catch (e) {} } } };
    if (op === 'ws') {
      if (req.headers.get('Upgrade') !== 'websocket') return new Response('Cần WebSocket', { status: 426 });
      const dev = url.searchParams.get('dev') || ''; if (!/^[A-Za-z0-9_-]{8,64}$/.test(dev)) return new Response('Sai máy', { status: 400 });
      for (const old of this.sockets()) { const a = old.deserializeAttachment() || {}; if (a.dev === dev) try { old.close(1000, 'replaced'); } catch (e) {} }
      const pair = new WebSocketPair(); this.ctx.acceptWebSocket(pair[1]);
      pair[1].serializeAttachment({ dev, chat: url.searchParams.get('chat') === '1', vis: true, at: Date.now() });
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (op === 'ai' && req.method === 'POST') { // hỏi AI: trả lời rồi thêm vào chat chung
      const H = { ...CORS, 'Content-Type': 'application/json' }, bad = (e, st) => new Response(JSON.stringify({ error: e }), { status: st, headers: H });
      if (!env.AI) return bad('noai', 501);
      let b; try { b = await req.json(); } catch (e) { return bad('format', 400); }
      const cfg = aiConf(await store.get()), asker = cleanStr(b.name, 40);
      const q = cleanStr(b.q, 400).replace(new RegExp(`(^|\\s)@(ai|${reEsc(cfg.name)})(?=$|[\\s,:!?.])[:,]?`, 'ig'), ' ').replace(/^\s*@+\s*/, '').trim();
      if (!q) return bad('empty', 400);
      const day = new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10), cnt = (await storage.get('aiCount')) || {};
      if (cnt.d !== day) { cnt.d = day; cnt.n = 0; }
      if (cnt.n >= AI_DAILY) return bad('limit', 429);
      cnt.n++; await storage.put('aiCount', cnt);
      const text = await askAI(env, [{ role: 'system', content: aiPrompt((await store.get()) || {}, asker) }, { role: 'user', content: `${asker || 'Bạn'}: ${q}` }]);
      if (!text) return bad('ai', 502);
      const now = Date.now(), item = Object.assign({ id: 'ai' + now.toString(36) + Math.random().toString(36).slice(2, 6), kind: 'msg', ai: true, dev: 'ai', name: cfg.name, note: text.slice(0, 800), at: now, updated: now },
        b.qid ? { reply: { id: cleanStr(b.qid, 40), name: asker, text: clip(q, 80) } } : {});
      const room = (await store.get()) || { events: {} }; room.moods = room.moods || {}; // đọc lại sau khi AI trả lời (trong lúc chờ có thể có tin mới)
      room.moods[item.id] = Object.assign({}, item, { _s: now }); await store.put(room); store.broadcast('');
      return new Response(JSON.stringify({ item, left: AI_DAILY - cnt.n }), { headers: H });
    }
    if (op === 'arc') { const k = url.pathname.split('/')[3] || '', H = { ...CORS, 'Content-Type': 'application/json' };
      if (!k) { const room = (await store.get()) || {}; return new Response(JSON.stringify({ arcs: room.arcs || [] }), { headers: H }); }
      const obj = (await storage.get('arc:' + k)) || {};
      return new Response(JSON.stringify({ items: Object.values(obj).sort((a, b) => (a.at || 0) - (b.at || 0)) }), { headers: H }); }
    if (op === 'get') return new Response(JSON.stringify((await store.get()) || { events: {} }), { headers: { 'Content-Type': 'application/json' } });
    if (op === 'append') { const item = await req.json(), room = (await store.get()) || { events: {} }; room.moods = room.moods || {}; if (!room.moods[item.id]) { room.moods[item.id] = Object.assign({}, item, { _s: Date.now() }); await store.put(room); store.broadcast(''); } return new Response('ok'); }
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
    const rai = url.pathname.match(/^\/room\/([A-Za-z0-9_-]{8,64})\/ai$/);
    if (rai && req.method === 'POST') {
      if (!env.ROOM) return json({ error: 'noai' }, 501);
      return roomStub(env, rai[1]).fetch(`https://room/ai/${rai[1]}`, { method: 'POST', body: await req.text() });
    }
    const rw = url.pathname.match(/^\/room\/([A-Za-z0-9_-]{8,64})\/ws$/);
    if (rw) { // kênh realtime: máy mở app nối thẳng vào phòng
      if (!env.ROOM) return new Response('Chưa có Durable Object', { status: 501, headers: CORS });
      return roomStub(env, rw[1]).fetch(new Request(`https://room/ws/${rw[1]}${url.search}`, req));
    }
    const ra = url.pathname.match(/^\/room\/([A-Za-z0-9_-]{8,64})\/arc(?:\/(\d{4}-\d{2}\.\d{1,3}))?$/);
    if (ra && req.method === 'GET') {
      if (!env.ROOM) return json({ arcs: [], items: [] });
      return roomStub(env, ra[1]).fetch(`https://room/arc/${ra[1]}/${ra[2] || ''}`);
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
