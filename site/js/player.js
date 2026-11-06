import { timelineAt } from './trace-core.js';

const NS = 'http://www.w3.org/2000/svg';
const CHAPTER_MS = 2600;

const ICONS = {
  you: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
  dns: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20"/>',
  edge: '<circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49M7.76 16.24a6 6 0 0 1 0-8.49M19.07 4.93a10 10 0 0 1 0 14.14M4.93 19.07a10 10 0 0 1 0-14.14"/>',
  origin: '<rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><path d="M6 6h.01M6 18h.01"/>',
};
const LABELS = { you: 'You', dns: 'DNS resolver', edge: 'CloudFront edge', origin: 'Amplify origin' };

// Node positions for a wide (desktop) and a tall (phone) scene.
const LAYOUTS = {
  wide: { w: 1200, h: 440, you: [140, 310], dns: [420, 100], edge: [740, 290], origin: [1060, 110] },
  tall: { w: 400, h: 540, you: [95, 440], dns: [300, 330], edge: [105, 215], origin: [295, 70] },
};
// Packet routes: [from, to, bend]. Bend curves the line sideways, as a fraction of its length.
const ROUTES = {
  'you-dns': ['you', 'dns', 0.22],
  'you-edge': ['you', 'edge', 0.12],
  'edge-origin': ['edge', 'origin', 0.2],
  'edge-you': ['edge', 'you', 0.28],
};

function movesFor(cache) {
  const toOrigin = cache === 'miss' || cache === 'refresh';
  return [
    [],
    [['you-dns', false], ['you-dns', true]],
    [['you-edge', false], ['you-edge', true], ['you-edge', false], ['you-edge', true]],
    [['you-edge', false]],
    toOrigin ? [['edge-origin', false], ['edge-origin', true]] : [],
    [['edge-you', false]],
  ];
}

function focusFor(cache) {
  const toOrigin = cache === 'miss' || cache === 'refresh';
  return ['you', 'dns', 'edge', 'edge', toOrigin ? 'origin' : 'edge', 'you'];
}

function curve([ax, ay], [bx, by], bend) {
  const dx = bx - ax;
  const dy = by - ay;
  const cx = (ax + bx) / 2 - dy * bend;
  const cy = (ay + by) / 2 + dx * bend;
  return `M${ax} ${ay} Q${cx} ${cy} ${bx} ${by}`;
}

function svg(tag, attrs = {}) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

const clock = (ms) => `0:${String(Math.floor(ms / 1000)).padStart(2, '0')}`;

export function createPlayer({ scene, caption, playButton, scrub, fill, ticks, time, labels, onChapter }) {
  const narrow = matchMedia('(max-width: 640px)');
  const total = labels.length * CHAPTER_MS;
  let layout;
  let els = {};
  let data = { captions: [], subs: {}, cache: 'unknown' };
  let moves = movesFor('unknown');
  let focus = focusFor('unknown');
  let elapsed = 0;
  let playing = false;
  let loop = 0;
  let chapter = -1;
  let loaded = false;

  function build() {
    layout = LAYOUTS[narrow.matches ? 'tall' : 'wide'];
    const root = svg('svg', { viewBox: `0 0 ${layout.w} ${layout.h}`, role: 'img', 'aria-label': 'Animated map of your request travelling from your device through DNS and a CloudFront edge to the Amplify origin and back' });
    const defs = svg('defs');
    defs.innerHTML = '<filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>'
      + '<pattern id="dots" width="28" height="28" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1.2" class="s-dot"/></pattern>';
    root.append(defs, svg('rect', { width: layout.w, height: layout.h, fill: 'url(#dots)' }));

    els = { paths: {}, nodes: {}, subs: {} };
    for (const [id, [from, to, bend]] of Object.entries(ROUTES)) {
      const path = svg('path', { d: curve(layout[from], layout[to], bend), class: 's-path' });
      els.paths[id] = path;
      root.append(path);
    }
    // Packet sits under the nodes, so arrival reads as the node lighting up.
    els.packet = svg('circle', { r: 8, class: 's-packet', filter: 'url(#glow)' });
    root.append(els.packet);
    for (const id of Object.keys(LABELS)) {
      const [x, y] = layout[id];
      const g = svg('g', { class: 's-node', transform: `translate(${x} ${y})` });
      const icon = svg('g', { class: 's-icon', transform: 'translate(-14 -14) scale(1.17)' });
      icon.innerHTML = ICONS[id];
      const label = svg('text', { class: 's-label', y: 62, 'text-anchor': 'middle' });
      label.textContent = LABELS[id];
      const sub = svg('text', { class: 's-sub', y: 84, 'text-anchor': 'middle' });
      sub.textContent = data.subs[id] ?? '';
      g.append(svg('circle', { r: 36, class: 's-halo' }), svg('circle', { r: 36, class: 's-ring' }), icon, label, sub);
      els.nodes[id] = g;
      els.subs[id] = sub;
      root.append(g);
    }
    scene.replaceChildren(root);
    chapter = -1;
    render();
  }

  function render() {
    const step = timelineAt(elapsed, CHAPTER_MS, moves.map((m) => m.length));
    if (step.chapter !== chapter) {
      chapter = step.chapter;
      Object.entries(els.nodes).forEach(([id, g]) => g.classList.toggle('on', loaded && focus[chapter] === id));
      if (loaded) {
        caption.textContent = data.captions[chapter];
        ticks.querySelectorAll('button').forEach((b, i) => b.classList.toggle('on', i <= chapter));
        onChapter(chapter);
      }
    }
    Object.values(els.paths).forEach((p) => p.classList.remove('lit'));
    moves.forEach((list, c) => list.forEach(([id], m) => {
      if (c < step.chapter || (c === step.chapter && m <= step.move)) els.paths[id].classList.add('lit');
    }));
    els.paths['edge-origin'].classList.toggle('skipped', loaded && moves[4].length === 0 && step.chapter >= 4);

    let x;
    let y;
    if (step.move >= 0) {
      const [id, reverse] = moves[step.chapter][step.move];
      const path = els.paths[id];
      const length = path.getTotalLength();
      ({ x, y } = path.getPointAtLength(length * (reverse ? 1 - step.t : step.t)));
    } else {
      [x, y] = layout[focus[step.chapter]];
    }
    els.packet.setAttribute('cx', x);
    els.packet.setAttribute('cy', y);
    fill.style.width = `${(elapsed / total) * 100}%`;
    time.textContent = `${clock(elapsed)} / ${clock(total)}`;
  }

  function setPlaying(value) {
    playing = value;
    const ended = !value && elapsed >= total;
    playButton.textContent = value ? '❚❚' : ended ? '↺' : '▶';
    playButton.setAttribute('aria-label', value ? 'Pause' : ended ? 'Play again' : 'Play');
    scene.parentElement.classList.toggle('is-playing', value);
  }

  function frame(id, last) {
    return (now) => {
      if (id !== loop || !playing) return;
      elapsed = Math.min(total, elapsed + (now - last));
      render();
      if (elapsed >= total) setPlaying(false);
      else requestAnimationFrame(frame(id, now));
    };
  }

  function play() {
    if (!loaded) return;
    if (elapsed >= total) elapsed = 0;
    setPlaying(true);
    requestAnimationFrame(frame(++loop, performance.now()));
  }

  function pause() {
    loop++;
    setPlaying(false);
  }

  // Jumps to the moment a chapter's packet has arrived, and pauses there.
  function seek(i) {
    pause();
    elapsed = (i + 0.82) * CHAPTER_MS;
    render();
  }

  ticks.replaceChildren(...labels.map((label, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tick';
    b.textContent = label;
    b.setAttribute('aria-label', `Jump to ${label}`);
    b.style.left = `${(i / labels.length) * 100}%`;
    b.addEventListener('click', (e) => { e.stopPropagation(); seek(i); });
    return b;
  }));
  playButton.addEventListener('click', () => (playing ? pause() : play()));
  scrub.addEventListener('click', (e) => {
    const { left, width } = scrub.getBoundingClientRect();
    pause();
    elapsed = Math.max(0, Math.min(1, (e.clientX - left) / width)) * total;
    render();
  });
  narrow.addEventListener('change', build);
  build();

  return {
    load(next) {
      data = next;
      moves = movesFor(next.cache);
      focus = focusFor(next.cache);
      loaded = true;
      Object.entries(els.subs).forEach(([id, sub]) => { sub.textContent = next.subs[id] ?? ''; });
      pause();
      elapsed = 0;
      chapter = -1;
      render();
    },
    play,
    pause,
    seek,
  };
}
