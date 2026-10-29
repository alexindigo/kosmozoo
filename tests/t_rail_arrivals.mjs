import { assertEquals } from "jsr:@std/assert";
import { makeRailArrivals } from "../client-solid/store/rail-arrivals.js";

const publish = (owner, ids) => { owner.stage(ids); owner.resolve(ids, new Set(ids)); };

Deno.test("rail arrivals: one consumer takes all identities, including off-tape; remount cannot replay", () => {
  const owner = makeRailArrivals();
  publish(owner, ["a", "off-tape"]);
  const first = owner.event();
  publish(owner, ["a", "b"]);
  assertEquals(owner.take(first), [], "superseded event cannot drain newer work");
  const event = owner.event();
  assertEquals(owner.take(event), ["a", "off-tape", "b"]);
  assertEquals(owner.take(event), [], "new consumers cannot replay a taken event");
  publish(owner, ["a"]);
  assertEquals(owner.take(owner.event()), ["a"], "a distinct event can light the same identity");
});

Deno.test("rail arrivals: navigation retires pending events and invalidates old tickets", () => {
  const owner = makeRailArrivals();
  publish(owner, ["a"]);
  const old = owner.event();
  owner.retire();
  publish(owner, ["a"]);
  assertEquals(owner.take(old), []);
  assertEquals(owner.event().epoch, old.epoch + 1);
  assertEquals(owner.take({ ...owner.event() }), [], "tickets are owner-issued identities");
  assertEquals(owner.take(owner.event()), ["a"]);
});

Deno.test("rail arrivals: size-pending identities wait for admission; ready off-tape identities and removed entries cannot replay", () => {
  const owner = makeRailArrivals();
  owner.stage(["known", "measuring", "removed"]);
  owner.resolve(["known"], new Set(["known", "measuring"]));
  assertEquals(owner.take(owner.event()), ["known"]);
  assertEquals(owner.waiting(), ["measuring"]);
  owner.resolve(["measuring"], new Set(["known", "measuring"]));
  assertEquals(owner.take(owner.event()), ["measuring"]);
  assertEquals(owner.waiting(), []);
  assertEquals(owner.take(owner.event()), []);
  owner.stage(["unfinished"]);
  owner.retire();
  assertEquals(owner.waiting(), []);
});
