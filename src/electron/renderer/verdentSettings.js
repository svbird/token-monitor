'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const api = window.tokenMonitor;
  let pending = false;
  function render(state) {
    $('verdentEnabled').checked = Boolean(state.enabled);
    $('verdentEnabled').disabled = pending || Boolean(state.busy);
    $('verdentSettingsSummary').textContent = state.busy ? '正在采集' : state.enabled ? '已启用' : '已关闭';
    const last = [...(state.history || [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    const seconds = Math.round((state.intervalMinutes || 0) * 60);
    const cadence = seconds ? (seconds % 60 ? `每 ${seconds} 秒` : `每 ${seconds / 60} 分钟`) : '启动与手动刷新';
    $('verdentCollectionStatus').textContent = `${cadence} · ${last ? `最后成功：${new Date(last.updatedAt).toLocaleString(undefined, { hour12: false })}` : '请在管理页配置账号并登录'}`;
    $('verdentSettingsError').textContent = state.error?.message || '';
  }
  $('verdentEnabled').onchange = async () => {
    pending = true; $('verdentEnabled').disabled = true;
    try {
      const state = await api.verdentCommand('configure', { enabled: $('verdentEnabled').checked });
      pending = false; render(state);
    } catch (_) { pending = false; $('verdentEnabled').disabled = false; $('verdentSettingsError').textContent = '设置保存失败，请重试。'; }
  };
  api.onVerdentState(render);
  api.verdentCommand('get').then(render).catch(() => { $('verdentSettingsError').textContent = 'Verdent 状态读取失败。'; });
})();
