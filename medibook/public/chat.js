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
    u.lang = document.documentElement.lang || navigator.language || 'en-US';
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

  let greeting = 'Hi! I can book, reschedule or cancel an appointment for you. How can I help?';

  async function init() {
    try {
      const res = await fetch(`/api/c/${encodeURIComponent(slug)}`);
      if (!res.ok) throw new Error('not found');
      const data = await res.json();
      document.title = `Book · ${data.clinic.name}`;
      $('clinic-name').textContent = data.clinic.name;
      $('emergency').textContent = `Medical emergency? Call ${data.clinic.emergency_number} now. Do not use this chat.`;
      greeting = `Hi! I'm the booking assistant for ${data.clinic.name}. I can book, reschedule or cancel an appointment. How can I help?`;
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
    add('bot', sessionId
      ? 'Welcome back. You can continue where you left off, or press "New chat" to start over.'
      : greeting);
  }

  async function send(text) {
    text = text.trim();
    if (!text || busy) return;
    busy = true;
    sendBtn.disabled = true;
    $('suggestions').classList.add('hidden');
    add('user', text);
    input.value = '';
    const typing = add('typing', 'Assistant is typing…');
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
    add('bot', greeting);
  }

  $('composer').addEventListener('submit', (e) => { e.preventDefault(); send(input.value); });
  $('suggestions').addEventListener('click', (e) => { if (e.target.tagName === 'BUTTON') send(e.target.textContent); });
  $('new-chat').addEventListener('click', resetChat);

  // Voice input via the browser's speech recognition (Chrome, Edge, Safari).
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (Recognition) {
    micBtn.classList.remove('hidden');
    const rec = new Recognition();
    rec.lang = navigator.language || 'en-US';
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
