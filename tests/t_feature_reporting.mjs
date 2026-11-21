import { assertEquals } from 'jsr:@std/assert';
import { createRoot } from 'solid-js';
import { makeAppStore } from '../client-solid/store/app-store.js';

Deno.test('installed features report through the shared status owner and retire with Store', () => {
  let disposeRoot, report;
  const store = createRoot(dispose => {
    disposeRoot = dispose;
    return makeAppStore({ storage: { getItem() { return null; }, setItem() {} } });
  });
  try {
    store.actions.features.register({ name: 'reporting-fixture', install(ports) {
      assertEquals(Object.hasOwn(ports, 'actions'), false);
      report = ports.reportError;
      return { dispose() { report?.('retired cleanup'); } };
    } });
    report('saved Run has an uncertain result');
    assertEquals(store.state.chips.map(({ kind, msg }) => ({ kind, msg })), [
      { kind: 'error', msg: 'saved Run has an uncertain result' },
    ]);
    store.dispose();
    report('late saved Run result');
    assertEquals(store.state.chips.map(c => c.msg), ['saved Run has an uncertain result']);
  } finally {
    store.dispose();
    disposeRoot();
  }
});
