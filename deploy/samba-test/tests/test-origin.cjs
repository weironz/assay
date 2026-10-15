// A former test endpoint may later become production. Never select a remote target implicitly.
const raw = process.env.SAMBA_E2E_ORIGIN;
if (!raw) throw new Error('Set SAMBA_E2E_ORIGIN explicitly to the isolated test deployment.');
let url;
try { url = new URL(raw); } catch { throw new Error('Invalid SAMBA_E2E_ORIGIN.'); }
if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) {
  throw new Error('SAMBA_E2E_ORIGIN must be an HTTPS origin, or HTTP loopback, without credentials or a path.');
}
module.exports = url.origin;
