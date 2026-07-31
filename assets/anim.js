/* CaseWatch motion layer — Lenis smooth scroll + GSAP reveals & parallax.
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

  /* ---- Lenis smooth scroll (desktop wheel; native momentum on touch) ---- */
  var header = document.querySelector("header");
  if (window.Lenis) {
    var lenis = new Lenis({
      duration: 1.05,
      easing: function (t) { return Math.min(1, 1.001 - Math.pow(2, -10 * t)); },
      smoothWheel: true,
      smoothTouch: false
    });
    lenis.on("scroll", function (e) {
      ST.update();
      if (header) header.classList.toggle("scrolled", e.scroll > 8);
    });
    G.ticker.add(function (t) { lenis.raf(t * 1000); });
    G.ticker.lagSmoothing(0);

    document.querySelectorAll('a[href^="#"]').forEach(function (a) {
      a.addEventListener("click", function (e) {
        var id = a.getAttribute("href");
        if (!id || id.length < 2) return;
        var target = document.querySelector(id);
        if (!target) return;
        e.preventDefault();
        lenis.scrollTo(target, { offset: -64, duration: 1.1 });
        var dr = document.getElementById("drawer"); if (dr) dr.classList.remove("on");
      });
    });
  } else {
    headerFallback();
  }

  /* ---- initial hidden states ---- */
  G.set(".rv", { opacity: 0, y: 24 });
  G.set(".hero .mock", { y: 0, x: 46 });     // the status card glides in from the right

  /* ---- hero entrance ---- */
  G.timeline({ defaults: { ease: "power3.out" } })
    .to(".hero .ey",        { opacity: 1, y: 0, duration: 0.55 })
    .to(".hero h1",         { opacity: 1, y: 0, duration: 0.80 }, "-=0.30")
    .to(".hero .lead",      { opacity: 1, y: 0, duration: 0.70 }, "-=0.55")
    .to(".hero .checkcard", { opacity: 1, y: 0, duration: 0.70 }, "-=0.50")
    .to(".hero .strip",     { opacity: 1, y: 0, duration: 0.60 }, "-=0.50")
    .to(".hero .mock",      { opacity: 1, x: 0, duration: 0.90 }, "-=1.05");

  /* ---- scroll reveals for everything else ---- */
  ST.batch(".rv:not([data-hero])", {
    start: "top 86%",
    onEnter: function (b) {
      G.to(b, { opacity: 1, y: 0, duration: 0.7, ease: "power3.out", stagger: 0.09, overwrite: true });
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
