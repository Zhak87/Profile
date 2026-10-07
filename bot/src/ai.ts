import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "./index";
import type { Job } from "./sources";
import { PROFILE, RESUME_URL, SITE_URL } from "./profile";

const CLAUDE_MODEL = "claude-opus-5-5";
const WORKERS_AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

type Effort = "low" | "medium" | "high";

export function aiBackend(env: Env): string {
  return env.ANTHROPIC_API_KEY ? `Claude (${env.CLAUDE_MODEL || CLAUDE_MODEL})` : "Cloudflare Workers AI (бесплатный, Llama 3.3)";
}

async function complete(env: Env, system: string, user: string, opts: { effort?: Effort; schema?: object; maxTokens?: number } = {}): Promise<string> {
  if (env.ANTHROPIC_API_KEY) {
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    const res = await client.beta.messages.create({
      model: env.CLAUDE_MODEL || CLAUDE_MODEL,
      max_tokens: opts.maxTokens ?? 8000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system,
      messages: [{ role: "user", content: user }],
      output_config: {
        effort: opts.effort ?? "low",
        ...(opts.schema ? { format: { type: "json_schema", schema: opts.schema } } : {}),
      },
    } as any);
    if (res.stop_reason === "refusal") throw new Error("Модель отказалась отвечать на этот запрос");
    return res.content.map((b: any) => (b.type === "text" ? b.text : "")).join("").trim();
  }
  const prompt = opts.schema ? `${user}\n\nОтветь ТОЛЬКО валидным JSON по схеме, без пояснений:\n${JSON.stringify(opts.schema)}` : user;
  const out: any = await (env.AI as any).run(WORKERS_AI_MODEL, {
    messages: [
      { role: "system", content: system },
      { role: "user", content: prompt },
    ],
    max_tokens: Math.min(opts.maxTokens ?? 1500, 2048),
  });
  return String(out?.response ?? "").trim();
}

function parseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    const m = text.match(/[\[{][\s\S]*[\]}]/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]) as T;
    } catch {
      return null;
    }
  }
}

const BASE_SYSTEM = `Ты — карьерный агент кандидата. Ниже его профиль. Никогда не выдумывай опыт, компании, проекты, цифры или навыки, которых нет в профиле.
Если чего-то не знаешь (зарплатные ожидания, готовность к переезду, английский, даты), не придумывай: отметь, что нужен ответ кандидата.

ПРОФИЛЬ КАНДИДАТА:
${PROFILE}`;

export type Score = { id: string; score: number; reason: string };

export async function scoreJobs(env: Env, jobs: Job[], wishes: string): Promise<Score[]> {
  if (!jobs.length) return [];
  const list = jobs
    .map((j, i) => `#${i}\nНазвание: ${j.title}\nКомпания: ${j.company}\nЛокация: ${j.location}\nЗарплата: ${j.salary || "не указана"}\nТип: ${j.kind}\nОписание: ${j.description.slice(0, 700)}`)
    .join("\n\n");
  const schema = {
    type: "object",
    properties: {
      results: {
        type: "array",
        items: {
          type: "object",
          properties: { index: { type: "integer" }, score: { type: "integer" }, reason: { type: "string" } },
          required: ["index", "score", "reason"],
          additionalProperties: false,
        },
      },
    },
    required: ["results"],
    additionalProperties: false,
  };
  const text = await complete(
    env,
    BASE_SYSTEM,
    `Оцени, насколько каждая вакансия подходит кандидату, по шкале 0–100 (стек, уровень, формат работы, локация: Астана или удалёнка, доступная из Казахстана).
Приоритет регионов: компании Казахстана (особенно Астана, офис или удалёнка) — выше всего; компании СНГ (Россия, Узбекистан, Беларусь, Кыргызстан и др.) с удалёнкой — тоже высоко; остальной мир с удалёнкой, доступной из Казахстана, — нормально, но чуть ниже при прочих равных.
Вакансии, требующие гражданства/резидентства США или ЕС, или офис в другой стране без удалёнки и релокации — не выше 20.
Пожелания кандидата: ${wishes || "нет"}.
reason — одно короткое предложение по-русски, почему подходит или нет.

${list}`,
    { schema, effort: "low", maxTokens: 6000 },
  );
  const parsed = parseJson<{ results: { index: number; score: number; reason: string }[] }>(text);
  return (parsed?.results ?? [])
    .filter((r) => jobs[r.index])
    .map((r) => ({ id: jobs[r.index].id, score: Math.max(0, Math.min(100, Math.round(r.score))), reason: r.reason }));
}

export async function coverLetter(env: Env, job: Job, fullDescription: string | null): Promise<string> {
  const english = /remotive|weworkremotely/.test(job.source);
  return complete(
    env,
    BASE_SYSTEM,
    `Напиши сопроводительное письмо на эту ${job.kind === "freelance" ? "фриланс-задачу (как отклик исполнителя)" : "вакансию"}.
Язык: ${english ? "английский" : "русский"}. 120–180 слов, живо и конкретно, без шаблонных фраз и без markdown.
Свяжи 2–3 конкретных пункта из опыта кандидата с требованиями. В конце дай ссылки на портфолио ${SITE_URL} и резюме ${RESUME_URL}.
Если в описании просят ответить на вопрос или указать кодовое слово, сделай это.

Вакансия: ${job.title}
Компания: ${job.company}
Локация: ${job.location}
Описание:
${(fullDescription || job.description).slice(0, 6000)}`,
    { effort: "medium", maxTokens: 4000 },
  );
}

export type RecruiterReply = { reply: string; attach_resume: boolean; needs_owner: boolean; owner_note: string };

export async function recruiterReply(env: Env, history: string, settings: { salary: string; notes: string }): Promise<RecruiterReply> {
  const schema = {
    type: "object",
    properties: {
      reply: { type: "string" },
      attach_resume: { type: "boolean" },
      needs_owner: { type: "boolean" },
      owner_note: { type: "string" },
    },
    required: ["reply", "attach_resume", "needs_owner", "owner_note"],
    additionalProperties: false,
  };
  const text = await complete(
    env,
    `${BASE_SYSTEM}

Ты ведёшь переписку с рекрутером ОТ ИМЕНИ кандидата, от первого лица, в его личном Telegram. Пиши коротко, вежливо, по-человечески, на языке собеседника, без markdown.
Цель — довести до собеседования и оффера: отвечай на вопросы по опыту, предлагай созвон, по просьбе присылай резюме (attach_resume=true) и сайт ${SITE_URL}.
Зарплатные ожидания: ${settings.salary || "НЕ ЗАДАНЫ — не называй цифру, поставь needs_owner=true"}.
Доп. информация от кандидата: ${settings.notes || "нет"}.
needs_owner=true, если: просят назвать или согласовать деньги и ожиданий нет; назначают конкретное время созвона/интервью; присылают оффер или условия; просят выполнить тестовое; спрашивают то, чего нет в профиле; сообщение не про работу.
В owner_note кратко объясни кандидату, что нужно от него (или пустая строка). reply — готовый текст ответа (черновик, даже если needs_owner=true).`,
    `Переписка (последние сообщения, внизу самое новое):\n${history}\n\nНапиши следующий ответ кандидата.`,
    { schema, effort: "medium", maxTokens: 4000 },
  );
  const parsed = parseJson<RecruiterReply>(text);
  if (!parsed?.reply) return { reply: text, attach_resume: false, needs_owner: true, owner_note: "Не удалось разобрать ответ ИИ, проверьте текст." };
  return parsed;
}

export async function assistant(env: Env, question: string): Promise<string> {
  return complete(
    env,
    `${BASE_SYSTEM}

Ты помогаешь кандидату в поиске работы: пишешь ответы рекрутерам (с hh.ru, почты, LinkedIn), сопроводительные письма, готовишь к собеседованиям.
Если кандидат прислал сообщение рекрутера, дай готовый ответ от его имени, который можно скопировать. Пиши без markdown-разметки.`,
    question,
    { effort: "medium", maxTokens: 4000 },
  );
}
