/* ═══════════════════════════════════════════════════════════════════════
   scanner.js — считывание штрихкода камерой устройства.

   Два пути декодирования за одним интерфейсом:
     • нативный BarcodeDetector — есть в Chrome на Android, ноль лишних
       килобайт;
     • ZXing из vendor/ — подгружается лениво и только там, где нативного
       нет. Это прежде всего Safari на iOS.

   Важное ограничение iOS: в приложении, установленном на домашний экран,
   доступ к камере не работал до iOS 14.3. На таких устройствах остаётся
   ручной ввод штрихкода — он доступен всегда и является полноценным
   рабочим путём, а не аварийным.
   ═══════════════════════════════════════════════════════════════════════ */

import { el, showToast } from './ui.js';

const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf'];

let stream   = null;
let detector = null;      // нативный BarcodeDetector
let zxing    = null;      // экземпляр ZXing-ридера
let rafId    = null;
let resolveScan = null;   // разрешает промис текущего сеанса
let torchOn  = false;

/* ── Ленивая загрузка ZXing ──────────────────────────────────────────── */
let zxingLoading = null;
function loadZxing() {
    if (window.ZXing) return Promise.resolve(window.ZXing);
    if (zxingLoading) return zxingLoading;
    zxingLoading = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'vendor/zxing.min.js';
        s.onload  = () => window.ZXing ? resolve(window.ZXing) : reject(new Error('ZXing не инициализировался'));
        s.onerror = () => reject(new Error('не удалось загрузить vendor/zxing.min.js'));
        document.head.appendChild(s);
    });
    return zxingLoading;
}

export const hasNativeDetector = () => 'BarcodeDetector' in window;

/* ── Публичный вход ────────────────────────────────────────────────────
   Открывает слой сканирования и разрешается штрихкодом либо null,
   если пользователь закрыл окно. */
export function scanBarcode() {
    return new Promise(async resolve => {
        resolveScan = resolve;
        openOverlay();

        try {
            await startCamera();
        } catch (e) {
            console.warn('[scanner] камера:', e);
            showCameraError(e);
            return;                       // слой остаётся, ручной ввод доступен
        }

        try {
            if (hasNativeDetector()) await runNative();
            else                     await runZxing();
        } catch (e) {
            console.warn('[scanner] декодер:', e);
            showCameraError(e);
        }
    });
}

/* ── Камера ────────────────────────────────────────────────────────── */
async function startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('браузер не даёт доступ к камере');
    }
    stream = await navigator.mediaDevices.getUserMedia({
        video: {
            facingMode: { ideal: 'environment' },
            width : { ideal: 1280 },
            height: { ideal: 720 }
        },
        audio: false
    });
    const video = el['scanner-video'];
    video.srcObject = video.srcObject || stream;
    video.setAttribute('playsinline', '');            // без него iOS уходит в полноэкранный плеер
    await video.play();

    el['scanner-hint'].textContent = 'Наведите камеру на штрихкод';
    updateTorchButton();
}

function stopCamera() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    if (zxing) { try { zxing.reset(); } catch (e) {} zxing = null; }
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
    const video = el['scanner-video'];
    if (video) { video.pause(); video.srcObject = null; }
    torchOn = false;
}

/* ── Фонарик ───────────────────────────────────────────────────────── */
function torchTrack() {
    const track = stream && stream.getVideoTracks()[0];
    if (!track || !track.getCapabilities) return null;
    const caps = track.getCapabilities();
    return caps && caps.torch ? track : null;
}

function updateTorchButton() {
    const btn = el['scanner-torch'];
    if (!btn) return;
    btn.classList.toggle('hidden', !torchTrack());
}

export async function toggleTorch() {
    const track = torchTrack();
    if (!track) return;
    torchOn = !torchOn;
    try {
        await track.applyConstraints({ advanced: [{ torch: torchOn }] });
        el['scanner-torch'].classList.toggle('scanner-torch-on', torchOn);
    } catch (e) {
        torchOn = false;
        console.warn('[scanner] фонарик:', e);
    }
}

/* ── Декодирование: нативный путь ──────────────────────────────────── */
async function runNative() {
    const supported = await window.BarcodeDetector.getSupportedFormats().catch(() => FORMATS);
    detector = new window.BarcodeDetector({
        formats: FORMATS.filter(f => supported.includes(f))
    });

    const video = el['scanner-video'];
    const tick = async () => {
        if (!stream) return;
        try {
            const codes = await detector.detect(video);
            if (codes && codes.length && codes[0].rawValue) return succeed(codes[0].rawValue);
        } catch (e) { /* кадр не распознан — просто ждём следующий */ }
        rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
}

/* ── Декодирование: ZXing ──────────────────────────────────────────── */
async function runZxing() {
    el['scanner-hint'].textContent = 'Подготовка сканера…';
    const ZX = await loadZxing();
    el['scanner-hint'].textContent = 'Наведите камеру на штрихкод';

    const hints = new Map();
    if (ZX.DecodeHintType && ZX.BarcodeFormat) {
        hints.set(ZX.DecodeHintType.POSSIBLE_FORMATS, [
            ZX.BarcodeFormat.EAN_13, ZX.BarcodeFormat.EAN_8,
            ZX.BarcodeFormat.UPC_A,  ZX.BarcodeFormat.UPC_E,
            ZX.BarcodeFormat.CODE_128, ZX.BarcodeFormat.CODE_39,
            ZX.BarcodeFormat.ITF
        ]);
        hints.set(ZX.DecodeHintType.TRY_HARDER, true);
    }

    zxing = new ZX.BrowserMultiFormatReader(hints, { delayBetweenScanAttempts: 120 });
    zxing.decodeFromStream(stream, el['scanner-video'], (result, err) => {
        if (result) succeed(result.getText());
    });
}

/* ── Завершение ────────────────────────────────────────────────────── */
function succeed(rawValue) {
    if (navigator.vibrate) navigator.vibrate(60);
    finish(String(rawValue).trim());
}

export function cancelScan() { finish(null); }

function finish(value) {
    stopCamera();
    closeOverlay();
    const done = resolveScan;
    resolveScan = null;
    if (done) done(value);
}

/* ── Слой ──────────────────────────────────────────────────────────── */
function openOverlay() {
    const o = el['scannerOverlay'];
    o.classList.remove('hidden');
    o.classList.add('flex');
    el['scanner-error'].classList.add('hidden');
    el['scanner-hint'].textContent = 'Запуск камеры…';
}

function closeOverlay() {
    const o = el['scannerOverlay'];
    o.classList.add('hidden');
    o.classList.remove('flex');
}

export const isScannerOpen = () => el['scannerOverlay'] && !el['scannerOverlay'].classList.contains('hidden');

function showCameraError(e) {
    const box = el['scanner-error'];
    const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
    box.textContent = denied
        ? 'Доступ к камере запрещён. Разрешите его в настройках браузера или введите штрихкод вручную.'
        : 'Камера недоступна на этом устройстве. Введите штрихкод вручную.';
    box.classList.remove('hidden');
    el['scanner-hint'].textContent = '';
}
