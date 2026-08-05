/* Ночной режим.

   Тема — это набор переменных на <html>, поэтому смена мгновенная и без
   перезагрузки: браузер просто пересчитывает цвета.

   При нажатии из самой кнопки расходится круг нового цвета и накрывает экран;
   тему переключаем в тот момент, когда круг уже всё закрыл, — переход выходит
   цельным, без мигания половин. Тем, кто отключил анимации в системе, круг не
   рисуем вовсе. */
(function () {
  var KEY = 'cwtheme';
  var root = document.documentElement;

  function saved() {
    try { return localStorage.getItem(KEY); } catch (e) { return null; }
  }
  function remember(v) {
    try { localStorage.setItem(KEY, v); } catch (e) {}
  }
  function apply(v) {
    if (v === 'dark') root.setAttribute('data-theme', 'dark');
    else root.removeAttribute('data-theme');
  }
  function now() {
    return root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  }

  apply(saved() === 'dark' ? 'dark' : 'light');

  var SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">'
    + '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.6v2.2M12 19.2v2.2M4.2 12H2M22 12h-2.2'
    + 'M6.3 6.3 4.8 4.8M19.2 19.2l-1.5-1.5M17.7 6.3l1.5-1.5M4.8 19.2l1.5-1.5"/></svg>';
  var MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" '
    + 'stroke-linejoin="round"><path d="M20 14.2A8.2 8.2 0 0 1 9.8 4a8.4 8.4 0 1 0 10.2 10.2z"/></svg>';

  function paint(btn) {
    var dark = now() === 'dark';
    btn.innerHTML = '<span class="ring"></span>' + (dark ? SUN : MOON);
    btn.setAttribute('aria-label', dark ? 'Switch to day mode' : 'Switch to night mode');
    btn.setAttribute('aria-pressed', dark ? 'true' : 'false');
  }

  /* круг расходится из точки нажатия и накрывает самый дальний угол экрана */
  function wave(x, y, colour, done) {
    var far = Math.max(
      Math.hypot(x, y), Math.hypot(window.innerWidth - x, y),
      Math.hypot(x, window.innerHeight - y), Math.hypot(window.innerWidth - x, window.innerHeight - y)
    );
    var v = document.createElement('div');
    v.className = 'theme-wave';
    v.style.background = colour;
    v.style.clipPath = 'circle(0px at ' + x + 'px ' + y + 'px)';
    document.body.appendChild(v);

    var grow = v.animate(
      [{ clipPath: 'circle(0px at ' + x + 'px ' + y + 'px)' },
       { clipPath: 'circle(' + Math.ceil(far) + 'px at ' + x + 'px ' + y + 'px)' }],
      { duration: 620, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'forwards' }
    );
    grow.onfinish = function () {
      done();
      // круг уже закрыл экран, поэтому подмену цвета никто не увидит
      var fade = v.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 320, easing: 'ease-out', fill: 'forwards' });
      fade.onfinish = function () { v.remove(); };
    };
  }

  function mount() {
    document.querySelectorAll('.lang-fab').forEach(function (fab) {
      if (fab.parentNode.querySelector('.theme-btn')) return;
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'theme-btn';
      paint(btn);
      fab.parentNode.insertBefore(btn, fab.nextSibling);

      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var next = now() === 'dark' ? 'light' : 'dark';
        remember(next);

        btn.classList.remove('hit'); void btn.offsetWidth; btn.classList.add('hit');

        var slow = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        var r = btn.getBoundingClientRect();
        var x = r.left + r.width / 2, y = r.top + r.height / 2;
        // цвет фона той темы, в которую переходим
        var colour = next === 'dark' ? '#0B1524' : '#F5F8FC';

        if (slow || !document.body.animate) { apply(next); paint(btn); return; }
        wave(x, y, colour, function () { apply(next); paint(btn); });
      });
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
  // веер языка собирается своим скриптом — если он ещё не успел, пробуем ещё раз
  setTimeout(mount, 300);
})();
