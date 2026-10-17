'use strict';

(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorVerdentPresentation = api;
})(typeof window === 'undefined' ? null : window, function createPresentation() {
  const day = value => {
    const date = new Date(Number(value));
    return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  };
  const addDays = (value, count) => new Date(Date.parse(`${value}T00:00:00Z`) + count * 86400000).toISOString().slice(0, 10);
  function bounds(period, now = Date.now()) {
    const end = day(now);
    const weekday = new Date(`${end}T00:00:00Z`).getUTCDay();
    const start = period === 'today' ? end : period === 'month' ? `${end.slice(0, 7)}-01`
      : period === 'last7' ? addDays(end, -6) : period === 'last30' ? addDays(end, -29)
        : period === 'week' ? addDays(end, -(weekday + 6) % 7) : '';
    return { start, end };
  }
  const addMap = (left, right) => {
    const result = { ...left };
    for (const [key, value] of Object.entries(right || {})) Object.defineProperty(result, key, { value: Number(Object.hasOwn(result, key) ? result[key] : 0) + value, enumerable: true, writable: true, configurable: true });
    return result;
  };
  function projectPeriod(base = {}, usage, period, now = Date.now(), range) {
    if (!usage || base.verdent) return base;
    const { start, end } = range || bounds(period, now);
    const days = usage.daily.filter(item => (!start || item.date >= start) && item.date <= end);
    if (!days.length) return base;
    const sum = { tokens: 0, credits: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const models = Object.create(null); const modelCredits = Object.create(null); const reads = Object.create(null); const writes = Object.create(null); const outputs = Object.create(null);
    for (const item of days) {
      for (const key of Object.keys(sum)) sum[key] += item[key];
      for (const [model, value] of Object.entries(item.models)) {
        models[model] = (models[model] || 0) + value.tokens; modelCredits[model] = (modelCredits[model] || 0) + value.credits;
        reads[model] = (reads[model] || 0) + value.cacheRead; writes[model] = (writes[model] || 0) + value.cacheWrite; outputs[model] = (outputs[model] || 0) + value.output;
      }
    }
    const coverage = { start: days[0].date, end: days.at(-1).date, days: days.length };
    return { ...base, totalTokens: Number(base.totalTokens || 0) + sum.tokens,
      cacheReadTokens: Number(base.cacheReadTokens || 0) + sum.cacheRead, cacheWriteTokens: Number(base.cacheWriteTokens || 0) + sum.cacheWrite,
      outputTokens: Number(base.outputTokens || 0) + sum.output,
      clients: addMap(base.clients, { verdent: sum.tokens }), clientCredits: { ...base.clientCredits, verdent: sum.credits },
      clientCacheReads: addMap(base.clientCacheReads, { verdent: sum.cacheRead }), clientCacheWrites: addMap(base.clientCacheWrites, { verdent: sum.cacheWrite }), clientOutputs: addMap(base.clientOutputs, { verdent: sum.output }),
      models: addMap(base.models, models), modelCredits: addMap(base.modelCredits, modelCredits),
      modelCacheReads: addMap(base.modelCacheReads, reads), modelCacheWrites: addMap(base.modelCacheWrites, writes), modelOutputs: addMap(base.modelOutputs, outputs),
      clientModels: { ...base.clientModels, verdent: models },
      verdent: { ...sum, coverage, account: usage.account, updatedAt: usage.updatedAt } };
  }
  function projectFixedSnapshot(snapshot, usage, selection, now = Date.now()) {
    if (snapshot.status !== 'ready' || !usage || snapshot.period?.verdent) return snapshot;
    const period = projectPeriod(snapshot.period, usage, selection, now, snapshot.range);
    if (!period.verdent) return snapshot;
    // Preserve native duration; only the known daily token counts affect the peak.
    const tokensByDay = new Map((snapshot.daily || []).map(row => [row.date, Number(row.tokens || 0)]));
    for (const row of usage.daily) if (row.date >= snapshot.range.start && row.date <= snapshot.range.end) tokensByDay.set(row.date, (tokensByDay.get(row.date) || 0) + row.tokens);
    return { ...snapshot, period, summary: { ...snapshot.summary,
      activeDays: [...tokensByDay.values()].filter(value => value > 0).length,
      peakDayTokens: Math.max(0, ...tokensByDay.values()) } };
  }
  function creditsLabel(value) { return `${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 8 }).format(value)} Credits`; }
  return { bounds, projectPeriod, projectFixedSnapshot, creditsLabel };
});
