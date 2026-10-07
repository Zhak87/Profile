# Бот поиска работы (Telegram)

Личный бот Думана: ищет вакансии и фриланс-задачи, оценивает их ИИ, пишет сопроводительные письма и ведёт переписку с рекрутерами в Telegram до оффера.

Хостинг: **Cloudflare Workers** (бесплатный план, работает 24/7 без «засыпания»), база **D1**, расписание через Cron Triggers.
ИИ: Claude, если задан `ANTHROPIC_API_KEY`; без ключа бесплатно работает Cloudflare Workers AI (Llama 3.3, качество ниже, дневной лимит).

## Что делает

- Каждые 10 минут проверяет по 3 площадки по кругу: hh.kz (Казахстан + удалёнка), Habr Career, Remotive, We Work Remotely, Habr Freelance, FL.ru. `/find` проверяет все сразу.
- ИИ ставит каждой вакансии процент соответствия резюме; присылает те, что выше порога (`/minscore`, по умолчанию 60).
- «✍️ Письмо» пишет сопроводительное под вакансию (для hh берёт полный текст вакансии) со ссылками на сайт и резюме.
- Воронка: «✅ Откликнулся» → «📞 Собес» → «🎉 Оффер», список в `/pipeline`.
- **Telegram Business**: когда рекрутер пишет вам в личку, бот готовит ответ от вашего имени и присылает на одобрение (✅ / ✏️ / 🙈). `/mode auto` — простые ответы уходят сами; деньги, время созвона, оффер и тестовые всегда идут к вам.
- Любое пересланное сообщение рекрутера (hh, почта, LinkedIn) → готовый ответ.

## Честно о площадках

- **hh.ru / hh.kz**: с 15.12.2025 API откликов и резюме закрыт для сторонних приложений. Бот ищет вакансии через открытый поиск и пишет письмо, а нажать «Откликнуться» на hh нужно самому (одна кнопка + вставить письмо). Обходы через логин/пароль нарушают правила hh и ведут к бану аккаунта.
- **LinkedIn**: автоматизация запрещена правилами, API для откликов нет.
- **Фриланс-биржи** (FL.ru, Habr Freelance, Kwork): откликаться можно только из своего аккаунта; бот находит задачи и пишет отклик.
- **Telegram**: переписка ведётся полностью автоматически через Telegram Business (нужен Telegram Premium).

## Установка (один раз)

1. **Cloudflare**: зарегистрируйтесь на dash.cloudflare.com (бесплатно), откройте *Workers & Pages* один раз, чтобы получить поддомен `*.workers.dev`.
2. **API-токен**: My Profile → API Tokens → Create Token → шаблон *Edit Cloudflare Workers*, добавьте разрешение *Account → D1 → Edit*. Скопируйте токен и **Account ID** (на главной странице аккаунта справа).
3. **Секреты GitHub**: репозиторий → Settings → Secrets and variables → Actions → New repository secret:
   - `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`
   - `TELEGRAM_BOT_TOKEN` — токен от @BotFather (лучше перевыпустить: /revoke)
   - `ANTHROPIC_API_KEY` — необязательно, ключ с console.anthropic.com
   - `HH_TOKEN` — необязательно, токен приложения с dev.hh.ru, если hh начнёт отвечать 403
4. Actions → *Deploy job bot* → Run workflow. Дальше деплой идёт сам при каждом изменении `bot/` в `main`.
5. Напишите боту `/start`: первый, кто нажал /start, становится владельцем.
6. Для переписки с рекрутерами: @BotFather → ваш бот → Bot Settings → Business Mode → Turn on. Затем в Telegram: Настройки → Telegram Business → Чат-боты → выберите бота, доступ «Все, кроме контактов», включите право отвечать.

## Команды

`/find` `/more` `/pipeline` `/keywords` `/hhquery` `/minscore` `/wishes` `/salary` `/about` `/mode` `/pause` `/unpause` `/sources` `/cv` `/settings`

## Разработка

```bash
cd bot && npm install
npm run typecheck
npx wrangler dev   # нужен .dev.vars с TELEGRAM_BOT_TOKEN=...
```

Профиль для ИИ лежит в `src/profile.ts`; площадки — в `src/sources.ts`.
