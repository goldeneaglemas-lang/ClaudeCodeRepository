// MediBook AI website widget.
// <script src="https://YOUR-HOST/widget.js" data-clinic="your-clinic-id" async></script>
(() => {
  const script = document.currentScript;
  if (!script) return;
  const slug = script.dataset.clinic;
  if (!slug) { console.warn('MediBook: missing data-clinic attribute'); return; }
  const origin = new URL(script.src).origin;
  const label = script.dataset.label || 'Book appointment';
  const color = script.dataset.color || '#0f766e';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = `📅 ${label}`;
  btn.setAttribute('aria-expanded', 'false');
  Object.assign(btn.style, {
    position: 'fixed', right: '16px', bottom: '16px', zIndex: 2147483000, border: 'none', borderRadius: '999px',
    padding: '12px 18px', background: color, color: '#fff', font: '600 15px system-ui, sans-serif',
    boxShadow: '0 6px 20px rgba(0,0,0,.25)', cursor: 'pointer',
  });

  let frame = null;
  btn.addEventListener('click', () => {
    if (!frame) {
      frame = document.createElement('iframe');
      frame.src = `${origin}/c/${encodeURIComponent(slug)}`;
      frame.title = label;
      frame.allow = 'microphone';
      Object.assign(frame.style, {
        position: 'fixed', right: '16px', bottom: '76px', zIndex: 2147483000, border: '1px solid #d9e0ea',
        borderRadius: '16px', boxShadow: '0 10px 40px rgba(0,0,0,.25)', background: '#fff',
        width: 'min(400px, calc(100vw - 32px))', height: 'min(620px, calc(100vh - 100px))',
      });
      document.body.appendChild(frame);
      btn.setAttribute('aria-expanded', 'true');
      return;
    }
    const open = frame.style.display !== 'none';
    frame.style.display = open ? 'none' : 'block';
    btn.setAttribute('aria-expanded', String(!open));
  });
  document.body.appendChild(btn);
})();
