# KaratUp — деплой (GitHub → Render + Neon), оплата Telegram Stars

Файлы: `server.js` (весь бэкенд), `index.html` (Mini App / PWA), `package.json`.
Баланс пополняется **только** оплатой звёздами Telegram (1 Telegram Star = 1 ⭐ в игре). Новые аккаунты стартуют с 0 ⭐.

1. **Neon** → neon.tech → Create project → скопируйте *Connection string*. Таблицы (в т.ч. `payments`) создаются сами.
2. **GitHub** → новый репозиторий, загрузите `server.js`, `index.html`, `package.json`, `README.md`. `.env` НЕ загружать.
3. **Render** → New → Web Service → репозиторий. Build: `npm install`, Start: `npm start`.
   Environment: `DATABASE_URL`, `BOT_TOKEN`, `ADMIN_PASS`, `SESSION_SECRET`,
   по желанию `PUBLIC_URL`, `MAX_DEPOSIT`, `SUPPORT_CONTACT` (см. `.env.example`).
4. **@BotFather**: бот должен быть создан там; для Stars ничего подключать не нужно (токен провайдера не используется).
   Сервер сам ставит вебхук, кнопку «🎮 Играть» и команды `/start`, `/paysupport`.
5. Откройте игру **через бота в Telegram** — оплата работает только там (в обычном браузере вход гостевой, пополнить нельзя).

## Как устроена оплата
- Клиент → `POST /api/deposit/invoice {amount}` → сервер создаёт счёт (`createInvoiceLink`, валюта `XTR`) → `Telegram.WebApp.openInvoice`.
- Telegram шлёт `pre_checkout_query` (сервер проверяет пользователя/сумму/бан) и затем `successful_payment`.
- Баланс растёт **только** по `successful_payment`; `charge_id` уникален в таблице `payments`, повторная доставка не задваивает зачисление.
- При сбое зачисления вебхук отвечает 500 — Telegram повторит доставку.

## Важно
- Free-сервис Render засыпает; `pre_checkout_query` нужно ответить за 10 секунд, поэтому на платной игре держите сервис бодрым
  (пинг `/healthz` раз в 5–10 мин, например cron-job.org) или берите платный инстанс.
- Если база уже была в демо-режиме, обнулите виртуальные балансы: `UPDATE users SET bal=0; DELETE FROM items;`
- Возвраты: `refundStarPayment` в Bot API; в приложении автоматического возврата нет (суммы видны в таблице `payments`).
