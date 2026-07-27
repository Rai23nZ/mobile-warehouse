# Свой сервер синхронизации

Тот же `server/worker.js`, что работает в Cloudflare, но на своей машине
с российским IP. Логика не дублируется: вместо базы D1 подставляется
локальная SQLite через `sqlite-d1.js`, вместо платформы Cloudflare —
Bun. Сам `worker.js` не меняется.

```
интернет → Caddy (443, HTTPS)  →  Bun (127.0.0.1:8787)  →  SQLite
              сертификат сам        server/worker.js         файл на диске
```

| Файл | Назначение |
|---|---|
| `sqlite-d1.js` | обёртка над SQLite с интерфейсом D1 |
| `main.js` | точка входа, отдаёт `worker.js` в Bun |
| `Caddyfile` | HTTPS и проксирование, кладётся в `/etc/caddy/` |
| `warehouse-sync.service` | служба systemd, кладётся в `/etc/systemd/system/` |

---

## Что понадобится

- Сервер Ubuntu 24.04 LTS с публичным IPv4
- Домен или поддомен, указывающий на этот IP **напрямую**
- Ключи ведущих, которые вы придумали для `LEAD_KEYS`

---

## Шаг 1. Подключиться к серверу

С ноутбука, в терминале (в Windows — PowerShell):

```bash
ssh root@194.226.166.195
```

При первом подключении спросит про отпечаток ключа — ответить `yes`.
Пароль root выдаётся в панели Рег.облака.

---

## Шаг 2. Обновить систему и поставить нужное

```bash
apt update && apt upgrade -y
apt install -y curl unzip ufw
```

---

## Шаг 3. Межсетевой экран

Оставляем открытыми только три порта: SSH, HTTP и HTTPS.
Порт приложения (8787) наружу не открывается — он слушает только
localhost.

```bash
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
ufw status
```

> Порт 80 нужен не для работы, а для получения сертификата: Let's Encrypt
> проверяет владение доменом, обращаясь именно на него. Закроете — HTTPS
> перестанет продлеваться.

---

## Шаг 4. Отдельный пользователь для приложения

Служба не должна работать от root.

```bash
adduser --system --group --no-create-home --home /opt/warehouse-sync warehouse
```

> `--no-create-home` важен: без него adduser положит в каталог служебные
> файлы, и `git clone` на шаге 6 откажется работать — ему нужен пустой
> каталог. Каталог создаст сам git.

---

## Шаг 5. Установить Bun

```bash
curl -fsSL https://bun.sh/install | bash
mv ~/.bun/bin/bun /usr/local/bin/bun
chmod 755 /usr/local/bin/bun
bun --version
```

Bun выбран потому, что SQLite и серверный HTTP в нём встроены: ставить
и обновлять отдельные библиотеки не нужно.

---

## Шаг 6. Положить код

```bash
git clone https://github.com/Rai23nZ/mobile-warehouse.git /opt/warehouse-sync
mkdir -p /opt/warehouse-sync/data
chown -R warehouse:warehouse /opt/warehouse-sync
```

**Если каталог оказался непустым** и git отказался («destination path
already exists and is not an empty directory») — то же самое без
требования пустоты:

```bash
cd /opt/warehouse-sync
git init -b main
git remote add origin https://github.com/Rai23nZ/mobile-warehouse.git
git fetch origin main
git reset --hard origin/main
git branch --set-upstream-to=origin/main main
mkdir -p data
chown -R warehouse:warehouse /opt/warehouse-sync
```

Обновление в будущем:

```bash
cd /opt/warehouse-sync && git pull && systemctl restart warehouse-sync
```

---

## Шаг 7. Ключи ведущих

```bash
nano /etc/warehouse-sync.env
```

Содержимое (ключи подставьте свои):

```
LEAD_KEYS=Петров:ВАШ_КЛЮЧ_1,Иванова:ВАШ_КЛЮЧ_2,Сидоров:ВАШ_КЛЮЧ_3
DB_PATH=/opt/warehouse-sync/data/warehouse.db
PORT=8787
```

Закрыть доступ посторонним:

```bash
chown root:warehouse /etc/warehouse-sync.env
chmod 640 /etc/warehouse-sync.env
```

---

## Шаг 8. Запустить службу

```bash
cp /opt/warehouse-sync/server/host/warehouse-sync.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now warehouse-sync
systemctl status warehouse-sync
```

Проверка изнутри сервера:

```bash
curl http://127.0.0.1:8787/health
```

Ожидается `{"ok":true,"db":"база привязана, активных проверок: 0",…}`.

Журнал, если что-то не так:

```bash
journalctl -u warehouse-sync -n 50 --no-pager
```

---

## Шаг 9. Направить домен на сервер

В панели Cloudflare, в зоне нужного домена:

1. Добавить запись **A**: имя `ru`, значение `194.226.166.195`
2. **Облако переключить на серое** (DNS only) — это принципиально.
   Оранжевое вернёт трафик на адреса Cloudflare, и всё, ради чего
   затевался переезд, пропадёт.

Проверить с ноутбука, что имя разрешается в нужный адрес:

```bash
nslookup ru.warehouse-sync.ru
```

Должен отвечать `194.226.166.195`, а не адреса вида `188.114.x.x`.
Записи DNS обновляются не мгновенно — подождите несколько минут.

---

## Шаг 10. Caddy и HTTPS

```bash
apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | tee /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install -y caddy
```

Положить конфиг, **заменив домен на свой**:

```bash
cp /opt/warehouse-sync/server/host/Caddyfile /etc/caddy/Caddyfile
nano /etc/caddy/Caddyfile
systemctl reload caddy
```

Сертификат Caddy получит сам за несколько секунд. Проверить:

```bash
journalctl -u caddy -n 30 --no-pager
```

---

## Шаг 11. Проверка снаружи

С ноутбука или телефона:

```
https://ru.warehouse-sync.ru/health
```

Должен вернуться тот же JSON. **Обязательно проверьте с мобильного
интернета** — ради этого всё и делалось.

---

## Шаг 12. Подключить к приложению

В `js/sync.js` поставить новый адрес **первым** в списке `API_CANDIDATES`,
Cloudflare оставить дальше — как запасной путь. Поднять `SHELL_VERSION`
в `sw.js` и выложить.

---

## Обслуживание

| Что | Как часто | Команда |
|---|---|---|
| Обновление системы | раз в месяц | `apt update && apt upgrade -y` |
| Обновление приложения | по мере правок | `cd /opt/warehouse-sync && git pull && systemctl restart warehouse-sync` |
| Журнал сервера | при разборе | `journalctl -u warehouse-sync -f` |
| Состояние службы | при разборе | `systemctl status warehouse-sync` |
| Сертификат | само | Caddy продлевает без участия |

Резервные копии отдельной настройки не требуют: данные смены живут
считанные часы и стираются по завершении проверки. Достаточно снимков
на стороне Рег.облака.

---

## Если что-то не работает

| Признак | Причина | Что делать |
|---|---|---|
| `curl` на localhost не отвечает | служба не запустилась | `journalctl -u warehouse-sync -n 50` |
| «КЛЮЧИ НЕ ЗАДАНЫ» в `/health` | не прочитан `/etc/warehouse-sync.env` | проверить права и перезапустить службу |
| Снаружи не открывается, изнутри работает | DNS или Caddy | `nslookup`, затем `journalctl -u caddy` |
| Сертификат не выдаётся | закрыт порт 80 | `ufw allow 80/tcp` |
| Имя разрешается в `188.114.x.x` | осталось оранжевое облако | переключить на серое |
