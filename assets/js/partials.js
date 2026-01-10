// /assets/js/partials.js
(() => {
  const loadInto = async (selector, url) => {
    const el = document.querySelector(selector);
    if (!el) return;

    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`Failed to load ${url} (${res.status})`);

    el.innerHTML = await res.text();
  };

  const boot = async () => {
    await loadInto("#site-header", "partials/header.html");
    await loadInto("#site-footer", "partials/footer.html");
  };

  boot().catch((e) => console.error("[partials]", e));
})();
