// Where the backend lives. On the website it is the page's own origin; inside the native app
// (Capacitor serves the bundled pages from capacitor://localhost or https://localhost) it is the live site.
const SITE = 'https://rukh.mmix.biz';
const proto = location.protocol;
export const IS_APP = !!(window.Capacitor && (window.Capacitor.isNativePlatform?.() ?? true)) || !/^https?:$/.test(proto);
export const ORIGIN = IS_APP ? SITE : location.origin;
export const WS_ORIGIN = ORIGIN.replace(/^http/, 'ws');
// absolute URL for an API path ('/api/clip' -> 'https://rukh.mmix.biz/api/clip' in the app)
export const api = (path) => ORIGIN + path;
