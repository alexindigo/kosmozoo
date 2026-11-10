import { assertEquals } from 'jsr:@std/assert';
import { matchesFieldFilter, cataloguePresentation, parameterInputName, connectionPresentation } from '../client-solid/features/variations/field-filter.js';

Deno.test('field filter matches the displayed ComfyUI title', () => {
  assertEquals(matchesFieldFilter({ title: 'Custom sampler', type: 'KSampler', input: 'steps' }, 'sampler'), true);
});
Deno.test('field filter matches raw input names across row kinds', () => {
  for (const row of [{ input: 'noise_seed' }, { key: 'sampler_name' }, { key: 'prompt' }, { input: 'image' }]) {
    assertEquals(matchesFieldFilter(row, row.input ?? row.key), true);
  }
});
Deno.test('field filter ignores case and surrounding query whitespace', () => {
  assertEquals(matchesFieldFilter({ title: 'Load Image', input: 'image' }, '  LOAD iMaGe  '), true);
});
Deno.test('empty field filter includes every row', () => {
  assertEquals(matchesFieldFilter({}, ''), true);
  assertEquals(matchesFieldFilter({}, '   '), true);
});
Deno.test('field filter matches full identity but not current values', () => {
  assertEquals(matchesFieldFilter({ title: 'Friendly name', type: 'HiddenClass', input: 'steps', label: 'identity', current: 'special' }, 'hiddenclass'), true);
  assertEquals(matchesFieldFilter({ title: 'Friendly name', input: 'steps', current: 'special' }, 'special'), false);
  assertEquals(matchesFieldFilter({ title: 'Friendly name', input: 'steps' }, 'missing'), false);
  assertEquals(matchesFieldFilter({ type: 'KSampler', key: 'steps' }, 'ksampler.steps'), true);
});

Deno.test('catalogue presentation keeps complete identities in section and node hierarchy', () => {
  const row = (id, domain, key, node = '1') => ({ id, domain, key, title: 'Repeated', type: 'Custom', nodeIds: [node] });
  const rows = [row('json', 'candidates', 'arbitrary'), row('steps', 'numeric', 'steps'), row('text', 'texts', 'text'),
    row('image', 'images', 'image'), row('strength', 'numeric', 'model_strength'), row('other', 'numeric', 'custom'),
    row('duplicate', 'texts', 'text', '2')];
  const groups = cataloguePresentation(rows);
  assertEquals(groups.map(group => group.name), ['Images', 'Text', 'Adjustments', 'Other inputs']);
  assertEquals(groups[1].nodes.map(node => node.label), ['Repeated #1', 'Repeated #2']);
  assertEquals(groups[2].nodes[0].ids, ['strength', 'steps', 'other']);
  assertEquals(groups.flatMap(group => group.nodes.flatMap(node => node.ids)).sort(), rows.map(row => row.id).sort());
  assertEquals(parameterInputName(rows[0]), 'arbitrary');
  assertEquals(matchesFieldFilter(rows[6], '#2'), true);
});

Deno.test('connection presentation omits incompatible known ports and preserves unknown ports', () => {
  const parameter = { id: 'sink.image', nodeIds: ['sink'], type: 'Sink', key: 'image', valueKind: 'connection',
    schema: { status: 'known', type: 'IMAGE' } };
  const nodes = [{ id: 'sink', type: 'Sink', outputs: [] }, { id: 'source', title: 'Source', type: 'Source',
    outputs: [{ name: 'Picture', type: 'IMAGE' }, { name: 'Clip', type: 'CLIP' }] }, { id: 'unknown', type: 'Custom', outputs: null }];
  assertEquals(connectionPresentation(parameter, nodes).map(node => ({ id: node.id, label: node.label, outputs: node.outputs })), [
    { id: 'source', label: 'Source #source', outputs: [{ slot: '0', label: 'Picture (0)' }] },
    { id: 'unknown', label: 'Custom #unknown', outputs: null }]);
});
