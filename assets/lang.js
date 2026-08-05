/* Переключатель языка веером.

   Круглая кнопка раскрывается дугой орбов, выбранный подсвечивается «шайбой»,
   которая переезжает на его место. Выбор запоминается в куке, поэтому при
   следующем заходе человек попадает сразу на свой язык.

   Языки, страницы которых ещё не переведены, помечены и говорят об этом прямо,
   а не молча ничего не делают. */
(function () {
  var LANGS = [
    { code: 'en', label: 'EN', name: 'English', dir: '', ready: true },
    { code: 'es', label: 'ES', name: 'Español', dir: 'es', ready: false },
    { code: 'hi', label: 'हि', name: 'हिन्दी', dir: 'hi', ready: false },
    { code: 'ru', label: 'RU', name: 'Русский', dir: 'ru', ready: false },
  ];
  var SPOTS = [{ x: -58, y: 26 }, { x: -22, y: 56 }, { x: 22, y: 56 }, { x: 58, y: 26 }];

  function byCode(c) {
    for (var i = 0; i < LANGS.length; i++) if (LANGS[i].code === c) return LANGS[i];
    return LANGS[0];
  }

  function current() {
    var seg = location.pathname.split('/')[1];
    for (var i = 0; i < LANGS.length; i++) if (LANGS[i].dir && LANGS[i].dir === seg) return LANGS[i].code;
    return 'en';
  }

  function remember(code) {
    try { document.cookie = 'cwlang=' + code + '; path=/; max-age=31536000; samesite=lax'; } catch (e) {}
  }

  function urlFor(lang) {
    var parts = location.pathname.split('/').filter(Boolean);
    if (parts.length && byCode(parts[0]).dir === parts[0] && parts[0] !== '') parts.shift();
    var tail = parts.join('/') || 'index.html';
    return '/' + (lang.dir ? lang.dir + '/' : '') + tail;
  }

  function toast(text) {
    var t = document.querySelector('.toast');
    if (!t) {
      t = document.createElement('div');
      t.className = 'toast';
      t.setAttribute('role', 'status');
      document.body.appendChild(t);
    }
    t.textContent = text;
    t.classList.add('on');
    clearTimeout(t._h);
    t._h = setTimeout(function () { t.classList.remove('on'); }, 3600);
  }

  function build(host) {
    var fab = document.createElement('div');
    fab.className = 'lang-fab';
    var now = byCode(current());

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'lang-fab-btn';
    btn.setAttribute('aria-label', 'Language');
    btn.setAttribute('aria-expanded', 'false');
    btn.innerHTML = '<span class="lang-fab-cur">' + now.label + '</span>'
      + '<svg class="lang-fab-x" viewBox="0 0 24 24" fill="none" stroke-width="2.2" stroke-linecap="round">'
      + '<path d="M6 6l12 12M18 6L6 18"/></svg>';
    fab.appendChild(btn);

    var orbs = document.createElement('div');
    orbs.className = 'lang-orbs';
    var puck = document.createElement('div');
    puck.className = 'lang-orb-puck';
    puck.innerHTML = '<span class="lang-orb-txt">' + now.label + '</span>';
    orbs.appendChild(puck);

    LANGS.forEach(function (l) {
      var o = document.createElement('button');
      o.type = 'button';
      o.className = 'lang-orb' + (l.ready ? '' : ' soon');
      o.dataset.l = l.code;
      o.setAttribute('aria-label', l.name + (l.ready ? '' : ' — coming soon'));
      o.innerHTML = '<span class="lang-orb-txt">' + l.label + '</span>';
      orbs.appendChild(o);
    });
    fab.appendChild(orbs);
    host.parentNode.replaceChild(fab, host);
    return fab;
  }

  function paint(fab, code) {
    var l = byCode(code);
    fab.querySelector('.lang-fab-cur').textContent = l.label;
    fab.querySelector('.lang-orb-puck .lang-orb-txt').textContent = l.label;
    fab.querySelectorAll('.lang-orb').forEach(function (o, i) {
      var act = o.dataset.l === code;
      o.setAttribute('aria-pressed', act ? 'true' : 'false');
      if (act) {
        var s = SPOTS[i] || { x: 0, y: 48 };
        fab.querySelector('.lang-orb-puck').style.transform = fab.classList.contains('is-open')
          ? 'translate(' + s.x + 'px,' + s.y + 'px)' : 'scale(.2)';
      }
    });
  }

  function close(fab) {
    fab.classList.remove('is-open');
    fab.querySelector('.lang-fab-btn').setAttribute('aria-expanded', 'false');
    fab.querySelectorAll('.lang-orb').forEach(function (o) { o.style.transform = 'scale(.2)'; });
    fab.querySelector('.lang-orb-puck').style.transform = 'scale(.2)';
  }

  function open(fab) {
    fab.classList.add('is-open');
    fab.querySelector('.lang-fab-btn').setAttribute('aria-expanded', 'true');
    fab.querySelectorAll('.lang-orb').forEach(function (o, i) {
      var s = SPOTS[i] || { x: 0, y: 48 };
      o.style.transitionDelay = (i * 45) + 'ms';
      o.style.transform = 'translate(' + s.x + 'px,' + s.y + 'px)';
    });
    paint(fab, current());
  }

  function mount() {
    document.querySelectorAll('.lang').forEach(function (host) {
      var fab = build(host);
      var btn = fab.querySelector('.lang-fab-btn');

      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (fab.classList.contains('is-open')) close(fab); else open(fab);
      });

      fab.querySelectorAll('.lang-orb').forEach(function (o) {
        o.addEventListener('click', function (e) {
          e.stopPropagation();
          var l = byCode(o.dataset.l);
          remember(l.code);
          close(fab);
          if (!l.ready) return toast(l.name + ' is coming soon — the site is in English for now.');
          if (l.code === current()) return;
          location.href = urlFor(l);
        });
      });

      document.addEventListener('click', function () { close(fab); });
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(fab); });
      paint(fab, current());
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
