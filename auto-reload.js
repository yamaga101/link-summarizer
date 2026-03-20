// Auto-reload: detect version change from git pull and reload extension
const AUTO_RELOAD_ALARM = 'linksumm_auto_reload_check';

async function checkVersionAndReload() {
    try {
        const loadedVersion = chrome.runtime.getManifest().version;
        const resp = await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' });
        if (!resp.ok) return;
        const manifest = await resp.json();
        const diskVersion = manifest.version;
        console.log(`[LinkSumm AutoReload] Loaded: ${loadedVersion} / Disk: ${diskVersion}`);
        if (diskVersion !== loadedVersion) {
            console.log('[LinkSumm AutoReload] Version mismatch → reloading...');
            chrome.runtime.reload();
        }
    } catch (e) {
        console.warn('[LinkSumm AutoReload] Check failed:', e.message);
    }
}

async function ensureAutoReloadAlarm() {
    if (!await chrome.alarms.get(AUTO_RELOAD_ALARM)) {
        chrome.alarms.create(AUTO_RELOAD_ALARM, { periodInMinutes: 1 });
        console.log('[LinkSumm AutoReload] Alarm registered (1 min interval)');
    }
}

ensureAutoReloadAlarm().catch(e => console.error('[LinkSumm AutoReload] ensureAlarm failed:', e));

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === AUTO_RELOAD_ALARM) {
        checkVersionAndReload();
    }
});
