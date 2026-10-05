// ==UserScript==
// @name         Qwerty Learner — No-Erase (block wrong keys)
// @namespace    https://github.com/qwerty-learner/qwerty-no-erase
// @version      1.0.0
// @description  Stop Qwerty Learner from wiping the whole word when you mistype. Wrong keys are swallowed (red flash + soft click) so typing pauses until the correct letter is typed. Toggle with Ctrl+Shift+Q.
// @author       qwerty-learner users
// @match        https://qwerty.kaiyi.cool/*
// @match        http://localhost:5173/*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @noframes
// ==/UserScript==

/**
 * HOW IT WORKS
 * ------------
 * Qwerty Learner keeps the typed string in React state (`wordState.inputWord`) inside
 * `src/pages/Typing/components/WordPanel/components/Word/index.tsx`. On a wrong key it sets
 * `hasWrong = true` and, after 300ms, runs:
 *
 *     state.inputWord = ''
 *     state.letterStates = new Array(...).fill('normal')
 *
 * i.e. it erases everything you typed. This script never touches React state. Instead it registers a
 * CAPTURE-phase `keydown` listener on `window` and, when the pressed character is not the character
 * the app expects next, it calls `preventDefault()` + `stopImmediatePropagation()`. The app's own
 * (bubble-phase) listener therefore never sees the wrong key, `inputWord` only ever contains the
 * correct prefix, and the wipe-timer never fires. Typing effectively "pauses" until you hit the
 * right key.
 *
 * The current position is read from the rendered DOM:
 *   - The word lives inside the wrapper `[data-tip="按 Tab 快捷键显示完整单词"]`.
 *   - Each character is a sibling `<span class="...font-mono...">`.
 *   - Correct characters already typed are marked with a `text-green*` class, so the number of
 *     leading green spans == how many correct characters have been typed == the index of the
 *     character expected next.
 * Counting green spans (instead of tracking our own counter) is self-healing: it automatically
 * resets on a new word, loop replays, prev/next/skip, window blur/resume, and even the app's own
 * clears.
 *
 * The expected CHARACTER is read from the letter span's React props via its fiber
 * (`memoizedProps.letter`), falling back to the span's text. Reading the prop (not the text) is
 * what makes the guard work in dictation ("recitation") mode, where hidden letters render as `_`.
 *
 * CAVEATS
 * -------
 *  - Dictation ("recitation") modes hide letters (`hideAll`/`hideVowel`/...) by rendering `_` in
 *    the DOM. The real character is still read from React props, so the guard works there too.
 *    Only if those props become unreadable does the script fall back to the DOM text and step
 *    aside for hidden letters (original erase-on-error behavior for that position).
 *  - Code dictionaries using multi-character input / Tab / newlines are not fully guarded.
 *  - Because the app never detects the mistake, it is not reported (no error-book/stats entry).
 *  - Depends on the site's DOM: the `data-tip` text, the `text-green*` classes, and React's
 *    `__reactFiber$*` node property. If the DOM structure changes, the guard logs a one-time
 *    console warning and disables itself for that page; if the React props cannot be read it
 *    falls back to the DOM text (normal mode keeps working; dictation mode degrades).
 *
 * INSTALL
 * -------
 * 1. Install Tampermonkey (or Violentmonkey).
 * 2. Create a new script and paste this file, or open the raw file and let the manager install it.
 * 3. Visit https://qwerty.kaiyi.cool/ and start typing.
 * 4. Press Ctrl+Shift+Q (or use the Tampermonkey menu command) to toggle the guard on/off.
 */

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------

  /** Wrapper element around the current word (see src/.../Word/index.tsx). */
  const WORD_WRAPPER_SELECTOR = '[data-tip="按 Tab 快捷键显示完整单词"]';

  /** Class substring applied by React's Letter component to already-correct letters. */
  const CORRECT_CLASS_SNIPPET = 'text-green';

  /** A hidden (dictation-mode) letter is rendered as this character. */
  const HIDDEN_CHAR = '_';

  /**
   * The app replaces spaces with this visible glyph (`EXPLICIT_SPACE` in src/constants).
   * We mirror it so a Space keypress compares correctly against the rendered word.
   */
  const EXPLICIT_SPACE = '\u2423'; // '␣'

  /** Text shown by the overlay while the app is paused / not typing. */
  const PAUSE_OVERLAY_TEXT = '按任意键';

  /** localStorage/GM keys. */
  const STORAGE_KEY_ENABLED = 'qlNoErase:enabled';

  /** How long the red "blocked" flash lasts (ms). */
  const FLASH_MS = 260;

  const DEBUG = false;

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  const hasGM =
    typeof GM_getValue === 'function' &&
    typeof GM_setValue === 'function';

  let enabled = loadEnabled();

  /** Set to true after we report a broken DOM, so we only warn once. */
  let warnedMissingDom = false;

  /** Set to true after we report that React props are unavailable, so we only warn once. */
  let warnedNoFiber = false;

  /** Lazily-created WebAudio context (created on first key press to satisfy autoplay policy). */
  let audioCtx = null;

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  function loadEnabled() {
    try {
      if (hasGM) {
        const v = GM_getValue(STORAGE_KEY_ENABLED, null);
        if (v !== null && v !== undefined) return v === true || v === 'true';
      }
      const raw = localStorage.getItem(STORAGE_KEY_ENABLED);
      if (raw !== null) return raw === 'true';
    } catch (err) {
      /* ignore */
    }
    return true;
  }

  function saveEnabled(value) {
    try {
      if (hasGM) GM_setValue(STORAGE_KEY_ENABLED, value);
      localStorage.setItem(STORAGE_KEY_ENABLED, value ? 'true' : 'false');
    } catch (err) {
      /* ignore */
    }
  }

  // ---------------------------------------------------------------------------
  // App config mirroring
  // ---------------------------------------------------------------------------

  /**
   * The app stores `isIgnoreCaseAtom = atomWithStorage('isIgnoreCase', true)` (jotai), which
   * serialises to localStorage as JSON. Mirror it so our matching rules equal the app's.
   */
  function isIgnoreCase() {
    try {
      const raw = localStorage.getItem('isIgnoreCase');
      if (raw === null) return true;
      return JSON.parse(raw) !== false;
    } catch (err) {
      return true;
    }
  }

  // ---------------------------------------------------------------------------
  // DOM helpers
  // ---------------------------------------------------------------------------

  /**
   * Locate the current word's letter container + spans.
   * Structure (simplified):
   *   <div data-tip="按 Tab 快捷键显示完整单词">
   *     <div class="flex items-center justify-center">
   *       <span class="...font-mono...">h</span> ...
   *     </div>
   *     <div class="absolute ...">[pronunciation icon]</div>
   *   </div>
   *
   * @returns {{ container: HTMLElement, spans: HTMLElement[] } | null}
   */
  function getLetterInfo() {
    const wrapper = document.querySelector(WORD_WRAPPER_SELECTOR);
    if (!wrapper) return null;

    // Primary: the first child div is the letters container.
    let container = wrapper.firstElementChild;
    let spans = container ? filterLetterSpans(container.children) : [];

    // Fallback: search the whole wrapper for font-mono spans with a common parent.
    if (spans.length === 0) {
      const alt = filterLetterSpans(wrapper.querySelectorAll('span'));
      if (alt.length > 0) {
        container = alt[0].parentElement;
        spans = alt;
      }
    }

    if (!container || spans.length === 0) {
      if (!warnedMissingDom) {
        warnedMissingDom = true;
        console.warn(
          '[qwerty-no-erase] Found the word wrapper but no letter spans — the site DOM likely changed. Blocking is skipped.',
        );
      }
      return null;
    }
    return { container, spans };
  }

  function filterLetterSpans(list) {
    const out = [];
    for (const el of list) {
      if (el && el.tagName === 'SPAN' && el.classList.contains('font-mono')) {
        out.push(el);
      }
    }
    return out;
  }

  /**
   * React attaches its internal fiber to every host DOM node under a random key such as
   * `__reactFiber$abc123`. Find it without knowing the random suffix.
   */
  function getFiber(node) {
    const keys = Object.keys(node);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactInternalInstance$') === 0) {
        return node[k];
      }
    }
    return null;
  }

  /**
   * Each rendered letter is a React element whose component props always contain the real
   * character as `letter` (the visible text is `_` while hidden in dictation mode). Walk up the
   * fiber tree a few levels to find a fiber carrying a string `letter` prop.
   */
  function readLetterProp(span) {
    let fiber = getFiber(span);
    let depth = 0;
    while (fiber && depth < 8) {
      const props = fiber.memoizedProps;
      if (props && typeof props.letter === 'string') return props.letter;
      fiber = fiber.return;
      depth++;
    }
    return null;
  }

  /**
   * The real characters of the current word, read from React props. Returns null if they cannot be
   * read, in which case callers fall back to the letters' rendered text.
   */
  function getTrueLetters(spans) {
    const letters = [];
    for (let i = 0; i < spans.length; i++) {
      const letter = readLetterProp(spans[i]);
      if (letter === null) {
        if (!warnedNoFiber) {
          warnedNoFiber = true;
          if (DEBUG) {
            console.log('[qwerty-no-erase] React props unavailable — falling back to DOM text.');
          }
        }
        return null;
      }
      letters.push(letter);
    }
    return letters;
  }

  /**
   * Number of leading letters already marked correct (green). This equals the count of characters
   * the app has accepted, i.e. the index of the character expected next.
   */
  function countCorrectPrefix(spans) {
    let count = 0;
    for (const span of spans) {
      const cls = typeof span.className === 'string' ? span.className : '';
      if (cls.indexOf(CORRECT_CLASS_SNIPPET) !== -1) count++;
      else break;
    }
    return count;
  }

  /**
   * The overlay with "按任意键开始/继续" is rendered only while `!state.isTyping`. When present the
   * app is paused and its start-key handler must receive the keypress, so we never block then.
   */
  function isTypingActive() {
    const candidates = document.querySelectorAll('div.backdrop-blur-sm');
    for (const el of candidates) {
      if (el.textContent && el.textContent.indexOf(PAUSE_OVERLAY_TEXT) !== -1) return false;
    }
    // Fallback in case Tailwind class names change: look for the text itself.
    const paragraphs = document.querySelectorAll('p');
    for (const el of paragraphs) {
      if (el.textContent && el.textContent.indexOf(PAUSE_OVERLAY_TEXT) !== -1) return false;
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // Matching
  // ---------------------------------------------------------------------------

  function normalizeChar(ch) {
    return ch === ' ' ? EXPLICIT_SPACE : ch;
  }

  function charsMatch(typed, expected) {
    if (typed === expected) return true;
    if (isIgnoreCase()) return typed.toLowerCase() === expected.toLowerCase();
    return false;
  }

  /** Mirrors `isChineseSymbol` from src/utils so the app can still warn about IME usage. */
  const CHINESE_SYMBOL_RE =
    /[\u3002\uff1f\uff01\uff0c\u3001\uff1b\uff1a\u201c\u201d\u2018\u2019\uff08\uff09\u300a\u300b\u3008\u3009\u3010\u3011\u300e\u300f\u300c\u300d\ufe43\ufe44\u3014\u3015\u2026\u2014\uff5e\ufe4f\uffe5]/;

  function isChineseSymbol(ch) {
    return CHINESE_SYMBOL_RE.test(ch);
  }

  // ---------------------------------------------------------------------------
  // Feedback (visual + audio)
  // ---------------------------------------------------------------------------

  function injectStyles() {
    if (document.getElementById('ql-no-erase-style')) return;
    const style = document.createElement('style');
    style.id = 'ql-no-erase-style';
    style.textContent = `
      @keyframes ql-no-erase-flash {
        0% { background-color: rgba(239, 68, 68, 0); filter: drop-shadow(0 0 0 rgba(239, 68, 68, 0)); }
        35% { background-color: rgba(239, 68, 68, 0.16); filter: drop-shadow(0 0 8px rgba(239, 68, 68, 0.95)); }
        100% { background-color: rgba(239, 68, 68, 0); filter: drop-shadow(0 0 0 rgba(239, 68, 68, 0)); }
      }
      .ql-no-erase-blocked {
        /* Red flash only — deliberately no transform, so the word never shakes/moves. */
        animation: ql-no-erase-flash 0.26s ease-out both;
        border-radius: 6px;
      }
      /* Neutralise the app's own "shake" animation on the letter container, so the word never
         moves on a mistake. Our flash class opts out so its (non-moving) animation can run. */
      [data-tip="按 Tab 快捷键显示完整单词"] > div:has(span.font-mono):not(.ql-no-erase-blocked) {
        animation: none !important;
      }
      #ql-no-erase-toast {
        position: fixed;
        left: 50%;
        bottom: 28px;
        transform: translateX(-50%) translateY(12px);
        z-index: 2147483647;
        padding: 8px 14px;
        border-radius: 8px;
        background: rgba(17, 24, 39, 0.92);
        color: #f9fafb;
        font: 500 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
        box-shadow: 0 6px 20px rgba(0, 0, 0, 0.25);
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.18s ease, transform 0.18s ease;
      }
      #ql-no-erase-toast.ql-no-erase-show {
        opacity: 1;
        transform: translateX(-50%) translateY(0);
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function flashBlocked(container) {
    if (!container) return;
    container.classList.add('ql-no-erase-blocked');
    window.setTimeout(function () {
      if (container && container.classList) container.classList.remove('ql-no-erase-blocked');
    }, FLASH_MS);
  }

  /** Short, soft tick. Created lazily because AudioContext needs a user gesture. */
  function playClick() {
    try {
      const AudioCtor = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtor) return;
      if (!audioCtx) audioCtx = new AudioCtor();
      if (audioCtx.state === 'suspended') audioCtx.resume();

      const t = audioCtx.currentTime;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(320, t);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.05, t + 0.005);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(t);
      osc.stop(t + 0.1);
    } catch (err) {
      /* audio is best-effort */
    }
  }

  function showToast(text) {
    injectStyles();
    let el = document.getElementById('ql-no-erase-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'ql-no-erase-toast';
      (document.body || document.documentElement).appendChild(el);
    }
    el.textContent = text;
    el.classList.add('ql-no-erase-show');
    window.clearTimeout(el._qlTimer);
    el._qlTimer = window.setTimeout(function () {
      el.classList.remove('ql-no-erase-show');
    }, 1600);
  }

  // ---------------------------------------------------------------------------
  // Core guard
  // ---------------------------------------------------------------------------

  function onKeyDownCapture(event) {
    if (!enabled) return;

    // Never interfere with shortcuts (Ctrl+J pronounce, Ctrl+Shift+Arrow skip, ...).
    if (event.ctrlKey || event.altKey || event.metaKey) return;

    const key = event.key;
    // Only single printable characters (letters, digits, punctuation, space).
    if (!key || key.length !== 1) return;

    // Let the app's own IME warning handle Chinese input.
    if (isChineseSymbol(key)) return;

    // While paused, the "press any key to start/continue" handler must receive the key.
    if (!isTypingActive()) return;

    const info = getLetterInfo();
    if (!info) return;

    const pos = countCorrectPrefix(info.spans);
    if (pos >= info.spans.length) return; // Word appears complete; let the app handle it.

    // Real character from React props (works in dictation mode); fall back to the span's text.
    const trueLetters = getTrueLetters(info.spans);
    const expectedRaw = trueLetters ? trueLetters[pos] : info.spans[pos].textContent;
    if (!expectedRaw) return;

    // Hidden letter rendered as '_' and React props unavailable: can't verify, so step aside.
    if (expectedRaw === HIDDEN_CHAR) return;

    const typed = normalizeChar(key);
    const expected = normalizeChar(expectedRaw);

    if (charsMatch(typed, expected)) return; // Correct — let it through to the app.

    // Wrong — swallow it before the app's window listener (bubble phase) can react.
    event.preventDefault();
    event.stopImmediatePropagation();
    flashBlocked(info.container);
    playClick();
  }

  function onToggleHotkey(event) {
    if (!event.ctrlKey || !event.shiftKey) return;
    const key = event.key && event.key.toLowerCase();
    if (key !== 'q') return;

    event.preventDefault();
    event.stopImmediatePropagation();

    enabled = !enabled;
    saveEnabled(enabled);
    showToast(enabled ? 'Qwerty No-Erase: ON' : 'Qwerty No-Erase: OFF (original behavior)');
  }

  // ---------------------------------------------------------------------------
  // Bootstrap
  // ---------------------------------------------------------------------------

  injectStyles();

  // Capture phase on window: runs before the app's bubble-phase `window.addEventListener('keydown')`
  // (KeyEventHandler) and before any document-level hotkey handler.
  window.addEventListener('keydown', onKeyDownCapture, true);
  window.addEventListener('keydown', onToggleHotkey, true);

  if (typeof GM_registerMenuCommand === 'function') {
    try {
      GM_registerMenuCommand('Toggle No-Erase (Ctrl+Shift+Q)', function () {
        enabled = !enabled;
        saveEnabled(enabled);
        showToast(enabled ? 'Qwerty No-Erase: ON' : 'Qwerty No-Erase: OFF (original behavior)');
      });
    } catch (err) {
      /* ignore */
    }
  }

  if (DEBUG) {
    console.log('[qwerty-no-erase] loaded; enabled =', enabled);
  }
})();
