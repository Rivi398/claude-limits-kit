// Claude Max limits in the VS Code status bar: session (5h) and weekly usage with reset times.
// Reads the OAuth token Claude Code already stores locally and asks the same usage endpoint
// that Claude Code's /usage uses. The token goes only to api.anthropic.com.
const vscode = require('vscode');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const ru = (vscode.env.language || '').startsWith('ru');
const L = (r, e) => (ru ? r : e);
const locale = ru ? 'ru-RU' : undefined;

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
let statusItem;
let timer;
let lastGood = null; // { sPct, wPct, sReset, wReset, scoped, at:Date }
let backoffUntil = 0; // no network until then (after a 429)

// One cache shared by every VS Code window: with many windows open, each polling on its own
// keeps the endpoint permanently rate-limited. Only the window whose turn it is asks Anthropic.
const SHARED = path.join(os.tmpdir(), `claude-limits-statusbar-${os.userInfo().username}.json`);

function readShared() {
  try { return JSON.parse(fs.readFileSync(SHARED, 'utf8')); } catch { return {}; }
}

function writeShared(patch) {
  try {
    const tmp = `${SHARED}.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ ...readShared(), ...patch }), { mode: 0o600 });
    fs.renameSync(tmp, SHARED);
  } catch { /* the cache is an optimisation only */ }
}

function fromShared(shared) {
  if (!shared.data || !shared.at) return null;
  return { ...shared.data, at: new Date(shared.at) };
}

function tokenFrom(json) {
  const token = JSON.parse(json).claudeAiOauth?.accessToken;
  if (!token) throw new Error('no accessToken');
  return token;
}

function keychain(args) {
  return new Promise((resolve, reject) => {
    execFile('security', ['find-generic-password', '-s', 'Claude Code-credentials', ...args, '-w'],
      { timeout: 5000 }, (err, stdout) => (err ? reject(err) : resolve(stdout.trim())));
  });
}

// Fresh OAuth token. macOS: Keychain item "Claude Code-credentials" (there can be two;
// the live one has account = user name). Linux/Windows: ~/.claude/.credentials.json.
async function getToken() {
  if (process.platform === 'darwin') {
    for (const args of [['-a', os.userInfo().username], []]) {
      try { return tokenFrom(await keychain(args)); } catch { /* try the next source */ }
    }
  }
  const file = path.join(os.homedir(), '.claude', '.credentials.json');
  try {
    return tokenFrom(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error(L('нет входа в Claude Code (claude /login)', 'not logged in to Claude Code (claude /login)'));
  }
}

function fetchUsage(token) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      USAGE_URL,
      {
        method: 'GET',
        headers: {
          Authorization: 'Bearer ' + token,
          'anthropic-beta': 'oauth-2025-04-20',
        },
        timeout: 10000,
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          if (res.statusCode === 429) {
            const e = new Error('rate_limit');
            e.rateLimited = true;
            return reject(e);
          }
          if (res.statusCode !== 200) {
            return reject(new Error('HTTP ' + res.statusCode + ': ' + body.slice(0, 120)));
          }
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(new Error('bad JSON'));
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  });
}

function untilText(iso) {
  if (!iso) return '—';
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return L('скоро', 'soon');
  const min = Math.round(ms / 60000);
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h}${L('ч', 'h')} ${m}${L('м', 'm')}` : `${m}${L('м', 'm')}`;
}

function fmtReset(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString(locale, {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
    });
  } catch (e) {
    return iso;
  }
}

// Draw from cache. stale = the last refresh failed, showing older data.
function render(stale, errMsg) {
  if (!lastGood) {
    statusItem.text = '$(pulse) CC —';
    statusItem.color = new vscode.ThemeColor('statusBarItem.warningForeground');
    statusItem.tooltip = L('Claude Usage: нет данных', 'Claude Usage: no data') + (errMsg ? ': ' + errMsg : '') +
      L('\n(клик — обновить)', '\n(click to refresh)');
    return;
  }
  const g = lastGood;
  statusItem.text = `${stale ? '$(history)' : '$(pulse)'} ${L('5ч', '5h')} ${g.sPct}% · ${L('7д', '7d')} ${g.wPct}%`;
  statusItem.color =
    g.sPct >= 90 || g.wPct >= 90
      ? new vscode.ThemeColor('statusBarItem.errorForeground')
      : undefined;

  const scopedLine = g.scoped
    ? `\n\n${L('Неделя', 'Weekly')} (${g.scoped.model}): ${g.scoped.percent}% · ${L('сброс', 'resets')} ${fmtReset(g.scoped.reset)}`
    : '';
  const staleLine = stale
    ? `\n\n⚠️ ${L('обновить не удалось', 'refresh failed')} (${errMsg || 'error'}), ${L('данные от', 'data from')} ${g.at.toLocaleTimeString(locale)}`
    : `\n\n_${L('обновлено', 'updated')} ${g.at.toLocaleTimeString(locale)}_`;

  const md = new vscode.MarkdownString(
    `**${L('Лимиты Claude', 'Claude limits')}**\n\n` +
      `**${L('Сессия (5ч)', 'Session (5h)')}:** ${g.sPct}%  ·  ${L('сброс через', 'resets in')} ${untilText(g.sReset)}\n` +
      `${L('сброс', 'resets')}: ${fmtReset(g.sReset)}\n\n` +
      `**${L('Неделя (7д)', 'Weekly (7d)')}:** ${g.wPct}%  ·  ${L('сброс через', 'resets in')} ${untilText(g.wReset)}\n` +
      `${L('сброс', 'resets')}: ${fmtReset(g.wReset)}` +
      scopedLine +
      staleLine +
      `\n\n${L('клик — обновить', 'click to refresh')}`
  );
  md.isTrusted = true;
  statusItem.tooltip = md;
}

async function update(manual) {
  // Click throttle: data under 45 s old is just redrawn, no request.
  if (manual && lastGood && Date.now() - lastGood.at.getTime() < 45000) {
    render(false);
    return;
  }
  // Back off after a 429: the endpoint allows about one request a minute.
  if (!manual && Date.now() < backoffUntil) {
    render(!!lastGood, 'rate limit');
    return;
  }

  // Fresh numbers from another window, or someone else is fetching right now: just use them.
  const shared = readShared();
  const interval = Math.max(60, vscode.workspace.getConfiguration('ccusage').get('refreshIntervalSeconds') || 300);
  const freshFor = manual ? 45000 : (interval - 5) * 1000;
  if (shared.at && Date.now() - shared.at < freshFor) {
    lastGood = fromShared(shared);
    render(false);
    return;
  }
  if (Date.now() < (shared.backoffUntil || 0) || Date.now() - (shared.fetchingSince || 0) < 15000) {
    lastGood = fromShared(shared) || lastGood;
    render(!!lastGood, 'rate limit');
    return;
  }
  writeShared({ fetchingSince: Date.now() });

  try {
    const token = await getToken();
    const data = await fetchUsage(token);
    const s = data.five_hour || {};
    const w = data.seven_day || {};
    const scopedRaw = (data.limits || []).find((l) => l.kind === 'weekly_scoped');
    lastGood = {
      sPct: Math.round(s.utilization ?? 0),
      wPct: Math.round(w.utilization ?? 0),
      sReset: s.resets_at,
      wReset: w.resets_at,
      scoped: scopedRaw
        ? {
            model: scopedRaw.scope?.model?.display_name || 'model',
            percent: scopedRaw.percent,
            reset: scopedRaw.resets_at,
          }
        : null,
      at: new Date(),
    };
    backoffUntil = 0;
    const { at, ...plain } = lastGood;
    writeShared({ data: plain, at: at.getTime(), backoffUntil: 0, fetchingSince: 0 });
    render(false);
  } catch (e) {
    if (e.rateLimited) {
      // Wait a minute before trying again; keep the old numbers.
      backoffUntil = Date.now() + 60000;
    }
    writeShared({ backoffUntil: e.rateLimited ? backoffUntil : 0, fetchingSince: 0 });
    render(!!lastGood, e.rateLimited ? 'rate limit' : e.message);
  }
}

function schedule() {
  if (timer) clearInterval(timer);
  const sec =
    vscode.workspace.getConfiguration('ccusage').get('refreshIntervalSeconds') || 300;
  timer = setInterval(() => update(false), Math.max(60, sec) * 1000);
}

function activate(context) {
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.command = 'ccusage.refresh';
  statusItem.text = '$(pulse) CC …';
  statusItem.show();
  context.subscriptions.push(statusItem);

  context.subscriptions.push(vscode.commands.registerCommand('ccusage.refresh', () => update(true)));
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('ccusage.refreshIntervalSeconds')) schedule();
    })
  );

  update(false);
  schedule();
}

function deactivate() {
  if (timer) clearInterval(timer);
}

module.exports = { activate, deactivate };
