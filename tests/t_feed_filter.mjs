import { assertEquals } from 'jsr:@std/assert';
import { emptyFilter, normalizeFilter, parseFilter, serializeFilter, compileFilter, filterConditions, parameterNames } from '../client/js/feed-filter-model.mjs';
import { feedUrl } from '../client/js/route-parse.mjs';
const entry = { filename: 'a/deep/Example.png', judgment: { vote: 'down', favorite: true, bookmark: true, notes: { neg: 'Blur in face', pos: 'Good light' } },
  meta: { nodes: [{ type: 'KSampler', inputs: { seed: 42, sampler_name: 'Euler', flag: false, zero: 0 } }] } };
Deno.test('filter URL round trip retains all fields, legacy key, unrelated query and clears outgoing filters', () => {
  const model = normalizeFilter({ mode: 'or', filename: 'a & b', directory: 'a/', down: true, up: true, favorite: true, bookmark: true,
    negativeMode: 'contains', negative: 'blur', positiveMode: 'nonempty', positive: 'retained', parameter: 'KSampler.seed', parameterMode: 'equals', parameterValue: '42' });
  const query = serializeFilter(model, new URLSearchParams('other=keep'));
  assertEquals(parseFilter(query), model);
  assertEquals(query.get('filter'), 'a & b');
  assertEquals(query.get('other'), 'keep');
  assertEquals(parseFilter(new URLSearchParams('filter=old')).filename, 'old');
  assertEquals(feedUrl('h', 'a.png', { search: '?' + query }), '/?other=keep#h#a.png');
});
Deno.test('empty filters match everything in either mode; AND/OR combine only set conditions', () => {
  assertEquals(compileFilter(emptyFilter())({ filename: '' }), true);
  assertEquals(compileFilter({ mode: 'or' })({ filename: '' }), true);
  assertEquals(compileFilter({ filename: 'example', up: true })(entry), false);
  assertEquals(compileFilter({ mode: 'or', filename: 'EXAMPLE', up: true })(entry), true);
  assertEquals(filterConditions({ down: true, up: true }).length, 2);
});
Deno.test('every condition kind matches and rejects independently', () => {
  for (const model of [{ filename: 'EXAMPLE' }, { directory: 'DEEP' }, { down: true }, { favorite: true }, { bookmark: true },
    { negativeMode: 'contains', negative: 'blur' }, { negativeMode: 'nonempty' }, { positiveMode: 'contains', positive: 'LIGHT' },
    { positiveMode: 'nonempty' }, { parameter: 'KSampler.zero' }, { parameter: 'KSampler.flag', parameterMode: 'equals', parameterValue: 'false' },
    { parameter: 'KSampler.seed', parameterMode: 'equals', parameterValue: '42' },
    { parameter: 'KSampler.sampler_name', parameterMode: 'contains', parameterValue: 'UL' }]) {
    assertEquals(compileFilter(model)(entry), true, JSON.stringify(model));
    assertEquals(compileFilter(model)({ filename: 'elsewhere.png' }), false, JSON.stringify(model));
  }
  assertEquals(compileFilter({ up: true })({ ...entry, judgment: { vote: 'up' } }), true);
  assertEquals(compileFilter({ parameter: 'KSampler.seed' })({ ...entry, meta: null }), false);
  assertEquals(compileFilter({ directory: 'Example' })(entry), false, 'directory excludes filename leaf');
  assertEquals(parameterNames([entry, entry]), ['KSampler.flag', 'KSampler.sampler_name', 'KSampler.seed', 'KSampler.zero']);
});
Deno.test('incomplete text conditions are not set in AND or OR, including parameter comparisons', () => {
  const incomplete = [{ filename: '' }, { directory: '' }, { negativeMode: 'contains', negative: '' },
    { positiveMode: 'contains', positive: '' }, { parameter: '', parameterMode: 'contains', parameterValue: '42' },
    { parameter: 'KSampler.seed', parameterMode: 'contains', parameterValue: '' },
    { parameter: 'KSampler.seed', parameterMode: 'equals', parameterValue: '' }];
  for (const model of incomplete) {
    assertEquals(filterConditions(model), [], JSON.stringify(model));
    for (const mode of ['and', 'or']) {
      assertEquals(compileFilter({ ...model, mode })({ filename: 'other.png' }), true, 'no set conditions');
      assertEquals(compileFilter({ ...model, mode, bookmark: true })(entry), true);
      assertEquals(compileFilter({ ...model, mode, bookmark: true })({ filename: 'other.png' }), false, 'incomplete row cannot defeat OR');
    }
    assertEquals(parseFilter(serializeFilter(model)), normalizeFilter(model), 'draft survives URL round trip');
  }
  assertEquals(filterConditions({ parameter: 'KSampler.seed' }).length, 1, 'Present needs only a name');
  assertEquals(filterConditions({ negativeMode: 'nonempty', positiveMode: 'nonempty' }).length, 2);
  assertEquals(compileFilter({ filename: ' ' })({ filename: 'a b.png' }), true, 'literal spaces are entered text');
});
