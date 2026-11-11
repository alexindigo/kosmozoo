// Exact source IDs belong to a Map, never a reactive object's mutation path.
import { createMemo, createSignal, batch } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { makeUnseenItems } from './unseen-items.js';

export const sameSourceIdentity = (record, source) => !!source && source.address === record.address &&
  source.incarnation === record.incarnation && source.sourceVersion?.epoch === record.epoch;

export function makeSourceRegistry({ createRecord, onRetire }) {
  const members = new Map();
  const [membership, setMembership] = createSignal(0);
  const changed = () => setMembership(value => value + 1);
  function makeRecord(id, source) {
    const [state, setState] = createStore({ host: source, activity: undefined, saving: undefined, reachability: undefined,
      arrivals: null });
    const [unseenRevision, setUnseenRevision] = createSignal(0);
    const unseen = makeUnseenItems({ changed: () => setUnseenRevision(n => n+1) });
    let inventorySequence = null;
    // Inventory owns reachability once observed; discovery cannot undo it.
    const host = createMemo(() => state.reachability === undefined ? state.host : { ...state.host, online: state.reachability });
    return { ...createRecord(id, source),
      get host() { return host(); },
      get reachability() { return state.reachability; },
      setReachability(value) { setState("reachability", value); },
      get activity() { return state.activity; },
      get arrivals() { return state.arrivals; },
      unseen,
      get inventorySequence() { return inventorySequence; },
      observeInventory(sequence) { if (Number.isSafeInteger(sequence)) inventorySequence = sequence; },
      get hasNew() { unseenRevision(); return unseen.hasUnseen(); },
      isUnseen(sequence) { unseenRevision(); return unseen.isUnseen(sequence); },
      acceptArrivals(value) {
        if (!unseen.accept(value)) return false;
        if (inventorySequence === null) inventorySequence = value.sequence;
        setState("arrivals", reconcile(value));
        return true;
      },
      get saving() { return state.saving; },
      updateHost(value) { setState("host", reconcile(value)); },
      patchHost(value) { setState("host", reconcile({ ...state.host, ...value })); },
      acceptActivity(value) { setState("activity", reconcile(value)); },
      setSaving(value) { setState("saving", value); },
    };
  }
  const view = field => createMemo(() => {
    membership();
    return Object.assign(Object.create(null), Object.fromEntries([...members].flatMap(([id, record]) => {
      const value = record[field];
      return value === undefined ? [] : [[id, value]];
    })));
  });
  const hosts = view("host"), activities = view("activity"), saving = view("saving");
  return {
    hosts, activities, saving,
    get: id => members.get(id), has: id => members.has(id),
    values: () => members.values(), [Symbol.iterator]: () => members[Symbol.iterator](),
    delete(id) {
      const record = members.get(id);
      if (!record) return false;
      members.delete(id); onRetire(record); changed(); return true;
    },
    reconcile(next) {
      batch(() => {
        let replaced = false;
        for (const [id, record] of members) {
          if (Object.hasOwn(next, id) && sameSourceIdentity(record, next[id])) continue;
          members.delete(id); onRetire(record); replaced = true;
        }
        for (const [id, value] of Object.entries(next)) {
          const record = members.get(id);
          if (record) record.updateHost(value);
          else { members.set(id, makeRecord(id, value)); replaced = true; }
        }
        if (replaced) changed();
      });
    },
  };
}
