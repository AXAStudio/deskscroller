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
- Feeds load when you open them, with a loading screen until the video is ready. To keep memory low, a feed you switch away from is unloaded after 3 minutes (the browser tab after 10, and it reopens on the same page), and everything is unloaded once the overlay has been hidden for 5 minutes; the tab you were on reloads when you show it again. **Keep feeds loaded** (Settings) keeps every feed running for instant switching, at roughly 300 MB per feed.
- **Skip ads** (Settings, on by default) skips ads in Shorts, Reels and TikTok straight to the next video, in fill mode. It looks for each site's ad markers and the "Sponsored" / "Ad" label, so if a site changes how it labels ads, some may get through until DeskScroller is updated.
- TikTok **slideshows** (photo posts) play in fill mode too: the pictures advance by themselves with the music, click pauses both, and the ‹ › buttons at the bottom (or scrolling sideways) flip through the pictures.
- Videos pause whenever they're covered: a different feed tab, the Accounts or Settings panel, or the overlay being hidden.
- **Anti-stretch** (Settings → Gaming) keeps the overlay the same size, shape and place when you play in a stretched resolution, such as 4:3 stretched in The Finals. It compares Windows' current resolution with your monitor's native resolution, so it works whether the game switches resolution or you set the stretched resolution as your desktop resolution, and squeezes the overlay by the amount your GPU or monitor will stretch it.
- **Remote desktop mode** (Settings, or right-click the tray icon) makes the overlay visible over Chrome Remote Desktop and other screen capture. It turns off GPU acceleration and opacity, and restarts DeskScroller when toggled.
- The **×** button (or Alt+F4) quits DeskScroller. The show/hide hotkey only hides it.

## Development

Set `DESKSCROLLER_PROFILE` to a folder to run a second, independent copy with its own profile, without touching your real logins and settings.

## Releasing an update

1. Bump `version` in `package.json` (e.g. `1.0.0` → `1.0.1`).
2. Optional: set `GH_TOKEN` to a GitHub token with access to this repo. Without it, the GitHub login saved in git is used.
3. Run `npm run release`. It builds the installer, uploads it with `latest.yml` to a draft GitHub release, and publishes the release once every file is up. Installed copies pick it up on their next check.

`npm run dist` builds the installer into `dist/` without publishing.
