'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { projectHistory, historyForDisplay, statsForDisplay } = require('../../src/electron/providers/verdent/history');
const { projectPeriod, projectFixedSnapshot, bounds } = require('../../src/electron/providers/verdent/presentation');
const { scopeForDates } = require('../../src/electron/providers/verdent/usage');
const { normalizeHistory } = require('../../src/shared/history');
const { projectModelAliasStats } = require('../../src/electron/modelAliasPresentation');
const NOW = Date.parse('2026-10-16T12:00:00');
const item = (date, tokens = 10, credits = 0, model = 'new-model') => ({ first_create_time: Date.parse(`${date}T10:00:00`) / 1000, total_tokens: tokens, total_credits: credits, total_input_tokens: tokens - 3, total_output_tokens: 1, total_cache_read_tokens: 2, total_cache_creation_tokens: 0, model_name: model });
const snapshot = (start, end, items, updatedAt = '2026-10-16T01:00:00Z', profileId = 'p', accountKey = 'a'.repeat(64)) => ({ profileId, accountKey, scope: scopeForDates(start, end), items, updatedAt });
const usageOf = rows => projectHistory(rows, 'p');

test('overlap replaces dates from newer complete ranges and retains identical same-second items', () => {
  const duplicate = item('2026-10-15');
  const old = snapshot('2026-10-14', '2026-10-16', [item('2026-10-14', 20), duplicate, duplicate, item('2026-10-16', 30)]);
  const newer = snapshot('2026-10-15', '2026-10-16', [duplicate, duplicate, item('2026-10-16', 40)], '2026-10-16T02:00:00Z');
  const usage = usageOf([newer, old]);
  assert.deepEqual(usage.daily.map(d => d.tokens), [20, 20, 40]);
  assert.equal(projectPeriod({}, usage, 'allTime', NOW).totalTokens, 80);
  assert.equal(usage.coverage.days, 3);
  assert.equal(projectPeriod({}, usageOf([old, newer, newer]), 'allTime', NOW).totalTokens, 80);
});

test('new empty complete snapshot clears its covered dates while preserving older nonoverlap', () => {
  const usage = usageOf([snapshot('2026-10-14', '2026-10-16', [item('2026-10-14'), item('2026-10-16')]), snapshot('2026-10-16', '2026-10-16', [], '2026-10-16T02:00:00Z')]);
  assert.deepEqual(usage.daily.map(d => d.tokens), [10, 0, 0]);
  assert.equal(projectPeriod({}, usage, 'today', NOW).verdent.credits, 0);
});

test('history isolates profiles and real account identities; range-outside timestamps do not erase good dates', () => {
  const good = snapshot('2026-10-16', '2026-10-16', [item('2026-10-16')]);
  const wrongAccount = { ...good, accountKey: 'b'.repeat(64), updatedAt: '2026-10-16T03:00:00Z', items: [item('2026-10-16', 100)] };
  const wrongProfile = { ...good, profileId: 'other', items: [item('2026-10-16', 200)] };
  const badTime = { ...good, updatedAt: '2026-10-16T02:00:00Z', items: [item('2026-10-15')] };
  const usage = projectHistory([good, wrongAccount, wrongProfile, badTime], 'p', good.accountKey);
  assert.equal(usage.daily[0].tokens, 10); assert.equal(usage.excludedSnapshots, 1);
  assert.equal(usageOf([good, wrongAccount]).daily[0].tokens, 100);
  assert.equal(projectHistory([good], 'missing'), null);
});

test('system-local attribution selects today, month and rolling periods without inventing uncollected dates', () => {
  const usage = usageOf(['2026-09-30', '2026-10-01', '2026-10-10', '2026-10-16'].map(date => snapshot(date, date, [item(date)])));
  for (const [period, expected] of [['today', 10], ['month', 30], ['last7', 20], ['allTime', 40]]) assert.equal(projectPeriod({}, usage, period, NOW).totalTokens, expected);
  assert.deepEqual(bounds('today', Date.parse('2026-10-16T00:00:00')), { start: '2026-10-16', end: '2026-10-16' });
  assert.equal(usage.coverage.days, 4);
});

test('local presentation adds tokens and zero Credits once, keeps money, device wires and unavailable metrics unchanged', () => {
  const usage = usageOf([snapshot('2026-10-16', '2026-10-16', [item('2026-10-16')])]);
  const period = { totalTokens: 100, costUsd: 2, clients: { codex: 100 }, models: { 'new-model': 100 }, messages: 3, sessions: { one: { totalTokens: 100 } }, projects: {} };
  const base = { periods: { today: period, month: period, allTime: period }, devices: [{ periods: { today: period } }] };
  const before = JSON.stringify(base);
  const display = statsForDisplay(base, usage, NOW);
  assert.equal(display.periods.today.totalTokens, 110); assert.equal(display.periods.today.costUsd, 2);
  assert.equal(display.periods.today.verdent.credits, 0); assert.equal(display.periods.today.modelCredits['new-model'], 0);
  assert.equal(display.periods.today.models['new-model'], 110); assert.equal(display.periods.today.messages, 3);
  assert.equal(display.periods.today.sessions, period.sessions); assert.equal(display.periods.today.projects, period.projects);
  assert.equal(display.devices, base.devices); assert.equal(JSON.stringify(base), before);
  assert.equal(statsForDisplay(display, usage, NOW), display); assert.equal(projectPeriod(display.periods.today, usage, 'today', NOW), display.periods.today);
});

test('dashboard history merges components and activity by day, preserves messages/time/currency and includes Credits', () => {
  const base = normalizeHistory({ contributions: [{ date: '2026-10-16', tokens: 100, cost: 2, messages: 3, activeTimeMs: 600, perClient: { codex: { tokens: 100, cost: 2, messages: 3 } }, perModel: { x: { tokens: 100, cost: 2 } } }] }, { todayKey: '2026-10-16' });
  const usage = usageOf([snapshot('2026-10-15', '2026-10-16', [item('2026-10-15', 10, 0.25), item('2026-10-16', 20)])]);
  const projected = historyForDisplay(base, usage, NOW);
  assert.equal(projected.summary.totalTokens, 130); assert.equal(projected.summary.totalCost, 2);
  assert.equal(projected.summary.messages, 3); assert.equal(projected.summary.activeTimeMs, 600);
  assert.equal(projected.summary.activeDays, 2); assert.equal(projected.summary.verdentCredits, 0.25);
  assert.equal(projected.daily.at(-1).perClient.verdent.cacheReadTokens, 2);
  assert.equal(projected.daily.at(-1).verdentCredits, 0); assert.equal(projected.monthly[0].verdentCredits, 0.25);
  assert.equal(base.summary.totalTokens, 100); assert.equal(historyForDisplay(projected, usage, NOW), projected);
});

test('compact previews retain full lifetime summaries; model aliases also fold Credits and derived-range models', () => {
  const usage = usageOf([snapshot('2026-10-16', '2026-10-16', [item('2026-10-16', 10, 2, 'vendor/x'), item('2026-10-16', 20, 3, 'x')])]);
  const base = { periods: { today: { totalTokens: 0 } }, historyPreview: { daily: [], monthly: [], summary: { totalTokens: 1000, totalCost: 5, messages: 20, activeTimeMs: 100 } } };
  const shown = statsForDisplay(base, usage, NOW);
  assert.equal(shown.historyPreview.summary.totalTokens, 1030); assert.equal(shown.historyPreview.summary.messages, 20);
  const aliased = projectModelAliasStats(shown, { 'vendor/x': 'x' }, { grouping: 'off' });
  assert.deepEqual(aliased.periods.today.models, { x: 30 }); assert.deepEqual(aliased.periods.today.modelCredits, { x: 5 });
  assert.equal(projectPeriod({}, aliased.verdentUsage, 'last7', NOW).modelCredits.x, 5);
});

test('derived range uses native locale boundaries and includes Verdent in daily peak, without duration estimates', () => {
  const usage = usageOf([snapshot('2026-10-11', '2026-10-16', [item('2026-10-11', 50), item('2026-10-16', 20)])]);
  const native = { status: 'ready', range: { start: '2026-10-11', end: '2026-10-16' }, daily: [{ date: '2026-10-16', tokens: 40 }], period: { totalTokens: 40 }, summary: { peakDayTokens: 40, activeTimeMs: 600 } };
  const result = projectFixedSnapshot(native, usage, 'week', NOW);
  assert.equal(result.period.totalTokens, 110); assert.equal(result.summary.peakDayTokens, 60);
  assert.equal(result.summary.activeDays, 2); assert.equal(result.summary.activeTimeMs, 600);
  assert.equal(native.period.totalTokens, 40); assert.equal(projectFixedSnapshot(result, usage, 'week', NOW), result);
});
