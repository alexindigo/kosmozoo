import { assert, assertEquals } from 'jsr:@std/assert';
import { makeUnseenItems } from '../client-solid/store/unseen-items.js';
const p=(revision,sequence,visibleRanges)=>({revision,sequence,visibleRanges,latestVisibleSeq:visibleRanges.at(-1)?.[1]??0});
Deno.test('unseen ledger: null is not baseline, out-of-order holes survive exposure and removal',()=>{
  const owner=makeUnseenItems();owner.accept(null);assert(!owner.hasUnseen());
  owner.accept(p(1,3,[[1,3]]));owner.accept(p(2,5,[[1,5]]));
  assert(owner.isUnseen(4));assert(owner.isUnseen(5));assert(owner.acknowledge(5));assert(owner.isUnseen(4));
  owner.accept(p(3,5,[[1,3],[5,5]]));assert(!owner.hasUnseen());
  owner.accept(p(4,5,[[1,5]]));assert(owner.isUnseen(4));assert(!owner.isUnseen(5));
  assert(!owner.accept(p(2,5,[[1,5]])));assert(!owner.accept(p(4,5,[[1,3]])));
  assert(owner.acknowledge(4));assert(!owner.hasUnseen());
  assert(!makeUnseenItems().acknowledge(5));
});

Deno.test('unseen ledger: same-revision compatibility is semantic and accepted inputs cannot mutate ownership',()=>{
  const owner=makeUnseenItems();owner.accept(p(1,3,[[1,3]]));
  assert(owner.accept({visibleRanges:[[1,3]],latestVisibleSeq:3,sequence:3,revision:1}));
  const input=p(2,5,[[1,5]]);assert(owner.accept(input));
  input.visibleRanges[0][1]=3;
  assert(owner.isUnseen(5));assertEquals(owner.projection.visibleRanges,[[1,5]]);
  assert(!owner.accept(p(2,5,[[1,4]])));
});
