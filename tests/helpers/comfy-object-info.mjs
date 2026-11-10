// Production-shaped ComfyUI object_info declarations shared by fake backings,
// editor rigs and contract tests. Shapes follow upstream nodes.py LoadImage/
// LoadImageOutput and comfy_api/latest/_io.py Autogrow serialization, so resource
// listings and dynamic templates are never silently omitted from a fixture.

// LoadImage publishes the input folder's current listing with upload semantics.
export const loadImage = (files = []) => ({ input: { required: { image: [[...files].sort(), { image_upload: true }] } },
  output: ["IMAGE", "MASK"], output_name: ["IMAGE", "MASK"], output_is_list: [false, false], category: "image" });

// LoadImageOutput lists the output folder through a remote route.
export const loadImageOutput = () => ({ input: { required: { image: ["COMBO", { image_upload: true, image_folder: "output",
  remote: { route: "/internal/files/output", refresh_button: true, control_after_refresh: "first" } }] } },
  output: ["IMAGE", "MASK"], output_name: ["IMAGE", "MASK"], output_is_list: [false, false], category: "image" });

// Autogrow prefix form: "images.image0" .. "images.image<max-1>".
export const batchImagesNode = (max = 50) => ({ input: { required: { images: ["COMFY_AUTOGROW_V3",
  { template: { input: { required: { image: ["IMAGE", {}] } }, prefix: "image", min: 1, max } }] } },
  output: ["IMAGE"], output_name: ["IMAGE"], output_is_list: [false], category: "image/batch" });

// Autogrow named form with min 0: every child is optional.
export const textEncodeQwenImage21 = () => ({ input: { required: { clip: ["CLIP", {}], prompt: ["STRING", { multiline: true, dynamicPrompts: true }],
  images: ["COMFY_AUTOGROW_V3", { template: { input: { required: { image: ["IMAGE", {}] } },
    names: Array.from({ length: 16 }, (_, index) => `image_${index + 1}`), min: 0 } }] } },
  output: ["CONDITIONING"], output_name: ["CONDITIONING"], output_is_list: [false], category: "advanced/conditioning" });

export const checkpointLoader = (names = ["model.safetensors"]) => ({ input: { required: { ckpt_name: [[...names], {}] } },
  output: ["MODEL", "CLIP", "VAE"], output_name: ["MODEL", "CLIP", "VAE"], output_is_list: [false, false, false], category: "loaders" });

export const saveImage = () => ({ output_node: true, input: { required: { images: ["IMAGE", {}], filename_prefix: ["STRING", { default: "ComfyUI" }] } },
  output: [], category: "image" });
