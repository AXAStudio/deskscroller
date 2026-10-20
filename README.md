# DeskScroller

An always-on-top overlay window for YouTube Shorts, Instagram Reels, and TikTok that sits over your game.

## Install

Download `DeskScroller-Setup-<version>.exe` from [Releases](https://github.com/AXAStudio/deskscroller/releases/latest) and run it. It installs for your user (no admin needed) and adds Start menu and desktop shortcuts.

The installed app checks GitHub for a new release at startup and every 3 hours. A new version downloads in the background; when it's ready, DeskScroller shows **Updating DeskScroller** for a moment and restarts into it. **Settings → About** shows your version and has **Check for updates**.

## Run from source

Double-click `start.bat`, or run `npm start`. Copies run from source never update themselves.

## Hotkeys (global, rebindable in Settings)

| Action              | Default              |
| ------------------- | -------------------- |
| Show / hide overlay | Ctrl + Shift + Space |
| Next / previous     | Ctrl + Shift + ↓ / ↑ |
| Play / pause        | Ctrl + Shift + K     |
| Mute                | Ctrl + Shift + M     |
| Click-through mode  | Ctrl + Shift + X     |

## Notes

- Games must run in **borderless / windowed** mode. Exclusive fullscreen draws over every other window.
- Log in under **Accounts** (person icon). Sessions are saved in `%APPDATA%\DeskScroller`.
- Google blocks sign-in inside apps, so YouTube (and the **Chrome** button on the other services) logs in through a plain Chrome or Edge window that uses a separate DeskScroller profile. Log in, then close that window, and DeskScroller copies the session into the overlay.
- **Smart focus** (Settings, on by default) lets you click and scroll videos without your game losing focus. The overlay takes keyboard focus automatically when you need to type: clicking a text box (comments, login forms), logging in, or using the browser tab. Clicking anything else, or back into your game, hands focus back.
- The **Web** tab (globe icon) is a regular browser with an address bar: type a URL or search terms. It opens on a start page with a search box, shortcuts and the sites you visited recently (hover one and click × to remove it). Back from your first page, or the start-page button in the address bar, returns to it. Links the feeds open in a new tab land there too. It shares DeskScroller's logins.
- **Fill mode** (the corner-brackets button in the toolbar) makes the video fill the overlay. Click to pause, scroll for next/previous (the next video slides in and starts playing right away), and use the buttons on the right to like, comment, share or mute. Comments and share open in the site's own layout; **Back to video** (or Escape) returns to fill mode. Turn it off to see the site's own layout with likes, comments and captions.
- All three feeds load at startup in the background, so switching between them is instant. A loading screen covers each feed until its video is ready.
- Videos pause whenever they're covered: a different feed tab, the Accounts or Settings panel, or the overlay being hidden.
- **Remote desktop mode** (Settings, or right-click the tray icon) makes the overlay visible over Chrome Remote Desktop and other screen capture. It turns off GPU acceleration and opacity, and restarts DeskScroller when toggled.
- The **×** button (or Alt+F4) quits DeskScroller. The show/hide hotkey only hides it.

## Development

Set `DESKSCROLLER_PROFILE` to a folder to run a second, independent copy with its own profile, without touching your real logins and settings.

## Releasing an update

1. Bump `version` in `package.json` (e.g. `1.0.0` → `1.0.1`).
2. Optional: set `GH_TOKEN` to a GitHub token with access to this repo. Without it, the GitHub login saved in git is used.
3. Run `npm run release`. It builds the installer, uploads it with `latest.yml` to a draft GitHub release, and publishes the release once every file is up. Installed copies pick it up on their next check.

`npm run dist` builds the installer into `dist/` without publishing.
