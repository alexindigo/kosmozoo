import { dependencyClosure, validateGraphLinks } from "./graph.mjs";

const object = value => value && typeof value === "object" && !Array.isArray(value);
const counter = data => Number.isFinite(data?.value) && data.value >= 0 && Number.isFinite(data?.max) && data.max > 0
  ? { value: data.value, max: data.max, fraction: Math.max(0, Math.min(1, data.value / data.max)) } : null;

// Ephemeral enrichment only. Queue/history still own prompt and completion.
// At most one latest state frame and one current-operation counter are retained.
export class WorkflowProgress {
  prompt = null;
  graph = null;
  nodes = null;
  info = null;
  frame = null;
  exact = null;
  highWater = 0;

  configure(prompt, descriptor) {
    if (prompt !== this.prompt) {
      this.prompt = prompt; this.graph = null; this.nodes = null; this.highWater = 0;
      if (this.frame?.prompt_id !== prompt) this.frame = null;
      if (this.exact?.promptId !== prompt) this.exact = null;
    }
    if (!prompt || this.graph || !object(descriptor?.graph) || !Array.isArray(descriptor.outputs) || !descriptor.outputs.length) return;
    try {
      validateGraphLinks(descriptor.graph);
      const nodes = dependencyClosure(descriptor.graph, descriptor.outputs);
      if ([...nodes].some(id => !object(descriptor.graph[id]) || typeof descriptor.graph[id].class_type !== "string")) return;
      this.graph = descriptor.graph; this.nodes = nodes;
    } catch { /* Incomplete optional queue data is never an empty workflow. */ }
  }

  receive({ type, data } = {}) {
    if (!object(data) || typeof data.prompt_id !== "string") return;
    if (type === "progress_state" && object(data.nodes)) {
      if (Object.values(data.nodes).some(n => !object(n) || !["running", "finished", "error"].includes(n.state) || !counter(n))) return;
      this.frame = data;
      if (this.exact && (this.exact.promptId !== data.prompt_id || data.nodes[this.exact.node]?.state !== "running")) this.exact = null;
    } else if (type === "progress" && typeof data.node === "string" && counter(data)) {
      this.exact = { promptId: data.prompt_id, node: data.node, ...counter(data) };
    } else if (["execution_error", "execution_interrupted"].includes(type)) {
      if (this.frame?.prompt_id === data.prompt_id) this.frame = null;
      if (this.exact?.promptId === data.prompt_id) this.exact = null;
    }
  }

  disconnect(prompt = null) {
    if (!prompt || this.frame?.prompt_id === prompt) this.frame = null;
    if (!prompt || this.exact?.promptId === prompt) this.exact = null;
  }

  operation() {
    if (!this.prompt || this.exact?.promptId !== this.prompt) return null;
    const { value, max, fraction } = this.exact;
    return { value, max, fraction };
  }

  workflow() {
    if (!this.prompt || !this.nodes?.size || !this.info?.lazyInputs || this.frame?.prompt_id !== this.prompt) return null;
    if ([...this.nodes].some(id => !this.info.lazyInputs.has(this.graph[id].class_type))) return null;
    const observed = Object.entries(this.frame.nodes).filter(([id, n]) => this.nodes.has(id) && ["running", "finished"].includes(n.state));
    if (!observed.length) return null;
    const done = new Set(observed.filter(([, n]) => n.state === "finished").map(([id]) => id));
    for (const [id] of observed) {
      const ancestors = dependencyClosure(this.graph, id, (node, key) => !this.info.lazyInputs.get(node.class_type)?.has(key));
      ancestors.delete(id);
      for (const ancestor of ancestors) if (this.nodes.has(ancestor)) done.add(ancestor);
    }
    // ComfyUI can have async nodes running together. Their fractional work is
    // independent; each contributes at most one node and never double-counts done.
    const partial = observed.reduce((sum, [id, n]) => sum + (n.state === "running" && !done.has(id) ? counter(n).fraction : 0), 0);
    const total = this.nodes.size;
    this.highWater = Math.max(this.highWater, Math.min(total * (1 - Number.EPSILON), done.size + partial));
    return { promptId: this.prompt, done: this.highWater, total, fraction: this.highWater / total, basis: "graph+events" };
  }
}

// Read-only socket lifetime, one per address. No previews are decoded or stored;
// no client messages (including feature negotiation) are ever sent.
export class ProgressConnection {
  constructor({ open, receive, lost, setTimer = setTimeout, clearTimer = clearTimeout }) {
    Object.assign(this, { open, receive, lost, setTimer, clearTimer });
    this.stopped = false; this.failures = 0; this.socket = null; this.timer = null; this.deadline = null;
    this.connect();
  }

  connect() {
    if (this.stopped || this.socket) return;
    let socket;
    try { socket = this.open(); } catch { this.retry(); return; }
    this.socket = socket;
    this.closed = new Promise(resolve => {
      socket.onclose = () => {
        resolve();
        if (this.socket !== socket) return;
        this.clearTimer(this.deadline); this.socket = null;
        if (!this.stopped) { this.lost(); this.retry(); }
      };
    });
    this.deadline = this.setTimer(() => { if (this.socket === socket) socket.close(); }, 10_000);
    socket.onopen = () => { this.clearTimer(this.deadline); this.failures = 0; };
    socket.onerror = () => { if (this.socket === socket) socket.close(); };
    socket.onmessage = event => {
      if (this.stopped || this.socket !== socket || typeof event.data !== "string" || event.data.length > 1024 * 1024) return;
      try { this.receive(JSON.parse(event.data)); } catch { /* Unsupported/malformed optional telemetry. */ }
    };
  }

  retry() {
    if (this.stopped) return;
    this.timer = this.setTimer(() => { this.timer = null; this.connect(); }, Math.min(1000 * 2 ** this.failures++, 30_000));
  }

  stop() {
    this.stopped = true;
    this.clearTimer(this.timer); this.clearTimer(this.deadline);
    this.socket?.close();
    return this.closed;
  }
}
