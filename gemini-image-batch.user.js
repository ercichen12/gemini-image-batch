// ==UserScript==
// @name         Gemini 批量生图队列
// @name:en      Gemini Batch Image Queue
// @namespace    https://github.com/ercichen12/gemini-image-batch
// @version      1.0.5
// @description  一次性粘贴 N 条生图提示词，在 gemini.google.com/images 逐条自动提交并下载生成的图片
// @description:en Paste N image prompts at once, auto-submit them one by one on Gemini and download results
// @author       ercichen12
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
    const VER = '1.0.5';
    try { console.info('[GIB] 批量生图脚本已注入 v' + VER); } catch (e) { }

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
            // 同样不能用 innerHTML（Trusted Types），改为逐个节点构建
            el.focus();
            el.textContent = '';
            String(text).split(/\r?\n/).forEach((line) => {
                const p = document.createElement('p');
                if (line) p.textContent = line;
                else p.appendChild(document.createElement('br'));
                el.appendChild(p);
            });
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

    // 发送前页面上已存在的图片（模板缩略图、上几轮的结果），一律不算本轮产出
    let baseline = new Set();

    function snapshotBaseline() {
        baseline = new Set();
        for (const img of document.querySelectorAll('img')) {
            const src = img.currentSrc || img.src || '';
            if (src) baseline.add(src);
        }
    }

    function collectImages() {
        const out = [];
        const seen = new Set();
        for (const img of document.querySelectorAll('img')) {
            const src = img.currentSrc || img.src || '';
            if (!src) continue;
            if (baseline.has(src)) continue;
            if (!/^blob:|googleusercontent\.com|gstatic\.com\/image/.test(src)) continue;
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

    /** 页面上的预览图带 =s1024-rw 这类尺寸参数，改成 =s0 通常就是原图 */
    function toFullSizeUrl(src) {
        if (!src) return src;
        if (/=s\d+(-rw|-no)?$/.test(src)) return src.replace(/=s\d+(-rw|-no)?$/, '=s0');
        if (/=w\d+-h\d+(-rw|-no)?$/.test(src)) return src.replace(/=w\d+-h\d+(-rw|-no)?$/, '=s0');
        return src;
    }

    async function fetchBlob(url) {
        const res = await fetch(url, { credentials: 'include' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const blob = await res.blob();
        if (blob.size < 2048) throw new Error('响应过小');
        return blob;
    }

    const GOOD_TYPES = /^image\/(png|jpeg|jpg)$/i;

    /** 明确不要 webp，实在只有 webp 就转成 png */
    async function toPng(blob) {
        try {
            const bmp = await createImageBitmap(blob);
            const cv = document.createElement('canvas');
            cv.width = bmp.width;
            cv.height = bmp.height;
            cv.getContext('2d').drawImage(bmp, 0, 0);
            const png = await new Promise((r) => cv.toBlob(r, 'image/png'));
            if (png && png.size > 2048) return png;
        } catch (e) { }
        return blob;
    }

    /** 找到只包含这一张图的最近容器，避免拿错另一张图的下载按钮 */
    function imageScope(img) {
        let node = img.parentElement;
        let best = node;
        for (let i = 0; i < 6 && node; i++) {
            const bigs = Array.from(node.querySelectorAll('img')).filter((x) => x.naturalWidth >= 256);
            best = node;
            if (bigs.length <= 1) break;
            node = node.parentElement;
        }
        return best || img.parentElement;
    }

    function findDownloadControl(scope) {
        const labels = ['download full size', 'download fullsize', 'download original',
            'download image', '下载原图', '下载完整尺寸', '下载图片', '保存原图'];
        const find = (root) => {
            if (!root) return null;
            for (const el of root.querySelectorAll('button, a, [role="button"]')) {
                const txt = ((el.getAttribute('aria-label') || '') + ' ' +
                    (el.getAttribute('title') || '') + ' ' +
                    (el.textContent || '')).toLowerCase();
                if (labels.some((t) => txt.includes(t))) return el;
            }
            return null;
        };
        return find(scope) || find(document.body);
    }

    async function revealToolbar(scope) {
        const types = ['pointerenter', 'pointerover', 'mouseenter', 'mouseover', 'mousemove'];
        const targets = [scope].concat(Array.from(scope.querySelectorAll('img')).slice(0, 2));
        targets.forEach((n) => {
            types.forEach((t) => {
                try { n.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window })); } catch (e) { }
            });
        });
        await sleep(500);
    }

    /** 保存单张：优先原图，绝不落 webp */
    async function saveOneImage(img, baseName) {
        if (!img || !img.src) throw new Error('图片元素无效');
        const src = img.src;
        const scope = imageScope(img);
        let fallback = null;

        // 1) 直接把预览地址换成原图地址
        const full = toFullSizeUrl(src);
        if (full !== src) {
            try {
                const blob = await fetchBlob(full);
                if (GOOD_TYPES.test(blob.type)) {
                    const name = baseName + '.' + mimeToExt(blob.type);
                    triggerDownload(blob, name);
                    return { name, from: '原图' };
                }
                fallback = blob; // 还是 webp，先留着备用
            } catch (e) { }
        }

        // 2) 用页面自带的「Download full size」，让 Google 给原始文件
        await revealToolbar(scope);
        const ctrl = findDownloadControl(scope);
        if (ctrl) {
            const href = ctrl.tagName === 'A' ? ctrl.href : null;
            if (href) {
                try {
                    const blob = await fetchBlob(href);
                    const out = GOOD_TYPES.test(blob.type) ? blob : await toPng(blob);
                    const name = baseName + '.' + mimeToExt(out.type);
                    triggerDownload(out, name);
                    return { name, from: '原图' };
                } catch (e) { }
            }
            ctrl.click();
            return { name: '（已由页面下载原图，文件名由 Google 生成）', from: '按钮' };
        }

        // 3) 兜底：webp 转 png
        if (fallback) {
            const png = await toPng(fallback);
            const name = baseName + '.png';
            triggerDownload(png, name);
            return { name, from: 'webp转png' };
        }

        // 4) 最后才用预览图本身
        try {
            const blob = await fetchBlob(src);
            const out = GOOD_TYPES.test(blob.type) ? blob : await toPng(blob);
            const name = baseName + '.' + mimeToExt(out.type);
            triggerDownload(out, name);
            return { name, from: '预览图' };
        } catch (e) {
            if (typeof GM_download === 'function') {
                const name = baseName + '.png';
                await new Promise((res, rej) => {
                    try { GM_download({ url: full, name, saveAs: false, onload: res, onerror: rej }); }
                    catch (err) { rej(err); }
                });
                return { name, from: 'GM_download' };
            }
            throw new Error('取图失败');
        }
    }

    async function downloadAll(images, idx, prompt) {
        const base = String(idx + 1).padStart(3, '0') + '_' + slug(prompt);
        let ok = 0;
        for (let i = 0; i < images.length; i++) {
            const suffix = images.length > 1 ? '_' + (i + 1) : '';
            try {
                const r = await saveOneImage(images[i].el, base + suffix);
                ok++;
                log(`⬇ 已保存 ${r.name}（${r.from}）`);
                await sleep(r.from === '按钮' ? 900 : 400);
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

            snapshotBaseline();

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
                if (!mode.chip && !mode.textHint && !mode.onImagesPath) {
                    log('⚠️ 未见 Images 标签，尝试主动选中 …');
                    const ok = await activateImagesTool();
                    if (!ok) log('⚠️ 仍无法确认生图模式，继续尝试提交');
                    else log('✓ 已切到生图模式');
                }

                snapshotBaseline();
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
                baseline = new Set();
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

    /* ------------------------- 面板 DOM（纯节点构建） -------------------------
     * 不用任何 HTML 字符串：Gemini 有 Trusted Types，innerHTML / DOMParser+importNode
     * 在沙箱里都靠不住，只有 createElement + textContent 是彻底干净的路径。
     */

    function h(tag, attrs) {
        const el = document.createElement(tag);
        if (attrs) {
            Object.keys(attrs).forEach((k) => {
                const v = attrs[k];
                if (v === null || v === undefined || v === false) return;
                if (k === 'text') el.textContent = String(v);
                else if (k === 'class') el.className = v;
                else if (k === 'style') el.style.cssText = v;
                else if (v === true) el.setAttribute(k, '');
                else el.setAttribute(k, String(v));
            });
        }
        for (let i = 2; i < arguments.length; i++) {
            const kid = arguments[i];
            if (kid === null || kid === undefined || kid === false) continue;
            if (Array.isArray(kid)) {
                kid.forEach((k2) => { if (k2) el.appendChild(k2); });
            } else if (typeof kid === 'string') {
                el.appendChild(document.createTextNode(kid));
            } else {
                el.appendChild(kid);
            }
        }
        return el;
    }

    function buildPanelNodes() {
        const dot = h('span', { class: 'dot', id: 'dot' });

        const head = h('div', { class: 'head', id: 'head' },
            dot,
            h('span', { class: 'title', text: 'Gemini 批量生图' }),
            h('button', { class: 'ico', id: 'btnMin', title: '收起', text: '—' }),
            h('button', { class: 'ico', id: 'btnHide', title: '隐藏（刷新页面后恢复）', text: '×' })
        );

        const ta = h('textarea', {
            id: 'ta',
            placeholder: '粘贴生图提示词\n\n默认按空行分隔，一条提示词可以写多段。\n例：\n一只橘猫坐在窗台，晨光，胶片质感\n\n赛博朋克城市夜景，霓虹，广角'
        });

        const seg = h('div', { class: 'seg' },
            h('button', { 'data-mode': 'blank', text: '空行分隔' }),
            h('button', { 'data-mode': 'line', text: '每行一条' })
        );

        const row1 = h('div', { class: 'row' },
            seg,
            h('span', { class: 'count' }, '共 ', h('b', { id: 'cnt', text: '0' }), ' 条')
        );

        const row2 = h('div', { class: 'row' },
            h('button', { class: 'btn primary', id: 'btnStart', text: '开始' }),
            h('button', { class: 'btn', id: 'btnSkip', text: '跳过当前' }),
            h('button', { class: 'btn danger', id: 'btnReset', text: '清空' })
        );

        const bar = h('div', { class: 'bar' }, h('i', { id: 'bar' }));

        const cfg = h('div', { class: 'cfg' },
            h('label', { text: '每条额外缓冲（秒）' }),
            h('input', { type: 'number', id: 'cfgDelay', min: '0', max: '120', step: '1' }),
            h('label', { text: '单条超时（秒）' }),
            h('input', { type: 'number', id: 'cfgTimeout', min: '30', max: '900', step: '10' }),
            h('label', { class: 'chk' }, h('input', { type: 'checkbox', id: 'cfgNewChat' }), ' 每条新开会话（推荐，避免风格串味）'),
            h('label', { class: 'chk' }, h('input', { type: 'checkbox', id: 'cfgAutoDl' }), ' 自动下载生成的图片')
        );

        const details = h('details', null,
            h('summary', { text: '设置与自检' }),
            cfg,
            h('div', { class: 'row' }, h('button', { class: 'btn', id: 'btnProbe', text: '自检当前页面' }))
        );

        const body = h('div', { class: 'body' },
            ta,
            row1,
            row2,
            bar,
            h('div', { class: 'status', id: 'status', text: '待命' }),
            h('div', { class: 'log', id: 'log' }),
            details
        );

        const panel = h('div', { class: 'panel', id: 'panel' }, head, body);
        panel.style.cssText =
            'position:fixed;right:18px;bottom:18px;width:340px;display:block;' +
            'z-index:2147483600;background:#1b1b1f;color:#e9e9ec;' +
            'border:1px solid #35353d;border-radius:12px;' +
            'font:12.5px/1.5 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;' +
            'box-shadow:0 8px 28px rgba(0,0,0,.45);overflow:hidden;';

        const pill = h('div', { class: 'pill', id: 'pill' },
            h('span', { class: 'dot', id: 'dot2' }),
            h('span', { id: 'pillText', text: '0/0' })
        );

        return { panel, pill };
    }


    function buildPanel() {
        const old = document.getElementById('gib-host');
        if (old) old.remove();

        const host = document.createElement('div');
        host.id = 'gib-host';
        host.style.cssText = 'all:initial;z-index:2147483600;';
        (document.body || document.documentElement).appendChild(host);

        try {
            root = host.attachShadow({ mode: 'open' });
        } catch (e) {
            root = host; // 极少数环境不支持 shadow DOM，退化为普通节点
        }

        // 样式用 textContent 写入，不经过 innerHTML
        const styleEl = document.createElement('style');
        styleEl.textContent = PANEL_CSS;
        root.appendChild(styleEl);

        // 纯节点构建，不解析任何 HTML
        const nodes = buildPanelNodes();
        root.appendChild(nodes.panel);
        root.appendChild(nodes.pill);

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

    let bootTries = 0;

    function boot() {
        try {
            if (!document.body && !document.documentElement) throw new Error('DOM 尚未就绪');
            buildPanel();
            S.queue = parseQueue(S.raw, S.mode);
            if (S.cursor > S.queue.length) S.cursor = 0;
            render();
            showBadge('批量生图脚本已加载 v' + VER + ' · 面板在右下角');
            if (S.running && !S.paused && S.cursor < S.queue.length) {
                log('检测到未完成任务，自动继续 …');
                setTimeout(() => tick(), 1500);
            }
        } catch (e) {
            bootTries++;
            try { console.error('[GIB] 面板初始化失败（第 ' + bootTries + ' 次）：', e); } catch (err) { }
            if (bootTries <= 3) setTimeout(boot, 1200 * bootTries);
        }
    }

    let badgeShown = false;

    /** 首次加载时左下角闪一个提示条，用来确认脚本确实运行了 */
    function showBadge(text) {
        if (badgeShown) return;
        badgeShown = true;
        try {
            const b = document.createElement('div');
            b.textContent = text;
            b.style.cssText =
                'position:fixed;left:16px;bottom:16px;z-index:2147483600;' +
                'background:#1b1b1f;color:#e9e9ec;border:1px solid #4c8dff;border-radius:8px;' +
                'padding:8px 12px;font:12px/1.5 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;' +
                'box-shadow:0 6px 20px rgba(0,0,0,.35);transition:opacity .6s;opacity:1;' +
                'pointer-events:none;';
            (document.body || document.documentElement).appendChild(b);
            setTimeout(() => { b.style.opacity = '0'; setTimeout(() => b.remove(), 700); }, 4200);
        } catch (e) { }
    }

    // 便于在控制台排查：__GIB.info() / __GIB.probe() / __GIB.show()
    // 注意：脚本带 @grant，跑在沙箱里，必须写到 unsafeWindow 才在页面控制台可见
    function installDebugApi() {
        const api = {
            version: VER,
            info: () => ({
                version: VER,
                panel: !!document.getElementById('gib-host'),
                queue: S.queue.length,
                cursor: S.cursor,
                running: S.running,
                minimized: S.minimized
            }),
            probe: () => probe(),
            show: () => {
                S.minimized = false;
                const h = document.getElementById('gib-host');
                if (h) h.style.display = '';
                const p = root && root.getElementById && root.getElementById('panel');
                if (p) {
                    p.style.display = 'block';
                    p.style.right = '18px';
                    p.style.bottom = '18px';
                    p.style.left = 'auto';
                    p.style.top = 'auto';
                }
                save(); render();
                return '已显示面板';
            }
        };
        try { window.__GIB = api; } catch (e) { }
        try { if (typeof unsafeWindow !== 'undefined') unsafeWindow.__GIB = api; } catch (e) { }
        try { if (typeof unsafeWindow !== 'undefined') unsafeWindow.__GIB_LOADED__ = true; } catch (e) { }
    }

    installDebugApi();

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 600));
    } else {
        setTimeout(boot, 600);
    }
})();
