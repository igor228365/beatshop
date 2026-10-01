# BEATSHOP

Магазин битов: каталог с 10-секундными превью, корзина, валюты (₴ ₽ $), вход через Google и Telegram,
подписки для продавцов (Pro 500 ₴, Pro Max 1000 ₴), загрузка битов с автоматическим превью, админка.

## Важно про токен бота
Токен, который ты написал в чате, теперь считается скомпрометированным. Сделай так:
1. В Telegram открой @BotFather, отправь `/revoke`, выбери своего бота. Получишь новый токен.
2. Новый токен вводи ТОЛЬКО в Render, в переменную `TELEGRAM_BOT_TOKEN`. Не вставляй его в код, GitHub и чаты.

## 1. Telegram-бот
1. @BotFather → `/mybots` → твой бот. Запомни его username (без @) → это `TELEGRAM_BOT_USERNAME`.
2. После первого деплоя: @BotFather → `/setdomain` → выбери бота → впиши домен Render, например `beatshop.onrender.com`.
3. Узнай свой chat id: напиши своему боту `/start`, потом открой @userinfobot и скопируй `Id` → это `ADMIN_CHAT_ID`. Бот будет присылать тебе заявки.

## 2. Вход через Google
1. https://console.cloud.google.com → создай проект → APIs & Services → OAuth consent screen (External, заполни название и почту).
2. Credentials → Create credentials → OAuth client ID → Web application.
3. Authorized JavaScript origins: `https://beatshop.onrender.com` (твой домен Render) и для тестов `http://localhost:3000`.
4. Скопируй Client ID → это `GOOGLE_CLIENT_ID`. Секрет клиента не нужен.

## 3. GitHub
В папке проекта:
```
git init
git add .
git commit -m "BEATSHOP"
git branch -M main
git remote add origin https://github.com/ТВОЙ_НИК/beatshop.git
git push -u origin main
```
(Репозиторий создай на github.com заранее, пустой. Файл `.env` в репозиторий не попадёт.)

## 4. Render
1. https://dashboard.render.com → New → Blueprint → выбери репозиторий. Render прочитает `render.yaml`.
2. Заполни переменные: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `ADMIN_CHAT_ID`, `GOOGLE_CLIENT_ID`, `BASE_URL` (адрес сайта, `https://....onrender.com`).
   `JWT_SECRET` и `ADMIN_KEY` Render сгенерирует сам. Ключ админки смотри в Environment.
3. Диск `/data` хранит базу и загруженные биты. Он доступен только на платном тарифе. На бесплатном тарифе данные пропадают при каждом перезапуске.
4. Когда сайт запустится, вернись к шагам про `/setdomain` (Telegram) и origins (Google).

## Как работают подписки
1. Продавец жмёт «Добавить бит» → видит тарифы → платит удобным способом → вводит контакт → «Я оплатил(а)».
2. Тебе в Telegram приходит заявка. Открой `https://твой-сайт/admin`, введи `ADMIN_KEY`, проверь поступление денег и нажми «включить на 30 дней».
3. После этого продавец может загружать биты. Pro: до 10 битов. Pro Max: без лимита и выше в каталоге.
4. Когда подписка кончается, биты продавца скрываются из каталога. Продлил, и они снова видны.

## Запуск на своём компьютере
```
npm install
cp .env.example .env     # впиши значения
npm run dev              # http://localhost:3000
```

## Структура
- `server.js`: вход, подписки, загрузка битов, заказы, админка
- `public/index.html`: сайт
- `public/admin.html`: админка
- `render.yaml`: настройки Render
