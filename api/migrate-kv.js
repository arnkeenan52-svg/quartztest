// api/migrate-kv.js — ONE-TIME data migration: copy everything important from
// the OLD Upstash store (read via @vercel/kv, which still works through the old
// KV_REST_API_* env vars) into the NEW Redis Cloud database (written via
// ./_kv.js → LOCKER_REDIS_REDIS_URL).
//
// HOW TO RUN (once, after deploying the new code):
//   https://www.quartzmolle.dk/api/migrate-kv?code=YOUR_LOCKER_CODE
// You'll get a JSON summary of what was copied. Then DELETE this file and
// redeploy so it can't be triggered again (it's also passcode-protected and
// self-disables once done).
//
// SAFE: by default it SKIPS any key that already exists in the new DB, so it can
// never overwrite fresh locker/heartbeat data written after the switch. Add
// &force=1 only if you deliberately want to overwrite.

import { kv as newkv } from './_kv.js';

export default async function handler(req, res) {
  const q = req.query || {};
  const LOCKER_CODE = process.env.LOCKER_CODE || '';
  if (!LOCKER_CODE || (q.code || '') !== LOCKER_CODE) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const force = String(q.force || '') === '1';

  // Self-disable once completed (unless forced), so a forgotten endpoint is inert.
  try {
    if (!force && (await newkv.get('migrate:done'))) {
      return res.status(200).json({ ok: true, alreadyDone: true, note: 'Migration already completed. Delete api/migrate-kv.js and redeploy.' });
    }
  } catch (e) { /* new DB unreachable — surfaced below */ }

  let oldkv;
  try { ({ kv: oldkv } = await import('@vercel/kv')); }
  catch (e) { return res.status(500).json({ error: 'Could not load @vercel/kv (old store)', detail: String(e && e.message || e) }); }

  const report = { copied: {}, skipped: [], errors: {} };
  const existsNew = async (key) => { try { return !!(await newkv.exists(key)); } catch { return false; } };

  // ---- strings / json ----
  for (const key of ['locker:state', 'locker:device']) {
    try {
      if (!force && await existsNew(key)) { report.skipped.push(key + ' (already in new)'); continue; }
      const v = await oldkv.get(key);
      if (v == null) { report.skipped.push(key + ' (empty in old)'); continue; }
      await newkv.set(key, v);
      report.copied[key] = 'value';
    } catch (e) { report.errors[key] = String(e && e.message || e); }
  }

  // ---- lists (preserve order: read head→tail, rebuild with rpush) ----
  for (const key of ['locker:history', 'locker:cmds', 'pickup:orders']) {
    try {
      if (!force && await existsNew(key)) { report.skipped.push(key + ' (already in new)'); continue; }
      const items = (await oldkv.lrange(key, 0, -1)) || [];
      if (!items.length) { report.skipped.push(key + ' (empty in old)'); continue; }
      await newkv.del(key);
      for (const it of items) await newkv.rpush(key, it);
      report.copied[key] = items.length + ' items';
    } catch (e) { report.errors[key] = String(e && e.message || e); }
  }

  // ---- hash ----
  for (const key of ['pickup:fulfilled']) {
    try {
      if (!force && await existsNew(key)) { report.skipped.push(key + ' (already in new)'); continue; }
      const obj = (await oldkv.hgetall(key)) || {};
      if (!Object.keys(obj).length) { report.skipped.push(key + ' (empty in old)'); continue; }
      await newkv.hset(key, obj);
      report.copied[key] = Object.keys(obj).length + ' fields';
    } catch (e) { report.errors[key] = String(e && e.message || e); }
  }

  // ---- OPTIONAL: visitor-stats sets (best-effort, never fails the migration) ----
  try {
    const visitKeys = (await oldkv.keys('visitors:*')) || [];
    let days = 0;
    for (const key of visitKeys) {
      try {
        if (!force && await existsNew(key)) continue;
        const members = (await oldkv.smembers(key)) || [];
        if (!members.length) continue;
        await newkv.sadd(key, ...members);
        const ttl = await oldkv.ttl(key);
        if (ttl && ttl > 0) await newkv.expire(key, ttl);
        days++;
      } catch { /* skip this day */ }
    }
    if (days) report.copied['visitors:* (stats)'] = days + ' days';
  } catch (e) { report.errors['visitors:*'] = String(e && e.message || e); }

  try { await newkv.set('migrate:done', { at: Date.now() }); } catch {}

  report.ok = true;
  report.note = 'Done. Now DELETE api/migrate-kv.js from the repo and redeploy.';
  return res.status(200).json(report);
}
