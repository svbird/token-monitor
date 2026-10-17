'use strict';

const { readRegularFileNoFollow, writePrivateJsonAtomic } = require('../../../shared/credentialStore');
const { scopeForDates, historyScope, scopeKey, firstCreateDay, parseItem, summarize, fingerprint, compareSnapshots, VerdentError } = require('./usage');

// Keep the existing persisted/IPC minutes unit for compatibility. UI uses whole
// seconds; tolerate only floating point rounding from seconds / 60.
function validRefreshMinutes(value) {
  const seconds = value * 60;
  return typeof value === 'number' && Number.isFinite(seconds) && seconds >= 0 && seconds <= 3600
    && Math.abs(seconds - Math.round(seconds)) < 1e-9 && (seconds === 0 || seconds >= 1);
}

function archiveOutside(previous, scope) {
  if (!previous) return [];
  // Preserve local records that aged out of the server window (or a clock
  // rollback excluded). Never treat these as newly queried or deduplicate rows.
  const ranges = [[previous.scope.start_time, Math.min(previous.scope.end_time, scope.start_time - 1)],
    [Math.max(previous.scope.start_time, scope.end_time + 1), previous.scope.end_time]];
  return ranges.flatMap(([start_time, end_time]) => {
    if (start_time > end_time) return [];
    const items = previous.items.filter(row => row.first_create_time >= start_time && row.first_create_time <= end_time);
    if (!items.length) return [];
    return [{ ...previous, scope: { ...previous.scope, kind: 'archive', start_time, end_time,
      startDate: firstCreateDay(start_time), endDate: firstCreateDay(end_time) },
    items, total: items.length, totals: summarize(items), fingerprint: fingerprint(items), comparison: null }];
  });
}

// Contains usage and preferences only. Chromium owns credentials in Partitions/.
class VerdentStore {
  constructor(file, { read = readRegularFileNoFollow, write = writePrivateJsonAtomic } = {}) {
    this.file = file;
    this.write = write;
    this.data = { version: 1, enabled: false, intervalMinutes: 0.5, rangeMode: 'allHistory', activeProfile: '', profiles: [], snapshots: [], range: null };
    try {
      const data = JSON.parse(read(file, { maxBytes: 100 * 1024 * 1024 }));
      if (data.version !== 1 || !Array.isArray(data.profiles) || !Array.isArray(data.snapshots)
        || !validRefreshMinutes(data.intervalMinutes) || typeof data.enabled !== 'boolean'
        || data.profiles.some(p => !/^[a-f0-9-]{36}$/.test(p.id) || typeof p.label !== 'string' || p.label.length > 80)
        || (data.activeProfile && !data.profiles.some(p => p.id === data.activeProfile))) throw new Error('Invalid store');
      if (data.range?.kind === 'allHistory') historyScope(data.range.end_time * 1000);
      else if (data.range) scopeForDates(data.range.startDate, data.range.endDate);
      if (data.rangeMode != null && !['fixed', 'today', 'last7', 'month', 'allHistory'].includes(data.rangeMode)) throw new Error('Invalid range mode');
      // Migrate the collection policy, never discard the saved usage or cadence.
      data.rangeMode = 'allHistory';
      for (const snapshot of data.snapshots) {
        if (!data.profiles.some(p => p.id === snapshot.profileId) || !/^[a-f0-9]{64}$/.test(snapshot.accountKey) || !Array.isArray(snapshot.items)) throw new Error('Invalid snapshot');
        const scope = snapshot.scope;
        scopeForDates(scope.startDate, scope.endDate);
        // Saved epochs describe what was actually queried. Never reinterpret
        // their date labels in a different system timezone on restart.
        if (scope.team_id !== '0' || scope.consume_type !== '' || !Number.isSafeInteger(scope.start_time)
          || !Number.isSafeInteger(scope.end_time) || scope.end_time < scope.start_time
          || scope.end_time - scope.start_time > 367 * 86400) throw new Error('Invalid stored scope');
        snapshot.items = snapshot.items.map(parseItem);
        snapshot.totals = summarize(snapshot.items);
        snapshot.fingerprint = fingerprint(snapshot.items);
        if (snapshot.total !== snapshot.items.length || !Number.isFinite(Date.parse(snapshot.updatedAt))) throw new Error('Invalid snapshot');
      }
      this.data = data;
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Verdent 本地存储无法读取；请备份并检查 verdent-usage.json，程序不会覆盖原文件。', { cause: error });
    }
  }
  commit(candidate) {
    // Publish only after durable atomic replacement. Failed writes preserve memory.
    try { this.write(this.file, candidate); }
    catch (error) { throw new VerdentError('storage', 'Verdent 统计写入失败，原成功统计已保留；请检查磁盘空间及文件权限。', undefined, { cause: error }); }
    this.data = candidate;
  }
  update(patch) { this.commit({ ...this.data, ...patch }); }
  replace(profileId, snapshot) {
    const previous = this.data.snapshots.find(old => old.profileId === profileId && old.accountKey === snapshot.accountKey && scopeKey(old.scope) === scopeKey(snapshot.scope));
    const snapshots = this.data.snapshots.filter(old => !(old.profileId === profileId && old.accountKey === snapshot.accountKey && scopeKey(old.scope) === scopeKey(snapshot.scope)));
    snapshots.push(...archiveOutside(previous, snapshot.scope));
    // Overlapping ranges coexist for selection, and are NEVER added together.
    snapshots.push({ ...snapshot, profileId, comparison: compareSnapshots(previous, snapshot) });
    this.update({ snapshots });
  }
}

module.exports = { VerdentStore, validRefreshMinutes };
