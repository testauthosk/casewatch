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

  /* Поддержка. Окно одно на все страницы кабинета, поэтому собираем его здесь,
     а в разметке страниц остаётся только кнопка в боковом меню. */
  var TG_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M21.9 4.3 18.7 19.4c-.24 1.07-.88 1.33-1.78.83l-4.92-3.63-2.37 2.28c-.26.26-.48.48-1 .48l.35-4.99 9.09-8.21c.4-.35-.09-.55-.61-.2L6.22 13.2 1.36 11.7c-1.06-.33-1.08-1.06.22-1.57l19-7.32c.88-.32 1.65.2 1.32 1.49z"/></svg>';

  CW.mountSupport = function (user, support) {
    var btn = document.getElementById('supBtn');
    if (!btn || document.getElementById('supWin')) return;
    support = support || {};
    var tg = support.tg || '';
    var mailto = 'mailto:' + (support.email || 'support@casewatch.app');

    var win = document.createElement('div');
    win.className = 'modal';
    win.id = 'supWin';
    win.innerHTML =
      '<div class="win">'
      + '<h3>Support</h3>'
      + '<p class="hint">Tell us what happened — we read every message and answer within a business day.</p>'
      + '<div class="field" style="margin-top:16px;"><label for="supTopic">What is it about</label>'
      + '<select id="supTopic">'
      + '<option>Case or hearing data</option>'
      + '<option>Alerts and channels</option>'
      + '<option>Payment or plan</option>'
      + '<option>Account and sign-in</option>'
      + '<option>Something else</option>'
      + '</select></div>'
      + '<div class="field" style="margin-top:12px;"><label for="supText">Your message</label>'
      + '<textarea id="supText" rows="5" placeholder="Describe it in a few sentences."></textarea></div>'
      + '<div class="ferr" id="supErr"></div>'
      + '<p class="hint" style="margin-top:10px;">We reply to <b>' + (user && user.email ? user.email : 'your email') + '</b>.</p>'
      + '<div class="acts"><button type="button" class="btn btn-ghost" id="supCancel">Cancel</button>'
      + '<button type="button" class="btn btn-primary" id="supSend">Send</button></div>'
      + (tg ? '<div class="auth-sep">or</div>'
        + '<a class="btn btn-tg btn-block" id="supTg" href="' + tg + '" target="_blank" rel="noopener">'
        + TG_ICON + ' Write to support in Telegram</a>' : '')
      + '<p class="hint" style="text-align:center;margin-top:12px;font-size:12.5px;">'
      + 'Or email <a href="' + mailto + '">' + (support.email || '') + '</a>.</p>'
      + '</div>';
    document.body.appendChild(win);

    var open = function () { win.classList.add('on'); document.getElementById('supText').focus(); };
    var close = function () { win.classList.remove('on'); };
    btn.addEventListener('click', open);
    document.getElementById('supCancel').addEventListener('click', close);
    win.addEventListener('click', function (e) { if (e.target === win) close(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });

    document.getElementById('supSend').addEventListener('click', function () {
      var send = this, err = document.getElementById('supErr');
      var text = document.getElementById('supText').value.trim();
      CW.err(err, '');
      if (text.length < 5) return CW.err(err, 'Write a couple of sentences so we can help.');
      CW.pending(send, true, 'Sending…');
      CW.api('/api/support', { topic: document.getElementById('supTopic').value, text: text })
        .then(function (r) {
          CW.pending(send, false);
          if (r.status === 429) return CW.err(err, 'You have sent several messages already — we are on it.');
          if (r.status !== 200) return CW.err(err, 'Could not send it. Try Telegram or email below.');
          win.querySelector('.win').innerHTML =
            '<h3>Got it</h3>'
            + '<p class="hint">We have your message and will reply to <b>'
            + (user && user.email ? user.email : 'your email') + '</b>.</p>'
            + '<div class="acts"><button type="button" class="btn btn-primary" id="supDone">Close</button></div>';
          document.getElementById('supDone').addEventListener('click', function () { location.reload(); });
        });
    });
  };

  /* защищённые страницы: без входа отправляем на форму входа */
  CW.requireUser = function () {
    return CW.api('/api/me').then(function (r) {
      if (r.status !== 200) { location.replace('login.html'); return null; }
      CW.mountSupport(r.data.user, r.data.support);
      return r.data.user;
    });
  };
})();
