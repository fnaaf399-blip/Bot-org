/**
 * ==================================================================
 *  ربات فوروارد و ادیت حرفه‌ای پست (تک‌فایل) - Cloudflare Worker
 *  فقط برای مدیر: آیدی عددی 5697106704 / یوزرنیم @CNN399
 * ==================================================================
 *  تنها نیازمندی خارج از این فایل: یک KV Namespace با نام بایندینگ BOT_KV
 *  (از داشبورد Cloudflare یا با یک خط دستور بسازید و در ورکر بایند کنید،
 *   تنظیمات دیگری لازم نیست و همه چیز داخل همین فایل است.)
 * ==================================================================
 */

// ====== مقادیر ثابت ======
const BOT_TOKEN = "8871471926:AAGu8eqJmr4gWwWrKTmGWozNjzLOA-qN22w";
const ADMIN_ID = 5697106704;
const ADMIN_USERNAME = "cnn399"; // بدون @ ، حروف کوچک
const BOT_USERNAME = "cmd_nwes_bot";
const WEBHOOK_SECRET = "cnn399_webhook_secret_key";
// ==========================

const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

async function tg(method, payload) {
  const res = await fetch(`${TG_API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({ ok: false }));
  if (!data.ok) console.log("TG error", method, JSON.stringify(data).slice(0, 300));
  return data;
}

function isAdmin(from) {
  if (!from) return false;
  if (from.id === ADMIN_ID) return true;
  if (from.username && from.username.toLowerCase() === ADMIN_USERNAME) return true;
  return false;
}

function escapeHtml(s) {
  if (!s) return "";
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escAttr(s) {
  return escapeHtml(s).replace(/"/g, "&quot;");
}
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ==================== تنظیمات پیش‌فرض ====================

const DEFAULT_CFG = {
  source: null, // {id, title}
  channels: [], // [{id, title, enabled}]

  removePhrases: [],
  censorPhrases: [],
  replacePairs: [], // {from,to}

  hashtags: { mode: "off", whitelist: [], pairs: [] }, // off | removeAll | whitelist | replace

  tagLinks: [], // {trigger, url, label}

  quote: { all: false, lines: [], phrases: [] },
  italic: { all: false, lines: [], phrases: [] },
  bold: { all: false, lines: [], phrases: [] },
  underlinePhrases: [],
  strikePhrases: [],
  spoilerPhrases: [],

  emojiLines: [], // {line, emoji}
  emojiPhrases: [], // {phrase, emoji}

  titleStyle: { enabled: false, style: "bold", separator: false },
  append: { prefix: "", suffix: "" },

  clean: { removeLinks: false, removeMentions: false, maxLength: 1024 },

  restrictions: {
    photo: false,
    video: false,
    gif: false,
    sticker: false,
    voice: false,
    video_note: false,
    audio: false,
    document: false,
    poll: false,
    location: false,
    contact: false,
    forwarded: false,
    linkOnly: false,
    longCaption: { enabled: false, max: 1000 },
    duplicate: { enabled: false },
  },

  delivery: { silent: false, protect: false, pin: false, delaySeconds: 0 },

  recentHashes: [],
};

function deepMerge(base, override) {
  if (Array.isArray(base)) return override !== undefined ? override : base;
  if (typeof base === "object" && base !== null) {
    const out = {};
    for (const k of Object.keys(base)) {
      out[k] = deepMerge(base[k], override ? override[k] : undefined);
    }
    return out;
  }
  return override !== undefined ? override : base;
}

async function getConfig(env) {
  const raw = await env.BOT_KV.get("cfg", "json");
  return deepMerge(DEFAULT_CFG, raw || {});
}
async function saveConfig(env, cfg) {
  await env.BOT_KV.put("cfg", JSON.stringify(cfg));
}

async function getState(env) {
  return (await env.BOT_KV.get("state", "json")) || null;
}
async function setState(env, state) {
  await env.BOT_KV.put("state", JSON.stringify(state), { expirationTtl: 600 });
}
async function clearState(env) {
  await env.BOT_KV.delete("state");
}

function getByPath(obj, path) {
  return path.split(".").reduce((o, k) => (o === undefined || o === null ? o : o[k]), obj);
}
function setByPath(obj, path, value) {
  const parts = path.split(".");
  let o = obj;
  for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]];
  o[parts[parts.length - 1]] = value;
}

// ==================== تعریف لیست‌های عمومی قابل مدیریت ====================
// هر ورودی یک بخش از منو است که با همین موتور عمومی افزودن/حذف کار می‌کند

const LIST_DEFS = {
  remove: { title: "🚫 حذف عبارات دقیق از کپشن", path: "removePhrases", kind: "text", ask: "عبارتی که باید از کپشن حذف شود را بفرستید." },
  censor: { title: "🔞 سانسور کلمات (با ***)", path: "censorPhrases", kind: "text", ask: "کلمه/عبارتی که باید سانسور شود را بفرستید." },
  replace: { title: "🔁 جایگزینی متن در کپشن", path: "replacePairs", kind: "pair", ask1: "متن مبدا (که باید پیدا شود) را بفرستید.", ask2: "متن جایگزین را بفرستید. برای حذف کامل بدون جایگزین: -" },
  htwhite: { title: "✅ هشتگ‌های مجاز (بقیه حذف می‌شوند)", path: "hashtags.whitelist", kind: "text", ask: "هشتگ مجاز را با # بفرستید. مثلا: #خبر" },
  htpairs: { title: "🔁 جایگزینی هشتگ خاص", path: "hashtags.pairs", kind: "pair", ask1: "هشتگ مبدا را با # بفرستید.", ask2: "هشتگ یا متن جایگزین را بفرستید. برای حذف: -" },
  quotephrases: { title: "💬 نقل‌قول کردن یک بخش خاص از کپشن", path: "quote.phrases", kind: "text", ask: "متن دقیقی که باید به‌صورت نقل‌قول (Blockquote) نمایش داده شود را بفرستید." },
  quotelines: { title: "💬 نقل‌قول کردن یک خط با شماره", path: "quote.lines", kind: "lineNumber", ask: "شماره خط کپشن (خط اول = 1) که باید نقل‌قول شود را بفرستید." },
  italicphrases: { title: "🔡 کج کردن (ایتالیک) یک بخش خاص", path: "italic.phrases", kind: "text", ask: "متن دقیقی که باید کج شود را بفرستید." },
  italiclines: { title: "🔡 کج کردن یک خط با شماره", path: "italic.lines", kind: "lineNumber", ask: "شماره خط (خط اول = 1) که باید کج شود را بفرستید." },
  boldphrases: { title: "🔠 بولد کردن یک بخش خاص", path: "bold.phrases", kind: "text", ask: "متن دقیقی که باید بولد شود را بفرستید." },
  boldlines: { title: "🔠 بولد کردن یک خط با شماره", path: "bold.lines", kind: "lineNumber", ask: "شماره خط (خط اول = 1) که باید بولد شود را بفرستید." },
  underline: { title: "🔤 زیرخط‌دار کردن یک بخش", path: "underlinePhrases", kind: "text", ask: "متن دقیقی که باید زیرخط‌دار شود را بفرستید." },
  strike: { title: "S̶ ̶خط‌خورده کردن یک بخش", path: "strikePhrases", kind: "text", ask: "متن دقیقی که باید خط‌خورده شود را بفرستید." },
  spoiler: { title: "🙈 اسپویلر کردن یک بخش", path: "spoilerPhrases", kind: "text", ask: "متن دقیقی که باید اسپویلر شود را بفرستید." },
  emojilines: { title: "😀 افزودن ایموجی به یک خط با شماره", path: "emojiLines", kind: "lineEmoji" },
  emojiphrases: { title: "😀 افزودن ایموجی کنار یک کلمه/بخش", path: "emojiPhrases", kind: "emojiPair" },
  taglinks: { title: "🔗 لینک‌دار کردن کنار یک تگ/کلمه", path: "tagLinks", kind: "taglink" },
};

function describeEntry(kind, item) {
  if (kind === "text") return escapeHtml(item);
  if (kind === "pair") return `«${escapeHtml(item.from)}» ⬅️ «${escapeHtml(item.to || "—")}»`;
  if (kind === "lineNumber") return `خط شماره ${item}`;
  if (kind === "lineEmoji") return `خط ${item.line} ⬅️ ${item.emoji}`;
  if (kind === "emojiPair") return `${escapeHtml(item.phrase)} ⬅️ ${item.emoji}`;
  if (kind === "taglink") return `«${escapeHtml(item.trigger)}» ⬅️ ${escAttr(item.url)}${item.label ? " (" + escapeHtml(item.label) + ")" : ""}`;
  return String(item);
}

// ==================== پردازش کپشن/متن (موتور اصلی ادیت) ====================

function stripUrls(text) {
  return text.replace(/https?:\/\/\S+/gi, "").replace(/\bwww\.\S+/gi, "");
}
function stripMentions(text) {
  return text.replace(/@[A-Za-z0-9_]{3,}/g, "");
}

function applyHashtags(text, ht) {
  if (!ht || ht.mode === "off") return text;
  const re = /#[A-Za-z0-9_\u0600-\u06FF]+/g;
  if (ht.mode === "removeAll") return text.replace(re, "");
  if (ht.mode === "whitelist") {
    return text.replace(re, (tag) => (ht.whitelist.includes(tag) ? tag : ""));
  }
  if (ht.mode === "replace") {
    return text.replace(re, (tag) => {
      const p = ht.pairs.find((x) => x.from === tag);
      return p ? p.to : tag;
    });
  }
  return text;
}

function cleanupWhitespace(text) {
  return text
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function wrapPhraseInHtml(html, phrase, openTag, closeTag) {
  if (!phrase) return html;
  const escPhrase = escapeHtml(phrase);
  const re = new RegExp(escapeRegex(escPhrase), "g");
  return html.replace(re, `${openTag}${escPhrase}${closeTag}`);
}

function prefixPhraseWithEmoji(html, phrase, emoji) {
  if (!phrase) return html;
  const escPhrase = escapeHtml(phrase);
  const re = new RegExp(escapeRegex(escPhrase), "g");
  return html.replace(re, `${emoji} ${escPhrase}`);
}

function applyTagLink(html, tagLink) {
  const escTrig = escapeHtml(tagLink.trigger);
  const re = new RegExp(escapeRegex(escTrig), "g");
  const label = tagLink.label && tagLink.label.trim() ? tagLink.label : tagLink.url;
  const link = `<a href="${escAttr(tagLink.url)}">${escapeHtml(label)}</a>`;
  return html.replace(re, `${escTrig} ${link}`);
}

/**
 * خط لوله کامل ادیت کپشن/متن. خروجی رشته HTML آماده ارسال با parse_mode=HTML است.
 */
function processCaption(raw, cfg) {
  let text = raw || "";

  // ۱) حذف عبارات دقیق
  for (const p of cfg.removePhrases) if (p) text = text.split(p).join("");

  // ۲) سانسور با ***
  for (const p of cfg.censorPhrases) if (p) text = text.split(p).join("*".repeat(Math.min(p.length, 12)) || "***");

  // ۳) جایگزینی متن
  for (const pair of cfg.replacePairs) if (pair.from) text = text.split(pair.from).join(pair.to || "");

  // ۴) پاکسازی لینک/منشن
  if (cfg.clean.removeLinks) text = stripUrls(text);
  if (cfg.clean.removeMentions) text = stripMentions(text);

  // ۵) هشتگ‌ها
  text = applyHashtags(text, cfg.hashtags);

  text = cleanupWhitespace(text);

  // ۶) محدودیت طول قبل از افزودن تگ‌های HTML (تا تگی نصفه نشود)
  const maxLen = cfg.clean.maxLength || 1024;
  if (text.length > maxLen) text = text.slice(0, Math.max(0, maxLen - 1)) + "…";

  // ۷) تقسیم به خط، افزودن ایموجی خط، استایل خط اول سریع، escape
  let lines = text.split("\n");

  for (const el of cfg.emojiLines) {
    const idx = el.line - 1;
    if (lines[idx] !== undefined) lines[idx] = `${el.emoji} ${lines[idx]}`;
  }

  const lineStyleMap = {}; // idx -> [ {open,close} ... ] innermost->outermost
  const addLineStyle = (idx0, open, close) => {
    if (!lineStyleMap[idx0]) lineStyleMap[idx0] = [];
    lineStyleMap[idx0].push([open, close]);
  };
  for (const ln of cfg.quote.lines) addLineStyle(ln - 1, "<blockquote>", "</blockquote>");
  for (const ln of cfg.italic.lines) addLineStyle(ln - 1, "<i>", "</i>");
  for (const ln of cfg.bold.lines) addLineStyle(ln - 1, "<b>", "</b>");
  if (cfg.titleStyle.enabled && lines.length > 0) {
    const tags = { bold: ["<b>", "</b>"], italic: ["<i>", "</i>"], underline: ["<u>", "</u>"], strike: ["<s>", "</s>"], spoiler: ["<tg-spoiler>", "</tg-spoiler>"], code: ["<code>", "</code>"] };
    const [o, c] = tags[cfg.titleStyle.style] || tags.bold;
    addLineStyle(0, o, c);
  }

  lines = lines.map((l) => escapeHtml(l));
  for (const idx in lineStyleMap) {
    if (lines[idx] === undefined) continue;
    for (const [open, close] of lineStyleMap[idx]) lines[idx] = `${open}${lines[idx]}${close}`;
  }
  if (cfg.titleStyle.enabled && cfg.titleStyle.separator && lines.length > 0) {
    lines.splice(1, 0, "────────────");
  }

  let html = lines.join("\n");

  // ۸) استایل روی بخش‌های خاص (phrase-based) - بعد از escape انجام می‌شود
  for (const p of cfg.bold.phrases) html = wrapPhraseInHtml(html, p, "<b>", "</b>");
  for (const p of cfg.italic.phrases) html = wrapPhraseInHtml(html, p, "<i>", "</i>");
  for (const p of cfg.underlinePhrases) html = wrapPhraseInHtml(html, p, "<u>", "</u>");
  for (const p of cfg.strikePhrases) html = wrapPhraseInHtml(html, p, "<s>", "</s>");
  for (const p of cfg.spoilerPhrases) html = wrapPhraseInHtml(html, p, "<tg-spoiler>", "</tg-spoiler>");
  for (const p of cfg.quote.phrases) html = wrapPhraseInHtml(html, p, "<blockquote>", "</blockquote>");
  for (const ep of cfg.emojiPhrases) html = prefixPhraseWithEmoji(html, ep.phrase, ep.emoji);
  for (const tl of cfg.tagLinks) html = applyTagLink(html, tl);

  // ۹) استایل کل کپشن
  if (cfg.bold.all) html = `<b>${html}</b>`;
  if (cfg.italic.all) html = `<i>${html}</i>`;
  if (cfg.quote.all) html = `<blockquote>${html}</blockquote>`;

  // ۱۰) پیشوند/پسوند
  if (cfg.append.prefix) html = `${escapeHtml(cfg.append.prefix)}\n${html}`;
  if (cfg.append.suffix) html = `${html}\n${escapeHtml(cfg.append.suffix)}`;

  return html.trim();
}

// ==================== تشخیص نوع پیام و قفل‌ها ====================

function detectType(msg) {
  if (msg.photo) return "photo";
  if (msg.video) return "video";
  if (msg.animation) return "gif";
  if (msg.sticker) return "sticker";
  if (msg.voice) return "voice";
  if (msg.video_note) return "video_note";
  if (msg.audio) return "audio";
  if (msg.document) return "document";
  if (msg.poll) return "poll";
  if (msg.location || msg.venue) return "location";
  if (msg.contact) return "contact";
  return "text";
}

function isForwarded(msg) {
  return !!(msg.forward_origin || msg.forward_from_chat || msg.forward_from);
}

function isLinkOnly(rawText) {
  if (!rawText) return false;
  const stripped = stripUrls(rawText).replace(/[\s\n]/g, "");
  return stripped.length === 0 && /https?:\/\//i.test(rawText);
}

async function passesRestrictions(env, cfg, msg, rawText) {
  const r = cfg.restrictions;
  const type = detectType(msg);
  if (r[type]) return false;
  if (r.forwarded && isForwarded(msg)) return false;
  if (r.linkOnly && isLinkOnly(rawText)) return false;
  if (r.longCaption.enabled && rawText && rawText.length > r.longCaption.max) return false;
  return true;
}

async function passesDuplicateCheck(env, cfg, finalHtml) {
  if (!cfg.restrictions.duplicate.enabled) return true;
  const hash = finalHtml.slice(0, 300);
  if (cfg.recentHashes.includes(hash)) return false;
  cfg.recentHashes.unshift(hash);
  cfg.recentHashes = cfg.recentHashes.slice(0, 30);
  await saveConfig(env, cfg);
  return true;
}

// ==================== ارسال به کانال‌ها ====================

function getLargestPhotoFileId(msg) {
  const arr = msg.photo || [];
  return arr.length ? arr[arr.length - 1].file_id : null;
}

async function deliverOne(cfg, chatId, run) {
  const res = await run(chatId);
  if (res && res.ok && cfg.delivery.pin) {
    const msgId = Array.isArray(res.result) ? res.result[0].message_id : res.result.message_id;
    await tg("pinChatMessage", { chat_id: chatId, message_id: msgId, disable_notification: true }).catch(() => {});
  }
}

async function sendToChannels(cfg, run) {
  if (cfg.delivery.delaySeconds > 0) {
    await sleep(Math.min(cfg.delivery.delaySeconds, 120) * 1000);
  }
  for (const ch of cfg.channels) {
    if (ch.enabled === false) continue;
    try {
      await deliverOne(cfg, ch.id, run);
    } catch (e) {
      console.log("send error", ch.id, e.message);
    }
  }
}

async function processSingleMessage(env, cfg, msg) {
  const rawText = msg.caption || msg.text || "";
  if (!(await passesRestrictions(env, cfg, msg, rawText))) return;

  const type = detectType(msg);
  const finalHtml = processCaption(rawText, cfg) || " ";
  if (!(await passesDuplicateCheck(env, cfg, finalHtml))) return;

  const common = { disable_notification: cfg.delivery.silent, protect_content: cfg.delivery.protect };

  if (type === "text") {
    await sendToChannels(cfg, (chId) =>
      tg("sendMessage", { chat_id: chId, text: finalHtml, parse_mode: "HTML", ...common })
    );
  } else {
    await sendToChannels(cfg, (chId) =>
      tg("copyMessage", {
        chat_id: chId,
        from_chat_id: msg.chat.id,
        message_id: msg.message_id,
        caption: finalHtml,
        parse_mode: "HTML",
        ...common,
      })
    );
  }
}

function mediaItemFor(msg) {
  const type = detectType(msg);
  if (type === "photo") return { type: "photo", file_id: getLargestPhotoFileId(msg) };
  if (type === "video") return { type: "video", file_id: msg.video.file_id };
  if (type === "document") return { type: "document", file_id: msg.document.file_id };
  if (type === "audio") return { type: "audio", file_id: msg.audio.file_id };
  return null;
}

async function bufferAlbumItem(env, cfg, msg) {
  const gid = msg.media_group_id;
  const key = `album:${gid}`;
  const existing = (await env.BOT_KV.get(key, "json")) || [];
  existing.push(msg);
  await env.BOT_KV.put(key, JSON.stringify(existing), { expirationTtl: 60 });
  if (existing.length === 1) {
    await sleep(1500);
    const finalList = (await env.BOT_KV.get(key, "json")) || existing;
    await env.BOT_KV.delete(key);
    await flushAlbum(env, cfg, finalList);
  }
}

async function flushAlbum(env, cfg, list) {
  list.sort((a, b) => a.message_id - b.message_id);
  for (const m of list) {
    const rawText = m.caption || "";
    if (!(await passesRestrictions(env, cfg, m, rawText))) return;
  }
  const captionSource = list.find((m) => m.caption)?.caption || "";
  const finalHtml = processCaption(captionSource, cfg);
  if (!(await passesDuplicateCheck(env, cfg, finalHtml))) return;

  const mediaArr = list.map(mediaItemFor).filter(Boolean).slice(0, 10);
  if (!mediaArr.length) return;
  mediaArr[0].caption = finalHtml;
  mediaArr[0].parse_mode = "HTML";

  await sendToChannels(cfg, (chId) =>
    tg("sendMediaGroup", {
      chat_id: chId,
      media: mediaArr,
      disable_notification: cfg.delivery.silent,
      protect_content: cfg.delivery.protect,
    })
  );
}

// ==================== منوها ====================

function kb(rows) {
  return { inline_keyboard: rows };
}
function backRow(to = "m:main") {
  return [{ text: "🔙 بازگشت", callback_data: to }];
}
async function edit(chatId, messageId, text, keyboard) {
  if (messageId) {
    const r = await tg("editMessageText", { chat_id: chatId, message_id: messageId, text, parse_mode: "HTML", reply_markup: keyboard });
    if (r.ok) return;
  }
  await tg("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", reply_markup: keyboard });
}

function mainMenu() {
  return kb([
    [{ text: "📥 منبع و کانال‌ها", callback_data: "m:source" }],
    [{ text: "🚫 حذف/سانسور متن", callback_data: "m:cut" }, { text: "🔁 جایگزینی", callback_data: "list:replace" }],
    [{ text: "#️⃣ هشتگ‌ها", callback_data: "m:hashtags" }, { text: "🔗 لینک کنار تگ", callback_data: "list:taglinks" }],
    [{ text: "💬 نقل‌قول", callback_data: "m:quote" }, { text: "🔡 کج کردن", callback_data: "m:italic" }],
    [{ text: "🔠 بولد کردن", callback_data: "m:bold" }, { text: "🎨 زیرخط/خط‌خورده/اسپویلر", callback_data: "m:decor" }],
    [{ text: "😀 ایموجی‌گذاری", callback_data: "m:emoji" }, { text: "✨ استایل خط اول", callback_data: "m:title" }],
    [{ text: "➕ پیشوند/پسوند", callback_data: "m:append" }, { text: "🧹 پاکسازی متن", callback_data: "m:clean" }],
    [{ text: "🔒 قفل رسانه/محتوا", callback_data: "m:lock" }, { text: "🚀 تنظیمات ارسال", callback_data: "m:delivery" }],
    [{ text: "📋 نمایش تنظیمات", callback_data: "m:show" }, { text: "♻️ ریست کامل", callback_data: "m:reset" }],
  ]);
}

async function showMain(chatId, messageId) {
  await edit(chatId, messageId, "🎛 <b>پنل مدیریت ربات</b>\nفقط برای @CNN399 قابل مشاهده است.", mainMenu());
}

async function showCutMenu(chatId, messageId) {
  await edit(chatId, messageId, "🚫 <b>حذف / سانسور متن</b>", kb([
    [{ text: "🚫 مدیریت عبارات حذفی", callback_data: "list:remove" }],
    [{ text: "🔞 مدیریت کلمات سانسوری", callback_data: "list:censor" }],
    backRow(),
  ]));
}

async function showHashtagsMenu(cfg, chatId, messageId) {
  const modeLabel = { off: "غیرفعال", removeAll: "حذف همه هشتگ‌ها", whitelist: "فقط هشتگ‌های مجاز", replace: "جایگزینی هشتگ‌ها" }[cfg.hashtags.mode];
  const text = `#️⃣ <b>مدیریت هشتگ‌ها</b>\nحالت فعلی: ${modeLabel}`;
  await edit(chatId, messageId, text, kb([
    [{ text: (cfg.hashtags.mode === "off" ? "✅ " : "") + "غیرفعال", callback_data: "ht:mode:off" }],
    [{ text: (cfg.hashtags.mode === "removeAll" ? "✅ " : "") + "حذف همه هشتگ‌ها", callback_data: "ht:mode:removeAll" }],
    [{ text: (cfg.hashtags.mode === "whitelist" ? "✅ " : "") + "فقط هشتگ‌های مجاز (بقیه حذف)", callback_data: "ht:mode:whitelist" }],
    [{ text: (cfg.hashtags.mode === "replace" ? "✅ " : "") + "جایگزینی هشتگ‌ها", callback_data: "ht:mode:replace" }],
    [{ text: "✅ لیست هشتگ‌های مجاز", callback_data: "list:htwhite" }],
    [{ text: "🔁 لیست جایگزینی هشتگ", callback_data: "list:htpairs" }],
    backRow(),
  ]));
}

async function showQuoteMenu(cfg, chatId, messageId) {
  await edit(chatId, messageId, `💬 <b>نقل‌قول (Blockquote)</b>\nنقل‌قول کل کپشن: ${cfg.quote.all ? "فعال" : "غیرفعال"}`, kb([
    [{ text: cfg.quote.all ? "✅ غیرفعال کردن کل کپشن" : "فعال کردن کل کپشن", callback_data: "toggle:quote.all" }],
    [{ text: "💬 نقل‌قول یک خط با شماره", callback_data: "list:quotelines" }],
    [{ text: "💬 نقل‌قول یک بخش خاص از متن", callback_data: "list:quotephrases" }],
    backRow(),
  ]));
}
async function showItalicMenu(cfg, chatId, messageId) {
  await edit(chatId, messageId, `🔡 <b>کج کردن (Italic)</b>\nکج کردن کل کپشن: ${cfg.italic.all ? "فعال" : "غیرفعال"}`, kb([
    [{ text: cfg.italic.all ? "✅ غیرفعال کردن کل کپشن" : "فعال کردن کل کپشن", callback_data: "toggle:italic.all" }],
    [{ text: "🔡 کج کردن یک خط با شماره", callback_data: "list:italiclines" }],
    [{ text: "🔡 کج کردن یک بخش خاص از متن", callback_data: "list:italicphrases" }],
    backRow(),
  ]));
}
async function showBoldMenu(cfg, chatId, messageId) {
  await edit(chatId, messageId, `🔠 <b>بولد کردن (Bold)</b>\nبولد کردن کل کپشن: ${cfg.bold.all ? "فعال" : "غیرفعال"}`, kb([
    [{ text: cfg.bold.all ? "✅ غیرفعال کردن کل کپشن" : "فعال کردن کل کپشن", callback_data: "toggle:bold.all" }],
    [{ text: "🔠 بولد کردن یک خط با شماره", callback_data: "list:boldlines" }],
    [{ text: "🔠 بولد کردن یک بخش خاص از متن", callback_data: "list:boldphrases" }],
    backRow(),
  ]));
}
async function showDecorMenu(chatId, messageId) {
  await edit(chatId, messageId, "🎨 <b>زیرخط / خط‌خورده / اسپویلر</b>", kb([
    [{ text: "🔤 زیرخط‌دار", callback_data: "list:underline" }],
    [{ text: "S̶ خط‌خورده", callback_data: "list:strike" }],
    [{ text: "🙈 اسپویلر", callback_data: "list:spoiler" }],
    backRow(),
  ]));
}
async function showEmojiMenu(chatId, messageId) {
  await edit(chatId, messageId, "😀 <b>ایموجی‌گذاری</b>", kb([
    [{ text: "😀 ایموجی روی یک خط با شماره", callback_data: "list:emojilines" }],
    [{ text: "😀 ایموجی کنار یک کلمه/بخش", callback_data: "list:emojiphrases" }],
    backRow(),
  ]));
}

async function showTitleMenu(cfg, chatId, messageId) {
  const s = cfg.titleStyle;
  const styles = ["bold", "italic", "underline", "strike", "spoiler", "code"];
  await edit(chatId, messageId, `✨ <b>استایل سریع خط اول (تیتر)</b>\nوضعیت: ${s.enabled ? "فعال" : "غیرفعال"} | استایل: ${s.style} | خط جداکننده: ${s.separator ? "فعال" : "غیرفعال"}`, kb([
    [{ text: s.enabled ? "✅ غیرفعال کردن" : "فعال کردن", callback_data: "titletoggle" }],
    styles.map((st) => ({ text: (s.style === st ? "✓ " : "") + st, callback_data: `titlestyle:${st}` })),
    [{ text: (s.separator ? "✅ " : "") + "خط جداکننده زیر تیتر", callback_data: "titlesep" }],
    backRow(),
  ]));
}

async function showAppendMenu(cfg, chatId, messageId) {
  const a = cfg.append;
  await edit(chatId, messageId, `➕ <b>پیشوند / پسوند کپشن</b>\nپیشوند: ${a.prefix ? escapeHtml(a.prefix) : "—"}\nپسوند: ${a.suffix ? escapeHtml(a.suffix) : "—"}`, kb([
    [{ text: "✏️ تنظیم پیشوند", callback_data: "ask:prefix" }],
    [{ text: "✏️ تنظیم پسوند", callback_data: "ask:suffix" }],
    [{ text: "🗑 پاک کردن هر دو", callback_data: "clearappend" }],
    backRow(),
  ]));
}

async function showCleanMenu(cfg, chatId, messageId) {
  const c = cfg.clean;
  await edit(chatId, messageId, `🧹 <b>پاکسازی متن</b>\nحذف همه لینک‌ها: ${c.removeLinks ? "فعال" : "غیرفعال"}\nحذف منشن‌ها (@user): ${c.removeMentions ? "فعال" : "غیرفعال"}\nحداکثر طول کپشن: ${c.maxLength}`, kb([
    [{ text: c.removeLinks ? "✅ غیرفعال کردن حذف لینک" : "فعال کردن حذف لینک", callback_data: "toggle:clean.removeLinks" }],
    [{ text: c.removeMentions ? "✅ غیرفعال کردن حذف منشن" : "فعال کردن حذف منشن", callback_data: "toggle:clean.removeMentions" }],
    [{ text: "✏️ تنظیم حداکثر طول", callback_data: "ask:maxlen" }],
    backRow(),
  ]));
}

async function showLockMenu(cfg, chatId, messageId) {
  const r = cfg.restrictions;
  const labels = { photo: "عکس", video: "ویدیو", gif: "گیف", sticker: "استیکر", voice: "ویس", video_note: "ویدیو-پیام", audio: "فایل صوتی", document: "سند", poll: "نظرسنجی", location: "لوکیشن", contact: "مخاطب", forwarded: "پست فوروارد/تبلیغاتی", linkOnly: "پیام فقط-لینک" };
  const rows = Object.keys(labels).map((k) => [{ text: `${r[k] ? "🔒" : "🔓"} ${labels[k]}`, callback_data: `lock:${k}` }]);
  rows.push([{ text: `${r.longCaption.enabled ? "🔒" : "🔓"} کپشن طولانی (بیش از ${r.longCaption.max})`, callback_data: "lock:longCaption" }]);
  rows.push([{ text: `${r.duplicate.enabled ? "🔒" : "🔓"} جلوگیری از پست تکراری`, callback_data: "lock:duplicate" }]);
  rows.push(backRow());
  await edit(chatId, messageId, "🔒 <b>قفل ارسال بر اساس نوع محتوا</b>", kb(rows));
}

async function showDeliveryMenu(cfg, chatId, messageId) {
  const d = cfg.delivery;
  await edit(chatId, messageId, `🚀 <b>تنظیمات ارسال</b>\nبی‌صدا: ${d.silent ? "فعال" : "غیرفعال"}\nمحافظت از محتوا (جلوگیری از فوروارد/سیو): ${d.protect ? "فعال" : "غیرفعال"}\nپین خودکار بعد از ارسال: ${d.pin ? "فعال" : "غیرفعال"}\nتاخیر قبل از ارسال: ${d.delaySeconds} ثانیه`, kb([
    [{ text: d.silent ? "✅ غیرفعال کردن بی‌صدا" : "فعال کردن بی‌صدا", callback_data: "toggle:delivery.silent" }],
    [{ text: d.protect ? "✅ غیرفعال کردن محافظت" : "فعال کردن محافظت محتوا", callback_data: "toggle:delivery.protect" }],
    [{ text: d.pin ? "✅ غیرفعال کردن پین" : "فعال کردن پین خودکار", callback_data: "toggle:delivery.pin" }],
    [{ text: "✏️ تنظیم تاخیر (ثانیه)", callback_data: "ask:delay" }],
    backRow(),
  ]));
}

async function showSourceMenu(cfg, chatId, messageId) {
  const cur = cfg.source ? `${cfg.source.title || ""} (<code>${cfg.source.id}</code>)` : "تنظیم نشده";
  let chList = cfg.channels.length ? cfg.channels.map((c, i) => `${i + 1}. ${c.title || ""} (<code>${c.id}</code>) ${c.enabled === false ? "❌غیرفعال" : "✅فعال"}`).join("\n") : "کانالی ثبت نشده.";
  const text = `📥 <b>گروه منبع</b>\n${cur}\n\n📡 <b>کانال‌ها</b>\n${chList}`;
  const rows = [[{ text: "✏️ تنظیم گروه منبع", callback_data: "ask:source" }]];
  cfg.channels.forEach((c, i) => {
    rows.push([
      { text: `${c.enabled === false ? "▶️ فعال کردن" : "⏸ غیرفعال کردن"} ${c.title || c.id}`, callback_data: `chtoggle:${i}` },
      { text: "❌ حذف", callback_data: `chdel:${i}` },
    ]);
  });
  rows.push([{ text: "➕ افزودن کانال", callback_data: "ask:channel" }]);
  rows.push(backRow());
  await edit(chatId, messageId, text, kb(rows));
}

async function showListMenu(cfg, key, chatId, messageId) {
  const def = LIST_DEFS[key];
  const arr = getByPath(cfg, def.path) || [];
  const listText = arr.length ? arr.map((it, i) => `${i + 1}. ${describeEntry(def.kind, it)}`).join("\n") : "چیزی ثبت نشده.";
  const rows = arr.map((_, i) => [{ text: `❌ حذف مورد ${i + 1}`, callback_data: `listdel:${key}:${i}` }]);
  rows.push([{ text: "➕ افزودن مورد جدید", callback_data: `listadd:${key}` }]);
  rows.push(backRow());
  await edit(chatId, messageId, `${def.title}\n\n${listText}`, kb(rows));
}

async function showConfigDump(cfg, chatId, messageId) {
  const text = `📋 <b>تنظیمات کامل (خام JSON)</b>\n<pre>${escapeHtml(JSON.stringify(cfg, null, 2)).slice(0, 3800)}</pre>`;
  await edit(chatId, messageId, text, kb([backRow()]));
}

async function showResetConfirm(chatId, messageId) {
  await edit(chatId, messageId, "♻️ آیا مطمئن هستید؟ همه تنظیمات (به‌جز منبع و کانال‌ها) پاک می‌شود.", kb([
    [{ text: "✅ بله، ریست کن", callback_data: "reset:confirm" }],
    backRow(),
  ]));
}

// ==================== دستورات (Bot Commands) ====================

const COMMANDS = [
  { command: "start", description: "شروع و نمایش منوی اصلی" },
  { command: "menu", description: "نمایش منوی اصلی" },
  { command: "source", description: "تنظیم گروه منبع و کانال‌ها" },
  { command: "cut", description: "حذف / سانسور متن" },
  { command: "replace", description: "جایگزینی متن" },
  { command: "hashtags", description: "مدیریت هشتگ‌ها" },
  { command: "taglinks", description: "لینک کنار تگ/کلمه" },
  { command: "quote", description: "نقل‌قول کردن بخشی از کپشن" },
  { command: "italic", description: "کج کردن بخشی از کپشن" },
  { command: "bold", description: "بولد کردن بخشی از کپشن" },
  { command: "decor", description: "زیرخط / خط‌خورده / اسپویلر" },
  { command: "emoji", description: "ایموجی‌گذاری در کپشن" },
  { command: "title", description: "استایل سریع خط اول" },
  { command: "append", description: "پیشوند و پسوند کپشن" },
  { command: "clean", description: "پاکسازی لینک/منشن/طول متن" },
  { command: "lock", description: "قفل انواع رسانه و محتوا" },
  { command: "delivery", description: "تنظیمات ارسال (سایلنت/پین/تاخیر)" },
  { command: "show", description: "نمایش تمام تنظیمات" },
  { command: "reset", description: "ریست تنظیمات" },
  { command: "help", description: "راهنما" },
];

async function registerCommands() {
  await tg("setMyCommands", {
    commands: COMMANDS,
    scope: { type: "chat", chat_id: ADMIN_ID },
  });
}

// ==================== مسیریابی Callback ها ====================

async function handleCallback(env, cq) {
  if (!isAdmin(cq.from)) {
    await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "دسترسی ندارید." });
    return;
  }
  const chatId = cq.message.chat.id;
  const messageId = cq.message.message_id;
  const data = cq.data || "";
  const cfg = await getConfig(env);

  try {
    if (data === "m:main") await showMain(chatId, messageId);
    else if (data === "m:source") await showSourceMenu(cfg, chatId, messageId);
    else if (data === "m:cut") await showCutMenu(chatId, messageId);
    else if (data === "m:hashtags") await showHashtagsMenu(cfg, chatId, messageId);
    else if (data === "m:quote") await showQuoteMenu(cfg, chatId, messageId);
    else if (data === "m:italic") await showItalicMenu(cfg, chatId, messageId);
    else if (data === "m:bold") await showBoldMenu(cfg, chatId, messageId);
    else if (data === "m:decor") await showDecorMenu(chatId, messageId);
    else if (data === "m:emoji") await showEmojiMenu(chatId, messageId);
    else if (data === "m:title") await showTitleMenu(cfg, chatId, messageId);
    else if (data === "m:append") await showAppendMenu(cfg, chatId, messageId);
    else if (data === "m:clean") await showCleanMenu(cfg, chatId, messageId);
    else if (data === "m:lock") await showLockMenu(cfg, chatId, messageId);
    else if (data === "m:delivery") await showDeliveryMenu(cfg, chatId, messageId);
    else if (data === "m:show") await showConfigDump(cfg, chatId, messageId);
    else if (data === "m:reset") await showResetConfirm(chatId, messageId);
    else if (data === "reset:confirm") {
      const keep = { source: cfg.source, channels: cfg.channels };
      await saveConfig(env, deepMerge(DEFAULT_CFG, keep));
      await showMain(chatId, messageId);
    }
    else if (data.startsWith("list:")) {
      const key = data.split(":")[1];
      await showListMenu(cfg, key, chatId, messageId);
    }
    else if (data.startsWith("listadd:")) {
      const key = data.split(":")[1];
      const def = LIST_DEFS[key];
      await setState(env, { step: "list_add", key, stage: 1, data: {} });
      const prompt = def.ask || def.ask1;
      await edit(chatId, messageId, prompt, kb([backRow(`list:${key}`)]));
    }
    else if (data.startsWith("listdel:")) {
      const [, key, idxStr] = data.split(":");
      const def = LIST_DEFS[key];
      const arr = getByPath(cfg, def.path) || [];
      arr.splice(Number(idxStr), 1);
      setByPath(cfg, def.path, arr);
      await saveConfig(env, cfg);
      await showListMenu(cfg, key, chatId, messageId);
    }
    else if (data.startsWith("ht:mode:")) {
      cfg.hashtags.mode = data.split(":")[2];
      await saveConfig(env, cfg);
      await showHashtagsMenu(cfg, chatId, messageId);
    }
    else if (data.startsWith("toggle:")) {
      const path = data.slice("toggle:".length);
      setByPath(cfg, path, !getByPath(cfg, path));
      await saveConfig(env, cfg);
      await routeBackToMenuFor(path, cfg, chatId, messageId);
    }
    else if (data === "titletoggle") {
      cfg.titleStyle.enabled = !cfg.titleStyle.enabled;
      await saveConfig(env, cfg);
      await showTitleMenu(cfg, chatId, messageId);
    }
    else if (data.startsWith("titlestyle:")) {
      cfg.titleStyle.style = data.split(":")[1];
      cfg.titleStyle.enabled = true;
      await saveConfig(env, cfg);
      await showTitleMenu(cfg, chatId, messageId);
    }
    else if (data === "titlesep") {
      cfg.titleStyle.separator = !cfg.titleStyle.separator;
      await saveConfig(env, cfg);
      await showTitleMenu(cfg, chatId, messageId);
    }
    else if (data === "clearappend") {
      cfg.append = { prefix: "", suffix: "" };
      await saveConfig(env, cfg);
      await showAppendMenu(cfg, chatId, messageId);
    }
    else if (data.startsWith("lock:")) {
      const key = data.split(":")[1];
      if (key === "longCaption") cfg.restrictions.longCaption.enabled = !cfg.restrictions.longCaption.enabled;
      else if (key === "duplicate") cfg.restrictions.duplicate.enabled = !cfg.restrictions.duplicate.enabled;
      else cfg.restrictions[key] = !cfg.restrictions[key];
      await saveConfig(env, cfg);
      await showLockMenu(cfg, chatId, messageId);
    }
    else if (data.startsWith("chtoggle:")) {
      const i = Number(data.split(":")[1]);
      cfg.channels[i].enabled = cfg.channels[i].enabled === false ? true : false;
      await saveConfig(env, cfg);
      await showSourceMenu(cfg, chatId, messageId);
    }
    else if (data.startsWith("chdel:")) {
      const i = Number(data.split(":")[1]);
      cfg.channels.splice(i, 1);
      await saveConfig(env, cfg);
      await showSourceMenu(cfg, chatId, messageId);
    }
    else if (data.startsWith("ask:")) {
      const what = data.split(":")[1];
      const map = {
        source: { step: "await_source", prompt: "یک پیام از گروه منبع را فوروارد کنید یا آیدی عددی گروه را بفرستید.", back: "m:source" },
        channel: { step: "await_channel", prompt: "یک پیام از کانال را فوروارد کنید، یا @username یا آیدی عددی آن را بفرستید.", back: "m:source" },
        prefix: { step: "await_prefix", prompt: "متن پیشوند را بفرستید.", back: "m:append" },
        suffix: { step: "await_suffix", prompt: "متن پسوند را بفرستید.", back: "m:append" },
        maxlen: { step: "await_maxlen", prompt: "حداکثر طول کپشن را به‌صورت عدد بفرستید (مثلا 800).", back: "m:clean" },
        delay: { step: "await_delay", prompt: "تعداد ثانیه تاخیر قبل از ارسال را بفرستید (0 تا 120).", back: "m:delivery" },
      };
      const conf = map[what];
      await setState(env, { step: conf.step });
      await edit(chatId, messageId, conf.prompt, kb([backRow(conf.back)]));
    }
  } catch (e) {
    console.log("callback error", e.message, e.stack);
  }

  await tg("answerCallbackQuery", { callback_query_id: cq.id });
}

async function routeBackToMenuFor(path, cfg, chatId, messageId) {
  if (path.startsWith("quote.")) return showQuoteMenu(cfg, chatId, messageId);
  if (path.startsWith("italic.")) return showItalicMenu(cfg, chatId, messageId);
  if (path.startsWith("bold.")) return showBoldMenu(cfg, chatId, messageId);
  if (path.startsWith("clean.")) return showCleanMenu(cfg, chatId, messageId);
  if (path.startsWith("delivery.")) return showDeliveryMenu(cfg, chatId, messageId);
  return showMain(chatId, messageId);
}

// ==================== مسیریابی پیام‌های متنی مدیر (FSM) ====================

async function handleAdminText(env, msg) {
  const chatId = msg.chat.id;
  const state = await getState(env);
  if (!state) {
    await tg("sendMessage", { chat_id: chatId, text: "برای مشاهده منو /menu را بزنید." });
    return;
  }
  const cfg = await getConfig(env);
  const text = (msg.text || "").trim();
  const forwardChatId = msg.forward_from_chat?.id || msg.forward_origin?.chat?.id || null;
  const forwardTitle = msg.forward_from_chat?.title || msg.forward_origin?.chat?.title || "";

  if (state.step === "list_add") {
    const def = LIST_DEFS[state.key];
    const arr = getByPath(cfg, def.path) || [];

    if (def.kind === "text") {
      if (!text) return;
      arr.push(text);
      setByPath(cfg, def.path, arr);
      await saveConfig(env, cfg);
      await clearState(env);
      await tg("sendMessage", { chat_id: chatId, text: "✅ اضافه شد." });
    } else if (def.kind === "pair") {
      if (state.stage === 1) {
        state.data.from = text;
        state.stage = 2;
        await setState(env, state);
        await tg("sendMessage", { chat_id: chatId, text: def.ask2 });
      } else {
        const to = text === "-" ? "" : text;
        arr.push({ from: state.data.from, to });
        setByPath(cfg, def.path, arr);
        await saveConfig(env, cfg);
        await clearState(env);
        await tg("sendMessage", { chat_id: chatId, text: "✅ اضافه شد." });
      }
    } else if (def.kind === "lineNumber") {
      const n = parseInt(text, 10);
      if (!n || n < 1) {
        await tg("sendMessage", { chat_id: chatId, text: "یک عدد معتبر (از ۱ به بالا) بفرستید." });
        return;
      }
      arr.push(n);
      setByPath(cfg, def.path, arr);
      await saveConfig(env, cfg);
      await clearState(env);
      await tg("sendMessage", { chat_id: chatId, text: "✅ اضافه شد." });
    } else if (def.kind === "lineEmoji") {
      if (state.stage === 1) {
        const n = parseInt(text, 10);
        if (!n || n < 1) {
          await tg("sendMessage", { chat_id: chatId, text: "شماره خط را به‌صورت عدد بفرستید." });
          return;
        }
        state.data.line = n;
        state.stage = 2;
        await setState(env, state);
        await tg("sendMessage", { chat_id: chatId, text: "حالا ایموجی مورد نظر را بفرستید." });
      } else {
        arr.push({ line: state.data.line, emoji: text });
        setByPath(cfg, def.path, arr);
        await saveConfig(env, cfg);
        await clearState(env);
        await tg("sendMessage", { chat_id: chatId, text: "✅ اضافه شد." });
      }
    } else if (def.kind === "emojiPair") {
      if (state.stage === 1) {
        state.data.phrase = text;
        state.stage = 2;
        await setState(env, state);
        await tg("sendMessage", { chat_id: chatId, text: "حالا ایموجی مورد نظر را بفرستید." });
      } else {
        arr.push({ phrase: state.data.phrase, emoji: text });
        setByPath(cfg, def.path, arr);
        await saveConfig(env, cfg);
        await clearState(env);
        await tg("sendMessage", { chat_id: chatId, text: "✅ اضافه شد." });
      }
    } else if (def.kind === "taglink") {
      if (state.stage === 1) {
        state.data.trigger = text;
        state.stage = 2;
        await setState(env, state);
        await tg("sendMessage", { chat_id: chatId, text: "حالا آدرس لینک (URL) را بفرستید. مثلا: https://t.me/example" });
      } else if (state.stage === 2) {
        if (!/^https?:\/\//i.test(text)) {
          await tg("sendMessage", { chat_id: chatId, text: "آدرس باید با http:// یا https:// شروع شود." });
          return;
        }
        state.data.url = text;
        state.stage = 3;
        await setState(env, state);
        await tg("sendMessage", { chat_id: chatId, text: "حالا متنی که به‌عنوان لینک نمایش داده شود را بفرستید (برای استفاده از خود آدرس، بفرستید: -)" });
      } else {
        const label = text === "-" ? "" : text;
        arr.push({ trigger: state.data.trigger, url: state.data.url, label });
        setByPath(cfg, def.path, arr);
        await saveConfig(env, cfg);
        await clearState(env);
        await tg("sendMessage", { chat_id: chatId, text: "✅ اضافه شد." });
      }
    }
    return;
  }

  switch (state.step) {
    case "await_source": {
      let id = forwardChatId;
      if (!id && /^-?\d+$/.test(text)) id = Number(text);
      if (!id) return tg("sendMessage", { chat_id: chatId, text: "ورودی نامعتبر است." });
      cfg.source = { id, title: forwardTitle || String(id) };
      await saveConfig(env, cfg);
      await clearState(env);
      await tg("sendMessage", { chat_id: chatId, text: "✅ گروه منبع تنظیم شد." });
      break;
    }
    case "await_channel": {
      let id = forwardChatId;
      let title = forwardTitle;
      if (!id && text.startsWith("@")) {
        const info = await tg("getChat", { chat_id: text });
        if (info.ok) { id = info.result.id; title = info.result.title || text; }
      } else if (!id && /^-?\d+$/.test(text)) { id = Number(text); title = text; }
      if (!id) return tg("sendMessage", { chat_id: chatId, text: "ورودی نامعتبر است." });
      if (!cfg.channels.find((c) => c.id === id)) {
        cfg.channels.push({ id, title, enabled: true });
        await saveConfig(env, cfg);
      }
      await clearState(env);
      await tg("sendMessage", { chat_id: chatId, text: "✅ کانال اضافه شد. (مطمئن شوید ربات در آن ادمین با دسترسی ارسال پست است)" });
      break;
    }
    case "await_prefix":
      cfg.append.prefix = text;
      await saveConfig(env, cfg);
      await clearState(env);
      await tg("sendMessage", { chat_id: chatId, text: "✅ پیشوند تنظیم شد." });
      break;
    case "await_suffix":
      cfg.append.suffix = text;
      await saveConfig(env, cfg);
      await clearState(env);
      await tg("sendMessage", { chat_id: chatId, text: "✅ پسوند تنظیم شد." });
      break;
    case "await_maxlen": {
      const n = parseInt(text, 10);
      if (!n || n < 10) return tg("sendMessage", { chat_id: chatId, text: "عدد معتبر بفرستید." });
      cfg.clean.maxLength = Math.min(n, 1024);
      await saveConfig(env, cfg);
      await clearState(env);
      await tg("sendMessage", { chat_id: chatId, text: "✅ تنظیم شد." });
      break;
    }
    case "await_delay": {
      const n = parseInt(text, 10);
      if (isNaN(n) || n < 0) return tg("sendMessage", { chat_id: chatId, text: "عدد معتبر بفرستید." });
      cfg.delivery.delaySeconds = Math.min(n, 120);
      await saveConfig(env, cfg);
      await clearState(env);
      await tg("sendMessage", { chat_id: chatId, text: "✅ تنظیم شد." });
      break;
    }
    default:
      await clearState(env);
  }
}

// ==================== ورود اصلی ====================

const COMMAND_MENU_MAP = {
  "/menu": (cfg, chatId) => showMain(chatId, null),
  "/source": (cfg, chatId) => showSourceMenu(cfg, chatId, null),
  "/cut": (cfg, chatId) => showCutMenu(chatId, null),
  "/replace": (cfg, chatId) => showListMenu(cfg, "replace", chatId, null),
  "/hashtags": (cfg, chatId) => showHashtagsMenu(cfg, chatId, null),
  "/taglinks": (cfg, chatId) => showListMenu(cfg, "taglinks", chatId, null),
  "/quote": (cfg, chatId) => showQuoteMenu(cfg, chatId, null),
  "/italic": (cfg, chatId) => showItalicMenu(cfg, chatId, null),
  "/bold": (cfg, chatId) => showBoldMenu(cfg, chatId, null),
  "/decor": (cfg, chatId) => showDecorMenu(chatId, null),
  "/emoji": (cfg, chatId) => showEmojiMenu(chatId, null),
  "/title": (cfg, chatId) => showTitleMenu(cfg, chatId, null),
  "/append": (cfg, chatId) => showAppendMenu(cfg, chatId, null),
  "/clean": (cfg, chatId) => showCleanMenu(cfg, chatId, null),
  "/lock": (cfg, chatId) => showLockMenu(cfg, chatId, null),
  "/delivery": (cfg, chatId) => showDeliveryMenu(cfg, chatId, null),
  "/show": (cfg, chatId) => showConfigDump(cfg, chatId, null),
  "/reset": (cfg, chatId) => showResetConfirm(chatId, null),
};

async function handleMessage(env, msg) {
  if (msg.chat.type === "private") {
    if (!isAdmin(msg.from)) return; // فقط مدیر
    const text = (msg.text || "").split(" ")[0];

    if (text === "/start") {
      await clearState(env);
      await registerCommands();
      await showMain(msg.chat.id, null);
      return;
    }
    if (text === "/help") {
      await tg("sendMessage", { chat_id: msg.chat.id, text: "همه بخش‌ها از منوی /menu یا دستورات کنار دکمه استیکر قابل دسترسی هستند." });
      return;
    }
    if (COMMAND_MENU_MAP[text]) {
      const cfg = await getConfig(env);
      await clearState(env);
      await COMMAND_MENU_MAP[text](cfg, msg.chat.id);
      return;
    }
    await handleAdminText(env, msg);
    return;
  }

  // پیام از گروه/کانال دیگر - فقط اگر گروه منبع ثبت شده باشد پردازش می‌شود
  const cfg = await getConfig(env);
  if (cfg.source && msg.chat && msg.chat.id === cfg.source.id) {
    if (msg.media_group_id) await bufferAlbumItem(env, cfg, msg);
    else await processSingleMessage(env, cfg, msg);
  }
}

async function handleUpdate(env, update) {
  try {
    if (update.callback_query) await handleCallback(env, update.callback_query);
    else if (update.message) await handleMessage(env, update.message);
  } catch (e) {
    console.log("handleUpdate error", e.message, e.stack);
  }
}

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") return new Response("bot is running");
    if (WEBHOOK_SECRET) {
      const secret = request.headers.get("x-telegram-bot-api-secret-token");
      if (secret !== WEBHOOK_SECRET) return new Response("forbidden", { status: 403 });
    }
    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("bad request", { status: 400 });
    }
    ctx.waitUntil(handleUpdate(env, update));
    return new Response("OK");
  },
};
