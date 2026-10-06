(() => {
  const slug = decodeURIComponent(location.pathname.split('/')[2] || '');
  const $ = (id) => document.getElementById(id);
  const messagesEl = $('messages');
  const input = $('input');
  const sendBtn = $('send');
  const micBtn = $('mic');
  const speakBtn = $('speak-toggle');
  const storageKey = `medibook:${slug}:session`;
  let sessionId = load(storageKey);
  let speakReplies = false;
  let busy = false;
  let clinic = null;
  let languages = ['en-IN'];
  let lang = 'en-IN'; // UI language: microphone recognition, spoken replies, greeting

  // Patient-facing text. Tamil should be reviewed by a native speaker before launch.
  const T = {
    'en-IN': {
      greeting: (c) => `Hi! I'm the booking assistant for ${c.name}. I can book, reschedule or cancel an appointment. How can I help?`,
      welcomeBack: 'Welcome back. You can continue where you left off, or press "New chat" to start over.',
      suggestions: ['Book an appointment', 'Reschedule my appointment', 'Cancel my appointment'],
      placeholder: 'Type your message…',
      emergency: (c) => `Medical emergency? Call ${c.emergency_number} now. Do not use this chat.`,
      typing: 'Assistant is typing…',
      other: 'தமிழ்',
    },
    'ta-IN': {
      greeting: (c) => `வணக்கம்! நான் ${c.name} முன்பதிவு உதவியாளர். Appointment புக் செய்ய, மாற்ற அல்லது ரத்து செய்ய உதவுவேன். எப்படி உதவலாம்?`,
      welcomeBack: 'மீண்டும் வருக. நிறுத்திய இடத்திலிருந்து தொடரலாம், அல்லது "New chat" அழுத்தவும்.',
      suggestions: ['Appointment புக் செய்ய வேண்டும்', 'என் appointment நேரத்தை மாற்ற வேண்டும்', 'என் appointment-ஐ ரத்து செய்ய வேண்டும்'],
      placeholder: 'உங்கள் செய்தியை தட்டச்சு செய்யவும்…',
      emergency: (c) => `அவசர மருத்துவ உதவியா? உடனே ${c.emergency_number} க்கு அழைக்கவும். இந்த chat-ஐ பயன்படுத்த வேண்டாம்.`,
      typing: 'உதவியாளர் பதில் எழுதுகிறார்…',
      other: 'English',
    },
  };
  const t = () => T[lang] ?? T['en-IN'];

  function applyLanguage() {
    document.documentElement.lang = lang.slice(0, 2);
    input.placeholder = t().placeholder;
    const chips = $('suggestions').querySelectorAll('button');
    t().suggestions.forEach((text, i) => { if (chips[i]) chips[i].textContent = text; });
    if (clinic) $('emergency').textContent = t().emergency(clinic);
    $('lang-toggle').textContent = t().other;
    $('lang-toggle').classList.toggle('hidden', languages.length < 2);
    if (rec) rec.lang = lang;
  }

  $('form-link').href = `/c/${encodeURIComponent(slug)}/book`;

  function load(k) { try { return sessionStorage.getItem(k); } catch { return null; } }
  function save(k, v) { try { v ? sessionStorage.setItem(k, v) : sessionStorage.removeItem(k); } catch { /* ignore */ } }

  function add(role, text) {
    const div = document.createElement('div');
    div.className = `msg ${role}`;
    div.textContent = text;
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return div;
  }

  function speak(text) {
    if (!speakReplies || !('speechSynthesis' in window)) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = /[\u0B80-\u0BFF]/.test(text) ? 'ta-IN' : lang;
    speechSynthesis.speak(u);
  }

  function setSpeak(on) {
    speakReplies = on;
    speakBtn.setAttribute('aria-pressed', String(on));
    speakBtn.textContent = on ? '🔊 Voice on' : '🔈 Voice';
    if (!on && 'speechSynthesis' in window) speechSynthesis.cancel();
  }
  speakBtn.addEventListener('click', () => setSpeak(!speakReplies));
  if (!('speechSynthesis' in window)) speakBtn.classList.add('hidden');

  async function init() {
    try {
      const res = await fetch(`/api/c/${encodeURIComponent(slug)}`);
      if (!res.ok) throw new Error('not found');
      const data = await res.json();
      document.title = `Book · ${data.clinic.name}`;
      $('clinic-name').textContent = data.clinic.name;
      clinic = data.clinic;
      languages = (data.languages || ['en-IN']).filter((l) => T[l]);
      if (!languages.length) languages = ['en-IN'];
      lang = languages[0];
      applyLanguage();
      if (!data.ai_enabled) {
        add('error', 'The chat assistant is offline right now. Please use the booking form below.');
        input.disabled = sendBtn.disabled = true;
        $('suggestions').classList.add('hidden');
        return;
      }
    } catch {
      add('error', 'This clinic could not be found.');
      input.disabled = sendBtn.disabled = true;
      return;
    }
    add('bot', sessionId ? t().welcomeBack : t().greeting(clinic));
  }

  async function send(text) {
    text = text.trim();
    if (!text || busy) return;
    busy = true;
    sendBtn.disabled = true;
    $('suggestions').classList.add('hidden');
    add('user', text);
    input.value = '';
    const typing = add('typing', t().typing);
    typing.className = 'typing';
    try {
      const res = await fetch(`/api/c/${encodeURIComponent(slug)}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: text, session_id: sessionId }),
      });
      const data = await res.json().catch(() => ({}));
      typing.remove();
      if (!res.ok) {
        add('error', data.message || 'Sorry, something went wrong. Please try again.');
        if (data.error === 'SESSION_FULL') resetChat();
        return;
      }
      sessionId = data.session_id;
      save(storageKey, sessionId);
      add('bot', data.reply);
      speak(data.reply);
    } catch {
      typing.remove();
      add('error', 'Network problem. Please check your connection and try again.');
    } finally {
      busy = false;
      sendBtn.disabled = false;
      input.focus();
    }
  }

  function resetChat() {
    sessionId = null;
    save(storageKey, null);
    messagesEl.textContent = '';
    $('suggestions').classList.remove('hidden');
    if (clinic) add('bot', t().greeting(clinic));
  }

  $('lang-toggle').addEventListener('click', () => {
    lang = languages.find((l) => l !== lang) ?? lang;
    applyLanguage();
    // Greet again in the new language if the conversation hasn't started.
    if (!sessionId && clinic) { messagesEl.textContent = ''; add('bot', t().greeting(clinic)); }
  });

  $('composer').addEventListener('submit', (e) => { e.preventDefault(); send(input.value); });
  $('suggestions').addEventListener('click', (e) => { if (e.target.tagName === 'BUTTON') send(e.target.textContent); });
  $('new-chat').addEventListener('click', resetChat);

  // Voice input via the browser's speech recognition (Chrome, Edge, Safari).
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const rec = Recognition ? new Recognition() : null;
  if (rec) {
    micBtn.classList.remove('hidden');
    rec.lang = lang;
    rec.interimResults = true;
    let listening = false;
    rec.onresult = (e) => {
      const r = e.results[e.results.length - 1];
      input.value = r[0].transcript;
      if (r.isFinal) send(input.value);
    };
    rec.onend = () => { listening = false; micBtn.classList.remove('listening'); };
    rec.onerror = () => { listening = false; micBtn.classList.remove('listening'); };
    micBtn.addEventListener('click', () => {
      if (listening) { rec.stop(); return; }
      setSpeak(true); // someone talking to us probably wants to hear the answer
      if ('speechSynthesis' in window) speechSynthesis.cancel();
      try { rec.start(); listening = true; micBtn.classList.add('listening'); } catch { /* already started */ }
    });
  }

  init();
})();
