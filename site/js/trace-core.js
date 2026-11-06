// Pure helpers for the "Trace this request" feature. No DOM access, so they can be unit tested.

// First three letters of a CloudFront POP id (e.g. "AMS54-P1") are the nearest airport code.
const POP_CITIES = {
  AMS: 'Amsterdam', FRA: 'Frankfurt', LHR: 'London', MAN: 'Manchester', CDG: 'Paris',
  MRS: 'Marseille', DUB: 'Dublin', BRU: 'Brussels', DUS: 'Düsseldorf', HAM: 'Hamburg',
  MUC: 'Munich', BER: 'Berlin', TXL: 'Berlin', ZRH: 'Zurich', VIE: 'Vienna', PRG: 'Prague',
  WAW: 'Warsaw', BUD: 'Budapest', MXP: 'Milan', FCO: 'Rome', PMO: 'Palermo', MAD: 'Madrid',
  BCN: 'Barcelona', LIS: 'Lisbon', CPH: 'Copenhagen', ARN: 'Stockholm', OSL: 'Oslo',
  HEL: 'Helsinki', ATH: 'Athens', SOF: 'Sofia', OTP: 'Bucharest', ZAG: 'Zagreb',
  IAD: 'Ashburn, VA', JFK: 'New York', EWR: 'Newark', BOS: 'Boston', ORD: 'Chicago',
  ATL: 'Atlanta', MIA: 'Miami', DFW: 'Dallas', IAH: 'Houston', DEN: 'Denver',
  LAX: 'Los Angeles', SFO: 'San Francisco', SEA: 'Seattle', PHX: 'Phoenix', YYZ: 'Toronto',
  YUL: 'Montréal', YVR: 'Vancouver', GRU: 'São Paulo', GIG: 'Rio de Janeiro', EZE: 'Buenos Aires',
  SCL: 'Santiago', BOG: 'Bogotá', LIM: 'Lima', QRO: 'Querétaro', BOM: 'Mumbai', DEL: 'New Delhi',
  BLR: 'Bengaluru', MAA: 'Chennai', HYD: 'Hyderabad', CCU: 'Kolkata', SIN: 'Singapore',
  KUL: 'Kuala Lumpur', BKK: 'Bangkok', CGK: 'Jakarta', MNL: 'Manila', HKG: 'Hong Kong',
  TPE: 'Taipei', ICN: 'Seoul', NRT: 'Tokyo', HND: 'Tokyo', KIX: 'Osaka', SYD: 'Sydney',
  MEL: 'Melbourne', PER: 'Perth', AKL: 'Auckland', DXB: 'Dubai', FJR: 'Fujairah',
  BAH: 'Bahrain', TLV: 'Tel Aviv', JNB: 'Johannesburg', CPT: 'Cape Town', NBO: 'Nairobi',
  LOS: 'Lagos',
};

export function parsePop(value) {
  if (!value) return null;
  const raw = value.trim();
  const code = raw.slice(0, 3).toUpperCase();
  return { raw, code, city: POP_CITIES[code] ?? null };
}

export function parseCacheStatus(xCache) {
  if (!xCache) return 'unknown';
  const v = xCache.trim().toLowerCase();
  if (v.startsWith('refreshhit')) return 'refresh';
  if (v.startsWith('hit')) return 'hit';
  if (v.startsWith('miss')) return 'miss';
  return 'unknown';
}

const ms = (start, end) => Math.max(0, Math.round((end - start) * 10) / 10);

// Splits a PerformanceNavigationTiming entry into network phases (milliseconds).
export function computePhases(t) {
  if (!t) return null;
  const hasTls = t.secureConnectionStart > 0;
  return {
    protocol: t.nextHopProtocol || 'unknown',
    dns: ms(t.domainLookupStart, t.domainLookupEnd),
    tcp: ms(t.connectStart, hasTls ? t.secureConnectionStart : t.connectEnd),
    tls: hasTls ? ms(t.secureConnectionStart, t.connectEnd) : 0,
    wait: ms(t.requestStart, t.responseStart),
    download: ms(t.responseStart, t.responseEnd),
    transferSize: t.transferSize ?? 0,
  };
}

const DNS_TYPES = { 1: 'A', 5: 'CNAME', 28: 'AAAA' };
const stripDot = (s) => String(s).replace(/\.$/, '');

// Parses a DNS-over-HTTPS JSON response (application/dns-json).
export function parseDoh(json) {
  return (json?.Answer ?? []).map((a) => ({
    name: stripDot(a.name),
    type: DNS_TYPES[a.type] ?? String(a.type),
    data: stripDot(a.data),
    ttl: a.TTL,
  }));
}

// `get` looks up a response header by lowercase name (e.g. Headers#get bound to a response).
export function auditHeaders(get) {
  const csp = get('content-security-policy') || '';
  return [
    { label: 'HTTPS only (Strict-Transport-Security)', ok: Boolean(get('strict-transport-security')) },
    { label: 'Content-Security-Policy', ok: Boolean(csp) },
    { label: 'No framing / clickjacking', ok: Boolean(get('x-frame-options')) || /frame-ancestors/.test(csp) },
    { label: 'No MIME sniffing (X-Content-Type-Options)', ok: (get('x-content-type-options') || '').toLowerCase() === 'nosniff' },
    { label: 'Referrer-Policy', ok: Boolean(get('referrer-policy')) },
    { label: 'Permissions-Policy', ok: Boolean(get('permissions-policy')) },
  ];
}

// Proportional segments for the timing bar; zero-length phases are dropped.
export function waterfall(p) {
  if (!p) return [];
  const parts = [['dns', 'DNS', p.dns], ['tcp', 'Connect', p.tcp], ['tls', 'TLS', p.tls], ['wait', 'Server', p.wait], ['download', 'Download', p.download]]
    .filter(([, , v]) => v > 0);
  const total = parts.reduce((sum, [, , v]) => sum + v, 0);
  return parts.map(([key, label, v]) => ({ key, label, ms: v, pct: Math.round((v / total) * 1000) / 10 }));
}

// Maps playback time to { chapter, move, t }: which chapter is playing, which packet move
// within it (-1 when the chapter has none) and progress 0..1 along that move.
// Moves fill the first 80% of a chapter; the rest is a pause on arrival.
export function timelineAt(elapsed, chapterMs, moveCounts) {
  const last = moveCounts.length - 1;
  const chapter = Math.max(0, Math.min(last, Math.floor(elapsed / chapterMs)));
  const local = Math.max(0, Math.min(1, (elapsed - chapter * chapterMs) / chapterMs));
  const moves = moveCounts[chapter];
  if (!moves) return { chapter, move: -1, t: 0 };
  const pos = Math.min(local / 0.8, 1) * moves;
  const move = Math.min(Math.floor(pos), moves - 1);
  return { chapter, move, t: Math.min(1, pos - move) };
}

export function toHex(buffer) {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');
}
