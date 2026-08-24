// client/app/services/scraper.mjs — scraper status text + the 2s status poll.
// (Moved from main.mjs; <App>'s init effect starts the poll once.)

import { state } from "../../js/state.mjs";
import { api } from "../../js/api.mjs";

export function scraperPendingText() {
  const p = state.scraper?.pending ?? {};
  const total = Object.values(p).reduce((a, b) => a + b, 0);
  return total > 0 ? `${total} left` : "";
}

let scraperPollStarted = false;
export function startScraperPoll() {
  if (scraperPollStarted) return;
  scraperPollStarted = true;
  setInterval(async () => {
    state.scraper = await api.scraper().catch(() => state.scraper);
    const counter = document.getElementById("scraperPending");
    if (counter) counter.textContent = scraperPendingText();
  }, 2000);
}
