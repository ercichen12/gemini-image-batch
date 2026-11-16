// ==UserScript==
// @name         Gemini 批量生图队列
// @name:en      Gemini Batch Image Queue
// @namespace    https://github.com/ercichen12/gemini-image-batch
// @version      1.7.2
// @description  一次性粘贴 N 条生图提示词，在 gemini.google.com/images 逐条自动提交并下载生成的图片
// @description:en Paste N image prompts at once, auto-submit them one by one on Gemini and download results
// @author       ercichen12
// @match        https://gemini.google.com/*
// @grant        GM_download
// @grant        GM_xmlhttpRequest
// @connect      googleusercontent.com
// @connect      lh3.googleusercontent.com
// @connect      *.googleusercontent.com
// @connect      gemini.google.com
// @noframes
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const NS = '__GIB_LOADED__';
    if (window[NS]) return;
    window[NS] = true;
    const VER = '1.7.2';
    try { console.info('[GIB] 批量生图脚本已注入 v' + VER); } catch (e) { }

    const IMAGES_URL = 'https://gemini.google.com/images';
    const LS_KEY = 'gib_state_v1';

    const DEFAULTS = {
        raw: '',
        mode: 'blank',      // blank = 空行分隔, line = 每行一条
        cursor: 0,
        statuses: [],       // { state, files, reason }
        records: {},        // index -> { prompt, state, files, meta, session, at, reason, nativeCount }
        autoExport: true,
        exported: false,
        capFail: false,
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
        if (!out.records || typeof out.records !== 'object') out.records = {};
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

    function slug(text, max) {
        const n = max || 20;
        return String(text || '')
            .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
            .replace(/\s+/g, '_')
            .replace(/^_+|_+$/g, '')
            .slice(0, n) || 'prompt';
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

            // 判定失败：必须等「生成确实结束」+ 冷却期，避免图还没渲染就下结论
            const ended = stop === false && (sawStop || Date.now() - start > 25000);
            if (ended && imgs.length === 0 && stable >= 3 && Date.now() - start > 30000) {
                const t = pageTextSample();
                if (/(limit|quota|too many|try again|上限|额度|配额|次数已用|稍后再试)/i.test(t)) {
                    return { error: '配额或限流' };
                }
                if (t.trim().length > 40) return { error: '仅返回文字，未出图' };
                // 其余情况不下结论，继续等到超时（宁可慢，也不丢掉已经生成好的图）
            }

            await sleep(1200);
        }
        if (peak > 0) return { error: '超时（已检测到图片但未稳定）' };
        const sample = pageTextSample().replace(/\s+/g, ' ').slice(0, 80);
        return { error: '未检测到图片 · 页面文字 ' + sample.length + ' 字' + (sample ? '：' + sample : '') };
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

    /** 下载端点常把类型标成 octet-stream，按文件头纠正回来 */
    async function sniffImage(blob) {
        if (/^image\//i.test(blob.type || '')) return blob;
        try {
            const b = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
            if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return new Blob([blob], { type: 'image/jpeg' });
            if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E) return new Blob([blob], { type: 'image/png' });
            if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57) return new Blob([blob], { type: 'image/webp' });
        } catch (e) { }
        return blob;
    }

    /** 扩展层取字节，绕开页面 CORS */
    function gmFetchBlob(url) {
        return new Promise((resolve, reject) => {
            if (typeof GM_xmlhttpRequest !== 'function') {
                reject(new Error('GM_xmlhttpRequest 不可用'));
                return;
            }
            GM_xmlhttpRequest({
                method: 'GET',
                url: url,
                responseType: 'arraybuffer',
                timeout: 30000,
                onload: (r) => {
                    if (r.status >= 400) { reject(new Error('HTTP ' + r.status)); return; }
                    const buf = r.response;
                    if (!buf || buf.byteLength < 4096) { reject(new Error('响应过小')); return; }
                    let type = 'application/octet-stream';
                    const m = /content-type:\s*([^\r\n;]+)/i.exec(r.responseHeaders || '');
                    if (m) type = m[1].trim();
                    resolve(new Blob([buf], { type: type }));
                },
                onerror: () => reject(new Error('网络错误')),
                ontimeout: () => reject(new Error('超时'))
            });
        });
    }

    async function fetchBlob(url) {
        try {
            const res = await fetch(url, { credentials: 'include' });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const blob = await res.blob();
            if (blob.size < 2048) throw new Error('响应过小');
            return await sniffImage(blob);
        } catch (e) {
            // 页面内取不到（多半是跨域），交给扩展再试一次
            try {
                const gm = await gmFetchBlob(url);
                if (gm.size < 2048) throw new Error('响应过小');
                return await sniffImage(gm);
            } catch (e2) {
                throw new Error((e.message || e) + ' / 扩展取图：' + (e2.message || e2));
            }
        }
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

    function hoverScope(scope) {
        const types = ['pointerenter', 'pointerover', 'mouseenter', 'mouseover', 'mousemove'];
        const targets = [scope].concat(Array.from(scope.querySelectorAll('img')).slice(0, 2));
        targets.forEach((n) => {
            types.forEach((t) => {
                try { n.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window })); } catch (e) { }
            });
        });
    }

    async function revealToolbar(scope) {
        hoverScope(scope);
        await sleep(500);
    }

    function isDisabled(el) {
        if (!el) return true;
        if (el.disabled) return true;
        if (el.getAttribute('aria-disabled') === 'true') return true;
        try {
            const st = getComputedStyle(el);
            if (st.pointerEvents === 'none' || st.opacity === '0') return true;
        } catch (e) { }
        return false;
    }

    /** 轮询到下载按钮真的可点再返回；不靠定时猜 */
    async function waitDownloadReady(scope, timeoutMs) {
        const t0 = Date.now();
        let why = '未找到下载按钮';
        while (Date.now() - t0 < timeoutMs) {
            hoverScope(scope);
            const btn = findDownloadControl(scope);
            if (btn) {
                if (!isDisabled(btn)) return btn;
                why = '按钮处于禁用态';
            }
            await sleep(400);
        }
        log(`  ⚠️ 下载按钮 ${Math.round(timeoutMs / 1000)} 秒内未就绪（${why}）`, 'warn');
        return null;
    }

    const MIN_FULL_W = 1500;

    async function blobSize(blob) {
        try {
            const bmp = await createImageBitmap(blob);
            return { w: bmp.width, h: bmp.height };
        } catch (e) {
            return { w: 0, h: 0 };
        }
    }

    /**
     * gg-dl 地址默认给缩略图。=s0 只保证最大边长，仍是压缩版；
     * =d 才是原始文件（同尺寸下体积明显更大）。所以 =d 优先。
     */
    function sizeVariants(u) {
        const out = [];
        try {
            const m = /=[^=\/]+$/.exec(u);
            const base = m ? u.slice(0, m.index) : u;
            const add = (s) => { if (out.indexOf(s) === -1 && out.length < 5) out.push(s); };
            add(base + '=d');
            add(base + '=s0');
            add(u);
        } catch (e) { }
        return out.length ? out : [u];
    }

    /** 记录尺寸和体积，用来自证取到的是不是原图 */
    async function blobMeta(blob) {
        let dim = '';
        try {
            const bmp = await createImageBitmap(blob);
            dim = bmp.width + '×' + bmp.height;
        } catch (e) { }
        const mb = (blob.size / 1048576).toFixed(2) + 'MB';
        return dim ? dim + ' · ' + mb : mb;
    }

    /**
     * 页面的「Download full size」最终无非三种出口：createObjectURL 生成 blob、
     * 造一个 <a download> 去点、或 window.open。临时接管这三处，就能在它下载前
     * 把真正的原图截下来，我们自己做命名。
     */
    let pendingUndo = [];

    function restorePendingHooks() {
        if (!pendingUndo.length) return;
        pendingUndo.reverse().forEach((fn) => { try { fn(); } catch (e) { } });
        pendingUndo = [];
    }

    async function captureDownload(trigger, wantName) {
        const uw = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
        const cap = {
            blob: null, href: null, name: '', urls: [], rpc: [], found: [], rpcCalls: [],
            renamed: false, renameFailed: false, newWindow: false, swallowed: false
        };
        const undo = [];

        const pushUrl = (tag, u) => {
            try {
                const s = String(u || '');
                if (!s || s.length > 600) return;
                if (/^(data:|about:|chrome|blob:)/.test(s)) return;
                if (cap.urls.length < 12) cap.urls.push(tag + ' ' + s);
            } catch (e) { }
        };

        // 出口一：createObjectURL 生成的图片 blob
        try {
            const orig = uw.URL.createObjectURL;
            undo.push(() => { uw.URL.createObjectURL = orig; });
            uw.URL.createObjectURL = function (b) {
                try {
                    if (b && /^image\//i.test(b.type) && b.size > 4096) {
                        if (!cap.blob || b.size > cap.blob.size) cap.blob = b;
                    }
                } catch (e) { }
                return orig.apply(this, arguments);
            };
        } catch (e) { }

        // 出口二：<a download> 点出来的
        try {
            const proto = uw.HTMLAnchorElement && uw.HTMLAnchorElement.prototype;
            if (proto) {
                const orig = proto.click;
                undo.push(() => { proto.click = orig; });
                proto.click = function () {
                    try {
                        const h = this.href || '';
                        if (/^(blob:|https?:)/i.test(h)) {
                            if (!cap.href) { cap.href = h; cap.name = this.download || ''; }
                            if (wantName) {
                                // 只有同源/blob 链接，download 属性才会被浏览器采纳
                                const sameOrigin = /^blob:/i.test(h) || h.indexOf(location.origin) === 0;
                                if (sameOrigin) {
                                    this.download = wantName;
                                    cap.renamed = true;
                                } else {
                                    // 跨域：放行也改不了名，拦下来我们自己按名保存同一份
                                    cap.renameFailed = true;
                                    cap.swallowed = true;
                                    return;
                                }
                            }
                        }
                    } catch (e) { }
                    // 一律放行：让浏览器照常下载
                    return orig.apply(this, arguments);
                };
            }
        } catch (e) { }

        // 出口三：window.open
        try {
            const orig = uw.open;
            undo.push(() => { uw.open = orig; });
            uw.open = function (url) {
                try {
                    const u = String(url || '');
                    if (/^(blob:|https?:)/i.test(u)) {
                        if (!cap.href) cap.href = u;
                        cap.newWindow = true;
                        pushUrl('open', u);
                    }
                } catch (e) { }
                return orig.apply(this, arguments);
            };
        } catch (e) { }

        // 出口四：fetch —— 下载 RPC 由我们代办：读真响应，回假响应阻止页面自己导航下载
        try {
            const orig = uw.fetch;
            undo.push(() => { uw.fetch = orig; });
            uw.fetch = function (input, init) {
                const url = typeof input === 'string' ? input : (input && input.url) || '';
                try { pushUrl('fetch', url); } catch (e) { }

                if (!/rpcids=c8o8Fe/.test(url)) return orig.apply(this, arguments);

                try {
                    if (cap.rpcCalls.length < 3) {
                        const b = readBodySync(init && init.body);
                        if (b) cap.rpcCalls.push({ url: url, body: b });
                    }
                } catch (e) { }

                let p;
                try { p = orig.apply(this, arguments); } catch (e) { p = null; }
                return Promise.resolve(p).then(function (res) {
                    try {
                        res.clone().text().then(function (t) { cap.rpcText = t; }).catch(function () { });
                    } catch (e) { }
                    cap.suppressed = true;
                    return fakeRpcResponse();
                }).catch(function () {
                    cap.suppressed = true;
                    return fakeRpcResponse();
                });
            };
        } catch (e) { }

        try {
            const xp = uw.XMLHttpRequest && uw.XMLHttpRequest.prototype;
            if (xp) {
                const orig = xp.open;
                undo.push(() => { xp.open = orig; });
                xp.open = function (m, u) {
                    try { pushUrl('xhr', u); } catch (e) { }
                    return orig.apply(this, arguments);
                };
            }
        } catch (e) { }

        try {
            const fp = uw.HTMLFormElement && uw.HTMLFormElement.prototype;
            if (fp) {
                const orig = fp.submit;
                undo.push(() => { fp.submit = orig; });
                fp.submit = function () {
                    try { pushUrl('form', this.action); } catch (e) { }
                    return orig.apply(this, arguments);
                };
            }
        } catch (e) { }

        pendingUndo = undo.slice();
        try {
            try { trigger(); } catch (e) { }
            const t0 = Date.now();
            // 实测点击后约 35 秒才真正下载；一旦某轮抓不到就缩短后续等待
            const waitMs = S.capFail ? 12000 : 60000;
            while (Date.now() - t0 < waitMs) {
                if (cap.renamed || cap.href || cap.rpcText) break;
                await sleep(300);
            }
            if (cap.renamed || cap.href || cap.rpcText) {
                log(`  点击后 ${Math.round((Date.now() - t0) / 1000)} 秒捕捉到下载动作`);
            } else {
                log('  等了 ' + Math.round(waitMs / 1000) + ' 秒仍未捕捉到下载动作', 'warn');
            }
            await sleep(500);
        } finally {
            restorePendingHooks();
        }

        // 从 batchexecute 响应里抠出原图地址（响应里的 = & / 常被转义）
        cap.rpc.forEach((text) => {
            const raw = String(text)
                .replace(/\\u003d/g, '=').replace(/\\u0026/g, '&')
                .replace(/\\u003f/g, '?').replace(/\\\//g, '/');
            const hits = raw.match(/https:\/\/[^"'\s\\\]]{20,}/g) || [];
            hits.forEach((u) => {
                if (!/googleusercontent|gg-dl|\.jpe?g|\.png|\.webp/i.test(u)) return;
                if (cap.found.indexOf(u) === -1 && cap.found.length < 8) cap.found.push(u);
            });
        });

        return cap;
    }

    function unescapeRpc(text) {
        return String(text || '')
            .replace(/\\u003d/gi, '=').replace(/\\u0026/gi, '&')
            .replace(/\\u003f/gi, '?').replace(/\\u002f/gi, '/')
            .replace(/\\\//g, '/').replace(/\\"/g, '"');
    }

    /** RPC 响应里可能的两种形态：图片地址，或直接内嵌的 base64 */
    function rpcCandidates(text) {
        const out = { urls: [], b64: null };
        const s = unescapeRpc(text);
        const urls = s.match(/https:\/\/[^\s"'<>\\]{16,}/g) || [];
        urls.forEach((u) => {
            if (!/googleusercontent|\/gg-dl\/|\.(jpe?g|png|webp)/i.test(u)) return;
            if (out.urls.indexOf(u) === -1 && out.urls.length < 10) out.urls.push(u);
        });
        const bm = s.match(/(\/9j\/[A-Za-z0-9+/=]{4000,}|iVBORw0KGgo[A-Za-z0-9+/=]{4000,})/);
        if (bm) out.b64 = bm[1];
        return out;
    }

    /** 把各种形态的请求体统一成字符串；读不出来返回 null */
    function readBodySync(body) {
        if (!body) return null;
        try {
            if (typeof body === 'string') return body.length > 8 ? body : null;
            if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
                const s = body.toString();
                return s.length > 8 ? s : null;
            }
            if (typeof FormData !== 'undefined' && body instanceof FormData) {
                const parts = [];
                body.forEach((v, k) => { parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v)); });
                const s = parts.join('&');
                return s.length > 8 ? s : null;
            }
        } catch (e) { }
        return null;
    }

    function fakeRpcResponse() {
        return new Response(")]}'\n\n[]", {
            status: 200,
            headers: { 'content-type': 'application/json' }
        });
    }

    /** 用同样的地址和请求体再发一次，拿干净的响应 */
    async function replayRpc(call) {
        const res = await fetch(call.url, {
            method: 'POST',
            credentials: 'include',
            headers: {
                'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
                'x-same-domain': '1'
            },
            body: call.body
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return await res.text();
    }

    function b64ToBlob(b64) {
        const bin = atob(b64);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        const type = arr[0] === 0xFF ? 'image/jpeg' : (arr[0] === 0x89 ? 'image/png' : 'image/jpeg');
        return new Blob([arr], { type });
    }

    /* --------------------- 生成阶段探针（不点按钮的取图路线） ---------------------
     * 页面显示的是 blob: 图，说明生成过程中必然请求过一次真实图片字节。
     * 在整轮生成期间挂探针，把这类响应直接收下来，就绕开了下载按钮。
     */

    let netProbe = null;

    function stopNetProbe() {
        if (netProbe && netProbe.stop) { try { netProbe.stop(); } catch (e) { } }
        netProbe = null;
    }

    function startNetProbe() {
        stopNetProbe();
        const uw = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
        const urls = [];
        const seen = new Set();
        const undo = [];
        let active = true;
        let biggest = null;

        const note = (u) => {
            try {
                const s = String(u || '');
                if (!s || seen.has(s)) return;
                if (!/googleusercontent|gg-dl|\/image|\.(jpe?g|png|webp)/i.test(s)) return;
                seen.add(s);
                if (urls.length < 40) urls.push(s);
            } catch (e) { }
        };

        try {
            const of = uw.fetch;
            undo.push(() => { uw.fetch = of; });
            uw.fetch = function (input) {
                if (!active) return of.apply(this, arguments);
                const u = typeof input === 'string' ? input : (input && input.url) || '';
                note(u);
                const p = of.apply(this, arguments);
                try {
                    if (p && typeof p.then === 'function') {
                        p.then((res) => {
                            try {
                                const ct = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
                                if (!/^image\//i.test(ct)) return;
                                res.clone().blob().then((b) => {
                                    if (b && b.size > 8192 && (!biggest || b.size > biggest.size)) biggest = b;
                                }).catch(() => { });
                            } catch (e) { }
                        }).catch(() => { });
                    }
                } catch (e) { }
                return p;
            };
        } catch (e) { }

        try {
            const xp = uw.XMLHttpRequest && uw.XMLHttpRequest.prototype;
            if (xp) {
                const oo = xp.open;
                undo.push(() => { xp.open = oo; });
                xp.open = function (m, u) { if (active) note(u); return oo.apply(this, arguments); };
            }
        } catch (e) { }

        netProbe = {
            urls,
            get blob() { return biggest; },
            stop() {
                active = false;
                undo.reverse().forEach((fn) => { try { fn(); } catch (e) { } });
            }
        };
        return netProbe;
    }

    /** 保存单张：优先原图，绝不落 webp */
    /**
     * 把所有能拿到的字节都当候选，最后按分辨率择优。
     * 只有 ≥ MIN_FULL_W 才算原图；否则退回页面原生下载，绝不拿缩略图充数。
     */
    /**
     * 让浏览器自己下载（保证拿到原图），只做一件事：把文件名改成我们的。
     * 能不能改取决于 Gemini 的触发方式：
     *   <a download> + 同源/blob  -> 改 download 属性即可
     *   <a download> + 跨域      -> 浏览器忽略属性，改用 GM_download 取同一份
     *   新窗口 / 整页跳转        -> 网页无权干涉，只能保持 Google 命名
     */
    async function saveOneImage(img, baseName) {
        if (!img || !img.src) throw new Error('图片元素无效');
        const scope = imageScope(img);

        const ctrl = await waitDownloadReady(scope, 30000);
        if (!ctrl) throw new Error('下载按钮未就绪');

        const cap = await captureDownload(() => ctrl.click(), baseName);
        if (!cap.renamed && !cap.href && !cap.rpcText) { S.capFail = true; save(); }
        log(`  捕捉结果：链接${cap.href ? '有' : '无'} · 改名${cap.renamed ? '成功' : '未成功'}${cap.newWindow ? ' · 新窗口' : ''}${cap.renameFailed ? ' · 跨域' : ''} · 页面blob${cap.blob ? '有' : '无'}`);

        if (cap.renamed) {
            log('  ✓ 已改名为 ' + baseName + '，由浏览器下载');
            return { name: baseName, from: '浏览器下载', meta: '' };
        }

        // 用页面那次下载响应的真实地址取图（不是重放，字节应与浏览器一致）
        if (cap.rpcText) {
            const cand = rpcCandidates(cap.rpcText);
            log(`  页面下载响应：${cap.rpcText.length}B，地址 ${cand.urls.length} 个`);
            // 优先：交给扩展按名下载同一地址（已验证可拿到原始文件）
            if (cand.urls.length && typeof GM_download === 'function') {
                log('  改用扩展下载该地址 …', 'warn');
                try {
                    await new Promise((res, rej) => {
                        GM_download({ url: cand.urls[0], name: baseName + '.jpg', saveAs: false, onload: res, onerror: rej });
                    });
                    log('  ✓ 已由扩展保存为 ' + baseName + '.jpg');
                    return { name: baseName + '.jpg', from: '扩展下载', meta: '' };
                } catch (e) {
                    log('  ✗ 扩展下载失败：' + (e && e.message ? e.message : e), 'err');
                }
            }

            let best = null;
            for (let i = 0; i < cand.urls.length; i++) {
                const vs = sizeVariants(cand.urls[i]);
                for (let k = 0; k < vs.length; k++) {
                    try {
                        const b = await fetchBlob(vs[k]);
                        if (!/^image\//i.test(b.type)) continue;
                        const d = await blobSize(b);
                        log(`  候选 ${vs[k].slice(-8)}：${d.w}×${d.h} ${(b.size / 1048576).toFixed(2)}MB`);
                        if (!best || b.size > best.b.size) best = { b: b, d: d };
                    } catch (e) { log(`  取图失败 ${vs[k].slice(-8)}：${e.message || e}`, 'warn'); }
                }
            }
            if (best) {
                const name = baseName + '.' + mimeToExt(best.b.type);
                triggerDownload(best.b, name);
                log(`  ✓ 已保存 ${name}（${best.d.w}×${best.d.h} · ${(best.b.size / 1048576).toFixed(2)}MB）`);
                return { name: name, from: '原图', meta: await blobMeta(best.b) };
            }

            // 取不到字节，但地址就是浏览器要导航去下载的那个：交给扩展按名下载
            if (cand.urls.length && typeof GM_download === 'function') {
                const u = cand.urls[0];
                log('  改用扩展下载该地址 …', 'warn');
                try {
                    await new Promise((res, rej) => {
                        GM_download({ url: u, name: baseName + '.jpg', saveAs: false, onload: res, onerror: rej });
                    });
                    log('  ✓ 已由扩展保存为 ' + baseName + '.jpg');
                    return { name: baseName + '.jpg', from: '扩展下载', meta: '' };
                } catch (e) {
                    log('  ✗ 扩展下载失败：' + (e && e.message ? e.message : e), 'err');
                }
            }

            // 最后：直接导航到该地址，至少让文件落到本地（名字归 Google）
            if (cand.urls.length) {
                try {
                    log('  ↳ 改为直接打开下载地址 …', 'warn');
                    location.href = cand.urls[0];   // 导航式下载，不会被弹窗拦截
                    return { name: '（浏览器下载，文件名由 Google 生成）', from: '浏览器下载', meta: '' };
                } catch (e) { }
            }
            log('  ⚠️ 从下载响应里没取到图片', 'warn');
        }

        // 兜底：让浏览器自己下一次，保证这一轮不空手
        try {
            await sleep(800);
            await revealToolbar(scope);
            const again = findDownloadControl(scope) || ctrl;
            if (again && !isDisabled(again)) again.click();
            log('  ↳ 已退回原生下载，文件名归 Google', 'warn');
        } catch (e) { }
        return { name: '（浏览器下载，文件名由 Google 生成）', from: '浏览器下载', meta: '' };
    }

    /** 队列跑完自动导出清单、对照页、日志 */
    function autoExportIfNeeded() {
        if (!S.autoExport || S.exported) return;
        if (!recordKeys().length) return;
        S.exported = true;
        save();
        exportAs('csv');
        setTimeout(() => exportAs('html'), 1000);
        setTimeout(() => exportAs('log'), 2000);
    }

    async function downloadAll(images, idx, prompt) {
        const base = String(idx + 1).padStart(3, '0') + '_' + slug(prompt, 40);
        const out = [];
        for (let i = 0; i < images.length; i++) {
            const suffix = images.length > 1 ? '_' + (i + 1) : '';
            try {
                const r = await saveOneImage(images[i].el, base + suffix);
                out.push(r);
                log(`⬇ 已保存 ${r.name}（${r.from}${r.meta ? ' ' + r.meta : ''}）`);
                await sleep(900);
            } catch (e) {
                log(`✗ 第 ${i + 1} 张保存失败：${e.message || e}`);
            }
        }
        return out;
    }

    /** 记录：提示词 ↔ 图片 ↔ 会话，清单与对照页的数据源 */
    function updateRecord(idx, patch) {
        if (!S.records) S.records = {};
        const cur = S.records[idx] || { prompt: S.queue[idx] || '', at: Date.now() };
        S.records[idx] = Object.assign(cur, patch);
        save();
    }

    function csvCell(v) {
        const s = (v === null || v === undefined) ? '' : String(v);
        return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }

    function esc(s) {
        return String(s === null || s === undefined ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function recordKeys() {
        return Object.keys(S.records || {}).map(Number).sort((a, b) => a - b);
    }

    function buildCsv() {
        const rows = [['序号', '状态', '提示词', '文件名', '张数', '规格', '会话链接', '完成时间', '备注'].join(',')];
        recordKeys().forEach((k) => {
            const r = S.records[k] || {};
            rows.push([
                String(k + 1).padStart(3, '0'),
                r.state || '',
                r.prompt || '',
                (r.files || []).join(' ; '),
                r.images || '',
                r.meta || '',
                r.session || '',
                r.at ? new Date(r.at).toLocaleString('zh-CN') : '',
                r.reason || (r.nativeCount ? '文件由浏览器命名，见会话链接' : '')
            ].map(csvCell).join(','));
        });
        return '\ufeff' + rows.join('\r\n');
    }

    function buildHtml() {
        const cards = recordKeys().map((k) => {
            const r = S.records[k] || {};
            const ok = r.state === 'ok';
            const imgs = (r.files || []).map((f) => '<img src="' + esc(f) + '" alt="">').join('');
            return '<article class="card' + (ok ? '' : ' bad') + '">' +
                '<div class="hd"><b>' + String(k + 1).padStart(3, '0') + '</b><span>' + esc(r.state || '') + '</span></div>' +
                (imgs ? '<div class="im">' + imgs + '</div>' : '<div class="im empty">未保存到本地 · 可用下方链接回原对话取图</div>') +
                '<p class="p">' + esc(r.prompt || '') + '</p>' +
                '<div class="mt">' + esc(r.meta || '') +
                (r.session ? ' · <a href="' + esc(r.session) + '" target="_blank" rel="noreferrer">回到对话</a>' : '') +
                (r.reason ? ' · ' + esc(r.reason) : '') +
                '</div></article>';
        }).join('');

        return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
            '<title>Gemini 批量生图对照</title><style>' +
            'body{margin:0;padding:24px;background:#f6f6f7;color:#1c1c1e;' +
            'font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}' +
            'h1{font-size:17px;font-weight:600;margin:0 0 4px}' +
            '.sub{color:#6b6b73;font-size:12.5px;margin-bottom:18px}' +
            '.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px}' +
            '.card{background:#fff;border:1px solid #e4e4e8;border-radius:10px;overflow:hidden;display:flex;flex-direction:column}' +
            '.card.bad{border-color:#f0b4b4;background:#fffafa}' +
            '.hd{display:flex;justify-content:space-between;padding:8px 10px;font-size:11.5px;color:#6b6b73;border-bottom:1px solid #f0f0f2}' +
            '.hd b{color:#1c1c1e;font-weight:600}' +
            '.im{background:#fafafa;display:flex;justify-content:center}' +
            '.im img{width:100%;display:block}' +
            '.im.empty{padding:36px 0;color:#a0a0a8;font-size:12px}' +
            '.p{margin:0;padding:10px 10px 6px;font-size:12.5px;word-break:break-word}' +
            '.mt{padding:0 10px 10px;color:#8a8a92;font-size:11.5px;word-break:break-all}' +
            'a{color:#2a6df5;text-decoration:none}' +
            '</style></head><body>' +
            '<h1>Gemini 批量生图对照</h1>' +
            '<div class="sub">共 ' + recordKeys().length + ' 条 · 导出 ' +
            esc(new Date().toLocaleString('zh-CN')) + ' · 把本文件与图片放在同一目录，缩略图才会显示</div>' +
            '<div class="grid">' + cards + '</div></body></html>';
    }

    function exportAs(kind) {
        if (kind === 'log') {
            if (!logLines.length) { log('⚠️ 还没有日志', 'warn'); return; }
            triggerDownload(new Blob([logText()], { type: 'text/plain;charset=utf-8' }), 'gemini-batch-log.txt');
            log('⬇ 已导出 gemini-batch-log.txt');
            return;
        }
        if (!recordKeys().length) { log('⚠️ 还没有可导出的记录', 'warn'); return; }
        if (kind === 'csv') {
            triggerDownload(new Blob([buildCsv()], { type: 'text/csv;charset=utf-8' }), 'gemini-batch-manifest.csv');
            log('⬇ 已导出 gemini-batch-manifest.csv');
        } else {
            triggerDownload(new Blob([buildHtml()], { type: 'text/html;charset=utf-8' }), 'gemini-batch-index.html');
            log('⬇ 已导出 gemini-batch-index.html（与图片同目录，双击打开）');
        }
        save();
    }

    /* ---------------------------------- 主流程 -------------------------------- */

    let busy = false;

    async function tick() {
        if (busy) return;
        if (!S.running || S.paused) return;

        // 保险：上一轮若因异常没还原钩子，这里兜底，避免污染页面请求
        restorePendingHooks();

        if (S.cursor >= S.queue.length) {
            S.running = false;
            save(); render();
            log('✅ 队列全部完成');
            autoExportIfNeeded();
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
            let saved = [];
            if (S.autoDownload) saved = await downloadAll(result.images, idx, prompt);

            const owned = (saved || []).filter((r) => r.name && r.name.charAt(0) !== '（');
            updateRecord(idx, {
                prompt,
                state: (saved.length > 0 || !S.autoDownload) ? 'ok' : 'fail',
                files: owned.map((r) => r.name),
                nativeCount: saved.length - owned.length,
                meta: owned[0] && owned[0].meta ? owned[0].meta : '',
                images: result.images.length,
                session: /\/app\//.test(location.pathname) ? location.href : '',
                at: Date.now()
            });

            S.statuses[idx] = { state: 'ok', files: owned.length, reason: '' };
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
                autoExportIfNeeded();
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
        updateRecord(idx, {
            prompt: S.queue[idx] || '',
            state: 'fail',
            reason,
            files: [],
            meta: '',
            session: /\/app\//.test(location.pathname) ? location.href : '',
            at: Date.now()
        });
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
    const logLines = [];

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
      margin-top: 7px; height: 150px; overflow-y: auto; padding: 7px 8px;
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
            h('div', { class: 'row' },
                h('button', { class: 'btn', id: 'btnProbe', text: '自检当前页面' }),
                h('button', { class: 'btn', id: 'btnCopyLog', text: '复制日志' })
            ),
            h('div', { class: 'row' },
                h('button', { class: 'btn', id: 'btnCsv', text: '导出清单' }),
                h('button', { class: 'btn', id: 'btnHtml', text: '对照页' }),
                h('button', { class: 'btn', id: 'btnLog', text: '导出日志' })
            )
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
            cfgNewChat: $('cfgNewChat'), cfgAutoDl: $('cfgAutoDl'), btnProbe: $('btnProbe'),
            btnCopyLog: $('btnCopyLog'), btnCsv: $('btnCsv'), btnHtml: $('btnHtml'), btnLog: $('btnLog')
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
            S = Object.assign({}, DEFAULTS, { raw: '', cursor: 0, statuses: [], sentAt: {}, records: {}, queue: [], exported: false, capFail: false });
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
        ui.btnCopyLog.addEventListener('click', copyLog);
        ui.btnCsv.addEventListener('click', () => exportAs('csv'));
        ui.btnLog.addEventListener('click', () => exportAs('log'));
        ui.btnHtml.addEventListener('click', () => exportAs('html'));

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
        const t = new Date().toTimeString().slice(0, 8);
        const line = `[${t}] ${msg}`;
        logLines.push(line);
        if (logLines.length > 3000) logLines.shift();
        if (!ui.log) return;
        const div = document.createElement('div');
        if (cls) div.className = cls;
        else if (/^✓|^✅|已保存/.test(msg)) div.className = 'ok';
        else if (/^✗|失败|异常/.test(msg)) div.className = 'err';
        else if (/⚠️|⏸|↳/.test(msg)) div.className = 'warn';
        div.textContent = line;
        ui.log.appendChild(div);
        ui.log.scrollTop = ui.log.scrollHeight;
        while (ui.log.childElementCount > 300) ui.log.firstElementChild.remove();
    }

    function logText() {
        const head = [
            '===== Gemini 批量生图 运行日志 =====',
            '版本: v' + VER,
            '时间: ' + new Date().toLocaleString('zh-CN'),
            '页面: ' + location.href,
            '队列: ' + S.queue.length + ' 条 / 进度 ' + S.cursor,
            '====================================',
            ''
        ].join('\n');
        return head + logLines.join('\n') + '\n';
    }

    async function copyLog() {
        const text = logText();
        if (!logLines.length) { log('⚠️ 日志为空', 'warn'); return; }
        try {
            await navigator.clipboard.writeText(text);
            log('📋 日志已复制到剪贴板，可直接粘贴');
        } catch (e) {
            try {
                const ta = document.createElement('textarea');
                ta.value = text;
                ta.style.cssText = 'position:fixed;left:-9999px;';
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                ta.remove();
                log('📋 日志已复制到剪贴板，可直接粘贴');
            } catch (e2) {
                log('✗ 复制失败，请在日志区手动选中后 Ctrl+C', 'err');
            }
        }
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
        S.capFail = false;   // 每批重新给满窗口
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
        if (imgs[0] && imgs[0].src) log('首图地址: ' + imgs[0].src.slice(0, 150));
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
            csv: () => buildCsv(),
            html: () => buildHtml(),
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
