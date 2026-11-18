// Visual Preposition Puzzle: original SVG scenes drawn in the app (start point, path arrow, end point, moving dot).
import { $, $$, esc } from './ui.js';
import { shuffle } from './study.js';

const reduce = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
// landmark drawings (viewBox 300x180). Colors come from CSS variables.
const LM = {
  fence: () => `<g class="lm">${[130, 145, 160, 175].map((x) => `<rect x="${x}" y="95" width="7" height="60" rx="2"/>`).join('')}<rect x="122" y="108" width="62" height="6"/><rect x="122" y="132" width="62" height="6"/></g>`,
  pool: () => `<g class="lm"><rect x="175" y="128" width="110" height="40" rx="4" class="water"/><path d="M175 128h110" class="edge"/></g>`,
  room: () => `<g class="lm"><path d="M170 45h110v115H170V125M170 95V45" class="wall"/><text x="225" y="40" class="lbl">room</text></g>`,
  bridge: () => `<g class="lm"><rect x="0" y="120" width="300" height="60" class="water"/><rect x="30" y="86" width="240" height="10" rx="2"/><rect x="60" y="96" width="8" height="40"/><rect x="232" y="96" width="8" height="40"/></g>`,
  lake: () => `<g class="lm"><ellipse cx="150" cy="95" rx="78" ry="38" class="water"/></g>`,
  river: () => `<g class="lm"><path d="M0 120 C80 105 160 140 300 118 V160 C160 180 80 145 0 160z" class="water"/></g>`,
  shop: () => `<g class="lm"><rect x="120" y="55" width="70" height="70" rx="3"/><rect x="112" y="48" width="86" height="12" class="roof"/><rect x="145" y="95" width="20" height="30" class="door"/><text x="155" y="44" class="lbl">shop</text></g>`,
  stage: () => `<g class="lm"><rect x="160" y="118" width="130" height="50" rx="3"/><path d="M160 118h130" class="edge"/></g>`,
  stairs: () => `<g class="lm"><path d="M50 165h40v-22h40v-22h40v-22h40v-22h40v88z"/></g>`,
  stream: () => `<g class="lm"><path d="M135 0 C125 60 170 110 140 180 H175 C200 110 158 60 168 0z" class="water"/></g>`,
  tunnel: () => `<g class="lm"><path d="M70 160 C90 40 210 40 230 160z"/><path d="M118 160 v-22 a32 32 0 0 1 64 0 v22z" class="hole"/></g>`,
  wall: () => `<g class="lm"><rect x="40" y="80" width="80" height="88" rx="2"/><path d="M40 80h80" class="edge"/></g>`,
};
const PATHS = {
  'fence|over': 'M40 150 Q152 20 265 150',
  'pool|into': 'M30 120 Q140 40 228 150',
  'room|into': 'M20 110 L232 110',
  'room|out of': 'M232 110 L20 110',
  'bridge|across': 'M32 78 L268 78',
  'bridge|under': 'M10 140 L290 140',
  'lake|around': 'M150 40 A102 58 0 1 1 149 40',
  'river|along': 'M20 108 C90 92 170 126 285 104',
  'shop|past': 'M20 150 L285 150',
  'stage|onto': 'M40 165 Q120 50 215 114',
  'stairs|up': 'M60 158 L250 70',
  'stairs|down': 'M250 70 L60 158',
  'stream|across': 'M40 130 Q152 50 265 130',
  'tunnel|through': 'M10 152 L290 152',
  'wall|off': 'M95 76 Q150 50 185 165',
};
let uidN = 0;
export function sceneSVG(item, { small = false, animate = true } = {}) {
  const d = PATHS[`${item.landmark}|${item.path}`] || 'M30 120 L270 120';
  const id = `vp${++uidN}`;
  const anim = animate && !reduce();
  const start = d.match(/M\s*([\d.]+)\s+([\d.]+)/);
  const nums = d.match(/[\d.]+/g).map(Number);
  const ex = nums[nums.length - 2], ey = nums[nums.length - 1];
  const under = item.path === 'under' || item.path === 'through';
  return `<svg class="vp ${small ? 'sm' : ''}" viewBox="0 0 300 180" role="img" aria-label="図解">
    <defs><marker id="${id}a" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" class="arrowhead"/></marker></defs>
    <rect x="0" y="168" width="300" height="12" class="ground"/>
    ${under ? '' : LM[item.landmark]?.() || ''}
    <path id="${id}" d="${d}" class="route" marker-end="url(#${id}a)"/>
    ${under ? LM[item.landmark]?.() || '' : ''}
    <circle cx="${start[1]}" cy="${start[2]}" r="6" class="startpt"/>
    <circle r="9" class="mover" ${anim ? '' : `cx="${ex}" cy="${ey}"`}>${anim ? `<animateMotion dur="2.4s" repeatCount="indefinite" keyPoints="0;1;1" keyTimes="0;0.8;1" calcMode="linear"><mpath href="#${id}"/></animateMotion>` : ''}</circle>
  </svg>`;
}

// format: 'img2prep' (picture -> choose preposition) | 'prep2img' (phrase -> choose picture)
export function renderVisual(host, item, all, onAnswer, format = Math.random() < 0.6 ? 'img2prep' : 'prep2img') {
  const t0 = performance.now();
  const others = shuffle(all.filter((x) => x.prep !== item.prep));
  if (format === 'img2prep') {
    const opts = shuffle([item.prep, ...[...new Set(others.map((x) => x.prep))].slice(0, 3)]);
    host.innerHTML = `<div class="vpq"><div class="small muted">動きに合う前置詞は？</div>${sceneSVG(item)}
      <div class="vp-phrase">${esc(item.verb)} <span class="blank">＿＿</span> the ${esc(item.landmark)}</div>
      <div class="choices grid2">${opts.map((p) => `<button class="choice" data-p="${esc(p)}"><span class="ctx">${esc(p)}</span></button>`).join('')}</div></div>`;
    host.querySelector('.choices').onclick = (e) => {
      const b = e.target.closest('.choice'); if (!b || b.disabled) return;
      const ok = b.dataset.p === item.prep;
      $$('.choice', host).forEach((x) => { x.disabled = true; x.classList.add(x.dataset.p === item.prep ? 'right' : x === b ? 'wrong' : 'dim'); });
      $('.blank', host).textContent = item.prep; $('.blank', host).classList.add(ok ? 'up' : 'down');
      onAnswer({ ok, answer: b.dataset.p, target: item.phrase, ms: Math.round(performance.now() - t0), format });
    };
  } else {
    const pics = shuffle([item, ...others.filter((x) => x.landmark !== item.landmark || x.path !== item.path).slice(0, 3)]);
    host.innerHTML = `<div class="vpq"><div class="small muted">この表現に合う図は？</div><div class="vp-phrase big">${esc(item.phrase)}</div>
      <div class="vp-grid">${pics.map((p, k) => `<button class="vp-pick" data-k="${k}">${sceneSVG(p, { small: true })}</button>`).join('')}</div></div>`;
    host.querySelector('.vp-grid').onclick = (e) => {
      const b = e.target.closest('.vp-pick'); if (!b || b.disabled) return;
      const pk = pics[+b.dataset.k], ok = pk === item;
      $$('.vp-pick', host).forEach((x) => { x.disabled = true; x.classList.add(pics[+x.dataset.k] === item ? 'right' : x === b ? 'wrong' : 'dim'); });
      onAnswer({ ok, answer: pk.phrase, target: item.phrase, ms: Math.round(performance.now() - t0), format });
    };
  }
}
