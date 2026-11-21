// Live smoke tests: the real newsbyagents.com API and one real GDELT call. NEWSBYAGENTS_SKIP_LIVE=1 skips them.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { NewsClient } from '../src/api.ts';
import { GdeltClient, GdeltError } from '../src/gdelt.ts';
import { DaysShape, daysOf, EditionShape, editionOf, SearchShape, searchOf, WorldNewsShape, worldNewsOf } from '../src/shapes.ts';

const skip = process.env.NEWSBYAGENTS_SKIP_LIVE === '1' ? 'NEWSBYAGENTS_SKIP_LIVE=1' : false;

describe('live: newsbyagents.com', { skip }, () => {
  const news = new NewsClient({ origin: process.env.NEWSBYAGENTS_ORIGIN ?? 'https://newsbyagents.com' });

  test('the latest edition maps onto the output schema', async () => {
    const e = EditionShape.parse(editionOf(await news.latest()));
    assert.match(e.day, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(e.status === 'final' || e.status === 'provisional');
    assert.ok(e.stories.length > 0);
    assert.ok(e.url.startsWith(news.origin));
    assert.ok(e.stories.every((s) => s.url.startsWith(`${e.url}#story-`)));
  });

  test('the days list and a past day', async () => {
    const d = DaysShape.parse(daysOf(await news.days({ limit: 2 }), (x) => news.dayUrl(x)));
    assert.ok(d.days.length > 0 && d.days.length <= 2);
    const oldest = d.days.at(-1);
    assert.ok(oldest);
    const e = EditionShape.parse(editionOf(await news.edition(oldest.day)));
    assert.equal(e.day, oldest.day);
  });

  test('search', async () => {
    const r = SearchShape.parse(searchOf(await news.search({ q: 'climate', limit: 3 })));
    assert.equal(r.query, 'climate');
    assert.ok(r.results.length <= 3);
  });

  test('the markdown twin', async () => {
    const md = await news.markdown('latest');
    assert.match(md, /^# /);
  });
});

describe('live: GDELT', { skip }, () => {
  test('one article-list search', { timeout: 90_000 }, async (t) => {
    // A shared address can find GDELT's pace already spent: back off generously before calling it a failure.
    const gdelt = new GdeltClient({ retries: 3, backOffMs: 12_000 });
    try {
      const r = WorldNewsShape.parse(worldNewsOf(await gdelt.search({ query: 'climate', timespan: '3d', maxRecords: 5 })));
      assert.ok(r.articles.length <= 5);
      assert.ok(r.articles.every((a) => /^https?:\/\//.test(a.url)));
    } catch (err) {
      if (err instanceof GdeltError && err.status === 429) {
        t.skip('GDELT rate limited this address on every try');
        return;
      }
      throw err;
    }
  });
});
