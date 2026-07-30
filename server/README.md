# Серверная часть синхронизации

`worker.js` разворачивается в Cloudflare Workers, данные хранит в D1.
Своего сервера не появляется: Cloudflare сам поддерживает и запускает код.

## Что должно быть настроено в панели Cloudflare

| Что | Значение |
|---|---|
| D1 база | `warehouse`, таблицы созданы (см. ниже) |
| Привязка базы к Worker | имя переменной **`DB`**, ровно так |
| Секрет | имя **`LEAD_KEY`**, значение — длинная случайная строка |

`LEAD_KEY` знает только ведущий и вводит его один раз на своём устройстве.
Он нужен, чтобы посторонний, узнавший адрес Worker, не мог создавать смены
в вашей базе. Доступа к данным этот ключ не даёт.

## Как обновить код Worker

1. Панель Cloudflare → **Compute** → **Workers & Pages** → `warehouse-sync`
2. **Edit code**
3. Заменить содержимое на текущий `server/worker.js`
4. **Deploy** — без этого изменения не применяются

Проверка после обновления: открыть в браузере `<адрес>/health`.
Ожидается `ok: true`, «база привязана», «секрет задан».

## Схема базы

```sql
CREATE TABLE IF NOT EXISTS sessions (code TEXT PRIMARY KEY, store TEXT NOT NULL, network TEXT NOT NULL, lead_name TEXT NOT NULL, mode TEXT NOT NULL, lead_token TEXT NOT NULL, master_name TEXT, master_hash TEXT, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS assignments (code TEXT NOT NULL, idx INTEGER NOT NULL, checker TEXT NOT NULL, is_lead INTEGER NOT NULL DEFAULT 0, zone_spec TEXT NOT NULL, items INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'new', started_at TEXT, finished_at TEXT, PRIMARY KEY (code, idx));
CREATE TABLE IF NOT EXISTS pool_chunks (code TEXT NOT NULL, idx INTEGER NOT NULL, part INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (code, idx, part));
CREATE TABLE IF NOT EXISTS results (code TEXT NOT NULL, idx INTEGER NOT NULL, tovar TEXT NOT NULL, uch TEXT NOT NULL, status TEXT NOT NULL, reason TEXT, found TEXT, comment TEXT, at TEXT NOT NULL, PRIMARY KEY (code, tovar, uch));
CREATE INDEX IF NOT EXISTS idx_assign_code ON assignments(code);
CREATE INDEX IF NOT EXISTS idx_results_code ON results(code);
CREATE INDEX IF NOT EXISTS idx_chunks_code ON pool_chunks(code, idx);
```

Выполняется в консоли базы (**D1 SQLite Database** → `warehouse` → **Console**).
Комментариев в SQL нет намеренно: при копировании переносы строк теряются,
и `--` закомментировал бы остаток запроса.

## Точки доступа

| Метод и путь | Кто вызывает | Чем подтверждает право |
|---|---|---|
| `GET /health` | кто угодно | — |
| `POST /session/create` | ведущий | заголовок `X-Lead-Key` |
| `POST /session/:code/pool/:idx/:part` | ведущий | `X-Lead-Token` |
| `GET /session/:code/info?store=` | все | код + номер магазина |
| `GET /session/:code/assignment/:idx?store=` | проверяющий | код + номер магазина |
| `GET /session/:code/pool/:idx/:part?store=` | проверяющий | код + номер магазина |
| `POST /session/:code/results?store=` | проверяющий | код + номер магазина |
| `GET /session/:code/progress` | ведущий | `X-Lead-Token` |
| `GET /session/:code/results` | ведущий | `X-Lead-Token` |
| `POST /session/:code/close` | ведущий | `X-Lead-Token` |
| `DELETE /session/:code` | ведущий | `X-Lead-Token` |
| `POST /session/:code/reclaim?store=` | ведущий | заголовок `X-Lead-Key` |
| `GET /sessions?store=` | ведущий | заголовок `X-Lead-Key` |

### Восстановление доступа

`leadToken` выдаётся один раз и живёт в памяти одного браузера. Если
устройство ведущего выключилось, а данные сайта пропали, результаты всей
смены остаются на сервере без владельца: отчёт не собрать и данные не
стереть. Переиздать токен было нечем.

`POST /session/:code/reclaim` закрывает эту дыру. Право подтверждается
мастер-ключом — тем самым, которым смена создавалась: его, в отличие от
токена, человек может ввести заново с любого устройства. Возвращается
**тот же** токен, а не новый: ротация выбила бы из сводки исправно
работающее второе устройство ведущего, ничего не прибавив к защите.

`GET /sessions?store=` перечисляет смены магазина — для ведущего,
забывшего код. Токены оттуда не отдаются.

Оба вызова пишут строку в журнал Worker.

Участок принадлежит ровно одному наряду, поэтому запись результата
ограничена условием `WHERE results.idx = excluded.idx`: чужую отметку
переписать нельзя даже намеренно.

## Учтённые ограничения бесплатного тарифа

| Ограничение | Как учтено |
|---|---|
| 10 мс процессорного времени на запрос | агрегаты считает SQL; куски пула проходят насквозь как текст, без разбора |
| 50 обращений к базе за вызов | результаты пишутся одним многострочным `INSERT` |
| 2 МБ на одно значение | пул режется кусками по 700 КБ |
| 100 КБ на длину SQL | данные передаются параметрами, а не в тексте запроса |

## Срок жизни данных

Истории не ведётся. Данные удаляются двумя путями:

- ведущий нажимает «Завершить проверку» — **после** того, как отчёт скачан;
- смены, в которые 36 часов не приходило ни одной отметки, подчищаются
  автоматически.

Срок отсчитывается от **последнего результата**, а не от создания смены.
Прежний вариант смотрел только на `created_at` и сносил проверку, в
которую прямо сейчас шли отметки: инвентаризация, пережившая ночь,
исчезала из-под работающих проверяющих.

Уборка запускается по расписанию, а не только при создании новой смены.
В Cloudflare это **Cron Trigger** (Worker → Settings → Trigger Events →
Cron Triggers, например `0 * * * *`); на своей машине — часовой таймер в
`server/host/main.js`. Без настроенного Cron в Cloudflare подчистка
останется только на создании смены, как раньше.

## Аварийная выгрузка

`tools/rescue.html` собирает те же два CSV в обход приложения — когда
сводка недостижима, а отчёт нужен. Открывается прямо с диска, ходит
только на чтение, ничего не закрывает и не удаляет. Токен берётся из
базы:

```sql
SELECT code, store, lead_name, created_at, lead_token FROM sessions ORDER BY created_at DESC;
```
