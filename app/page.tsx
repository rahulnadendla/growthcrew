"use client";

import { useEffect, useRef, useState } from "react";
import { AGENTS, AGENT_ORDER, STEP_AGENT, type AgentId, type StepId } from "@/lib/team";
import { simulateRound, totals, type CellResult } from "@/lib/simulate";

type Status = "idle" | "working" | "done" | "error";
type LogKind = "info" | "handoff" | "review" | "good" | "warn";
type LogLine = { t: string; text: string; kind: LogKind };
type Lang = "english" | "hindi" | "telugu";
type Ad = { headline: string; body: string; cta: string };
type AdSet = { angle_id: string; english: Ad; hindi: Ad; telugu: Ad; fixed?: Lang[] };
type Cell = { cell_id: string; label: string; angle: string; language: string; audience: string; channel: string; daily_budget_inr: number; ad?: Ad };
type Round = { round: number; cells: Cell[]; results: CellResult[]; shownDays: number; analysis?: any; nextAds?: any[] };

const LANG_LABEL: Record<Lang, string> = { english: "English", hindi: "हिन्दी", telugu: "తెలుగు" };
const langKey = (l: string): Lang => (l?.toLowerCase().startsWith("hi") ? "hindi" : l?.toLowerCase().startsWith("te") ? "telugu" : "english");
const now = () => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const inr = (n: number | null | undefined) => (n == null ? "—" : "₹" + Math.round(n).toLocaleString("en-IN"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const wc = (s: string) => (s || "").trim().split(/\s+/).filter(Boolean).length;

export default function Home() {
  const [url, setUrl] = useState("");
  const [audience, setAudience] = useState("");
  const [budget, setBudget] = useState("30000");
  const [pasteMode, setPasteMode] = useState(false);
  const [pasted, setPasted] = useState("");
  const [pasteReason, setPasteReason] = useState("");

  const [phase, setPhase] = useState<"start" | "team">("start");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Record<AgentId, Status>>({ head: "idle", researcher: "idle", copywriter: "idle", channel: "idle", reviewer: "idle" });
  const [log, setLog] = useState<LogLine[]>([]);
  const [error, setError] = useState<{ message: string; retry: () => void } | null>(null);

  const [page, setPage] = useState<{ title: string; text: string; url: string } | null>(null);
  const [research, setResearch] = useState<any>(null);
  const [researchMeta, setResearchMeta] = useState<any>(null);
  const [reviewResearch, setReviewResearch] = useState<any>(null);
  const [strategy, setStrategy] = useState<any>(null);
  const [ads, setAds] = useState<AdSet[] | null>(null);
  const [reviewCopy, setReviewCopy] = useState<any>(null);
  const [channel, setChannel] = useState<any>(null);
  const [signoff, setSignoff] = useState<any>(null);
  const [rounds, setRounds] = useState<Round[]>([]);
  const [learnings, setLearnings] = useState<{ round: number; text: string }[]>([]);

  // A mutable copy of everything, so each step can read what earlier steps produced.
  const ctx = useRef<any>({});
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" });
  }, [log]);

  const say = (text: string, kind: LogKind = "info") => setLog((l) => [...l, { t: now(), text, kind }]);
  const setAgent = (a: AgentId, s: Status) => setStatus((x) => ({ ...x, [a]: s }));

  async function callAgent(step: StepId, input: any) {
    const agent = STEP_AGENT[step];
    setAgent(agent, "working");
    try {
      const res = await fetch("/api/agent", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agentId: step, input }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "This step failed.");
      setAgent(agent, "done");
      if (data.warnings?.length) say(`${AGENTS[agent].name}: note — ${data.warnings.slice(0, 2).join("; ")}`, "warn");
      return data as { output: any; warnings: string[]; meta: any };
    } catch (e: any) {
      setAgent(agent, "error");
      throw new Error(e?.message === "Failed to fetch" ? "Network problem. Check your connection and retry." : e?.message || "This step failed.");
    }
  }

  // ---------- The pipeline: each step reads/writes ctx.current ----------
  const steps: { name: string; run: () => Promise<void> }[] = [
    {
      name: "read page",
      run: async () => {
        const c = ctx.current;
        if (c.pastedText) {
          c.page = { title: "", text: c.pastedText.slice(0, 15000), url: c.url || "" };
          say("Researcher: using the page text you pasted.");
        } else {
          setAgent("researcher", "working");
          say(`Researcher: opening ${c.url} …`);
          const res = await fetch("/api/fetch-page", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: c.url }) });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || !data.ok) {
            setAgent("researcher", "idle");
            throw Object.assign(new Error(data.reason || data.error || "Couldn't open that page."), { needPaste: true });
          }
          c.page = { title: data.title, text: data.text, url: data.url };
          say(`Researcher: read the page${data.title ? ` "${data.title.slice(0, 60)}"` : ""}.`);
        }
        setPage(c.page);
      },
    },
    {
      name: "research",
      run: async () => {
        const c = ctx.current;
        say("Researcher: studying the product, then searching the web for competitors and customer pains …");
        const r = await callAgent("research", { page_url: c.page.url, page_text: c.page.text, audience_hint: c.audience || "not given", monthly_budget_inr: c.budget });
        c.research = r.output;
        setResearch(r.output);
        setResearchMeta(r.meta);
        say(
          r.meta?.webSearchUsed ? `Researcher: checked ${r.meta.sources?.length || 0} web sources.` : "Researcher: web search unavailable — competitors are from general knowledge, please verify.",
          r.meta?.webSearchUsed ? "info" : "warn"
        );
        say(`Researcher → Reviewer: ${r.output.competitors?.length || 0} competitors, ${r.output.angles?.length || 0} angles, ${r.output.key_claims?.length || 0} page claims.`, "handoff");
      },
    },
    {
      name: "review research",
      run: async () => {
        const c = ctx.current;
        const r = await callAgent("review_research", { research: c.research });
        c.reviewResearch = r.output;
        setReviewResearch(r.output);
        say(`Reviewer: research ${r.output.verdict === "approve" ? "approved" : "approved with notes"}.${r.output.notes?.[0] ? " " + r.output.notes[0] : ""}`, "review");
        say("Reviewer → Head of Growth: research handed over.", "handoff");
      },
    },
    {
      name: "strategy",
      run: async () => {
        const c = ctx.current;
        say("Head of Growth: choosing what to test first …");
        const r = await callAgent("strategy", { research: c.research, reviewer_notes: c.reviewResearch?.notes || [], audience_hint: c.audience || "not given", monthly_budget_inr: c.budget });
        c.strategy = r.output;
        setStrategy(r.output);
        say(`Head of Growth: 3 tests picked — ${r.output.tests.map((t: any) => `${t.angle_id} in ${t.language}`).join(", ")}.`, "good");
        say("Head of Growth → Copywriter: write ads for all 5 angles in 3 languages.", "handoff");
      },
    },
    {
      name: "copy",
      run: async () => {
        const c = ctx.current;
        say("Copywriter: writing 15 ads (5 angles × English, Hindi, Telugu) …");
        const r = await callAgent("copy", {
          product_name: c.research.product_name,
          product_summary: c.research.product_summary,
          target_customer: c.research.target_customer,
          key_claims: c.research.key_claims,
          angles: c.research.angles,
        });
        c.ads = r.output.ads as AdSet[];
        setAds(c.ads);
        say("Copywriter → Reviewer: 15 ads ready for checking.", "handoff");
      },
    },
    {
      name: "review copy",
      run: async () => {
        const c = ctx.current;
        say("Reviewer: checking every ad against the page's claims, language and word limits …");
        const r = await callAgent("review_copy", { key_claims: c.research.key_claims, ads: c.ads });
        const issues: any[] = Array.isArray(r.output.issues) ? [...r.output.issues] : [];
        // Rules also checked in code, not just by the AI.
        for (const ad of c.ads as AdSet[])
          for (const l of ["english", "hindi", "telugu"] as Lang[]) {
            const a = ad[l];
            if (!a) continue;
            if (wc(a.headline) > 8 || wc(a.body) > 25)
              if (!issues.some((i) => i.angle_id === ad.angle_id && i.language === l))
                issues.push({ angle_id: ad.angle_id, language: l, problem: "Over the word limit", fix_hint: "Headline max 8 words, body max 25." });
          }
        c.reviewCopy = { ...r.output, issues };
        setReviewCopy(c.reviewCopy);
        if (!issues.length) {
          say("Reviewer: all 15 ads approved.", "review");
          return;
        }
        say(`Reviewer → Copywriter: sent back ${issues.length} ad${issues.length > 1 ? "s" : ""}. e.g. ${issues[0].angle_id} ${issues[0].language}: ${issues[0].problem}`, "review");
        const flagged = issues.map((i) => ({ ...i, current: (c.ads as AdSet[]).find((a) => a.angle_id === i.angle_id)?.[langKey(i.language)] }));
        const f = await callAgent("copy_fix", { key_claims: c.research.key_claims, ads_to_fix: flagged.slice(0, 8) });
        const next: AdSet[] = (c.ads as AdSet[]).map((a) => ({ ...a, fixed: [...(a.fixed || [])] }));
        for (const fx of f.output.fixed || []) {
          const target = next.find((a) => a.angle_id === fx.angle_id);
          const l = langKey(fx.language);
          if (target && fx.headline) {
            target[l] = { headline: fx.headline, body: fx.body, cta: fx.cta };
            if (!target.fixed!.includes(l)) target.fixed!.push(l);
          }
        }
        c.ads = next;
        setAds(next);
        say(`Copywriter: fixed ${f.output.fixed?.length || 0} ad${(f.output.fixed?.length || 0) === 1 ? "" : "s"}. Reviewer: approved.`, "good");
      },
    },
    {
      name: "channel",
      run: async () => {
        const c = ctx.current;
        say("Head of Growth → Channel Lead: plan where and how to run the 3 tests.", "handoff");
        const testAds = c.strategy.tests.map((t: any) => ({ ...t, ad: (c.ads as AdSet[]).find((a) => a.angle_id === t.angle_id)?.[langKey(t.language)] }));
        const weekBudget = Math.round((Number(c.budget) || 30000) * (7 / 30));
        const r = await callAgent("channel", { tests: testAds, test_budget_7_days_inr: weekBudget, audience_hint: c.audience || "not given", product: c.research.product_summary });
        // Budget rule enforced in code: the 3 tests must add up to the week's budget.
        const total = (r.output.plan || []).reduce((s: number, p: any) => s + (Number(p.daily_budget_inr) || 0) * 7, 0);
        if (Math.abs(total - weekBudget) > weekBudget * 0.3) {
          const fair = Math.round(weekBudget / 21);
          r.output.plan = (r.output.plan || []).map((p: any) => ({ ...p, daily_budget_inr: fair }));
          say(`Reviewer: budgets didn't add up to the ₹${weekBudget.toLocaleString("en-IN")} test budget — set each ad to ${inr(fair)}/day.`, "review");
        }
        c.channel = r.output;
        setChannel(r.output);
        say(`Channel Lead: ${r.output.plan.map((p: any) => `${p.cell_id} on ${p.channel}`).join(", ")}.`, "good");
        say("Channel Lead → Head of Growth: plan ready for sign-off.", "handoff");
      },
    },
    {
      name: "sign-off",
      run: async () => {
        const c = ctx.current;
        const weekBudget = Math.round((Number(c.budget) || 30000) * (7 / 30));
        const r = await callAgent("signoff", { strategy: c.strategy, channel_plan: c.channel, test_budget_7_days_inr: weekBudget });
        c.signoff = r.output;
        setSignoff(r.output);
        say(`Head of Growth: test plan ${r.output.approved === false ? "approved with changes" : "approved"}. ${r.output.message || ""}`, "good");
        say("Ready to launch. (Results in this demo are sample data.)", "info");
      },
    },
  ];

  async function runFrom(index: number) {
    setBusy(true);
    setError(null);
    for (let i = index; i < steps.length; i++) {
      try {
        await steps[i].run();
      } catch (e: any) {
        if (e?.needPaste) {
          setPasteReason(e.message);
          setPasteMode(true);
          setPhase("start");
          setBusy(false);
          say(`Researcher: ${e.message} Waiting for pasted page text.`, "warn");
          return;
        }
        say(`Stopped at "${steps[i].name}": ${e.message}`, "warn");
        setError({ message: e.message, retry: () => runFrom(i) });
        setBusy(false);
        return;
      }
    }
    setBusy(false);
  }

  function start() {
    const clean = url.trim();
    if (!pasteMode && !/^https?:\/\//i.test(clean)) {
      setError({ message: "Please paste a full link starting with http:// or https://", retry: () => setError(null) });
      return;
    }
    if (pasteMode && pasted.trim().length < 200) {
      setError({ message: "Please paste a bit more of the page text (at least a few lines).", retry: () => setError(null) });
      return;
    }
    ctx.current = { url: clean, audience: audience.trim(), budget: Number(budget) || 30000, pastedText: pasteMode ? pasted.trim() : "" };
    setPhase("team");
    setLog([]);
    setStatus({ head: "idle", researcher: "idle", copywriter: "idle", channel: "idle", reviewer: "idle" });
    setResearch(null); setResearchMeta(null); setReviewResearch(null); setStrategy(null); setAds(null);
    setReviewCopy(null); setChannel(null); setSignoff(null); setRounds([]); setLearnings([]); setPage(null);
    prevReady.current = 0;
    setTab("research");
    say("Head of Growth: new client. Team, let's go.", "good");
    runFrom(0);
  }

  // ---------- Learning loop ----------
  function cellsForRound(n: number): Cell[] {
    const c = ctx.current;
    const avg = Math.round(c.channel.plan.reduce((s: number, p: any) => s + (Number(p.daily_budget_inr) || 0), 0) / c.channel.plan.length) || 300;
    if (n === 1) {
      return c.strategy.tests.map((t: any) => {
        const plan = c.channel.plan.find((p: any) => p.cell_id === t.cell_id) || {};
        const angle = c.research.angles.find((a: any) => a.id === t.angle_id);
        return {
          cell_id: t.cell_id,
          label: `${t.cell_id} · ${angle?.name || t.angle_id} · ${t.language} · ${plan.channel || ""}`,
          angle: angle?.name || t.angle_id,
          language: t.language,
          audience: t.audience,
          channel: plan.channel || "",
          daily_budget_inr: Number(plan.daily_budget_inr) || avg,
          ad: (c.ads as AdSet[]).find((a) => a.angle_id === t.angle_id)?.[langKey(t.language)],
        };
      });
    }
    const prev = c.rounds[n - 2];
    return prev.analysis.next_round.map((x: any, i: number) => {
      const id = `R${n}-${i + 1}`;
      const ad = prev.nextAds?.[i];
      return {
        cell_id: id,
        label: `${id} · ${x.angle_name} · ${x.language}`,
        angle: x.angle_name,
        language: x.language,
        audience: x.audience,
        channel: "",
        daily_budget_inr: avg,
        ad: ad ? { headline: ad.headline, body: ad.body, cta: ad.cta } : undefined,
      };
    });
  }

  async function runRound(n: number) {
    const c = ctx.current;
    setBusy(true);
    setError(null);
    try {
      c.rounds = c.rounds || [];
      let round: Round = c.rounds[n - 1];
      if (!round || !round.results?.length) {
        const cells = cellsForRound(n);
        const results = simulateRound(n, cells, (c.research?.product_name || "") + c.url);
        round = { round: n, cells, results, shownDays: 0 };
        c.rounds[n - 1] = round;
        setRounds([...c.rounds]);
        say(`Round ${n} launched: ${cells.length} ads live for 7 days (sample results).`, "good");
        for (let d = 1; d <= 7; d++) {
          await sleep(550);
          round.shownDays = d;
          setRounds([...c.rounds]);
          if (d === 3 || d === 7) {
            const lead = [...results].map((r) => ({ id: r.cell_id, t: totals(r.days.slice(0, d)) })).filter((x) => x.t.cps != null).sort((a, b) => a.t.cps! - b.t.cps!)[0];
            if (lead) say(`Day ${d}: ${lead.id} leads at ${inr(lead.t.cps)} per signup.`, "info");
          }
        }
      }
      if (!round.analysis) {
        say("Head of Growth: reading the results …");
        const table = round.results.map((r) => {
          const cell = round.cells.find((x) => x.cell_id === r.cell_id)!;
          const t = totals(r.days);
          return {
            cell_id: r.cell_id, angle: cell.angle, language: cell.language, audience: cell.audience, channel: cell.channel, ad_headline: cell.ad?.headline || "",
            daily: r.days.map((d) => ({ day: d.day, spend_inr: d.spend, clicks: d.clicks, signups: d.signups })),
            total: { spend_inr: t.spend, impressions: t.impressions, clicks: t.clicks, signups: t.signups, ctr_pct: +(t.ctr * 100).toFixed(2), cost_per_signup_inr: t.cps ? Math.round(t.cps) : null },
          };
        });
        const r = await callAgent("analyze", {
          round: n,
          product: c.research.product_summary,
          test_plan: c.signoff?.test_plan,
          results: table,
          learnings_so_far: (c.learnings || []).map((l: any) => l.text),
        });
        round.analysis = r.output;
        setRounds([...c.rounds]);
        say(`Head of Growth: ${r.output.summary}`, "good");
        (r.output.decisions || []).forEach((d: any) => say(`Decision ${d.cell_id}: ${String(d.action).toUpperCase()} — ${d.reason}`, d.action === "stop" ? "warn" : "info"));
        const newL = (r.output.learnings || []).map((t: string) => ({ round: n, text: t }));
        c.learnings = [...(c.learnings || []), ...newL];
        setLearnings(c.learnings);
        say(`Learnings log: +${newL.length} new learning${newL.length === 1 ? "" : "s"}.`, "good");
        say("Head of Growth → Copywriter: write next round's ads using what we learned.", "handoff");
      }
      if (!round.nextAds) {
        const r = await callAgent("copy_round2", {
          key_claims: c.research.key_claims,
          product: c.research.product_summary,
          learnings: c.learnings.map((l: any) => l.text),
          next_round: round.analysis.next_round.map((x: any, i: number) => ({ ...x, cell_id: `R${n + 1}-${i + 1}` })),
        });
        let nextAds: any[] = r.output.ads;
        say(`Copywriter → Reviewer: ${nextAds.length} new ads for round ${n + 1}.`, "handoff");
        // The Reviewer checks the new ads too, before anything runs.
        const rv = await callAgent("review_copy", {
          key_claims: c.research.key_claims,
          ads: nextAds.map((a: any) => ({ angle_id: a.cell_id, [langKey(a.language)]: { headline: a.headline, body: a.body, cta: a.cta } })),
        });
        const issues: any[] = Array.isArray(rv.output.issues) ? rv.output.issues : [];
        if (issues.length) {
          say(`Reviewer → Copywriter: sent back ${issues.length}. e.g. ${issues[0].angle_id}: ${issues[0].problem}`, "review");
          const flagged = issues.map((i) => ({ ...i, current: nextAds.find((a: any) => a.cell_id === i.angle_id) }));
          const f = await callAgent("copy_fix", { key_claims: c.research.key_claims, ads_to_fix: flagged.slice(0, 6) });
          nextAds = nextAds.map((a: any) => {
            const fx = (f.output.fixed || []).find((x: any) => x.angle_id === a.cell_id);
            return fx && fx.headline ? { ...a, headline: fx.headline, body: fx.body, cta: fx.cta, fixed: true } : a;
          });
          say(`Copywriter: fixed ${f.output.fixed?.length || 0}. Reviewer: approved.`, "good");
        } else {
          say("Reviewer: new ads approved.", "review");
        }
        round.nextAds = nextAds;
        setRounds([...c.rounds]);
        say(`Round ${n + 1} ads are ready.`, "good");
      }
    } catch (e: any) {
      say(`Round ${n} stopped: ${e.message}`, "warn");
      setError({ message: e.message, retry: () => runRound(n) });
    }
    setBusy(false);
  }

  // ---------- Tabs (layout only) ----------
  type TabId = "research" | "strategy" | "ads" | "plan" | "results";
  const TABS: { id: TabId; label: string; icon: string; ready: boolean; agent: AgentId }[] = [
    { id: "research", label: "Research", icon: "🔎", ready: !!research, agent: "researcher" },
    { id: "strategy", label: "Strategy", icon: "🧭", ready: !!strategy, agent: "head" },
    { id: "ads", label: "Ads", icon: "✍️", ready: !!ads, agent: "copywriter" },
    { id: "plan", label: "Channels & plan", icon: "📣", ready: !!channel, agent: "channel" },
    { id: "results", label: "Results & learnings", icon: "📈", ready: rounds.length > 0, agent: "head" },
  ];
  const [tab, setTab] = useState<TabId>("research");
  const readyCount = TABS.filter((t) => t.ready).length;
  const prevReady = useRef(0);
  useEffect(() => {
    // When a new section becomes ready, jump to it so viewers follow the team live.
    if (readyCount > prevReady.current) {
      const newest = [...TABS].reverse().find((t) => t.ready);
      if (newest) setTab(newest.id);
    }
    prevReady.current = readyCount;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readyCount]);
  const nextTabWorking = TABS.find((t) => !t.ready);

  const lastRound = rounds[rounds.length - 1];
  const canLaunch = !!signoff && rounds.length === 0 && !busy;
  const canNext = !!lastRound?.nextAds && rounds.length < 3 && !busy;
  const testedAngles = new Set((strategy?.tests || []).map((t: any) => t.angle_id));

  return (
    <div className="wrap">
      <header className="top">
        <div className="logo">Growth<span>Crew</span></div>
        <div className="tag">An AI growth team for every startup</div>
      </header>

      {phase === "start" && (
        <section>
          <h1>Your growth team, ready in minutes.</h1>
          <p className="lead">
            Paste your product page. Five AI agents research your market, write ads in English, Hindi and Telugu, plan a fair test — and learn from the results, round after round.
          </p>
          <div className="flow">
            <b>🔎 Research</b>→<b>✅ Review</b>→<b>🧭 Strategy</b>→<b>✍️ Ads ×3 languages</b>→<b>✅ Review</b>→<b>📣 Channels</b>→<b>🧭 Sign-off</b>→<b>📈 Results → learn → next round</b>
          </div>
          <div className="form">
            {!pasteMode ? (
              <div>
                <label>Product page link</label>
                <input placeholder="https://yourstartup.in/product" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === "Enter" && start()} />
              </div>
            ) : (
              <div>
                <div className="callout warn small" style={{ marginBottom: 8 }}>
                  Couldn&apos;t read the page ({pasteReason}). Paste the page text here instead — copy everything on the product page.
                </div>
                <label>Page text</label>
                <textarea value={pasted} onChange={(e) => setPasted(e.target.value.slice(0, 15000))} placeholder="Paste the product page text…" />
              </div>
            )}
            <div className="row2">
              <div>
                <label>Audience / city (optional)</label>
                <input placeholder="e.g. small shop owners in Hyderabad" value={audience} onChange={(e) => setAudience(e.target.value.slice(0, 200))} />
              </div>
              <div>
                <label>Monthly ad budget in ₹ (optional)</label>
                <input inputMode="numeric" value={budget} onChange={(e) => setBudget(e.target.value.replace(/[^\d]/g, "").slice(0, 9))} />
              </div>
            </div>
            {error && (
              <div className="err">
                <span>{error.message}</span>
              </div>
            )}
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button className="primary big" onClick={start} disabled={busy}>Start my growth team →</button>
              {pasteMode && <button className="ghost" onClick={() => { setPasteMode(false); setError(null); }}>Use a link instead</button>}
            </div>
          </div>
        </section>
      )}

      {phase === "team" && (
        <section>
          <div className="team">
            {AGENT_ORDER.map((id) => (
              <div key={id} className={`agent ${status[id]}`}>
                <div className="ic">{AGENTS[id].icon}</div>
                <div className="nm">{AGENTS[id].name}</div>
                <div className="tt">{AGENTS[id].title}</div>
                <div className="st"><span className="dot" />{status[id] === "idle" ? "Waiting" : status[id] === "working" ? "Working…" : status[id] === "done" ? "Done" : "Needs retry"}</div>
              </div>
            ))}
          </div>

          <div className="grid2 section">
            <div>
              {error && (
                <div className="err" style={{ marginBottom: 14 }}>
                  <span>{error.message}</span>
                  <button className="primary" onClick={error.retry} disabled={busy}>Retry this step</button>
                </div>
              )}

              <div className="tabs-bar" role="tablist">
                {TABS.map((t) => {
                  const working = !t.ready && busy && nextTabWorking?.id === t.id;
                  return (
                    <button key={t.id} role="tab" aria-selected={tab === t.id} disabled={!t.ready}
                      className={`tab ${tab === t.id ? "on" : ""} ${t.ready ? "ready" : ""} ${working ? "working" : ""}`}
                      onClick={() => setTab(t.id)}>
                      <span className="ti">{t.icon}</span>{t.label}
                      <span className="tstate">{t.ready ? "✓" : working ? <span className="dot" /> : ""}</span>
                    </button>
                  );
                })}
              </div>

              {!research && (
                <div className="card empty">
                  <div className="spin" />
                  <div><b>The team is getting started.</b><div className="small muted">Research appears here first. Follow every handoff in the activity feed.</div></div>
                </div>
              )}

              {tab === "research" && research && (
                <div className="card">
                  <h2>🔎 Research</h2>
                  <p style={{ marginTop: 0 }}><b>{research.product_name}</b> — {research.product_summary}</p>
                  <p className="small"><b>Who it&apos;s for:</b> {research.target_customer}</p>
                  {reviewResearch?.notes?.length > 0 && (
                    <div className="callout small" style={{ margin: "10px 0" }}><b>Reviewer notes:</b>
                      <ul className="clean">{reviewResearch.notes.map((n: string, i: number) => <li key={i}>{n}</li>)}</ul>
                    </div>
                  )}
                  <div className="section">
                    <h3>Competitors</h3>
                    <div className="tablewrap">
                      <table>
                        <thead><tr><th>Competitor</th><th>What they say</th><th>Gap we can use</th></tr></thead>
                        <tbody>{(research.competitors || []).map((c: any, i: number) => <tr key={i}><td><b>{c.name}</b></td><td>{c.what_they_say}</td><td>{c.gap}</td></tr>)}</tbody>
                      </table>
                    </div>
                    {!researchMeta?.webSearchUsed && <p className="small muted">Web search was not available — competitors come from the AI&apos;s general knowledge. Verify before use.</p>}
                  </div>
                  <div className="section">
                    <h3>Customer pains</h3>
                    <ul className="clean">{(research.customer_pains || []).map((p: string, i: number) => <li key={i}>{p}</li>)}</ul>
                  </div>
                  <div className="section">
                    <h3>5 positioning angles</h3>
                    <div className="angles">
                      {(research.angles || []).map((a: any) => (
                        <div className="angle" key={a.id}>
                          <div className="id">{a.id} {testedAngles.has(a.id) && <span className="pill brand">In test</span>}</div>
                          <h3>{a.name}</h3>
                          <div className="small"><b>Job:</b> {a.job}</div>
                          <div className="small muted" style={{ marginTop: 4 }}>{a.why_it_works}</div>
                          <div className="small" style={{ marginTop: 6 }}>📄 “{a.backing_claim}”</div>
                        </div>
                      ))}
                    </div>
                  </div>
                  {researchMeta?.sources?.length > 0 && (
                    <div className="section small">
                      <h3>Sources</h3>
                      <ul className="clean">
                        {researchMeta.sources.filter((s: any) => /^https?:\/\//.test(s.url)).map((s: any, i: number) => (
                          <li key={i}><a href={s.url} target="_blank" rel="noopener noreferrer nofollow">{s.title}</a></li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}

              {tab === "strategy" && strategy && (
                <div className="card">
                  <h2>🧭 Strategy — what we test first</h2>
                  <p style={{ marginTop: 0 }}>{strategy.goal}</p>
                  <div className="tablewrap">
                    <table>
                      <thead><tr><th>Test</th><th>Angle</th><th>Language</th><th>Audience</th><th>Hypothesis</th></tr></thead>
                      <tbody>{(strategy.tests || []).map((t: any) => (
                        <tr key={t.cell_id}><td><b>{t.cell_id}</b></td><td>{research?.angles?.find((a: any) => a.id === t.angle_id)?.name || t.angle_id}</td><td>{t.language}</td><td>{t.audience}</td><td>{t.hypothesis}</td></tr>
                      ))}</tbody>
                    </table>
                  </div>
                  <p className="small"><b>Why these:</b> {strategy.why_these}</p>
                  <p className="small muted"><b>Not now:</b> {strategy.not_testing_now}</p>
                </div>
              )}

              {tab === "ads" && ads && (
                <div className="card">
                  <h2>✍️ Ads — 5 angles × 3 languages</h2>
                  {reviewCopy && (
                    <p className="small">
                      {reviewCopy.issues?.length ? <span className="pill warn">Reviewer sent back {reviewCopy.issues.length}</span> : <span className="pill ok">Reviewer approved all</span>}
                      {reviewCopy.issues?.slice(0, 3).map((i: any, k: number) => <span key={k} className="muted">· {i.angle_id} {i.language}: {i.problem} </span>)}
                    </p>
                  )}
                  <div className="ads">{(ads || []).filter(Boolean).map((a) => <AdCard key={a.angle_id} set={a} angleName={research?.angles?.find((x: any) => x.id === a.angle_id)?.name} inTest={testedAngles.has(a.angle_id)} />)}</div>
                </div>
              )}

              {tab === "plan" && channel && (
                <div className="card">
                  <h2>📣 Channel plan</h2>
                  <div className="tablewrap">
                    <table>
                      <thead><tr><th>Test</th><th>Channel</th><th>Format</th><th>Targeting</th><th className="num">₹ / day</th></tr></thead>
                      <tbody>{(channel.plan || []).map((p: any) => (
                        <tr key={p.cell_id}><td><b>{p.cell_id}</b></td><td>{p.channel}</td><td>{p.format}</td><td>{p.targeting}</td><td className="num">{inr(p.daily_budget_inr)}</td></tr>
                      ))}</tbody>
                    </table>
                  </div>
                  <p className="small muted">{channel.schedule_note}</p>
                </div>
              )}

              {tab === "plan" && signoff && (
                <div className="card section">
                  <h2>🧭 Test plan — signed off</h2>
                  <div className="callout ok small">
                    <div><b>Metric:</b> {signoff.test_plan?.metric} · <b>Duration:</b> {signoff.test_plan?.duration_days} days · <b>Budget:</b> {inr(signoff.test_plan?.total_budget_inr)}</div>
                    <div><b>Winner rule:</b> {signoff.test_plan?.winner_rule}</div>
                    <div><b>Stop rule:</b> {signoff.test_plan?.stop_rule}</div>
                    <div><b>Min. signups per ad:</b> {signoff.test_plan?.min_signups_per_cell}</div>
                  </div>
                  {signoff.changes?.length > 0 && <ul className="clean small">{signoff.changes.map((c: string, i: number) => <li key={i}>{c}</li>)}</ul>}
                  {canLaunch && (
                    <div style={{ marginTop: 14 }}>
                      <button className="primary big" onClick={() => runRound(1)}>Launch test → see the learning loop</button>
                      <p className="small muted">Ads are not actually posted. Results are sample numbers so you can see how the team learns.</p>
                    </div>
                  )}
                </div>
              )}

              {tab === "plan" && channel && !signoff && busy && (
                <div className="card section empty"><div className="spin" /><div className="small">Head of Growth is reviewing the plan…</div></div>
              )}

              {tab === "results" && (
                <div className="round-tabs">
                  {rounds.map((r) => <span key={r.round} className="pill">Round {r.round}{r.analysis ? (r.analysis.winner ? ` · winner ${r.analysis.winner}` : " · no winner yet") : " · running"}</span>)}
                </div>
              )}
              {tab === "results" && rounds.map((r, i) => <div key={r.round} className={i ? "section" : ""}><RoundView r={r} /></div>)}

              {tab === "results" && learnings.length > 0 && (
                <div className="card section">
                  <h2>🧠 Learnings log</h2>
                  <p className="small muted" style={{ marginTop: 0 }}>The team&apos;s memory. Every round adds to it, and the next round is built on it.</p>
                  <ul className="learn">{learnings.map((l, i) => <li key={i}><span className="r">ROUND {l.round}</span>{l.text}</li>)}</ul>
                </div>
              )}

              {tab === "results" && canNext && (
                <div className="section">
                  <button className="primary big" onClick={() => runRound(rounds.length + 1)}>Run round {rounds.length + 1} with the new ads →</button>
                </div>
              )}
              {tab === "results" && rounds.length > 0 && (
                <div className="section">
                  <button className="ghost" onClick={() => { setPhase("start"); setPasteMode(false); setError(null); }} disabled={busy}>Start over with another product</button>
                </div>
              )}
            </div>

            <div className="log" ref={logRef}>
              <h3>Team activity</h3>
              {log.map((l, i) => (
                <div key={i} className={`ln ${l.kind}`}><span className="t">{l.t}</span>{l.text}</div>
              ))}
              {busy && <div className="ln"><span className="t">…</span>working</div>}
            </div>
          </div>
        </section>
      )}

      <footer className="note">
        Ads are written by AI and not posted anywhere. Ad performance numbers in the learning loop are sample data.
        <br />Built with Claude (Anthropic API) · Next.js · Vercel.
      </footer>
    </div>
  );
}

function AdCard({ set, angleName, inTest }: { set: AdSet; angleName?: string; inTest: boolean }) {
  const [lang, setLang] = useState<Lang>("english");
  const ad = set[lang];
  return (
    <div className="ad">
      <div className="tabs">
        {(["english", "hindi", "telugu"] as Lang[]).map((l) => (
          <button key={l} className={l === lang ? "on" : ""} onClick={() => setLang(l)}>{LANG_LABEL[l]}</button>
        ))}
      </div>
      <div className="body">
        {ad ? (
          <>
            <div className="hl">{ad.headline}</div>
            <div className="tx">{ad.body}</div>
            <span className="cta">{ad.cta}</span>
          </>
        ) : <span className="muted">Missing</span>}
      </div>
      <div className="foot">
        {set.angle_id} · {angleName || ""} {inTest && <span className="pill brand">In test</span>}
        {set.fixed?.includes(lang) && <span className="pill warn">Fixed after review</span>}
      </div>
    </div>
  );
}

const COLORS = ["#c2264d", "#2a5bd7", "#1f8a4c"];

function RoundView({ r }: { r: Round }) {
  const days = r.shownDays;
  // Cumulative cost per signup by day, per cell, for the chart.
  const series = r.results.map((res) =>
    res.days.slice(0, days).map((_, i) => {
      const t = totals(res.days.slice(0, i + 1));
      return t.cps;
    })
  );
  const all = series.flat().filter((v): v is number => v != null);
  const max = all.length ? Math.max(...all) * 1.1 : 1;
  const W = 560, H = 180, P = 30;
  const x = (i: number) => P + (i * (W - P * 2)) / 6;
  const y = (v: number) => H - P - (v / max) * (H - P * 2);

  return (
    <div className="card section">
      <h2>📈 Round {r.round} — results <span className="pill warn">Sample data</span></h2>
      <p className="small muted" style={{ marginTop: 0 }}>Day {days} of 7 · cost per signup (lower is better)</p>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Cost per signup by day">
        <line x1={P} y1={H - P} x2={W - P} y2={H - P} stroke="#e4e2da" />
        {[1, 2, 3, 4, 5, 6, 7].map((d, i) => <text key={d} x={x(i)} y={H - 10} fontSize="11" textAnchor="middle" fill="#616673">D{d}</text>)}
        {series.map((s, k) => {
          const pts = s.map((v, i) => (v == null ? null : `${x(i)},${y(v)}`)).filter(Boolean).join(" ");
          const last = s.length ? s[s.length - 1] : null;
          return (
            <g key={k}>
              <polyline points={pts} fill="none" stroke={COLORS[k % 3]} strokeWidth="2.5" />
              {last != null && <text x={x(s.length - 1) + 6} y={y(last) + 4} fontSize="11" fill={COLORS[k % 3]} fontWeight="700">{r.results[k].cell_id} {inr(last)}</text>}
            </g>
          );
        })}
      </svg>
      <div className="tablewrap">
        <table>
          <thead>
            <tr><th>Ad</th>{[1, 2, 3, 4, 5, 6, 7].map((d) => <th key={d} className="num">Day {d}</th>)}<th className="num">Spend</th><th className="num">Signups</th><th className="num">₹ / signup</th></tr>
          </thead>
          <tbody>
            {r.results.map((res, k) => {
              const shown = res.days.slice(0, days);
              const t = totals(shown);
              const cell = r.cells.find((c) => c.cell_id === res.cell_id);
              return (
                <tr key={res.cell_id}>
                  <td><b style={{ color: COLORS[k % 3] }}>{res.cell_id}</b> <span className="small muted">{cell?.angle} · {cell?.language}</span>
                    {cell?.ad && <div className="small" style={{ marginTop: 2 }}>“{cell.ad.headline}”</div>}</td>
                  {[0, 1, 2, 3, 4, 5, 6].map((i) => <td key={i} className="num">{i < days ? `${res.days[i].signups}` : ""}</td>)}
                  <td className="num">{inr(t.spend)}</td><td className="num">{t.signups}</td><td className="num"><b>{inr(t.cps)}</b></td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="small muted">Day columns show signups per day.</p>
      </div>

      {r.analysis && (
        <div className="section">
          <div className={`callout ${r.analysis.winner ? "ok" : "warn"}`}>
            <b>🧭 Head of Growth:</b> {r.analysis.summary}
            <div className="small" style={{ marginTop: 6 }}><b>Is the data enough?</b> {r.analysis.confidence_note}</div>
          </div>
          <div className="tablewrap section">
            <table>
              <thead><tr><th>Ad</th><th>Decision</th><th>Why</th></tr></thead>
              <tbody>{(r.analysis.decisions || []).map((d: any) => (
                <tr key={d.cell_id}><td><b>{d.cell_id}</b></td><td><span className={`pill ${d.action === "scale" ? "ok" : d.action === "stop" ? "warn" : ""}`}>{String(d.action).toUpperCase()}</span></td><td>{d.reason}</td></tr>
              ))}</tbody>
            </table>
          </div>
          <p className="small"><b>Budget next round:</b> {r.analysis.budget_shift}</p>
          {r.nextAds && (
            <div className="section">
              <h3>Next round: new ads built from the learnings</h3>
              <div className="ads">
                {(r.nextAds || []).map((a: any, i: number) => (
                  <div className="ad" key={i}>
                    <div className="body">
                      <div className="small muted">{a.cell_id} · {a.language}</div>
                      <div className="hl">{a.headline}</div>
                      <div className="tx">{a.body}</div>
                      <span className="cta">{a.cta}</span>
                    </div>
                    <div className="foot">Uses: {a.uses_learning} {a.fixed && <span className="pill warn">Fixed after review</span>}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
