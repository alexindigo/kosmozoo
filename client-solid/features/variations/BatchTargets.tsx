import { For, Show } from "solid-js";
import { iconSvg } from "/js/icons.mjs";
import { IconButton } from "../../components/IconButton.js";
import { SingleLineText } from "../../components/SingleLineText.js";
import { fmtGenerationTime } from "../../store/fields.js";
import { Thumbnail } from "./Thumbnail.js";

// A presentation of the editor's actual Run cohort, not gallery selection or
// Load Image candidates. All resources and actions are injected by its owner.
export function BatchTargets(props) {
  return <Show when={props.targets.length > 1 || props.showProblem && props.targets.some(target => props.problem?.(target.id) || props.outcome?.(target.id))}>
    <section class="vz-batch" aria-label="Images in this batch">
      <SingleLineText class="vz-batch-label" value={`Batch images (${props.targets.length})`} />
      <div class="vz-batch-list" tabindex="0" aria-label="Batch images">
        <For each={props.targets}>{target => <article class="vz-batch-item" classList={{ "vz-batch-problem": !!props.problem?.(target.id) || props.outcome?.(target.id)?.state === "issue" }} data-target-id={target.id}>
          <Thumbnail class="vz-batch-thumbnail" src={props.thumbnail(target)} name={target.filename}
            lazy register={props.registerThumbnail} rememberFocus={props.rememberFocus} />
          <div class="vz-batch-info">
            <SingleLineText class="vz-batch-name" value={target.filename} hint={`${target.host}: ${target.filename}`} />
            <SingleLineText class="vz-batch-time" value={`Generation time: ${fmtGenerationTime(props.generationTime(target.id))}`} />
            <Show when={props.problem?.(target.id) && !(props.outcome?.(target.id)?.state === "issue" && props.outcome(target.id).message === props.problem(target.id).message) && props.problem(target.id)}>
              {problem => <SingleLineText class="vz-batch-issue" value={problem().message} hint={problem().message} />}
            </Show>
            <Show when={props.outcome?.(target.id)}>{outcome => <div class="vz-batch-outcome" classList={{ "vz-batch-queued": outcome().state === "queued", "vz-batch-issue": outcome().state === "issue" }}>
              <SingleLineText value={outcome().state === "queued" ? outcome().message : `Issue: ${outcome().message}`} hint={`Captured setup: ${outcome().message}`} />
            </div>}</Show>
          </div>
          <Show when={props.removable}><IconButton chrome size="sm" variant="plain vz-batch-remove"
            icon={iconSvg("x")} title={`Remove ${target.filename} from batch`}
            onAction={() => props.onRemove(target.id)} /></Show>
        </article>}</For>
      </div>
    </section>
  </Show>;
}
