"use strict";
// KaratUp — весь сервер в одном файле: Express + Neon Postgres + Telegram-бот + раздача index.html (PWA).
try { process.loadEnvFile(); } catch (e) { /* .env необязателен: на Render переменные задаются в панели */ }
const express = require("express");
const crypto = require("crypto");
const path = require("path");
const { Pool, types } = require("pg");

/* ---------- правила игры и цены (источник правды — сервер) ---------- */
const START = 0, EDGE = 94, SELL = 0.9; // новые аккаунты начинают с 0 ⭐: баланс только за оплату Telegram Stars
const MULTS = [2, 3, 5, 10, 20, 50, 100];
const nm = s => String(s || "").trim().replace(/^@+/, "").toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 32);
const rand = () => crypto.randomInt(0, 1_000_000_000) / 1e9;
const uid = () => crypto.randomBytes(6).toString("hex");

const PRICE = {
  swirl: 458, wine: 458, cocoa: 458, pot: 458, egg: 400, y2025: 439,
  sakura: 872, board: 581, jack: 458, book: 458, wreath: 453, pen: 719,
  bow: 485, straw: 520, globe: 620, star: 781, heels: 1701, fur: 2231,
  hat: 785, skull: 1098, rose: 2224, ring: 2829, mit: 654, potion: 1243,
  bells: 785, locket: 1896, web: 1481, torch: 450, lib: 458, mask: 785,
  dog: 458, noodle: 458, lamp: 458, lolly: 458, pop: 458, flam: 456,
  pack: 458, cake: 458, poo: 458, snake: 395, sock: 445, bear: 950,
  dryer: 1180, fskull: 1300, zip: 458,
};

/* ---------- база (Neon) ---------- */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id          BIGSERIAL PRIMARY KEY,
  username    TEXT UNIQUE NOT NULL,
  tg_id       BIGINT UNIQUE,
  secret_hash TEXT,
  bal         BIGINT NOT NULL DEFAULT 0 CHECK (bal >= 0),
  banned      BOOLEAN NOT NULL DEFAULT false,
  v           INT NOT NULL DEFAULT 0,
  games       INT NOT NULL DEFAULT 0,
  wins        INT NOT NULL DEFAULT 0,
  profit      BIGINT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS items (
  seq        BIGSERIAL,
  uid        TEXT PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS items_user_idx ON items(user_id, seq);

CREATE TABLE IF NOT EXISTS payments (
  id         BIGSERIAL PRIMARY KEY,
  charge_id  TEXT UNIQUE NOT NULL,          -- telegram_payment_charge_id: защита от двойного зачисления
  user_id    BIGINT NOT NULL REFERENCES users(id),
  stars      BIGINT NOT NULL,
  payload    TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payments_user_idx ON payments(user_id, id);

CREATE TABLE IF NOT EXISTS broadcasts (
  id   BIGSERIAL PRIMARY KEY,
  text TEXT NOT NULL,
  ts   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS broadcast_seen (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bc_id   BIGINT NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, bc_id)
);
`;
types.setTypeParser(20, v => parseInt(v, 10)); // BIGINT -> number

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

const url = process.env.DATABASE_URL || "";
const pool = new Pool({
  connectionString: url,
  max: 8,
  ssl: url && !/localhost|127\.0\.0\.1/.test(url) ? { rejectUnauthorized: false } : false,
});
pool.on("error", e => console.error("pg pool error:", e.message));

async function tx(fn) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const r = await fn(c);
    await c.query("COMMIT");
    return r;
  } catch (e) {
    try { await c.query("ROLLBACK"); } catch (_) {}
    throw e;
  } finally { c.release(); }
}

async function lockUser(c, id) {
  const { rows } = await c.query("SELECT * FROM users WHERE id=$1 FOR UPDATE", [id]);
  return rows[0];
}
async function invOf(c, id) {
  const { rows } = await c.query("SELECT uid, key FROM items WHERE user_id=$1 ORDER BY seq", [id]);
  return rows;
}
async function migrate() { await pool.query(SCHEMA); await pool.query("DROP TABLE IF EXISTS mines_games, crash_bets"); }


/* ---------- авторизация и Telegram ---------- */
const auth = (() => {

const SECRET = process.env.SESSION_SECRET ||
  crypto.createHash("sha256").update("ku:" + (process.env.BOT_TOKEN || "") + (process.env.DATABASE_URL || "")).digest("hex");
const TTL = 30 * 24 * 3600 * 1000;

const sha = s => crypto.createHash("sha256").update(String(s)).digest("hex");
const sign = s => crypto.createHmac("sha256", SECRET).update(s).digest("base64url");
function safeEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function issue(uid) { const p = uid + "." + (Date.now() + TTL); return p + "." + sign(p); }
function verify(t) {
  const a = String(t || "").split(".");
  if (a.length !== 3) return null;
  if (!safeEq(sign(a[0] + "." + a[1]), a[2]) || Date.now() > +a[1]) return null;
  return +a[0];
}
function middleware(req, res, next) {
  const h = req.headers.authorization || "";
  const uid = verify(h.startsWith("Bearer ") ? h.slice(7) : "");
  if (!uid) return res.status(401).json({ error: "Требуется вход" });
  req.uid = uid; next();
}

// Проверка Telegram Mini App initData (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app)
function checkTelegram(initData, botToken, maxAgeSec = 86400) {
  if (!botToken) return null;
  const p = new URLSearchParams(String(initData || ""));
  const hash = p.get("hash"); if (!hash) return null;
  p.delete("hash");
  const str = [...p.entries()].sort(([a], [b]) => a < b ? -1 : 1).map(([k, v]) => k + "=" + v).join("\n");
  const key = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const calc = crypto.createHmac("sha256", key).update(str).digest("hex");
  if (!safeEq(calc, hash)) return null;
  if (Date.now() / 1000 - Number(p.get("auth_date") || 0) > maxAgeSec) return null;
  try { return JSON.parse(p.get("user") || "null"); } catch (e) { return null; }
}

function adminOk(pass) {
  const e = process.env.ADMIN_PASS;
  return !!e && safeEq(sha(pass || ""), sha(e));
}

// простой rate-limit по IP
const hits = new Map();
function limit(max, windowMs) {
  return (req, res, next) => {
    const k = req.ip + req.path, now = Date.now();
    let h = hits.get(k);
    if (!h || now > h.reset) h = { n: 0, reset: now + windowMs };
    h.n++; hits.set(k, h);
    if (h.n > max) return res.status(429).json({ error: "Слишком много попыток, подождите" });
    next();
  };
}
setInterval(() => { const now = Date.now(); for (const [k, h] of hits) if (now > h.reset) hits.delete(k); }, 60000).unref();

return { issue, verify, middleware, checkTelegram, adminOk, sha, safeEq, limit };
})();

const bot = (() => {
const TOKEN = process.env.BOT_TOKEN || "";
const secret = TOKEN ? crypto.createHash("sha256").update("wh:" + TOKEN).digest("hex").slice(0, 32) : "";
const appUrl = () => (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/$/, "");

async function api(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}),
  });
  return r.json();
}

// Пополнение звёздами Telegram: 1 Telegram Star = 1 ⭐ в игре
const MIN_DEP = 100, MAX_DEP = Math.max(MIN_DEP, parseInt(process.env.MAX_DEPOSIT, 10) || 10000);
const DEP_RE = /^dep:(\d+)$/;

async function createInvoice(user, amount) {
  if (!TOKEN) throw new HttpError(503, "Оплата не настроена на сервере (нет BOT_TOKEN)");
  const r = await api("createInvoiceLink", {
    title: `${amount} ⭐ для KaratUp`,
    description: `Пополнение баланса KaratUp на ${amount} ⭐`,
    payload: `dep:${user.id}`,
    provider_token: "",            // для Telegram Stars токен провайдера не нужен
    currency: "XTR",
    prices: [{ label: `${amount} ⭐`, amount }],
  });
  if (!r.ok) { console.error("createInvoiceLink:", r.description); throw new HttpError(502, "Не удалось создать счёт, попробуйте позже"); }
  return r.result;
}

// Telegram ждёт ответ на pre_checkout_query не дольше 10 секунд
async function preCheckout(q) {
  let ok = false, err = "Платёж отклонён";
  try {
    const m = DEP_RE.exec(q.invoice_payload || "");
    const amt = q.total_amount;
    if (m && q.currency === "XTR" && Number.isInteger(amt) && amt >= MIN_DEP && amt <= MAX_DEP) {
      const { rows } = await pool.query("SELECT banned FROM users WHERE id=$1 AND tg_id=$2", [+m[1], q.from.id]);
      if (rows[0] && !rows[0].banned) ok = true;
      else if (rows[0]) err = "Аккаунт заблокирован";
    }
  } catch (e) { console.error("pre_checkout:", e.message); err = "Ошибка сервера, попробуйте позже"; }
  await api("answerPreCheckoutQuery", { pre_checkout_query_id: q.id, ok, ...(ok ? {} : { error_message: err }) });
}

// Зачисление идемпотентно: charge_id уникален, повторная доставка апдейта ничего не добавит
async function paid(m) {
  const p = m.successful_payment;
  const mm = DEP_RE.exec(p.invoice_payload || "");
  if (!mm || p.currency !== "XTR") { console.error("Неизвестный платёж:", JSON.stringify(p)); return; }
  const amt = p.total_amount;
  const bal = await tx(async c => {
    const u = (await c.query("SELECT * FROM users WHERE id=$1 AND tg_id=$2 FOR UPDATE", [+mm[1], m.from.id])).rows[0];
    if (!u) throw new Error("пользователь не найден для платежа " + p.telegram_payment_charge_id);
    const ins = await c.query(
      "INSERT INTO payments(charge_id,user_id,stars,payload) VALUES($1,$2,$3,$4) ON CONFLICT (charge_id) DO NOTHING RETURNING id",
      [p.telegram_payment_charge_id, u.id, amt, p.invoice_payload]);
    if (!ins.rowCount) return null;                       // уже зачислено
    return (await c.query("UPDATE users SET bal=LEAST(bal+$2, 1000000000000) WHERE id=$1 RETURNING bal", [u.id, amt])).rows[0].bal;
  });
  if (bal !== null) {
    console.log(`Платёж ${p.telegram_payment_charge_id}: +${amt} ⭐ → user ${mm[1]}`);
    try { await api("sendMessage", { chat_id: m.chat.id, text: `✅ Оплата получена: +${amt} ⭐\nБаланс: ${bal} ⭐` }); } catch (e) { /* не критично */ }
  }
}

async function init() {
  if (!TOKEN) return console.log("BOT_TOKEN не задан — Telegram-бот и оплата отключены");
  const url = appUrl();
  if (!url.startsWith("https://")) return console.log("Нет https PUBLIC_URL — вебхук бота не установлен");
  try {
    // drop_pending_updates НЕ ставим: иначе при перезапуске сервера можно потерять неполученные платежи
    const r = await api("setWebhook", { url: `${url}/tg/webhook/${secret}`, allowed_updates: ["message", "pre_checkout_query"] });
    console.log("Telegram setWebhook:", r.ok ? "ok" : r.description);
    await api("setChatMenuButton", { menu_button: { type: "web_app", text: "🎮 Играть", web_app: { url } } });
    await api("setMyCommands", { commands: [
      { command: "start", description: "Открыть KaratUp" },
      { command: "paysupport", description: "Помощь по платежам" },
    ] });
  } catch (e) { console.error("Telegram init error:", e.message); }
}

async function handle(update) {
  if (!update) return;
  if (update.pre_checkout_query) return preCheckout(update.pre_checkout_query);
  const m = update.message;
  if (!m) return;
  if (m.successful_payment) return paid(m);
  if (!m.text) return;
  if (m.text.startsWith("/paysupport")) {
    const c = process.env.SUPPORT_CONTACT || "администратору";
    return void await api("sendMessage", { chat_id: m.chat.id,
      text: `По вопросам оплаты и возвратов Telegram Stars напишите ${c}. Укажите свой @username в игре и время платежа.` });
  }
  if (m.text.startsWith("/start")) {
    await api("sendMessage", {
      chat_id: m.chat.id,
      text: "⭐ KaratUp — апгрейды подарков. Пополняйте баланс звёздами Telegram прямо в приложении. 18+",
      reply_markup: { inline_keyboard: [[{ text: "🎮 Играть", web_app: { url: appUrl() } }]] },
    });
  }
}

return { init, handle, createInvoice, secret, TOKEN, MIN_DEP, MAX_DEP };
})();

/* ---------- приложение ---------- */
if (!process.env.DATABASE_URL) { console.error("Не задан DATABASE_URL (строка подключения Neon)"); process.exit(1); }

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "20kb" }));
const H = fn => (req, res, next) => fn(req, res).catch(next);
const A = auth.middleware;

/* ---------- helpers ---------- */
async function need(c, id) {
  const u = await lockUser(c, id);
  if (!u) throw new HttpError(401, "Требуется вход");
  return u;
}
const play = u => { if (u.banned) throw new HttpError(403, "Аккаунт заблокирован"); };
async function snap(c, u) {
  const inv = await invOf(c, u.id);
  return { user: u.username, bal: u.bal, inv, games: u.games, wins: u.wins, profit: u.profit, v: u.v, banned: u.banned };
}
const int = (x, lo, hi, msg) => { const n = Number(x); if (!Number.isInteger(n) || n < lo || n > hi) throw new HttpError(400, msg); return n; };
const newSecret = () => crypto.randomBytes(18).toString("hex");

/* ---------- служебное ---------- */
app.get("/healthz", (req, res) => res.json({ ok: true }));
app.post("/tg/webhook/:s", H(async (req, res) => {
  if (!bot.secret || !auth.safeEq(req.params.s, bot.secret)) return res.sendStatus(404);
  try { await bot.handle(req.body); }
  catch (e) {
    console.error("bot", e.message);
    // при сбое зачисления отвечаем 500 — Telegram повторит доставку, деньги не потеряются
    if (req.body && req.body.message && req.body.message.successful_payment) return res.sendStatus(500);
  }
  res.sendStatus(200);
}));

/* ---------- вход ---------- */
// Гость: username + локальный секрет (создаётся при первом входе, хранится в браузере)
app.post("/api/login", auth.limit(30, 60000), H(async (req, res) => {
  const name = nm(req.body.username);
  if (name.length < 3) throw new HttpError(400, "Юзернейм: от 3 символов (a–z, 0–9, _)");
  const secret = String(req.body.secret || "");
  const out = await tx(async c => {
    const { rows } = await c.query("SELECT * FROM users WHERE username=$1 FOR UPDATE", [name]);
    let u = rows[0], issued = null;
    if (!u) {
      issued = newSecret();
      u = (await c.query("INSERT INTO users(username,secret_hash,bal) VALUES($1,$2,$3) RETURNING *", [name, auth.sha(issued), START])).rows[0];
    } else if (u.tg_id) {
      throw new HttpError(403, "Это имя занято аккаунтом Telegram");
    } else if (!u.secret_hash) {          // аккаунт создан админом — первый вошедший забирает
      issued = newSecret();
      await c.query("UPDATE users SET secret_hash=$2 WHERE id=$1", [u.id, auth.sha(issued)]);
    } else if (!auth.safeEq(auth.sha(secret), u.secret_hash)) {
      throw new HttpError(403, "Имя занято. Выберите другой @username");
    }
    return { user: u.username, token: auth.issue(u.id), secret: issued };
  });
  res.json(out);
}));

// Telegram Mini App: подпись initData проверяется токеном бота
app.post("/api/login/tg", auth.limit(60, 60000), H(async (req, res) => {
  const t = auth.checkTelegram(req.body.initData, bot.TOKEN);
  if (!t || !t.id) throw new HttpError(401, "Не удалось подтвердить Telegram-аккаунт");
  const out = await tx(async c => {
    let u = (await c.query("SELECT * FROM users WHERE tg_id=$1 FOR UPDATE", [t.id])).rows[0];
    if (!u) {
      let name = nm(t.username) || ("tg" + t.id);
      if (name.length < 3 || (await c.query("SELECT 1 FROM users WHERE username=$1", [name])).rowCount) name = "tg" + t.id;
      u = (await c.query("INSERT INTO users(username,tg_id,bal) VALUES($1,$2,$3) RETURNING *", [name, t.id, START])).rows[0];
    }
    return { user: u.username, token: auth.issue(u.id) };
  });
  res.json(out);
}));

/* ---------- состояние ---------- */
app.get("/api/me", A, H(async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM users WHERE id=$1", [req.uid]);
  const u = rows[0]; if (!u) throw new HttpError(401, "Требуется вход");
  const inv = await invOf(pool, u.id);
  const bc = (await pool.query(
    `SELECT id, text, ts FROM broadcasts b WHERE b.ts >= $2 AND NOT EXISTS
       (SELECT 1 FROM broadcast_seen s WHERE s.bc_id=b.id AND s.user_id=$1) ORDER BY id LIMIT 1`, [u.id, u.created_at])).rows[0];
  res.json({
    user: u.username, bal: u.bal, inv, games: u.games, wins: u.wins, profit: u.profit, v: u.v, banned: u.banned,
    bc: bc ? { id: String(bc.id), text: bc.text, ts: new Date(bc.ts).getTime() } : null,
  });
}));

app.post("/api/bc/seen", A, H(async (req, res) => {
  const id = int(req.body.id, 1, 9e15, "bad id");
  await pool.query("INSERT INTO broadcast_seen(user_id,bc_id) SELECT $1::bigint,$2::bigint WHERE EXISTS(SELECT 1 FROM broadcasts WHERE id=$2::bigint) ON CONFLICT DO NOTHING", [req.uid, id]);
  res.json({ ok: true });
}));

/* ---------- магазин ---------- */
app.post("/api/buy", A, H(async (req, res) => {
  const key = String(req.body.key), price = PRICE[key];
  if (!price) throw new HttpError(400, "Нет такого подарка");
  res.json(await tx(async c => {
    const u = await need(c, req.uid); play(u);
    if (u.bal < price) throw new HttpError(400, "Не хватает звёзд — пополните баланс");
    await c.query("UPDATE users SET bal=bal-$2 WHERE id=$1", [u.id, price]);
    await c.query("INSERT INTO items(uid,user_id,key) VALUES($1,$2,$3)", [uid(), u.id, key]);
    return snap(c, { ...u, bal: u.bal - price });
  }));
}));

app.post("/api/sell", A, H(async (req, res) => {
  res.json(await tx(async c => {
    const u = await need(c, req.uid); play(u);
    const it = (await c.query("DELETE FROM items WHERE uid=$1 AND user_id=$2 RETURNING key", [String(req.body.uid), u.id])).rows[0];
    if (!it) throw new HttpError(400, "Предмет не найден");
    const p = Math.floor(PRICE[it.key] * SELL);
    await c.query("UPDATE users SET bal=bal+$2 WHERE id=$1", [u.id, p]);
    return { ...(await snap(c, { ...u, bal: u.bal + p })), price: p };
  }));
}));

// Пополнение: сервер создаёт счёт в Telegram Stars, баланс растёт только после successful_payment (см. bot.handle)
app.post("/api/deposit/invoice", A, auth.limit(20, 60000), H(async (req, res) => {
  const v = int(req.body.amount, bot.MIN_DEP, bot.MAX_DEP, `Сумма пополнения: от ${bot.MIN_DEP} до ${bot.MAX_DEP} ⭐`);
  const u = (await pool.query("SELECT * FROM users WHERE id=$1", [req.uid])).rows[0];
  if (!u) throw new HttpError(401, "Требуется вход");
  play(u);
  if (!u.tg_id) throw new HttpError(403, "Оплата звёздами доступна только в Telegram — откройте игру через бота");
  res.json({ link: await bot.createInvoice(u, v) });
}));

/* ---------- апгрейд ---------- */
app.post("/api/upgrade", A, H(async (req, res) => {
  const b = req.body || {};
  const mode = b.mode === "stars" ? "stars" : "item";
  const stake = int(b.stake, 0, 1e12, "Некорректная сумма");
  const uids = Array.isArray(b.uids) ? [...new Set(b.uids.map(String))].slice(0, 200) : [];
  res.json(await tx(async c => {
    const u = await need(c, req.uid); play(u);
    let items = [];
    if (uids.length) {
      items = (await c.query("SELECT uid,key FROM items WHERE user_id=$1 AND uid=ANY($2) FOR UPDATE", [u.id, uids])).rows;
      if (items.length !== uids.length) throw new HttpError(400, "Предмет не найден");
    }
    const value = stake + items.reduce((s, i) => s + PRICE[i.key], 0);
    if (value < 10) throw new HttpError(400, "Минимум для апгрейда — 10 ⭐");
    if (stake > u.bal) throw new HttpError(400, "Не хватает звёзд на балансе");
    let T, mult;
    if (mode === "item") { T = PRICE[b.target]; if (!T) throw new HttpError(400, "Выберите подарок"); mult = T / value; }
    else { mult = Number(b.mult); if (!MULTS.includes(mult)) throw new HttpError(400, "Неверный множитель"); T = value * mult; }
    if (!(mult >= 2) || mult > 100) throw new HttpError(400, "Множитель должен быть от x2 до x100");
    const chance = Math.min(95, EDGE / mult);
    const win = rand() * 100 < chance;
    const d = win ? T - value : -value;
    if (uids.length) await c.query("DELETE FROM items WHERE user_id=$1 AND uid=ANY($2)", [u.id, uids]);
    if (win && mode === "item") await c.query("INSERT INTO items(uid,user_id,key) VALUES($1,$2,$3)", [uid(), u.id, b.target]);
    const delta = -stake + (win && mode === "stars" ? T : 0);
    const r = (await c.query("UPDATE users SET bal=bal+$2, games=games+1, wins=wins+$3, profit=profit+$4 WHERE id=$1 RETURNING *",
      [u.id, delta, win ? 1 : 0, d])).rows[0];
    return { win, chance, mult, T, value, d, ...(await snap(c, r)) };
  }));
}));

/* ---------- админка (пароль только на сервере: ADMIN_PASS) ---------- */
const AD = (req, res, next) => {
  if (!process.env.ADMIN_PASS) return res.status(503).json({ error: "ADMIN_PASS не задан на сервере" });
  if (!auth.adminOk(req.headers["x-admin-pass"])) return res.status(403).json({ error: "Неверный пароль" });
  next();
};
const adm = auth.limit(40, 60000);
app.post("/api/admin/login", adm, AD, (req, res) => res.json({ ok: true }));
app.get("/api/admin/users", adm, AD, H(async (req, res) => {
  const { rows } = await pool.query("SELECT username,bal,banned FROM users ORDER BY created_at DESC LIMIT 300");
  res.json({ users: rows });
}));
app.post("/api/admin/credit", adm, AD, H(async (req, res) => {
  const name = nm(req.body.username); if (name.length < 3) throw new HttpError(400, "Неверный юзернейм");
  const v = int(req.body.amount, 1, 1e9, "Сумма: от 1 до 1 000 000 000 ⭐");
  res.json(await tx(async c => {
    let u = (await c.query("SELECT * FROM users WHERE username=$1 FOR UPDATE", [name])).rows[0], created = false;
    if (!u) { u = (await c.query("INSERT INTO users(username,bal) VALUES($1,$2) RETURNING *", [name, START])).rows[0]; created = true; }
    const r = (await c.query("UPDATE users SET bal=LEAST(bal+$2, 1000000000000), v=v+1 WHERE id=$1 RETURNING bal", [u.id, v])).rows[0];
    return { username: name, bal: r.bal, created };
  }));
}));
app.post("/api/admin/zero", adm, AD, H(async (req, res) => {
  const r = await pool.query("UPDATE users SET bal=0, v=v+1 WHERE username=$1", [nm(req.body.username)]);
  if (!r.rowCount) throw new HttpError(404, "Пользователь не найден");
  res.json({ ok: true });
}));
app.post("/api/admin/ban", adm, AD, H(async (req, res) => {
  const name = nm(req.body.username); if (name.length < 3) throw new HttpError(400, "Неверный юзернейм");
  const flag = !!req.body.flag;
  if (!flag) { const r = await pool.query("UPDATE users SET banned=false, v=v+1 WHERE username=$1", [name]); if (!r.rowCount) throw new HttpError(404, "Пользователь не найден"); return res.json({ ok: true }); }
  const r = await pool.query("INSERT INTO users(username,bal) VALUES($1,$2) ON CONFLICT (username) DO UPDATE SET banned=true, v=users.v+1 RETURNING (xmax=0) AS created", [name, START]);
  res.json({ ok: true, created: r.rows[0].created });
}));
app.post("/api/admin/broadcast", adm, AD, H(async (req, res) => {
  const text = String(req.body.text || "").trim().slice(0, 500);
  if (!text) throw new HttpError(400, "Введите текст рассылки");
  await pool.query("INSERT INTO broadcasts(text) VALUES($1)", [text]);
  await pool.query("DELETE FROM broadcasts WHERE id NOT IN (SELECT id FROM broadcasts ORDER BY id DESC LIMIT 30)");
  const n = (await pool.query("SELECT count(*)::int AS n FROM users")).rows[0].n;
  res.json({ count: n });
}));

/* ---------- статика, PWA и ошибки ---------- */
const MANIFEST = { name: "KaratUp", short_name: "KaratUp", description: "Апгрейды подарков за звёзды Telegram", lang: "ru",
  start_url: "/", scope: "/", display: "standalone", orientation: "portrait", background_color: "#0b0b0e", theme_color: "#0b0b0e",
  icons: [{ src: "/icon.png", sizes: "512x512", type: "image/png", purpose: "any" }, { src: "/icon.png", sizes: "512x512", type: "image/png", purpose: "maskable" }] };
const SW = `const V="ku-v1";
self.addEventListener("install",e=>{e.waitUntil(caches.open(V).then(c=>c.addAll(["/","/icon.png"])).then(()=>self.skipWaiting()))});
self.addEventListener("activate",e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==V).map(x=>caches.delete(x)))).then(()=>self.clients.claim()))});
self.addEventListener("fetch",e=>{const r=e.request,u=new URL(r.url);
if(r.method!=="GET"||u.origin!==location.origin||u.pathname.startsWith("/api")||u.pathname.startsWith("/tg"))return;
e.respondWith(fetch(r).then(x=>{if(x.ok){const c=x.clone();caches.open(V).then(h=>h.put(r,c))}return x}).catch(()=>caches.match(r).then(m=>m||caches.match("/"))))});`;
const ICON = Buffer.from("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", "base64");
const page = (req, res) => res.set("Cache-Control", "no-cache").sendFile(path.join(__dirname, "index.html"));
app.get(["/", "/index.html"], page);
app.get("/manifest.webmanifest", (req, res) => res.type("application/manifest+json").send(JSON.stringify(MANIFEST)));
app.get("/sw.js", (req, res) => res.type("application/javascript").set("Cache-Control", "no-cache").send(SW));
app.get(["/icon.png", "/apple-touch-icon.png"], (req, res) => res.type("image/png").set("Cache-Control", "public, max-age=86400").send(ICON));
app.use("/api", (req, res) => res.status(404).json({ error: "Не найдено" }));
app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err && err.type === "entity.parse.failed") return res.status(400).json({ error: "Некорректный запрос" });
  console.error(err);
  res.status(500).json({ error: "Ошибка сервера" });
});

(async () => {
  await migrate();
  const port = process.env.PORT || 3000;
  app.listen(port, () => { console.log("KaratUp on :" + port); bot.init(); });
})().catch(e => { console.error("Startup failed:", e); process.exit(1); });
