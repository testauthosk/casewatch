/* CaseCheck — клиентская часть кабинета.
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
    var n = (q.get('n') || '').toUpperCase();
    // без кода гражданства дело в ACIS не найти — такой перенос отбрасываем
    return a.length === 9 && /^[A-Z]{2}$/.test(n) ? { aNumber: a, country: c, natCode: n } : null;
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


  /* Кнопки Google и Apple видны всегда. Пока ключи провайдера не прописаны,
     кнопка не ведёт в тупик, а честно говорит, что вход ещё подключается. */
  CW.mountProviders = function () {
    return CW.api('/api/auth/providers').then(function (r) {
      var on = r.data || {};
      [['google', on.google, 'Google'], ['apple', on.apple, 'Apple']].forEach(function (p) {
        var el = document.getElementById(p[0]);
        if (!el) return;
        el.style.display = '';
        if (p[1]) {
          el.addEventListener('click', function () { location.href = '/api/auth/' + p[0] + '/start'; });
          return;
        }
        // провайдер ещё не подключён: кнопку показываем, но не ведём в тупик
        el.classList.add('soon');
        el.addEventListener('click', function () {
          var note = el.parentNode.querySelector('.soon-note');
          if (!note) {
            note = document.createElement('p');
            note.className = 'hint soon-note';
            el.parentNode.insertBefore(note, el.nextSibling);
          }
          note.textContent = p[2] + ' sign-in is being connected. Use your email for now.';
        });
      });
    });
  };

  /* Пароль: правила видны сразу, а не после отказа формы, и отмечаются по мере
     набора — так человек понимает, чего не хватает, не гадая. Глазок нужен,
     чтобы проверить набранное; поле повтора страхует от опечатки вслепую. */
  CW.PW_RULES = [
    { id: 'len', text: 'At least 8 characters', test: function (v) { return v.length >= 8; } },
    { id: 'up', text: 'One uppercase letter', test: function (v) { return /[A-Z]/.test(v); } },
    { id: 'num', text: 'One number', test: function (v) { return /\d/.test(v); } },
    { id: 'sym', text: 'One symbol — ! ? # $', test: function (v) { return /[^A-Za-z0-9\s]/.test(v); } },
  ];

  CW.passOk = function (v) {
    return CW.PW_RULES.every(function (r) { return r.test(String(v || '')); });
  };

  function eye(input) {
    var f = input.closest('.field');
    if (!f || f.querySelector('.eye')) return;
    f.classList.add('has-eye');
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'eye';
    b.setAttribute('aria-label', 'Show password');
    b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" '
      + 'stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/>'
      + '<circle cx="12" cy="12" r="2.6"/><path class="slash" d="M4 20 20 4"/></svg>';
    b.addEventListener('click', function () {
      var show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      b.classList.toggle('on', show);
      b.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    });
    f.appendChild(b);
  }

  CW.passwordUI = function (pass, again, mount) {
    if (!pass || !mount) return { ok: function () { return false; } };
    eye(pass);
    if (again) eye(again);

    var tick = '<svg class="tk" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" '
      + 'stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
    mount.className = 'pw';
    mount.innerHTML =
      '<div class="pw-bar" aria-hidden="true"><i></i><i></i><i></i><i></i></div>'
      + '<div class="pw-word" id="pwWord" role="status" aria-live="polite">Password strength</div>'
      + '<ul class="pw-reqs">'
      + CW.PW_RULES.map(function (r) {
          return '<li class="req" data-r="' + r.id + '"><span class="dot">' + tick + '</span>' + r.text + '</li>';
        }).join('')
      + '</ul>';
    pass.setAttribute('aria-describedby', mount.id);

    var word = mount.querySelector('#pwWord');
    var bars = mount.querySelectorAll('.pw-bar i');
    var rows = {};
    mount.querySelectorAll('.req').forEach(function (li) { rows[li.dataset.r] = li; });
    var WORDS = ['Password strength', 'Weak', 'Fair', 'Good', 'Strong'];

    function paint() {
      var v = pass.value;
      var n = 0;
      CW.PW_RULES.forEach(function (r) {
        var ok = r.test(v);
        if (ok) n++;
        rows[r.id].classList.toggle('ok', ok);
      });
      bars.forEach(function (b, i) { b.classList.toggle('on', v && i < n); });
      // шкала не должна хвалить пароль, который форма всё равно не пропустит
      mount.dataset.lvl = v ? Math.max(n, 1) : 0;
      word.textContent = v ? WORDS[Math.max(n, 1)] : WORDS[0];
      if (again) matchNote();
    }

    function matchNote() {
      var box = mount.parentNode.querySelector('.pw-match');
      if (!box) return;
      if (!again.value) { box.className = 'pw-match'; box.textContent = ''; return; }
      var same = again.value === pass.value;
      box.className = 'pw-match show ' + (same ? 'ok' : 'bad');
      box.textContent = same ? 'Passwords match' : 'Passwords do not match yet';
    }

    pass.addEventListener('input', paint);
    if (again) again.addEventListener('input', matchNote);
    paint();

    return {
      ok: function () { return CW.passOk(pass.value) && (!again || again.value === pass.value); },
      first: function () {
        if (!CW.passOk(pass.value)) return pass;
        if (again && again.value !== pass.value) return again;
        return null;
      },
    };
  };

  /* Поле кода из письма. Приём тот же, что в известных реализациях (input-otp,
     на нём построен shadcn): одно настоящее поле, а клетки — только рисунок.
     Так остаются целыми вставка из буфера, автоподстановка кода из письма и
     подсказка клавиатуры на телефоне, чего лишаются варианты из шести полей. */
  CW.codeInput = function (input, onDone) {
    if (!input || input.dataset.otp) return null;
    input.dataset.otp = '1';
    var LEN = Number(input.getAttribute('maxlength')) || 6;

    var wrap = document.createElement('div');
    wrap.className = 'otp';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);

    /* Цифра не «появляется», а прокручивается на своё место барабаном: в каждой
       клетке лежит лента из пустоты и цифр 0–9, двигаем её по вертикали. */
    var strip = '<span class="roll"><i></i><i>0</i><i>1</i><i>2</i><i>3</i><i>4</i>'
      + '<i>5</i><i>6</i><i>7</i><i>8</i><i>9</i></span>';

    var cells = document.createElement('div');
    cells.className = 'otp-cells';
    cells.setAttribute('aria-hidden', 'true');
    for (var i = 0; i < LEN; i++) {
      var c = document.createElement('span');
      c.className = 'cell';
      c.style.setProperty('--i', i);          // задержки волной, слева направо
      c.innerHTML = strip;
      cells.appendChild(c);
    }
    wrap.appendChild(cells);
    var slots = cells.children;

    var line = document.createElement('div');
    line.className = 'otp-life';
    line.innerHTML = '<i></i>';
    wrap.appendChild(line);

    input.setAttribute('inputmode', 'numeric');
    input.setAttribute('autocomplete', 'one-time-code');

    function paint() {
      var v = input.value.replace(/\D/g, '').slice(0, LEN);
      if (v !== input.value) input.value = v;               // буквы в код не попадают
      for (var i = 0; i < LEN; i++) {
        var s = slots[i];
        var roll = s.firstChild;
        roll.style.setProperty('--d', v[i] ? Number(v[i]) + 1 : 0);
        s.classList.toggle('filled', !!v[i]);
        s.classList.toggle('now', document.activeElement === input && i === Math.min(v.length, LEN - 1));
      }
      wrap.classList.toggle('full', v.length === LEN);
      if (v.length === LEN && onDone) onDone(v);
    }

    /* Код живёт десять минут — показываем это полосой, а не молчим до отказа */
    var life = null;
    function clock(seconds) {
      if (life) clearInterval(life);
      var left = seconds, total = seconds;
      wrap.classList.remove('dead');
      function tick() {
        var bar = line.firstChild;
        bar.style.transform = 'scaleX(' + Math.max(0, left / total) + ')';
        line.dataset.left = Math.floor(left / 60) + ':' + ('0' + (left % 60)).slice(-2);
        line.classList.toggle('warn', left <= 60);
        if (left <= 0) { clearInterval(life); wrap.classList.add('dead'); }
        left--;
      }
      tick();
      life = setInterval(tick, 1000);
    }

    input.addEventListener('input', paint);
    input.addEventListener('focus', function () { wrap.classList.add('on'); paint(); });
    input.addEventListener('blur', function () { wrap.classList.remove('on'); paint(); });
    paint();

    return {
      start: function (seconds) { clock(seconds || 600); input.focus(); },
      win: function () {
        wrap.classList.add('win');
        if (life) clearInterval(life);
        var m = document.querySelector('.mailer');
        if (m) m.classList.add('sealed');
      },
      shake: function () {
        wrap.classList.remove('bad'); void wrap.offsetWidth; wrap.classList.add('bad');
        input.value = ''; paint(); input.focus();
      },
    };
  };

  /* Свой выпадающий список вместо системного: тот рисуется операционной
     системой и выбивается из оформления. Родной <select> остаётся в разметке
     скрытым — он держит значение, поэтому остальной код о подмене не знает. */
  /* Выбор гражданства. Список у ACIS свой — 246 позиций и своя запись имён,
     поэтому свободный ввод не годится: «Mexico» их поиск не понимает, нужен
     ровно их вариант. Отсюда поиск по буквам и скрытые поля с кодом. */
  CW.countryPicker = function (mount, placeholder) {
    if (!mount || mount.dataset.ready) return null;
    mount.dataset.ready = '1';
    var all = window.CW_COUNTRIES || [];
    var cur = -1;          // выбранная страна
    var hot = 0;           // подсвеченная в списке

    mount.classList.add('csel');
    mount.innerHTML = '<button type="button" class="cselbtn">'
      + '<span class="lb ph">' + (placeholder || 'Select country…') + '</span>'
      + '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" '
      + 'stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg></button>'
      + '<div class="cselopts" role="listbox"><div class="cselfind">'
      + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">'
      + '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6"/></svg>'
      + '<input type="text" placeholder="Type to search" autocomplete="off" spellcheck="false"></div>'
      + '<div class="colist"></div></div>'
      + '<input type="hidden" class="cval"><input type="hidden" class="ccode">';

    var btn = mount.querySelector('.cselbtn'), lab = mount.querySelector('.lb');
    var box = mount.querySelector('.cselopts'), find = mount.querySelector('.cselfind input');
    var list = mount.querySelector('.colist');
    var val = mount.querySelector('.cval'), code = mount.querySelector('.ccode');

    var tick = '<svg class="tick" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" '
      + 'stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';

    /* Показываем имена по-человечески: в списке ACIS они капсом. */
    function nice(n) {
      return n.toLowerCase().replace(/(^|[\s\-\(\/])([a-z])/g, function (m, a, b) { return a + b.toUpperCase(); });
    }

    var shown = [];
    function draw(term) {
      var t = (term || '').trim().toLowerCase();
      // «russ» должно первым делом давать Россию, а не Byelorussia: начало имени важнее середины
      shown = t
        ? all.filter(function (c) { return c[1].toLowerCase().indexOf(t) >= 0; })
             .sort(function (a, b) {
               var ai = a[1].toLowerCase().indexOf(t), bi = b[1].toLowerCase().indexOf(t);
               return ai - bi || a[1].localeCompare(b[1]);
             })
        : all;
      hot = 0;
      list.innerHTML = shown.length
        ? shown.map(function (c, i) {
          return '<div class="o' + (c[0] === code.value ? ' sel' : '') + (i === 0 ? ' hot' : '')
            + '" role="option" data-c="' + c[0] + '"><span>' + nice(c[1]) + '</span>' + tick + '</div>';
        }).join('')
        : '<div class="cselnone">Nothing matches that</div>';
    }

    function pick(c) {
      cur = c;
      val.value = c[1]; code.value = c[0];
      lab.textContent = nice(c[1]);
      lab.classList.remove('ph');
      mount.classList.remove('open');
      mount.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function move(step) {
      var os = list.querySelectorAll('.o');
      if (!os.length) return;
      os[hot] && os[hot].classList.remove('hot');
      hot = (hot + step + os.length) % os.length;
      os[hot].classList.add('hot');
      os[hot].scrollIntoView({ block: 'nearest' });
    }

    list.addEventListener('click', function (e) {
      var o = e.target.closest('.o');
      if (!o) return;
      var c = shown.filter(function (x) { return x[0] === o.dataset.c; })[0];
      if (c) pick(c);
    });

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var open = mount.classList.toggle('open');
      if (open) {
        draw('');
        find.value = '';
        // на телефоне клавиатура поверх списка мешает больше, чем помогает
        if (!matchMedia('(pointer: coarse)').matches) setTimeout(function () { find.focus(); }, 40);
      }
    });
    find.addEventListener('input', function () { draw(this.value); });
    find.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); if (shown[hot]) pick(shown[hot]); }
      else if (e.key === 'Escape') mount.classList.remove('open');
    });
    box.addEventListener('click', function (e) { e.stopPropagation(); });
    document.addEventListener('click', function () { mount.classList.remove('open'); });

    return {
      value: function () { return val.value; },
      code: function () { return code.value; },
      set: function (c) {
        var hit = all.filter(function (x) { return x[0] === String(c || '').toUpperCase(); })[0];
        if (hit) pick(hit);
      },
      clear: function () {
        cur = -1; val.value = ''; code.value = '';
        lab.textContent = placeholder || 'Select country…';
        lab.classList.add('ph');
      },
    };
  };

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
