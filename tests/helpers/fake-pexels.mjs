// A Pexels-compatible service for tests. `api` is the service (it also serves
// some images itself); `cdn` is a separate image origin that must never
// receive the key. Unit tests inject `fakePexels().fetch`; the browser proof
// serves the same handler on two real ports (tests/fake-pexels.mjs).

export const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(60).fill(0x11), 0xff, 0xd9]);
const PAGE = 40;

export function pexelsHandler({ api = "http://pexels.home", cdn = "http://cdn.example", key = null, curated = true, image = () => JPEG } = {}) {
  const apiOrigin = new URL(api).origin, cdnOrigin = new URL(cdn).origin;
  const photo = (id, alt) => ({ id: Number(id), alt, photographer: `Photographer ${id}`, width: 1200, height: 800,
    src: { large2x: id === "13" ? `${apiOrigin}/img/13-text` : id === "21" ? `${apiOrigin}/redirect/21` : `${cdnOrigin}/img/${id}-large2x`,
      medium: `${apiOrigin}/img/${id}-medium` } });
  const json = (body, status = 200) => Response.json(body, { status });
  const bytes = path => { const id = path.match(/\/(\d+)/)?.[1] ?? "0", data = image(id); return new Response(data, { headers: { "Content-Type": data[0] === 0x89 ? "image/png" : "image/jpeg" } }); };
  return request => {
    const url = new URL(request.url), authorization = request.headers.get("Authorization");
    if (url.origin === cdnOrigin) return bytes(url.pathname);
    if (url.origin !== apiOrigin) return json({ error: "Unknown host" }, 404);
    if (url.pathname.startsWith("/v1/") && key && authorization !== key) return json({ error: "Unauthorized" }, 401);
    if (url.pathname === "/v1/curated") {
      if (!curated) return json({ error: "Not found" }, 404);
      const page = Number(url.searchParams.get("page"));
      return json({ page, per_page: PAGE, photos: Array.from({ length: PAGE }, (_, n) => photo(String(page * 100 + n), `Curated scene ${n}`)),
        ...(page < 3 ? { next_page: `${apiOrigin}/v1/curated?page=${page + 1}` } : {}) });
    }
    if (url.pathname === "/v1/search") {
      const query = url.searchParams.get("query"), page = Number(url.searchParams.get("page")), total = query === "dogs" ? 3 : 50;
      const count = Math.max(0, Math.min(PAGE, total - (page - 1) * PAGE));
      return json({ page, per_page: PAGE, total_results: total,
        photos: Array.from({ length: count }, (_, n) => photo(String(1000 + page * 100 + n), `${query} photo ${n}`)) });
    }
    const single = url.pathname.match(/^\/v1\/photos\/(\w+)$/);
    if (single) return single[1] === "999" ? json({ error: "Not found" }, 404) : json(photo(single[1], `Photo ${single[1]}`));
    if (url.pathname === "/redirect/21") return new Response(null, { status: 302, headers: { Location: `${cdnOrigin}/moved/21` } });
    if (url.pathname === "/img/13-text") return new Response("hello", { headers: { "Content-Type": "text/plain" } });
    if (url.pathname.startsWith("/img/")) return bytes(url.pathname);
    return json({ error: "Not found" }, 404);
  };
}

export function fakePexels(options = {}) {
  const requests = [], handler = pexelsHandler(options);
  const fetch = async (href, init = {}) => {
    const request = new Request(href, init);
    requests.push({ url: request.url, authorization: request.headers.get("Authorization") });
    return handler(request);
  };
  return { fetch, requests };
}
