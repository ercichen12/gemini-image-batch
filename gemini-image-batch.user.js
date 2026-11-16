// ==UserScript==
// @name         Gemini 批量生图队列
// @name:en      Gemini Batch Image Queue
// @namespace    https://github.com/chenjunqiang/gemini-image-batch
// @version      1.0.0
// @description  一次性粘贴 N 条生图提示词，在 gemini.google.com/images 逐条自动提交并下载生成的图片
// @description:en Paste N image prompts at once, auto-submit them one by one on Gemini and download results
// @author       chenjunqiang
// @match        https://gemini.google.com/*
// @grant        GM_download
// @connect      googleusercontent.com
// @connect      lh3.googleusercontent.com
// @connect      *.googleusercontent.com
// @noframes
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const NS = '__GIB_LOADED__';
    if (window[NS]) return;
    window[NS] = true;

    const IMAGES_URL = 'https://gemini.google.com/images';
    const LS_KEY = 'gib_state_v1';

    const DEFAULTS = {
        raw: '',
        mode: 'blank',      // blank = 空行分隔, line = 每行一条
        cursor: 0,
        statuses: [],       // { state, files, reason }
        sentAt: {},         // index -> 时间戳，防止刷新后重复发送
        running: false,
        paused: false,
        delay: 3,           // 每条之间的额外缓冲秒数
        timeout: 180,       // 单条等待上限秒数
        newChat: true,      // 每条新开会话，避免风格互相污染
        autoDownload: true,
        collapsed: false,
        minimized: false
    };

    let S = load();

    /* ---------------------------------- 工具 ---------------------------------- */

    function load() {
        let out;
        try {
            const saved = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
            out = Object.assign({}, DEFAULTS, saved, { paused: false, running: !!saved.running });
        } catch (e) {
            out = Object.assign({}, DEFAULTS);
        }
        if (!out.sentAt || typeof out.sentAt !== 'object') out.sentAt = {};
        if (!Array.isArray(out.statuses)) out.statuses = [];
        out.queue = parseQueue(out.raw, out.mode);
        if (out.cursor > out.queue.length) out.cursor = 0;
        return out;
    }

    function save() {
        try {
            localStorage.setItem(LS_KEY, JSON.stringify(S));
        } catch (e) { /* 存储满或隐私模式，忽略 */ }
    }

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    function isVisible(el) {
        if (!el || !el.getBoundingClientRect) return false;
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) return false;
        const st = getComputedStyle(el);
        return st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0';
    }

    function firstVisible(selectors, root) {
        const scope = root || document;
        for (const sel of selectors) {
            let list;
            try { list = scope.querySelectorAll(sel); } catch (e) { continue; }
            for (const el of list) {
                if (isVisible(el)) return el;
            }
        }
        return null;
    }

    function slug(text) {
        return String(text || '')
            .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
            .replace(/\s+/g, '_')
            .replace(/^_+|_+$/g, '')
            .slice(0, 20) || 'prompt';
    }

    function parseQueue(raw, mode) {
        if (!raw || !raw.trim()) return [];
        const parts = mode === 'line'
            ? raw.split(/\r?\n/)
            : raw.split(/\r?\n\s*(?:\r?\n\s*)+/);
        return parts.map((s) => s.trim()).filter(Boolean);
    }

    /* -------------------------------- 选择器层 -------------------------------- */

    const SEL = {
        composer: [
            'rich-textarea div[contenteditable="true"]',
            'div[contenteditable="true"][role="textbox"]',
            '.ql-editor[contenteditable="true"]',
            'div[contenteditable="true"]'
        ],
        send: [
            'button[aria-label="Send message"]',
            'button[aria-label="发送消息"]',
            'button[aria-label="发送"]',
            'button[aria-label*="Send message"]',
            'button[aria-label*="发送"]',
            'button.send-button',
            'button[data-test-id="send-button"]',
            'button[aria-label*="Send"]'
        ],
        stop: [
            'button[aria-label*="Stop response"]',
            'button[aria-label*="Stop"]',
            'button[aria-label*="停止"]'
        ]
    };

    function findComposer() {
        const el = firstVisible(SEL.composer);
        if (!el) return null;
        // 排除掉面板自身或搜索框这类误命中
        if (el.closest('#gib-host')) return null;
        return el;
    }

    function findSendButton() {
        const btn = firstVisible(SEL.send);
        if (!btn || btn.disabled || btn.getAttribute('aria-disabled') === 'true') return null;
        return btn;
    }

    function findStopButton() {
        return firstVisible(SEL.stop);
    }

    function composerScope() {
        const box = findComposer();
        if (!box) return null;
        return box.closest('form, .input-area, rich-textarea')?.parentElement || box.parentElement;
    }

    /** 判断当前是否确实处在「生成图片」模式 */
    function imagesModeState() {
        const scope = composerScope() || document;
        let chip = null;
        for (const el of scope.querySelectorAll('button, [role="button"], [class*="chip"]')) {
            const t = (el.textContent || '').trim().toLowerCase();
            if (['images', 'image', '图片', '生成图片', '创建图片', '画像'].includes(t)) { chip = el; break; }
        }
        const box = findComposer();
        const hint = ((box && (box.getAttribute('aria-label') || box.getAttribute('data-placeholder'))) || '').toLowerCase();
        const placeholder = (document.querySelector('[data-placeholder]')?.getAttribute('data-placeholder') || '').toLowerCase();
        const textHint = /describe your image|描述你的图片|描述图片/.test(hint + ' ' + placeholder);
        return { chip: !!chip, textHint, onImagesPath: /\/images/.test(location.pathname) };
    }

    /** 尝试主动选中 Images 工具（兜底路径，正常在 /images 页不需要） */
    async function activateImagesTool() {
        const scope = composerScope() || document.body;
        const plus = firstVisible(
            ['button[aria-label*="Add"]', 'button[aria-label*="添加"]', 'button[aria-label*="Upload"]',
                'button[aria-label*="Tools"]', 'button[aria-label*="工具"]', 'button[aria-label*="加"]'],
            scope
        ) || [...scope.querySelectorAll('button')].find((b) => /^\s*\+?\s*$/.test(b.textContent || ''));
        if (!plus) return false;
        plus.click();
        await sleep(600);
        const items = [...document.querySelectorAll('[role="menuitem"], [role="option"], li, button')];
        const target = items.find((el) => {
            if (!isVisible(el)) return false;
            const t = (el.textContent || '').trim().toLowerCase();
            return t.length < 24 && /image|图片|画像/.test(t);
        });
        if (!target) {
            document.body.click();
            return false;
        }
        target.click();
        await sleep(700);
        return imagesModeState().chip;
    }

    /* -------------------------------- 输入与发送 ------------------------------- */

    function clearComposer(el) {
        el.focus();
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand('delete', false, null);
    }

    function fillComposer(el, text) {
        try {
            clearComposer(el);
            const clean = String(text).replace(/\r/g, '');
            document.execCommand('insertText', false, clean);
            const got = (el.innerText || '').replace(/\s+/g, '');
            const want = clean.replace(/\s+/g, '').slice(0, 16);
            if (got.includes(want.slice(0, 8))) return true;
        } catch (e) { /* 落到下面的兜底 */ }

        try {
            el.focus();
            el.innerHTML = String(text).split(/\r?\n/).map((line) =>
                '<p>' + (line ? line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') : '<br>') + '</p>'
            ).join('');
            el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return (el.innerText || '').trim().length > 0;
        } catch (e) {
            return false;
        }
    }

    async function waitSent(ms) {
        const t0 = Date.now();
        while (Date.now() - t0 < ms) {
            if (findStopButton()) return true;
            const box = findComposer();
            if (box && (box.innerText || '').trim() === '') return true;
            if (/\/app\//.test(location.pathname)) return true;
            await sleep(300);
        }
        return false;
    }

    async function sendMessage() {
        const btn = findSendButton();
        if (btn) {
            btn.click();
            if (await waitSent(5000)) return true;
        }
        const box = findComposer();
        if (box) {
            box.focus();
            for (const type of ['keydown', 'keypress', 'keyup']) {
                box.dispatchEvent(new KeyboardEvent(type, {
                    key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true
                }));
            }
            return await waitSent(8000);
        }
        return false;
    }

    /* -------------------------------- 出图检测 -------------------------------- */

    function collectImages() {
        const out = [];
        const seen = new Set();
        for (const img of document.querySelectorAll('img')) {
            const src = img.currentSrc || img.src || '';
            if (!src) continue;
            if (!/^blob:|googleusercontent\.com|gstatic\.com\/image/.test(src)) continue;
            if (/^data:/.test(src) && src.length < 5000) continue;
            if (img.naturalWidth < 256 || img.naturalHeight < 256) continue;
            if (img.closest('nav, header, [role="navigation"], side-navigation, .side-nav, #gib-host')) continue;
            if (!isVisible(img)) continue;
            if (seen.has(src)) continue;
            seen.add(src);
            out.push({ src, w: img.naturalWidth, h: img.naturalHeight, el: img });
        }
        return out;
    }

    function pageTextSample() {
        const nodes = document.querySelectorAll('model-response, message-content, .model-response-text, .response-container');
        let text = '';
        nodes.forEach((n) => { text += ' ' + (n.innerText || ''); });
        if (!text.trim()) text = (document.body.innerText || '').slice(-3000);
        return text;
    }

    async function waitImages() {
        const start = Date.now();
        const deadline = start + S.timeout * 1000;
        let lastSig = '';
        let stable = 0;
        let sawStop = false;
        let peak = 0;

        while (Date.now() < deadline) {
            if (!S.running || S.paused) return { error: '已暂停' };

            const imgs = collectImages();
            const stop = !!findStopButton();
            if (stop) sawStop = true;
            peak = Math.max(peak, imgs.length);

            const sig = imgs.length + '|' + (stop ? 1 : 0);
            if (sig === lastSig) stable++; else { stable = 0; lastSig = sig; }

            // 出图成功：生成已停止、有图、且连续两次轮询稳定
            if (!stop && imgs.length > 0 && stable >= 2) return { images: imgs };

            // 判定失败：必须等到「生成确实结束」才下结论，避免刚发出去就误判
            const ended = stop === false && (sawStop || Date.now() - start > 25000);
            if (ended && imgs.length === 0 && stable >= 3) {
                const t = pageTextSample();
                if (/(limit|quota|too many|try again|上限|额度|配额|次数已用|稍后再试)/i.test(t)) {
                    return { error: '配额或限流' };
                }
                if (t.trim().length > 40) return { error: '仅返回文字，未出图' };
                return { error: '未检测到图片' };
            }

            await sleep(1200);
        }
        if (peak > 0) return { error: '超时（已检测到图片但未稳定）' };
        return { error: '等待超时' };
    }

    /* -------------------------------- 图片下载 -------------------------------- */

    function mimeToExt(type) {
        const m = String(type || '').toLowerCase();
        if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
        if (m.includes('webp')) return 'webp';
        if (m.includes('gif')) return 'gif';
        return 'png';
    }

    function triggerDownload(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 15000);
    }

    async function saveOneImage(src, baseName) {
        // 1) 取 blob 自己命名保存（blob: 链接最稳）
        try {
            const res = await fetch(src, { credentials: 'include' });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const blob = await res.blob();
            if (blob.size < 1024) throw new Error('响应过小');
            const name = baseName + '.' + mimeToExt(blob.type);
            triggerDownload(blob, name);
            return name;
        } catch (e1) {
            // 2) 交给 Tampermonkey 扩展下载（可绕开跨域）
            if (typeof GM_download === 'function') {
                const name = baseName + '.png';
                await new Promise((resolve, reject) => {
                    try {
                        GM_download({ url: src, name, saveAs: false, onload: resolve, onerror: reject });
                    } catch (err) { reject(err); }
                });
                return name;
            }
            // 3) 最后兜底：新窗口打开，用户自己另存
            window.open(src, '_blank');
            throw new Error('跨域受限，已在新标签打开原图');
        }
    }

    async function downloadAll(images, idx, prompt) {
        const base = String(idx + 1).padStart(3, '0') + '_' + slug(prompt);
        let ok = 0;
        for (let i = 0; i < images.length; i++) {
            const suffix = images.length > 1 ? '_' + (i + 1) : '';
            try {
                const name = await saveOneImage(images[i].src, base + suffix);
                ok++;
                log(`⬇ 已保存 ${name}`);
                await sleep(400);
            } catch (e) {
                log(`✗ 第 ${i + 1} 张保存失败：${e.message || e}`);
            }
        }
        return ok;
    }

    /* ---------------------------------- 主流程 -------------------------------- */

    let busy = false;

    async function tick() {
        if (busy) return;
        if (!S.running || S.paused) return;

        if (S.cursor >= S.queue.length) {
            S.running = false;
            save(); render();
            log('✅ 队列全部完成');
            return;
        }

        busy = true;
        const idx = S.cursor;
        const prompt = S.queue[idx];
        const total = S.queue.length;

        try {
            // 每条新会话：确保停在生图页
            if (S.newChat && !/\/images/.test(location.pathname)) {
                log('↻ 返回生图页，开启干净会话 …');
                location.href = IMAGES_URL;
                return;
            }

            // 刷新后重入：这条已经发过了，只等结果，避免重复提交
            const sentAgo = S.sentAt[idx] ? Date.now() - S.sentAt[idx] : Infinity;
            const resuming = sentAgo < 10 * 60 * 1000 && /\/app\//.test(location.pathname);

            if (!resuming) {
                log(`▶ 第 ${idx + 1}/${total} 条：${prompt.slice(0, 30)}…`);
                S.statuses[idx] = { state: 'running', files: 0, reason: '' };
                save(); render();

                const box = await waitForComposer(25000);
                if (!box) return fail(idx, '找不到输入框');

                const mode = imagesModeState();
                if (!mode.chip && !mode.textHint) {
                    log('⚠️ 未见 Images 标签，尝试主动选中 …');
                    const ok = await activateImagesTool();
                    if (!ok) log('⚠️ 仍无法确认生图模式，继续尝试提交');
                    else log('✓ 已切到生图模式');
                }

                if (!fillComposer(box, prompt)) {
                    await sleep(400);
                    if (!fillComposer(box, prompt)) return fail(idx, '写入提示词失败');
                }
                await sleep(500 + Math.random() * 400);

                if (!(await sendMessage())) return fail(idx, '点击发送无效');

                S.sentAt[idx] = Date.now();
                save();
                log('  已发送，等待出图 …');
            } else {
                log(`↻ 检测到第 ${idx + 1} 条已提交，继续等待出图 …`);
            }

            const result = await waitImages();
            if (result.error) {
                const quota = /配额|限流/.test(result.error);
                return fail(idx, result.error, quota);
            }

            log(`  出图 ${result.images.length} 张`);
            let files = 0;
            if (S.autoDownload) {
                files = await downloadAll(result.images, idx, prompt);
            }

            S.statuses[idx] = { state: files > 0 || !S.autoDownload ? 'ok' : 'fail', files, reason: '' };
            S.cursor = idx + 1;
            S.sentAt[idx] = 0;
            save(); render();
            log(`✓ 第 ${idx + 1} 条完成`);

            if (S.cursor < total && S.running && !S.paused) {
                log(`  缓冲 ${S.delay}s 后继续 …`);
                await sleep(S.delay * 1000);
                if (S.newChat) {
                    location.href = IMAGES_URL;
                } else {
                    await tick();
                }
            } else if (S.cursor >= total) {
                S.running = false;
                save(); render();
                log('✅ 队列全部完成');
            }
        } catch (e) {
            log('✗ 异常：' + (e && e.message ? e.message : e));
            fail(idx, '脚本异常');
        } finally {
            busy = false;
        }
    }

    function fail(idx, reason, pause) {
        S.statuses[idx] = { state: 'fail', files: 0, reason };
        S.cursor = idx + 1;
        S.sentAt[idx] = 0;
        if (pause) {
            S.paused = true;
            log(`⏸ 第 ${idx + 1} 条失败（${reason}），已暂停整队`);
        } else {
            log(`✗ 第 ${idx + 1} 条失败：${reason}，跳到下一条`);
        }
        save(); render();
        if (S.running && !S.paused && S.cursor < S.queue.length) {
            setTimeout(() => {
                if (S.newChat) location.href = IMAGES_URL;
                else { busy = false; tick(); }
            }, Math.max(1500, S.delay * 1000));
        }
    }

    async function waitForComposer(ms) {
        const t0 = Date.now();
        while (Date.now() - t0 < ms) {
            const box = findComposer();
            if (box) return box;
            await sleep(400);
        }
        return null;
    }

    /* ---------------------------------- 面板 UI ------------------------------- */

    let root = null;
    let ui = {};

    const PANEL_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
    .panel {
      position: fixed; right: 18px; bottom: 18px; width: 340px;
      background: #1b1b1f; color: #e9e9ec; border: 1px solid #35353d;
      border-radius: 12px; box-shadow: 0 8px 28px rgba(0,0,0,.45);
      font-size: 12.5px; line-height: 1.5; z-index: 2147483000; overflow: hidden;
    }
    .panel.min { width: auto; }
    .head {
      display: flex; align-items: center; gap: 8px; padding: 9px 11px;
      background: #232329; cursor: move; user-select: none; border-bottom: 1px solid #35353d;
    }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #6b6b76; flex: none; }
    .dot.run { background: #4c8dff; box-shadow: 0 0 0 3px rgba(76,141,255,.18); }
    .dot.pause { background: #e0a03c; }
    .dot.done { background: #3fbf7f; }
    .title { font-weight: 600; font-size: 12.5px; flex: 1; white-space: nowrap; }
    .ico {
      width: 20px; height: 20px; border: 0; border-radius: 5px; background: transparent;
      color: #9a9aa6; cursor: pointer; font-size: 13px; line-height: 1; padding: 0;
    }
    .ico:hover { background: #35353d; color: #fff; }
    .body { padding: 10px 11px 11px; }
    textarea {
      width: 100%; height: 128px; resize: vertical; padding: 8px 9px;
      background: #131316; color: #e9e9ec; border: 1px solid #35353d; border-radius: 8px;
      font-family: ui-monospace, Consolas, monospace; font-size: 12px; line-height: 1.5; outline: none;
    }
    textarea:focus { border-color: #4c8dff; }
    .row { display: flex; align-items: center; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
    .seg { display: flex; border: 1px solid #35353d; border-radius: 7px; overflow: hidden; }
    .seg button {
      border: 0; background: #131316; color: #9a9aa6; padding: 4px 9px; font-size: 11.5px; cursor: pointer;
    }
    .seg button.on { background: #2f4d80; color: #fff; }
    .count { margin-left: auto; color: #9a9aa6; font-size: 11.5px; }
    .count b { color: #e9e9ec; }
    .btn {
      flex: 1; border: 1px solid #35353d; background: #26262d; color: #e9e9ec;
      padding: 7px 0; border-radius: 7px; font-size: 12px; cursor: pointer; font-weight: 500;
    }
    .btn:hover { background: #30303a; }
    .btn.primary { background: #4c8dff; border-color: #4c8dff; color: #fff; }
    .btn.primary:hover { background: #3d7ce8; }
    .btn.danger { color: #ff9a9a; }
    .btn:disabled { opacity: .45; cursor: not-allowed; }
    .bar { height: 4px; background: #2a2a31; border-radius: 3px; margin-top: 9px; overflow: hidden; }
    .bar i { display: block; height: 100%; width: 0%; background: #4c8dff; transition: width .3s; }
    .status { margin-top: 6px; color: #9a9aa6; font-size: 11.5px; min-height: 16px; }
    .log {
      margin-top: 7px; height: 96px; overflow-y: auto; padding: 7px 8px;
      background: #131316; border: 1px solid #2a2a31; border-radius: 7px;
      font-family: ui-monospace, Consolas, monospace; font-size: 11px; line-height: 1.55; color: #b9b9c3;
    }
    .log div { white-space: pre-wrap; word-break: break-all; }
    .log .ok { color: #6fe0a8; }
    .log .err { color: #ff9a9a; }
    .log .warn { color: #f0c070; }
    details { margin-top: 8px; border-top: 1px dashed #35353d; padding-top: 7px; }
    summary { cursor: pointer; color: #9a9aa6; font-size: 11.5px; outline: none; }
    .cfg { display: grid; grid-template-columns: 1fr 62px; gap: 6px 8px; margin-top: 8px; align-items: center; }
    .cfg label { color: #b9b9c3; font-size: 11.5px; }
    .cfg input[type=number] {
      width: 100%; background: #131316; color: #e9e9ec; border: 1px solid #35353d;
      border-radius: 5px; padding: 3px 6px; font-size: 11.5px; outline: none;
    }
    .cfg .chk { grid-column: 1 / -1; display: flex; align-items: center; gap: 6px; color: #b9b9c3; }
    .pill {
      position: fixed; right: 18px; bottom: 18px; z-index: 2147483000;
      background: #1b1b1f; color: #e9e9ec; border: 1px solid #35353d; border-radius: 20px;
      padding: 7px 13px; font-size: 12px; cursor: pointer; box-shadow: 0 6px 20px rgba(0,0,0,.4);
      display: none; align-items: center; gap: 7px;
    }
    .pill.show { display: flex; }
    `;

    const PANEL_HTML = `
    <div class="panel" id="panel">
      <div class="head" id="head">
        <span class="dot" id="dot"></span>
        <span class="title">Gemini 批量生图</span>
        <button class="ico" id="btnMin" title="收起">—</button>
        <button class="ico" id="btnHide" title="隐藏（刷新页面后恢复）">×</button>
      </div>
      <div class="body">
        <textarea id="ta" placeholder="粘贴生图提示词&#10;&#10;默认按空行分隔，一条提示词可以写多段。&#10;例：&#10;一只橘猫坐在窗台，晨光，胶片质感&#10;&#10;赛博朋克城市夜景，霓虹，广角"></textarea>
        <div class="row">
          <div class="seg">
            <button data-mode="blank">空行分隔</button><button data-mode="line">每行一条</button>
          </div>
          <span class="count">共 <b id="cnt">0</b> 条</span>
        </div>
        <div class="row">
          <button class="btn primary" id="btnStart">开始</button>
          <button class="btn" id="btnSkip">跳过当前</button>
          <button class="btn danger" id="btnReset">清空</button>
        </div>
        <div class="bar"><i id="bar"></i></div>
        <div class="status" id="status">待命</div>
        <div class="log" id="log"></div>
        <details>
          <summary>设置与自检</summary>
          <div class="cfg">
            <label>每条额外缓冲（秒）</label><input type="number" id="cfgDelay" min="0" max="120" step="1">
            <label>单条超时（秒）</label><input type="number" id="cfgTimeout" min="30" max="900" step="10">
            <label class="chk"><input type="checkbox" id="cfgNewChat"> 每条新开会话（推荐，避免风格串味）</label>
            <label class="chk"><input type="checkbox" id="cfgAutoDl"> 自动下载生成的图片</label>
          </div>
          <div class="row">
            <button class="btn" id="btnProbe">自检当前页面</button>
          </div>
        </details>
      </div>
    </div>
    <div class="pill" id="pill"><span class="dot" id="dot2"></span><span id="pillText">0/0</span></div>
    `;

    function buildPanel() {
        const host = document.createElement('div');
        host.id = 'gib-host';
        document.documentElement.appendChild(host);
        root = host.attachShadow({ mode: 'open' });
        root.innerHTML = '<style>' + PANEL_CSS + '</style>' + PANEL_HTML;

        const $ = (id) => root.getElementById(id);
        ui = {
            panel: $('panel'), pill: $('pill'), dot: $('dot'), dot2: $('dot2'),
            ta: $('ta'), cnt: $('cnt'), bar: $('bar'), status: $('status'), log: $('log'),
            btnStart: $('btnStart'), btnSkip: $('btnSkip'), btnReset: $('btnReset'),
            pillText: $('pillText'), head: $('head'), btnMin: $('btnMin'), btnHide: $('btnHide'),
            cfgDelay: $('cfgDelay'), cfgTimeout: $('cfgTimeout'),
            cfgNewChat: $('cfgNewChat'), cfgAutoDl: $('cfgAutoDl'), btnProbe: $('btnProbe')
        };

        ui.ta.value = S.raw;
        ui.cfgDelay.value = S.delay;
        ui.cfgTimeout.value = S.timeout;
        ui.cfgNewChat.checked = S.newChat;
        ui.cfgAutoDl.checked = S.autoDownload;

        // 输入与切分
        ui.ta.addEventListener('input', () => {
            S.raw = ui.ta.value;
            S.queue = parseQueue(S.raw, S.mode);
            if (S.cursor > S.queue.length) S.cursor = 0;
            save(); render();
        });
        root.querySelectorAll('.seg button').forEach((b) => {
            b.addEventListener('click', () => {
                S.mode = b.dataset.mode;
                S.queue = parseQueue(S.raw, S.mode);
                S.cursor = 0;
                save(); render();
            });
        });

        // 主按钮
        ui.btnStart.addEventListener('click', onStart);
        ui.btnSkip.addEventListener('click', () => {
            if (!S.queue.length) return;
            log(`↷ 跳过第 ${S.cursor + 1} 条`);
            S.statuses[S.cursor] = { state: 'skip', files: 0, reason: '手动跳过' };
            S.cursor++;
            save(); render();
            if (S.running) {
                if (S.newChat) location.href = IMAGES_URL;
                else { busy = false; tick(); }
            }
        });
        ui.btnReset.addEventListener('click', () => {
            if (!confirm('清空队列与所有进度？')) return;
            S = Object.assign({}, DEFAULTS, { raw: '', cursor: 0, statuses: [], sentAt: {}, queue: [] });
            ui.ta.value = '';
            save(); render();
            log('已清空');
        });

        // 设置
        ui.cfgDelay.addEventListener('change', () => { S.delay = Math.max(0, Number(ui.cfgDelay.value) || 0); save(); });
        ui.cfgTimeout.addEventListener('change', () => { S.timeout = Math.max(30, Number(ui.cfgTimeout.value) || 180); save(); });
        ui.cfgNewChat.addEventListener('change', () => { S.newChat = ui.cfgNewChat.checked; save(); });
        ui.cfgAutoDl.addEventListener('change', () => { S.autoDownload = ui.cfgAutoDl.checked; save(); });
        ui.btnProbe.addEventListener('click', probe);

        // 收起 / 隐藏 / 拖动
        ui.btnMin.addEventListener('click', () => { S.minimized = true; save(); render(); });
        ui.pill.addEventListener('click', () => { S.minimized = false; save(); render(); });
        ui.btnHide.addEventListener('click', () => {
            host.style.display = 'none';
            log('面板已隐藏，刷新页面可恢复');
        });
        makeDraggable(ui.panel, ui.head);

        render();
    }

    function makeDraggable(panel, handle) {
        let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
        handle.addEventListener('mousedown', (e) => {
            if (e.target.closest('button')) return;
            dragging = true;
            const r = panel.getBoundingClientRect();
            sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
            panel.style.right = 'auto'; panel.style.bottom = 'auto';
            panel.style.left = ox + 'px'; panel.style.top = oy + 'px';
            e.preventDefault();
        });
        window.addEventListener('mousemove', (e) => {
            if (!dragging) return;
            const nx = Math.max(4, ox + e.clientX - sx);
            const ny = Math.max(4, oy + e.clientY - sy);
            panel.style.left = nx + 'px';
            panel.style.top = ny + 'px';
        });
        window.addEventListener('mouseup', () => { dragging = false; });
    }

    function log(msg, cls) {
        if (!ui.log) return;
        const t = new Date().toTimeString().slice(0, 8);
        const div = document.createElement('div');
        if (cls) div.className = cls;
        else if (/^✓|^✅|已保存/.test(msg)) div.className = 'ok';
        else if (/^✗|失败|异常/.test(msg)) div.className = 'err';
        else if (/⚠️|⏸/.test(msg)) div.className = 'warn';
        div.textContent = `[${t}] ${msg}`;
        ui.log.appendChild(div);
        ui.log.scrollTop = ui.log.scrollHeight;
        while (ui.log.childElementCount > 200) ui.log.firstElementChild.remove();
    }

    function render() {
        if (!ui.panel) return;
        const total = S.queue.length;
        const done = S.cursor;

        ui.panel.classList.toggle('min', S.minimized);
        ui.panel.style.display = S.minimized ? 'none' : '';
        ui.pill.classList.toggle('show', !!S.minimized);

        ui.cnt.textContent = total;
        const pct = total ? Math.round((done / total) * 100) : 0;
        ui.bar.style.width = pct + '%';
        ui.pillText.textContent = `${done}/${total}`;

        let state = 'idle';
        if (S.running && S.paused) state = 'pause';
        else if (S.running) state = 'run';
        else if (total && done >= total) state = 'done';
        ui.dot.className = 'dot ' + (state === 'idle' ? '' : state);
        if (ui.dot2) ui.dot2.className = ui.dot.className;

        ui.status.textContent =
            state === 'run' ? `运行中 · 第 ${Math.min(done + 1, total)}/${total} 条` :
                state === 'pause' ? `已暂停 · 进度 ${done}/${total}` :
                    state === 'done' ? `已完成 ${done}/${total}` :
                        total ? `待开始 · 共 ${total} 条` : '待命 · 先粘贴提示词';

        ui.btnStart.textContent = S.running ? (S.paused ? '继续' : '暂停') : (done > 0 && done < total ? '继续' : '开始');
        ui.btnStart.classList.toggle('primary', !S.running || S.paused);
        root.querySelectorAll('.seg button').forEach((b) => b.classList.toggle('on', b.dataset.mode === S.mode));
    }

    async function onStart() {
        if (S.running && !S.paused) {
            S.paused = true;
            save(); render();
            log('⏸ 已暂停（当前这条不会重发）');
            return;
        }
        if (!S.queue.length) {
            S.queue = parseQueue(ui.ta.value, S.mode);
            S.raw = ui.ta.value;
        }
        if (!S.queue.length) {
            log('⚠️ 队列为空，先粘贴提示词', 'warn');
            return;
        }
        if (S.cursor >= S.queue.length) {
            log('队列已跑完，若要重跑请点「清空」后重新粘贴', 'warn');
            return;
        }

        S.running = true;
        S.paused = false;
        save(); render();
        log(`▶ 启动，共 ${S.queue.length} 条`);

        if (!/\/images/.test(location.pathname)) {
            log('↻ 跳转到生图页 …');
            await sleep(600);
            location.href = IMAGES_URL;
            return;
        }
        tick();
    }

    /* --------------------------------- 自检信息 ------------------------------- */

    function probe() {
        const box = findComposer();
        const send = findSendButton();
        const stop = findStopButton();
        const mode = imagesModeState();
        const imgs = collectImages();
        log('—— 自检 ——');
        log('URL: ' + location.pathname);
        log('输入框: ' + (box ? (box.tagName.toLowerCase() + '.' + (box.className || '').toString().split(' ')[0]) : '未找到'));
        log('发送键: ' + (send ? (send.getAttribute('aria-label') || send.className || send.tagName) : '未找到'));
        log('停止键: ' + (stop ? '存在' : '不存在'));
        log('Images 标签: ' + (mode.chip ? '已选中' : '未检测到') + ' / 占位提示: ' + (mode.textHint ? '像生图页' : '不像'));
        log('当前识别到图片: ' + imgs.length + ' 张');
        const ed = box && box.getAttribute('aria-label');
        if (ed) log('输入框 aria-label: ' + ed);
    }

    /* --------------------------------- 启动引导 ------------------------------- */

    function boot() {
        buildPanel();
        S.queue = parseQueue(S.raw, S.mode);
        if (S.cursor > S.queue.length) S.cursor = 0;
        render();
        if (S.running && !S.paused && S.cursor < S.queue.length) {
            log('检测到未完成任务，自动继续 …');
            setTimeout(() => tick(), 1500);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 800));
    } else {
        setTimeout(boot, 800);
    }
})();
