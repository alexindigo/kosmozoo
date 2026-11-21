import { For } from "solid-js";
import { problemPresentation } from "./problem-presentation.js";
import { problemText } from "/shared/features/variations/problems.mjs";
// All field/tile/history consumers share this contract presentation.
export function ProblemFeedback(props) {
  return <For each={problemPresentation(props.problems).problems}>{problem =>
    <p class={problem.severity === "error" ? "vz-readiness-error" : "vz-field-help"} role="status" data-problem-code={problem.code}>{problemText(problem)}</p>
  }</For>;
}
