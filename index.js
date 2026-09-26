/* ================================================================
   ربات پست‌گذار فوق حرفه‌ای — نسخه نهایی رفع باگ
   ربات: @cmd_nwes_bot
   مدیر: @CNN399
   اجرا: Cloudflare Workers
   حافظه/تنظیمات: KV با نام BOT_KV
   Secret Token: 30
================================================================ */

const BOT_TOKEN    = "8871471926:AAGu8eqJmr4gWwWrKTmGWozNjzLOA-qN22w";
const BOT_USERNAME = "cmd_nwes_bot";
const ADMIN_UNAME  = "cnn399";          // فقط همین یوزرنیم مدیر است
const SECRET_TOKEN = "30";
const TG_API       = `https://api.telegram.org/bot${BOT_TOKEN}`;
const SETTINGS_KEY = "settings_v4";    // برای حفظ تنظیمات قبلی
const ALBUM_WAIT   = 2600;
const MAX_SITE_VIDEO = 20 * 1024 * 1024;
const CAP_LIMIT    = 950;

const DEFAULTS = {
  active: true,
  sources: [],
  channels: [],
  removePhrases: [],
  replacements: [],
  removeAllHashtags: false,
  removeHashtags: [],
  replaceHashtags: [],
  title: { bold: true, italic: false, underline: false, strike: false, spoiler: false, emoji: "" },
  bodyEmoji: "",
  prefix: "",
  suffix: "",
  removeLastLine: false,
  stripLinks: false,
  stripMentions: false,
  trimSpaces: true,
  stripTgEmojis: false,
  bannedWords: [],
  censorWords: [],
  button: { enabled: false, text: "", url: "" },
  preview: true,
  photoAsFile: false,
  dedupe: true,
  deleteFromSource: false,
  reportToAdmin: false,
  manualPost: false,
  locks: {
    video: false, photo: false, gif: false, voice: false, audio: false,
    sticker: false, document: false, videoNote: false, text: false,
    ads: false, forward: false
  },
  site: { enabled: false, url: "", sendToken: true }
};

const TYPE_LOCK = {
  video: 'video', photo: 'photo', animation: 'gif', voice: 'voice',
  audio: 'audio', sticker: 'sticker', document: 'document', video_note: 'videoNote'
};

const COMMANDS = [
  { command: "start", description: "باز کردن پنل مدیریت" },
  { command: "menu", description: "منوی اصلی" },
  { command: "help", description: "کمک" },
  { command: "id", description: "آیدی این چت" },
  { command: "stats", description: "آمار ربات" },
  { command: "backup", description: "پشتیبان تنظیمات" },
  { command: "ping", description: "تست آنلاین بودن" },
  { command: "debug", description: "گزارش عیب‌یابی" }
];

const isOn = x => x && x.enabled !== false;

/* ------------------ ابزارها ------------------ */
const sleep = ms => new Promise(r => setTimeout(r, ms));
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escReg = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const clip = (s, n = 24) => (s && s.length > n ? s.slice(0, n) + '…' : s) || '—';
const tgOn = v => v ? '✅' : '❌';
const stripHtml = s => String(s ?? '').replace(/<[^>]+>/g, '');
const fmtTime = ts => {
  const d = new Date(ts);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
};

// کوتاه‌کردن بر اساس بایت برای دکمه‌های تلگرام (محدودیت ۶۴ بایت)
function tb(s, max = 58) {
  s = String(s ?? '');
  const enc = new TextEncoder();
  if (enc.encode(s).length <= max) return s;
  let out = '', len = 0;
  for (const ch of s) {
    const b = enc.encode(ch).length;
    if (len + b > max - 1) break;
    out += ch;
    len += b;
  }
  return out + '…';
}

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

const kvGet = async (env, k) => {
  const v = await env.BOT_KV.get(k);
  try { return v ? JSON.parse(v) : null; } catch { return null; }
};
const kvPut = (env, k, v, ttl) => env.BOT_KV.put(k, JSON.stringify(v), ttl ? { expirationTtl: ttl } : undefined);
const setErr = (env, msg) => kvPut(env, 'last_error', { t: Date.now(), msg: String(msg).slice(0, 250) }).catch(() => {});

function stripEmojis(s) {
  return String(s ?? '')
    .replace(/[\u{1F1E6}-\u{1F1FF}\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{25A0}-\u{25FF}\u{2100}-\u{214F}\u{203C}\u{2049}\u{20E3}\u{FE0F}\u{200D}\u{24C2}\u{3030}\u{303D}]/gu, '')
    .replace(/[ \t]{2,}/g, ' ');
}

const hashRe = tag => new RegExp(escReg(tag) + '(?=\\s|$)', 'g');
const cutHashTags = (t, tag) => t.replace(hashRe(tag), '').replace(/[ \t]{2,}/g, ' ');

function getCommand(text) {
  const t = String(text || '').trim();
  const m = t.match(/^\/([A-Za-z0-9_]+)(?:@[A-Za-z0-9_]+)?/);
  return m ? ('/' + m[1]).toLowerCase() : t.toLowerCase();
}

const isAdminUser = u => !!u && typeof u.username === 'string' && u.username.toLowerCase() === ADMIN_UNAME;

/* ------------------ ارتباط مقاوم با تلگرام ------------------ */
async function tg(method, data, retries = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 25000);

      const res = await fetch(`${TG_API}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
        signal: controller.signal
      });

      clearTimeout(timer);

      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('application/json')) {
        const txt = await res.text();
        lastErr = new Error(`HTTP ${res.status}: ${txt.slice(0, 140)}`);
        if (attempt < retries && res.status >= 500) {
          await sleep(1500 * attempt);
          continue;
        }
        throw lastErr;
      }

      const json = await res.json();

      if (!json.ok && json.parameters && json.parameters.retry_after && attempt < retries) {
        await sleep((json.parameters.retry_after + 1) * 1000);
        continue;
      }

      return json;
    } catch (e) {
      lastErr = e;
      if (attempt < retries) {
        await sleep(1500 * attempt);
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error('Telegram request failed');
}

async function safeSend(chatId, payload, env) {
  const p = { chat_id: chatId, ...payload };
  try {
    let r = await tg('sendMessage', p);
    if (r.ok) return r;

    const desc = r.description || '';

    // اگر مشکل از HTML بود، بدون فرمت بفرست
    if (/parse|entities/i.test(desc) && p.parse_mode) {
      const p2 = { ...p };
      delete p2.parse_mode;
      if (p2.text) p2.text = stripHtml(p2.text);
      if (p2.caption) p2.caption = stripHtml(p2.caption);
      r = await tg('sendMessage', p2);
      if (r.ok) return r;
    }

    // اگر مشکل از دکمه‌ها بود، بدون کیبورد بفرست
    if (/reply_markup|keyboard|button/i.test(desc)) {
      const p3 = { ...p };
      delete p3.reply_markup;
      if (p3.parse_mode) {
        delete p3.parse_mode;
        p3.text = stripHtml(p3.text || '');
      }
      r = await tg('sendMessage', p3);
      if (r.ok) return r;
    }

    // آخرین تلاش: متن ساده
    const p4 = { chat_id: chatId, text: stripHtml(p.text || p.caption || 'پاسخ ربات') };
    r = await tg('sendMessage', p4);
    if (!r.ok) setErr(env, 'sendMessage: ' + (r.description || desc));
    return r;
  } catch (e) {
    setErr(env, 'sendMessage exception: ' + (e.message || e));
    return { ok: false, description: String(e.message || e) };
  }
}

async function safeEdit(message, text, kb, env) {
  const chatId = message.chat.id;
  const messageId = message.message_id;
  const base = {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    reply_markup: kb ? { inline_keyboard: kb } : undefined
  };

  try {
    let r = await tg('editMessageText', base);
    if (r.ok || /not modified/i.test(r.description || '')) return r;

    const desc = r.description || '';

    if (/parse|entities/i.test(desc)) {
      const b2 = { ...base, parse_mode: undefined, text: stripHtml(text) };
      r = await tg('editMessageText', b2);
      if (r.ok || /not modified/i.test(r.description || '')) return r;
    }

    if (/reply_markup|keyboard|button/i.test(desc) || !r.ok) {
      const b3 = { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML' };
      r = await tg('editMessageText', b3);
      if (r.ok || /not modified/i.test(r.description || '')) return r;
    }

    const b4 = { chat_id: chatId, message_id: messageId, text: stripHtml(text) };
    r = await tg('editMessageText', b4);
    if (!r.ok) setErr(env, 'editMessageText: ' + (r.description || desc));
    return r;
  } catch (e) {
    setErr(env, 'editMessageText exception: ' + (e.message || e));
    return { ok: false, description: String(e.message || e) };
  }
}

async function sendPanel(chatId, s, env) {
  return safeSend(chatId, {
    text: mainText(s),
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: mainMenu(s) }
  }, env);
}

async function ensureCommands(env) {
  try {
    if (await env.BOT_KV.get('cmds_set_final')) return;
    await tg('setMyCommands', { commands: COMMANDS });
    await kvPut(env, 'cmds_set_final', '1');
  } catch (e) {
    setErr(env, 'setMyCommands: ' + (e.message || e));
  }
}

async function ensureMenuButton(chatId, env) {
  try {
    const key = 'menu_btn:' + chatId;
    if (await env.BOT_KV.get(key)) return;
    await tg('setChatMenuButton', {
      chat_id: chatId,
      menu_button: { type: 'commands' }
    });
    await kvPut(env, key, '1');
  } catch (e) {
    setErr(env, 'setChatMenuButton: ' + (e.message || e));
  }
}

/* ------------------ تنظیمات، حالت، آمار ------------------ */
async function loadSettings(env) {
  const s = await kvGet(env, SETTINGS_KEY);
  const m = s ? {
    ...DEFAULTS,
    ...s,
    locks: { ...DEFAULTS.locks, ...(s.locks || {}) },
    title: { ...DEFAULTS.title, ...(s.title || {}) },
    button: { ...DEFAULTS.button, ...(s.button || {}) },
    site: { ...DEFAULTS.site, ...(s.site || {}) }
  } : { ...DEFAULTS };

  m.sources = (m.sources || []).map(x => ({ enabled: true, ...x }));
  m.channels = (m.channels || []).map(x => ({ enabled: true, ...x }));
  m.removePhrases = m.removePhrases || [];
  m.replacements = m.replacements || [];
  m.removeHashtags = m.removeHashtags || [];
  m.replaceHashtags = m.replaceHashtags || [];
  m.bannedWords = m.bannedWords || [];
  m.censorWords = m.censorWords || [];
  return m;
}

const saveSettings = (env, s) => kvPut(env, SETTINGS_KEY, s);
const getState = (env, id) => kvGet(env, `st:${id}`);
const setState = (env, id, v) => kvPut(env, `st:${id}`, v, 900);
const delState = (env, id) => env.BOT_KV.delete(`st:${id}`);

async function bumpStats(env) {
  try {
    const d = new Date().toISOString().slice(0, 10);
    const today = await kvGet(env, `stats:${d}`) || { posts: 0 };
    today.posts++;
    await kvPut(env, `stats:${d}`, today, 60 * 60 * 24 * 40);

    const total = await kvGet(env, 'stats:total') || { posts: 0 };
    total.posts++;
    await kvPut(env, 'stats:total', total);
  } catch (e) {
    setErr(env, 'stats: ' + (e.message || e));
  }
}

async function pushLog(env, entry) {
  try {
    const log = await kvGet(env, 'log') || [];
    log.unshift(entry);
    await kvPut(env, 'log', log.slice(0, 25));
  } catch (e) {
    setErr(env, 'log: ' + (e.message || e));
  }
}

async function statsText(env) {
  const d = new Date().toISOString().slice(0, 10);
  const today = await kvGet(env, `stats:${d}`);
  const total = await kvGet(env, 'stats:total');
  const log = await kvGet(env, 'log') || [];
  const last = await kvGet(env, 'last_error');

  let txt = `📊 <b>آمار و گزارش</b>\n\n📨 پست‌های امروز: <b>${(today && today.posts) || 0}</b>\n📦 مجموع کل: <b>${(total && total.posts) || 0}</b>`;

  if (log.length) {
    txt += '\n\n📜 <b>آخرین پست‌ها:</b>\n' + log.slice(0, 8).map(l =>
      `• ${fmtTime(l.t)} → ${l.ok}/${l.total} کانال | ${esc(clip(l.title || '(بدون کپشن)', 30))}`
    ).join('\n');
  }

  if (last) txt += `\n\n⚠️ آخرین خطا: ${esc(clip(last.msg, 120))}`;
  return txt;
}

async function debugText(env) {
  const out = {
    worker: '✅ running',
    time: new Date().toISOString(),
    kv_binding_BOT_KV: !!(env && env.BOT_KV),
    admin: '@' + ADMIN_UNAME,
    secret_token: '✅ 30'
  };

  try {
    const w = await tg('getWebhookInfo');
    out.webhook = w.result || w;
  } catch (e) {
    out.webhook_error = String(e.message || e);
  }

  try {
    const me = await tg('getMe');
    out.telegram_connection = me.ok ? '✅ ok' : '❌ failed';
    out.bot = me.ok ? { id: me.result.id, username: me.result.username } : null;
  } catch (e) {
    out.telegram_error = String(e.message || e);
  }

  try {
    const s = await loadSettings(env);
    out.settings = {
      active: s.active,
      sources: s.sources.length,
      channels: s.channels.length,
      removePhrases: s.removePhrases.length,
      replacements: s.replacements.length,
      site_enabled: s.site.enabled
    };
    const lastErr = await kvGet(env, 'last_error');
    if (lastErr) out.last_error = lastErr;
  } catch (e) {
    out.kv_error = String(e.message || e);
  }

  return `<pre>${esc(JSON.stringify(out, null, 2).slice(0, 3500))}</pre>`;
}

/* ------------------ پردازش کپشن ------------------ */
function cleanCaption(text, s) {
  if (!text) return '';
  let t = String(text);

  for (const r of (s.replacements || [])) {
    if (r && r.from) t = t.split(r.from).join(r.to ?? '');
  }

  for (const p of (s.removePhrases || [])) {
    if (p) t = t.split(p).join('');
  }

  for (const h of (s.replaceHashtags || [])) {
    if (h && h.from) t = t.replace(hashRe(h.from), h.to || '');
  }

  if (s.removeAllHashtags) {
    t = t.replace(/#[^\s#]+/g, '');
  } else {
    for (const h of (s.removeHashtags || [])) {
      if (h) t = cutHashTags(t, h);
    }
  }

  if (s.removeLastLine) {
    const lines = t.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].trim()) {
        lines.splice(i, 1);
        break;
      }
    }
    t = lines.join('\n');
  }

  if (s.stripLinks) {
    t = t.replace(/https?:\/\/\S+/gi, '').replace(/\b(?:t\.me|telegram\.me|telegra\.ph)\/\S+/gi, '');
  }

  if (s.stripMentions) {
    t = t.replace(/@[A-Za-z0-9_]{3,}/g, '');
  }

  for (const w of (s.censorWords || [])) {
    if (w) t = t.split(w).join('⛔');
  }

  if (s.trimSpaces) {
    t = t.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n');
  }

  return t.trim();
}

function clipCaption(t) {
  if (!t || t.length <= CAP_LIMIT) return t;
  let cut = t.slice(0, CAP_LIMIT);
  const nl = cut.lastIndexOf('\n');
  if (nl > CAP_LIMIT - 200) cut = cut.slice(0, nl);
  return cut + '\n…';
}

function buildTgHtml(cleaned, s) {
  const t = s.stripTgEmojis ? stripEmojis(cleaned) : cleaned;
  if (!t && !s.prefix && !s.suffix) return '';

  const lines = t.split('\n');
  let ti = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim()) { ti = i; break; }
  }

  const out = [];
  if (s.prefix) out.push(esc(s.prefix));

  lines.forEach((ln, i) => {
    if (!ln.trim()) {
      out.push('');
      return;
    }

    if (i === ti) {
      let x = esc(ln.trim());
      if (s.title.emoji) x = s.title.emoji + ' ' + x;

      const T = s.title;
      if (T.bold) x = `<b>${x}</b>`;
      if (T.italic) x = `<i>${x}</i>`;
      if (T.strike) x = `<s>${x}</s>`;
      if (T.underline) x = `<u>${x}</u>`;
      if (T.spoiler) x = `<tg-spoiler>${x}</tg-spoiler>`;

      out.push(x);
    } else {
      out.push(esc((s.bodyEmoji ? s.bodyEmoji + ' ' : '') + ln));
    }
  });

  if (s.suffix) out.push(esc(s.suffix));
  return out.join('\n').trim();
}

const buildSitePlain = (cleaned, s) =>
  stripEmojis([s.prefix, cleaned, s.suffix].filter(Boolean).join('\n')).trim();

function looksLikeAd(text, m) {
  const t = String(text || '');
  if (/(https?:\/\/|t\.me\/|telegram\.me\/|telegra\.ph\/)/i.test(t)) return true;
  if (m && m.reply_markup) return true;
  if (m && Array.isArray(m.entities) && m.entities.some(e => e.type === 'url' || e.type === 'text_link')) return true;
  return false;
}

const bannedHit = (text, s) =>
  (s.bannedWords || []).some(w => w && String(text || '').toLowerCase().includes(String(w).toLowerCase()));

/* ------------------ رسانه ------------------ */
function extractMedia(m) {
  if (m.photo && m.photo.length) {
    const p = m.photo[m.photo.length - 1];
    return { type: 'photo', file_id: p.file_id, size: p.file_size };
  }
  if (m.video) return { type: 'video', file_id: m.video.file_id, size: m.video.file_size };
  if (m.animation) return { type: 'animation', file_id: m.animation.file_id, size: m.animation.file_size };
  if (m.voice) return { type: 'voice', file_id: m.voice.file_id, size: m.voice.file_size };
  if (m.audio) return { type: 'audio', file_id: m.audio.file_id, size: m.audio.file_size };
  if (m.document) return { type: 'document', file_id: m.document.file_id, size: m.document.file_size };
  if (m.video_note) return { type: 'video_note', file_id: m.video_note.file_id, size: m.video_note.file_size };
  if (m.sticker) return { type: 'sticker', file_id: m.sticker.file_id, size: 0 };
  return null;
}

/* ------------------ دریافت از منبع ------------------ */
async function handleSourcePost(m, s, env) {
  if (s.active === false) return;

  const seenKey = `seen:${m.chat.id}:${m.message_id}`;
  if (await env.BOT_KV.get(seenKey)) return;
  await env.BOT_KV.put(seenKey, '1', { expirationTtl: 3600 });

  if (s.dedupe && !m.media_group_id) {
    const sig = (m.caption || m.text || '') + '|' + ((extractMedia(m) || {}).file_id || '');
    const hk = 'dup:' + hashStr(sig);
    if (await env.BOT_KV.get(hk)) return;
    await env.BOT_KV.put(hk, '1', { expirationTtl: 86400 });
  }

  if (
    s.locks.forward &&
    (m.forward_date || m.forward_from || m.forward_from_chat || m.forward_from_message_id || m.sender_chat)
  ) return;

  if (m.media_group_id) return handleAlbumPart(m, s, env);

  const media = extractMedia(m);
  await dispatchPost({
    medias: media ? [media] : [],
    caption: m.caption || m.text || '',
    chatId: m.chat.id,
    messageIds: [m.message_id],
    raw: m
  }, s, env);
}

async function handleAlbumPart(m, s, env) {
  const key = `alb:${m.chat.id}:${m.media_group_id}`;
  const now = Date.now();

  let rec = await kvGet(env, key);
  if (!rec) rec = { items: [], caption: '', ids: [], flushAt: now + ALBUM_WAIT, chatId: m.chat.id };

  const md = extractMedia(m);
  if (md) rec.items.push(md);
  rec.ids.push(m.message_id);
  if (m.caption && !rec.caption) rec.caption = m.caption;

  rec.flushAt = now + ALBUM_WAIT;
  await kvPut(env, key, rec, 300);

  await sleep(ALBUM_WAIT + 300);

  const rec2 = await kvGet(env, key);
  if (rec2 && Date.now() >= rec2.flushAt) {
    await env.BOT_KV.delete(key);
    await dispatchPost({
      medias: rec2.items,
      caption: rec2.caption,
      chatId: rec2.chatId,
      messageIds: rec2.ids,
      raw: m
    }, s, env);
  }
}

/* ------------------ ارسال نهایی ------------------ */
async function dispatchPost(post, s, env) {
  const targets = s.channels.filter(isOn);
  if (!targets.length) return 0;

  let medias = (post.medias || []).filter(m => !s.locks[TYPE_LOCK[m.type] || '']);
  const siteMedias = medias.slice();

  if (s.photoAsFile) {
    medias = medias.map(m => m.type === 'photo' ? { ...m, type: 'document' } : m);
    medias = medias.filter(m => !s.locks[TYPE_LOCK[m.type] || '']);
  }

  const text = post.caption || '';
  if (!medias.length && !text) return 0;
  if (!medias.length && s.locks.text) return 0;
  if (s.locks.ads && looksLikeAd(text, post.raw)) return 0;
  if (bannedHit(text, s)) return 0;

  const cleaned = clipCaption(cleanCaption(text, s));
  const html = buildTgHtml(cleaned, s);

  let okCount = 0;
  for (const ch of targets) {
    try {
      await sendToChannel(ch.id, medias, html, s);
      okCount++;
    } catch (e) {
      console.error('send fail →', ch.id, e.message);
      setErr(env, `ارسال به ${ch.id}: ${e.message || e}`);
    }
    await sleep(350);
  }

  await sendToSite(siteMedias, cleaned, post, s, env);

  if (okCount) {
    await bumpStats(env);
    await pushLog(env, {
  
