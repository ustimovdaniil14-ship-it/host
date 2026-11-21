# KaratUp — бесплатный деплой (GitHub → Render + Neon)

Файлы: `server.js` (весь бэкенд), `index.html` (приложение для телефона, PWA), `package.json`. Всё остальное создаётся само.
Звёзды и подарки виртуальные. Бесплатно: GitHub, Render (Free Web Service), Neon (Free).

1. **Neon** → neon.tech → Create project → скопируйте *Connection string* (`postgresql://…?sslmode=require`). Таблицы создаются сами.
2. **GitHub** → новый репозиторий, загрузите 4 файла: `server.js`, `index.html`, `package.json`, `README.md`.
   `.env` НЕ загружать (там токен и пароли).
3. **Render** → New → Web Service → репозиторий. Build: `npm install`, Start: `npm start`, Instance: **Free**.
   Environment:
   - `DATABASE_URL` — строка Neon
   - `BOT_TOKEN` — токен от @BotFather
   - `ADMIN_PASS` — пароль админ-панели (⚙️ → Админ-панель)
   - `SESSION_SECRET` — любая случайная строка
4. Откройте адрес `https://….onrender.com` на телефоне → «📲 Установить на главный экран». Бот сам получит кнопку «🎮 Играть» (`/start`).

Free-сервис Render засыпает без трафика (первый заход ~30–50 с). Чтобы не спал — бесплатный пинг `/healthz` раз в 10 мин (например, cron-job.org).
GitHub Pages здесь не подойдёт: он хостит только статику, а нужен сервер с базой.
