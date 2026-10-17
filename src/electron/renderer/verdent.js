'use strict';
(() => {
  const $ = id => document.getElementById(id);
  let state;
  let pending = false;
  const number = value => new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 8 }).format(value);
  const time = value => new Date(value).toLocaleString(undefined, { hour12: false });
  const fields = ['total_input_tokens', 'total_output_tokens', 'total_cache_read_tokens', 'total_cache_creation_tokens', 'total_tokens', 'total_credits'];
  const titles = ['输入 Token', '输出 Token', '缓存读取 Token', '缓存创建 Token', '总 Token', 'Credits'];
  function cell(row, value) { const td = document.createElement('td'); td.textContent = value; row.append(td); return td; }
  function renderGroups() {
    $('groups').replaceChildren();
    for (const group of state?.selected?.groups?.[$('dimension').value] || []) {
      const row = document.createElement('tr');
      cell(row, $('dimension').value === 'first_create_time' ? `${time(Number(group.name) * 1000)} · ${group.name}` : group.name || '（空值）');
      fields.forEach(field => cell(row, number(group[field]))); cell(row, number(group.items)); $('groups').append(row);
    }
  }
  function render(next, controls = false) {
    state = next;
    if (controls || !document.activeElement?.matches('input,select')) {
      $('enabled').checked = Boolean(next.enabled); $('interval').value = String(Math.round((next.intervalMinutes || 0) * 60));
      $('profile').replaceChildren(...(next.profiles || []).map(p => { const o = new Option(p.label, p.id); o.selected = p.id === next.activeProfile; return o; }));
    }
    $('error').hidden = !next.error; $('error').textContent = next.error?.message || '';
    $('loginStatus').textContent = next.loginStatus?.message || '';
    $('cancel').hidden = !next.busy;
    for (const id of ['enabled', 'profile', 'profileLabel', 'addProfile', 'login', 'completeLogin', 'clearSession', 'interval', 'save', 'refresh', 'refreshFull', 'validate']) $(id).disabled = Boolean(next.busy);
    $('status').textContent = next.busy ? (next.progress ? `第 ${next.progress.attempt} 次尝试 · 读取 ${next.progress.pass}/2 · 分页 ${next.progress.page}/${next.progress.pages} · total ${next.progress.total}${next.progress.reusedRecords ? ` · 复用 ${next.progress.reusedRecords} 条历史` : ''}` : '正在核对账号并读取…')
      : `${next.enabled ? '已启用' : '已关闭'} · ${next.identityVerified ? '本次运行已核对账号身份' : '尚未核对当前登录身份'}${next.selected ? ` · 最后成功更新：${time(next.selected.updatedAt)}` : ''}${next.nextRefreshAt ? ` · 下次采集：${time(next.nextRefreshAt)}` : ''}`;
    $('coverage').textContent = next.coverage ? `主页累计覆盖 ${next.coverage.start} — ${next.coverage.end}，共 ${next.coverage.days} 个已采集日期（中间可能有缺口）；重叠时间范围采用最新完整快照。${next.coverage.partialDays ? ` ${next.coverage.partialDays} 个日期仅覆盖部分时段。` : ''}` : '主页尚无可汇总历史。';
    if (next.excludedSnapshots) $('coverage').textContent += ` ${next.excludedSnapshots} 份快照含范围外时间，保留原数据但暂不计入主页。`;
    const snapshot = next.selected;
    $('usage').hidden = !snapshot; $('cards').replaceChildren();
    if (snapshot) {
      $('snapshotInfo').textContent = `${time(snapshot.scope.start_time * 1000)} — ${time(snapshot.scope.end_time * 1000)} · ${number(snapshot.total)} 条记录 · 账号 ${snapshot.account}`;
      const comparison = snapshot.comparison;
      $('comparison').textContent = `内容指纹 ${snapshot.fingerprint.slice(0, 16)} · ` + (!comparison ? '此范围首次成功采集。'
        : comparison.unchanged ? `与 ${time(comparison.previousUpdatedAt)} 的结果相同（包括重复记录数量）。`
        : `与 ${time(comparison.previousUpdatedAt)} 相比，新增 ${comparison.addedOccurrences} 条字段组合、消失 ${comparison.removedOccurrences} 条字段组合；不能据此判定调用数或聚合更新方式。`);
      [4, 5, 0, 1, 2, 3].forEach(i => {
        const card = document.createElement('div'); card.className = 'card';
        const label = document.createElement('span'); label.textContent = titles[i];
        const value = document.createElement('strong'); value.textContent = number(snapshot.totals[fields[i]]); card.append(label, value); $('cards').append(card);
      });
    }
    renderGroups(); $('history').replaceChildren();
    for (const history of [...(next.history || [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
      const row = document.createElement('tr'); const td = cell(row, ''); const select = document.createElement('button');
      select.textContent = `${history.startDate} — ${history.endDate}${history.kind === 'archive' ? ' · 本地归档' : ''}`; select.disabled = Boolean(next.busy);
      select.onclick = () => command('selectHistory', { key: history.key, startDate: history.startDate, endDate: history.endDate }); td.append(select);
      cell(row, history.account); cell(row, number(history.totals.total_tokens)); cell(row, number(history.totals.total_credits)); cell(row, number(history.total)); cell(row, time(history.updatedAt)); $('history').append(row);
    }
    $('empty').hidden = Boolean(next.history?.length);
    $('anomalyPanel').hidden = !next.anomalies?.length; $('anomalies').textContent = JSON.stringify(next.anomalies || [], null, 2);
    $('validation').textContent = next.validation ? JSON.stringify(next.validation, null, 2) : '尚未验证';
  }
  async function command(name, input) {
    if (pending && name !== 'cancel') return;
    pending = true;
    try { render(await window.verdent.command(name, input), true); }
    catch (_) { $('error').hidden = false; $('error').textContent = '操作未完成，请重试。'; }
    finally { pending = false; }
  }
  $('enabled').onchange = () => command('configure', { enabled: $('enabled').checked });
  $('profile').onchange = () => command('configure', { activeProfile: $('profile').value });
  $('addProfile').onclick = () => command('addProfile', $('profileLabel').value);
  $('login').onclick = () => command('login'); $('clearSession').onclick = () => command('clearSession');
  $('completeLogin').onclick = () => command('completeLogin');
  const saveInterval = () => command('configure', { intervalMinutes: Number($('interval').value) / 60 });
  $('save').onclick = () => { if ($('interval').reportValidity()) return saveInterval(); };
  $('refresh').onclick = async () => { if (!$('interval').reportValidity()) return; await saveInterval(); if (!state.error) await command('refresh'); };
  $('refreshFull').onclick = async () => { if (!$('interval').reportValidity()) return; await saveInterval(); if (!state.error) await command('refreshFull'); };
  $('validate').onclick = () => command('validateWeek');
  $('cancel').onclick = () => command('cancel'); $('dimension').onchange = renderGroups;
  window.verdent.onState(next => render(next)); command('get');
})();
