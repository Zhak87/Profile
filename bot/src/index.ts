import { aiBackend, assistant, coverLetter, detectStage, recruiterReply, scoreJobs, type Stage } from "./ai";
import { DEFAULT_KEYWORDS, RESUME_URL, SITE_URL } from "./profile";
import { SOURCES, collectJobs, hhFullDescription, type Job, type SourceResult } from "./sources";
import { SCHEMA } from "./schema";
import { Telegram, clip, esc, webhookSecret, type Keyboard } from "./telegram";

export interface Env {
  DB: D1Database;
  AI: Ai;
  TELEGRAM_BOT_TOKEN: string;
  ANTHROPIC_API_KEY?: string;
  CLAUDE_MODEL?: string;
  HH_TOKEN?: string;
  HH_USER_AGENT?: string;
}

const now = () => Math.floor(Date.now() / 1000);
const SOURCES_PER_RUN = 4;
const MAX_CARDS_PER_RUN = 8;
const MAX_NEW_PER_RUN = 24;
const DEFAULT_HH_QUERY = 'React OR TypeScript OR Frontend OR Fullstack OR "Full-stack" OR ".NET" OR "C#" OR "Node.js" OR "Next.js"';

// ───────────────────────── settings ─────────────────────────

async function getSetting(env: Env, key: string, fallback = ""): Promise<string> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? fallback;
}

async function setSetting(env: Env, key: string, value: string) {
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(key, value)
    .run();
}

async function ownerId(env: Env): Promise<number | null> {
  const v = await getSetting(env, "owner_id");
  return v ? Number(v) : null;
}

async function keywords(env: Env): Promise<string[]> {
  const v = await getSetting(env, "keywords");
  return v ? v.split(",").map((s) => s.trim()).filter(Boolean) : DEFAULT_KEYWORDS;
}

// ───────────────────────── job search ─────────────────────────

type JobRow = Job & { rid: number; score: number | null; reason: string | null; status: string };

function rowToJob(r: any): JobRow {
  return { ...r, id: r.ext_id } as JobRow;
}

const STATUS_LABEL: Record<string, string> = {
  sent: "новая",
  applied: "✅ откликнулся · жду ответа",
  test: "📝 тестовое",
  interview: "📞 собеседование",
  offer: "🎉 оффер",
  rejected: "❌ отказ",
  hidden: "🙈 скрыта",
  queued: "в очереди",
};

function jobCard(j: JobRow, manage = false): { text: string; keyboard: Keyboard } {
  const score = j.score != null && j.score >= 0 ? `${j.score >= 80 ? "🔥" : j.score >= 65 ? "✨" : "•"} ${j.score}% · ` : "";
  const meta = [j.company && `🏢 ${esc(j.company)}`, j.location && `📍 ${esc(j.location)}`, j.salary && `💰 ${esc(j.salary)}`].filter(Boolean).join("\n");
  const text = [
    `${score}<b>${esc(j.title)}</b>${j.kind === "freelance" ? " <i>(фриланс)</i>" : ""}`,
    meta,
    j.reason ? `<i>${esc(j.reason)}</i>` : "",
    `<code>${esc(j.source)}</code>${j.status !== "sent" ? ` · ${STATUS_LABEL[j.status] ?? j.status}` : ""}`,
  ]
    .filter(Boolean)
    .join("\n");
  const keyboard: Keyboard = [[{ text: "✍️ Письмо", callback_data: `cl:${j.rid}` }, { text: "🔗 Открыть", url: j.url }]];
  if (j.status === "sent" || j.status === "hidden" || j.status === "queued")
    keyboard.push([{ text: "✅ Откликнулся", callback_data: `st:${j.rid}:applied` }, { text: "🙈 Скрыть", callback_data: `st:${j.rid}:hidden` }]);
  // Stages after applying are set automatically from employers' messages; manual buttons only in /pipeline.
  else if (manage)
    keyboard.push([
      { text: "📞 Собес", callback_data: `st:${j.rid}:interview` },
      { text: "🎉 Оффер", callback_data: `st:${j.rid}:offer` },
      { text: "❌ Отказ", callback_data: `st:${j.rid}:rejected` },
    ]);
  return { text, keyboard };
}

async function existingIds(env: Env, ids: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const rows = await env.DB.prepare(`SELECT ext_id FROM jobs WHERE ext_id IN (${chunk.map(() => "?").join(",")})`)
      .bind(...chunk)
      .all<{ ext_id: string }>();
    rows.results.forEach((r) => found.add(r.ext_id));
  }
  return found;
}

/** Fetch the next group of sources (or all of them), score new matches with AI and send the good ones. */
async function runSearch(env: Env, tg: Telegram, opts: { all?: boolean; manual?: boolean; freelanceOnly?: boolean } = {}) {
  const owner = await ownerId(env);
  if (!owner) return;
  if (!opts.manual && (await getSetting(env, "paused")) === "1") return;

  // Free Workers have a tight CPU budget per run, so cron rotates through sources a few at a time.
  const cursor = Number(await getSetting(env, "source_cursor", "0")) % SOURCES.length;
  const pick = opts.freelanceOnly
    ? SOURCES.flatMap((src, i) => (src.kind === "freelance" ? [i] : []))
    : opts.all
      ? SOURCES.map((_, i) => i)
      : Array.from({ length: SOURCES_PER_RUN }, (_, k) => (cursor + k) % SOURCES.length);
  if (!opts.all && !opts.freelanceOnly) await setSetting(env, "source_cursor", String((cursor + SOURCES_PER_RUN) % SOURCES.length));

  const ctx = {
    hhQuery: await getSetting(env, "hh_query", DEFAULT_HH_QUERY),
    hhUserAgent: env.HH_USER_AGENT || "DumanJobBot/1.0 (+https://zhak87.github.io/Profile/)",
    hhToken: env.HH_TOKEN,
  };
  const { jobs, report } = await collectJobs(ctx, await keywords(env), pick);
  await saveReport(env, report);

  const known = await existingIds(env, jobs.map((j) => j.id));
  const fresh = jobs.filter((j) => !known.has(j.id)).slice(0, MAX_NEW_PER_RUN);
  if (!fresh.length) {
    if (opts.manual) await tg.send(owner, "Новых подходящих вакансий пока нет. Проверю ещё раз по расписанию.");
    return;
  }

  const minScore = Number(await getSetting(env, "min_score", "60"));
  const wishes = await getSetting(env, "wishes");
  const scores = new Map<string, { score: number; reason: string }>();
  let aiError = "";
  for (let i = 0; i < fresh.length; i += 12) {
    try {
      for (const s of await scoreJobs(env, fresh.slice(i, i + 12), wishes)) scores.set(s.id, s);
    } catch (e: any) {
      aiError = e?.message ?? String(e);
    }
  }

  const t = now();
  const toSend: JobRow[] = [];
  for (const j of fresh) {
    const s = scores.get(j.id);
    // Without an AI score the job is still shown, so an AI outage never hides vacancies.
    const status = !s || s.score >= minScore ? "sent" : "skipped";
    const res = await env.DB.prepare(
      `INSERT INTO jobs (ext_id, source, kind, title, company, url, salary, location, description, score, reason, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(ext_id) DO NOTHING RETURNING rid`,
    )
      .bind(j.id, j.source, j.kind, j.title, j.company, j.url, j.salary, j.location, j.description.slice(0, 6000), s?.score ?? -1, s?.reason ?? null, status, t, t)
      .first<{ rid: number }>();
    if (res && status === "sent") toSend.push({ ...j, rid: res.rid, score: s?.score ?? -1, reason: s?.reason ?? null, status });
  }

  toSend.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  for (const j of toSend.slice(0, MAX_CARDS_PER_RUN)) {
    const card = jobCard(j);
    await tg.send(owner, card.text, card.keyboard).catch(() => undefined);
  }
  if (toSend.length > MAX_CARDS_PER_RUN) {
    await env.DB.prepare(`UPDATE jobs SET status = 'queued' WHERE rid IN (${toSend.slice(MAX_CARDS_PER_RUN).map((j) => j.rid).join(",")})`).run();
    await tg.send(owner, `Ещё ${toSend.length - MAX_CARDS_PER_RUN} подходящих вакансий в очереди: /more`);
  }
  if (aiError) await tg.send(owner, `⚠️ ИИ не смог оценить часть вакансий, показываю их без оценки.\n<code>${esc(clip(aiError, 300))}</code>`);
  if (opts.manual && !toSend.length) await tg.send(owner, `Нашёл ${fresh.length} новых, но ни одна не набрала ${minScore}%. Порог меняется командой /minscore.`);
}

async function saveReport(env: Env, report: SourceResult[]) {
  const prev = JSON.parse(await getSetting(env, "source_report", "{}")) as Record<string, SourceResult & { at: number }>;
  for (const r of report) prev[r.name] = { ...r, at: now() };
  await setSetting(env, "source_report", JSON.stringify(prev));
}

// ───────────────────────── automatic pipeline stages ─────────────────────────

const STAGE_RANK: Record<string, number> = { applied: 1, test: 2, interview: 3, offer: 4 };
const STAGE_NOTE: Record<Exclude<Stage, "none">, string> = {
  test: "📝 Прислали тестовое задание",
  interview: "📞 Приглашение на собеседование",
  offer: "🎉 Оффер!",
  rejected: "❌ Отказ",
};

/** Detects interview/offer/rejection in an employer's message and moves the matching application forward. */
async function trackStage(env: Env, tg: Telegram, owner: number, text: string, sender: string) {
  const apps = await env.DB.prepare(
    "SELECT rid, title, company, status FROM jobs WHERE status IN ('applied','test','interview','offer') ORDER BY updated_at DESC LIMIT 40",
  ).all<{ rid: number; title: string; company: string; status: string }>();
  let r;
  try {
    r = await detectStage(env, text, sender, apps.results);
  } catch (e) {
    console.error("stage detection failed", e);
    return;
  }
  if (r.stage === "none") return;
  const job = apps.results.find((a) => a.rid === r.rid);
  const note = `${STAGE_NOTE[r.stage]} — ${esc(sender)}${r.summary ? `\n${esc(r.summary)}` : ""}`;
  if (!job) {
    await tg.send(owner, `🔔 ${note}\n\n<i>Не нашёл эту вакансию среди откликов, поэтому этап никуда не записал.</i>`);
    return;
  }
  const forward = r.stage === "rejected" || (STAGE_RANK[r.stage] ?? 0) > (STAGE_RANK[job.status] ?? 0);
  if (forward) await env.DB.prepare("UPDATE jobs SET status = ?, updated_at = ? WHERE rid = ?").bind(r.stage, now(), job.rid).run();
  const row = await env.DB.prepare("SELECT * FROM jobs WHERE rid = ?").bind(job.rid).first<any>();
  const card = jobCard(rowToJob(row), true);
  await tg.send(owner, `🔔 ${note}\n${forward ? "Этап обновлён автоматически:" : "Вакансия:"}\n\n${card.text}`, card.keyboard);
}

// ───────────────────────── Telegram Business (chats with recruiters) ─────────────────────────

async function chatHistory(env: Env, chatId: number): Promise<string> {
  const rows = await env.DB.prepare("SELECT from_owner, name, text FROM biz_msgs WHERE chat_id = ? ORDER BY id DESC LIMIT 20").bind(chatId).all<any>();
  return rows.results
    .reverse()
    .map((r) => `${r.from_owner ? "Кандидат" : `Собеседник (${r.name || "рекрутер"})`}: ${r.text}`)
    .join("\n");
}

async function sendDraft(env: Env, tg: Telegram, draftId: number, text?: string) {
  const d = await env.DB.prepare("SELECT * FROM drafts WHERE id = ?").bind(draftId).first<any>();
  if (!d || d.status !== "pending") return false;
  const body = text ?? d.reply;
  await tg.sendAsOwner(d.conn_id, d.chat_id, body);
  if (d.attach_resume) await tg.sendDocumentAsOwner(d.conn_id, d.chat_id, RESUME_URL, `Резюме · портфолио: ${SITE_URL}`).catch(() => undefined);
  await env.DB.batch([
    env.DB.prepare("UPDATE drafts SET status = 'sent' WHERE id = ?").bind(draftId),
    env.DB.prepare("INSERT INTO biz_msgs (conn_id, chat_id, from_owner, name, text, ts) VALUES (?, ?, 1, NULL, ?, ?)").bind(d.conn_id, d.chat_id, body, now()),
  ]);
  return true;
}

async function onBusinessMessage(env: Env, tg: Telegram, m: any) {
  const owner = await ownerId(env);
  if (!owner || !m.text) return;
  const connId: string = m.business_connection_id;
  const fromOwner = m.from?.id === owner;
  // Our own sends via the connection were already stored when we sent them.
  if (fromOwner && m.sender_business_bot) return;

  const name = [m.chat?.first_name, m.chat?.last_name].filter(Boolean).join(" ") || m.chat?.title || "";
  await env.DB.prepare("INSERT INTO biz_msgs (conn_id, chat_id, from_owner, name, text, ts) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(connId, m.chat.id, fromOwner ? 1 : 0, name, m.text, now())
    .run();

  if (fromOwner) {
    // The owner answered by hand: any pending draft for this chat is outdated.
    await env.DB.prepare("UPDATE drafts SET status = 'superseded' WHERE chat_id = ? AND status = 'pending'").bind(m.chat.id).run();
    return;
  }
  if ((await getSetting(env, "biz_enabled", "1")) !== "1") return;

  await trackStage(env, tg, owner, m.text, name || m.chat?.username || "собеседник");
  const who = `${esc(name)}${m.chat?.username ? ` (@${esc(m.chat.username)})` : ""}`;
  let r;
  try {
    r = await recruiterReply(env, await chatHistory(env, m.chat.id), {
      salary: await getSetting(env, "salary"),
      notes: await getSetting(env, "notes"),
    });
  } catch (e: any) {
    await tg.send(owner, `💬 ${who}: ${esc(clip(m.text, 1500))}\n\n⚠️ ИИ не ответил: <code>${esc(clip(e?.message ?? String(e), 300))}</code>`);
    return;
  }

  await env.DB.prepare("UPDATE drafts SET status = 'superseded' WHERE chat_id = ? AND status = 'pending'").bind(m.chat.id).run();
  const draft = await env.DB.prepare(
    "INSERT INTO drafts (conn_id, chat_id, peer_name, reply, attach_resume, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?) RETURNING id",
  )
    .bind(connId, m.chat.id, name, r.reply, r.attach_resume ? 1 : 0, now())
    .first<{ id: number }>();
  const id = draft!.id;

  const auto = (await getSetting(env, "mode", "approve")) === "auto";
  if (auto && !r.needs_owner) {
    await sendDraft(env, tg, id);
    await tg.send(owner, `🤖 Ответил ${who} автоматически:\n\n${esc(r.reply)}${r.attach_resume ? "\n\n📎 + резюме PDF" : ""}`);
    return;
  }
  await tg.send(
    owner,
    `💬 <b>${who}</b>:\n${esc(clip(m.text, 1500))}\n\n🤖 <b>Черновик ответа:</b>\n${esc(r.reply)}${r.attach_resume ? "\n📎 + резюме PDF" : ""}${
      r.owner_note ? `\n\n⚠️ ${esc(r.owner_note)}` : ""
    }`,
    [
      [
        { text: "✅ Отправить", callback_data: `ds:${id}` },
        { text: "✏️ Своими словами", callback_data: `de:${id}` },
      ],
      [{ text: "🙈 Пропустить", callback_data: `dx:${id}` }],
    ],
  );
}

async function onBusinessConnection(env: Env, tg: Telegram, c: any) {
  const owner = await ownerId(env);
  if (!owner || c.user?.id !== owner) return;
  const canReply = c.rights?.can_reply ?? c.can_reply ?? false;
  await setSetting(env, "biz_conn", c.is_enabled ? c.id : "");
  await tg.send(
    owner,
    c.is_enabled
      ? canReply
        ? "🔗 Бот подключён к вашему Telegram как бизнес-бот. Теперь я вижу входящие от рекрутеров и готовлю ответы. Режим: /mode"
        : "🔗 Бот подключён, но без права отвечать. Включите «Управление сообщениями / Reply to messages» в настройках Telegram Business → Чат-боты."
      : "Бот отключён от вашего Telegram Business.",
  );
}

// ───────────────────────── commands ─────────────────────────

const HELP = `<b>Что я умею</b>
Каждые 10 минут проверяю вакансии и фриланс-задачи (hh: Казахстан, СНГ и удалёнка по миру; Habr Career, Remotive, We Work Remotely, Habr Freelance, FL.ru, Freelancehunt и проектная работа на hh). Казахстан и СНГ в приоритете, оцениваю их ИИ и присылаю подходящие. По кнопке «✍️ Письмо» пишу сопроводительное под конкретную вакансию.

Если подключить меня в Telegram → Настройки → Telegram Business → Чат-боты, я буду отвечать рекрутерам в ваших личных чатах (по умолчанию после вашего одобрения).

Перешлите или вставьте сюда любое сообщение рекрутера (с hh, почты, LinkedIn) — напишу ответ и сам отмечу этап: тестовое, собеседование, оффер или отказ.

/find — искать сейчас
/freelance — искать только фриланс-проекты
/more — показать вакансии из очереди
/pipeline — мои отклики и собеседования
/keywords react, .net, … — ключевые слова
/minscore 60 — порог соответствия
/wishes удалёнка, от 800к — пожелания к вакансиям
/salary 900 000 ₸ на руки — ожидания для ответов рекрутерам
/about английский B1, могу выйти через 2 недели — что ещё знать ИИ
/mode approve | auto — ответы рекрутерам: с одобрением или сами
/pause, /unpause — остановить или возобновить автопоиск
/sources — какие площадки работают
/cv — резюме и сайт
/settings — текущие настройки`;

async function onCommand(env: Env, tg: Telegram, chatId: number, text: string) {
  const [cmdRaw, ...rest] = text.trim().split(/\s+/);
  const cmd = cmdRaw.split("@")[0].toLowerCase();
  const arg = text.trim().slice(cmdRaw.length).trim();

  switch (cmd) {
    case "/start":
    case "/help":
      await tg.send(chatId, `Привет, Думан! Я ваш бот для поиска работы.\nИИ: ${esc(aiBackend(env))}\n\n${HELP}`);
      return;
    case "/find":
      await tg.send(chatId, "🔎 Ищу по всем площадкам…");
      await runSearch(env, tg, { all: true, manual: true });
      return;
    case "/freelance":
      await tg.send(chatId, "🔎 Ищу фриланс-проекты…");
      await runSearch(env, tg, { freelanceOnly: true, manual: true });
      return;
    case "/more": {
      const rows = await env.DB.prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY score DESC LIMIT 8").all<any>();
      if (!rows.results.length) return void (await tg.send(chatId, "Очередь пуста."));
      for (const r of rows.results) {
        await env.DB.prepare("UPDATE jobs SET status = 'sent', updated_at = ? WHERE rid = ?").bind(now(), r.rid).run();
        const card = jobCard({ ...rowToJob(r), status: "sent" });
        await tg.send(chatId, card.text, card.keyboard);
      }
      return;
    }
    case "/pipeline": {
      const rows = await env.DB.prepare(
        "SELECT * FROM jobs WHERE status IN ('applied','test','interview','offer') ORDER BY CASE status WHEN 'offer' THEN 0 WHEN 'interview' THEN 1 WHEN 'test' THEN 2 ELSE 3 END, updated_at DESC LIMIT 15",
      ).all<any>();
      if (!rows.results.length) return void (await tg.send(chatId, "Откликов пока нет. Нажимайте «✅ Откликнулся» на карточках вакансий, и я буду вести их здесь."));
      await tg.send(chatId, "Этапы обновляются сами, когда работодатель пишет вам в Telegram или вы пересылаете мне его сообщение. Кнопки ниже — если нужно поправить вручную.");
      for (const r of rows.results) {
        const card = jobCard(rowToJob(r), true);
        await tg.send(chatId, card.text, card.keyboard);
      }
      return;
    }
    case "/keywords":
      if (arg) await setSetting(env, "keywords", arg);
      await tg.send(chatId, `Ключевые слова: <code>${esc((await keywords(env)).join(", "))}</code>`);
      return;
    case "/hhquery":
      if (arg) await setSetting(env, "hh_query", arg);
      await tg.send(chatId, `Запрос для hh: <code>${esc(await getSetting(env, "hh_query", DEFAULT_HH_QUERY))}</code>`);
      return;
    case "/minscore": {
      const n = Number(rest[0]);
      if (Number.isFinite(n) && n >= 0 && n <= 100) await setSetting(env, "min_score", String(Math.round(n)));
      await tg.send(chatId, `Порог соответствия: ${await getSetting(env, "min_score", "60")}%`);
      return;
    }
    case "/wishes":
    case "/salary":
    case "/about": {
      const key = cmd === "/about" ? "notes" : cmd.slice(1);
      if (arg) await setSetting(env, key, arg === "-" ? "" : arg);
      await tg.send(chatId, `Сохранено: ${esc((await getSetting(env, key)) || "пусто")}\n(чтобы очистить, отправьте «${cmd} -»)`);
      return;
    }
    case "/mode": {
      if (arg === "auto" || arg === "approve") await setSetting(env, "mode", arg);
      const mode = await getSetting(env, "mode", "approve");
      await tg.send(
        chatId,
        mode === "auto"
          ? "Режим: <b>авто</b>. Простые ответы рекрутерам отправляю сам; деньги, время созвона, оффер и тестовые всегда присылаю вам на одобрение. Вернуть ручной режим: /mode approve"
          : "Режим: <b>с одобрением</b>. Каждый ответ рекрутеру сначала присылаю вам. Включить автоответы: /mode auto",
      );
      return;
    }
    case "/pause":
      await setSetting(env, "paused", "1");
      await tg.send(chatId, "⏸ Автопоиск на паузе. /unpause — продолжить.");
      return;
    case "/unpause":
      await setSetting(env, "paused", "0");
      await tg.send(chatId, "▶️ Автопоиск включён.");
      return;
    case "/sources": {
      const rep = JSON.parse(await getSetting(env, "source_report", "{}")) as Record<string, SourceResult & { at: number }>;
      const lines = SOURCES.map((s) => {
        const r = rep[s.name];
        if (!r) return `⏳ ${esc(s.name)} — ещё не проверялся`;
        const ago = Math.round((now() - r.at) / 60);
        return r.ok ? `✅ ${esc(s.name)} — ${r.count} совпадений (${ago} мин назад)` : `❌ ${esc(s.name)} — ${esc(r.error ?? "")} (${ago} мин назад)`;
      });
      await tg.send(chatId, `<b>Площадки</b>\n${lines.join("\n")}`);
      return;
    }
    case "/cv":
    case "/resume":
      await tg.sendDocument(chatId, RESUME_URL, `Портфолио: ${SITE_URL}`).catch(() => tg.send(chatId, `Резюме: ${RESUME_URL}\nСайт: ${SITE_URL}`));
      return;
    case "/settings": {
      const counts = await env.DB.prepare("SELECT status, COUNT(*) AS n FROM jobs GROUP BY status").all<{ status: string; n: number }>();
      const c = Object.fromEntries(counts.results.map((r) => [r.status, r.n]));
      await tg.send(
        chatId,
        [
          `<b>Настройки</b>`,
          `ИИ: ${esc(aiBackend(env))}`,
          `Автопоиск: ${(await getSetting(env, "paused")) === "1" ? "⏸ пауза" : "▶️ каждые 10 минут"}`,
          `Ключевые слова: <code>${esc((await keywords(env)).join(", "))}</code>`,
          `Порог: ${await getSetting(env, "min_score", "60")}%`,
          `Пожелания: ${esc((await getSetting(env, "wishes")) || "—")}`,
          `Зарплата для рекрутеров: ${esc((await getSetting(env, "salary")) || "— (спрошу вас)")}`,
          `О себе: ${esc((await getSetting(env, "notes")) || "—")}`,
          `Ответы рекрутерам: ${(await getSetting(env, "mode", "approve")) === "auto" ? "авто" : "с одобрением"}`,
          `Telegram Business: ${(await getSetting(env, "biz_conn")) ? "подключён" : "не подключён"}`,
          ``,
          `Просмотрено вакансий: ${Object.values(c).reduce((a, b) => a + b, 0)} · прислано: ${(c.sent ?? 0) + (c.applied ?? 0) + (c.interview ?? 0) + (c.offer ?? 0) + (c.rejected ?? 0) + (c.hidden ?? 0)}`,
          `Отклики: ${c.applied ?? 0} · собеседования: ${c.interview ?? 0} · офферы: ${c.offer ?? 0}`,
        ].join("\n"),
      );
      return;
    }
    default:
      await tg.send(chatId, "Не знаю такой команды. /help");
  }
}

async function onCallback(env: Env, tg: Telegram, q: any) {
  const owner = await ownerId(env);
  if (q.from?.id !== owner) return tg.answer(q.id, "Это не ваш бот");
  const [kind, idRaw, extra] = String(q.data ?? "").split(":");
  const id = Number(idRaw);
  const chatId = q.message?.chat?.id as number;
  const msgId = q.message?.message_id as number;

  if (kind === "st") {
    await env.DB.prepare("UPDATE jobs SET status = ?, updated_at = ? WHERE rid = ?").bind(extra, now(), id).run();
    const row = await env.DB.prepare("SELECT * FROM jobs WHERE rid = ?").bind(id).first<any>();
    if (row) {
      const card = jobCard(rowToJob(row), extra !== "applied" && extra !== "hidden");
      await tg.edit(chatId, msgId, card.text, card.keyboard);
    }
    const toast: Record<string, string> = { applied: "Записал. Этапы буду отмечать сам по ответам работодателя", interview: "Удачи на собеседовании!", offer: "Поздравляю! 🎉", rejected: "Записал. Идём дальше", hidden: "Скрыл" };
    return tg.answer(q.id, toast[extra]);
  }

  if (kind === "cl") {
    await tg.answer(q.id, "Пишу письмо…");
    const row = await env.DB.prepare("SELECT * FROM jobs WHERE rid = ?").bind(id).first<any>();
    if (!row) return;
    const job = rowToJob(row);
    await tg.typing(chatId);
    const full = job.source === "hh" ? await hhFullDescription(job.id.slice(3), env.HH_USER_AGENT || "DumanJobBot/1.0", env.HH_TOKEN) : null;
    try {
      const letter = await coverLetter(env, job, full);
      await tg.send(chatId, `✍️ <b>${esc(job.title)}</b>${job.company ? ` · ${esc(job.company)}` : ""}\n\n${esc(letter)}`, [
        [{ text: job.source === "hh" ? "🔗 Откликнуться на hh" : "🔗 Откликнуться", url: job.url }],
        [{ text: "✅ Откликнулся", callback_data: `st:${job.rid}:applied` }],
      ]);
    } catch (e: any) {
      await tg.send(chatId, `⚠️ Не получилось написать письмо: <code>${esc(clip(e?.message ?? String(e), 300))}</code>`);
    }
    return;
  }

  if (kind === "ds") {
    try {
      const ok = await sendDraft(env, tg, id);
      await tg.answer(q.id, ok ? "Отправлено" : "Черновик уже неактуален");
      if (ok) await tg.edit(chatId, msgId, `${q.message?.text ?? ""}\n\n✅ Отправлено`.slice(-3900));
    } catch (e: any) {
      await tg.answer(q.id, "Ошибка отправки");
      await tg.send(chatId, `⚠️ Telegram не дал отправить: <code>${esc(clip(e?.message ?? String(e), 300))}</code>`);
    }
    return;
  }
  if (kind === "de") {
    await setSetting(env, "pending_edit", String(id));
    await tg.answer(q.id);
    await tg.send(chatId, "Напишите ответ своими словами одним сообщением, я отправлю его от вашего имени. /cancel — отмена.");
    return;
  }
  if (kind === "dx") {
    await env.DB.prepare("UPDATE drafts SET status = 'skipped' WHERE id = ?").bind(id).run();
    await tg.answer(q.id, "Пропущено");
    await tg.edit(chatId, msgId, `${q.message?.text ?? ""}\n\n🙈 Пропущено`.slice(-3900));
    return;
  }
  await tg.answer(q.id);
}

async function onPrivateMessage(env: Env, tg: Telegram, m: any) {
  const chatId = m.chat.id as number;
  let owner = await ownerId(env);
  if (!owner) {
    // The first person to /start becomes the owner; everyone else is ignored afterwards.
    if (m.text?.startsWith("/start")) {
      await setSetting(env, "owner_id", String(m.from.id));
      owner = m.from.id;
    } else return;
  }
  if (m.from?.id !== owner) {
    await tg.send(chatId, "Это личный бот, он работает только для владельца.");
    return;
  }

  const text: string = m.text ?? m.caption ?? "";
  if (!text) return;

  const pending = await getSetting(env, "pending_edit");
  if (pending) {
    await setSetting(env, "pending_edit", "");
    if (text.trim() === "/cancel") return void (await tg.send(chatId, "Отменил."));
    if (!text.startsWith("/")) {
      try {
        const ok = await sendDraft(env, tg, Number(pending), text);
        await tg.send(chatId, ok ? "✅ Отправил." : "Этот черновик уже неактуален.");
      } catch (e: any) {
        await tg.send(chatId, `⚠️ Не получилось отправить: <code>${esc(clip(e?.message ?? String(e), 300))}</code>`);
      }
      return;
    }
  }

  if (text.startsWith("/")) return onCommand(env, tg, chatId, text);

  // Anything else (a forwarded recruiter message, a question) goes to the AI assistant.
  await tg.typing(chatId);
  const fwd = m.forward_origin ? `Пересланное сообщение от ${m.forward_origin.sender_user?.first_name ?? m.forward_origin.sender_user_name ?? m.forward_origin.chat?.title ?? "собеседника"}:\n` : "";
  if (m.forward_origin || text.length > 60) {
    const sender = m.forward_origin?.sender_user?.first_name ?? m.forward_origin?.sender_user_name ?? m.forward_origin?.chat?.title ?? "работодатель";
    await trackStage(env, tg, owner!, text, sender);
  }
  try {
    await tg.send(chatId, esc(await assistant(env, fwd + text)));
  } catch (e: any) {
    await tg.send(chatId, `⚠️ ИИ не ответил: <code>${esc(clip(e?.message ?? String(e), 300))}</code>`);
  }
}

async function onUpdate(env: Env, tg: Telegram, u: any) {
  if (u.business_connection) return onBusinessConnection(env, tg, u.business_connection);
  if (u.business_message) return onBusinessMessage(env, tg, u.business_message);
  if (u.callback_query) return onCallback(env, tg, u.callback_query);
  if (u.message?.chat?.type === "private") return onPrivateMessage(env, tg, u.message);
}

// ───────────────────────── entry points ─────────────────────────

let schemaReady = false;
async function ensureSchema(env: Env) {
  if (schemaReady) return;
  await env.DB.batch(SCHEMA.map((q) => env.DB.prepare(q)));
  schemaReady = true;
}

/** Points the Telegram webhook at this Worker and registers the command menu. */
async function connectWebhook(env: Env, tg: Telegram, origin: string, secret: string) {
  await tg.call("setWebhook", {
    url: `${origin}/tg`,
    secret_token: secret,
    allowed_updates: ["message", "callback_query", "business_connection", "business_message"],
  });
  await tg.call("setMyCommands", {
    commands: [
      ["find", "Искать вакансии сейчас"],
      ["more", "Вакансии из очереди"],
      ["pipeline", "Мои отклики и собеседования"],
      ["settings", "Настройки и статистика"],
      ["mode", "Ответы рекрутерам: авто или с одобрением"],
      ["sources", "Статус площадок"],
      ["cv", "Резюме и сайт"],
      ["help", "Что умеет бот"],
    ].map(([command, description]) => ({ command, description })),
  });
  await setSetting(env, "webhook_url", `${origin}/tg`);
}

const page = (body: string, status = 200) =>
  new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><body style="font:18px system-ui;padding:32px;max-width:640px">${body}</body>`, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (!env.TELEGRAM_BOT_TOKEN)
      return page("⚠️ Добавьте секрет <b>TELEGRAM_BOT_TOKEN</b>: Cloudflare → этот Worker → Settings → Variables and Secrets.", 500);
    await ensureSchema(env);
    const tg = new Telegram(env.TELEGRAM_BOT_TOKEN);
    const secret = await webhookSecret(env.TELEGRAM_BOT_TOKEN);

    if (url.pathname === "/tg" && req.method === "POST") {
      if (req.headers.get("x-telegram-bot-api-secret-token") !== secret) return new Response("forbidden", { status: 403 });
      const update: any = await req.json();
      // Telegram re-delivers an update if we answer slowly; handle each one once.
      const fresh = await env.DB.prepare("INSERT INTO updates (update_id, ts) VALUES (?, ?) ON CONFLICT DO NOTHING RETURNING update_id")
        .bind(update.update_id, now())
        .first();
      if (!fresh) return new Response("dup");
      try {
        await onUpdate(env, tg, update);
      } catch (e) {
        console.error("update failed", e);
      }
      return new Response("ok");
    }

    // Opening the Worker URL in a browser connects the bot to Telegram (only points the webhook at this same Worker).
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/setup")) {
      try {
        if ((await getSetting(env, "webhook_url")) !== `${url.origin}/tg` || url.pathname === "/setup") await connectWebhook(env, tg, url.origin, secret);
        const me = await tg.call<{ username: string }>("getMe", {});
        return page(`✅ Бот работает и подключён к Telegram.<br><br>Откройте <a href="https://t.me/${me.username}">@${me.username}</a> и отправьте /start.<br><br>ИИ: ${esc(aiBackend(env))}`);
      } catch (e: any) {
        return page(`⚠️ Не удалось подключить Telegram: <code>${esc(e?.message ?? String(e))}</code><br>Проверьте секрет TELEGRAM_BOT_TOKEN.`, 500);
      }
    }

    return new Response("not found", { status: 404 });
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    if (!env.TELEGRAM_BOT_TOKEN) return;
    const tg = new Telegram(env.TELEGRAM_BOT_TOKEN);
    ctx.waitUntil(
      (async () => {
        await ensureSchema(env);
        await runSearch(env, tg).catch((e) => console.error("search failed", e));
        await env.DB.prepare("DELETE FROM updates WHERE ts < ?").bind(now() - 3 * 86400).run();
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
