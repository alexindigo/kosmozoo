import { req } from "/js/api.mjs";
import { decodeDetectionResult } from "/shared/detection-result.mjs";
import { isContentHash } from "/shared/content-hash.mjs";

export const settings = signal => req("GET", "/api/settings/plugins.detector", undefined, { signal });
export const discovery = signal => req("GET", "/api/plugins", undefined, { signal });
export const status = signal => req("GET", "/api/plugins/detector/status", undefined, { signal });
export const saveSettings = serviceUrl => req("PATCH", "/api/settings/plugins.detector", { serviceUrl });

export async function detect(resource, signal) {
  let body, raw = false;
  if (resource.source === "anchor") {
    const response = await fetch(resource.src, { signal });
    if (!response.ok) throw new Error("Cannot read anchor bytes");
    body = await response.arrayBuffer(); raw = true;
  } else body = { collection: resource.collection, name: resource.name, kind: resource.kind,
    ...(resource.hash ? { expectedHash: resource.hash } : {}) };
  const envelope = await req("POST", "/api/plugins/detector/detect", body, { signal, raw });
  const result = decodeDetectionResult(envelope);
  if (!isContentHash(envelope.image?.hash) || typeof envelope.detector?.serviceUrl !== "string" ||
      !(envelope.detector.model === null || typeof envelope.detector.model === "string")) throw new Error("Detector response lacks content identity");
  if (!raw && (envelope.image.collection !== body.collection || envelope.image.name !== body.name || envelope.image.kind !== body.kind))
    throw new Error("Detector response names a different resource");
  return { ...result, image: { ...envelope.image }, detector: { ...envelope.detector } };
}
