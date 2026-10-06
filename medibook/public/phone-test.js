// Browser stand-in for an Exotel phone call: same WebSocket protocol, 8 kHz 16-bit PCM both ways.
// Also runs a setup check (browser, microphone, server keys, Claude, Sarvam) so problems are named.
(() => {
  const $ = (id) => document.getElementById(id);
  const slug = new URLSearchParams(location.search).get('clinic') || '';
  const RATE = 8000;
  let ws, ctx, stream, node, sendTimer;
  let captured = [];
  let playAt = 0;
  let sources = [];
  let markTimers = [];

  const status = (text, isError = false) => { $('status').textContent = text; $('status').className = `notice${isError ? ' error' : ''}`; };

  function log(kind, text) {
    if ($('log').firstElementChild?.classList.contains('muted')) $('log').textContent = '';
    const p = document.createElement('p');
    if (kind === 'error') {
      p.className = 'notice error';
      p.textContent = `Problem: ${text}`;
    } else {
      const who = document.createElement('strong');
      who.textContent = kind === 'caller' ? 'You: ' : 'Assistant: ';
      p.append(who, text);
    }
    $('log').appendChild(p);
    p.scrollIntoView({ block: 'nearest' });
  }

  // ---------- setup checks ----------

  function browserProblem() {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      return `Browsers only allow the microphone on https:// pages or on http://localhost, and this page is ${location.origin}. ` +
        'Open http://localhost:3000 on the computer running the server, or put the server behind HTTPS.';
    }
    if (!window.AudioContext || !window.AudioWorkletNode) return 'This browser is too old for test calls. Use a recent Chrome, Edge or Firefox.';
    if (!window.WebSocket) return 'This browser does not support WebSockets.';
    return null;
  }

  async function serverStatus() {
    const res = await fetch('/api/admin/voice-status');
    if (res.status === 401) return { problem: 'You are not logged in. Log in to the dashboard (/admin) in this browser first, then reopen this page.' };
    if (!res.ok) return { problem: `The server answered ${res.status}. Check the server terminal for errors.` };
    const v = await res.json();
    const missing = [!v.ai && 'ANTHROPIC_API_KEY', !v.speech && 'SARVAM_API_KEY'].filter(Boolean);
    if (!missing.length) return {};
    const many = missing.length > 1;
    return {
      problem: `${missing.join(' and ')} ${many ? 'are' : 'is'} not set on the server. Stop the server (Ctrl+C), ` +
        `set ${many ? 'them' : 'it'} in the same terminal window, then run npm start again.`,
    };
  }

  function addCheck(ok, name, text) {
    const li = document.createElement('li');
    li.className = ok ? 'ok' : 'bad';
    const b = document.createElement('strong');
    b.textContent = `${ok ? '✅' : '❌'} ${name}: `;
    li.append(b, text);
    $('checks').appendChild(li);
  }

  async function micPeak(ms = 2000) {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    const c = new AudioContext();
    await c.resume();
    const an = c.createAnalyser();
    c.createMediaStreamSource(s).connect(an);
    const data = new Float32Array(an.fftSize);
    let peak = 0;
    const end = Date.now() + ms;
    while (Date.now() < end) {
      await new Promise((r) => setTimeout(r, 50));
      an.getFloatTimeDomainData(data);
      for (const v of data) peak = Math.max(peak, Math.abs(v));
    }
    s.getTracks().forEach((t) => t.stop());
    c.close();
    return peak;
  }

  async function check() {
    $('check').disabled = true;
    $('checks').textContent = '';
    try {
      const bp = browserProblem();
      if (bp) { addCheck(false, 'Browser', bp); return status('Fix the ❌ item above first.', true); }
      addCheck(true, 'Browser', 'microphone and audio are supported on this page');

      status('Say something now: listening to the microphone for 2 seconds…');
      try {
        const peak = await micPeak();
        if (peak < 0.02) addCheck(false, 'Microphone', 'no sound picked up. Check the right microphone is selected in your computer settings and is not muted.');
        else addCheck(true, 'Microphone', `working (level ${Math.min(100, Math.round(peak * 100))}%)`);
      } catch {
        addCheck(false, 'Microphone', 'access was blocked. Click the microphone icon in the address bar, allow it, and reload the page.');
      }

      status('Checking the server, Claude and Sarvam…');
      const srv = await serverStatus();
      if (srv.problem) addCheck(false, 'Server', srv.problem);
      const res = await fetch('/api/admin/voice-check', { method: 'POST' });
      if (res.status === 401) { addCheck(false, 'Login', 'log in to the dashboard (/admin) in this browser first.'); return status('Fix the ❌ items above.', true); }
      if (!res.ok) { addCheck(false, 'Server', `the check failed with ${res.status}. See the server terminal.`); return status('Fix the ❌ items above.', true); }
      const { steps } = await res.json();
      for (const st of steps) addCheck(st.ok, st.name, st.ok ? `${st.detail} (${st.ms} ms)` : st.error);
      const allOk = !srv.problem && steps.every((st) => st.ok) && !$('checks').querySelector('.bad');
      status(allOk ? 'Everything works. Press Start call.' : 'Fix the ❌ items above (restart the server after changing keys), then check again.', !allOk);
    } catch (err) {
      addCheck(false, 'Check', String(err.message || err));
      status('The check could not finish. Is the server running?', true);
    } finally {
      $('check').disabled = false;
    }
  }

  // ---------- audio ----------

  function toBase64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  // Downsample captured float audio to 8 kHz 16-bit PCM and send it as Exotel "media" events.
  function flushMic() {
    if (!captured.length || ws?.readyState !== 1) return;
    const total = captured.reduce((n, a) => n + a.length, 0);
    const input = new Float32Array(total);
    let o = 0;
    for (const a of captured) { input.set(a, o); o += a.length; }
    captured = [];
    const ratio = ctx.sampleRate / RATE;
    const outLen = Math.floor(total / ratio);
    const pcm = new Int16Array(outLen);
    let peak = 0;
    for (let i = 0; i < outLen; i++) {
      const pos = i * ratio;
      const i0 = Math.floor(pos);
      const i1 = Math.min(i0 + 1, total - 1);
      const v = input[i0] + (input[i1] - input[i0]) * (pos - i0);
      peak = Math.max(peak, Math.abs(v));
      pcm[i] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
    }
    $('level').style.width = `${Math.min(100, Math.round(peak * 140))}%`;
    ws.send(JSON.stringify({ event: 'media', stream_sid: 'TEST', media: { payload: toBase64(new Uint8Array(pcm.buffer)) } }));
  }

  function play(payload) {
    const bin = atob(payload);
    const n = bin.length >> 1;
    const buf = ctx.createBuffer(1, n, RATE);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < n; i++) {
      let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
      if (v >= 0x8000) v -= 0x10000;
      ch[i] = v / 32768;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    playAt = Math.max(playAt, ctx.currentTime + 0.05);
    src.start(playAt);
    playAt += buf.duration;
    sources.push(src);
    src.onended = () => { sources = sources.filter((s) => s !== src); };
  }

  function clearPlayback() {
    for (const s of sources) { try { s.stop(); } catch { /* already stopped */ } }
    sources = [];
    playAt = 0;
    markTimers.forEach(clearTimeout);
    markTimers = [];
  }

  // ---------- call ----------

  async function start() {
    if (!slug) return status('Open this page from the dashboard (Phone calls → Test call).', true);
    const bp = browserProblem();
    if (bp) return status(bp, true);
    $('start').disabled = true;
    $('log').innerHTML = '<p class="muted small">Connecting…</p>';
    try {
      const srv = await serverStatus();
      if (srv.problem) throw new Error(srv.problem);
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      } catch {
        throw new Error('Microphone access was blocked. Click the microphone icon in the address bar, allow it, and try again.');
      }
      ctx = new AudioContext();
      await ctx.resume();
      await ctx.audioWorklet.addModule('/static/pcm-worklet.js');
      node = new AudioWorkletNode(ctx, 'pcm-capture');
      node.port.onmessage = (e) => captured.push(e.data);
      const mute = ctx.createGain();
      mute.gain.value = 0;
      ctx.createMediaStreamSource(stream).connect(node).connect(mute).connect(ctx.destination);
      connect();
    } catch (err) {
      stream?.getTracks().forEach((t) => t.stop());
      ctx?.close();
      $('start').disabled = false;
      status(String(err.message || err), true);
    }
  }

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/exotel/stream?clinic=${encodeURIComponent(slug)}&test=1`);
    ws.onopen = () => {
      ws.send(JSON.stringify({ event: 'connected' }));
      ws.send(JSON.stringify({
        event: 'start',
        start: { stream_sid: 'TEST', call_sid: `TEST-${Date.now()}`, account_sid: 'test', from: $('from').value, to: '' },
      }));
      sendTimer = setInterval(flushMic, 100);
      status('Connected. Preparing the greeting…');
      $('hangup').disabled = false;
    };
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.event === 'media') play(msg.media.payload);
      else if (msg.event === 'clear') clearPlayback();
      else if (msg.event === 'mark') {
        // Like Exotel: confirm the mark once everything queued before it has played.
        const delay = Math.max(0, (playAt - ctx.currentTime) * 1000);
        markTimers.push(setTimeout(() => ws?.readyState === 1 && ws.send(JSON.stringify({ event: 'mark', stream_sid: 'TEST', mark: msg.mark })), delay));
      } else if (msg.event === 'debug') {
        if (msg.kind === 'state') return status(msg.text);
        log(msg.kind, msg.text);
        if (msg.kind === 'error') status(msg.text, true);
        else if (msg.kind === 'assistant' && !$('log').querySelector('.notice.error')) {
          status('Assistant is speaking. When it finishes, speak in Tamil or English (you can also talk over it).');
        }
      }
    };
    ws.onclose = (e) => {
      const connected = $('hangup').disabled === false;
      const hadError = $('log').querySelector('.notice.error');
      cleanup();
      if (hadError) return; // keep the error visible
      if (!connected) return status('Could not connect to the call service. Press "Check setup" to find out why, and look at the server terminal.', true);
      status('Call ended. The Phone calls tab in the dashboard shows the outcome and transcript.');
    };
  }

  function cleanup() {
    clearInterval(sendTimer);
    setTimeout(() => { clearPlayback(); ctx?.close(); }, Math.max(0, (playAt - (ctx?.currentTime ?? 0)) * 1000) + 300);
    stream?.getTracks().forEach((t) => t.stop());
    $('start').disabled = false;
    $('hangup').disabled = true;
    $('level').style.width = '0';
  }

  function hangup() {
    if (ws?.readyState === 1) {
      ws.send(JSON.stringify({ event: 'stop', stream_sid: 'TEST' }));
      ws.close(1000);
    }
  }

  $('start').addEventListener('click', start);
  $('hangup').addEventListener('click', hangup);
  $('check').addEventListener('click', check);
  const bp = browserProblem();
  if (bp) status(bp, true);
})();
