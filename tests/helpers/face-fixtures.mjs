export function face(x = 100, y = 100, span = 40, score = .9) {
  const kps = Array.from({ length: 28 }, () => [x, y, 1]);
  for (let i = 11; i < 17; i++) kps[i] = [x - span / 2, y, 1];
  for (let i = 17; i < 23; i++) kps[i] = [x + span / 2, y, 1];
  return { bbox: [x - span, y - span, x + span, y + span], score, kps };
}
export const resource = (name = "a.png", source = "fake", stamp = "origin-1") => ({ source,
  collection: source.startsWith("input:") ? source.slice(6) : source, kind: source.startsWith("input:") ? "input" : "output",
  name, src: `/bytes/${source}/${name}`, stamp, session: 1 });
export const result = (faces = [face()], hash = "a".repeat(64)) => ({ w: 512, h: 512, faces,
  image: { hash }, detector: { serviceUrl: "http://detector", model: "anime-face-detector" } });
export const turn = () => new Promise(resolve => setTimeout(resolve, 0));
