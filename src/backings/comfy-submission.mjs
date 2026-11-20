// The address binding owns this lane. Admission/claim precedes transport; only
// the transport's body-written signal releases the next send, never a timer.
import http from "node:http";
import { Buffer } from "node:buffer";

export function promptRequest(url, body, { signal, onSent = () => {} } = {}) {
  let sentResolve, resultResolve, finished = false;
  const sent = new Promise(resolve => { sentResolve = resolve; });
  const result = new Promise(resolve => { resultResolve = resolve; });
  const request = http.request(url, { method: "POST", signal, agent: false,
    headers: { "Content-Type": "application/json", "Content-Length": new TextEncoder().encode(body).length } }, response => {
    const chunks = [];
    response.on("data", chunk => chunks.push(chunk));
    response.on("error", reject);
    response.on("end", () => {
      const bytes = [204, 205, 304].includes(response.statusCode) ? null : Buffer.concat(chunks);
      resultResolve({ response: new Response(bytes, { status: response.statusCode }), sent: finished });
    });
  });
  function reject(error) { sentResolve(false); resultResolve({ error, sent: finished }); }
  request.on("error", reject);
  request.once("finish", () => {
    finished = true;
    try { onSent(); sentResolve(true); }
    catch (error) { request.destroy(error); reject(error); }
  });
  request.end(body);
  return { sent, result };
}

export function makePromptLane(send, { signal } = {}) {
  let tail = Promise.resolve();
  return {
    submit(job, { beforeSend = () => {}, onSent, isCurrent = () => true } = {}) {
      let release;
      const previous = tail;
      const sent = new Promise(resolve => { release = resolve; });
      tail = sent;
      const result = (async () => {
        await previous;
        if (signal?.aborted || !isCurrent()) throw signal?.reason ?? new Error("Run destination changed; unsent jobs were kept");
        await beforeSend();
        if (signal?.aborted || !isCurrent()) throw signal?.reason ?? new Error("Run destination changed; unsent jobs were kept");
        const request = send(job, { signal, onSent });
        request.sent.then(release, () => release(false));
        return await request.result;
      })().finally(() => release(false));
      // Every caller gets both lifetimes: send ordering and terminal evidence.
      return { sent, result };
    },
  };
}

// Injected non-network backings retain their explicit enqueue port. They have
// no body-written evidence, so their next send waits for terminal completion.
export function submitPrompt(backing, job, ports = {}) {
  if (backing.submit) return backing.submit(job, ports);
  const result = Promise.resolve().then(async () => {
    if (ports.isCurrent && !ports.isCurrent()) throw new Error("Run destination changed; unsent jobs were kept");
    await ports.beforeSend?.();
    const result = await backing.enqueue(job);
    return result;
  });
  return { sent: result.then(() => false, () => false), result };
}
