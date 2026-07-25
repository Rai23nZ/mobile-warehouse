/* ═══════════════════════════════════════════════════════════════════════
   reasons.js — справочник причин неподтверждения.

   Единственное место, где заданы формулировки. В сессию пишется `id`,
   а текст берётся отсюда при отрисовке плиток и при выгрузке отчёта:
   правка формулировки не ломает уже сохранённые сессии.

   `needsScan` — нужен ли второй шаг мастера со сканированием того, что
   оказалось на участке вместо нужного товара.
   ═══════════════════════════════════════════════════════════════════════ */

export const REASONS = [
    { id: 'bc_factory', label: 'Неправильный ШК (заводской)', needsScan: true  },
    { id: 'label_knt',  label: 'Неверная оклейка ШК (КНТ)',   needsScan: true  },
    { id: 'label_pp',   label: 'Неверная оклейка ШК (ПП)',    needsScan: true  },
    { id: 'empty_pack', label: 'Пустая упаковка',             needsScan: false },
    { id: 'part_set',   label: 'Часть комплекта',             needsScan: false },
    { id: 'dup_skip',   label: 'Задвоение/Пропуск',           needsScan: false },
    { id: 'ntp',        label: 'НТП',                         needsScan: false },
    { id: 'not_found',  label: 'Не установлена',              needsScan: false }
];

const BY_ID = new Map(REASONS.map(r => [r.id, r]));

export const reasonById    = id => BY_ID.get(id) || null;
export const reasonLabel   = id => (BY_ID.get(id) || {}).label || '';
export const reasonNeedsScan = id => !!(BY_ID.get(id) || {}).needsScan;

/* Подставляется в отчёт, когда штрихкод отсканирован, но артикул по нему
   в базе не нашёлся. Это не ошибка: подробности пользователь пишет в
   комментарий, а сам ШК всё равно попадает в колонку «Факт: ШК». */
export const NO_ARTICLE = 'ШК нет';
