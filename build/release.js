// npm run release: build the installer and publish it as a GitHub release.
//
// electron-builder alone fails the first upload of every new version (its two
// parallel uploads each try to create the release; the second gets a 422). So we
// create the release ourselves as a draft, let electron-builder upload into it,
// then publish it. That also means installed copies never see a half-uploaded
// release.
const { spawnSync, execFileSync } = require('child_process');
const path = require('path');
const pkg = require('../package.json');

const { owner, repo } = pkg.build.publish[0];
const tag = `v${pkg.version}`;
const API = `https://api.github.com/repos/${owner}/${repo}`;

function token() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  // Fall back to the GitHub login git already has saved on this PC.
  try {
    const out = execFileSync('git', ['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8' });
    const m = /^password=(.+)$/m.exec(out);
    if (m) {
      console.log('Using the GitHub login saved in git.');
      return m[1].trim();
    }
  } catch { /* no saved login */ }
  return null;
}

const TOKEN = token();
if (!TOKEN) {
  console.error('No GitHub token. Set GH_TOKEN to a token with access to the repo, then run this again.');
  process.exit(1);
}

async function gh(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'deskscroller-release' },
    body: body && JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${await res.text()}`);
  return res.json();
}

// Exiting with process.exit() while fetch's sockets are still closing crashes
// Node on Windows, so failures throw and the exit code is set at the end.
const fail = (msg, code = 1) => { throw Object.assign(new Error(msg), { code }); };

// The releases list includes drafts, which "get release by tag" doesn't.
const findRelease = async () => (await gh('GET', `${API}/releases?per_page=100`)).find((r) => r.tag_name === tag);

(async () => {
  let release = await findRelease();
  if (release && !release.draft) fail(`${tag} is already published. Bump "version" in package.json first.`);
  if (!release) {
    release = await gh('POST', `${API}/releases`, { tag_name: tag, name: pkg.version, draft: true });
    console.log(`Created draft release ${tag}.`);
  }

  const cli = path.join(__dirname, '..', 'node_modules', 'electron-builder', 'cli.js');
  const build = spawnSync(process.execPath, [cli, '--win', '--publish', 'always'], {
    stdio: 'inherit',
    env: { ...process.env, GH_TOKEN: TOKEN },
  });
  if (build.status !== 0) fail(`Build or upload failed; the draft ${tag} is still on GitHub. Fix the problem and run this again.`, build.status || 1);

  const names = (await gh('GET', `${API}/releases/${release.id}/assets`)).map((a) => a.name);
  const missing = ['latest.yml', `DeskScroller-Setup-${pkg.version}.exe`].filter((n) => !names.includes(n));
  if (missing.length) fail(`Upload incomplete (missing ${missing.join(', ')}); leaving ${tag} as a draft.`);
  await gh('PATCH', `${API}/releases/${release.id}`, { draft: false, make_latest: 'true' });
  console.log(`Published ${tag}: https://github.com/${owner}/${repo}/releases/tag/${tag}`);
})().catch((err) => {
  console.error(err.message || err);
  process.exitCode = typeof err.code === 'number' ? err.code : 1;
});
