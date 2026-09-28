// plugins/export/client.js — the export plugin's client half: a bucket strip
// in the lightbox. Six buckets, three tags; character is the default (stored
// absent). The consumer exists before input ergonomics get polished — bucket
// adoption was 0/61 because there was no consumer.

export function register(client) {
  client.composition?.("export-strip", { label: "Export" }); // surfaces in mode list
  client.toolbar?.({
    id: "export",
    label: "Export",
    // buckets/tags are rendered by the host workbench from the plugin's
    // advertised capability (GET /api/plugins lists them)
  });
}
