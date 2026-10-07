export type Job = {
  id: string; // "<source>:<external id>"
  source: string;
  title: string;
  company: string;
  url: string;
  salary: string;
  location: string;
  description: string;
  kind: "job" | "freelance";
};

export type SourceResult = { name: string; ok: boolean; count: number; error?: string };

type Source = { name: string; kind: Job["kind"]; fetch: (ctx: SourceCtx) => Promise<Job[]> };
type SourceCtx = { hhQuery: string; hhUserAgent: string; hhToken?: string };

const UA = "Mozilla/5.0 (compatible; DumanJobBot/1.0; +https://zhak87.github.io/Profile/)";

export function stripHtml(s: string): string {
  return decodeEntities(
    s.replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|li|div|h\d)>/gi, "\n").replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t ]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
}

async function getJson(url: string, headers: Record<string, string> = {}): Promise<any> {
  const res = await fetch(url, { headers: { "user-agent": UA, accept: "application/json", ...headers } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function money(from?: number | null, to?: number | null, cur?: string | null): string {
  if (!from && !to) return "";
  const f = (n: number) => n.toLocaleString("ru-RU");
  const range = from && to ? `${f(from)}–${f(to)}` : from ? `от ${f(from)}` : `до ${f(to!)}`;
  return `${range} ${cur ?? ""}`.trim();
}

// hh.ru / hh.kz public vacancy search. Applying through the API is closed to
// third-party apps since 2025-12-15, so we only search and link to the vacancy.
async function hh(ctx: SourceCtx, extra: string, kind: Job["kind"] = "job"): Promise<Job[]> {
  const params = new URLSearchParams({ text: ctx.hhQuery, per_page: "50", period: "3", order_by: "publication_time" });
  const headers: Record<string, string> = { "HH-User-Agent": ctx.hhUserAgent };
  if (ctx.hhToken) headers.authorization = `Bearer ${ctx.hhToken}`;
  const data = await getJson(`https://api.hh.ru/vacancies?${params}&${extra}`, headers);
  return (data.items ?? []).map((v: any): Job => {
    const s = v.salary_range ?? v.salary;
    return {
      id: `hh:${v.id}`,
      source: "hh",
      title: v.name,
      company: v.employer?.name ?? "",
      url: v.alternate_url,
      salary: s ? money(s.from, s.to, s.currency) : "",
      location: [v.area?.name, v.schedule?.name ?? v.work_format?.[0]?.name].filter(Boolean).join(" · "),
      description: stripHtml([v.snippet?.requirement, v.snippet?.responsibility].filter(Boolean).join("\n")),
      kind,
    };
  });
}

async function rss(url: string, source: string, kind: Job["kind"]): Promise<Job[]> {
  const res = await fetch(url, { headers: { "user-agent": UA, accept: "application/rss+xml, application/xml, text/xml" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const xml = await res.text();
  const items = xml.match(/<item[\s>][\s\S]*?<\/item>/g) ?? [];
  const tag = (item: string, name: string) => {
    const m = item.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`));
    return m ? stripHtml(m[1]) : "";
  };
  return items.slice(0, 60).map((item): Job => {
    const link = tag(item, "link") || tag(item, "guid");
    let title = tag(item, "title");
    let company = "";
    // We Work Remotely titles look like "Company: Position"
    if (source === "weworkremotely" && title.includes(": ")) [company, title] = [title.split(": ")[0], title.split(": ").slice(1).join(": ")];
    return {
      id: `${source}:${link}`,
      source,
      title,
      company,
      url: link,
      salary: "",
      location: tag(item, "region") || "Remote",
      description: tag(item, "description").slice(0, 3000),
      kind,
    };
  });
}

export const SOURCES: Source[] = [
  { name: "hh (Казахстан)", kind: "job", fetch: (c) => hh(c, "area=40") },
  // CIS: Russia, Belarus, Uzbekistan, Kyrgyzstan, Azerbaijan — remote or relocation-friendly roles at CIS companies.
  { name: "hh (СНГ)", kind: "job", fetch: (c) => hh(c, "area=113&area=16&area=97&area=48&area=9&schedule=remote") },
  { name: "hh (удалёнка, все регионы)", kind: "job", fetch: (c) => hh(c, "schedule=remote") },
  // "Проектная работа" on hh: one-off and contract projects in Kazakhstan and remote across CIS.
  { name: "hh (проекты, КЗ)", kind: "freelance", fetch: (c) => hh(c, "employment=project&area=40", "freelance") },
  { name: "hh (проекты, удалёнка)", kind: "freelance", fetch: (c) => hh(c, "employment=project&schedule=remote", "freelance") },
  {
    name: "remotive",
    kind: "job",
    fetch: async () => {
      const data = await getJson("https://remotive.com/api/remote-jobs?category=software-dev&limit=40");
      return (data.jobs ?? []).map((j: any): Job => ({
        id: `remotive:${j.id}`,
        source: "remotive",
        title: j.title,
        company: j.company_name,
        url: j.url,
        salary: j.salary ?? "",
        location: j.candidate_required_location ?? "Remote",
        description: stripHtml(j.description ?? "").slice(0, 3000),
        kind: /contract|freelance/i.test(j.job_type ?? "") ? "freelance" : "job",
      }));
    },
  },
  { name: "weworkremotely front-end", kind: "job", fetch: () => rss("https://weworkremotely.com/categories/remote-front-end-programming-jobs.rss", "weworkremotely", "job") },
  { name: "weworkremotely full-stack", kind: "job", fetch: () => rss("https://weworkremotely.com/categories/remote-full-stack-programming-jobs.rss", "weworkremotely", "job") },
  { name: "habr career", kind: "job", fetch: () => rss("https://career.habr.com/vacancies/rss?type=all&sort=date", "habr", "job") },
  { name: "habr freelance", kind: "freelance", fetch: () => rss("https://freelance.habr.com/tasks.rss", "habr-freelance", "freelance") },
  { name: "fl.ru", kind: "freelance", fetch: () => rss("https://www.fl.ru/rss/all.xml?category=5", "fl", "freelance") },
  { name: "freelancehunt", kind: "freelance", fetch: () => rss("https://freelancehunt.com/projects.rss", "freelancehunt", "freelance") },
];

export async function collectJobs(ctx: SourceCtx, keywords: string[], pick: number[]): Promise<{ jobs: Job[]; report: SourceResult[] }> {
  const chosen = pick.map((i) => SOURCES[i]);
  const settled = await Promise.allSettled(chosen.map((s) => s.fetch(ctx)));
  const report: SourceResult[] = [];
  const seen = new Set<string>();
  const jobs: Job[] = [];
  const kw = keywords.map((k) => k.toLowerCase());
  settled.forEach((r, i) => {
    const name = chosen[i].name;
    if (r.status === "rejected") {
      report.push({ name, ok: false, count: 0, error: String(r.reason?.message ?? r.reason).slice(0, 120) });
      return;
    }
    const matched = r.value.filter((j) => {
      if (!j.url || !j.title || seen.has(j.id)) return false;
      const hay = `${j.title}\n${j.description}`.toLowerCase();
      return kw.some((k) => hay.includes(k));
    });
    matched.forEach((j) => seen.add(j.id));
    jobs.push(...matched);
    report.push({ name, ok: true, count: matched.length });
  });
  return { jobs, report };
}

/** Full hh vacancy text for writing a cover letter (search results only carry a snippet). */
export async function hhFullDescription(id: string, userAgent: string, token?: string): Promise<string | null> {
  try {
    const headers: Record<string, string> = { "HH-User-Agent": userAgent };
    if (token) headers.authorization = `Bearer ${token}`;
    const v = await getJson(`https://api.hh.ru/vacancies/${id}`, headers);
    return stripHtml(v.description ?? "").slice(0, 6000);
  } catch {
    return null;
  }
}
