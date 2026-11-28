// A teammate page's "How to reach" card: every way people get to it, each with its real state. Two fixed rows (your own
// chats; the instance's Slack bot, once it is connected) and one per way a channel module declares (board.reach: its own app,
// an email address), read from src/reach.ts. Nothing here names a module.
import { reachQuery, QUERIES, useQuery } from "./queries";
import { Icon, type IconName } from "./ui/icons";
import { SectionCard, StatusDot, LinkButton, type StatusTone } from "./ui";
import { SkeletonLines } from "./Skeleton";
import type { ReachRow } from "./types";

interface Line { id: string; icon: IconName; tone: number; title: string; detail: string; state: { tone: StatusTone; word: string }; action?: { href: string; label: string } }

const STATE: Record<ReachRow["state"], { tone: StatusTone; word: string }> = { on: { tone: "ok", word: "On" }, needs: { tone: "needs", word: "Needs tokens" }, off: { tone: "idle", word: "Off" } };
const ICON: Record<ReachRow["kind"], [IconName, number]> = { app: ["apps", 1], address: ["mail", 4] };

export function TeammateReach({ agentKey, name, onSignIn }: { agentKey: string; name: string; onSignIn: () => void }) {
  const q = useQuery(reachQuery(agentKey), onSignIn);
  const modules = useQuery(QUERIES.modules, onSignIn).data?.modules;
  const data = q.data;
  if (!data) return <SectionCard title={`How to reach ${name}`}>{q.error ? <p className="mate-p">Couldn't load this: {q.error}</p> : <SkeletonLines lines={3} />}</SectionCard>;
  const href = (m: ReachRow["manage"]) => (m.page ? `#/team/m/${m.page}` : `#/team/modules/${modules?.find((x) => x.name === m.module && !x.browse)?.id ?? m.module}/settings`);
  const lines: Line[] = [
    { id: "chats", icon: "chat", tone: 0, title: "Your chats", detail: `Write “cc ${name}” in a chat${data.address ? ", or cc its address in an email" : ""}.`, state: { tone: "ok", word: "Always on" } },
    ...(data.bot ? [{ id: "bot", icon: "agents" as const, tone: 6, title: "AidenHQ bot", detail: `Anyone can DM or @mention the Slack bot and name ${name}; it answers under ${name}'s name.`, state: { tone: "ok" as const, word: "On" } }] : []),
    ...data.rows.map((r): Line => {
      const [icon, tone] = ICON[r.kind];
      return { id: r.id, icon, tone: r.state === "off" ? 7 : tone, title: r.label, detail: r.detail, state: STATE[r.state], action: { href: href(r.manage), label: r.state === "off" ? "Set up" : r.kind === "address" ? "Edit" : "Manage" } };
    }),
  ];
  return (
    <SectionCard title={`How to reach ${name}`}>
      <ul className="reach">
        {lines.map((l) => (
          <li key={l.id} className="reach-row" style={{ "--tone-bg": `var(--tone-${l.tone}-bg)`, "--tone-fg": `var(--tone-${l.tone}-fg)` } as React.CSSProperties}>
            <span className="reach-ico" aria-hidden><Icon name={l.icon} size={16} /></span>
            <span className="reach-body">
              <span className="reach-top">
                <b>{l.title}</b>
                <StatusDot tone={l.state.tone}>{l.state.word}</StatusDot>
              </span>
              <span className={`reach-detail${l.state.tone === "idle" ? " off" : ""}`}>{l.detail}</span>
            </span>
            {l.action && <LinkButton size="sm" href={l.action.href}>{l.action.label}</LinkButton>}
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}
