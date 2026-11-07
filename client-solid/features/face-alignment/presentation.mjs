// Stateless projection into the existing decode-guarded display owner.
export function facePresentation(resource, record, active) {
  const ordinary = { ...resource, resource, hash: undefined };
  if (!active) return ordinary;
  // Canonical content knowledge precedes ML readiness. Never re-admit cached
  // named pixels while waiting for the current content's detection record.
  const hash = resource.hash ?? record?.image.hash;
  if (!hash) return ordinary;
  return { ...resource, resource: { ...resource, hash },
    src: resource.source === "anchor" ? resource.src : `/api/content/${hash}/bytes`,
    hash, ...(record?.image.hash === hash ? { recordId: record.id } : {}) };
}
