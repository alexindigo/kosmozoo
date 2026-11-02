// Native error evidence is retained at the display owner, never guessed from
// extensions or a failed size measurement. Shared by every MediaBox consumer.
export function mediaFailure(kind, code) {
  if (kind === "image" && code === "decode") return "This image can't be decoded.";
  if ((kind === "video" || kind === "audio") && (code === 3 || code === 4)) {
    return `Your browser can't play this ${kind} format.`;
  }
  return "Can't display this file.";
}
