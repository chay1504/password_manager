// One place for the security headers every deployment must send.

export const CSP = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

export const SECURITY_HEADERS = {
  'Content-Security-Policy': CSP,
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
};

// Only sent over HTTPS on real hosting (the local dev server is plain HTTP).
export const HSTS = { 'Strict-Transport-Security': 'max-age=63072000; includeSubDomains' };

// Pages and the service worker must always be revalidated so updates arrive.
export const REVALIDATE = 'public, max-age=0, must-revalidate';
export const REVALIDATE_PATHS = ['/', '/index.html', '/sw.js', '/manifest.webmanifest'];

export function netlifyHeaders() {
  const lines = ['/*', ...Object.entries({ ...SECURITY_HEADERS, ...HSTS }).map(([k, v]) => `  ${k}: ${v}`)];
  for (const path of REVALIDATE_PATHS) lines.push(path, `  Cache-Control: ${REVALIDATE}`);
  return `${lines.join('\n')}\n`;
}

export function vercelConfig() {
  const toList = (obj) => Object.entries(obj).map(([key, value]) => ({ key, value }));
  return {
    cleanUrls: false,
    trailingSlash: false,
    headers: [
      { source: '/(.*)', headers: toList({ ...SECURITY_HEADERS, ...HSTS }) },
      ...REVALIDATE_PATHS.map((source) => ({ source, headers: toList({ 'Cache-Control': REVALIDATE }) })),
    ],
  };
}
