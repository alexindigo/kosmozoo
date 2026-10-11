// Whitelisted ephemeral presentation, shared by native launcher and Store boot.
const notices = Object.freeze({
  "no-browser": "App windows are unavailable because no supported installed browser was detected.",
  "display-unavailable": "App windows are unavailable in this session because no graphical display was found.",
  "browser-failed": "The installed browser could not open an app window.",
  "profile-busy": "The dedicated browser profile is busy or its ownership could not be established; its data and locks were kept.",
  "firefox-disabled": "Firefox supports app windows, but they are disabled in the dedicated profile. Run kosmozoo browser-settings firefox, visit about:config, set browser.taskbarTabs.enabled to true, then relaunch. No preference was changed automatically.",
  "firefox-unsupported": "This installed Firefox does not provide characterized Linux app-window support.",
  "firefox-unknown": "Firefox app-window availability could not be determined from this package, profile or managed configuration. No preference was changed.",
  "firefox-origin-conflict": "Firefox's existing app registration points to a different URL. Its native launcher cannot select this engine's URL without changing that registration, so a regular browser is used. Manage the web app in Firefox itself if you want to re-register it; no registration or profile data was changed.",
});
export function launchNotice(reason, browserURL) {
  return typeof reason === "string" && Object.hasOwn(notices, reason) ? `${notices[reason]} Regular-browser URL: ${browserURL}` : null;
}
export function noticeURL(browserURL, reason) {
  if (!launchNotice(reason, browserURL)) throw new Error("Unknown launch-reason code");
  const url = new URL(browserURL); url.searchParams.set("launchReason", reason); return url.href;
}
