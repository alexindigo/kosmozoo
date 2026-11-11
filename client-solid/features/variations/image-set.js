// Acquisition-independent work. Files are opaque identities, never cloned or
// deduplicated by filename. Byte comparisons are readonly, session-owned evidence.
export { imageReference, imageReferenceValue, imageIdentity, sameImage, validImageSet,
  mergeImages, uploadImage } from "/shared/features/variations/recipe-model.mjs";
