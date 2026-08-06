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

  /* Одна фигура вместо двух стоковых иконок: диск, из которого выезжающий
     сверху круг «выкусывает» месяц, лучи втягиваются, проступают звёзды.
     Всё переходами по классу — иконка не подменяется, а превращается. */
  var seq = 0;
  function icon() {
    var id = 'cut' + (++seq);
    var rays = '';
    for (var i = 0; i < 8; i++) {
      var a = (i * Math.PI) / 4;
      var x1 = 12 + Math.cos(a) * 8.4, y1 = 12 + Math.sin(a) * 8.4;
      var x2 = 12 + Math.cos(a) * 10.8, y2 = 12 + Math.sin(a) * 10.8;
      rays += '<line x1="' + x1.toFixed(2) + '" y1="' + y1.toFixed(2) + '" x2="' + x2.toFixed(2)
        + '" y2="' + y2.toFixed(2) + '"/>';
    }
    return '<svg class="sunmoon" viewBox="0 0 24 24" aria-hidden="true">'
      + '<mask id="' + id + '"><rect x="0" y="0" width="24" height="24" fill="#fff"/>'
      + '<circle class="bite" cx="24" cy="1" r="7.4" fill="#000"/></mask>'
      + '<circle class="body" cx="12" cy="12" r="5.6" mask="url(#' + id + ')"/>'
      + '<g class="rays">' + rays + '</g>'
      + '<g class="stars"><path d="M18.6 5.4v2.2M17.5 6.5h2.2"/>'
      + '<path d="M7.4 4.6v1.5M6.65 5.35h1.5"/></g>'
      + '</svg>';
  }

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
      btn.innerHTML = '<span class="ring"></span>' + icon();
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
