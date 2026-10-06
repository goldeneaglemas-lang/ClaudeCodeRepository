(() => {
  const $ = (id) => document.getElementById(id);
  const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  let clinic = null;
  let doctors = [];

  async function call(path, opts = {}) {
    const res = await fetch(`/api/admin${path}`, {
      ...opts,
      headers: { 'content-type': 'application/json' },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && path !== '/login') { showLogin(); throw new Error('Please log in.'); }
    if (!res.ok) throw new Error(data.message || 'Something went wrong.');
    return data;
  }

  function flash(text, isError = false) {
    const el = $('flash');
    el.textContent = text;
    el.className = `notice${isError ? ' error' : ''}`;
    clearTimeout(flash.t);
    flash.t = setTimeout(() => el.classList.add('hidden'), 5000);
  }

  const cell = (text) => { const td = document.createElement('td'); td.textContent = text ?? ''; return td; };
  const button = (label, cls, onClick) => {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = label; if (cls) b.className = cls;
    b.addEventListener('click', onClick);
    return b;
  };

  function todayLocal() {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: clinic.timezone, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date()).map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}`;
  }
  const addDays = (d, n) => { const [y, m, dd] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd + n)).toISOString().slice(0, 10); };
  const pretty = (local) => {
    const [d, t] = local.split('T');
    const [y, m, dd] = d.split('-').map(Number);
    return `${new Date(Date.UTC(y, m - 1, dd)).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })} ${t}`;
  };

  // ---------- auth ----------
  function showLogin() {
    $('app').classList.add('hidden');
    $('login').classList.remove('hidden');
  }

  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('login-error').classList.add('hidden');
    try {
      await call('/login', { method: 'POST', body: { slug: $('l-slug').value.trim(), password: $('l-pass').value } });
      $('l-pass').value = '';
      start();
    } catch (err) {
      $('login-error').textContent = err.message;
      $('login-error').classList.remove('hidden');
    }
  });

  $('logout').addEventListener('click', async () => { await call('/logout', { method: 'POST' }).catch(() => {}); showLogin(); });

  // ---------- tabs ----------
  document.querySelector('.tabs').addEventListener('click', (e) => {
    const tab = e.target.dataset?.tab;
    if (!tab) return;
    document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    document.querySelectorAll('[data-panel]').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== tab));
    if (tab === 'timeoff') loadTimeOff();
    if (tab === 'calls') loadCalls();
  });

  // ---------- appointments ----------
  async function loadAppointments() {
    const q = new URLSearchParams({ from: $('a-from').value, to: $('a-to').value });
    if ($('a-doctor').value) q.set('doctor_id', $('a-doctor').value);
    if ($('a-status').value) q.set('status', $('a-status').value);
    try {
      const rows = await call(`/appointments?${q}`);
      const tbody = $('a-rows');
      tbody.textContent = '';
      $('a-empty').classList.toggle('hidden', rows.length > 0);
      for (const a of rows) {
        const tr = document.createElement('tr');
        const status = document.createElement('td');
        const badge = document.createElement('span');
        badge.className = `badge ${a.status}`; badge.textContent = a.status.replace('_', '-');
        status.appendChild(badge);
        const patient = cell(a.patient_name);
        patient.appendChild(document.createElement('br'));
        const contact = document.createElement('span');
        contact.className = 'muted small';
        contact.textContent = [a.patient_phone, a.patient_email].filter(Boolean).join(' · ');
        patient.appendChild(contact);
        const actions = document.createElement('td');
        actions.className = 'actions';
        const setStatus = (s, confirmText) => async () => {
          if (confirmText && !confirm(confirmText)) return;
          try { await call(`/appointments/${a.id}/status`, { method: 'POST', body: { status: s } }); loadAppointments(); }
          catch (err) { flash(err.message, true); }
        };
        if (a.status === 'booked') {
          actions.append(
            button('Done', 'secondary', setStatus('completed')),
            button('No-show', 'secondary', setStatus('no_show')),
            button('Cancel', 'danger', setStatus('cancelled', `Cancel ${a.patient_name}'s appointment?`)),
          );
        } else {
          actions.append(button('Restore', 'secondary', setStatus('booked')));
        }
        tr.append(cell(pretty(a.start_local)), cell(a.doctor_name), patient, cell(a.reason), status, cell(`${a.code} · ${a.source.replace('_', ' ')}`), actions);
        tbody.appendChild(tr);
      }
    } catch (err) { flash(err.message, true); }
  }
  ['a-from', 'a-to', 'a-doctor', 'a-status'].forEach((id) => $(id).addEventListener('change', loadAppointments));
  $('a-refresh').addEventListener('click', loadAppointments);

  $('manual-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const a = await call('/appointments', {
        method: 'POST',
        body: { doctor_id: Number($('mf-doctor').value), start: $('mf-start').value, name: $('mf-name').value, phone: $('mf-phone').value, reason: $('mf-reason').value },
      });
      flash(`Booked ${a.when} with ${a.doctor}. Code ${a.confirmation_code}.`);
      e.target.reset();
      loadAppointments();
    } catch (err) { flash(err.message, true); }
  });

  // ---------- doctors ----------
  function fillDoctorSelects() {
    const fill = (sel, withAll) => {
      const prev = sel.value;
      sel.textContent = '';
      if (withAll) sel.appendChild(new Option('All doctors', ''));
      for (const d of doctors) if (d.active || withAll) sel.appendChild(new Option(d.name, d.id));
      if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
    };
    fill($('a-doctor'), true);
    fill($('mf-doctor'), false);
    fill($('t-doctor'), false);
  }

  async function loadDoctors() {
    doctors = await call('/doctors');
    fillDoctorSelects();
    const tbody = $('d-rows');
    tbody.textContent = '';
    for (const d of doctors) {
      const tr = document.createElement('tr');
      const act = document.createElement('td');
      act.appendChild(button('Edit', 'secondary', () => editDoctor(d)));
      tr.append(cell(d.name), cell(d.specialty), cell(`${d.slot_minutes} min`), cell(d.active ? 'Yes' : 'No'), act);
      tbody.appendChild(tr);
    }
  }

  function renderHoursInputs(wh = {}) {
    const grid = $('df-hours');
    grid.textContent = '';
    for (const day of DAYS) {
      const label = document.createElement('span');
      label.textContent = day;
      const input = document.createElement('input');
      input.id = `df-h-${day}`;
      input.setAttribute('aria-label', `${day} hours`);
      input.placeholder = 'closed';
      input.value = (wh[day] || []).map(([s, e]) => `${s}-${e}`).join(', ');
      grid.append(label, input);
    }
  }

  function parseHours() {
    const out = {};
    for (const day of DAYS) {
      const raw = $(`df-h-${day}`).value.trim();
      if (!raw) continue;
      out[day] = raw.split(',').map((part) => {
        const m = /^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(part);
        if (!m) throw new Error(`Couldn't read "${part.trim()}" for ${day}. Use 09:00-13:00.`);
        return [`${m[1].padStart(2, '0')}:${m[2]}`, `${m[3].padStart(2, '0')}:${m[4]}`];
      });
    }
    return out;
  }

  function editDoctor(d) {
    $('df-title').textContent = d ? `Edit ${d.name}` : 'Add a doctor';
    $('df-id').value = d?.id ?? '';
    $('df-name').value = d?.name ?? '';
    $('df-specialty').value = d?.specialty ?? '';
    $('df-bio').value = d?.bio ?? '';
    $('df-slot').value = d?.slot_minutes ?? 15;
    $('df-active').checked = d ? d.active : true;
    renderHoursInputs(d?.working_hours);
    if (d) $('doctor-form').scrollIntoView({ behavior: 'smooth' });
  }
  $('df-reset').addEventListener('click', () => editDoctor(null));

  $('doctor-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const body = {
        name: $('df-name').value, specialty: $('df-specialty').value, bio: $('df-bio').value,
        slot_minutes: Number($('df-slot').value), working_hours: parseHours(), active: $('df-active').checked,
      };
      const id = $('df-id').value;
      await call(id ? `/doctors/${id}` : '/doctors', { method: id ? 'PUT' : 'POST', body });
      flash('Doctor saved.');
      editDoctor(null);
      loadDoctors();
    } catch (err) { flash(err.message, true); }
  });

  // ---------- time off ----------
  async function loadTimeOff() {
    try {
      const rows = await call('/time-off');
      const tbody = $('t-rows');
      tbody.textContent = '';
      const fmt = (iso) => new Date(iso).toLocaleString(undefined, { timeZone: clinic.timezone, dateStyle: 'medium', timeStyle: 'short' });
      for (const t of rows) {
        const tr = document.createElement('tr');
        const act = document.createElement('td');
        act.appendChild(button('Remove', 'danger', async () => {
          await call(`/time-off/${t.id}`, { method: 'DELETE' }).catch((err) => flash(err.message, true));
          loadTimeOff();
        }));
        tr.append(cell(doctors.find((d) => d.id === t.doctor_id)?.name), cell(fmt(t.start_at)), cell(fmt(t.end_at)), cell(t.reason), act);
        tbody.appendChild(tr);
      }
    } catch (err) { flash(err.message, true); }
  }

  $('timeoff-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await call('/time-off', { method: 'POST', body: { doctor_id: Number($('t-doctor').value), start: $('t-start').value, end: $('t-end').value, reason: $('t-reason').value } });
      flash('Time blocked.');
      e.target.reset();
      loadTimeOff();
    } catch (err) { flash(err.message, true); }
  });

  // ---------- phone calls ----------
  const OUTCOMES = { booked: 'Booked', transferred: 'Transferred', completed: 'Completed', no_input: 'No response', '': 'In progress' };

  async function loadCalls() {
    try {
      const calls = await call('/calls');
      const tbody = $('c-rows');
      tbody.textContent = '';
      $('c-empty').classList.toggle('hidden', calls.length > 0);
      const booked = calls.filter((c) => c.bookings > 0).length;
      $('c-summary').textContent = calls.length
        ? `Last ${calls.length} calls: ${booked} led to a booking, ${calls.filter((c) => c.outcome === 'transferred').length} transferred to staff.`
        : '';
      for (const c of calls) {
        const tr = document.createElement('tr');
        const when = new Date(c.started_at).toLocaleString(undefined, { timeZone: clinic.timezone, dateStyle: 'medium', timeStyle: 'short' });
        const len = c.duration_seconds ? `${Math.floor(c.duration_seconds / 60)}m ${c.duration_seconds % 60}s` : '—';
        const outcome = document.createElement('td');
        const badge = document.createElement('span');
        badge.className = `badge ${c.outcome === 'booked' ? 'booked' : ''}`;
        badge.textContent = OUTCOMES[c.outcome] ?? c.outcome;
        outcome.appendChild(badge);
        const act = document.createElement('td');
        act.appendChild(button('Transcript', 'secondary', () => showTranscript(c)));
        tr.append(cell(when), cell(c.from_number || 'Unknown'), cell(len), cell(c.turns), outcome, act);
        tbody.appendChild(tr);
      }
    } catch (err) { flash(err.message, true); }
  }

  async function showTranscript(c) {
    try {
      const { transcript } = await call(`/calls/${encodeURIComponent(c.call_sid)}/transcript`);
      const box = $('c-transcript');
      box.textContent = '';
      $('c-transcript-title').textContent = `Transcript — ${c.from_number || 'Unknown caller'}`;
      if (!transcript.length) box.textContent = 'No transcript (deleted after the retention period, or the caller said nothing).';
      for (const line of transcript) {
        const p = document.createElement('p');
        if (line.speaker === 'action') {
          p.className = 'muted small';
          p.textContent = `⚙ ${line.text}`;
        } else {
          const who = document.createElement('strong');
          who.textContent = line.speaker === 'caller' ? 'Caller: ' : 'Assistant: ';
          p.append(who, line.text);
        }
        box.appendChild(p);
      }
      $('c-transcript-card').classList.remove('hidden');
      $('c-transcript-card').scrollIntoView({ behavior: 'smooth' });
    } catch (err) { flash(err.message, true); }
  }

  // ---------- settings ----------
  function fillSettings() {
    $('s-name').value = clinic.name;
    $('s-phone').value = clinic.phone;
    $('s-address').value = clinic.address;
    $('s-tz').value = clinic.timezone;
    $('s-emergency').value = clinic.emergency_number;
    $('s-notice').value = clinic.min_notice_minutes;
    $('s-horizon').value = clinic.booking_horizon_days;
    $('s-notes').value = clinic.assistant_notes;
    $('s-voice-number').value = clinic.voice_number;
    $('s-transfer').value = clinic.transfer_number;
    if (![...$('s-voice-lang').options].some((o) => o.value === clinic.voice_language)) {
      $('s-voice-lang').appendChild(new Option(clinic.voice_language, clinic.voice_language));
    }
    $('s-voice-lang').value = clinic.voice_language;
    $('s-voice-name').value = clinic.voice_name;
  }

  $('settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const body = {
        name: $('s-name').value, phone: $('s-phone').value, address: $('s-address').value, timezone: $('s-tz').value.trim(),
        emergency_number: $('s-emergency').value, min_notice_minutes: Number($('s-notice').value),
        booking_horizon_days: Number($('s-horizon').value), assistant_notes: $('s-notes').value,
        voice_number: $('s-voice-number').value, transfer_number: $('s-transfer').value,
        voice_language: $('s-voice-lang').value, voice_name: $('s-voice-name').value.trim(),
      };
      if ($('s-pass').value) body.new_password = $('s-pass').value;
      clinic = await call('/clinic', { method: 'PUT', body });
      $('s-pass').value = '';
      $('h-clinic').textContent = clinic.name;
      flash('Settings saved.');
    } catch (err) { flash(err.message, true); }
  });

  // ---------- start ----------
  async function start() {
    try {
      clinic = await call('/me');
    } catch { return; }
    $('login').classList.add('hidden');
    $('app').classList.remove('hidden');
    $('h-clinic').textContent = clinic.name;
    const base = location.origin;
    $('open-chat').href = `/c/${clinic.slug}`;
    $('embed-snippet').textContent = `<script src="${base}/widget.js" data-clinic="${clinic.slug}" async></script>`;
    $('embed-links').textContent = `Chat with AI assistant: ${base}/c/${clinic.slug}\nBooking form:           ${base}/c/${clinic.slug}/book`;
    const today = todayLocal();
    $('a-from').value = today;
    $('a-to').value = addDays(today, 6);
    fillSettings();
    editDoctor(null);
    await loadDoctors().catch((err) => flash(err.message, true));
    loadAppointments();
  }

  start();
})();
