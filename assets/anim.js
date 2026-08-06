/* CaseCheck motion layer — GSAP reveals & parallax на родной прокрутке.
   Graceful: if GSAP is missing or the user prefers reduced motion, we simply
   reveal everything and fall back to native scrolling. Transform/opacity only. */
(function () {
  var root = document.documentElement;
  root.classList.remove("nojs");
  root.classList.add("js");

  var reduce = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  var G = window.gsap, ST = window.ScrollTrigger;

  function revealAll() {
    document.querySelectorAll(".rv").forEach(function (el) { el.classList.add("in"); });
  }
  function headerFallback() {
    var h = document.querySelector("header"); if (!h) return;
    var upd = function () { h.classList.toggle("scrolled", (window.scrollY || window.pageYOffset) > 8); };
    window.addEventListener("scroll", upd, { passive: true }); upd();
  }

  if (reduce || !G || !ST) { revealAll(); headerFallback(); return; }

  window.__animOwned = true;          // signal the inline IntersectionObserver to stand down
  root.classList.add("gsapx");        // CSS drops the reveal-transition; GSAP owns opacity/transform
  G.registerPlugin(ST);

  /* Плавную прокрутку убрали намеренно: она перехватывает колесо и превращает
     обычное листание в вязкое слоу-мо. Родная прокрутка быстрее и предсказуемее,
     а появление блоков ниже держится на ScrollTrigger и от неё не зависит. */
  var header = document.querySelector("header");
  headerFallback();

  document.querySelectorAll('a[href^="#"]').forEach(function (a) {
    a.addEventListener("click", function (e) {
      var id = a.getAttribute("href");
      if (!id || id.length < 2) return;
      var target = document.querySelector(id);
      if (!target) return;
      e.preventDefault();
      var y = target.getBoundingClientRect().top + window.pageYOffset - 64;
      window.scrollTo({ top: y, behavior: "smooth" });
      var dr = document.getElementById("drawer"); if (dr) dr.classList.remove("on");
    });
  });

  /* ---- initial hidden states ----
     На узком экране карточки идут в один столбец с небольшим зазором, и сдвиг
     по вертикали при появлении накладывал их друг на друга — выглядело как
     поломка. На телефоне проявляем только прозрачностью, без съезда. */
  var NARROW = window.matchMedia("(max-width:700px)").matches;
  var RISE = NARROW ? 0 : 24;
  G.set(".rv", { opacity: 0, y: RISE });
  G.set(".hero .mock", { y: 0, x: 46 });     // the status card glides in from the right

  /* ---- hero entrance ----
     clearProps:"transform" once each element lands — GSAP otherwise leaves an inline
     transform matrix, and any transform creates a stacking context (which was pushing
     the country dropdown panel *under* the strip text below it). The mock keeps its
     transform on purpose (it drives the scroll parallax). */
  G.timeline({ defaults: { ease: "power3.out" } })
    .to(".hero .ey",        { opacity: 1, y: 0, duration: 0.55, clearProps: "transform" })
    .to(".hero h1",         { opacity: 1, y: 0, duration: 0.80, clearProps: "transform" }, "-=0.30")
    .to(".hero .lead",      { opacity: 1, y: 0, duration: 0.70, clearProps: "transform" }, "-=0.55")
    .to(".hero .checkcard", { opacity: 1, y: 0, duration: 0.70, clearProps: "transform" }, "-=0.50")
    .to(".hero .strip",     { opacity: 1, y: 0, duration: 0.60, clearProps: "transform" }, "-=0.50")
    .to(".hero .mock",      { opacity: 1, x: 0, duration: 0.90 }, "-=1.05");

  /* ---- scroll reveals for everything else ---- */
  ST.batch(".rv:not([data-hero])", {
    start: "top 86%",
    onEnter: function (b) {
      G.to(b, { opacity: 1, y: 0, duration: 0.7, ease: "power3.out", stagger: 0.09, overwrite: true, clearProps: "transform" });
    }
  });

  /* ---- subtle parallax on the status card (desktop, real pointer only) ---- */
  var mm = G.matchMedia();
  mm.add("(min-width:981px) and (pointer:fine)", function () {
    G.to(".hero .mock", {
      yPercent: -7, ease: "none",
      scrollTrigger: { trigger: ".hero", start: "top top", end: "bottom top", scrub: 0.6 }
    });
  });

  window.addEventListener("load", function () { ST.refresh(); });
})();
