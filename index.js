/*
============================================================
  BARCHI ARZ | برچی ارز
  Cloudflare Worker - Single File
  Source: SARAFI.AF
  Market: سرای شهزاده
  KV: BARCHI_ARZ_KV

  Currency rates:
  https://m.sarafi.af/fa/exchange-rates

  Cron:
  * * * * *

  Random checks:
  2 checks inside every 10-minute window

  History:
  90 days
============================================================
*/

const SOURCE_URL = "https://m.sarafi.af/fa/exchange-rates";

const CURRENT_KEY = "barchi:current";
const HISTORY_KEY = "barchi:history";
const SCHEDULE_PREFIX = "barchi:schedule:";

const HISTORY_DAYS = 90;
const HISTORY_MAX = 1200;

const CURRENCY_NAMES = {
  AFN: "افغانی",
  USD: "دالر آمریکا",
  EUR: "یورو",
  GBP: "پوند انگلیس",
  IRR: "تومان ایران",
  PKR: "روپیه پاکستان",
  SAR: "ریال سعودی",
  AED: "درهم امارات",
  CHF: "فرانک سوئیس",
  AUD: "دالر استرالیا",
  CAD: "دالر کانادا",
  RUB: "روبل روسیه",
  DKK: "کرون دانمارک",
  SEK: "کرون سویدن",
  NOK: "کرون ناروی",
  TRY: "لیره ترکیه",
  CNY: "یوان چین",
  KWD: "دینار کویت",
  QAR: "ریال قطر",
  BHD: "دینار بحرین",
  JPY: "ین جاپان"
};

/*
============================================================
  FLAG SOURCES
  No Emoji flags.
  Real image files from FlagCDN.
============================================================
*/

const FLAGS = {
  AFN: "af",
  USD: "us",
  EUR: "eu",
  GBP: "gb",
  IRR: "ir",
  PKR: "pk",
  SAR: "sa",
  AED: "ae",
  CHF: "ch",
  AUD: "au",
  CAD: "ca",
  RUB: "ru",
  DKK: "dk",
  SEK: "se",
  NOK: "no",
  TRY: "tr",
  CNY: "cn",
  KWD: "kw",
  QAR: "qa",
  BHD: "bh",
  JPY: "jp"
};

function flagURL(code, size = 40) {
  const country = FLAGS[code];

  if (!country) {
    return "https://flagcdn.com/" + size + "x30/un.png";
  }

  return "https://flagcdn.com/" + size + "x30/" + country + ".png";
}


/*
============================================================
  WORKER
============================================================
*/

export default {

  async fetch(request, env, ctx) {

    const url = new URL(request.url);

    /*
    -----------------------------
      WEBSITE
    -----------------------------
    */

    if (
      url.pathname === "/" ||
      url.pathname === "/index.html"
    ) {
      return new Response(HTML, {
        headers: {
          "content-type": "text/html; charset=UTF-8",
          "cache-control": "public, max-age=60"
        }
      });
    }


    /*
    -----------------------------
      CURRENT RATES
    -----------------------------
    */

    if (url.pathname === "/api/rates") {

      let current = await env.BARCHI_ARZ_KV.get(
        CURRENT_KEY,
        { type: "json" }
      );

      /*
        First request:
        If KV is empty, fetch SARAFI.AF immediately.
      */

      if (!current || !current.rates || !current.rates.length) {

        try {

          current = await refreshRates(
            env,
            Date.now()
          );

        } catch (error) {

          return json({
            ok: false,
            error: "دریافت نرخ ارز از منبع انجام نشد.",
            message: String(error)
          }, 503);
        }
      }

      return json({
        ok: true,
        source: SOURCE_URL,
        market: "سرای شهزاده",
        updatedAt: current.updatedAt,
        rates: current.rates
      });
    }


    /*
    -----------------------------
      HISTORY
    -----------------------------
    */

    if (url.pathname === "/api/history") {

      const code = (
        url.searchParams.get("code") ||
        "USD"
      ).toUpperCase();

      const history =
        await env.BARCHI_ARZ_KV.get(
          HISTORY_KEY,
          { type: "json" }
        ) || [];

      const result = [];

      for (const snapshot of history) {

        const rate = snapshot.rates.find(
          item => item.code === code
        );

        if (!rate) continue;

        result.push({
          time: snapshot.time,
          buy: rate.buy,
          sell: rate.sell
        });
      }

      return json({
        ok: true,
        code,
        data: result.slice(-100)
      });
    }


    /*
    -----------------------------
      SOURCE
    -----------------------------
    */

    if (url.pathname === "/api/source") {

      return json({
        ok: true,
        source: SOURCE_URL,
        market: "سرای شهزاده"
      });
    }


    return new Response("Not Found", {
      status: 404
    });
  },


  /*
  ============================================================
    CRON
  ============================================================
  */

  async scheduled(event, env, ctx) {

    const now =
      event.scheduledTime || Date.now();

    /*
      Every 10 minutes create two random minutes.

      Example:

      [3,8]

      or

      [5,7]

      or

      [1,6]
    */

    const windowStart =
      Math.floor(now / 600000) * 600000;

    const scheduleKey =
      SCHEDULE_PREFIX + windowStart;

    let schedule =
      await env.BARCHI_ARZ_KV.get(
        scheduleKey,
        { type: "json" }
      );

    if (!schedule) {

      const minutes = randomTwoMinutes();

      schedule = {
        minutes,
        createdAt: now
      };

      await env.BARCHI_ARZ_KV.put(
        scheduleKey,
        JSON.stringify(schedule),
        {
          expiration:
            Math.floor(
              (windowStart + 15 * 60 * 1000) / 1000
            )
        }
      );
    }


    const currentMinute =
      Math.floor(
        (now - windowStart) / 60000
      );


    /*
      Check whether this minute
      is one of our two random minutes.
    */

    if (
      schedule.minutes.includes(
        currentMinute
      )
    ) {

      ctx.waitUntil(
        refreshRates(
          env,
          now
        ).catch(() => {})
      );
    }


    /*
      Daily history cleanup.
    */

    const date = new Date(now);

    if (
      date.getUTCHours() === 0 &&
      date.getUTCMinutes() === 0
    ) {

      ctx.waitUntil(
        cleanHistory(env).catch(() => {})
      );
    }
  }
};


/*
============================================================
  RANDOM TWO MINUTES
============================================================
*/

function randomTwoMinutes() {

  const array =
    new Uint32Array(2);

  crypto.getRandomValues(array);

  const first =
    array[0] % 10;

  let second =
    array[1] % 10;

  while (second === first) {
    second =
      (second + 1) % 10;
  }

  return [
    Math.min(first, second),
    Math.max(first, second)
  ];
}


/*
============================================================
  FETCH SARAFI
============================================================
*/

async function refreshRates(env, now) {

  const response =
    await fetch(
      SOURCE_URL,
      {
        method: "GET",

        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; BarchiArz/1.0)",

          "Accept":
            "text/html,application/xhtml+xml",

          "Accept-Language":
            "fa-IR,fa;q=0.9,en;q=0.8",

          "Cache-Control":
            "no-cache"
        }
      }
    );


  if (!response.ok) {

    throw new Error(
      "SARAFI.AF HTTP " +
      response.status
    );
  }


  const html =
    await response.text();


  const rates =
    parseSarafiTable(html);


  if (!rates.length) {

    throw new Error(
      "نرخ ارز از جدول SARAFI.AF پیدا نشد."
    );
  }


  /*
    AFN is the base currency.
  */

  rates.unshift({
    code: "AFN",
    nameFa: CURRENCY_NAMES.AFN,
    buy: 1,
    sell: 1,
    unitLabel: "",
    flag: flagURL("AFN", 40)
  });


  const snapshot = {

    time: now,

    source: SOURCE_URL,

    market: "سرای شهزاده",

    rates
  };


  const old =
    await env.BARCHI_ARZ_KV.get(
      CURRENT_KEY,
      { type: "json" }
    );


  /*
    Compare only actual rates.
  */

  const changed =
    !old ||
    JSON.stringify(old.rates) !==
    JSON.stringify(rates);


  /*
    No change:
    do not waste KV writes.
  */

  if (!changed) {

    return old;
  }


  /*
    Save current rates.
  */

  await env.BARCHI_ARZ_KV.put(
    CURRENT_KEY,
    JSON.stringify({
      ...snapshot,
      historyCount:
        Number(old?.historyCount || 0) + 1
    })
  );


  /*
    Save history.
  */

  let history =
    await env.BARCHI_ARZ_KV.get(
      HISTORY_KEY,
      { type: "json" }
    ) || [];


  const cutoff =
    now -
    HISTORY_DAYS *
    24 *
    60 *
    60 *
    1000;


  /*
    Delete data older than 90 days.
  */

  history =
    history.filter(
      item =>
        Number(item.time) >= cutoff
    );


  /*
    Add new snapshot.
  */

  history.push(snapshot);


  /*
    If storage becomes large,
    remove oldest data first.
  */

  if (history.length > HISTORY_MAX) {

    history =
      history.slice(
        history.length - HISTORY_MAX
      );
  }


  await env.BARCHI_ARZ_KV.put(
    HISTORY_KEY,
    JSON.stringify(history)
  );


  return snapshot;
}


/*
============================================================
  SARAFI TABLE PARSER
============================================================
*/

function parseSarafiTable(html) {

  /*
    Remove scripts/styles.
  */

  html =
    html
      .replace(
        /<script\b[\s\S]*?<\/script>/gi,
        ""
      )
      .replace(
        /<style\b[\s\S]*?<\/style>/gi,
        ""
      );


  const tables =
    html.match(
      /<table\b[\s\S]*?<\/table>/gi
    ) || [];


  let selectedTable = null;

  let bestScore = -1;


  /*
    Find the table containing:
    واحد پول / خرید / فروش
    and common currency codes.
  */

  for (const table of tables) {

    const text =
      cleanText(table);

    let score = 0;


    if (
      /واحد\s*پول/i.test(text)
    ) {
      score += 5;
    }


    if (/خرید/i.test(text)) {
      score += 3;
    }


    if (/فروش/i.test(text)) {
      score += 3;
    }


    const commonCodes = [
      "USD",
      "EUR",
      "GBP",
      "SAR",
      "AED",
      "CHF",
      "AUD",
      "CAD"
    ];


    for (const code of commonCodes) {

      if (
        new RegExp(
          "\\b" + code + "\\b"
        ).test(text)
      ) {
        score++;
      }
    }


    if (score > bestScore) {

      bestScore = score;

      selectedTable = table;
    }
  }


  if (!selectedTable) {
    return [];
  }


  const rows =
    selectedTable.match(
      /<tr\b[\s\S]*?<\/tr>/gi
    ) || [];


  const rates = [];


  for (const row of rows) {

    const cells =
      extractCells(row);


    if (cells.length < 3) {
      continue;
    }


    const first =
      cleanText(cells[0]);


    /*
      Example:

      USD - دالر آمریکا
    */

    const codeMatch =
      first.match(
        /\b([A-Z]{3})\b/
      );


    if (!codeMatch) {
      continue;
    }


    const code =
      codeMatch[1];


    if (
      !CURRENCY_NAMES[code]
    ) {
      continue;
    }


    const buy =
      parseRate(cells[1]);


    const sell =
      parseRate(cells[2]);


    if (
      !Number.isFinite(buy) ||
      !Number.isFinite(sell)
    ) {
      continue;
    }


    /*
      SARAFI currently displays
      some currencies in thousands.
    */

    const unitLabel =
      /هزار/i.test(first)
        ? "هزار"
        : "";


    rates.push({

      code,

      nameFa:
        CURRENCY_NAMES[code],

      buy,

      sell,

      unitLabel,

      flag:
        flagURL(code, 40)
    });
  }


  /*
    Remove duplicate codes.
  */

  const unique = [];

  const seen =
    new Set();


  for (const item of rates) {

    if (seen.has(item.code)) {
      continue;
    }

    seen.add(item.code);

    unique.push(item);
  }


  return unique;
}


/*
============================================================
  HTML HELPERS
============================================================
*/

function extractCells(row) {

  const cells = [];

  const regex =
    /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi;

  let match;


  while (
    (match = regex.exec(row)) !== null
  ) {

    cells.push(match[1]);
  }


  return cells;
}


function cleanText(value) {

  return decodeEntities(
    String(value || "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}


function decodeEntities(value) {

  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(
      /&#(\d+);/g,
      (_, n) =>
        String.fromCodePoint(
          Number(n)
        )
    )
    .replace(
      /&#x([0-9a-f]+);/gi,
      (_, n) =>
        String.fromCodePoint(
          parseInt(n, 16)
        )
    );
}


function normalizeDigits(value) {

  return String(value)

    .replace(/[۰-۹]/g, d =>
      "۰۱۲۳۴۵۶۷۸۹".indexOf(d)
    )

    .replace(/[٠-٩]/g, d =>
      "٠١٢٣٤٥٦٧٨٩".indexOf(d)
    );
}


function parseRate(value) {

  const text =
    normalizeDigits(
      cleanText(value)
    );


  /*
    Keep decimal point.
  */

  const match =
    text.match(
      /-?\d+(?:[.,]\d+)?/
    );


  if (!match) {
    return NaN;
  }


  return Number(
    match[0]
      .replace(/,/g, ".")
  );
}


/*
============================================================
  HISTORY CLEANUP
============================================================
*/

async function cleanHistory(env) {

  const history =
    await env.BARCHI_ARZ_KV.get(
      HISTORY_KEY,
      { type: "json" }
    );


  if (!Array.isArray(history)) {
    return;
  }


  const cutoff =
    Date.now() -
    HISTORY_DAYS *
    24 *
    60 *
    60 *
    1000;


  const cleaned =
    history.filter(
      item =>
        Number(item.time) >= cutoff
    );


  if (
    cleaned.length !==
    history.length
  ) {

    await env.BARCHI_ARZ_KV.put(
      HISTORY_KEY,
      JSON.stringify(cleaned)
    );
  }
}


/*
============================================================
  JSON RESPONSE
============================================================
*/

function json(data, status = 200) {

  return new Response(
    JSON.stringify(data),
    {
      status,

      headers: {
        "content-type":
          "application/json; charset=UTF-8",

        "cache-control":
          "no-store",

        "access-control-allow-origin":
          "*"
      }
    }
  );
}


/*
============================================================
  WEBSITE
============================================================
*/

const HTML = String.raw`<!DOCTYPE html>

<html lang="fa" dir="rtl">

<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1"
>

<title>برچی ارز | Barchi Arz</title>

<meta
  name="description"
  content="نرخ لحظه‌ای ارزهای پولی افغانستان"
>

<script
  src="https://cdn.jsdelivr.net/npm/chart.js"
></script>

<style>

* {
  box-sizing: border-box;
}

html {
  scroll-behavior: smooth;
}

body {
  margin: 0;
  background:
    radial-gradient(
      circle at top right,
      #17277a 0,
      #080d35 35%,
      #030622 100%
    );
  color: #fff;
  font-family:
    Tahoma,
    Arial,
    sans-serif;
}

button,
input,
select {
  font: inherit;
}

.container {
  width: min(1180px, 94%);
  margin: auto;
}

.header {
  padding: 22px 0;
}

.header-box {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;

  padding: 18px;

  border: 1px solid
    rgba(255,255,255,.08);

  background:
    rgba(12,18,65,.72);

  backdrop-filter:
    blur(20px);

  border-radius: 24px;

  box-shadow:
    0 20px 70px
    rgba(0,0,0,.35);
}

.brand {
  display: flex;
  align-items: center;
  gap: 13px;
}

.brand img {
  width: 48px;
  height: 48px;
  object-fit: contain;
  border-radius: 13px;
}

.brand-name {
  font-size: 23px;
  font-weight: 900;
}

.brand-en {
  color: #5fa8ff;
  font-size: 12px;
  margin-top: 3px;
}

.status {
  display: flex;
  align-items: center;
  gap: 8px;

  padding: 10px 13px;

  border-radius: 14px;

  background:
    rgba(25,197,123,.08);

  border: 1px solid
    rgba(25,197,123,.18);

  color: #9df2c9;

  font-size: 12px;
}

.status-dot {
  width: 9px;
  height: 9px;

  border-radius: 50%;

  background: #20d88a;

  box-shadow:
    0 0 15px #20d88a;
}

.hero {
  margin-top: 20px;
  padding: 30px;

  border-radius: 30px;

  background:
    linear-gradient(
      135deg,
      rgba(25,45,145,.78),
      rgba(7,13,54,.82)
    );

  border: 1px solid
    rgba(255,255,255,.08);
}

.hero h1 {
  margin: 0;
  font-size: clamp(27px, 5vw, 48px);
  font-weight: 900;
}

.hero p {
  color: #aeb9df;
  line-height: 2;
  margin: 12px 0 0;
}

.controls {
  display: grid;
  grid-template-columns:
    minmax(0, 1fr)
    auto;

  gap: 12px;

  margin: 20px 0;
}

.search {
  position: relative;
}

.search input {
  width: 100%;
  padding: 16px 20px;

  border-radius: 17px;

  border: 1px solid
    rgba(255,255,255,.09);

  background:
    rgba(7,12,48,.75);

  color: white;

  outline: none;
}

.source-btn {
  border: 0;
  padding: 0 20px;

  border-radius: 17px;

  background:
    linear-gradient(
      135deg,
      #2275ff,
      #664cff
    );

  color: white;

  cursor: pointer;
}

.info {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;

  margin-bottom: 20px;
}

.info-box {
  padding: 10px 14px;

  border-radius: 13px;

  background:
    rgba(255,255,255,.045);

  color: #aeb9df;

  font-size: 12px;
}

.info-box strong {
  color: white;
}

.grid {
  display: grid;

  grid-template-columns:
    repeat(
      auto-fit,
      minmax(250px, 1fr)
    );

  gap: 16px;
}

.card {
  position: relative;

  padding: 18px;

  border-radius: 23px;

  background:
    linear-gradient(
      145deg,
      rgba(22,32,105,.9),
      rgba(8,13,54,.91)
    );

  border: 1px solid
    rgba(255,255,255,.07);

  box-shadow:
    0 18px 50px
    rgba(0,0,0,.25);

  overflow: hidden;
}

.card::before {
  content: "";

  position: absolute;

  width: 100px;
  height: 100px;

  top: -50px;
  left: -50px;

  background: #347eff;

  filter: blur(55px);

  opacity: .25;
}

.currency-head {
  display: flex;
  align-items: center;

  gap: 12px;

  position: relative;
}

.flag {
  width: 42px;
  height: 31px;

  object-fit: cover;

  border-radius: 6px;

  background: #111;

  box-shadow:
    0 4px 15px
    rgba(0,0,0,.3);
}

.currency-name {
  flex: 1;
}

.currency-name strong {
  display: block;
  font-size: 16px;
}

.currency-name span {
  display: block;

  color: #8290c0;

  font-size: 11px;

  margin-top: 3px;
}

.code {
  direction: ltr;

  color: #6fa6ff;

  font-weight: 900;
}

.prices {
  display: grid;

  grid-template-columns:
    1fr 1fr;

  gap: 9px;

  margin-top: 17px;
}

.price {
  padding: 13px;

  border-radius: 15px;

  background:
    rgba(0,0,0,.16);
}

.price small {
  color: #8c99c6;
  display: block;
  margin-bottom: 5px;
}

.price b {
  font-size: 19px;
  direction: ltr;
  display: block;
}

.sell {
  border:
    1px solid
    rgba(56,135,255,.18);
}

.buy {
  border:
    1px solid
    rgba(33,214,145,.13);
}

.unit {
  margin-top: 9px;

  color: #8795c3;

  font-size: 11px;
}

.chart-wrap {
  height: 90px;

  margin-top: 14px;
}

.converter {
  margin-top: 20px;

  padding: 22px;

  border-radius: 24px;

  background:
    rgba(10,17,65,.75);

  border:
    1px solid
    rgba(255,255,255,.07);
}

.converter h2 {
  margin-top: 0;
}

.convert-row {
  display: grid;

  grid-template-columns:
    1fr 1fr;

  gap: 10px;
}

.convert-row input,
.convert-row select {
  width: 100%;

  padding: 14px;

  border-radius: 14px;

  background: #080e39;

  color: white;

  border:
    1px solid
    rgba(255,255,255,.1);

  outline: none;
}

.result {
  margin-top: 14px;

  padding: 18px;

  border-radius: 17px;

  background:
    linear-gradient(
      135deg,
      rgba(35,117,255,.18),
      rgba(100,76,255,.14)
    );

  font-size: 20px;

  font-weight: 900;

  text-align: center;
}

.footer {
  margin: 30px 0;

  text-align: center;

  color: #7180b0;

  font-size: 12px;

  line-height: 2;
}

.footer a {
  colo
