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
      t: Date.now(),
      title: cleaned.split('\n').find(l => l.trim()) || '',
      ok: okCount,
      total: targets.length
    });

    if (s.reportToAdmin) await reportAdmin(env, okCount, cleaned);

    if (s.deleteFromSource && post.messageIds && post.messageIds.length) {
      for (const id of post.messageIds) {
        await tg('deleteMessage', { chat_id: post.chatId, message_id: id }).catch(() => {});
      }
    }
  }

  return okCount;
}

async function reportAdmin(env, okCount, cleaned) {
  const chat = await kvGet(env, 'admin_chat');
  if (!chat) return;
  const first = ((cleaned || '').split('\n').find(l => l.trim())) || '(بدون کپشن)';
  await safeSend(chat, {
    text: `✅ پست به ${okCount} کانال ارسال شد.\n📌 ${esc(first.slice(0, 70))}`,
    parse_mode: 'HTML'
  }, env);
}

async function trySend(method, params) {
  let r = await tg(method, params);
  if (r.ok) return r;

  const desc = r.description || '';

  if (/parse|entities/i.test(desc) && params.parse_mode) {
    const p = { ...params };
    delete p.parse_mode;
    if (p.caption) p.caption = stripHtml(p.caption);
    if (p.text) p.text = stripHtml(p.text);
    if (Array.isArray(p.media)) {
      p.media = p.media.map(x => {
        const y = { ...x };
        if (y.caption) y.caption = stripHtml(y.caption);
        delete y.parse_mode;
        return y;
      });
    }
    r = await tg(method, p);
    if (r.ok) return r;
  }

  if (/reply_markup|keyboard|button/i.test(desc) && params.reply_markup) {
    const p = { ...params };
    delete p.reply_markup;
    r = await tg(method, p);
    if (r.ok) return r;
  }

  throw new Error(r.description || method);
}

function buttonKb(s) {
  if (s.button && s.button.enabled && s.button.text && /^https?:\/\//i.test(s.button.url || '')) {
    return { inline_keyboard: [[{ text: tb(s.button.text, 58), url: s.button.url }]] };
  }
  return undefined;
}

async function sendSingle(chId, m, html, s) {
  const p = { chat_id: chId };
  const hasCap = !['video_note', 'sticker'].includes(m.type);

  if (html && hasCap) {
    p.caption = html;
    p.parse_mode = 'HTML';
  }

  const kb = buttonKb(s);
  if (kb && hasCap) p.reply_markup = kb;

  switch (m.type) {
    case 'photo': p.photo = m.file_id; return trySend('sendPhoto', p);
    case 'video': p.video = m.file_id; p.supports_streaming = true; return trySend('sendVideo', p);
    case 'animation': p.animation = m.file_id; return trySend('sendAnimation', p);
    case 'voice': p.voice = m.file_id; return trySend('sendVoice', p);
    case 'audio': p.audio = m.file_id; return trySend('sendAudio', p);
    case 'document': p.document = m.file_id; return trySend('sendDocument', p);
    case 'video_note': p.video_note = m.file_id; return trySend('sendVideoNote', p);
    case 'sticker': p.sticker = m.file_id; return trySend('sendSticker', p);
  }
}

async function sendToChannel(chId, medias, html, s) {
  if (!medias.length) {
    if (!html) return;
    const p = { chat_id: chId, text: html, parse_mode: 'HTML' };
    if (!s.preview) p.link_preview_options = { is_disabled: true };
    const kb = buttonKb(s);
    if (kb) p.reply_markup = kb;
    await trySend('sendMessage', p);
    return;
  }

  const groupable = [], singles = [];
  for (const m of medias) {
    (['photo', 'video', 'animation', 'audio', 'document'].includes(m.type) ? groupable : singles).push(m);
  }

  if (groupable.length > 1) {
    const media = groupable.slice(0, 10).map((m, i) => {
      const it = { type: m.type, media: m.file_id };
      if (m.type === 'video') it.supports_streaming = true;
      if (i === 0 && html) {
        it.caption = html;
        it.parse_mode = 'HTML';
      }
      return it;
    });

    let r = await tg('sendMediaGroup', { chat_id: chId, media });
    if (!r.ok && /parse|entities/i.test(r.description || '')) {
      const media2 = media.map(x => {
        const y = { ...x };
        if (y.caption) y.caption = stripHtml(y.caption);
        delete y.parse_mode;
        return y;
      });
      r = await tg('sendMediaGroup', { chat_id: chId, media: media2 });
    }
    if (!r.ok) throw new Error(r.description || 'sendMediaGroup');

    for (const m of groupable.slice(10)) await sendSingle(chId, m, '', s);
  } else if (groupable.length === 1) {
    await sendSingle(chId, groupable[0], singles.length ? '' : html, s);
  }

  for (const m of singles) await sendSingle(chId, m, groupable.length ? '' : html, s);
}

async function sendToSite(medias, cleaned, post, s, env) {
  if (!s.site.enabled || !s.site.url) return;

  const caption = buildSitePlain(cleaned, s);

  for (const m of medias) {
    if (m.type !== 'photo' && m.type !== 'video') continue;
    if (m.type === 'video' && (m.size || 0) > MAX_SITE_VIDEO) continue;

    const payload = {
      bot_username: BOT_USERNAME,
      type: m.type,
      file_id: m.file_id,
      file_size: m.size || 0,
      caption,
      streamable: true,
      source_chat: post.chatId,
      message_id: post.messageIds && post.messageIds[0],
      ts: Date.now()
    };

    if (s.site.sendToken) payload.token = BOT_TOKEN;

    try {
      await fetch(s.site.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000)
      });
    } catch (e) {
      console.error('site fail:', e);
      setErr(env, 'سایت: ' + (e.message || e));
    }
  }
}

/* ------------------ پشتیبان / بازیابی ------------------ */
async function sendBackup(env, chatId) {
  try {
    const s = await loadSettings(env);
    const fd = new FormData();
    fd.append('chat_id', String(chatId));
    fd.append('caption', '📦 پشتیبان تنظیمات ربات');
    fd.append('document', new Blob([JSON.stringify(s, null, 2)], { type: 'application/json' }), 'bot-settings.json');

    const res = await fetch(`${TG_API}/sendDocument`, { method: 'POST', body: fd });
    const j = await res.json().catch(() => ({ ok: false, description: 'bad response' }));
    if (!j.ok) return safeSend(chatId, { text: '❌ پشتیبان‌گیری ناموفق: ' + esc(j.description || '') }, env);
  } catch (e) {
    return safeSend(chatId, { text: '❌ خطا: ' + esc(e.message || String(e)) }, env);
  }
}

async function restoreBackup(env, txt) {
  const obj = JSON.parse(txt);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('bad json');

  const merged = {
    ...DEFAULTS,
    ...obj,
    locks: { ...DEFAULTS.locks, ...(obj.locks || {}) },
    title: { ...DEFAULTS.title, ...(obj.title || {}) },
    button: { ...DEFAULTS.button, ...(obj.button || {}) },
    site: { ...DEFAULTS.site, ...(obj.site || {}) }
  };

  await saveSettings(env, merged);
  return merged;
}

/* ------------------ منوها — همه دکمه‌ها کوتاه و زیر ۶۴ بایت ------------------ */
const backBtn = () => [{ text: '↩️ اصلی', callback_data: 'm:main' }];
const cancelBtn = () => [{ text: '🚫 لغو', callback_data: 'cancel' }];

function mainMenu(s) {
  return [
    [{ text: '📥 منابع', callback_data: 'm:src' }, { text: '📤 کانال‌ها', callback_data: 'm:ch' }],
    [{ text: '✂️ حذف', callback_data: 'm:cut' }, { text: '🔁 جایگزینی', callback_data: 'm:rep' }],
    [{ text: '#️⃣ هشتگ', callback_data: 'm:hash' }, { text: '🚫 کلمات', callback_data: 'm:words' }],
    [{ text: '🎨 تیتر', callback_data: 'm:title' }, { text: '😀 اموجی', callback_data: 'm:emoji' }],
    [{ text: '📝 افزودنی', callback_data: 'm:txt' }, { text: '🧩 پردازش', callback_data: 'm:proc' }],
    [{ text: '🔘 دکمه', callback_data: 'm:btn' }, { text: '🔒 قفل', callback_data: 'm:lock' }],
    [{ text: '⚙️ پیشرفته', callback_data: 'm:adv' }, { text: '📊 آمار', callback_data: 'm:stats' }],
    [{ text: '📢 همگانی', callback_data: 'm:bcast' }, { text: '📮 پست دستی', callback_data: 'm:manual' }],
    [{ text: `🛑 ربات: ${tgOn(s.active !== false)}`, callback_data: 'active' }, { text: '🌐 سایت', callback_data: 'm:site' }],
    [{ text: '📦 پشتیبان', callback_data: 'backup' }, { text: '♻️ بازیابی', callback_data: 'restore' }],
    [{ text: '🧪 تست', callback_data: 'test' }, { text: '❌ بستن', callback_data: 'close' }]
  ];
}

function mainText(s) {
  return `⚙️ <b>پنل ربات پست‌گذار</b>

وضعیت: ${s.active === false ? '⛔ متوقف' : '✅ فعال'}
📥 منبع فعال: ${s.sources.filter(isOn).length}/${s.sources.length}
📤 کانال فعال: ${s.channels.filter(isOn).length}/${s.channels.length}

📌 هر پیام خصوصی مدیر، این پنل را باز می‌کند.`;
}

function srcMenu(s) {
  const k = s.sources.map((x, i) => [
    { text: tb(`${isOn(x) ? '🟢' : '⭕️'} ${x.title || x.id}`, 42), callback_data: `src:t:${i}` },
    { text: '🗑', callback_data: `src:d:${i}` }
  ]);
  k.push([{ text: '➕ منبع', callback_data: 'src:add' }], backBtn());
  return k;
}

function chMenu(s) {
  const k = s.channels.map((x, i) => [
    { text: tb(`${isOn(x) ? '🟢' : '⭕️'} ${x.title || x.id}`, 42), callback_data: `ch:t:${i}` },
    { text: '🗑', callback_data: `ch:d:${i}` }
  ]);
  k.push([{ text: '➕ کانال', callback_data: 'ch:add' }], backBtn());
  return k;
}

function cutMenu(s) {
  const k = s.removePhrases.map((p, i) => [{ text: tb(`🗑 ${p}`, 54), callback_data: `cut:d:${i}` }]);
  k.push([{ text: '➕ حذف', callback_data: 'cut:add' }], backBtn());
  return k;
}

function repMenu(s) {
  const k = s.replacements.map((r, i) => [{ text: tb(`❌ ${r.from}→${r.to}`, 54), callback_data: `rep:d:${i}` }]);
  k.push([{ text: '➕ جایگزین', callback_data: 'rep:add' }], backBtn());
  return k;
}

function hashMenu(s) {
  const k = [[{ text: `🗑 همه: ${tgOn(s.removeAllHashtags)}`, callback_data: 'hash:all' }]];
  s.removeHashtags.forEach((h, i) => k.push([{ text: tb(`🗑 ${h}`, 54), callback_data: `hs:d:${i}` }]));
  k.push([{ text: '➕ هشتگ', callback_data: 'hs:add' }]);
  s.replaceHashtags.forEach((h, i) => k.push([{ text: tb(`🔁 ${h.from}→${h.to}`, 54), callback_data: `hr:d:${i}` }]));
  k.push([{ text: '➕ جایگزین', callback_data: 'hr:add' }], backBtn());
  return k;
}

function wordsMenu(s) {
  const k = [];
  (s.bannedWords || []).forEach((w, i) => k.push([{ text: tb(`🚫 ${w}`, 54), callback_data: `ban:d:${i}` }]));
  k.push([{ text: '➕ ممنوعه', callback_data: 'ban:add' }]);
  (s.censorWords || []).forEach((w, i) => k.push([{ text: tb(`⛔ ${w}`, 54), callback_data: `cen:d:${i}` }]));
  k.push([{ text: '➕ سانسور', callback_data: 'cen:add' }], backBtn());
  return k;
}

function titleMenu(s) {
  const T = s.title;
  return [
    [{ text: `B بولد: ${tgOn(T.bold)}`, callback_data: 't:bold' }, { text: `I کج: ${tgOn(T.italic)}`, callback_data: 't:italic' }],
    [{ text: `U زیرخط: ${tgOn(T.underline)}`, callback_data: 't:underline' }, { text: `S خط‌خورده: ${tgOn(T.strike)}`, callback_data: 't:strike' }],
    [{ text: `🙈 سانسور: ${tgOn(T.spoiler)}`, callback_data: 't:spoiler' }],
    [{ text: '😀 تیتر', callback_data: 't:emoji' }],
    backBtn()
  ];
}

function emojiMenu(s) {
  return [
    [{ text: '😀 تیتر', callback_data: 'e:title' }],
    [{ text: '🔹 بدنه', callback_data: 'e:body' }],
    [{ text: `🧹 اموجی: ${tgOn(s.stripTgEmojis)}`, callback_data: 'e:strip' }],
    backBtn()
  ];
}

function txtMenu(s) {
  return [
    [{ text: '⤴️ بالا', callback_data: 'x:pre' }],
    [{ text: '⤵️ پایین', callback_data: 'x:suf' }],
    backBtn()
  ];
}

function procMenu(s) {
  return [
    [{ text: `🗑 خط آخر: ${tgOn(s.removeLastLine)}`, callback_data: 'proc:last' }],
    [{ text: `🔗 لینک: ${tgOn(s.stripLinks)}`, callback_data: 'proc:links' }],
    [{ text: `🆔 آیدی: ${tgOn(s.stripMentions)}`, callback_data: 'proc:ments' }],
    [{ text: `🧹 اموجی: ${tgOn(s.stripTgEmojis)}`, callback_data: 'proc:emo' }],
    [{ text: `📏 فاصله: ${tgOn(s.trimSpaces)}`, callback_data: 'proc:trim' }],
    [{ text: `♻️ تکراری: ${tgOn(s.dedupe)}`, callback_data: 'proc:dedupe' }],
    backBtn()
  ];
}

function btnMenu(s) {
  return [
    [{ text: `🔘 دکمه: ${tgOn(s.button.enabled)}`, callback_data: 'noop' }],
    [{ text: '➕ تنظیم', callback_data: 'btn:set' }],
    [{ text: '❌ حذف', callback_data: 'btn:off' }],
    backBtn()
  ];
}

const LOCK_LABELS = [
  ['video', '🎬 ویدیو'], ['photo', '🖼 عکس'], ['gif', '🎞 گیف'], ['voice', '🎤 ویس'],
  ['audio', '🎵 آهنگ'], ['sticker', '🌚 استیکر'], ['document', '📎 فایل'], ['videoNote', '🔘 نوت'],
  ['text', '📄 متن'], ['ads', '📢 تبلیغ'], ['forward', '↪️ فوروارد']
];

function lockMenu(s) {
  const k = LOCK_LABELS.map(([key, label]) => [{ text: `${label}: ${tgOn(s.locks[key])}`, callback_data: `lock:${key}` }]);
  k.push(backBtn());
  return k;
}

function advMenu(s) {
  return [
    [{ text: `🗑 حذف منبع: ${tgOn(s.deleteFromSource)}`, callback_data: 'adv:del' }],
    [{ text: `📣 گزارش: ${tgOn(s.reportToAdmin)}`, callback_data: 'adv:rep' }],
    [{ text: `🖼 بی‌افت: ${tgOn(s.photoAsFile)}`, callback_data: 'adv:paf' }],
    [{ text: `🔗 پیش‌نمایش: ${tgOn(s.preview)}`, callback_data: 'adv:prev' }],
    backBtn()
  ];
}

function siteMenu(s) {
  return [
    [{ text: `🌐 سایت: ${tgOn(s.site.enabled)}`, callback_data: 'site:t' }],
    [{ text: '🔗 آدرس', callback_data: 'site:url' }],
    [{ text: `🔑 توکن: ${tgOn(s.site.sendToken)}`, callback_data: 'site:tok' }],
    backBtn()
  ];
}

/* ------------------ Resolve چت ------------------ */
async function resolveChat(m) {
  if (m.forward_from_chat) {
    return {
      id: m.forward_from_chat.id,
      title: m.forward_from_chat.title || m.forward_from_chat.username || ''
    };
  }

  if (m.sender_chat) {
    return {
      id: m.sender_chat.id,
      title: m.sender_chat.title || m.sender_chat.username || ''
    };
  }

  const t = String(m.text || m.caption || '').trim();

  if (/^-?\d+$/.test(t)) return { id: parseInt(t, 10), title: '' };

  if (/^@[A-Za-z0-9_]{3,}$/.test(t)) {
    const r = await tg('getChat', { chat_id: t });
    if (r.ok) return { id: r.result.id, title: r.result.title || r.result.username || '' };
  }

  const link = t.match(/(?:https?:\/\/)?(?:t\.me|telegram\.me)\/([A-Za-z0-9_]{3,})/i);
  if (link) {
    const r = await tg('getChat', { chat_id: '@' + link[1] });
    if (r.ok) return { id: r.result.id, title: r.result.title || r.result.username || '' };
  }

  return null;
}

/* ------------------ پیام‌های مدیر در پیوی ------------------ */
async function handleAdminMessage(m, env) {
  await kvPut(env, 'admin_chat', m.chat.id);
  await ensureCommands(env);
  await ensureMenuButton(m.chat.id, env);

  const s = await loadSettings(env);
  const st = await getState(env, m.from.id);
  const cmd = getCommand(m.text);
  const txt = String(m.text || m.caption || '').trim();

  // اگر در حالت ورودی بود ولی مدیر خواست لغو/منو بزند
  if (st && ['/cancel', '/abort', '/stop', '/menu', '/start', '/main', '/help'].includes(cmd)) {
    await delState(env, m.from.id);
    return sendPanel(m.chat.id, s, env);
  }

  if (!st) {
    if (cmd === '/id') {
      return safeSend(m.chat.id, { text: `🆔 آی‌دی این چت:\n<code>${esc(String(m.chat.id))}</code>`, parse_mode: 'HTML' }, env);
    }
    if (cmd === '/stats') {
      return safeSend(m.chat.id, { text: await statsText(env), parse_mode: 'HTML' }, env);
    }
    if (cmd === '/backup') {
      return sendBackup(env, m.chat.id);
    }
    if (cmd === '/ping') {
      return safeSend(m.chat.id, { text: '🏓 ربات آنلاین است.' }, env);
    }
    if (cmd === '/debug') {
      return safeSend(m.chat.id, { text: await debugText(env), parse_mode: 'HTML' }, env);
    }

    // مهم‌ترین رفع باگ: هر پیام خصوصی مدیر پنل را باز می‌کند
    return sendPanel(m.chat.id, s, env);
  }

  let reply = '', menu = null;

  switch (st.action) {
    case 'add_source':
    case 'add_channel': {
      const c = await resolveChat(m);
      if (!c) {
        return safeSend(m.chat.id, {
          text: '❌ نامعتبر بود.\nپیامی از گروه/کانال را فوروارد کنید یا آی‌دی عددی یا @یوزرنیم یا لینک t.me بفرستید.'
        }, env);
      }

      const arr = st.action === 'add_source' ? s.sources : s.channels;
      if (!arr.some(x => x.id === c.id)) arr.push(c);
      await saveSettings(env, s);
      await delState(env, m.from.id);

      reply = `✅ اضافه شد: ${esc(c.title || String(c.id))}\n⚠️ ربات باید در آن چت ادمین باشد.`;
      menu = st.action === 'add_source' ? srcMenu(s) : chMenu(s);
      break;
    }

    case 'add_phrase':
      if (!txt) return safeSend(m.chat.id, { text: '❌ متن بفرستید.' }, env);
      s.removePhrases.push(txt);
      await saveSettings(env, s);
      await delState(env, m.from.id);
      reply = '✅ جمله به لیست حذف اضافه شد.';
      menu = cutMenu(s);
      break;

    case 'rep_from':
      if (!txt) return safeSend(m.chat.id, { text: '❌ متن بفرستید.' }, env);
      await setState(env, m.from.id, { action: 'rep_to', data: txt });
      return safeSend(m.chat.id, { text: '🔁 حالا متن جایگزین را بفرستید.\nبرای حذف کامل، خالی بفرستید.' }, env);

    case 'rep_to':
      s.replacements.push({ from: st.data, to: txt });
      await saveSettings(env, s);
      await delState(env, m.from.id);
      reply = `✅ ثبت شد:\n${esc(st.data)} → ${esc(txt || '(حذف)')}`;
      menu = repMenu(s);
      break;

    case 'hs_add': {
      if (!txt) return safeSend(m.chat.id, { text: '❌ هشتگ بفرستید.' }, env);
      let h = txt;
      if (!h.startsWith('#')) h = '#' + h;
      if (!s.removeHashtags.includes(h)) s.removeHashtags.push(h);
      await saveSettings(env, s);
      await delState(env, m.from.id);
      reply = `✅ هشتگ ${esc(h)} اضافه شد.`;
      menu = hashMenu(s);
      break;
    }

    case 'hr_from': {
      if (!txt) return safeSend(m.chat.id, { text: '❌ هشتگ بفرستید.' }, env);
      let h = txt;
      if (!h.startsWith('#')) h = '#' + h;
      await setState(env, m.from.id, { action: 'hr_to', data: h });
      return safeSend(m.chat.id, { text: `حالا هشتگ جایگزین برای ${esc(h)} را بفرستید.\nخالی = حذف.` }, env);
    }

    case 'hr_to': {
      let ht = txt;
      if (ht && !ht.startsWith('#')) ht = '#' + ht;
      s.replaceHashtags.push({ from: st.data, to: ht });
      await saveSettings(env, s);
      await delState(env, m.from.id);
      reply = `✅ جایگزینی ثبت شد:\n${esc(st.data)} → ${esc(ht || '(حذف)')}`;
      menu = hashMenu(s);
      break;
    }

    case 'add_banned':
      if (!txt) return safeSend(m.chat.id, { text: '❌ کلمه بفرستید.' }, env);
      s.bannedWords.push(txt);
      await saveSettings(env, s);
      await delState(env, m.from.id);
      reply = '✅ کلمه ممنوعه اضافه شد.';
      menu = wordsMenu(s);
      break;

    case 'add_censor':
      if (!txt) return safeSend(m.chat.id, { text: '❌ کلمه بفرستید.' }, env);
      s.censorWords.push(txt);
      await saveSettings(env, s);
      await delState(env, m.from.id);
      reply = '✅ کلمه سانسور اضافه شد.';
      menu = wordsMenu(s);
      break;

    case 'btn_text':
      if (!txt) return safeSend(m.chat.id, { text: '❌ متن دکمه بفرستید.' }, env);
      await setState(env, m.from.id, { action: 'btn_url', data: txt });
      return safeSend(m.chat.id, { text: '🔗 حالا لینک دکمه را بفرستید.\nمثال: https://t.me/example' }, env);

    case 'btn_url': {
      const u = txt;
      if (!/^https?:\/\/.+/i.test(u)) {
        return safeSend(m.chat.id, { text: '❌ لینک باید با http:// یا https:// شروع شود.' }, env);
      }
      s.button = { enabled: true, text: st.data, url: u };
      await saveSettings(env, s);
      await delState(env, m.from.id);
      reply = '✅ دکمه زیر پست فعال شد.';
      menu = btnMenu(s);
      break;
    }

    case 'bcast': {
      if (!txt) return safeSend(m.chat.id, { text: '❌ متن همگانی بفرستید.' }, env);
      let ok = 0, bad = 0;
      for (const ch of s.channels.filter(isOn)) {
        let r = await tg('sendMessage', { chat_id: ch.id, text: txt, parse_mode: 'HTML' });
        if (!r.ok) r = await tg('sendMessage', { chat_id: ch.id, text: stripHtml(txt) });
        r.ok ? ok++ : bad++;
        await sleep(300);
      }
      await delState(env, m.from.id);
      reply = `📢 ارسال همگانی\nموفق: ${ok} | ناموفق: ${bad}`;
      menu = mainMenu(s);
      break;
    }

    case 'manual_post': {
      const media = extractMedia(m);
      const cap = m.caption || m.text || '';
      if (!media && !cap) {
        return safeSend(m.chat.id, { text: '❌ متن یا رسانه بفرستید.' }, env);
      }

      const targets = s.channels.filter(isOn);
      if (!targets.length) {
        await delState(env, m.from.id);
        return safeSend(m.chat.id, { text: '⚠️ هنوز کانال مقصد فعالی اضافه نشده است.' }, env);
      }

      const okCount = await dispatchPost({
        medias: media ? [media] : [],
        caption: cap,
        chatId: m.chat.id,
        messageIds: [],
        raw: m
      }, s, env);

      await delState(env, m.from.id);
      reply = okCount ? `✅ پست دستی به ${okCount} کانال ارسال شد.` : '⚠️ پست ارسال نشد. ممکن است قفل/کلمه ممنوعه/نبود کانال فعال باشد.';
      menu = mainMenu(s);
      break;
    }

    case 'restore': {
      let fileTxt = txt;
      if (m.document) {
        try {
          const r = await tg('getFile', { file_id: m.document.file_id });
          if (!r.ok) throw new Error(r.description || 'getFile failed');
          const fr = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${r.result.file_path}`);
          fileTxt = await fr.text();
        } catch (e) {
          return safeSend(m.chat.id, { text: '❌ خواندن فایل پشتیبان ناموفق: ' + esc(e.message || String(e)) }, env);
        }
      }

      try {
        const merged = await restoreBackup(env, fileTxt);
        await delState(env, m.from.id);
        reply = '✅ تنظیمات بازیابی شد.';
        menu = mainMenu(merged);
      } catch {
        return safeSend(m.chat.id, { text: '❌ فایل/متن پشتیبان معتبر نیست.' }, env);
      }
      break;
    }

    case 'title_emoji':
      s.title.emoji = txt;
      await saveSettings(env, s);
      await delState(env, m.from.id);
      reply = '✅ اموجی تیتر ذخیره شد.';
      menu = titleMenu(s);
      break;

    case 'body_emoji':
      s.bodyEmoji = txt;
      await saveSettings(env, s);
      await delState(env, m.from.id);
      reply = '✅ اموجی بدنه ذخیره شد.';
      menu = emojiMenu(s);
      break;

    case 'prefix':
      s.prefix = txt;
      await saveSettings(env, s);
      await delState(env, m.from.id);
      reply = '✅ متن بالای کپشن ذخیره شد.';
      menu = txtMenu(s);
      break;

    case 'suffix':
      s.suffix = txt;
      await saveSettings(env, s);
      await delState(env, m.from.id);
      reply = '✅ متن پایین کپشن ذخیره شد.';
      menu = txtMenu(s);
      break;

    case 'site_url': {
      const u = txt;
      if (!/^https?:\/\/.+/i.test(u)) {
        return safeSend(m.chat.id, { text: '❌ آدرس باید با http:// یا https:// شروع شود.' }, env);
      }
      s.site.url = u;
      await saveSettings(env, s);
      await delState(env, m.from.id);
      reply = '✅ آدرس سایت ذخیره شد.';
      menu = siteMenu(s);
      break;
    }

    default:
      await delState(env, m.from.id);
      return sendPanel(m.chat.id, s, env);
  }

  return safeSend(m.chat.id, {
    text: reply,
    parse_mode: 'HTML',
    reply_markup: menu ? { inline_keyboard: menu } : undefined
  }, env);
}

/* ------------------ دکمه‌های پنل ------------------ */
async function handleCallback(cq, env) {
  const msg = cq.message;
  if (!msg) return;

  const data = cq.data || '';
  if (!isAdminUser(cq.from)) {
    return tg('answerCallbackQuery', {
      callback_query_id: cq.id,
      text: '⛔ شما مدیر ربات نیستید.',
      show_alert: true
    }).catch(() => {});
  }

  const s = await loadSettings(env);
  const done = () => tg('answerCallbackQuery', { callback_query_id: cq.id }).catch(() => {});
  const idx = d => parseInt(String(d).split(':').pop(), 10);

  const render = async (text, kb) => {
    const r = await safeEdit(msg, text, kb, env);
    if (!r.ok && !/not modified/i.test(r.description || '')) {
      await safeSend(msg.chat.id, {
        text,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: kb }
      }, env);
    }
  };

  const ask = txt => render(txt, [cancelBtn()[0]]);

  const views = {
    'm:main': async () => render(mainText(s), mainMenu(s)),
    'm:src': async () => render(`📥 <b>منابع</b>\nربات از این گروه/کانال پست می‌گیرد.\n⚠️ ربات باید ادمین باشد.`, srcMenu(s)),
    'm:ch': async () => render(`📤 <b>کانال‌ها</b>\nپست‌های ادیت‌شده اینجا ارسال می‌شوند.\n⚠️ ربات باید ادمین باشد.`, chMenu(s)),
    'm:cut': async () => render(`✂️ <b>حذف جملات</b>\nحذف دقیق از کپشن.`, cutMenu(s)),
    'm:rep': async () => render(`🔁 <b>جایگزینی متن</b>`, repMenu(s)),
    'm:hash': async () => render(`#️⃣ <b>هشتگ‌ها</b>`, hashMenu(s)),
    'm:words': async () => render(`🚫 <b>کلمات</b>\n🚫 ممنوعه = پست ارسال نمی‌شود\n⛔ سانسور = جایگزین با ⛔`, wordsMenu(s)),
    'm:title': async () => render(`🎨 <b>تیتر</b>\nخط اول کپشن.`, titleMenu(s)),
    'm:emoji': async () => render(`😀 <b>اموجی</b>\n🌐 سایت همیشه بدون اموجی.`, emojiMenu(s)),
    'm:txt': async () => render(`📝 <b>افزودنی</b>\nبالا: ${esc(clip(s.prefix || '—', 35))}\nپایین: ${esc(clip(s.suffix || '—', 35))}`, txtMenu(s)),
    'm:proc': async () => render(`🧩 <b>پردازش کپشن</b>`, procMenu(s)),
    'm:btn': async () => render(`🔘 <b>دکمه زیر پست</b>\nمتن: ${esc(s.button.text || '—')}`, btnMenu(s)),
    'm:lock': async () => render(`🔒 <b>قفل ارسال</b>`, lockMenu(s)),
    'm:adv': async () => render(`⚙️ <b>پیشرفته</b>`, advMenu(s)),
    'm:stats': async () => render(await statsText(env), [backBtn()[0]]),
    'm:site': async () => render(`🌐 <b>سایت</b>\nعکس/ویدیو با کپشن بدون اموجی ارسال می‌شود.`, siteMenu(s)),
    'm:bcast': async () => {
      await setState(env, cq.from.id, { action: 'bcast' });
      return ask('📢 متن همگانی را بفرستید:');
    },
    'm:manual': async () => {
      await setState(env, cq.from.id, { action: 'manual_post' });
      return ask('📮 متن/عکس/ویدیو پست دستی را بفرستید:');
    }
  };

  if (views[data]) {
    await done();
    return views[data]();
  }

  if (data === 'noop') return done();

  if (data === 'close') {
    await done();
    return tg('deleteMessage', { chat_id: msg.chat.id, message_id: msg.message_id }).catch(() => {});
  }

  if (data === 'cancel') {
    await delState(env, cq.from.id);
    await done();
    return render('⚠️ لغو شد.', mainMenu(s));
  }

  if (data === 'backup') {
    await done();
    return sendBackup(env, msg.chat.id);
  }

  if (data === 'restore') {
    await setState(env, cq.from.id, { action: 'restore' });
    await done();
    return ask('♻️ فایل bot-settings.json یا متن JSON پشتیبان را بفرستید:');
  }

  if (data === 'active') {
    s.active = !(s.active !== false);
    await saveSettings(env, s);
    await done();
    return render(mainText(s), mainMenu(s));
  }

  if (data === 'test') {
    await done();
    let ok = 0, bad = 0;
    for (const ch of s.channels.filter(isOn)) {
      try {
        await tg('sendMessage', { chat_id: ch.id, text: '✅ تست اتصال ربات به کانال.' });
        ok++;
      } catch {
        bad++;
      }
    }
    return safeSend(msg.chat.id, {
      text: s.channels.length
        ? `🧪 تست کانال‌ها\nموفق: ${ok} | ناموفق: ${bad}\nناموفق معمولاً یعنی ربات ادمین نیست.`
        : '⚠️ هنوز کانال مقصدی اضافه نشده است.'
    }, env);
  }

  if (data === 'src:add' || data === 'ch:add') {
    await setState(env, cq.from.id, { action: data === 'src:add' ? 'add_source' : 'add_channel' });
    await done();
    return ask('📨 یکی از این‌ها را بفرستید:\n۱) فوروارد پیام از گروه/کانال\n۲) آی‌دی عددی\n۳) @یوزرنیم\n۴) لینک t.me\n\n⚠️ ربات باید داخل آن چت ادمین باشد.');
  }

  if (data.startsWith('src:t:')) {
    const i = idx(data);
    if (i >= 0 && i < s.sources.length) {
      s.sources[i].enabled = !isOn(s.sources[i]);
      await saveSettings(env, s);
    }
    await done();
    return views['m:src']();
  }

  if (data.startsWith('src:d:')) {
    const i = idx(data);
    if (i >= 0 && i < s.sources.length) {
      s.sources.splice(i, 1);
      await saveSettings(env, s);
    }
    await done();
    return views['m:src']();
  }

  if (data.startsWith('ch:t:')) {
    const i = idx(data);
    if (i >= 0 && i < s.channels.length) {
      s.channels[i].enabled = !isOn(s.channels[i]);
      await saveSettings(env, s);
    }
    await done();
    return views['m:ch']();
  }

  if (data.startsWith('ch:d:')) {
    const i = idx(data);
    if (i >= 0 && i < s.channels.length) {
      s.channels.splice(i, 1);
      await saveSettings(env, s);
    }
    await done();
    return views['m:ch']();
  }

  if (data === 'cut:add') {
    await setState(env, cq.from.id, { action: 'add_phrase' });
    await done();
    return ask('✍️ جمله/متنی که باید دقیقاً حذف شود را بفرستید:');
  }

  if (data.startsWith('cut:d:')) {
    const i = idx(data);
    if (i >= 0 && i < s.removePhrases.length) {
      s.removePhrases.splice(i, 1);
      await saveSettings(env, s);
    }
    await done();
    return views['m:cut']();
  }

  if (data === 'rep:add') {
    await setState(env, cq.from.id, { action: 'rep_from' });
    await done();
    return ask('✍️ متنی که باید پیدا شود را بفرستید:');
  }

  if (data.startsWith('rep:d:')) {
    const i = idx(data);
    if (i >= 0 && i < s.replacements.length) {
      s.replacements.splice(i, 1);
      await saveSettings(env, s);
    }
    await done();
    return views['m:rep']();
  }

  if (data === 'hash:all') {
    s.removeAllHashtags = !s.removeAllHashtags;
    await saveSettings(env, s);
    await done();
    return views['m:hash']();
  }

  if (data === 'hs:add') {
    await setState(env, cq.from.id, { action: 'hs_add' });
    await done();
    return ask('#️⃣ هشتگی که باید حذف شود را بفرستید:');
  }

  if (data.startsWith('hs:d:')) {
    const i = idx(data);
    if (i >= 0 && i < s.removeHashtags.length) {
      s.removeHashtags.splice(i, 1);
      await saveSettings(env, s);
    }
    await done();
    return views['m:hash']();
  }

  if (data === 'hr:add') {
    await setState(env, cq.from.id, { action: 'hr_from' });
    await done();
    return ask('#️⃣ هشتگی که باید جایگزین شود را بفرستید:');
  }

  if (data.startsWith('hr:d:')) {
    const i = idx(data);
    if (i >= 0 && i < s.replaceHashtags.length) {
      s.replaceHashtags.splice(i, 1);
      await saveSettings(env, s);
    }
    await done();
    return views['m:hash']();
  }

  if (data === 'ban:add') {
    await setState(env, cq.from.id, { action: 'add_banned' });
    await done();
    return ask('🚫 کلمه ممنوعه را بفرستید:');
  }

  if (data.startsWith('ban:d:')) {
    const i = idx(data);
    if (i >= 0 && i < s.bannedWords.length) {
      s.bannedWords.splice(i, 1);
      await saveSettings(env, s);
    }
    await done();
    return views['m:words']();
  }

  if (data === 'cen:add') {
    await setState(env, cq.from.id, { action: 'add_censor' });
    await done();
    return ask('⛔ کلمه سانسور را بفرستید:');
  }

  if (data.startsWith('cen:d:')) {
    const i = idx(data);
    if (i >= 0 && i < s.censorWords.length) {
      s.censorWords.splice(i, 1);
      await saveSettings(env, s);
    }
    await done();
    return views['m:words']();
  }

  const tmap = {
    't:bold': 'bold',
    't:italic': 'italic',
    't:underline': 'underline',
    't:strike': 'strike',
    't:spoiler': 'spoiler'
  };

  if (tmap[data]) {
    s.title[tmap[data]] = !s.title[tmap[data]];
    await saveSettings(env, s);
    await done();
    return views['m:title']();
  }

  if (data === 't:emoji' || data === 'e:title') {
    await setState(env, cq.from.id, { action: 'title_emoji' });
    await done();
    return ask('😀 اموجی تیتر را بفرستید:');
  }

  if (data === 'e:body') {
    await setState(env, cq.from.id, { action: 'body_emoji' });
    await done();
    return ask('🔹 اموجی بدنه را بفرستید:');
  }

  if (data === 'e:strip' || data === 'proc:emo') {
    s.stripTgEmojis = !s.stripTgEmojis;
    await saveSettings(env, s);
    await done();
    return data === 'e:strip' ? views['m:emoji']() : views['m:proc']();
  }

  if (data === 'x:pre') {
    await setState(env, cq.from.id, { action: 'prefix' });
    await done();
    return ask('⤴️ متن بالای کپشن را بفرستید:');
  }

  if (data === 'x:suf') {
    await setState(env, cq.from.id, { action: 'suffix' });
    await done();
    return ask('⤵️ متن پایین کپشن را بفرستید:');
  }

  const procMap = {
    'proc:last': 'removeLastLine',
    'proc:links': 'stripLinks',
    'proc:ments': 'stripMentions',
    'proc:trim': 'trimSpaces',
    'proc:dedupe': 'dedupe'
  };

  if (procMap[data]) {
    s[procMap[data]] = !s[procMap[data]];
    await saveSettings(env, s);
    await done();
    return views['m:proc']();
  }

  if (data === 'btn:set') {
    await setState(env, cq.from.id, { action: 'btn_text' });
    await done();
    return ask('🔘 متن دکمه را بفرستید:');
  }

  if (data === 'btn:off') {
    s.button = { enabled: false, text: '', url: '' };
    await saveSettings(env, s);
    await done();
    return views['m:btn']();
  }

  if (data.startsWith('lock:')) {
    const key = data.slice(5);
    if (key in s.locks) {
      s.locks[key] = !s.locks[key];
      await saveSettings(env, s);
    }
    await done();
    return views['m:lock']();
  }

  const advMap = {
    'adv:del': 'deleteFromSource',
    'adv:rep': 'reportToAdmin',
    'adv:paf': 'photoAsFile',
    'adv:prev': 'preview'
  };

  if (advMap[data]) {
    s[advMap[data]] = !s[advMap[data]];
    await saveSettings(env, s);
    await done();
    return views['m:adv']();
  }

  if (data === 'site:t') {
    s.site.enabled = !s.site.enabled;
    await saveSettings(env, s);
    await done();
    return views['m:site']();
  }

  if (data === 'site:url') {
    await setState(env, cq.from.id, { action: 'site_url' });
    await done();
    return ask('🔗 آدرس کامل سایت را بفرستید:\nمثال: https://example.com/ingest');
  }

  if (data === 'site:tok') {
    s.site.sendToken = !s.site.sendToken;
    await saveSettings(env, s);
    await done();
    return views['m:site']();
  }

  return done();
}

/* ------------------ مسیریابی آپدیت‌ها ------------------ */
async function handleUpdate(u, env) {
  if (u.callback_query) return handleCallback(u.callback_query, env);

  // ادیت‌ها را پردازش نکن تا پست تکراری ساخته نشود
  if (u.edited_message || u.edited_channel_post) return;

  const m = u.message || u.channel_post;
  if (!m || !m.chat) return;

  if (m.chat.type === 'private') {
    if (!isAdminUser(m.from)) {
      return safeSend(m.chat.id, {
        text: `⛔ شما مدیر ربات نیستید.\nیوزرنیم دریافتی: @${esc(m.from.username || '(ندارد)')}\nمدیر باید: @${esc(ADMIN_UNAME)}`
      }, env);
    }
    return handleAdminMessage(m, env);
  }

  // اگر مدیر در گروه دستور داد، بگو فقط پیوی
  if (isAdminUser(m.from) && String(m.text || '').trim().startsWith('/')) {
    return safeSend(m.chat.id, {
      text: '⚠️ مدیریت ربات فقط در پیوی من انجام می‌شود.\nلطفاً در پیوی ربات /start بفرستید.'
    }, env);
  }

  const s = await loadSettings(env);
  if (s.sources.filter(isOn).some(x => x.id === m.chat.id)) {
    return handleSourcePost(m, s, env);
  }
}

/* ------------------ ورودی ورکر ------------------ */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'GET') {
      if (!env || !env.BOT_KV) {
        return new Response('❌ خطا: بایندینگ KV با نام BOT_KV تعریف نشده است.\nدر ورکر: Settings → Bindings → KV Namespace → نام متغیر: BOT_KV', {
          headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
      }

      if (url.pathname === '/' || url.pathname === '/webhook' || url.pathname === '/set') {
        const hook = `${url.origin}/webhook`;
        try {
          const r = await tg('setWebhook', {
            url: hook,
            secret_token: SECRET_TOKEN,
            drop_pending_updates: true,
            allowed_updates: ['message', 'channel_post', 'callback_query']
          });

          if (!r.ok) throw new Error(r.description || 'setWebhook failed');

          await ensureCommands(env);

          return new Response(
            `✅ Webhook set → ${hook}\n🔐 Secret Token: 30\n🗑 آپدیت‌های قدیمی پاک شدند\n📋 منوی اسلش/کنار میکروفون ست شد\n\nحالا در پیوی ربات /start بفرستید.`,
            { headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
          );
        } catch (e) {
          return new Response(`❌ خطا در ست کردن وبهوک:\n${esc(e.message || String(e))}\n\nعیب‌یابی: ${url.origin}/check`, {
            headers: { 'Content-Type': 'text/plain; charset=utf-8' }
          });
        }
      }

      if (url.pathname === '/test-telegram') {
        try {
          const r = await tg('getMe');
          if (r.ok) {
            return new Response(`✅ اتصال به تلگرام موفق\n🤖 @${r.result.username}\n🆔 ${r.result.id}`, {
              headers: { 'Content-Type': 'text/plain; charset=utf-8' }
            });
          }
          return new Response(`❌ ${r.description}`, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
        } catch (e) {
          return new Response(`❌ خطای شبکه/تلگرام:\n${esc(e.message || String(e))}`, {
            headers: { 'Content-Type': 'text/plain; charset=utf-8' }
          });
        }
      }

      if (url.pathname === '/check' || url.pathname === '/debug') {
        const out = await debugText(env);
        return new Response(out.replace(/<[^>]+>/g, ''), {
          headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
      }

      return new Response('OK');
    }

    if (request.method === 'POST' && url.pathname === '/webhook') {
      const token = request.headers.get('x-telegram-bot-api-secret-token');
      if (token !== SECRET_TOKEN) {
        return new Response('forbidden', { status: 403 });
      }

      let update;
      try {
        update = await request.json();
      } catch {
        return new Response('bad request', { status: 400 });
      }

      if (!env || !env.BOT_KV) {
        const chatId = update && update.message && update.message.chat && update.message.chat.id;
        if (chatId) {
          ctx.waitUntil(safeSend(chatId, {
            text: '⚠️ خطا: بایندینگ KV با نام BOT_KV در تنظیمات ورکر تعریف نشده است.'
          }, env));
        }
        return new Response('KV binding missing', { status: 500 });
      }

      ctx.waitUntil((async () => {
        try {
          await handleUpdate(update, env);
        } catch (e) {
          console.error('update error:', e);
          const chatId = update && (
            (update.message && update.message.chat && update.message.chat.id) ||
            (update.channel_post && update.channel_post.chat && update.channel_post.chat.id) ||
            (update.callback_query && update.callback_query.message && update.callback_query.message.chat.id)
          );
          if (chatId) {
            await safeSend(chatId, {
              text: '⚠️ خطا در پردازش:\n' + esc(String(e.message || e).slice(0, 300))
            }, env);
          }
          setErr(env, e.message || e);
        }
      })());

      return new Response('ok');
    }

    return new Response('Not found', { status: 404 });
  }
};