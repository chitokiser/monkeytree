// /assets/js/partials.js
(() => {
  const loadInto = async (selector, url) => {
    const el = document.querySelector(selector);
    if (!el) return;

    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`Failed to load ${url} (${res.status})`);

    el.innerHTML = await res.text();
  };

  function initHamburger() {
    const burger = document.getElementById("btnBurger");
    const nav = document.getElementById("hdrNav");
    if (!burger || !nav) return;

    burger.addEventListener("click", () => {
      nav.classList.toggle("open");
      burger.classList.toggle("open");
    });

    document.addEventListener("click", (e) => {
      if (!nav.contains(e.target) && !burger.contains(e.target)) {
        nav.classList.remove("open");
        burger.classList.remove("open");
      }
    });
  }

  const boot = async () => {
    await loadInto("#site-header", "partials/header.html");
    await loadInto("#site-footer", "partials/footer.html");

    initHamburger();

    // 헤더/푸터 로드 완료 이벤트 → header-wallet.js에서 버튼 바인딩에 사용
    window.dispatchEvent(new CustomEvent("partials:loaded"));
  };

  boot().catch((e) => console.error("[partials]", e));
})();
