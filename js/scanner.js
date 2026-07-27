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

/* Типы сканирования: 1D-штрихкоды товара и 2D QR-код проверки.
   Раньше список форматов был один на оба сценария и содержал только
   1D-форматы — из-за этого сканер, открытый на экране присоединения,
   физически не мог распознать QR: ни нативный BarcodeDetector, ни ZXing
   не искали такой паттерн на кадре. */
export const SCAN_TYPE_BARCODE = 'barcode';
export const SCAN_TYPE_QR      = 'qr';

const BARCODE_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf'];
const QR_FORMATS      = ['qr_code'];

const HINT_TEXT = {
    [SCAN_TYPE_BARCODE]: 'Наведите камеру на штрихкод',
    [SCAN_TYPE_QR]:      'Наведите камеру на QR-код'
};

function formatsFor(type) { return type === SCAN_TYPE_QR ? QR_FORMATS : BARCODE_FORMATS; }

const SCAN_INTERVAL_MS = 120;       // пауза между попытками ZXing

let stream   = null;
let detector = null;      // нативный BarcodeDetector
let rafId    = null;
let timerId  = null;      // следующая попытка ZXing
let resolveScan = null;   // разрешает промис текущего сеанса
let torchOn  = false;
let scanType = SCAN_TYPE_BARCODE;   // что ищем в текущем сеансе
let roiCanvas = null, roiCtx = null;

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
export function scanBarcode(type = SCAN_TYPE_BARCODE) {
    return new Promise(async resolve => {
        scanType = type === SCAN_TYPE_QR ? SCAN_TYPE_QR : SCAN_TYPE_BARCODE;
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

    el['scanner-hint'].textContent = HINT_TEXT[scanType];
    updateTorchButton();
}

function stopCamera() {
    if (rafId)   { cancelAnimationFrame(rafId); rafId = null; }
    if (timerId) { clearTimeout(timerId); timerId = null; }
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

/* ── Область распознавания ─────────────────────────────────────────────
   Декодеру отдаётся не весь кадр, а только рамка в центре экрана.
   Иначе код ловится «на подлёте»: пока товар несут к рамке, в объектив
   успевает попасть соседняя вешалка или второй ярлык того же товара —
   и сеанс закрывается чужим штрихкодом раньше, чем пользователь успел
   прицелиться. Обрезка заодно и ускоряет разбор: пикселей меньше.

   Рамка живёт в CSS-пикселях поверх видео, растянутого object-fit:
   cover, поэтому её координаты пересчитываются в пиксели самого потока.
   Cover масштабирует картинку по большей стороне и центрирует, лишнее
   уходит за края элемента — отсюда scale и отрицательные отступы. */
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function frameRoi() {
    const video = el['scanner-video'];
    const frame = el['scanner-frame'];
    if (!video || !frame) return null;

    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh || video.readyState < 2) return null;   // кадра ещё нет

    const vr = video.getBoundingClientRect();
    const fr = frame.getBoundingClientRect();
    if (!vr.width || !vr.height) return null;

    const scale = Math.max(vr.width / vw, vr.height / vh);
    const offX  = (vr.width  - vw * scale) / 2;
    const offY  = (vr.height - vh * scale) / 2;

    /* Строго целые пиксели. Дробный исходный прямоугольник заставляет
       браузер пересэмплировать вырезку, и тонкие штрихи расплываются:
       EAN-13 с модулем шириной в пару пикселей после такой обрезки не
       читается вообще, хотя на глаз кадр остаётся чистым. Копируем
       один в один, без масштабирования. */
    const sx = Math.floor(clamp((fr.left - vr.left - offX) / scale, 0, vw));
    const sy = Math.floor(clamp((fr.top  - vr.top  - offY) / scale, 0, vh));
    const sw = Math.min(Math.round(fr.width  / scale), vw - sx);
    const sh = Math.min(Math.round(fr.height / scale), vh - sy);
    if (sw < 16 || sh < 16) return null;

    if (!roiCanvas) {
        roiCanvas = document.createElement('canvas');
        roiCtx    = roiCanvas.getContext('2d', { willReadFrequently: true });
    }

    /* Вырезка обкладывается белым полем. Штрихкоду по стандарту нужна
       свободная светлая полоса по краям, а код, поднесённый к рамке
       вплотную, занимает её почти целиком — обрезанный «в край» EAN-13
       переставал читаться вовсе. Поле рисуем сами, а не забираем
       пикселями из кадра: за рамкой может стоять соседний ярлык, и
       тогда вся затея теряет смысл. Обрезанный рамкой код от этого
       читаемым не станет — не сойдутся направляющие и контрольная
       цифра. */
    const pad = Math.round(sw * 0.1);
    const cw = sw + pad * 2, ch = sh + pad * 2;
    if (roiCanvas.width !== cw || roiCanvas.height !== ch) {
        roiCanvas.width  = cw;
        roiCanvas.height = ch;
    }
    roiCtx.fillStyle = '#fff';
    roiCtx.fillRect(0, 0, cw, ch);
    roiCtx.drawImage(video, sx, sy, sw, sh, pad, pad, sw, sh);
    return roiCanvas;
}

/* ── Декодирование: нативный путь ──────────────────────────────────── */
async function runNative() {
    const wanted = formatsFor(scanType);
    const supported = await window.BarcodeDetector.getSupportedFormats().catch(() => wanted);
    const formats = wanted.filter(f => supported.includes(f));
    detector = new window.BarcodeDetector({
        formats: formats.length ? formats : wanted
    });

    const tick = async () => {
        if (!stream) return;
        const roi = frameRoi();
        if (roi) {
            try {
                const codes = await detector.detect(roi);
                if (codes && codes.length && codes[0].rawValue) return succeed(codes[0].rawValue);
            } catch (e) { /* кадр не распознан — просто ждём следующий */ }
        }
        rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
}

/* ── Декодирование: ZXing ──────────────────────────────────────────── */
async function runZxing() {
    el['scanner-hint'].textContent = 'Подготовка сканера…';
    const ZX = await loadZxing();
    el['scanner-hint'].textContent = HINT_TEXT[scanType];

    const hints = new Map();
    if (ZX.DecodeHintType && ZX.BarcodeFormat) {
        const possibleFormats = scanType === SCAN_TYPE_QR
            ? [ZX.BarcodeFormat.QR_CODE]
            : [
                ZX.BarcodeFormat.EAN_13, ZX.BarcodeFormat.EAN_8,
                ZX.BarcodeFormat.UPC_A,  ZX.BarcodeFormat.UPC_E,
                ZX.BarcodeFormat.CODE_128, ZX.BarcodeFormat.CODE_39,
                ZX.BarcodeFormat.ITF
            ];
        hints.set(ZX.DecodeHintType.POSSIBLE_FORMATS, possibleFormats);
        hints.set(ZX.DecodeHintType.TRY_HARDER, true);
    }

    /* Ридер низкого уровня вместо decodeFromStream: тот сам забирает
       кадр целиком и обрезать его не даёт, а нам нужна только рамка. */
    const reader = new ZX.MultiFormatReader();
    reader.setHints(hints);

    const attempt = () => {
        if (!stream) return;                          // сканер закрыли
        const roi = frameRoi();
        let text = null;
        if (roi) {
            try {
                const source = new ZX.HTMLCanvasElementLuminanceSource(roi);
                const bitmap = new ZX.BinaryBitmap(new ZX.HybridBinarizer(source));
                text = reader.decode(bitmap).getText();
            } catch (e) {
                /* NotFoundException на кадре без кода — штатная ситуация */
            }
            reader.reset();
        }
        if (text) return succeed(text);
        timerId = setTimeout(attempt, SCAN_INTERVAL_MS);
    };
    attempt();
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
    /* Режим объявляется разметке: у QR рамка квадратная под сам код, и
       нет кнопки ручного ввода — под QR не напечатано цифр, набирать
       нечего. Для ключа проверки ручной путь остался на экране
       присоединения: № магазина и код. */
    o.dataset.scan = scanType;
    o.setAttribute('aria-label', scanType === SCAN_TYPE_QR
        ? 'Сканирование QR-кода' : 'Сканирование штрихкода');
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
    // запасной путь разный: у ШК он тут же в слое, у QR — поля на экране
    const fallback = scanType === SCAN_TYPE_QR
        ? 'Введите № магазина и код проверки вручную.'
        : 'Введите штрихкод вручную.';
    box.textContent = denied
        ? 'Доступ к камере запрещён. Разрешите его в настройках браузера. ' + fallback
        : 'Камера недоступна на этом устройстве. ' + fallback;
    box.classList.remove('hidden');
    el['scanner-hint'].textContent = '';
}
