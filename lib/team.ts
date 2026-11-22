// Public info about the team (safe to send to the browser).
export type AgentId = "head" | "researcher" | "copywriter" | "channel" | "reviewer";

export const AGENTS: Record<AgentId, { name: string; title: string; icon: string }> = {
  head: { name: "Head of Growth", title: "Sets strategy, picks tests, reads results", icon: "🧭" },
  researcher: { name: "Researcher", title: "Product, market and competitors", icon: "🔎" },
  copywriter: { name: "Copywriter", title: "Ads in English, Hindi, Telugu", icon: "✍️" },
  channel: { name: "Channel Lead", title: "Where to run, who to target, budget", icon: "📣" },
  reviewer: { name: "Reviewer", title: "Checks every handoff", icon: "✅" },
};

export const AGENT_ORDER: AgentId[] = ["head", "researcher", "copywriter", "channel", "reviewer"];

export type StepId =
  | "research" | "review_research" | "strategy" | "copy" | "review_copy"
  | "copy_fix" | "channel" | "signoff" | "analyze" | "copy_round2";

export const STEP_AGENT: Record<StepId, AgentId> = {
  research: "researcher",
  review_research: "reviewer",
  strategy: "head",
  copy: "copywriter",
  review_copy: "reviewer",
  copy_fix: "copywriter",
  channel: "channel",
  signoff: "head",
  analyze: "head",
  copy_round2: "copywriter",
};
