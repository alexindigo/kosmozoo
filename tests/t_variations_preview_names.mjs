import { assertEquals, assertThrows, assertStringIncludes } from 'jsr:@std/assert';
import { previewRecipeNaming } from '../src/features/variations/recipe-compile.mjs';
import { variationOutputName } from '../src/features/variations/shared.mjs';

Deno.test('preview naming separates unresolved transfer identity from strict filename validation', () => {
  const sample = { '43.image': '\0pending-0', '2.text': '\0pending-0' };
  const compiled = { transfers: { '43.image': ['archive-resource'] } };
  const display = previewRecipeNaming(sample, compiled);
  assertEquals(display, { '43.image': '[upload name pending]', '2.text': '\0pending-0' });
  assertEquals(sample['43.image'], '\0pending-0');
  const target = { directory: '', sourceStem: 'flux' };
  const request = { suffix: '_{43.image}' };
  const parameters = [{ id: '43.image', kind: 'image' }];
  const naming = values => variationOutputName(target, request, values, {}, {}, parameters);
  assertThrows(() => naming(sample), Error, 'control character');
  assertStringIncludes(naming(display).value, '[upload name pending]');
  const known = previewRecipeNaming({ '43.image': 'bad\nname.png' }, compiled);
  assertEquals(known['43.image'], 'bad\nname.png');
  assertThrows(() => naming(known), Error, 'control character');
});
