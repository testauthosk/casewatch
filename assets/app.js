/* CaseWatch — клиентская часть кабинета.
   Ходит в наш API, ничего не решает сама: сервер единственный источник правды. */
(function () {
  var CW = (window.CW = {});

  CW.api = function (path, body) {
    return fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        return { status: r.status, data: j };
      });
    });
  };

  CW.err = function (box, text) {
    if (!box) return;
    box.textContent = text;
    box.style.display = text ? 'block' : 'none';
  };

  CW.pending = function (btn, on, label) {
    if (!btn) return;
    btn.disabled = on;
    if (on) { btn.dataset.label = btn.dataset.label || btn.textContent; btn.textContent = label || 'Please wait…'; }
    else if (btn.dataset.label) btn.textContent = btn.dataset.label;
  };

  /* дело, введённое на главной, живёт в адресе до самого кабинета */
  CW.carried = function () {
    var q = new URLSearchParams(location.search);
    var a = (q.get('a') || '').replace(/\D/g, '');
    var c = q.get('c') || '';
    return a.length === 9 ? { aNumber: a, country: c } : null;
  };

  CW.pretty = function (a) {
    var d = String(a).replace(/\D/g, '');
    return d.length === 9 ? 'A' + d.slice(0, 3) + '-' + d.slice(3, 6) + '-' + d.slice(6) : a;
  };

  CW.ago = function (ts) {
    if (!ts) return 'not checked yet';
    var s = Math.max(0, Math.floor(Date.now() / 1000) - ts);
    if (s < 90) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    return Math.floor(s / 86400) + ' d ago';
  };


  /* кнопки Google и Apple показываем только когда провайдер настроен —
     мёртвая кнопка на странице входа хуже, чем её отсутствие */
  CW.mountProviders = function () {
    return CW.api('/api/auth/providers').then(function (r) {
      var on = r.data || {};
      [['google', on.google], ['apple', on.apple]].forEach(function (pair) {
        var el = document.getElementById(pair[0]);
        if (!el) return;
        if (!pair[1]) { el.remove(); return; }
        el.style.display = '';
        el.addEventListener('click', function () {
          location.href = '/api/auth/' + pair[0] + '/start';
        });
      });
      var sep = document.querySelector('.auth-sep');
      if (sep && !document.querySelector('.btn-oauth, .btn-apple')) sep.remove();
    });
  };

  /* Свой выпадающий список вместо системного: тот рисуется операционной
     системой и выбивается из оформления. Родной <select> остаётся в разметке
     скрытым — он держит значение, поэтому остальной код о подмене не знает. */
  CW.fancySelect = function (sel) {
    if (!sel || sel.dataset.fancy) return;
    sel.dataset.fancy = '1';

    var wrap = document.createElement('div');
    wrap.className = 'csel';
    sel.parentNode.insertBefore(wrap, sel);
    wrap.appendChild(sel);
    sel.style.display = 'none';

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cselbtn';
    btn.innerHTML = '<span class="lb"></span>'
      + '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" '
      + 'stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
    var list = document.createElement('div');
    list.className = 'cselopts';
    list.setAttribute('role', 'listbox');
    wrap.appendChild(btn);
    wrap.appendChild(list);

    var tick = '<svg class="tick" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" '
      + 'stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
    var opts = [].slice.call(sel.options);
    var label = btn.querySelector('.lb');

    list.innerHTML = opts.map(function (o, i) {
      return '<div class="o' + (i === sel.selectedIndex ? ' sel' : '') + '" role="option" data-i="' + i + '">'
        + '<span>' + o.text + '</span>' + tick + '</div>';
    }).join('');
    label.textContent = opts[sel.selectedIndex] ? opts[sel.selectedIndex].text : '';

    function pick(i) {
      sel.selectedIndex = i;
      label.textContent = opts[i].text;
      list.querySelectorAll('.o').forEach(function (o) { o.classList.toggle('sel', +o.dataset.i === i); });
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
    function close() { wrap.classList.remove('open', 'up'); }
    function open() {
      // снизу может не быть места — тогда раскрываем вверх
      var r = btn.getBoundingClientRect();
      wrap.classList.toggle('up', window.innerHeight - r.bottom < Math.min(248, opts.length * 42 + 16));
      wrap.classList.add('open');
    }

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (wrap.classList.contains('open')) close(); else open();
    });
    list.querySelectorAll('.o').forEach(function (o) {
      o.addEventListener('click', function () { pick(+o.dataset.i); close(); btn.focus(); });
    });
    document.addEventListener('click', close);
    btn.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        var next = sel.selectedIndex + (e.key === 'ArrowDown' ? 1 : -1);
        if (next >= 0 && next < opts.length) pick(next);
        if (!wrap.classList.contains('open')) open();
      } else if (e.key === 'Escape') close();
      else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (wrap.classList.contains('open')) close(); else open(); }
    });
  };

  /* защищённые страницы: без входа отправляем на форму входа */
  CW.requireUser = function () {
    return CW.api('/api/me').then(function (r) {
      if (r.status !== 200) { location.replace('login.html'); return null; }
      return r.data.user;
    });
  };
})();
