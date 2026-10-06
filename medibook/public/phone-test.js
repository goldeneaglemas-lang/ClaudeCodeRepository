// Browser stand-in for an Exotel phone call: same WebSocket protocol, 8 kHz 16-bit PCM both ways.
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
    const who = document.createElement('strong');
    who.textContent = kind === 'caller' ? 'You: ' : 'Assistant: ';
    p.append(who, text);
    $('log').appendChild(p);
    p.scrollIntoView({ block: 'nearest' });
  }

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

  async function start() {
    if (!slug) return status('Open this page from the dashboard (Phone calls → Test call).', true);
    $('start').disabled = true;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch {
      $('start').disabled = false;
      return status('Microphone access was blocked. Allow the microphone and try again.', true);
    }
    ctx = new AudioContext();
    await ctx.audioWorklet.addModule('/static/pcm-worklet.js');
    node = new AudioWorkletNode(ctx, 'pcm-capture');
    node.port.onmessage = (e) => captured.push(e.data);
    const mute = ctx.createGain();
    mute.gain.value = 0;
    ctx.createMediaStreamSource(stream).connect(node).connect(mute).connect(ctx.destination);

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/exotel/stream?clinic=${encodeURIComponent(slug)}&test=1`);
    ws.onopen = () => {
      ws.send(JSON.stringify({ event: 'connected' }));
      ws.send(JSON.stringify({
        event: 'start',
        start: { stream_sid: 'TEST', call_sid: `TEST-${Date.now()}`, account_sid: 'test', from: $('from').value, to: '' },
      }));
      sendTimer = setInterval(flushMic, 100);
      status('Call connected. Speak in Tamil or English after the greeting.');
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
      } else if (msg.event === 'debug') log(msg.kind, msg.text);
    };
    ws.onclose = (e) => {
      const hadCall = $('hangup').disabled === false;
      cleanup();
      status(e.code === 1006 && !hadCall
        ? 'Could not connect. Check that SARVAM_API_KEY is set on the server and that you are logged in.'
        : 'Call ended. Check the Phone calls tab for the outcome and transcript.', e.code === 1006);
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
})();
