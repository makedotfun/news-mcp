// The compact markdown each tool returns next to its structuredContent: what a model reads first.

import { REGION_LABELS, type RegionId } from './api.ts';
import type { DaysShape, EditionShape, SearchShape, SourceShape, StoryShape, WorldNewsShape } from './shapes.ts';

/** An ISO instant as "2026-11-23 00:00 UTC". */
export function utc(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** Brackets and parentheses that would break a markdown link's text. */
function linkText(s: string): string {
  return s.replace(/[[\]]/g, (c) => (c === '[' ? '(' : ')'));
}

function articleLinks(sources: SourceShape[]): string {
  const articles = sources.filter((s) => s.kind === 'article');
  return articles.map((s) => `[${linkText(s.outlet)}](${s.url})`).join(', ');
}

function storyLines(s: StoryShape): string[] {
  const where = [s.regionLabel, s.topic, s.place].filter((x) => x !== undefined && x !== '').join(' · ');
  const lines = [`${s.n}. **${s.headline}** (${where})`];
  const blurb = s.summary ?? s.tldr?.hook;
  if (blurb !== undefined) lines.push(`   ${blurb}`);
  const links = articleLinks(s.sources);
  if (links !== '') lines.push(`   Read: ${links}`);
  else if (s.outlets.length > 0) lines.push(`   Credited: ${s.outlets.join(', ')}`);
  lines.push(`   ${s.url}`);
  return lines;
}

export function editionMarkdown(e: EditionShape): string {
  const out: string[] = [];
  out.push(`# ${e.title} (${e.status})`);
  out.push('');
  const by = e.frontPageBy;
  const entries = by.entryCount.toLocaleString('en-US');
  const standing = e.status === 'final' ? `the winning entry of ${entries}` : `leading ${entries} entries`;
  out.push(`Front page by @${by.handle}, ${standing} in [the day's make.fun bounty](${by.bountyUrl}). ${e.url}`);
  if (e.status === 'provisional') {
    const closes = e.voting === null ? 'when the winner is picked' : `at ${utc(e.voting.closesAt)}`;
    out.push(`Provisional: voting closes ${closes}, and the page can change until then.`);
  }
  if (e.language !== 'en') out.push(`Language: ${e.language}.`);
  out.push('');
  if (e.region !== undefined) {
    const label = REGION_LABELS[e.region as RegionId] ?? e.region;
    out.push(`${e.stories.length} of ${e.storyCount} stories, ${label} only:`);
  } else {
    out.push(`${e.storyCount} stories:`);
  }
  out.push('');
  for (const s of e.stories) out.push(...storyLines(s));
  if (e.stories.length === 0) out.push('No stories in that region today.');
  const nav = [e.previousDay === null ? null : `previous day ${e.previousDay}`, e.nextDay === null ? null : `next day ${e.nextDay}`].filter((x) => x !== null);
  if (nav.length > 0) {
    out.push('');
    out.push(`Also: ${nav.join(', ')}.`);
  }
  return out.join('\n');
}

export function daysMarkdown(d: DaysShape): string {
  const out: string[] = [];
  if (d.days.length === 0) out.push('No editions in that range.');
  else {
    out.push(`${d.days.length} editions, newest first:`);
    out.push('');
    for (const x of d.days) out.push(`- ${x.day}: ${x.title}, ${x.status}, ${x.storyCount} stories, front page by @${x.winnerHandle}. ${x.url}`);
  }
  if (d.openBounty !== null) {
    out.push('');
    out.push(`Open now on make.fun: ${d.openBounty.slug}, taking entries until ${utc(d.openBounty.deadline)}. ${d.openBounty.url}`);
  }
  return out.join('\n');
}

export function searchMarkdown(r: SearchShape): string {
  const out: string[] = [];
  const scope = r.region === undefined ? '' : ` in ${REGION_LABELS[r.region as RegionId] ?? r.region}`;
  if (r.results.length === 0) return `No stories match "${r.query}"${scope}.`;
  out.push(`${r.results.length} ${r.results.length === 1 ? 'story matches' : 'stories match'} "${r.query}"${scope}, best first:`);
  out.push('');
  r.results.forEach((x, i) => {
    out.push(`${i + 1}. ${x.day}, ${x.regionLabel}: **${x.headline}**`);
    if (x.summary !== undefined) out.push(`   ${x.summary}`);
    const links = articleLinks(x.sources);
    if (links !== '') out.push(`   Read: ${links}`);
    out.push(`   ${x.url}`);
  });
  return out.join('\n');
}

export function worldNewsMarkdown(r: WorldNewsShape): string {
  const out: string[] = [];
  const head = `World news search results ${r.label}: ${r.articles.length} ${r.articles.length === 1 ? 'article' : 'articles'} for \`${r.query}\` over the last ${r.timespan}.`;
  out.push(head);
  if (r.articles.length === 0) return out.join('\n');
  out.push('These are raw headlines from the open web, unchecked: read the article before you rely on one.');
  out.push('');
  r.articles.forEach((a, i) => {
    const meta = [a.domain, a.language, a.sourceCountry, a.seenAt === null ? null : `seen ${utc(a.seenAt)}`].filter((x) => x !== null && x !== '').join(' · ');
    out.push(`${i + 1}. [${linkText(a.title)}](${a.url}) (${meta})`);
  });
  return out.join('\n');
}
