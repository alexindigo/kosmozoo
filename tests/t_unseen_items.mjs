import { assert, assertEquals } from 'jsr:@std/assert';
import { makeUnseenItems } from '../client-solid/store/unseen-items.js';
import { validItemArrivals } from '../client/js/source-events.mjs';
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

Deno.test('unseen attention: judgment eligibility never acknowledges hidden arrivals',()=>{
  const owner=makeUnseenItems();owner.accept(p(1,1,[[1,1]]));
  const frame={...p(2,3,[[1,3]]),downVotedRanges:[[2,2]],upVotedRanges:[[3,3]]};
  assert(owner.accept(frame));
  assertEquals(owner.attention({hideUp:true}),[]);
  assert(owner.isUnseen(2));assert(owner.isUnseen(3));
  assertEquals(owner.attention(),[[3,3]]);
  assertEquals(owner.attention({revealThumbedDown:true}),[[2,3]]);
  assertEquals(owner.attention({downvoteHides:false}),[[2,3]]);
  assert(owner.acknowledge(3));assertEquals(owner.attention(),[]);
  assertEquals(owner.attention({revealThumbedDown:true}),[[2,2]]);
  assert(!owner.accept({...frame,downVotedRanges:[]}),'same revision cannot change votes');
  assert(owner.accept({...frame,revision:3,downVotedRanges:[],upVotedRanges:[[2,3]]}));
  assertEquals(owner.attention(),[[2,2]],'up-voting restores still-unseen attention');
  assert(owner.acknowledge(2));assertEquals(owner.attention({downvoteHides:false}),[]);
});

Deno.test('unseen vote facts: reject malformed, foreign and overlapping membership atomically',()=>{
  const frame={...p(2,5,[[1,2],[4,5]]),downVotedRanges:[[2,2]],upVotedRanges:[[4,4]]};
  assert(validItemArrivals(frame));
  for(const patch of [{downVotedRanges:[[3,3]]},{downVotedRanges:[[6,6]]},{upVotedRanges:[[2,2]]},
    {downVotedRanges:[[1,1],[2,2]]},{downVotedRanges:undefined}]){
    assert(!validItemArrivals({...frame,...patch}));
  }
});
