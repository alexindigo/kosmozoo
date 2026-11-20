// One exact, multi-paragraph value shared by extraction and browser regressions.
export const fullTextEnding = "The final sentence survives extraction and is readable in Details.";
const start = "  First paragraph with deliberate surrounding whitespace.\n\n";
const end = `\n\n${fullTextEnding}\n  `;
export const fullTextPrompt = start + "Middle paragraph: keep every word.\n\n".repeat(300)
  .slice(0, 10_000 - start.length - end.length) + end;
export const fullTextGraph = {
  "1": { class_type: "CLIPTextEncode", inputs: { text: fullTextPrompt } },
  "2": { class_type: "SaveImage", inputs: { filename_prefix: "full-text" } },
};
