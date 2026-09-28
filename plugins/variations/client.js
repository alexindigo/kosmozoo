// plugins/variations/client.js — the variations plugin's client half.
//
// The panel UI lives in client/js/variations.mjs (tightly coupled to the
// card DOM). This file registers the plugin's client-side presence so the
// plugin host knows it has a client half.

export function register(kz) {
  // No client-side registrations needed — the variations panel is wired
  // directly into card.mjs. This file exists so the plugin host reports
  // hasClient: true.
}
