import { For, Show } from "solid-js";

// Input-only annotation, in exactly the allocation/pixel mapping of its image.
// Pointer-transparent: the shared stage gesture owner handles hit-testing.
export function FaceFeedback(props) {
  const record = () => props.ports.feedbackRecord(props.accepted);
  const g = () => props.geometry;
  return <Show when={record() && g()}><svg class="face-feedback" aria-label={`Selected faces on image ${props.side.toUpperCase()}`}
    viewBox={`0 0 ${g().geometry.width} ${g().geometry.height}`} data-record={record().id}>
    <For each={record().faces}>{face => {
      const box = () => { const [x, y] = g().forward(face.bbox); return { x, y, w: (face.bbox[2] - face.bbox[0]) * g().q, h: (face.bbox[3] - face.bbox[1]) * g().q }; };
      return <g class="face-selected" classList={{ "is-anchor": record().anchor === face.id }} data-face={face.id} data-selected="true">
        <rect x={box().x} y={box().y} width={box().w} height={box().h} />
        <Show when={record().anchor === face.id && face.eyes}><For each={[face.eyes?.left, face.eyes?.right]}>{point =>
          <circle class="face-eye" cx={g().forward(point)[0]} cy={g().forward(point)[1]} r="3" />
        }</For></Show>
      </g>;
    }}</For>
  </svg></Show>;
}
