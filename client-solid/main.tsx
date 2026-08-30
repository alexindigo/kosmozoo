// client-solid/main.tsx — phase 0 runtime spike. Proves the toolchain end to
// end: babel-preset-solid output + vendored solid-js dists, in a real browser.
// A signal counter (fine-grained text update) and a <Show> toggle (conditional
// mount/unmount) — the two primitives every later phase builds on.
import { createSignal } from "solid-js";
import { render, Show } from "solid-js/web";

function App() {
  const [count, setCount] = createSignal(0);
  const [on, setOn] = createSignal(false);
  return (
    <div id="spike">
      <button id="inc" onClick={() => setCount(count() + 1)}>increment</button>
      <p id="count">{count()}</p>
      <button id="toggle" onClick={() => setOn(!on())}>toggle</button>
      <Show when={on()}>
        <div id="shown">shown</div>
      </Show>
    </div>
  );
}

render(() => <App />, document.getElementById("app"));
