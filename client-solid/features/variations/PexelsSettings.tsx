import { createSignal, createUniqueId, onMount, For, Show } from "solid-js";
import { IconButton } from "../../components/IconButton.js";
import { TextField } from "../../components/TextField.js";
import { SingleLineText } from "../../components/SingleLineText.js";
import { iconSvg } from "/js/icons.mjs";

// Settings row for Pexels-compatible services. The injected owner holds the
// redacted list and mutations; this view keeps only the unsaved form.
// Saved keys are never shown: the form says whether one is kept or removed.
export function PexelsSettings(props) {
  const owner = () => props.ports.pexels;
  const state = () => owner().state();
  const uid = `pexels-${createUniqueId().replace(/[^\w-]/g, "")}`;
  const [draft, setDraft] = createSignal(null), [removing, setRemoving] = createSignal(null);
  const [busy, setBusy] = createSignal(false), [message, setMessage] = createSignal("");
  let nameField;
  onMount(() => { owner().load(true); });

  const edit = service => {
    setRemoving(null); setMessage("");
    setDraft(service ? { id: service.id, name: service.name, url: service.url, key: "", hasKey: service.hasKey, clearKey: false }
      : { id: null, name: "", url: "", key: "", hasKey: false, clearKey: false });
    queueMicrotask(() => nameField?.focus());
  };
  const change = patch => setDraft(value => ({ ...value, ...patch }));
  const save = async () => {
    const value = draft();
    if (!value || busy()) return;
    const details = { name: value.name, url: value.url,
      ...(value.clearKey ? { key: null } : value.key.trim() ? { key: value.key } : {}) };
    setBusy(true); setMessage("");
    const result = value.id ? await owner().update(value.id, details) : await owner().create(details);
    setBusy(false);
    if (!result.ok) { setMessage(result.error); return; }
    setDraft(null); setMessage(`${result.service.name} saved`);
  };
  const remove = async service => {
    setBusy(true); setMessage("");
    const result = await owner().remove(service.id);
    setBusy(false); setRemoving(null);
    if (draft()?.id === service.id) setDraft(null);
    setMessage(result.ok ? `${service.name} removed` : result.error);
  };
  const keyPlaceholder = () => draft().clearKey ? "Saved key will be removed" : draft().hasKey ? "Saved key is kept" : "Optional";

  return <Show when={props.matches("pexels photos stock images service api key")}>
    <section class="pexels-settings" aria-labelledby={`${uid}-title`}>
      <div class="pexels-settings-head">
        <SingleLineText id={`${uid}-title`} class="pexels-settings-title" value="Pexels services" />
        <Show when={!draft() && !busy()}>
          <IconButton chrome size="sm" variant="plain" icon={iconSvg("plus", 14)} title="Add Pexels service" onAction={() => edit(null)} />
        </Show>
      </div>
      <Show when={state().error}>
        <div class="pexels-settings-error">
          <SingleLineText role="status" value="Couldn't read Pexels services." hint={state().error} />
          <button type="button" class="btn" onClick={() => owner().load(true)}>Retry</button>
        </div>
      </Show>
      <Show when={state().services.length}>
        <ul class="pexels-services">
          <For each={state().services}>{service =>
            <li class="pexels-service" classList={{ "is-editing": draft()?.id === service.id }}>
              <Show when={removing() === service.id} fallback={<>
                <button type="button" class="pexels-service-open" title={`Edit ${service.name}`} onClick={() => edit(service)}>
                  <SingleLineText class="pexels-service-name" value={service.name} />
                  <SingleLineText class="pexels-service-url" value={service.url} />
                </button>
                <Show when={service.hasKey}><span class="pexels-service-key" role="img" aria-label="API key saved" title="API key saved" innerHTML={iconSvg("lock", 12)} /></Show>
                <Show when={!busy()}>
                  <IconButton chrome size="sm" variant="plain" icon={iconSvg("x", 14)} title={`Remove ${service.name}`} onAction={() => { setMessage(""); setRemoving(service.id); }} />
                </Show>
              </>}>
                <div class="pexels-service-confirm">
                  <SingleLineText value={`Remove ${service.name}?`} />
                  <Show when={!busy()} fallback={<SingleLineText role="status" value="Removing..." />}>
                    <button type="button" class="btn pexels-remove" onClick={() => remove(service)}>Remove</button>
                    <button type="button" class="btn" onClick={() => setRemoving(null)}>Keep</button>
                  </Show>
                </div>
              </Show>
            </li>
          }</For>
        </ul>
      </Show>
      <Show when={state().loaded && !state().services.length && !draft()}>
        <p class="pexels-settings-empty">Add a service to pick its photos in Variations.</p>
      </Show>
      <Show when={draft()}>
        <form class="pexels-form" onSubmit={event => { event.preventDefault(); save(); }}>
          <label for={`${uid}-name`}>Name</label>
          <TextField ref={nameField} id={`${uid}-name`} size="sm" type="text" autocomplete="off" placeholder="Pexels" value={draft().name}
            onInput={event => change({ name: event.currentTarget.value })} />
          <label for={`${uid}-url`}>URL</label>
          <TextField id={`${uid}-url`} size="sm" type="url" autocomplete="off" spellcheck={false} placeholder="https://api.pexels.com" value={draft().url}
            onInput={event => change({ url: event.currentTarget.value })} />
          <label for={`${uid}-key`}>API key</label>
          <TextField id={`${uid}-key`} size="sm" type="password" autocomplete="off" placeholder={keyPlaceholder()} value={draft().key}
            onInput={event => change({ key: event.currentTarget.value, clearKey: false })} />
          <div class="pexels-form-actions">
            <Show when={!busy()} fallback={<SingleLineText role="status" value="Saving..." />}>
              <Show when={draft().hasKey}>
                <button type="button" class="btn" onClick={() => change({ clearKey: !draft().clearKey, key: "" })}>{draft().clearKey ? "Keep saved key" : "Remove saved key"}</button>
              </Show>
              <button type="button" class="btn" onClick={() => { setDraft(null); setMessage(""); }}>Cancel</button>
              <button type="submit" class="btn">{draft().id ? "Save" : "Add service"}</button>
            </Show>
          </div>
        </form>
      </Show>
      <Show when={message()}><SingleLineText class="pexels-settings-message" role="status" value={message()} /></Show>
    </section>
  </Show>;
}
