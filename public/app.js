/* Plant Care PWA — vanilla JS, no build step. */
(() => {
  const app = document.getElementById('app');
  const tabbar = document.getElementById('tabbar');
  let me = null; // /api/me payload
  let plants = [];

  // --- utilities -------------------------------------------------------------

  const h = (html) => {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content;
  };
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c]);

  async function api(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && !path.startsWith('/api/auth/')) {
      renderLogin();
      throw new Error('signed out');
    }
    if (!res.ok && !data.error) data.error = `Request failed (${res.status})`;
    return data;
  }

  let toastTimer;
  function toast(msg, isError = false) {
    document.querySelector('.toast')?.remove();
    const el = document.createElement('div');
    el.className = `toast${isError ? ' error' : ''}`;
    el.textContent = msg;
    document.body.appendChild(el);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.remove(), 2600);
  }

  const DAY = 86400;
  function dueLabel(ts) {
    if (ts == null) return '';
    const days = Math.ceil((ts - Date.now() / 1000) / DAY);
    if (days <= 0) return 'today';
    if (days === 1) return 'tomorrow';
    if (days < 7) {
      return new Date(ts * 1000).toLocaleDateString(undefined, { weekday: 'long' });
    }
    return new Date(ts * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  const isStandalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);

  // --- push ------------------------------------------------------------------

  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
  }

  async function enableReminders() {
    try {
      const reg = await navigator.serviceWorker.register('/sw.js');
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        toast('Notifications are blocked. Check Settings → Notifications.', true);
        return false;
      }
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(me.vapid_public_key),
      });
      const out = await api('POST', '/api/push/subscribe', sub.toJSON());
      if (!out.ok) throw new Error(out.error);
      toast('Reminders on — sending a test…');
      // Immediate proof the whole pipeline works, while the phone is in hand.
      api('POST', '/api/push/test').catch(() => {});
      return true;
    } catch (err) {
      toast(`Couldn't enable reminders: ${err.message}`, true);
      return false;
    }
  }

  async function pushEnabled() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return false;
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return false;
    return !!(await reg.pushManager.getSubscription());
  }

  // --- screens ---------------------------------------------------------------

  function setNav(active) {
    tabbar.hidden = false;
    tabbar.querySelectorAll('button').forEach((b) =>
      b.classList.toggle('active', b.dataset.nav === active)
    );
  }

  function renderLogin() {
    tabbar.hidden = true;
    app.replaceChildren(
      h(`
      <h1>Plant Care</h1>
      <p class="sub">Sign in to see your plants.</p>
      <label for="email">Email</label>
      <input id="email" type="email" autocomplete="email" placeholder="you@example.com" />
      <button id="send" class="primary bigbtn">Send me a code</button>
      <div id="codeStep" hidden>
        <label for="code" style="display:block;margin-top:18px">Enter the 6-digit code</label>
        <input id="code" class="code-input" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="one-time-code" />
        <button id="verify" class="primary bigbtn">Sign in</button>
      </div>
    `)
    );
    const email = app.querySelector('#email');
    email.value = localStorage.getItem('planta-email') || '';
    app.querySelector('#send').onclick = async () => {
      if (!email.value.trim()) return toast('Enter your email first.', true);
      localStorage.setItem('planta-email', email.value.trim());
      await api('POST', '/api/auth/request', { email: email.value });
      app.querySelector('#codeStep').hidden = false;
      app.querySelector('#code').focus();
      toast('Code sent — check your email');
    };
    app.querySelector('#verify').onclick = async () => {
      const out = await api('POST', '/api/auth/verify', {
        email: email.value,
        code: app.querySelector('#code').value,
      });
      if (!out.ok) return toast(out.error, true);
      await boot();
    };
  }

  function renderInstallInstructions() {
    tabbar.hidden = true;
    app.replaceChildren(
      h(`
      <h1>Almost there</h1>
      <p class="sub">To get reminders, this app needs to live on your home screen.</p>
      <ol class="install-steps">
        <li>Open this page in <strong>Safari</strong> (not from another app's browser)</li>
        <li>Tap the <strong>Share</strong> button at the bottom</li>
        <li>Scroll down, tap <strong>Add to Home Screen</strong></li>
        <li>Tap <strong>Add</strong></li>
        <li>Open <strong>Plants</strong> from your home screen — not from Safari</li>
        <li>Tap <strong>Turn on reminders</strong></li>
      </ol>
      <button id="skip" class="ghost bigbtn">Continue in the browser anyway</button>
    `)
    );
    app.querySelector('#skip').onclick = () => renderToday(true);
  }

  async function renderToday(skipInstallCheck = false) {
    if (isIOS && !isStandalone && !skipInstallCheck) return renderInstallInstructions();
    setNav('today');

    const data = await api('GET', '/api/plants');
    plants = data.plants || [];
    const due = plants.filter((p) => p.water_due || p.feed_due);

    const frag = h(`<h1>Today</h1><p class="sub" id="subline"></p><div id="list"></div>`);
    const list = frag.querySelector('#list');

    if (due.length === 0) {
      const upcoming = plants
        .filter((p) => p.next_water_due)
        .sort((a, b) => a.next_water_due - b.next_water_due)[0];
      frag.querySelector('#subline').remove();
      list.append(
        h(`
        <div class="empty">
          <span class="big">🌿</span>
          Nothing needs care today.
          ${upcoming ? `<br />Next up: <strong>${esc(upcoming.nickname)}</strong>, ${dueLabel(upcoming.next_water_due)}.` : ''}
        </div>
      `)
      );
    } else {
      frag.querySelector('#subline').textContent =
        `${due.length} plant${due.length === 1 ? '' : 's'} need${due.length === 1 ? 's' : ''} attention`;
      for (const p of due) {
        const tasks = [p.water_due && 'water', p.feed_due && 'feed'].filter(Boolean);
        const card = h(`
          <div class="card overdue checkrow" data-id="${p.id}">
            <input type="checkbox" aria-label="Done caring for ${esc(p.nickname)}" />
            <div class="info">
              <div class="name">${esc(p.nickname)}</div>
              <div class="meta">${tasks.map((t) => (t === 'water' ? '💧 Water' : '🌱 Feed')).join(' · ')}${p.location ? ` · ${esc(p.location)}` : ''}</div>
            </div>
          </div>
        `);
        const checkbox = card.querySelector('input');
        checkbox.onchange = async () => {
          checkbox.disabled = true;
          if (p.water_due) await api('POST', `/api/plants/${p.id}/care`, { kind: 'water' });
          if (p.feed_due) await api('POST', `/api/plants/${p.id}/care`, { kind: 'fertilize' });
          toast(p.water_due && p.feed_due ? 'Watered & fed' : p.water_due ? 'Watered' : 'Fed');
          setTimeout(() => renderToday(true), 350);
        };
        list.append(card);
      }
      const logAll = h(`<button class="primary bigbtn">Log all as done</button>`);
      logAll.querySelector('button').onclick = async () => {
        const water = due.filter((p) => p.water_due).map((p) => p.id);
        const feed = due.filter((p) => p.feed_due).map((p) => p.id);
        if (water.length) await api('POST', '/api/care/bulk', { plantIds: water, kind: 'water' });
        if (feed.length) await api('POST', '/api/care/bulk', { plantIds: feed, kind: 'fertilize' });
        toast('All logged');
        renderToday(true);
      };
      list.append(logAll);
    }

    // Reminder enablement banner.
    if (isStandalone || !isIOS) {
      if (!(await pushEnabled()) && 'Notification' in window) {
        const banner = h(`
          <div class="card">
            <div class="info">
              <div class="name">Turn on reminders</div>
              <div class="meta">One notification a day, only when something needs care.</div>
            </div>
            <button class="primary small" id="enable">Turn on</button>
          </div>
        `);
        banner.querySelector('#enable').onclick = async (e) => {
          e.target.disabled = true;
          const ok = await enableReminders();
          if (ok) renderToday(true);
          else e.target.disabled = false;
        };
        list.prepend(banner);
      }
    }

    app.replaceChildren(frag);
  }

  async function renderCollection() {
    setNav('collection');
    const data = await api('GET', '/api/plants');
    plants = (data.plants || []).sort(
      (a, b) => (a.next_water_due ?? Infinity) - (b.next_water_due ?? Infinity)
    );

    const frag = h(`<h1>Plants</h1><p class="sub">${plants.length} in your collection</p><div id="list"></div>`);
    const list = frag.querySelector('#list');
    if (plants.length === 0) {
      list.append(h(`<div class="empty"><span class="big">🪴</span>No plants yet.<br />Add your first one below.</div>`));
    }
    for (const p of plants) {
      const card = h(`
        <div class="card search-result" data-id="${p.id}">
          ${p.thumbnail ? `<img class="thumb" src="${esc(p.thumbnail)}" alt="" />` : `<div class="thumb">🪴</div>`}
          <div class="info">
            <div class="name">${esc(p.nickname)}</div>
            <div class="meta">💧 ${dueLabel(p.next_water_due)}${p.next_feed_due ? ` · 🌱 ${dueLabel(p.next_feed_due)}` : ''}${p.location ? ` · ${esc(p.location)}` : ''}</div>
          </div>
        </div>
      `);
      card.querySelector('.card').onclick = () => renderDetail(p.id);
      list.append(card);
    }
    app.replaceChildren(frag);
  }

  async function renderDetail(id) {
    const data = await api('GET', '/api/plants');
    const p = (data.plants || []).find((x) => x.id === id);
    if (!p) return renderCollection();

    const hist = await api('GET', `/api/plants/${id}/history`);
    const KIND_LABEL = { water: '💧 Watered', fertilize: '🌱 Fed', repot: '🪴 Repotted', note: '📝 Note' };

    const frag = h(`
      <button class="backlink" id="back">← All plants</button>
      <div class="detail-header">
        <div class="thumb">🪴</div>
        <div>
          <h1 style="margin:0">${esc(p.nickname)}</h1>
          <p class="sub" style="margin:0">${p.location ? esc(p.location) : ''}</p>
        </div>
      </div>
      <div class="row">
        <button class="primary" id="water">Log watering</button>
        <button id="feed" ${p.fertilize_interval_days == null ? 'disabled' : ''}>Log feeding</button>
      </div>
      <h2>Schedule</h2>
      <div class="kv"><span class="k">Next water</span><span>${dueLabel(p.next_water_due)}</span></div>
      <div class="kv"><span class="k">Next feed</span><span>${p.next_feed_due ? dueLabel(p.next_feed_due) : 'off'}</span></div>
      <h2>Settings</h2>
      <label>Water every (days)</label>
      <input id="wdays" type="number" min="1" inputmode="numeric" value="${p.water_interval_days}" />
      <label>Feed every (days) — winter pauses automatically</label>
      <input id="fdays" type="number" min="1" inputmode="numeric" value="${p.fertilize_interval_days ?? ''}" placeholder="off" />
      <label>Location</label>
      <input id="loc" value="${esc(p.location ?? '')}" placeholder="kitchen windowsill" />
      <button class="bigbtn" id="save">Save changes</button>
      <h2>History</h2>
      <div id="hist"></div>
      <button class="danger bigbtn" id="archive">Remove this plant</button>
    `);

    frag.querySelector('#back').onclick = () => renderCollection();
    frag.querySelector('#water').onclick = async () => {
      await api('POST', `/api/plants/${id}/care`, { kind: 'water' });
      toast('Watered');
      renderDetail(id);
    };
    frag.querySelector('#feed').onclick = async () => {
      await api('POST', `/api/plants/${id}/care`, { kind: 'fertilize' });
      toast('Fed');
      renderDetail(id);
    };
    frag.querySelector('#save').onclick = async () => {
      const out = await api('PATCH', `/api/plants/${id}`, {
        water_interval_days: Number(app.querySelector('#wdays').value),
        fertilize_interval_days: app.querySelector('#fdays').value === '' ? null : Number(app.querySelector('#fdays').value),
        location: app.querySelector('#loc').value,
      });
      if (!out.ok) return toast(out.error, true);
      toast('Saved');
      renderDetail(id);
    };
    frag.querySelector('#archive').onclick = async () => {
      if (!confirm(`Remove ${p.nickname}? You can ask Austin to bring it back.`)) return;
      await api('DELETE', `/api/plants/${id}`);
      toast('Removed');
      renderCollection();
    };

    const histEl = frag.querySelector('#hist');
    if (!hist.events?.length) {
      histEl.append(h(`<p class="sub">No history yet.</p>`));
    } else {
      for (const e of hist.events) {
        histEl.append(
          h(`<div class="history-item">${KIND_LABEL[e.kind] || e.kind} — ${new Date(e.occurred_at * 1000).toLocaleDateString()}</div>`)
        );
      }
    }
    app.replaceChildren(frag);
  }

  function renderAdd() {
    setNav('add');
    const frag = h(`
      <h1>Add a plant</h1>
      <p class="sub">Search by species, or skip straight to naming it.</p>
      <input id="q" placeholder="Search species… (e.g. monstera)" autocomplete="off" />
      <div id="results"></div>
      <div id="form"></div>
    `);

    let selected = null; // {id, common_name, thumbnail, water_days?} | null
    const qInput = frag.querySelector('#q');
    const results = frag.querySelector('#results');
    const form = frag.querySelector('#form');

    function showForm() {
      form.replaceChildren(
        h(`
        ${selected ? `<div class="card">${selected.thumbnail ? `<img class="thumb" src="${esc(selected.thumbnail)}" />` : '<div class="thumb">🌿</div>'}<div class="info"><div class="name">${esc(selected.common_name)}</div><div class="meta">${esc(selected.scientific_name ?? '')}</div></div><button class="ghost small" id="clear">✕</button></div>` : ''}
        <label>Name it</label>
        <input id="nick" placeholder="kitchen monstera" />
        <label>Where does it live?</label>
        <input id="loc" placeholder="bedroom windowsill (optional)" />
        <div class="row">
          <div>
            <label>Water every (days)</label>
            <input id="wdays" type="number" min="1" inputmode="numeric" value="${selected?.water_days ?? ''}" placeholder="7" />
          </div>
          <div>
            <label>Feed every (days)</label>
            <input id="fdays" type="number" min="1" inputmode="numeric" value="28" />
          </div>
        </div>
        <label>Last watered (optional — leave blank for today)</label>
        <input id="lastw" type="date" max="${new Date().toISOString().slice(0, 10)}" />
        <button class="primary bigbtn" id="create">Add plant</button>
      `)
      );
      form.querySelector('#clear')?.addEventListener('click', () => {
        selected = null;
        showForm();
      });
      form.querySelector('#create').onclick = async () => {
        const nickname = form.querySelector('#nick').value.trim();
        if (!nickname) return toast('Give it a name first.', true);
        const body = {
          nickname,
          location: form.querySelector('#loc').value.trim() || null,
          perenual_id: selected?.id ?? null,
        };
        const wdays = form.querySelector('#wdays').value;
        if (wdays) body.water_interval_days = Number(wdays);
        const fdays = form.querySelector('#fdays').value;
        body.fertilize_interval_days = fdays === '' ? null : Number(fdays);
        const lastw = form.querySelector('#lastw').value;
        if (lastw) {
          // Local midday, so the date stays right regardless of timezone.
          body.last_watered = Math.floor(new Date(`${lastw}T12:00:00`).getTime() / 1000);
        }
        const out = await api('POST', '/api/plants', body);
        if (!out.ok) return toast(out.error, true);
        if (body.perenual_id && !out.species_found) {
          toast("Couldn't reach the plant database — added with your settings.");
        } else {
          toast(`${nickname} added`);
        }
        renderCollection();
      };
    }
    showForm();

    let debounce;
    qInput.oninput = (e) => {
      clearTimeout(debounce);
      const q = e.target.value.trim();
      if (q.length < 3) {
        results.replaceChildren();
        return;
      }
      debounce = setTimeout(async () => {
        const out = await api('GET', `/api/species/search?q=${encodeURIComponent(q)}`);
        results.replaceChildren();
        if (out.error === 'unavailable') {
          results.append(h(`<p class="sub">Couldn't reach the plant database. Add it manually below and we'll fill in details later.</p>`));
          return;
        }
        for (const r of (out.results || []).slice(0, 6)) {
          const row = h(`
            <div class="card search-result">
              ${r.thumbnail ? `<img class="thumb" src="${esc(r.thumbnail)}" alt="" />` : '<div class="thumb">🌿</div>'}
              <div class="info">
                <div class="name">${esc(r.common_name)}</div>
                <div class="meta">${esc(r.scientific_name ?? '')}</div>
              </div>
            </div>
          `);
          row.querySelector('.card').onclick = async () => {
            selected = r;
            results.replaceChildren();
            qInput.value = '';
            // Pull details so the watering interval can prefill. Not all
            // species have data — fall back honestly rather than guessing.
            const detail = await api('GET', `/api/species/${r.id}`).catch(() => null);
            selected.water_days = detail?.species?.water_days ?? null;
            showForm();
            if (selected.water_days == null) {
              toast('No watering data for this species — set your own interval.');
            }
            form.querySelector('#nick').focus();
          };
          results.append(row);
        }
      }, 300);
    };

    app.replaceChildren(frag);
  }

  // --- boot ------------------------------------------------------------------

  tabbar.addEventListener('click', (e) => {
    const nav = e.target.dataset?.nav;
    if (nav === 'today') renderToday(true);
    if (nav === 'collection') renderCollection();
    if (nav === 'add') renderAdd();
  });

  async function boot() {
    const out = await api('GET', '/api/me').catch(() => null);
    if (!out?.ok) return; // 401 already routed to renderLogin
    me = out;
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
    renderToday();
  }

  boot();
})();
