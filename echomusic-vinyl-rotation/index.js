const STORAGE_KEY = 'echomusic-vinyl-rotation-settings';
const DEFAULT_SETTINGS = {
  scale: 100,
};

const clamp = (value, min, max) =>
  Math.max(min, Math.min(max, Number(value) || 0));

const normalizeSettings = (value) => {
  const source = value && typeof value === 'object' ? value : {};
  return {
    ...DEFAULT_SETTINGS,
    scale: clamp(source.scale ?? DEFAULT_SETTINGS.scale, 90, 150),
  };
};

let disposeSnapshot = null;
let observerRef = null;
let disposeWatch = null;
let disposeFullscreen = null;
let isChangingTrack = false;
let activeCtx = null;
let lastIsPlaying = null;
let lastPauseTime = 0;
let vinylElementsReady = false;
let cachedCoverContainer = null;
let state = null;
let settingsDispose = null;
let settingsStyleDispose = null;
let saveTimer = 0;

const SETTINGS_CSS = `
.echo-vinyl-settings {
  display: grid;
  gap: 14px;
  color: var(--color-text-main);
}

.echo-vinyl-settings-row {
  display: grid;
  gap: 7px;
}

.echo-vinyl-settings-line {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
}

.echo-vinyl-settings-title {
  font-size: 13px;
  font-weight: 760;
}

.echo-vinyl-settings-hint {
  color: var(--color-text-secondary);
  font-size: 12px;
  line-height: 1.45;
}

.echo-vinyl-settings-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
`;

const scheduleSave = (ctx) => {
  if (saveTimer) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = 0;
    if (!state) return;
    void ctx.storage.set(STORAGE_KEY, normalizeSettings(state.settings));
  }, 240);
};

const updateSettings = (ctx, patch) => {
  if (!state) return;
  state.settings = normalizeSettings({ ...state.settings, ...patch });
  applySettings();
  scheduleSave(ctx);
};

const isWindowFullscreen = () => {
  if (document.fullscreenElement) return true;
  try {
    const ow = window.outerWidth;
    const oh = window.outerHeight;
    const sw = window.screen?.availWidth || window.screen?.width || 0;
    const sh = window.screen?.availHeight || window.screen?.height || 0;
    if (ow && oh && sw && sh && ow >= sw * 0.95 && oh >= sh * 0.95) return true;
  } catch(e) {}
  return false;
};

const applySettings = () => {
  if (!state) return;
  const scale = (isWindowFullscreen() ? 120 : state.settings.scale) / 100;

  const group = document.querySelector('.echo-vinyl-group');
  if (group) {
    group.style.transform = `scale(${scale})`;
  }
};

const createSettingsComponent = (ctx) =>
  ctx.vue.defineComponent({
    name: 'VinylRotationSettings',
    setup() {
      const { h, defineAsyncComponent } = ctx.vue;
      const Slider = defineAsyncComponent(ctx.ui.components.Slider);
      const Button = defineAsyncComponent(ctx.ui.components.Button);

      const slider = (label, key, min, max, hint) =>
        h('div', { class: 'echo-vinyl-settings-row' }, [
          h('div', { class: 'echo-vinyl-settings-line' }, [
            h('span', { class: 'echo-vinyl-settings-title' }, label),
            h('span', { class: 'echo-vinyl-settings-hint' }, String(state.settings[key])),
          ]),
          h(Slider, {
            modelValue: state.settings[key],
            min,
            max,
            step: 1,
            'onUpdate:modelValue': (value) =>
              updateSettings(ctx, { [key]: Number(value) }),
          }),
          hint ? h('div', { class: 'echo-vinyl-settings-hint' }, hint) : null,
        ]);

      return () =>
        h('div', { class: 'echo-vinyl-settings' }, [
          slider('唱片缩放', 'scale', 90, 150, '调整黑胶唱片和封面的大小，基于中心缩放。'),
          h('div', { class: 'echo-vinyl-settings-actions' }, [
            h(
              Button,
              {
                variant: 'outline',
                size: 'xs',
                onClick: () => updateSettings(ctx, DEFAULT_SETTINGS),
              },
              { default: () => '恢复默认' },
            ),
          ]),
        ]);
    },
  });

function injectVinylStyles() {
  const old = document.getElementById('echo-vinyl-global-style');
  if (old) old.remove();
  
  const style = document.createElement('style');
  style.id = 'echo-vinyl-global-style';
  style.textContent = `
    .lyric-page .cover-wrapper,
    .lyric-page .cover-wrapper *,
    .lyric-page .cover-side,
    .lyric-page .cover-side *,
    .lyric-page .cover-container,
    .lyric-page .cover-container * {
      background: transparent !important;
      background-color: transparent !important;
      background-image: none !important;
      box-shadow: none !important;
      border: none !important;
      outline: none !important;
      -webkit-mask-image: none !important;
      mask-image: none !important;
    }

    .lyric-page .cover-wrapper {
      overflow: visible !important;
      border-radius: 0 !important;
      width: 510px !important;
      height: 510px !important;
      min-width: 510px !important;
      min-height: 510px !important;
      padding: 0 !important;
      margin: 0 !important;
      position: absolute !important;
      filter: none !important;
      --shadow-cover: none !important;
    }

    .lyric-page .cover-container {
      overflow: visible !important;
      position: relative !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      width: 510px !important;
      height: 510px !important;
      min-width: 510px !important;
      min-height: 510px !important;
    }

    body:not(.echo-vinyl-ready) .lyric-page .cover-container {
      opacity: 0 !important;
    }

    body.echo-vinyl-ready .lyric-page .cover-container {
      opacity: 1 !important;
    }

    .lyric-page {
      overflow: visible !important;
    }

    .lyric-page .lyric-page-content {
      overflow: visible !important;
    }

    .lyric-page .cover-container::before,
    .lyric-page .cover-container::after {
      content: none !important;
      display: none !important;
    }

    .echo-vinyl-group {
      position: absolute !important;
      width: 510px !important;
      height: 510px !important;
      top: 0 !important;
      left: 0 !important;
      transform-origin: 255px 255px !important;
      pointer-events: none !important;
    }

    .echo-vinyl-cover-wrap {
      width: 225px !important;
      height: 225px !important;
      border-radius: 50% !important;
      overflow: hidden !important;
      z-index: 2 !important;
      position: absolute !important;
      top: 143px !important;
      left: 193px !important;
      animation: echoVinylSpin 20s linear infinite;
      animation-play-state: paused !important;
      transform-origin: center center !important;
    }

    .echo-vinyl-cover-wrap img {
      width: 100% !important;
      height: 100% !important;
      border: none !important;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4) !important;
      object-fit: cover !important;
      display: block !important;
      border-radius: 50% !important;
    }

    .echo-vinyl-disc {
      position: absolute !important;
      width: 355px !important;
      height: 355px !important;
      border-radius: 50% !important;
      z-index: 1 !important;
      background: #0d0d0f !important;
      box-shadow:
        0 2px 6px rgba(0,0,0,0.6),
        0 10px 30px rgba(0,0,0,0.7),
        0 25px 70px rgba(0,0,0,0.5),
        inset 0 0 2px rgba(255,255,255,0.06) !important;
      top: 78px !important;
      left: 128px !important;
      animation: echoVinylSpin 20s linear infinite;
      animation-play-state: paused !important;
      overflow: hidden !important;
      transform-origin: center center !important;
    }

    .echo-vinyl-disc::before {
      content: '' !important;
      position: absolute !important;
      top: 0 !important;
      left: 0 !important;
      right: 0 !important;
      bottom: 0 !important;
      border-radius: 50% !important;
      background:
        repeating-radial-gradient(
          circle at center,
          rgba(16,16,18,1) 0px,
          rgba(32,32,35,1) 1.5px,
          rgba(10,10,12,1) 3px,
          rgba(14,14,16,1) 3.8px,
          rgba(26,26,29,1) 5.3px,
          rgba(8,8,10,1) 7px
        ) !important;
    }

    .echo-vinyl-disc::after {
      content: '' !important;
      position: absolute !important;
      top: 0 !important;
      left: 0 !important;
      right: 0 !important;
      bottom: 0 !important;
      border-radius: 50% !important;
      background:
        linear-gradient(
          140deg,
          rgba(255,255,255,0.18) 0%,
          rgba(255,255,255,0.10) 10%,
          rgba(255,255,255,0.04) 20%,
          transparent 35%,
          transparent 50%,
          rgba(0,0,0,0.08) 70%,
          rgba(0,0,0,0.15) 100%
        ),
        radial-gradient(
          ellipse at 35% 20%,
          rgba(255,255,255,0.12) 0%,
          transparent 35%
        ) !important;
    }

    body.echo-vinyl-spinning .echo-vinyl-disc,
    body.echo-vinyl-spinning .echo-vinyl-cover-wrap {
      animation-play-state: running !important;
    }

    .echo-vinyl-tonearm {
      position: absolute !important;
      top: 28px !important;
      left: 160px !important;
      width: 425px !important;
      height: 283px !important;
      z-index: 99999 !important;
      pointer-events: none !important;
      overflow: visible !important;
      transform-origin: 142px 14px !important;
      transform: rotate(-30deg) translateZ(0) !important;
      will-change: transform !important;
      transition: transform 0.35s cubic-bezier(0.4, 0, 0.2, 1) !important;
    }

    body.echo-vinyl-spinning .echo-vinyl-tonearm {
      transform: rotate(0deg) translateZ(0) !important;
    }

    .echo-vinyl-tonearm svg {
      width: 100% !important;
      height: 100% !important;
      overflow: visible !important;
    }

    @keyframes echoVinylSpin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
  `;
  document.head.appendChild(style);
}

function setupVinylElements() {
  const coverContainer = document.querySelector('.lyric-page .cover-container');
  if (!coverContainer) return;

  if (coverContainer === cachedCoverContainer && vinylElementsReady) return;

  const hasGroup = coverContainer.querySelector('.echo-vinyl-group');
  const hasDisc = coverContainer.querySelector('.echo-vinyl-disc');
  const hasCoverWrap = coverContainer.querySelector('.echo-vinyl-cover-wrap');

  if (!hasGroup || !hasDisc || !hasCoverWrap) {
    vinylElementsReady = false;
  }

  if (!vinylElementsReady) {
    let parent = coverContainer;
    while (parent && parent !== document.body) {
      parent.style.setProperty('overflow', 'visible', 'important');
      parent = parent.parentElement;
    }

    coverContainer.style.cssText = 'background:transparent!important;background-color:transparent!important;background-image:none!important;box-shadow:none!important;border-radius:0!important;border:none!important;overflow:visible!important;position:relative!important;display:flex!important;align-items:center!important;justify-content:center!important;width:510px!important;height:510px!important;min-width:510px!important;min-height:510px!important;';
    
    const coverWrapper = document.querySelector('.lyric-page .cover-wrapper');
    if (coverWrapper) {
      coverWrapper.className = '';
      coverWrapper.style.cssText = 'background:transparent!important;background-color:transparent!important;background-image:none!important;box-shadow:none!important;overflow:visible!important;border-radius:0!important;width:510px!important;height:510px!important;min-width:510px!important;min-height:510px!important;border:none!important;padding:0!important;margin:0!important;position:absolute!important;outline:none!important;filter:none!important;';
      
      let pw = coverWrapper.parentElement;
      while (pw && pw !== document.body) {
        pw.style.setProperty('overflow', 'visible', 'important');
        pw = pw.parentElement;
      }
    }
    
    const coverSide = document.querySelector('.lyric-page .cover-side');
    if (coverSide) {
      coverSide.style.background = 'transparent';
      coverSide.style.boxShadow = 'none';
      coverSide.style.border = 'none';

      const songInfo = coverSide.querySelector('.song-info');
      if (songInfo) songInfo.style.display = 'none';
    }

    coverContainer.querySelectorAll('*').forEach(el => {
      if (el.classList.contains('echo-vinyl-disc') || 
          el.classList.contains('echo-vinyl-cover-wrap') || 
          el.classList.contains('echo-vinyl-tonearm') ||
          el.classList.contains('echo-vinyl-group') ||
          el.tagName === 'IMG') {
        return;
      }
      const text = el.textContent?.trim();
      if (text && !el.querySelector('img')) {
        el.style.display = 'none';
      }
    });

    let group = coverContainer.querySelector('.echo-vinyl-group');
    if (!group) {
      group = document.createElement('div');
      group.className = 'echo-vinyl-group';
    }

    let coverWrap = group.querySelector('.echo-vinyl-cover-wrap');
    if (!coverWrap) {
      coverWrap = document.createElement('div');
      coverWrap.className = 'echo-vinyl-cover-wrap';
    }

    const imgs = coverContainer.querySelectorAll('img');
    imgs.forEach(img => {
      if (img.parentElement !== coverWrap) {
        coverWrap.appendChild(img);
      }
      if (!img.dataset.vinylStyled) {
        img.style.width = '100%';
        img.style.height = '100%';
        img.style.border = 'none';
        img.style.borderRadius = '50%';
        img.style.objectFit = 'cover';
        img.style.display = 'block';
        img.dataset.vinylStyled = '1';
      }
    });

    let disc = group.querySelector('.echo-vinyl-disc');
    if (!disc) {
      disc = document.createElement('div');
      disc.className = 'echo-vinyl-disc';
    }

    let tonearm = group.querySelector('.echo-vinyl-tonearm');
    if (!tonearm) {
      tonearm = document.createElement('div');
      tonearm.className = 'echo-vinyl-tonearm';
      tonearm.setAttribute('data-v', '2');
      tonearm.innerHTML = `
        <svg viewBox="0 0 300 200" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <filter id="tonearm-shadow" x="-20%" y="-20%" width="140%" height="140%">
              <feDropShadow dx="1" dy="2" stdDeviation="2" flood-color="rgba(0,0,0,0.5)"/>
            </filter>
          </defs>
          <g filter="url(#tonearm-shadow)">
            <circle cx="100" cy="10" r="7" fill="#e8e8ea" stroke="#c0c0c2" stroke-width="1.2"/>
            <circle cx="100" cy="10" r="3" fill="#a0a0a3"/>
            <path d="M 100 10 C 105 25, 120 40, 130 48 C 135 52, 138 54, 140 55"
                  stroke="#d0d0d3" stroke-width="5.5" fill="none" stroke-linecap="round"/>
            <path d="M 100 10 C 105 25, 120 40, 130 48 C 135 52, 138 54, 140 55"
                  stroke="#ffffff" stroke-width="3.5" fill="none" stroke-linecap="round" opacity="0.5"/>
            <g transform="translate(140, 55) rotate(45)">
              <rect x="0" y="-7" width="14" height="14" rx="1.5" fill="#e0e0e2" stroke="#c0c0c3" stroke-width="0.8"/>
              <rect x="12" y="-4" width="10" height="8" rx="1" fill="#d0d0d3"/>
              <rect x="20" y="-2" width="6" height="4" rx="0.8" fill="#c8c8cb"/>
            </g>
          </g>
        </svg>`;
    }

    if (!group.contains(disc)) group.appendChild(disc);
    if (!group.contains(coverWrap)) group.appendChild(coverWrap);
    if (!group.contains(tonearm)) group.appendChild(tonearm);
    if (!coverContainer.contains(group)) coverContainer.appendChild(group);

    vinylElementsReady = true;
    cachedCoverContainer = coverContainer;
    document.body.classList.add('echo-vinyl-ready');
  }
}

function onTrackChange() {
  if (isChangingTrack) return;
  isChangingTrack = true;
  document.body.classList.remove('echo-vinyl-spinning');

  requestAnimationFrame(() => {
    setTimeout(() => {
      const playing = activeCtx?.player?.isPlaying?.value ?? false;
      if (playing) {
        document.body.classList.add('echo-vinyl-spinning');
      }
      isChangingTrack = false;
    }, 100);
  });
}

export async function activate(ctx) {
  if (disposeSnapshot) { try { disposeSnapshot(); } catch(e) {} disposeSnapshot = null; }
  if (observerRef) { observerRef.disconnect(); observerRef = null; }
  if (disposeWatch) { try { disposeWatch(); } catch(e) {} disposeWatch = null; }
  if (settingsDispose) { try { settingsDispose(); } catch(e) {} settingsDispose = null; }
  if (settingsStyleDispose) { try { settingsStyleDispose(); } catch(e) {} settingsStyleDispose = null; }
  if (saveTimer) { window.clearTimeout(saveTimer); saveTimer = 0; }
  isChangingTrack = false;
  document.body.classList.remove('echo-vinyl-ready');
  activeCtx = ctx;

  document.querySelectorAll('.echo-vinyl-disc, .echo-vinyl-cover-wrap, .echo-vinyl-tonearm, .echo-vinyl-group').forEach(el => el.remove());

  state = ctx.vue.reactive({
    settings: normalizeSettings(await ctx.storage.get(STORAGE_KEY)),
  });

  injectVinylStyles();
  setupVinylElements();
  applySettings();

  const onResize = () => applySettings();
  document.addEventListener('fullscreenchange', onResize);
  window.addEventListener('resize', onResize);
  disposeFullscreen = () => {
    document.removeEventListener('fullscreenchange', onResize);
    window.removeEventListener('resize', onResize);
  };

  settingsStyleDispose = ctx.css.inject(SETTINGS_CSS, { id: 'echomusic-vinyl-rotation-settings' });
  settingsDispose = ctx.ui.settings.define({
    title: '黑胶唱片',
    description: '调整黑胶唱片和封面的缩放比例，以及唱针高度。',
    component: createSettingsComponent(ctx),
  });

  if (ctx && ctx.player) {
    try {
      lastIsPlaying = ctx.player.isPlaying?.value;
      if (lastIsPlaying) {
        document.body.classList.add('echo-vinyl-spinning');
      }
      if (ctx.vue && ctx.vue.watch) {
        disposeWatch = ctx.vue.watch(ctx.player.isPlaying, (val) => {
          if (isChangingTrack) return;
          const now = Date.now();
          if (val) {
            if (lastPauseTime && (now - lastPauseTime) < 600) {
              lastPauseTime = 0;
              onTrackChange();
              return;
            }
            document.body.classList.add('echo-vinyl-spinning');
          } else {
            lastPauseTime = now;
            document.body.classList.remove('echo-vinyl-spinning');
          }
          lastIsPlaying = val;
        });
      }
    } catch(e) {}
  }

  if (ctx && ctx.nowPlaying) {
    ctx.nowPlaying.getSnapshot().then((snapshot) => {
      lastIsPlaying = snapshot?.playback?.isPlaying;
      if (lastIsPlaying) {
        document.body.classList.add('echo-vinyl-spinning');
      }
    }).catch(() => {});

    disposeSnapshot = ctx.nowPlaying.onSnapshot((snapshot) => {
      if (isChangingTrack) return;
      const val = snapshot?.playback?.isPlaying;
      const now = Date.now();
      if (val) {
        if (lastPauseTime && (now - lastPauseTime) < 600) {
          lastPauseTime = 0;
          onTrackChange();
          return;
        }
        document.body.classList.add('echo-vinyl-spinning');
      } else if (val === false) {
        lastPauseTime = now;
        document.body.classList.remove('echo-vinyl-spinning');
      }
      lastIsPlaying = val;
    });
  }

  let lastCoverContainer = document.querySelector('.lyric-page .cover-container');

  observerRef = new MutationObserver((mutations) => {
    if (!document.querySelector('.lyric-page')) return;

    let hasCoverChange = false;
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.classList?.contains('lyric-page') || node.classList?.contains('cover-side') ||
            node.classList?.contains('cover-wrapper') || node.classList?.contains('cover-container')) {
          hasCoverChange = true;
          break;
        }
        if (node.querySelector?.('.cover-container, .cover-wrapper')) {
          hasCoverChange = true;
          break;
        }
      }
      if (hasCoverChange) break;
    }

    if (hasCoverChange) {
      const newCoverContainer = document.querySelector('.lyric-page .cover-container');
      if (newCoverContainer && newCoverContainer !== lastCoverContainer) {
        lastCoverContainer = newCoverContainer;
        onTrackChange();
      }
      vinylElementsReady = false;
      cachedCoverContainer = null;
      setupVinylElements();
      applySettings();
    }
  });
  observerRef.observe(document.body, { childList: true, subtree: true });
}

export function deactivate(ctx) {
  isChangingTrack = false;
  activeCtx = null;
  if (disposeSnapshot) {
    try { disposeSnapshot(); } catch(e) {}
  }
  if (observerRef) observerRef.disconnect();
  if (disposeWatch) { try { disposeWatch(); } catch(e) {} disposeWatch = null; }
  if (disposeFullscreen) { disposeFullscreen(); disposeFullscreen = null; }
  if (settingsDispose) { try { settingsDispose(); } catch(e) {} settingsDispose = null; }
  if (settingsStyleDispose) { try { settingsStyleDispose(); } catch(e) {} settingsStyleDispose = null; }
  if (saveTimer) { window.clearTimeout(saveTimer); saveTimer = 0; }
  state = null;

  document.getElementById('echo-vinyl-global-style')?.remove();
  document.body.classList.remove('echo-vinyl-spinning');
  document.body.classList.remove('echo-vinyl-ready');
  document.querySelectorAll('.echo-vinyl-disc, .echo-vinyl-cover-wrap, .echo-vinyl-tonearm, .echo-vinyl-group').forEach(el => el.remove());
  
  const c = document.querySelector('.lyric-page .cover-container');
  if (c) {
    c.style.cssText = '';
    c.querySelectorAll('*').forEach(el => { el.style.cssText = ''; });
  }
}
