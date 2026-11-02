import { assertEquals } from 'jsr:@std/assert';
import { matchesFieldFilter } from '../client-solid/features/variations/field-filter.js';

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
Deno.test('field filter rejects absent text and does not match hidden identity or values', () => {
  assertEquals(matchesFieldFilter({ title: 'Friendly name', type: 'HiddenClass', input: 'steps', label: 'identity', current: 'special' }, 'hiddenclass'), false);
  assertEquals(matchesFieldFilter({ title: 'Friendly name', input: 'steps' }, 'missing'), false);
  assertEquals(matchesFieldFilter({ type: 'KSampler', key: 'steps' }, 'ksampler.steps'), true);
});
