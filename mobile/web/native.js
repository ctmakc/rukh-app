// Injected into every bundled page of the RUKH app by scripts/sync-web.sh (never loaded on the website).
// Plugins only through window.Capacitor.Plugins[name] — pages are plain modules without a bundler.
// Pages here run from a local origin; the MMIX bug report and Review Kit name the live site and post through it.
window.MMIX_SITE_ORIGIN = 'https://rukh.mmix.biz';
function rukhNative() {
  const C = window.Capacitor;
  if (!C || !C.Plugins) return;
  const P = C.Plugins;
  const home = /^\/(index\.html|app\.html)?$/.test(location.pathname);
  // Camera, TV screen and lesson pages run for minutes without touches: keep the display on there.
  if (!home) {
    P.KeepAwake && P.KeepAwake.keepAwake().catch(() => {});
    // Hardware back: step back inside the app, then to the start screen; never drop out of a running page silently.
    P.App && P.App.addListener('backButton', () => {
      if (history.length > 1) history.back();
      else location.href = '/index.html';
    });
  }
  // Clean paths used by the web pages (/cam, /screen, /lesson, /c/<id>) -> bundled files or the live site.
  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[href]');
    if (!a || a.target === '_blank') return;
    const u = new URL(a.getAttribute('href'), location.href);
    if (u.origin !== location.origin) return;
    const m = u.pathname.match(/^\/(cam|screen|lesson|clip|app|privacy|support)\/?$/);
    if (m) { e.preventDefault(); location.href = '/' + m[1] + '.html' + u.search + u.hash; return; }
    if (/^\/c\//.test(u.pathname)) { e.preventDefault(); location.href = 'https://rukh.mmix.biz' + u.pathname + u.search; }
  }, true);
}
// The Capacitor bridge is injected at document start; wait for the DOM in case this script ran first.
if (window.Capacitor && window.Capacitor.Plugins) rukhNative();
else document.addEventListener('DOMContentLoaded', rukhNative, { once: true });
