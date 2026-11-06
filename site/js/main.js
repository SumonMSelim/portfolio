import { computePhases, parseDoh, parsePop, parseCacheStatus, auditHeaders, waterfall, toHex } from './trace-core.js';
import { createPlayer } from './player.js';

const journey = document.getElementById('journey');
const hops = [...document.querySelectorAll('.hop')];
const panel = document.getElementById('hop-panel');
const packet = document.getElementById('packet');
const progress = document.getElementById('hops-progress');
const track = document.getElementById('hops-track');
const counter = document.getElementById('hop-count');
const bar = document.getElementById('waterfall');
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

// Which timing-bar segments light up for each hop.
const STAGE_SEGMENTS = [[], ['dns'], ['tcp', 'tls'], ['wait'], ['wait'], ['download']];

let evidence = null;
let stages = [];
let current = 0;
let player;

async function init() {
  player = createPlayer({
    scene: document.getElementById('scene'),
    caption: document.getElementById('caption'),
    playButton: document.getElementById('play'),
    scrub: document.getElementById('scrub'),
    fill: document.getElementById('scrub-fill'),
    ticks: document.getElementById('ticks'),
    time: document.getElementById('ptime'),
    labels: hops.map((hop) => hop.querySelector('.hop-label').textContent),
    onChapter: select,
  });
  document.getElementById('player-host').textContent = location.hostname;

  const goTo = (i) => player.seek(Math.max(0, Math.min(hops.length - 1, i)));
  hops.forEach((hop, i) => hop.addEventListener('click', () => goTo(i)));
  document.getElementById('hop-prev').addEventListener('click', () => goTo(current - 1));
  document.getElementById('hop-next').addEventListener('click', () => goTo(current + 1));
  document.querySelectorAll('[data-replay]').forEach((b) => b.addEventListener('click', () => {
    document.getElementById('player').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
    trace();
  }));
  journey.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    goTo(current + (e.key === 'ArrowRight' ? 1 : -1));
    hops[current].focus();
  });
  addEventListener('resize', () => moveTo(current));
  initToolkit();
  await trace();
}

function initToolkit() {
  const tabs = [...document.querySelectorAll('.tk-tab')];
  const panels = [...document.querySelectorAll('.tk-panel')];
  const show = (key) => {
    tabs.forEach((tab) => {
      const on = tab.dataset.tk === key;
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
    });
    panels.forEach((panel) => { panel.hidden = panel.dataset.tk !== key; });
  };
  tabs.forEach((tab) => tab.addEventListener('click', () => show(tab.dataset.tk)));
  show(tabs[0].dataset.tk);
}

// Collects fresh evidence (new edge probe, DNS lookup and hash), then replays the journey.
async function trace() {
  player.pause();
  current = 0;
  hops.forEach((hop) => hop.classList.remove('active', 'done'));
  moveTo(0);
  panel.replaceChildren(h('p', 'measuring', 'Tracing your connection…'));
  [evidence] = await Promise.all([collect(), intro()]);
  const protocol = evidence.timing?.protocol;
  document.getElementById('hud-link').textContent = `${protocol && protocol !== 'unknown' ? protocol.toUpperCase() : 'HTTP'} ${evidence.secure ? '🔒 TLS' : '⚠ PLAIN'}`;
  stages = buildStages(evidence);
  stages.forEach((s, i) => { hops[i].querySelector('.hop-metric').textContent = s.metric; });
  renderWaterfall(evidence.timing);
  const pop = evidence.edge?.pop;
  player.load({
    cache: evidence.edge?.cache ?? 'unknown',
    captions: stages.map((s) => s.caption),
    subs: { you: stages[0].metric, dns: stages[1].metric, edge: pop ? `${pop.code} · ${pop.city ?? pop.raw}` : 'nearest edge', origin: stages[4].metric },
  });
  if (reduceMotion) player.seek(0);
  else player.play();
}

// "Hey, do you know how you got here?" fades in word by word, holds, then fades out.
async function intro() {
  const overlay = document.getElementById('intro');
  if (reduceMotion) {
    overlay.hidden = true;
    return;
  }
  const line = document.getElementById('intro-line');
  const text = line.dataset.text ?? (line.dataset.text = line.textContent);
  line.replaceChildren(...text.split(' ').map((word, i) => {
    const span = h('span', 'intro-word', `${word} `);
    span.style.animationDelay = `${i * 0.18}s`;
    return span;
  }));
  overlay.hidden = false;
  overlay.classList.remove('out');
  // Re-trigger the CSS entrance animations on every retrace.
  void overlay.offsetWidth;
  overlay.classList.add('in');
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 3400);
    overlay.onclick = () => { clearTimeout(timer); resolve(); };
  });
  overlay.classList.replace('in', 'out');
  await new Promise((resolve) => setTimeout(resolve, 600));
  overlay.hidden = true;
}

function select(i) {
  if (!stages.length) return;
  current = Math.max(0, Math.min(stages.length - 1, i));
  hops.forEach((hop, j) => {
    hop.setAttribute('aria-selected', String(j === current));
    hop.tabIndex = j === current ? 0 : -1;
    hop.classList.toggle('done', j < current);
    hop.classList.toggle('active', j === current);
  });
  moveTo(current);
  counter.textContent = `${current + 1} / ${stages.length}`;
  bar.querySelectorAll('.seg').forEach((seg) => seg.classList.toggle('lit', STAGE_SEGMENTS[current].includes(seg.dataset.key)));
  renderPanel(stages[current]);
}

const centre = (hop) => hop.offsetLeft + hop.offsetWidth / 2;

// Slides the packet and progress line to the centre of the given hop.
function moveTo(i) {
  const x = centre(hops[i]);
  const start = centre(hops[0]);
  track.style.left = `${start}px`;
  track.style.width = `${centre(hops.at(-1)) - start}px`;
  packet.style.transform = `translateX(${x}px)`;
  progress.style.left = `${start}px`;
  progress.style.width = `${x - start}px`;
}

async function collect() {
  const [edge, dns] = await Promise.all([probeEdge(), resolveDns(location.hostname)]);
  const data = {
    host: location.hostname,
    collectedAt: new Date().toISOString(),
    secure: location.protocol === 'https:',
    timing: computePhases(performance.getEntriesByType('navigation')[0]),
    dns,
    edge,
  };
  const json = JSON.stringify(data, null, 2);
  const hash = crypto.subtle ? toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(json))) : null;
  return { ...data, json, hash };
}

async function probeEdge() {
  try {
    const res = await fetch(location.pathname, { method: 'HEAD', cache: 'no-store' });
    const get = (name) => res.headers.get(name);
    return { pop: parsePop(get('x-amz-cf-pop')), cache: parseCacheStatus(get('x-cache')), via: get('via'), defenses: auditHeaders(get) };
  } catch {
    return null;
  }
}

async function resolveDns(host) {
  if (!host.includes('.')) return [];
  try {
    const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=A`;
    const res = await fetch(url, { headers: { accept: 'application/dns-json' } });
    return parseDoh(await res.json());
  } catch {
    return [];
  }
}

const fmt = (v) => (v == null ? '—' : `${v < 10 ? v.toFixed(1) : Math.round(v)} ms`);

function buildStages({ host, secure, timing: t, dns, edge, json, hash }) {
  const quic = t?.protocol === 'h3';
  const handshake = t ? t.tcp + t.tls : null;
  const pop = edge?.pop;
  const cache = edge?.cache ?? 'unknown';
  const defenses = edge?.defenses ?? [];
  const passed = defenses.filter((d) => d.ok).length;
  const hasCname = dns.some((r) => r.type === 'CNAME');

  return [
    {
      metric: t?.protocol && t.protocol !== 'unknown' ? t.protocol.toUpperCase() : 'HTTP',
      caption: `You asked your browser for ${host}`,
      kicker: 'Hop 1 · Your device',
      title: 'It started with you',
      metrics: [['Protocol', t?.protocol ?? 'unknown'], ['Page size', t?.transferSize ? `${(t.transferSize / 1024).toFixed(1)} KB` : 'cached'], ['Arrived at', new Date().toLocaleTimeString()]],
      visual: chain([['You', 'you'], [host, 'host']]),
      text: `You asked your browser for ${host}. Before a single pixel could appear, that request had to find a server, prove it was talking to the right one, and agree on secret keys.`,
    },
    {
      metric: t ? fmt(t.dns) : '—',
      caption: `DNS: ${host} → ${hasCname ? 'CNAME → ' : ''}Amazon CloudFront${t ? ` · ${fmt(t.dns)}` : ''}`,
      kicker: 'Hop 2 · DNS',
      title: `Where is ${host}?`,
      metrics: [['Lookup', t ? fmt(t.dns) : '—'], ['Records', dns.length ? String(dns.length) : 'n/a'], ['Resolved via', 'DNS-over-HTTPS']],
      visual: dns.length
        ? chain([[host, 'host'], ...dns.map((r) => [`${r.type} ${r.data}`, r.type === 'CNAME' ? 'cname' : 'ip'])])
        : chain([[host, 'host'], ['CNAME → CloudFront', 'cname'], ['edge IPs', 'ip']]),
      text: `${hasCname || !dns.length ? 'This name is a CNAME into' : 'This name resolves straight to'} Amazon CloudFront, the global CDN under AWS Amplify Hosting. ${dns.length ? 'The chain above was just re-resolved live for you.' : 'On the live site this chain is re-resolved for you in real time.'}`,
      study: 'Classic DNS is plaintext and unauthenticated: anyone on the path can read or spoof it. That is why this lookup used DNS-over-HTTPS.',
    },
    {
      metric: handshake == null ? '—' : fmt(handshake),
      caption: `${quic ? 'QUIC + TLS 1.3 handshake' : secure ? 'TCP + TLS handshake' : 'TCP handshake (no TLS locally)'}${handshake ? ` · ${fmt(handshake)}` : ''} · keys agreed`,
      kicker: 'Hop 3 · Handshake',
      title: quic ? 'QUIC + TLS 1.3 in one round trip' : 'TCP, then TLS',
      metrics: [['Connect', t ? fmt(t.tcp) : '—'], ['TLS', secure && t ? fmt(t.tls) : 'none (local)'], ['Transport', quic ? 'QUIC / UDP' : 'TCP']],
      visual: sequence(quic
        ? [['r', 'Initial: ClientHello + key share'], ['l', 'ServerHello + certificate'], ['r', 'Finished → encrypted']]
        : [['r', 'SYN'], ['l', 'SYN-ACK'], ['r', 'ACK'], ['r', 'ClientHello + key share'], ['l', 'ServerHello + certificate'], ['r', 'Finished → encrypted']]),
      text: handshake === 0
        ? 'Your browser reused a warm connection, so it skipped the handshake entirely. Here is what it would have done.'
        : 'Your browser and the edge agreed on fresh keys with ephemeral Diffie-Hellman, and the edge proved it owns this name with an AWS Certificate Manager certificate.',
      study: 'From my Cryptography course: ephemeral (EC)DHE gives forward secrecy. Even if the server key leaks one day, a recording of this session stays unreadable.',
    },
    {
      metric: pop?.code ?? '—',
      caption: pop ? `Arrived at CloudFront edge ${pop.raw}${pop.city ? ` · ${pop.city}` : ''}` : 'Arrived at the nearest CloudFront edge',
      kicker: 'Hop 4 · CloudFront edge',
      title: pop?.city ? `Served from ${pop.city}` : 'A CloudFront edge near you',
      metrics: [['Edge ID', pop?.raw ?? 'n/a (local)'], ['Airport code', pop?.code ?? '—'], ['Cache', cache.toUpperCase()]],
      visual: edgeCard(pop, cache),
      text: 'CloudFront edge locations are named after the nearest airport. DNS steered you to this one so the page had the shortest possible trip.',
    },
    {
      metric: { hit: 'HIT', refresh: 'REVAL', miss: 'MISS' }[cache] ?? '—',
      caption: {
        hit: 'Cache HIT · the Amplify origin was never touched',
        refresh: 'Edge revalidated its copy with the Amplify origin',
        miss: 'Cache MISS · fetched from the Amplify Hosting origin',
      }[cache] ?? 'Edge → Amplify Hosting origin',
      kicker: 'Hop 5 · Amplify origin',
      title: { hit: 'The edge already had it', refresh: 'A quick check with the origin', miss: 'All the way to the origin' }[cache] ?? 'Edge or origin?',
      metrics: [['Time to first byte', t ? fmt(t.wait) : '—'], ['Cache status', cache.toUpperCase()]],
      visual: originPath(cache),
      text: {
        hit: 'Cache HIT: the request never left the edge. The Amplify Hosting origin was not touched at all.',
        refresh: 'The edge asked the Amplify origin whether its copy was still current, then served it.',
        miss: 'Cache MISS: the edge fetched this page from the Amplify Hosting origin, kept a copy for the next visitor, and sent it on.',
      }[cache] ?? 'On the live site this shows whether the edge or the Amplify origin answered you.',
    },
    {
      metric: defenses.length ? `${passed}/${defenses.length}` : '—',
      caption: `Delivered${defenses.length ? ` · ${passed}/${defenses.length} security headers` : ''}${hash ? ` · sealed sha256:${hash.slice(0, 10)}…` : ''}`,
      kicker: 'Hop 6 · Delivered',
      title: 'Delivered, with its armour on',
      metrics: [['Download', t ? fmt(t.download) : '—'], ['Security headers', defenses.length ? `${passed} of ${defenses.length}` : 'n/a']],
      visual: delivered(defenses, json, hash),
      text: 'The page arrived with security headers telling your browser how to protect you. Below is everything this journey collected, sealed with a SHA-256 hash, the way forensic investigators prove evidence was not tampered with.',
      study: 'Each of these hops is something I am learning to attack and defend in my MSc Security and Networking Engineering at the University of Amsterdam.',
    },
  ];
}

function renderPanel({ kicker, title, metrics, visual, text, study }) {
  panel.replaceChildren(
    h('p', 'kicker', kicker),
    h('h3', 'panel-title', title),
    h('div', 'metrics', ...metrics.map(([label, value]) => h('div', 'metric', h('span', 'metric-value', value), h('span', 'metric-label', label)))),
    h('div', 'visual', visual),
    h('p', 'panel-text', text),
    ...(study ? [h('p', 'panel-study', study)] : []),
  );
  panel.classList.remove('enter');
  void panel.offsetWidth;
  panel.classList.add('enter');
}

function renderWaterfall(t) {
  const segments = waterfall(t);
  if (!segments.length) {
    bar.hidden = true;
    return;
  }
  bar.replaceChildren(...segments.map((s) => {
    const seg = h('div', `seg seg-${s.key}`, h('span', 'seg-label', `${s.label} ${fmt(s.ms)}`));
    seg.dataset.key = s.key;
    seg.style.flexGrow = String(Math.max(s.pct, 6));
    seg.title = `${s.label}: ${fmt(s.ms)}`;
    return seg;
  }));
}

function chain(items) {
  const parts = [];
  items.forEach(([label, kind], i) => {
    if (i) parts.push(h('span', 'chain-arrow', '→'));
    const chip = h('span', `chip chip-${kind}`, label);
    chip.style.animationDelay = `${i * 0.25}s`;
    parts.push(chip);
  });
  return h('div', 'chain', ...parts);
}

function sequence(rows) {
  return h('div', 'seq',
    h('div', 'seq-ends', h('span', '', 'You'), h('span', '', 'Edge')),
    ...rows.map(([dir, label], i) => {
      const row = h('div', `seq-row seq-${dir}`, h('span', 'seq-label', label));
      row.style.animationDelay = `${i * 0.3}s`;
      return row;
    }),
  );
}

function edgeCard(pop, cache) {
  return h('div', 'edge-card',
    h('span', 'edge-pulse'),
    h('div', '', h('p', 'edge-city', pop?.city ?? pop?.code ?? 'Nearest edge'), h('p', 'edge-code', pop?.raw ?? 'x-amz-cf-pop appears on the live site')),
    h('span', `badge badge-${cache}`, cache === 'unknown' ? 'CACHE ?' : `CACHE ${cache.toUpperCase()}`),
  );
}

function originPath(cache) {
  return h('div', `origin-path origin-${cache}`,
    h('span', 'node', 'You'),
    h('span', 'link'),
    h('span', 'node', 'Edge'),
    h('span', 'link link-origin'),
    h('span', 'node node-origin', 'Amplify origin'),
  );
}

function delivered(defenses, json, hash) {
  const copy = h('button', 'ctl', 'Copy evidence');
  copy.type = 'button';
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(`${json}\nsha256: ${hash}`);
      copy.textContent = 'Copied ✓';
    } catch {
      copy.textContent = 'Copy blocked';
    }
  });
  return h('div', 'delivered',
    h('ul', 'checks', ...(defenses.length ? defenses : [{ label: 'Security headers appear on the live site', ok: false }]).map((d, i) => {
      const li = h('li', d.ok ? 'pass' : 'fail', h('span', 'check-mark', d.ok ? '✓' : '✗'), d.label);
      li.style.animationDelay = `${i * 0.15}s`;
      return li;
    })),
    h('div', 'seal',
      h('p', 'seal-label', 'Evidence seal · SHA-256'),
      h('p', 'seal-hash', hash ?? 'needs HTTPS (live site)'),
      h('details', '', h('summary', '', 'View evidence log'), h('pre', '', json)),
      copy,
    ),
  );
}

function h(tag, cls, ...children) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  node.append(...children.filter((c) => c != null && c !== false));
  return node;
}

init();
