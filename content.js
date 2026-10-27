/*
 * YT Hover Account Switcher — content script.
 *
 * Hovering the masthead avatar on www.youtube.com shows a dropdown with every
 * account in the browser session. Clicking one switches YouTube to it.
 *
 * Flow:
 *   MutationObserver / yt-navigate-finish → attachToAvatar()
 *   hover → showDropdown() → loadAccounts() → renderAccounts()
 *   click row → switchAccount()
 */
(() => {
  'use strict';

  // ---------------------------------------------------------------------------
  // Config
  // ---------------------------------------------------------------------------

  /** Logs the raw getAccountSwitcherEndpoint response + parse details. */
  const DEBUG = true;

  const LOG_PREFIX = '[YT-Switcher]';
  const ENDPOINT = '/getAccountSwitcherEndpoint';
  const CACHE_TTL_MS = 5 * 60 * 1000;
  const SHOW_DELAY_MS = 150;
  const HIDE_DELAY_MS = 250;
  const WAIT_TIMEOUT_MS = 3000;

  /**
   * Switch by clicking the matching row in YouTube's own account menu (opened
   * invisibly). This runs YouTube's real switch logic, which is the only
   * method that reliably persists the new account. URL navigation below is
   * kept as a fallback.
   */
  const SWITCH_VIA_NATIVE_MENU = true;

  /** How long to wait for YouTube to navigate after the native click. */
  const NATIVE_SWITCH_TIMEOUT_MS = 6000;

  /**
   * URL fallback: when an account carries YouTube's sign-in URL
   * (accountSigninToken), use it; otherwise ?authuser=N&pageId=X.
   */
  const PREFER_SIGNIN_URL = true;

  /** Hosts we're willing to navigate to when following a sign-in URL. */
  const ALLOWED_SWITCH_HOSTS = new Set([
    'www.youtube.com',
    'accounts.youtube.com',
    'accounts.google.com',
  ]);

  // Only run on the main desktop site, top frame, once.
  if (location.hostname !== 'www.youtube.com' || window.top !== window) return;
  if (window.__ytHoverSwitcherLoaded) return;
  window.__ytHoverSwitcherLoaded = true;

  const log = (...args) => { if (DEBUG) console.log(LOG_PREFIX, ...args); };
  const warn = (...args) => console.warn(LOG_PREFIX, ...args);

  /**
   * Firefox content scripts expose `content.fetch`, which issues the request
   * as the page (correct Origin + cookies). Chrome has no such global (and
   * `content` may even resolve to YouTube's <div id="content">), so fall back.
   */
  const pageFetch =
    typeof content === 'object' && content && typeof content.fetch === 'function'
      ? content.fetch.bind(content)
      : window.fetch.bind(window);

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  const state = {
    avatar: null,          // the attached #avatar-btn element
    avatarAbort: null,     // AbortController for avatar listeners
    dropdown: null,        // our dropdown root element
    showTimer: 0,
    hideTimer: 0,
    suppressed: false,     // true after a native click until the mouse leaves the avatar
    internalClick: false,  // true while we programmatically click the avatar
    cache: null,           // { accounts, ts }
    inflight: null,        // pending loadAccounts() promise
    renderToken: 0,        // guards against stale async renders
    switching: false,
  };

  const globalAbort = new AbortController();
  let observer = null;

  // ---------------------------------------------------------------------------
  // Generic helpers
  // ---------------------------------------------------------------------------

  /** Removes YouTube's XSSI guard `)]}'` from a JSON response. */
  function stripXssiPrefix(text) {
    return text.replace(/^\s*\)\]\}'\s*/, '');
  }

  /**
   * Recursively collects every object under `root` matching `predicate`.
   * Does not descend into matches (so nested look-alikes aren't double counted).
   */
  function findAll(root, predicate, out = [], seen = new WeakSet()) {
    if (!root || typeof root !== 'object' || seen.has(root)) return out;
    seen.add(root);
    if (!Array.isArray(root) && predicate(root)) {
      out.push(root);
      return out;
    }
    for (const value of Array.isArray(root) ? root : Object.values(root)) {
      findAll(value, predicate, out, seen);
    }
    return out;
  }

  function findFirst(root, predicate) {
    return findAll(root, predicate)[0] || null;
  }

  /** Reads YouTube's text shapes: "str", {simpleText}, {runs:[{text}]}, {content}. */
  function readText(value) {
    if (!value) return '';
    if (typeof value === 'string') return value.trim();
    if (typeof value.simpleText === 'string') return value.simpleText.trim();
    if (Array.isArray(value.runs)) return value.runs.map((r) => r.text || '').join('').trim();
    if (typeof value.content === 'string') return value.content.trim();
    return '';
  }

  /** Picks the largest thumbnail URL and makes it absolute https. */
  function readPhotoUrl(photo) {
    const thumbs = photo && Array.isArray(photo.thumbnails) ? photo.thumbnails : [];
    const best = thumbs.reduce(
      (acc, t) => (!acc || (t.width || 0) > (acc.width || 0) ? t : acc),
      null
    );
    return normalizeImageUrl(best && best.url);
  }

  function normalizeImageUrl(url) {
    if (!url || typeof url !== 'string') return '';
    if (url.startsWith('//')) url = 'https:' + url;
    try {
      const u = new URL(url, location.origin);
      return u.protocol === 'https:' ? u.href : '';
    } catch {
      return '';
    }
  }

  function readAuthuserFromUrl(url) {
    if (!url) return null;
    try {
      const value = new URL(url, location.origin).searchParams.get('authuser');
      return value !== null && /^\d+$/.test(value) ? Number(value) : null;
    } catch {
      return null;
    }
  }

  /** Resolves with predicate()'s first truthy value, polling every frame. */
  function waitFor(predicate, timeoutMs = WAIT_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const start = performance.now();
      const tick = () => {
        let result = null;
        try { result = predicate(); } catch { /* keep polling */ }
        if (result) return resolve(result);
        if (performance.now() - start > timeoutMs) return reject(new Error('waitFor timed out'));
        requestAnimationFrame(tick);
      };
      tick();
    });
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function isRendered(el) {
    return !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  }

  // ---------------------------------------------------------------------------
  // Fetching + parsing accounts
  // ---------------------------------------------------------------------------

  /** Primary source: YouTube's account switcher endpoint. */
  async function fetchFromEndpoint() {
    const res = await pageFetch(ENDPOINT, { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.text();
    if (DEBUG) console.log(LOG_PREFIX, 'raw getAccountSwitcherEndpoint response:\n' + raw);
    const json = JSON.parse(stripXssiPrefix(raw));
    return parseAccounts(json);
  }

  function isAccountItem(obj) {
    return 'accountName' in obj && ('accountPhoto' in obj || 'serviceEndpoint' in obj || 'isSelected' in obj);
  }

  /**
   * Turns the endpoint JSON into a flat list of accounts. Path-agnostic: it
   * finds "account sections" (one per Google account / authuser) and the
   * account items inside them anywhere in the tree.
   */
  function parseAccounts(json) {
    let sections = findAll(json, (o) => 'accountItemSectionRenderer' in o)
      .map((o) => o.accountItemSectionRenderer);
    if (!sections.length) sections = [json]; // unknown shape: treat whole tree as one section

    const accounts = [];
    const seen = new Set();

    sections.forEach((section, sectionIndex) => {
      const email = readSectionEmail(section);

      for (const item of findAll(section, isAccountItem)) {
        const account = parseAccountItem(item, sectionIndex, email);
        const key = `${account.authuser}|${account.pageId}|${account.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        account.nativeIndex = accounts.length; // position in the native menu list
        accounts.push(account);
      }
    });

    log('parsed accounts:', accounts);
    if (!accounts.length) warn('Parser found no account items. Paste the raw response (with DEBUG on) to fix the parser.');
    return accounts;
  }

  /**
   * Section headers seen so far: none (the active Google account's section),
   * accountItemSectionHeaderRenderer.title (other accounts), or the older
   * googleAccountHeaderRenderer.email.
   */
  function readSectionEmail(section) {
    const header = section.header || {};
    const data = header.accountItemSectionHeaderRenderer || header.googleAccountHeaderRenderer || header;
    const text = readText(data.email) || readText(data.title);
    return text.includes('@') ? text : '';
  }

  function parseAccountItem(item, sectionIndex, sectionEmail) {
    const endpoint = item.serviceEndpoint || item.navigationEndpoint || item;
    const tokenHolder = findFirst(endpoint, (o) => Array.isArray(o.supportedTokens));
    const tokens = tokenHolder ? tokenHolder.supportedTokens : endpoint;

    const pageIdObj = findFirst(tokens, (o) => typeof o.pageId === 'string');
    const gaiaObj = findFirst(tokens, (o) => typeof o.obfuscatedGaiaId === 'string');
    const signinObj = findFirst(tokens, (o) => typeof o.signinUrl === 'string');
    const signinUrl = signinObj ? signinObj.signinUrl : '';

    const authuserFromUrl = readAuthuserFromUrl(signinUrl);
    const byline = readText(item.accountByline) || readText(item.channelHandle) || sectionEmail;

    return {
      source: 'endpoint',
      name: readText(item.accountName) || byline || 'Unknown account',
      byline,
      email: sectionEmail,
      photoUrl: readPhotoUrl(item.accountPhoto),
      isSelected: item.isSelected === true,
      isDisabled: item.isDisabled === true,
      authuser: authuserFromUrl !== null ? authuserFromUrl : sectionIndex,
      pageId: pageIdObj ? pageIdObj.pageId : '',
      obfuscatedGaiaId: gaiaObj ? gaiaObj.obfuscatedGaiaId : '',
      signinUrl,
    };
  }

  /**
   * Fallback 1: ytInitialData embedded in the page's inline <script>.
   * (Content scripts live in an isolated world, so window.ytInitialData
   * itself isn't readable — we parse the script text instead.) It rarely
   * contains the switcher, but it's cheap to check.
   */
  function readFromInitialData() {
    for (const script of document.querySelectorAll('script:not([src])')) {
      const text = script.textContent;
      if (!text.includes('ytInitialData') || !text.includes('accountItem')) continue;
      const match = text.match(/ytInitialData\s*=\s*(\{.+?\});\s*(?:var |window\[|$|<\/script>)/s);
      if (!match) continue;
      try {
        const accounts = parseAccounts(JSON.parse(match[1]));
        if (accounts.length) return accounts.map((a) => ({ ...a, source: 'initialData' }));
      } catch (err) {
        warn('Could not parse ytInitialData:', err);
      }
    }
    return [];
  }

  /**
   * Fallback 2: invisibly open YouTube's own account menu, go to
   * "Switch account", scrape the list, and close it again.
   */
  async function scrapeNativeMenu() {
    if (!state.avatar) throw new Error('No avatar button to open');
    return withHiddenNativeMenu(async () => {
      await openNativeAccountList();
      const sections = [...document.querySelectorAll('ytd-popup-container ytd-account-item-section-renderer')];
      const items = [...document.querySelectorAll('ytd-popup-container ytd-account-item-renderer')];

      const accounts = items.map((el, nativeIndex) => {
        const section = el.closest('ytd-account-item-section-renderer');
        const sectionIndex = Math.max(0, sections.indexOf(section));
        const email = textOf(section && section.querySelector('#email'));
        const byline = textOf(el.querySelector('#channel-handle, #account-byline, #byline')) || email;
        const check = el.querySelector('#checkmark, #check, yt-icon[icon="check"]');
        return {
          source: 'scrape',
          nativeIndex,
          name: textOf(el.querySelector('#channel-title, #account-name')) || byline || 'Unknown account',
          byline,
          email,
          photoUrl: normalizeImageUrl(el.querySelector('img') && el.querySelector('img').src),
          isSelected:
            el.matches('[selected], [is-selected], [aria-selected="true"]') || (!!check && isRendered(check)),
          isDisabled: false,
          authuser: sectionIndex,
          pageId: '',
          obfuscatedGaiaId: '',
          signinUrl: '',
        };
      });
      log('scraped accounts from native menu:', accounts);
      return accounts;
    });
  }

  function textOf(el) {
    return el ? el.textContent.trim() : '';
  }

  /** Runs fn while YouTube's popup is visually hidden; always closes it afterwards. */
  async function withHiddenNativeMenu(fn) {
    const root = document.documentElement;
    root.classList.add('yts-scraping');
    try {
      return await fn();
    } finally {
      closeNativeMenu();
      setTimeout(() => root.classList.remove('yts-scraping'), 300);
    }
  }

  function clickAvatarProgrammatically() {
    state.internalClick = true;
    try {
      state.avatar.click();
    } finally {
      state.internalClick = false;
    }
  }

  async function openNativeAccountList() {
    if (!isNativeMenuOpen()) clickAvatarProgrammatically();
    const switchItem = await waitFor(findSwitchAccountItem);
    switchItem.click();
    await waitFor(() => {
      const item = document.querySelector('ytd-popup-container ytd-account-item-renderer');
      return item && isRendered(item);
    });
    await sleep(100); // let Polymer finish stamping the remaining rows
  }

  /** Finds the "Switch account" entry in the native menu (locale-tolerant). */
  function findSwitchAccountItem() {
    const links = [...document.querySelectorAll(
      'ytd-popup-container ytd-multi-page-menu-renderer ytd-compact-link-renderer'
    )].filter(isRendered);
    const clickable = (el) => el.querySelector('a, tp-yt-paper-item') || el;

    const byText = links.find((l) => /switch account/i.test(l.textContent));
    if (byText) return clickable(byText);

    // Non-English UI: the first item with a visible right arrow opens a sub-page,
    // and in the account section that's "Switch account".
    const byArrow = links.find((l) => {
      const icon = l.querySelector('#right-icon');
      return icon && icon.childElementCount > 0 && isRendered(icon);
    });
    return byArrow ? clickable(byArrow) : null;
  }

  /** Finds the native menu row for `account`: by name (+ byline), else by position. */
  function findNativeAccountRow(account) {
    const rows = [...document.querySelectorAll('ytd-popup-container ytd-account-item-renderer')];
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const name = norm(account.name);
    const byline = norm(account.byline);

    const byName = rows.filter((r) => {
      const title = norm(textOf(r.querySelector('#channel-title, #account-name')));
      return title ? title === name : norm(r.textContent).includes(name);
    });
    if (byName.length === 1) return byName[0];
    const byBoth = byName.filter((r) => !byline || norm(r.textContent).includes(byline));
    if (byBoth.length) return byBoth[0];

    return Number.isInteger(account.nativeIndex) ? rows[account.nativeIndex] || null : null;
  }

  /** Opens the native menu invisibly and clicks the account's row. */
  async function clickNativeAccountRow(account) {
    await openNativeAccountList();
    const row = findNativeAccountRow(account);
    if (!row) throw new Error('Native account row not found');
    log('clicking native account row:', textOf(row).replace(/\s+/g, ' '));
    (row.querySelector('tp-yt-paper-icon-item') || row).click();
  }

  function closeNativeMenu() {
    if (isNativeMenuOpen() && state.avatar) clickAvatarProgrammatically();
  }

  function isNativeMenuOpen() {
    const menu = document.querySelector('ytd-popup-container tp-yt-iron-dropdown ytd-multi-page-menu-renderer');
    const dropdown = menu && menu.closest('tp-yt-iron-dropdown');
    return !!dropdown && dropdown.style.display !== 'none' && dropdown.getAttribute('aria-hidden') !== 'true';
  }

  /**
   * Returns the account list, using the 5-minute cache when fresh and
   * de-duplicating concurrent requests. Tries each source in order.
   */
  function loadAccounts(force = false) {
    if (!force && state.cache && Date.now() - state.cache.ts < CACHE_TTL_MS) {
      return Promise.resolve(state.cache.accounts);
    }
    if (state.inflight) return state.inflight;

    state.inflight = (async () => {
      let accounts = [];
      try {
        accounts = await fetchFromEndpoint();
      } catch (err) {
        warn('getAccountSwitcherEndpoint failed:', err);
      }
      if (!accounts.length) {
        warn('Falling back to ytInitialData.');
        accounts = readFromInitialData();
      }
      if (!accounts.length) {
        warn('Falling back to scraping the native account menu.');
        try {
          accounts = await scrapeNativeMenu();
        } catch (err) {
          warn('Native menu scrape failed:', err);
        }
      }
      if (!accounts.length) throw new Error('No accounts found');
      state.cache = { accounts, ts: Date.now() };
      return accounts;
    })().finally(() => {
      state.inflight = null;
    });

    return state.inflight;
  }

  // ---------------------------------------------------------------------------
  // Switching
  // ---------------------------------------------------------------------------

  /** Current URL minus account params, plus `t=` on watch pages. */
  function currentTargetUrl() {
    const url = new URL(location.href);
    url.searchParams.delete('authuser');
    url.searchParams.delete('pageId');
    url.searchParams.delete('pageid');
    if (url.pathname === '/watch') {
      const video = document.querySelector('#movie_player video, video.html5-main-video');
      if (video && video.currentTime > 1) url.searchParams.set('t', `${Math.floor(video.currentTime)}s`);
    }
    return url;
  }

  /** Builds the navigation URL that activates `account` and returns to the current page. */
  function buildSwitchUrl(account) {
    const target = currentTargetUrl();

    if (PREFER_SIGNIN_URL && account.signinUrl) {
      try {
        const signin = new URL(account.signinUrl, location.origin);
        if (signin.protocol === 'https:' && ALLOWED_SWITCH_HOSTS.has(signin.hostname)) {
          if (!signin.searchParams.has('skip_identity_prompt')) signin.searchParams.set('skip_identity_prompt', 'true');
          if (signin.searchParams.has('next')) {
            // Keep YouTube's format: it sends an absolute URL here.
            const original = signin.searchParams.get('next') || '';
            const isAbsolute = /^https?:/i.test(original);
            signin.searchParams.set('next', isAbsolute ? target.href : target.pathname + target.search + target.hash);
            return signin.href;
          }
          if (signin.searchParams.has('continue')) {
            signin.searchParams.set('continue', target.href);
            return signin.href;
          }
        }
      } catch (err) {
        warn('Bad signinUrl, using authuser params instead:', err);
      }
    }

    target.searchParams.set('authuser', String(account.authuser));
    if (account.pageId) target.searchParams.set('pageId', account.pageId);
    return target.href;
  }

  /**
   * Switches to `account`. First lets YouTube do it via its own menu; if the
   * page hasn't started navigating after NATIVE_SWITCH_TIMEOUT_MS, falls back
   * to URL navigation.
   */
  async function switchAccount(account, row) {
    if (account.isSelected || account.isDisabled || state.switching) return;
    state.switching = true;
    state.cache = null;
    setRowSwitching(row);
    log('switch requested:', account);

    let leaving = false;
    const markLeaving = () => { leaving = true; };
    const once = { once: true, signal: globalAbort.signal };
    window.addEventListener('beforeunload', markLeaving, once);
    document.addEventListener('yt-navigate-start', markLeaving, once);

    if (SWITCH_VIA_NATIVE_MENU && state.avatar) {
      // Put the playback time in the URL so YouTube's reload keeps it.
      try { history.replaceState(history.state, '', currentTargetUrl().href); } catch { /* ignore */ }

      const root = document.documentElement;
      root.classList.add('yts-scraping');
      try {
        await clickNativeAccountRow(account);
        await waitFor(() => leaving, NATIVE_SWITCH_TIMEOUT_MS).catch(() => {});
        if (leaving) {
          log('YouTube is switching via its native menu.');
          return;
        }
        warn('Native switch did not navigate; falling back to URL switch.');
      } catch (err) {
        warn('Native menu switch failed, falling back to URL switch:', err);
      }
      closeNativeMenu();
      setTimeout(() => root.classList.remove('yts-scraping'), 300);
    }

    const url = buildSwitchUrl(account);
    log('switching via URL to', account.name, '→', url);
    location.assign(url);
  }

  // ---------------------------------------------------------------------------
  // Dropdown rendering (DOM APIs only — no innerHTML)
  // ---------------------------------------------------------------------------

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function checkIcon() {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'yts-check');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', 'M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2z');
    svg.appendChild(path);
    return svg;
  }

  function ensureDropdown() {
    if (state.dropdown) return state.dropdown;
    const dropdown = el('div');
    dropdown.id = 'yts-dropdown';
    dropdown.setAttribute('role', 'menu');
    dropdown.setAttribute('aria-label', 'Switch account');
    dropdown.hidden = true;
    const opts = { signal: globalAbort.signal };
    dropdown.addEventListener('mouseenter', cancelHide, opts);
    dropdown.addEventListener('mouseleave', () => scheduleHide(), opts);
    document.body.appendChild(dropdown);
    state.dropdown = dropdown;
    return dropdown;
  }

  function setDropdownContent(...children) {
    const dropdown = ensureDropdown();
    dropdown.replaceChildren(...children);
    positionDropdown();
  }

  function renderLoading() {
    const list = el('div', 'yts-list');
    list.setAttribute('aria-busy', 'true');
    for (let i = 0; i < 3; i++) {
      const row = el('div', 'yts-row yts-skeleton');
      const lines = el('div', 'yts-text');
      lines.append(el('div', 'yts-skel-line'), el('div', 'yts-skel-line yts-skel-short'));
      row.append(el('div', 'yts-avatar yts-skel-avatar'), lines);
      list.appendChild(row);
    }
    setDropdownContent(list);
  }

  function renderError(message) {
    const box = el('div', 'yts-error');
    box.append(
      el('div', 'yts-error-title', message || 'Couldn’t load your accounts.'),
      el('div', 'yts-error-hint', 'Check the console for [YT-Switcher] logs.')
    );
    const retry = el('button', 'yts-retry', 'Try again');
    retry.type = 'button';
    retry.addEventListener('click', () => {
      state.switching = false;
      loadAndRender(true);
    });
    box.appendChild(retry);
    setDropdownContent(box);
  }

  /** Renders accounts grouped by Google account email (one group per authuser). */
  function renderAccounts(accounts) {
    const list = el('div', 'yts-list');
    let lastGroup = null;

    for (const account of accounts) {
      const group = account.email || '';
      if (group !== lastGroup) {
        if (group) list.appendChild(el('div', 'yts-group-label', group));
        lastGroup = group;
      }
      list.appendChild(renderAccountRow(account));
    }
    setDropdownContent(list);
  }

  function renderAccountRow(account) {
    const row = el('button', 'yts-row');
    row.type = 'button';
    row.setAttribute('role', 'menuitemradio');
    row.setAttribute('aria-checked', String(account.isSelected));
    if (account.isSelected) row.classList.add('yts-selected');
    if (account.isDisabled) row.disabled = true;
    row.title = [account.name, account.byline, account.email].filter(Boolean)
      .filter((v, i, arr) => arr.indexOf(v) === i).join('\n');

    let avatar;
    if (account.photoUrl) {
      avatar = el('img', 'yts-avatar');
      avatar.src = account.photoUrl;
      avatar.alt = '';
      avatar.referrerPolicy = 'no-referrer';
      avatar.loading = 'lazy';
    } else {
      avatar = el('div', 'yts-avatar yts-avatar-fallback', (account.name[0] || '?').toUpperCase());
    }

    const text = el('div', 'yts-text');
    text.append(el('div', 'yts-name', account.name));
    if (account.byline && account.byline !== account.name) {
      text.append(el('div', 'yts-byline', account.byline));
    }

    row.append(avatar, text);
    if (account.isSelected) row.appendChild(checkIcon());

    row.addEventListener('click', () => switchAccount(account, row));
    return row;
  }

  function setRowSwitching(row) {
    if (!row) return;
    row.classList.add('yts-switching');
    row.setAttribute('aria-busy', 'true');
    const text = row.querySelector('.yts-text');
    const status = el('div', 'yts-byline yts-status');
    status.append(el('span', 'yts-spinner'), document.createTextNode('Switching…'));
    const old = text.querySelector('.yts-byline');
    if (old) old.replaceWith(status); else text.appendChild(status);
    if (state.dropdown) {
      state.dropdown.querySelectorAll('.yts-row').forEach((r) => { if (r !== row) r.disabled = true; });
    }
  }

  /** Shows cached data instantly, or a skeleton while fetching. */
  async function loadAndRender(force) {
    const token = ++state.renderToken;
    const fresh = !force && state.cache && Date.now() - state.cache.ts < CACHE_TTL_MS;
    if (!fresh) renderLoading();
    try {
      const accounts = await loadAccounts(force);
      if (token === state.renderToken && !state.switching) renderAccounts(accounts);
    } catch (err) {
      warn('Could not load accounts:', err);
      if (token === state.renderToken) renderError();
    }
  }

  /** Right-aligns the dropdown just below the avatar. */
  function positionDropdown() {
    if (!state.dropdown || !state.avatar) return;
    const rect = state.avatar.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth;
    state.dropdown.style.top = `${Math.round(rect.bottom + 6)}px`;
    state.dropdown.style.right = `${Math.max(8, Math.round(viewportWidth - rect.right))}px`;
  }

  // ---------------------------------------------------------------------------
  // Show / hide
  // ---------------------------------------------------------------------------

  function isDropdownVisible() {
    return !!state.dropdown && !state.dropdown.hidden;
  }

  function showDropdown() {
    if (!state.avatar || !state.avatar.isConnected || state.suppressed || isNativeMenuOpen()) return;
    const dropdown = ensureDropdown();
    if (isDropdownVisible()) return;
    dropdown.hidden = false;
    positionDropdown();
    requestAnimationFrame(() => dropdown.classList.add('yts-open'));
    loadAndRender(false);
  }

  function hideDropdown() {
    clearTimeout(state.showTimer);
    clearTimeout(state.hideTimer);
    if (!state.dropdown || state.switching) return;
    state.dropdown.classList.remove('yts-open');
    state.dropdown.hidden = true;
  }

  function cancelHide() {
    clearTimeout(state.hideTimer);
  }

  function scheduleHide(delay = HIDE_DELAY_MS) {
    clearTimeout(state.showTimer);
    clearTimeout(state.hideTimer);
    state.hideTimer = setTimeout(hideDropdown, delay);
  }

  // ---------------------------------------------------------------------------
  // Avatar wiring
  // ---------------------------------------------------------------------------

  function findAvatarButton() {
    return (
      document.querySelector('ytd-masthead ytd-topbar-menu-button-renderer #avatar-btn') ||
      document.querySelector('ytd-masthead #avatar-btn') ||
      document.querySelector('#masthead #avatar-btn')
    );
  }

  function onAvatarEnter() {
    cancelHide();
    clearTimeout(state.showTimer);
    state.showTimer = setTimeout(showDropdown, SHOW_DELAY_MS);
  }

  function onAvatarLeave() {
    state.suppressed = false;
    scheduleHide();
  }

  /** Native click opens YouTube's menu — get out of its way. Never preventDefault. */
  function onAvatarClick() {
    if (state.internalClick) return;
    state.suppressed = true;
    hideDropdown();
  }

  function attachToAvatar() {
    const button = findAvatarButton();
    if (!button || button === state.avatar) return;
    detachFromAvatar();

    const ac = new AbortController();
    const opts = { signal: ac.signal };
    button.addEventListener('mouseenter', onAvatarEnter, opts);
    button.addEventListener('mouseleave', onAvatarLeave, opts);
    button.addEventListener('click', onAvatarClick, opts);
    button.dataset.ytsAttached = '1';

    state.avatar = button;
    state.avatarAbort = ac;
    log('attached to avatar button');
  }

  function detachFromAvatar() {
    if (state.avatarAbort) state.avatarAbort.abort();
    if (state.avatar) delete state.avatar.dataset.ytsAttached;
    state.avatar = null;
    state.avatarAbort = null;
    hideDropdown();
  }

  /** Re-attaches whenever YouTube swaps out (or first renders) the avatar. */
  function startObserver() {
    let scheduled = false;
    observer = new MutationObserver(() => {
      if (state.avatar && state.avatar.isConnected) return;
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        if (state.avatar && !state.avatar.isConnected) detachFromAvatar();
        attachToAvatar();
      });
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function onDocumentPointerDown(event) {
    if (!isDropdownVisible()) return;
    const target = event.target;
    if (state.dropdown.contains(target) || (state.avatar && state.avatar.contains(target))) return;
    hideDropdown();
  }

  function onKeyDown(event) {
    if (event.key === 'Escape' && isDropdownVisible()) hideDropdown();
  }

  function cleanup() {
    globalAbort.abort();
    if (observer) observer.disconnect();
    detachFromAvatar();
    if (state.dropdown) state.dropdown.remove();
    state.dropdown = null;
    window.__ytHoverSwitcherLoaded = false;
  }

  function init() {
    const opts = { signal: globalAbort.signal };
    document.addEventListener('yt-navigate-finish', attachToAvatar, opts);
    document.addEventListener('yt-navigate-start', hideDropdown, opts);
    document.addEventListener('pointerdown', onDocumentPointerDown, { ...opts, capture: true });
    document.addEventListener('keydown', onKeyDown, opts);
    window.addEventListener('resize', positionDropdown, opts);
    window.addEventListener('pagehide', (e) => { if (!e.persisted) cleanup(); }, opts);

    startObserver();
    attachToAvatar();
    log('initialised');
  }

  init();
})();
