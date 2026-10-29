/* Discord HTTP interactions on Cloudflare Workers Free + D1 Free.
 * No npm packages, Gateway connection, paid storage, or always-on process. */
const API = 'https://discord.com/api/v10';
const NONE = { parse: [], users: [], roles: [], replied_user: false };
const TERMINAL = new Set(['approved', 'denied', 'cancelled', 'expired', 'failed']);
const P = { ADMIN: 8n, MANAGE_ROLES: 1n << 28n, VIEW: 1n << 10n,
  SEND: 1n << 11n, EMBED: 1n << 14n, ATTACH: 1n << 15n, HISTORY: 1n << 16n };
const FORBIDDEN_ROLE_BITS = [1, 2, 3, 4, 5, 13, 17, 27, 28, 29, 30, 33, 34, 40]
  .reduce((bits, position) => bits | (1n << BigInt(position)), 0n);
export class UserError extends Error {}
export class DiscordError extends Error {
  constructor(status, retry = 60) { super(`Discord HTTP ${status}`); this.status = status; this.retry = retry; }
}
const now = () => Math.floor(Date.now() / 1000);
const uid = i => i.member?.user?.id;
const json = (data, status = 200) => Response.json(data, { status });
const privateReply = content => json({ type: 4, data: { content, flags: 64, allowed_mentions: NONE } });
const deferred = () => json({ type: 5, data: { flags: 64 } });
const changed = result => result.meta.changes > 0;
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS installation (singleton INTEGER PRIMARY KEY CHECK(singleton=1), application_id TEXT NOT NULL, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, bot_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS requests (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL, role_id TEXT NOT NULL,
 status TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL,
 message_id TEXT, reviewer_id TEXT, decided INTEGER, error TEXT,
 next_at INTEGER NOT NULL, lease_until INTEGER NOT NULL DEFAULT 0, lease_owner TEXT,
 dirty INTEGER NOT NULL DEFAULT 0, notified TEXT NOT NULL DEFAULT 'waiting',
 cleaned INTEGER NOT NULL DEFAULT 0, scan_before TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS one_open ON requests(user_id) WHERE status IN ('receiving','pending','approving');
CREATE INDEX IF NOT EXISTS quota_user ON requests(user_id,created);
CREATE INDEX IF NOT EXISTS quota_created ON requests(created);
CREATE INDEX IF NOT EXISTS maintenance_due ON requests(next_at,lease_until);
CREATE INDEX IF NOT EXISTS status_index ON requests(status);
`;

export function config(env) {
  const c = JSON.parse(env.CONFIG_JSON || '{}');
  const snowflake = s => typeof s === 'string' && /^\d{17,20}$/.test(s);
  if (![env.APPLICATION_ID, c.guild_id, c.review_channel_id].every(snowflake))
    throw new UserError('Set APPLICATION_ID and the server/channel IDs as quoted Discord IDs.');
  if (!Array.isArray(c.reviewer_role_ids) || !c.reviewer_role_ids.length ||
      !c.reviewer_role_ids.every(snowflake)) throw new UserError('Configure reviewer role IDs.');
  const roles = Object.entries(c.roles || {});
  if (!roles.length || roles.length > 25 || roles.some(([label, id]) => !label.length || label.length > 100 || !snowflake(id)) ||
      new Set(roles.map(([, id]) => id)).size !== roles.length || roles.some(([, id]) => c.reviewer_role_ids.includes(id)))
    throw new UserError('Configure 1–25 distinct selectable roles; reviewer roles cannot be selectable.');
  c.application_id = env.APPLICATION_ID;
  if (c.notify_dms === undefined) c.notify_dms = true;
  if (typeof c.notify_dms !== 'boolean') throw new UserError('Set notify_dms to true or false, without quotes.');
  c.max_bytes ??= 4 * 1024 * 1024;
  c.pending_hours ??= 168;
  c.evidence_hours ??= 24;
  c.audit_days ??= 30;
  c.max_open ??= 25;
  c.requests_per_hour ??= 3;
  c.requests_per_day ??= 100;
  for (const [key, max] of Object.entries({ max_bytes: 8 * 1024 * 1024, pending_hours: 720,
    evidence_hours: 168, audit_days: 90, max_open: 50, requests_per_hour: 10, requests_per_day: 250 })) {
    if (!Number.isInteger(c[key]) || c[key] < 1 || c[key] > max) throw new UserError(`Invalid limit: ${key}.`);
  }
  return c;
}

async function api(env, path, method = 'GET', body, anonymous = false) {
  const headers = anonymous ? {} : { Authorization: `Bot ${env.DISCORD_TOKEN}` };
  if (body !== undefined && !(body instanceof FormData)) {
    headers['Content-Type'] = 'application/json'; body = JSON.stringify(body);
  }
  const response = await fetch(API + path, { method, headers, body, signal: AbortSignal.timeout(8000) });
  if (!response.ok) {
    let retry = 60;
    if (response.status === 429) {
      const payload = await response.json().catch(() => ({}));
      retry = Math.max(60, Math.ceil(Number(payload.retry_after) || 60));
    } else await response.body?.cancel();
    throw new DiscordError(response.status, retry);
  }
  return response.status === 204 ? null : response.json();
}
async function installation(env, c) {
  const row = await env.DB.prepare('SELECT * FROM installation WHERE singleton=1').first();
  if (!row || row.application_id !== c.application_id || row.guild_id !== c.guild_id || row.channel_id !== c.review_channel_id)
    throw new UserError('Setup is incomplete or this database belongs to another bot/server/channel.');
  return row;
}
export function permissions(roles, member, guildId, channel) {
  let bits = BigInt(roles.find(r => r.id === guildId)?.permissions || 0);
  for (const r of roles) if (member.roles.includes(r.id)) bits |= BigInt(r.permissions);
  if (bits & P.ADMIN) return (1n << 64n) - 1n;
  if (!channel) return bits;
  const overwrites = channel.permission_overwrites || [];
  const everyone = overwrites.find(o => o.id === guildId && o.type === 0);
  if (everyone) bits = (bits & ~BigInt(everyone.deny)) | BigInt(everyone.allow);
  let allow = 0n, deny = 0n;
  for (const o of overwrites) if (o.type === 0 && member.roles.includes(o.id)) {
    allow |= BigInt(o.allow); deny |= BigInt(o.deny);
  }
  bits = (bits & ~deny) | allow;
  const personal = overwrites.find(o => o.type === 1 && o.id === member.user.id);
  if (personal) bits = (bits & ~BigInt(personal.deny)) | BigInt(personal.allow);
  return bits;
}
export function checkChannel(c, botId, channel, roles, me) {
  if (channel.type !== 0 || channel.guild_id !== c.guild_id) throw new UserError('Use a text review channel in the configured server.');
  const overwrites = channel.permission_overwrites || [];
  if (!overwrites.some(o => o.type === 0 && o.id === c.guild_id && (BigInt(o.deny) & P.VIEW)))
    throw new UserError('Deny @everyone View Channel in the review channel.');
  for (const o of overwrites) if (BigInt(o.allow) & P.VIEW) {
    if (!((o.type === 0 && c.reviewer_role_ids.includes(o.id)) || (o.type === 1 && o.id === botId)))
      throw new UserError('Review channel View Channel allows must be limited to reviewer roles and the bot member.');
  }
  const required = P.VIEW | P.SEND | P.EMBED | P.ATTACH | P.HISTORY;
  if (!(permissions(roles, me, c.guild_id) & P.MANAGE_ROLES) ||
      (permissions(roles, me, c.guild_id, channel) & required) !== required)
    throw new UserError('The bot needs Manage Roles plus review-channel viewing, messaging, history, embeds and attachments.');
  for (const id of c.reviewer_role_ids) {
    if (!roles.some(r => r.id === id) || !(permissions(roles, { roles: [id], user: { id: '0' } }, c.guild_id, channel) & P.VIEW))
      throw new UserError('A reviewer role is missing or cannot see the review channel.');
  }
}
export function higher(a, b) {
  return a.position > b.position || (a.position === b.position && BigInt(a.id) < BigInt(b.id));
}
export function targetRole(c, roles, me, roleId) {
  const role = roles.find(r => r.id === roleId);
  const top = roles.filter(r => r.id === c.guild_id || me.roles.includes(r.id)).reduce((a, b) => higher(a, b) ? a : b);
  if (!Object.values(c.roles).includes(roleId) || !role || role.id === c.guild_id || role.managed || !higher(top, role))
    throw new UserError('This role is unavailable, managed, or not below the bot’s highest role.');
  if (BigInt(role.permissions) & FORBIDDEN_ROLE_BITS) throw new UserError('Privileged roles cannot be requested.');
  return role;
}
export function authorize(c, member, applicantId) {
  if (member.user.id === applicantId) throw new UserError('You cannot review your own request.');
  if (member.user.bot || !member.roles.some(id => c.reviewer_role_ids.includes(id)))
    throw new UserError('You do not currently hold a configured reviewer role.');
}
async function environment(env, c) {
  const install = await installation(env, c);
  const [channel, roles, me] = await Promise.all([
    api(env, `/channels/${c.review_channel_id}`), api(env, `/guilds/${c.guild_id}/roles`),
    api(env, `/guilds/${c.guild_id}/members/${install.bot_id}`),
  ]);
  checkChannel(c, install.bot_id, channel, roles, me);
  return { install, channel, roles, me };
}

export async function readBounded(stream, limit) {
  const reader = stream.getReader(); const chunks = []; let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      total += value.length;
      if (total > limit) throw new UserError('File or request exceeds its size limit.');
      chunks.push(value);
    }
  } catch (e) { await reader.cancel().catch(() => {}); throw e; }
  const result = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}
export function extension(b) {
  const at = (s, n = 0) => [...s].every((x, i) => b[n + i] === x.charCodeAt(0));
  if (at('\x89PNG\r\n\x1a\n')) return 'png';
  if (at('\xff\xd8\xff')) return 'jpg';
  if (at('GIF87a') || at('GIF89a')) return 'gif';
  if (at('RIFF') && at('WEBP', 8)) return 'webp';
  if (at('\x1aE\xdf\xa3') && new TextDecoder().decode(b.slice(0, 4096)).includes('webm')) return 'webm';
  if (b.length >= 16 && at('ftyp', 4)) {
    // Read only the declared file-type box, never bytes in later media boxes.
    const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let size = view.getUint32(0), header = 8;
    if (size === 1) {
      const wideSize = view.getBigUint64(8);
      if (wideSize > 4096n) return null;
      size = Number(wideSize); header = 16;
    }
    if (size < header + 8 || size > b.length || size > 4096 || (size - header - 8) % 4) return null;
    const brands = new Set([new TextDecoder().decode(b.subarray(header, header + 4))]);
    for (let n = header + 8; n < size; n += 4) brands.add(new TextDecoder().decode(b.subarray(n, n + 4)));
    const has = values => values.some(value => brands.has(value));
    // AVIF shares generic HEIF brands but is outside this bot's allowlist.
    if (has(['avif', 'avis'])) return null;
    if (has(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs'])) return 'heic';
    if (has(['mif1', 'mif2', 'msf1'])) return 'heif';
    if (brands.has('qt  ')) return 'mov';
    if (has(['isom', 'iso2', 'mp41', 'mp42', 'avc1', 'M4V '])) return 'mp4';
  }
  return null;
}
export function trustedURL(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && ['cdn.discordapp.com', 'media.discordapp.net'].includes(u.hostname) &&
      !u.username && !u.password && !u.port && /^\/(?:ephemeral-)?attachments\//.test(u.pathname);
  } catch { return false; }
}
async function download(attachment, c) {
  if (!Number.isInteger(attachment.size) || attachment.size <= 0) throw new UserError('Discord reported an invalid attachment size. Please upload the file again.');
  if (attachment.size > c.max_bytes) throw new UserError(`The file exceeds the ${c.max_bytes / 1048576} MiB limit. Compress it and submit again.`);
  if (!trustedURL(attachment.url)) throw new UserError('The attachment URL is not a supported Discord upload URL. Please upload the file again.');
  const response = await fetch(attachment.url, { redirect: 'manual', signal: AbortSignal.timeout(12000) });
  if (response.status !== 200) {
    await response.body?.cancel(); throw new UserError('Discord could not provide the attachment. Please upload the file again.');
  }
  if (Number(response.headers.get('Content-Length')) > c.max_bytes) {
    await response.body?.cancel(); throw new UserError(`The downloaded file exceeds the ${c.max_bytes / 1048576} MiB limit. Compress it and submit again.`);
  }
  const bytes = await readBounded(response.body, c.max_bytes), ext = extension(bytes);
  if (bytes.length !== attachment.size) throw new UserError('The downloaded file size did not match Discord’s attachment size. Please upload the original file again.');
  if (!ext) throw new UserError('The file contents were not recognized as PNG, JPEG, GIF, WebP, HEIC, HEIF, MP4, MOV or WebM. Renaming a file does not convert its format.');
  return { bytes, ext };
}
export function components(row) {
  if (row.status !== 'pending') return [];
  return [{ type: 1, components: [
    { type: 2, style: 3, label: 'Approve', custom_id: `rv:approve:${row.id}` },
    { type: 2, style: 4, label: 'Deny', custom_id: `rv:deny:${row.id}` },
  ] }];
}
function card(row) {
  const fields = [{ name: 'Member', value: `<@${row.user_id}> (${row.user_id})` },
    { name: 'Requested role', value: `<@&${row.role_id}> (${row.role_id})` },
    { name: 'Status', value: row.status }, { name: 'Submitted', value: `<t:${row.created}:f>` }];
  if (row.reviewer_id) fields.push({ name: 'Reviewer', value: `<@${row.reviewer_id}>` });
  if (row.error) fields.push({ name: 'Action needed', value: row.error });
  return { title: 'Role verification', color: 5793266, fields, footer: { text: `verification:${row.id}` } };
}
const getRow = (env, id) => env.DB.prepare('SELECT * FROM requests WHERE id=?').bind(id).first();
async function finish(env, id, status, from, error = null) {
  await env.DB.prepare(`UPDATE requests SET status=?, decided=?, error=?, dirty=1, next_at=? WHERE id=? AND status=?`)
    .bind(status, now(), error, now(), id, from).run();
}
async function original(env, i, message) {
  return api(env, `/webhooks/${i.application_id}/${i.token}/messages/@original`, 'PATCH',
    { content: message, allowed_mentions: NONE, components: [] }, true);
}
function safeError(e) {
  return e instanceof UserError ? e.message : 'Discord or storage is temporarily unavailable. Check /verification_status before submitting again.';
}
function logFailure(label, id, e) { console.warn(label, id, e.name, e.status || ''); }

export async function reserve(env, c, i, roleId) {
  const time = now();
  const result = await env.DB.prepare(`INSERT OR IGNORE INTO requests
    (id,user_id,role_id,status,created,expires,next_at,lease_until)
    SELECT ?,?,?,'receiving',?,?,?,?
    WHERE (SELECT count(*) FROM requests WHERE user_id=? AND created>?) < ?
    AND (SELECT count(*) FROM requests WHERE created>?) < ?
    AND (SELECT count(*) FROM requests WHERE status IN ('receiving','pending','approving')) < ?`)
    .bind(i.id, uid(i), roleId, time, time + c.pending_hours * 3600, time + 120, time + 120,
      uid(i), time - 3600, c.requests_per_hour, time - 86400, c.requests_per_day, c.max_open).run();
  if (!changed(result)) throw new UserError('You already have an open request, or a request/queue limit was reached. Use /verification_status or try later.');
  return getRow(env, i.id);
}
async function submit(env, c, i, roleId) {
  if (!Object.values(c.roles).includes(roleId)) throw new UserError('This role is no longer available.');
  const field = i.data.components?.flatMap(item => item.component ? [item.component] : item.components || [])
    .find(item => item.type === 19 && item.custom_id === 'evidence');
  if (field?.values?.length !== 1) throw new UserError('Upload exactly one file.');
  const attachment = i.data.resolved?.attachments?.[field.values[0]];
  if (!attachment) throw new UserError('Missing attachment. Submit a new form.');
  const context = await environment(env, c);
  targetRole(c, context.roles, context.me, roleId);
  const member = await api(env, `/guilds/${c.guild_id}/members/${uid(i)}`);
  if (member.roles.includes(roleId)) throw new UserError('You already have this role.');
  const row = await reserve(env, c, i, roleId);
  let sending = false;
  try {
    const file = await download(attachment, c);
    // Recheck privacy immediately before the evidence leaves this invocation.
    const channel = await api(env, `/channels/${c.review_channel_id}`);
    checkChannel(c, context.install.bot_id, channel, context.roles, context.me);
    const pending = { ...row, status: 'pending' };
    const form = new FormData();
    form.append('payload_json', JSON.stringify({
      content: c.reviewer_role_ids.map(id => `<@&${id}>`).join(' ') +
        (['heic', 'heif'].includes(file.ext) ? '\nHEIC/HEIF image: a preview may be unavailable. Download the attachment and open it in a compatible image viewer to review it.' : ''),
      embeds: [card(pending)],
      components: components(pending), allowed_mentions: { ...NONE, roles: c.reviewer_role_ids },
      nonce: row.id, enforce_nonce: true,
      attachments: [{ id: 0, filename: `SPOILER_evidence.${file.ext}` }],
    }));
    form.append('files[0]', new Blob([file.bytes]), `SPOILER_evidence.${file.ext}`);
    sending = true;
    const message = await api(env, `/channels/${c.review_channel_id}/messages`, 'POST', form);
    await env.DB.prepare(`UPDATE requests SET status='pending',message_id=?,next_at=?,lease_until=0 WHERE id=? AND status='receiving'`)
      .bind(message.id, Math.min(now() + 3600, row.expires), row.id).run();
    return `Request ${row.id} is ready for private review. Use /verification_status to check progress.`;
  } catch (e) {
    if (!sending) await finish(env, row.id, 'failed', 'receiving', e instanceof UserError ? e.message : 'Upload failed while contacting Discord or processing the file. Please submit again.');
    // An ambiguous send is reconciled by scanning the dedicated channel, never blindly repeated.
    throw e;
  }
}

export async function claimDecision(env, row, reviewer, approve) {
  const owner = crypto.randomUUID();
  const result = await env.DB.prepare(`UPDATE requests SET status=?,reviewer_id=?,decided=?,dirty=1,error=NULL,
    next_at=?,lease_until=?,lease_owner=? WHERE id=? AND status='pending' AND expires>?`)
    .bind(approve ? 'approving' : 'denied', reviewer, approve ? null : now(), now(),
      approve ? now() + 120 : 0, owner, row.id, now()).run();
  return changed(result);
}
export async function applyApproval(env, c, row) {
  try {
    const context = await environment(env, c);
    let member;
    try { member = await api(env, `/guilds/${c.guild_id}/members/${row.user_id}`); }
    catch (e) {
      if (e.status !== 404) throw e;
      await finish(env, row.id, 'failed', 'approving', 'Member left before approval completed.'); return;
    }
    // Reconcile a prior successful PUT if the worker stopped before its database write.
    if (member.roles.includes(row.role_id)) { await finish(env, row.id, 'approved', 'approving'); return; }
    targetRole(c, context.roles, context.me, row.role_id);
    const reviewer = await api(env, `/guilds/${c.guild_id}/members/${row.reviewer_id}`);
    authorize(c, reviewer, row.user_id);
    await api(env, `/guilds/${c.guild_id}/members/${row.user_id}/roles/${row.role_id}`, 'PUT');
    await finish(env, row.id, 'approved', 'approving');
  } catch (e) {
    await env.DB.prepare(`UPDATE requests SET error=?,dirty=1,next_at=? WHERE id=? AND status='approving'`)
      .bind('Approval is reserved and will retry. ' + safeError(e), now() + (e.retry || 60), row.id).run();
    logFailure('Approval awaiting recovery', row.id, e);
  }
}
async function review(env, c, i, action, id) {
  const row = await getRow(env, id);
  if (!row || i.channel_id !== c.review_channel_id || row.message_id !== i.message?.id)
    throw new UserError('Stale or unregistered review card. Wait for recovery.');
  const context = await environment(env, c);
  const reviewer = await api(env, `/guilds/${c.guild_id}/members/${uid(i)}`);
  authorize(c, reviewer, row.user_id);
  if (row.status !== 'pending') throw new UserError(`This request is already ${row.status}.`);
  if (now() >= row.expires) {
    await finish(env, row.id, 'expired', 'pending'); throw new UserError('This request expired. The member must submit again.');
  }
  const message = await api(env, `/channels/${c.review_channel_id}/messages/${row.message_id}`);
  if (message.author.id !== context.install.bot_id || !message.attachments?.length) {
    await finish(env, row.id, 'failed', 'pending', 'Review evidence is missing. Submit again.');
    throw new UserError('The review evidence is missing.');
  }
  if (action === 'approve') targetRole(c, context.roles, context.me, row.role_id);
  if (!(await claimDecision(env, row, uid(i), action === 'approve'))) throw new UserError('This request was already decided or its review deadline passed.');
  if (action === 'approve') {
    try { await applyApproval(env, c, await getRow(env, row.id)); }
    finally { await env.DB.prepare('UPDATE requests SET lease_until=0 WHERE id=?').bind(row.id).run(); }
  }
  const latest = await getRow(env, row.id);
  return `Decision recorded: ${latest.status}. The review card will update during maintenance.${c.notify_dms === false ? '' : ' A member DM will also be attempted.'}`;
}

async function reconcileUpload(env, c, row, botId) {
  const query = row.scan_before ? `&before=${row.scan_before}` : '';
  const messages = await api(env, `/channels/${c.review_channel_id}/messages?limit=100${query}`);
  const matches = messages.filter(m => m.author.id === botId && m.embeds?.[0]?.footer?.text === `verification:${row.id}`);
  if (matches.length) {
    const message = matches[0];
    for (const duplicate of matches.slice(1)) await api(env, `/channels/${c.review_channel_id}/messages/${duplicate.id}`, 'DELETE');
    await env.DB.prepare(`UPDATE requests SET status='pending',message_id=?,next_at=?,scan_before=NULL WHERE id=? AND status='receiving'`)
      .bind(message.id, Math.min(now() + 3600, row.expires), row.id).run();
    return;
  }
  const oldest = messages.reduce((a, m) => !a || BigInt(m.id) < BigInt(a.id) ? m : a, null);
  if (messages.length === 100 && Date.parse(oldest.timestamp) / 1000 > row.created - 60) {
    await env.DB.prepare('UPDATE requests SET scan_before=?,next_at=? WHERE id=?').bind(oldest.id, now() + 60, row.id).run();
  } else await finish(env, row.id, 'failed', 'receiving', 'Upload was interrupted before delivery. Please submit again.');
}
async function syncCard(env, c, row) {
  if (row.message_id && !row.cleaned) {
    try {
      await api(env, `/channels/${c.review_channel_id}/messages/${row.message_id}`, 'PATCH',
        { embeds: [card(row)], components: components(row), allowed_mentions: NONE });
    } catch (e) { if (e.status !== 404) throw e; }
  }
  await env.DB.prepare('UPDATE requests SET dirty=0 WHERE id=? AND status=?').bind(row.id, row.status).run();
}
async function clean(env, c, row) {
  if (row.message_id) {
    try { await api(env, `/channels/${c.review_channel_id}/messages/${row.message_id}`, 'DELETE'); }
    catch (e) { if (e.status !== 404) throw e; }
  }
  await env.DB.prepare('UPDATE requests SET cleaned=1,dirty=0 WHERE id=?').bind(row.id).run();
}
async function notify(env, c, row) {
  if (c.notify_dms === false) {
    await env.DB.prepare("UPDATE requests SET notified='disabled' WHERE id=?").bind(row.id).run();
    return;
  }
  let state = 'sent';
  try {
    const dm = await api(env, '/users/@me/channels', 'POST', { recipient_id: row.user_id });
    await api(env, `/channels/${dm.id}/messages`, 'POST', {
      content: `Verification request ${row.id} for role ${row.role_id}: **${row.status}**. Use /verification_status in your server for details.`,
      allowed_mentions: NONE,
    });
  } catch (e) { if (![403, 404].includes(e.status)) throw e; state = 'blocked'; }
  await env.DB.prepare('UPDATE requests SET notified=? WHERE id=?').bind(state, row.id).run();
}
export async function maintain(env, c) {
  const install = await installation(env, c), time = now(), owner = crypto.randomUUID();
  // One bounded job/minute keeps the free per-invocation CPU and subrequest budget small.
  const row = await env.DB.prepare(`UPDATE requests SET lease_until=?,lease_owner=? WHERE id=(
    SELECT id FROM requests WHERE next_at<=? AND lease_until<=? ORDER BY next_at LIMIT 1)
    AND lease_until<=? RETURNING *`).bind(time + 120, owner, time, time, time).first();
  if (!row) return;
  try {
    if (row.status === 'receiving') {
      await reconcileUpload(env, c, row, install.bot_id);
    } else if (row.status === 'pending') {
      if (time >= row.expires) await finish(env, row.id, 'expired', 'pending', 'The review deadline passed. You may submit again.');
      else {
        try {
          const message = await api(env, `/channels/${c.review_channel_id}/messages/${row.message_id}`);
          if (!message.attachments?.length) await finish(env, row.id, 'failed', 'pending', 'Evidence is missing. Please submit again.');
        } catch (e) {
          if (e.status !== 404) throw e;
          await finish(env, row.id, 'failed', 'pending', 'The review message was deleted. Please submit again.');
        }
        await env.DB.prepare(`UPDATE requests SET next_at=? WHERE id=? AND status='pending'`)
          .bind(Math.min(time + 3600, row.expires), row.id).run();
      }
    } else if (row.status === 'approving') {
      if (time >= row.expires && !row.cleaned) await clean(env, c, row);
      await applyApproval(env, c, row);
    }
    let latest = await getRow(env, row.id), retry = 0;
    if (latest.dirty && !latest.cleaned) {
      try { await syncCard(env, c, latest); }
      catch (e) { retry = Math.max(retry, e.retry || 60); logFailure('Card update delayed', row.id, e); }
    }
    if (TERMINAL.has(latest.status)) {
      // Deletion is independent of whether a DM succeeds.
      if (!latest.cleaned && time >= latest.decided + c.evidence_hours * 3600) {
        try { await clean(env, c, latest); }
        catch (e) { retry = Math.max(retry, e.retry || 60); logFailure('Evidence deletion delayed', row.id, e); }
      }
      if (latest.notified === 'waiting') {
        try { await notify(env, c, latest); }
        catch (e) { retry = Math.max(retry, e.retry || 60); logFailure('Notification delayed', row.id, e); }
      }
      latest = await getRow(env, row.id);
      const auditEnd = latest.decided + c.audit_days * 86400;
      if (latest.cleaned && time >= auditEnd) {
        await env.DB.prepare('DELETE FROM requests WHERE id=?').bind(row.id).run();
      } else {
        const due = latest.cleaned ? auditEnd : latest.decided + c.evidence_hours * 3600;
        await env.DB.prepare('UPDATE requests SET next_at=? WHERE id=?')
          .bind(retry ? time + retry : Math.max(time + 60, due), row.id).run();
      }
    }
  } catch (e) {
    await env.DB.prepare('UPDATE requests SET next_at=? WHERE id=?').bind(time + (e.retry || 60), row.id).run();
    logFailure('Maintenance delayed', row.id, e);
  } finally {
    await env.DB.prepare('UPDATE requests SET lease_until=0 WHERE id=? AND lease_owner=?').bind(row.id, owner).run();
  }
}
async function processInteraction(env, c, i) {
  let message;
  try {
    if (i.type === 5 && i.data.custom_id?.startsWith('rv:upload:')) {
      message = await submit(env, c, i, i.data.custom_id.split(':')[2]);
    } else if (i.type === 3 && /^rv:(approve|deny):\d{17,20}$/.test(i.data.custom_id || '')) {
      const [, action, id] = i.data.custom_id.split(':'); message = await review(env, c, i, action, id);
    } else if (i.type === 2 && ['verification_status', 'verification_cancel'].includes(i.data.name)) {
      await installation(env, c);
      const row = await env.DB.prepare('SELECT * FROM requests WHERE user_id=? ORDER BY created DESC LIMIT 1').bind(uid(i)).first();
      if (i.data.name === 'verification_cancel') {
        if (!row || row.status !== 'pending') throw new UserError('Only a pending request can be withdrawn. Upload recovery or an approval already in progress must finish first.');
        const result = await env.DB.prepare(`UPDATE requests SET status='cancelled',decided=?,dirty=1,next_at=? WHERE id=? AND status='pending'`)
          .bind(now(), now(), row.id).run();
        if (!changed(result)) throw new UserError('The request changed before cancellation completed. Check its status.');
        message = 'Request withdrawn. It can no longer be approved.';
      } else message = row ? `Request ${row.id} for role ${row.role_id}: **${row.status}**.${row.error ? '\n' + row.error : ''}${row.notified === 'blocked' ? '\nYour DM could not be delivered.' : ''}` : 'No retained request found.';
    } else throw new UserError('Unknown action. Run /verify to start again.');
  } catch (e) { message = safeError(e); logFailure('Interaction failed', i.id, e); }
  try { await original(env, i, message); } catch (e) { logFailure('Response unavailable', i.id, e); }
}

function decodeHex(text) {
  if (!/^(?:[0-9a-f]{2})+$/i.test(text || '')) return null;
  return Uint8Array.from(text.match(/../g), pair => parseInt(pair, 16));
}
let importedPublicKey;
export async function verifySignature(request, body, publicKey) {
  const signature = decodeHex(request.headers.get('X-Signature-Ed25519'));
  const timestamp = request.headers.get('X-Signature-Timestamp');
  const keyBytes = decodeHex(publicKey);
  if (signature?.length !== 64 || keyBytes?.length !== 32 || !/^\d+$/.test(timestamp || '') || Math.abs(now() - Number(timestamp)) > 300) return false;
  if (importedPublicKey?.hex !== publicKey) importedPublicKey = { hex: publicKey,
    key: crypto.subtle.importKey('raw', keyBytes, { name: 'Ed25519' }, false, ['verify']) };
  const prefix = new TextEncoder().encode(timestamp), bytes = new Uint8Array(prefix.length + body.length);
  bytes.set(prefix); bytes.set(body, prefix.length);
  return crypto.subtle.verify('Ed25519', await importedPublicKey.key, signature, bytes);
}
export async function register(env, c) {
  if (!env.DISCORD_TOKEN) throw new UserError('Configure DISCORD_TOKEN as a Worker secret.');
  await env.DB.batch(SCHEMA.split(';').map(s => s.trim()).filter(Boolean).map(sql => env.DB.prepare(sql)));
  const app = await api(env, '/oauth2/applications/@me');
  if (app.id !== c.application_id) throw new UserError('DISCORD_TOKEN belongs to a different application than APPLICATION_ID.');
  const bot = await api(env, '/users/@me');
  await env.DB.prepare(`INSERT OR IGNORE INTO installation VALUES (1,?,?,?,?)`)
    .bind(c.application_id, c.guild_id, c.review_channel_id, bot.id).run();
  await environment(env, c);
  const commands = [
    { name: 'verify', description: 'Choose a role and privately submit one image or video.', type: 1 },
    { name: 'verification_status', description: 'Privately check your latest verification request.', type: 1 },
    { name: 'verification_cancel', description: 'Withdraw your pending verification request.', type: 1 },
  ];
  await api(env, `/applications/${c.application_id}/guilds/${c.guild_id}/commands`, 'PUT', commands);
}
const SETUP_PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Discord verification setup</title><h1>Register the bot commands</h1>
<p>Enter the SETUP_KEY you saved in your Cloudflare Worker secrets. This initializes the database, checks permissions and registers this bot's three server commands.</p>
<form method="post"><label>Setup key <input name="key" type="password" required autocomplete="off"></label><button>Register commands</button></form>
<p>No bot token belongs in this form. This page is for the server owner.</p>`;
async function sameSecret(a, b) {
  if (!b || b.length < 32 || !a || a.length > 512) return false;
  const [left, right] = await Promise.all([a, b].map(s => crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))));
  const x = new Uint8Array(left), y = new Uint8Array(right); let diff = 0;
  for (let n = 0; n < x.length; n++) diff |= x[n] ^ y[n];
  return diff === 0;
}
export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    if (path === '/setup') {
      const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; form-action 'self'; frame-ancestors 'none'" };
      if (request.method === 'GET') return new Response(SETUP_PAGE, { headers });
      if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
      try {
        const body = new TextDecoder().decode(await readBounded(request.body, 4096));
        if (!await sameSecret(new URLSearchParams(body).get('key'), env.SETUP_KEY)) return new Response('Forbidden', { status: 403 });
        await register(env, config(env));
        return new Response('Setup complete. Save /interactions as the Interactions Endpoint URL in Discord, then run /verify in your server.');
      } catch (e) { logFailure('Setup failed', '', e); return new Response(safeError(e), { status: 400 }); }
    }
    if (path !== '/interactions' || request.method !== 'POST') return new Response('Discord role verifier. Setup: /setup', { status: path === '/' ? 200 : 404 });
    let body;
    try { body = await readBounded(request.body, 65536); }
    catch { return new Response('Request too large', { status: 413 }); }
    if (!await verifySignature(request, body, env.DISCORD_PUBLIC_KEY).catch(() => false)) return new Response('Invalid signature', { status: 401 });
    let i;
    try { i = JSON.parse(new TextDecoder().decode(body)); } catch { return new Response('Invalid JSON', { status: 400 }); }
    if (i.application_id !== env.APPLICATION_ID) return new Response('Wrong application', { status: 401 });
    if (i.type === 1) return json({ type: 1 });
    try {
      const c = config(env);
      if (i.guild_id !== c.guild_id || !uid(i) || i.member.user.bot) return privateReply('Use this bot as a member of the configured server.');
      if (i.type === 2 && i.data.name === 'verify') return json({ type: 4, data: {
        content: `Choose a role, then upload one image/video (max ${c.max_bytes / 1048576} MiB). Reviewers and administrators can see the evidence. Avoid identity documents and passwords. Requests expire after ${c.pending_hours} hours; review copies are deleted ${c.evidence_hours} hours after completion, plus maintenance delays.`,
        flags: 64, allowed_mentions: NONE,
        components: [{ type: 1, components: [{ type: 3, custom_id: 'rv:choose', placeholder: 'Choose a role', min_values: 1, max_values: 1,
          options: Object.entries(c.roles).map(([label, value]) => ({ label, value })) }] }],
      } });
      if (i.type === 3 && i.data.custom_id === 'rv:choose') {
        const role = i.data.values?.[0];
        if (i.data.values?.length !== 1 || !Object.values(c.roles).includes(role)) return privateReply('Choose a currently configured role.');
        return json({ type: 9, data: { title: 'Submit verification evidence', custom_id: `rv:upload:${role}`,
          components: [{ type: 18, label: 'One image or video', description: 'Private review by server reviewers and administrators.',
            component: { type: 19, custom_id: 'evidence', min_values: 1, max_values: 1, required: true } }] } });
      }
      ctx.waitUntil(processInteraction(env, c, i));
      return deferred();
    } catch (e) { return privateReply(safeError(e)); }
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(maintain(env, config(env)).catch(e => logFailure('Scheduled job unavailable', '', e)));
  },
};
