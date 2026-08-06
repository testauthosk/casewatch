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

  /* Иконки — солнце и месяц из набора Lucide (ISC): именно они стоят в
     большинстве переключателей, потому что у них выверенная сетка и одинаковая
     толщина штриха с остальными иконками сайта. Обе лежат в кнопке разом и
     сменяют друг друга поворотом, а не подставляются заново. */
  var SUN = '<svg class="ic-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
    + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/>'
    + '<path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/>'
    + '<path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>';
  var MOON = '<svg class="ic-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
    + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>';

  function paint(btn) {
    var dark = now() === 'dark';
    btn.classList.toggle('night', dark);
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
    // Цвета текста и карточек переключаем, пока круг ещё идёт: если ждать конца,
    // на середине анимации тёмный текст оказывается на уже тёмном фоне.
    setTimeout(done, 200);
    grow.onfinish = function () {
      var fade = v.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 260, easing: 'ease-out', fill: 'forwards' });
      fade.onfinish = function () { v.remove(); };
    };
  }

  function mount() {
    document.querySelectorAll('.lang-fab').forEach(function (fab) {
      if (fab.parentNode.querySelector('.theme-btn')) return;
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'theme-btn';
      btn.innerHTML = '<span class="ring"></span>' + SUN + MOON;
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
        wave(x, y, colour, function () {
          // пока переключаем, даём цветам разъехаться плавно, а не скачком
          root.classList.add('theming');
          apply(next); paint(btn);
          setTimeout(function () { root.classList.remove('theming'); }, 560);
        });
      });
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
  // веер языка собирается своим скриптом — если он ещё не успел, пробуем ещё раз
  setTimeout(mount, 300);
})();
