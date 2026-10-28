# YT Account Switcher

Hover the avatar in YouTube's top-right corner to see every account in your browser session (name, handle/email, avatar, a check on the current one). Click one to switch to it, without opening YouTube's account menu.

Plain Manifest V3 JavaScript. No build step and no dependencies.

```
manifest.json   extension manifest (content script on https://www.youtube.com/*)
content.js      hover UI, account fetching/parsing, switching
styles.css      dropdown styles (light + dark)
icons/          extension icons (16, 32, 48, 128 px)
```

There is no background script because everything runs as a same-origin request from the content script.

## Install

### Chrome / Brave

1. Open `chrome://extensions` (or `brave://extensions`).
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select this folder (the one containing `manifest.json`).
4. Open or reload a tab on https://www.youtube.com.

After you edit the code, click the reload icon on the extension card and then reload the YouTube tab.

> Chrome may warn about the unrecognized `browser_specific_settings` key. That key is only for Firefox, so you can ignore the warning.

### Firefox

Version 1.0.0 is signed by Mozilla, so it installs permanently and survives restarts.

1. Download `hover-switcher-1.0.0.xpi` from the [latest release](https://github.com/lochansaroy02/yt-account-switcher/releases/latest).
2. Open the file in Firefox (drag it onto a window, or **File → Open File**) and click **Add**.
3. Open or reload https://www.youtube.com.

On Firefox versions older than 127, MV3 host access isn't granted automatically. Click the Extensions (puzzle) button, then this extension, then **Always allow on www.youtube.com**.

To update, install the newer `.xpi` from the releases page the same way. Firefox replaces the old version.

#### Developing in Firefox

To run your local changes, open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on…** and select `manifest.json` in this folder. Temporary add-ons are removed when Firefox restarts.

#### Building a release

Run `./build.sh`. It writes `dist/yt-account-switcher-<version>.zip`, which you upload to addons.mozilla.org (**On your own**) to get a signed `.xpi`. The script refuses to build while `DEBUG` is `true`.

## Usage

- **Hover** the avatar. After about 150 ms the account list appears under it.
- **Click** an account to switch. The row shows "Switching…" and the page reloads as that account. Your current path and query (`v=`, `list=`, …) are kept, and on a watch page so is your playback time (`t=`).
- **Click the avatar itself** to open YouTube's normal menu. The hover dropdown closes and doesn't get in the way.
- Press **Esc** or click elsewhere to close the dropdown.

The account list is cached for 5 minutes per tab.

## How it works

1. **Primary:** `GET https://www.youtube.com/getAccountSwitcherEndpoint` with your cookies. The extension strips the `)]}'` prefix, then searches the JSON recursively for account items (`accountName`, `accountByline`, `accountPhoto`, `isSelected`, and the `supportedTokens` that hold `pageId`, `obfuscatedGaiaId` and `signinUrl`).
2. **Fallback 1:** it looks for account data in the inline `ytInitialData` script.
3. **Fallback 2:** it opens YouTube's own account menu invisibly, goes to "Switch account", reads the rows from the page, and closes the menu again.

**Switching:** the extension opens YouTube's own account menu invisibly, goes to "Switch account", and clicks the matching row. That way YouTube's own switch logic runs and the new account actually sticks. Before clicking, it adds your playback time (`t=`) to the URL so it survives the reload.

If YouTube hasn't started navigating within 6 seconds, the extension falls back to a URL switch: YouTube's sign-in URL with `next` set to your current page, or `?authuser=N&pageId=…` if there's no sign-in URL. To skip the native menu and always use the URL method, set `SWITCH_VIA_NATIVE_MENU = false` in `content.js`.

The script only runs on `www.youtube.com`. It does nothing on YouTube Studio, music.youtube.com, embeds or iframes.

## Known limitations

- It relies on `getAccountSwitcherEndpoint`, an **undocumented YouTube endpoint** that may change or disappear without notice. The parser doesn't depend on exact JSON paths, but a large redesign would still break it.
- **The page reloads** when you switch accounts, which is how YouTube applies a new account.
- The native-menu fallback recognizes the "Switch account" item by its English label first and then by its position, so it may fail in some languages.
- If you're signed out, there is no avatar and nothing happens.

## Troubleshooting

1. Open DevTools (`Ctrl+Shift+I`) and go to the **Console** tab, then type `[YT-Switcher]` into the filter box.
2. You should see `[YT-Switcher] initialised` and `attached to avatar button`.
   - If neither appears, the extension isn't running. Check that it's enabled, reload the tab, and in Firefox check the host permission described above.
   - If you see `initialised` but not `attached`, YouTube probably renamed the avatar button. Run `document.querySelector('#avatar-btn')` in the console and report what it returns.
3. Set `DEBUG = true` at the top of `content.js`, reload the extension, and hover the avatar. The console shows:
   - `raw getAccountSwitcherEndpoint response:` followed by the full JSON
   - `parsed accounts:` followed by the extracted list
4. If the list is empty or wrong, right-click the raw response, choose **Copy string contents**, and share it so the parser can be fixed. **Redact first:** it contains your names, emails, handles and account IDs.
5. Set `DEBUG = false` again before building a release. Warnings are still printed either way.
