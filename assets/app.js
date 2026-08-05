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

  /* защищённые страницы: без входа отправляем на форму входа */
  CW.requireUser = function () {
    return CW.api('/api/me').then(function (r) {
      if (r.status !== 200) { location.replace('login.html'); return null; }
      return r.data.user;
    });
  };
})();
