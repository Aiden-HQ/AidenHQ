// Cloudflare Radar's Zero Wire (briefings on critical CVEs, with what is known about their exploitation) as
// src_security.zerowire rows, one per briefing. No agent tool reads the whole feed (web_view caps a page at 20 KB), so
// the scanner keeps it in the warehouse, where Security Watch joins its CVE ids to the findings.
import { capText, tableDdl, type SourceStore, type Table } from "./source-store.js";

export const FEED_URL = "https://radar.cloudflare.com/security/zero-wire/rss";

export const ZEROWIRE: Table = {
  name: "zerowire_entry",
  key: ["guid"],
  cols: { guid: "text", title: "text", url: "text", published: "timestamptz", summary: "text", cves: "text[]", exploitation: "text" },
  tracked: [],
  url: "url",
  search: ["title", "summary", "exploitation"],
};

export const ZEROWIRE_DDL = `${tableDdl("src_security", ZEROWIRE)}
CREATE OR REPLACE VIEW src_security.zerowire AS
  SELECT guid, title, url, published, summary, cves, exploitation, baseline, first_seen_at, ingested_at, seq, tsv FROM src_security.zerowire_entry;
COMMENT ON VIEW src_security.zerowire IS 'Cloudflare Zero Wire briefings (critical CVEs; Cloudforce One), one row per briefing, refreshed daily. cves = the CVE ids it names (empty when none is assigned yet); summary starts with Cloudflare''s priority label (Prioritize patching, Update affected systems); exploitation = the briefing''s sentences about exploitation or CISA KEV (a briefing lists critical CVEs, so read this to know whether one is exploited). Join cves to src_security.findings (vuln_id, aliases).';
GRANT SELECT ON src_security.zerowire TO agents_open;`;

const decode = (s: string) =>
  s.replace(/&(lt|gt|amp|quot|apos|#39);/g, (_, e) => ({ lt: "<", gt: ">", amp: "&", quot: '"', apos: "'", "#39": "'" })[e as string] ?? "");
const tag = (xml: string, name: string) => xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`))?.[1] ?? "";
const plain = (html: string) => decode(html.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

/** The feed's briefings as rows; a briefing without a guid is skipped. */
export function parseFeed(xml: string) {
  if (!xml.includes("<rss")) throw new Error("zero wire feed is not RSS");
  const rows = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const item = m[1]!;
    const guid = plain(tag(item, "guid"));
    if (!guid) continue;
    const body = plain(tag(item, "content:encoded"));
    const published = new Date(plain(tag(item, "pubDate")));
    const sentences = body.split(/(?<=[.!?])\s+/).filter((s) => /exploit|known exploited|\bKEV\b/i.test(s));
    rows.push({
      guid,
      title: plain(tag(item, "title")),
      url: plain(tag(item, "link")) || null,
      published: Number.isNaN(published.getTime()) ? null : published,
      summary: capText(plain(tag(item, "description")), 1000).text,
      cves: [...new Set(`${plain(tag(item, "title"))} ${body}`.match(/CVE-\d{4}-\d{4,}/g) ?? [])].sort(),
      exploitation: capText([...new Set(sentences)].join(" "), 2000).text || null,
    });
  }
  return rows;
}

/** One daily fetch of the feed into the warehouse; the caller treats a failure as the feed's alone, never the CVE pass's. */
export async function zerowirePass(store: SourceStore, fetchFeed: () => Promise<string> = async () => {
  const res = await fetch(FEED_URL, { headers: { "user-agent": "aidenhq-security-scanner" }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`zero wire feed: HTTP ${res.status}`);
  return await res.text();
}): Promise<number> {
  return store.run("security", "zerowire", async () => {
    let written = 0;
    for (const r of parseFeed(await fetchFeed())) if ((await store.upsert(ZEROWIRE, r, { baseline: false })) !== "same") written++;
    return written;
  });
}
