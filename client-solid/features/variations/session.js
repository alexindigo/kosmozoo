// Composition metadata and an owner-safe public capability only. Drafts and
// decisions belong to the mounted modal, never this bridge.
export function makeVariationSession({ read, write }) {
  let sequence = 0, owner = null;
  const outcome = (status) => Promise.resolve({ status });
  const install = (opening) => write({ open: true, ...opening, session: `variations-${++sequence}` });
  const closeOpening = () => write({ open: false, key: null, images: [], session: null });
  function request(opening, automatic = false, expectedSession) {
    const current = read();
    if (expectedSession && current.session !== expectedSession) return outcome("stale");
    if (!current.open) {
      if (opening) { install(opening); return outcome("applied"); }
      return outcome("stale");
    }
    const registration = owner;
    if (!registration || registration.session !== current.session) return outcome("stale");
    const intent = { type: opening ? "replace" : automatic ? "automatic" : "close", key: opening?.key ?? null };
    let consumed = false;
    const permit = () => {
      if (consumed || owner !== registration || read().session !== registration.session || !read().open) return { status: "stale" };
      consumed = true;
      if (opening) install(opening); else closeOpening();
      return { status: "applied" };
    };
    return registration.capability.requestLeave({ intent, permit, cancel: () => {} });
  }
  return {
    open(images, bulk) {
      const captured = images.map(({ id, host, filename, meta, origin }) => ({ id, host, filename, meta, ...(origin === undefined ? {} : { origin }) }));
      if (!captured.length) return outcome("stale");
      const key = bulk ? "batch:" + captured.map((image) => image.id).join("|") : captured[0].id;
      return request(read().open && read().key === key ? null : { images: captured, key });
    },
    close: ({ automatic = false, session } = {}) => request(null, automatic, session),
    run() {
      const current = read(), registration = owner;
      return current.open && registration?.session === current.session ? registration.capability.requestRun() : outcome("stale");
    },
    register(session, capability) {
      if (!read().open || read().session !== session) return () => {};
      const registration = { session, capability };
      owner = registration;
      return () => { if (owner === registration) owner = null; };
    },
  };
}
