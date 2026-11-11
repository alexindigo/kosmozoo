import { assert, assertEquals } from 'jsr:@std/assert';
import { validRanges, containsSequence, insertRange, subtractRanges } from '../client/js/sequence-ranges.mjs';
Deno.test('sequence ranges: canonical validation and bounded interval arithmetic',()=>{
  assert(validRanges([[1,3],[5,8]],8));
  for(const bad of [[[0,1]],[[1,2],[3,4]],[[4,5],[1,2]],[[1,9]],[[1.1,2]],[[1]],[[2,1]]])assert(!validRanges(bad,8));
  const sparse=[];sparse.length=1;assert(!validRanges(sparse));
  assertEquals(insertRange([[1,2],[5,6]],3,4),[[1,6]]);
  assertEquals(subtractRanges([[1,1000000000000]],[[5,5],[7,999999999999]],3),[[4,4],[6,6],[1000000000000,1000000000000]]);
  assert(containsSequence([[1,3],[5,8]],6));assert(!containsSequence([[1,3],[5,8]],4));
});

Deno.test('sequence ranges: descriptor-first rejection never invokes indexed accessors', () => {
  let reads=0;
  for (const nested of [false,true]) {
    const pair=[1,2], outer=[pair], array=nested?pair:outer;
    Object.defineProperty(array,'0',{enumerable:true,configurable:true,get(){reads++;return nested?1:pair;}});
    assert(!validRanges(outer));assertEquals(reads,0);
  }
  const inherited=[];inherited.length=1;Object.setPrototypeOf(inherited,Object.assign(Object.create(Array.prototype),{0:[1,2]}));
  const extra=[[1,2]];extra.extra=true;
  const symbol=[[1,2]];symbol[Symbol('escape')]=true;
  const prototype=[[1,2]];Object.setPrototypeOf(prototype,Object.create(Array.prototype));
  for(const bad of [inherited,extra,symbol,prototype])assert(!validRanges(bad));
});
