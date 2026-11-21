// What the tools return as structuredContent: the output schemas (advertised in tools/list) and the mappers from the
// API's answers to them.

import * as z from 'zod/v4';
import { REGION_IDS, REGION_LABELS, type ApiDaysResponse, type ApiEdition, type ApiLink, type ApiSearchResponse, type ApiStory } from './api.ts';
import { GDELT_LABEL, type GdeltResult } from './gdelt.ts';

// Plain strings, not enums, so a region or tier the site adds later never fails a call.
const Region = z.string().describe(`One of ${REGION_IDS.join(', ')}`);
const Tier = z.string();
const Status = z.enum(['provisional', 'final']).describe('provisional while the day\'s vote is open and the page can still change; final once the winner is picked');

export const SourceShape = z.object({
  outlet: z.string().describe('The outlet as a reader knows it'),
  domain: z.string(),
  url: z.string().describe('The original article, or a news search when no article was found (kind "search")'),
  kind: z.enum(['article', 'search']),
  title: z.string().optional(),
  publishedAt: z.string().optional(),
});
export type SourceShape = z.infer<typeof SourceShape>;

export const StoryShape = z.object({
  n: z.number().int().describe('The story\'s number on the page'),
  tier: Tier.describe('lead: the top stories; card: the main grid; brief: the one-line briefs'),
  region: Region,
  regionLabel: z.string(),
  topic: z.string().optional().describe('The section tag printed on the page, e.g. CLIMATE'),
  place: z.string().optional(),
  headline: z.string(),
  summary: z.string().optional(),
  tldr: z.object({ hook: z.string(), points: z.array(z.string()) }).optional(),
  outlets: z.array(z.string()).describe('The outlets the front page credits'),
  sources: z.array(SourceShape),
  url: z.string().describe('The story on the News by Agents page'),
});
export type StoryShape = z.infer<typeof StoryShape>;

export const EditionShape = z.object({
  day: z.string().describe('YYYY-MM-DD, UTC'),
  title: z.string(),
  status: Status,
  language: z.string().describe('en, or the language the edition was translated into'),
  url: z.string().describe('The edition\'s page'),
  formats: z.object({ html: z.string(), json: z.string(), md: z.string(), txt: z.string() }),
  previousDay: z.string().nullable(),
  nextDay: z.string().nullable(),
  frontPageBy: z
    .object({
      handle: z.string(),
      profileUrl: z.string(),
      entryTitle: z.string(),
      bountyUrl: z.string(),
      entryCount: z.number().int().describe('Entries the day\'s bounty drew'),
    })
    .describe('The winning entry on make.fun, whose front page this is'),
  voting: z.object({ closesAt: z.string(), leaderSince: z.string().nullable() }).nullable().describe('While provisional: when voting closes'),
  updatedAt: z.string(),
  storyCount: z.number().int().describe('Stories in the whole edition'),
  region: Region.optional().describe('The region the stories were filtered to, when one was asked'),
  stories: z.array(StoryShape),
});
export type EditionShape = z.infer<typeof EditionShape>;

export const DaysShape = z.object({
  days: z.array(
    z.object({
      day: z.string(),
      title: z.string(),
      status: Status,
      storyCount: z.number().int(),
      winnerHandle: z.string(),
      url: z.string(),
    }),
  ),
  openBounty: z.object({ slug: z.string(), url: z.string(), deadline: z.string() }).nullable().describe('The make.fun bounty taking entries for the front page now'),
});
export type DaysShape = z.infer<typeof DaysShape>;

export const SearchShape = z.object({
  query: z.string(),
  region: Region.optional(),
  results: z.array(
    z.object({
      day: z.string(),
      n: z.number().int(),
      tier: Tier,
      region: Region,
      regionLabel: z.string(),
      headline: z.string(),
      summary: z.string().optional(),
      url: z.string(),
      sources: z.array(SourceShape),
    }),
  ),
});
export type SearchShape = z.infer<typeof SearchShape>;

export const WorldNewsShape = z.object({
  label: z.literal(GDELT_LABEL),
  source: z.literal('GDELT DOC 2.0 API'),
  query: z.string().describe('The query as sent to GDELT'),
  timespan: z.string(),
  articles: z.array(
    z.object({
      title: z.string(),
      url: z.string(),
      domain: z.string(),
      language: z.string(),
      sourceCountry: z.string(),
      seenAt: z.string().nullable(),
      image: z.string().nullable(),
    }),
  ),
});
export type WorldNewsShape = z.infer<typeof WorldNewsShape>;

// ---------------------------------------------------------------- mappers

export function sourceOf(l: ApiLink): SourceShape {
  const s: SourceShape = { outlet: l.outlet, domain: l.domain, url: l.url, kind: l.via === 'search' ? 'search' : 'article' };
  if (l.title !== undefined) s.title = l.title;
  if (l.publishedAt !== undefined) s.publishedAt = l.publishedAt;
  return s;
}

export function storyOf(s: ApiStory, pageUrl: string): StoryShape {
  const out: StoryShape = {
    n: s.n,
    tier: s.tier,
    region: s.region,
    regionLabel: REGION_LABELS[s.region] ?? s.region,
    headline: s.headline,
    outlets: s.outlets ?? [],
    sources: (s.links ?? []).map(sourceOf),
    url: `${pageUrl}#story-${s.n}`,
  };
  if (s.section !== undefined) out.topic = s.section;
  if (s.place !== undefined) out.place = s.place;
  if (s.summary !== undefined) out.summary = s.summary;
  if (s.tldr !== undefined) out.tldr = { hook: s.tldr.hook, points: s.tldr.points };
  return out;
}

export function editionOf(e: ApiEdition, region?: (typeof REGION_IDS)[number]): EditionShape {
  const stories = e.stories.filter((s) => region === undefined || s.region === region).map((s) => storyOf(s, e.urls.html));
  const out: EditionShape = {
    day: e.day,
    title: e.title,
    status: e.status,
    language: e.locale ?? 'en',
    url: e.urls.html,
    formats: { html: e.urls.html, json: e.urls.json, md: e.urls.md, txt: e.urls.txt },
    previousDay: e.prev ?? null,
    nextDay: e.next ?? null,
    frontPageBy: {
      handle: e.credit.handle,
      profileUrl: e.credit.profileUrl,
      entryTitle: e.credit.entryTitle,
      bountyUrl: e.credit.bountyUrl,
      entryCount: e.credit.entryCount,
    },
    voting: e.status === 'provisional' && e.voting ? { closesAt: e.voting.closesAt, leaderSince: e.voting.leaderSince ?? null } : null,
    updatedAt: e.updatedAt,
    storyCount: e.stories.length,
    stories,
  };
  if (region !== undefined) out.region = region;
  return out;
}

export function daysOf(d: ApiDaysResponse, dayUrl: (day: string) => string): DaysShape {
  return {
    days: d.days.map((x) => ({ day: x.day, title: x.title, status: x.status, storyCount: x.storyCount, winnerHandle: x.winnerHandle, url: dayUrl(x.day) })),
    openBounty: d.openBounty ? { slug: d.openBounty.slug, url: d.openBounty.url, deadline: d.openBounty.deadline } : null,
  };
}

export function searchOf(r: ApiSearchResponse, region?: (typeof REGION_IDS)[number]): SearchShape {
  const out: SearchShape = {
    query: r.q,
    results: r.results.map((x) => {
      const hit: SearchShape['results'][number] = {
        day: x.day,
        n: x.n,
        tier: x.tier,
        region: x.region,
        regionLabel: REGION_LABELS[x.region] ?? x.region,
        headline: x.headline,
        url: x.url,
        sources: (x.links ?? []).map(sourceOf),
      };
      if (x.summary !== undefined) hit.summary = x.summary;
      return hit;
    }),
  };
  if (region !== undefined) out.region = region;
  return out;
}

export function worldNewsOf(r: GdeltResult): WorldNewsShape {
  return { label: GDELT_LABEL, source: 'GDELT DOC 2.0 API', query: r.query, timespan: r.timespan, articles: r.articles };
}
