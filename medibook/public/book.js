(() => {
  const slug = decodeURIComponent(location.pathname.split('/')[2] || '');
  const api = (p) => `/api/c/${encodeURIComponent(slug)}${p}`;
  const $ = (id) => document.getElementById(id);
  let doctors = [];
  let chosen = null;

  $('chat-link').href = `/c/${encodeURIComponent(slug)}`;

  async function call(url, opts = {}) {
    const res = await fetch(url, { ...opts, headers: { 'content-type': 'application/json' } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || 'Something went wrong.');
    return data;
  }

  function todayIn(tz) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date()).map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}`;
  }

  function prettyDate(d) {
    const [y, m, day] = d.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, day)).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
  }

  async function init() {
    try {
      const data = await call(api(''));
      doctors = data.doctors;
      document.title = `Book · ${data.clinic.name}`;
      $('clinic-name').textContent = data.clinic.name;
      $('clinic-meta').textContent = [data.clinic.address, data.clinic.phone].filter(Boolean).join(' · ');
      $('emergency').textContent = `In a medical emergency, call ${data.clinic.emergency_number} immediately.`;
      $('doctor').innerHTML = '';
      for (const d of doctors) {
        const o = document.createElement('option');
        o.value = d.id;
        o.textContent = d.specialty ? `${d.name} — ${d.specialty}` : d.name;
        $('doctor').appendChild(o);
      }
      const today = todayIn(data.clinic.timezone);
      $('date').min = today;
      $('date').value = today;
      loadSlots();
    } catch (e) {
      $('book-card').textContent = e.message;
    }
  }

  async function loadSlots() {
    chosen = null;
    $('patient-fields').classList.add('hidden');
    const doctor = doctors.find((d) => String(d.id) === $('doctor').value);
    $('doctor-bio').textContent = doctor?.bio || '';
    if (!doctor || !$('date').value) return;
    const area = $('slots-area');
    area.innerHTML = '<p class="muted small">Loading open times…</p>';
    try {
      const days = await call(api(`/slots?doctor_id=${doctor.id}&from=${$('date').value}`));
      area.textContent = '';
      if (!days.length) {
        area.innerHTML = '<p class="muted small">No open times this week. Try a later date or another doctor.</p>';
        return;
      }
      for (const day of days) {
        const label = document.createElement('p');
        label.className = 'day-label';
        label.textContent = prettyDate(day.date);
        const wrap = document.createElement('div');
        wrap.className = 'slots';
        for (const t of day.times) {
          const b = document.createElement('button');
          b.type = 'button';
          b.textContent = t;
          b.setAttribute('aria-pressed', 'false');
          b.addEventListener('click', () => {
            area.querySelectorAll('[aria-pressed="true"]').forEach((x) => x.setAttribute('aria-pressed', 'false'));
            b.setAttribute('aria-pressed', 'true');
            chosen = { doctor_id: doctor.id, start: `${day.date}T${t}` };
            $('patient-fields').classList.remove('hidden');
            $('name').focus();
          });
          wrap.appendChild(b);
        }
        area.append(label, wrap);
      }
    } catch (e) {
      area.innerHTML = '';
      const p = document.createElement('p');
      p.className = 'notice error';
      p.textContent = e.message;
      area.appendChild(p);
    }
  }

  $('doctor').addEventListener('change', loadSlots);
  $('date').addEventListener('change', loadSlots);

  $('book-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!chosen) return;
    $('book-error').classList.add('hidden');
    $('book-btn').disabled = true;
    try {
      const appt = await call(api('/appointments'), {
        method: 'POST',
        body: JSON.stringify({ ...chosen, name: $('name').value, phone: $('phone').value, email: $('email').value, reason: $('reason').value }),
      });
      $('book-form').classList.add('hidden');
      $('booked').classList.remove('hidden');
      $('booked-code').textContent = appt.confirmation_code;
      $('booked-when').textContent = `${appt.when} with ${appt.doctor}`;
    } catch (err) {
      $('book-error').textContent = err.message;
      $('book-error').classList.remove('hidden');
      loadSlots();
    } finally {
      $('book-btn').disabled = false;
    }
  });

  $('book-another').addEventListener('click', () => {
    $('booked').classList.add('hidden');
    $('book-form').classList.remove('hidden');
    $('book-form').reset();
    init();
  });

  function manageMsg(text, isError) {
    $('manage-msg').textContent = text;
    $('manage-msg').className = `notice${isError ? ' error' : ''}`;
  }

  $('manage-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('manage-result').classList.add('hidden');
    $('manage-msg').classList.add('hidden');
    try {
      const a = await call(api('/appointments/lookup'), {
        method: 'POST', body: JSON.stringify({ code: $('m-code').value, phone: $('m-phone').value }),
      });
      $('m-details').textContent = `${a.when} with ${a.doctor} — status: ${a.status}`;
      $('m-cancel').classList.toggle('hidden', a.status !== 'booked');
      $('manage-result').classList.remove('hidden');
    } catch (err) { manageMsg(err.message, true); }
  });

  $('m-cancel').addEventListener('click', async () => {
    if (!confirm('Cancel this appointment?')) return;
    try {
      await call(api('/appointments/cancel'), {
        method: 'POST', body: JSON.stringify({ code: $('m-code').value, phone: $('m-phone').value }),
      });
      $('manage-result').classList.add('hidden');
      manageMsg('Your appointment has been cancelled.');
      loadSlots();
    } catch (err) { manageMsg(err.message, true); }
  });

  init();
})();
