# Asterisk для Allo GPT

Основная инструкция — [в README проекта](../README.md). Генератор создаёт конфигурацию отдельной локальной АТС; не подменяйте ею конфиги другой рабочей АТС.

## Локальный Docker Desktop

1. Скопируйте `.env.example` в `.env` в корне проекта.
2. Задайте отдельный случайный `ASTERISK_ARI_PASSWORD`. Для Docker оставьте `ASTERISK_ARI_URL=http://127.0.0.1:8088` и `ASTERISK_HTTP_BIND_ADDRESS=0.0.0.0`.
3. Для телефонной сети заполните четыре `PLUSOFON_SIP_*` / `PLUSOFON_CALLER_NUMBER` поля по основному README. Без полного набора генератор оставляет только локальную проверку и отключает SIP-регистрацию/исходящие.
4. Выполните:

```powershell
npm.cmd run setup:asterisk
docker compose up -d asterisk
docker compose exec asterisk asterisk -rx "pjsip show registrations"
npm.cmd run check:gateway
```

Создаются `pjsip.conf`, `extensions.conf`, `ari.conf`, `http.conf`, `rtp.conf`, `modules.conf`, `chan_websocket.conf` в `runtime/asterisk/`. В них есть пароль ARI и SIP-пароль, поэтому каталог исключён из Git. В Windows режимы Unix `0600` не заменяют настройки доступа NTFS.

Образ Asterisk 23 закреплён digest в `compose.yaml`. Нужны `chan_websocket`, ARI, PJSIP, `codec_resample`, телефонные кодеки alaw/ulaw, `TALK_DETECT` и `func_jitterbuffer`. Аудио между Node.js и АТС — PCM 24 кГц; телефонная часть согласует кодек с оператором. Фиксированный `JITTERBUFFER` (по умолчанию 120 мс, `ASTERISK_JITTERBUFFER_MS`) устанавливается на входящей стороне PJSIP до обработки и записи; для исходящего звонка используется обработчик `b(gpt-charge^s^1)` на вызываемом канале. WebSocket использует заголовок Basic-авторизации, медиа-канал — выданный Asterisk идентификатор соединения.

Compose публикует ARI TCP 8088 **только на localhost**, SIP TCP 5060 и RTP UDP 10000–10020. Конфигурация использует TCP для SIP, не UDP. При NAT может потребоваться публичный `ASTERISK_EXTERNAL_ADDRESS`, firewall и проброс RTP. Настройки зависят от сети и оператора.

Записи обеих сторон создаются в `/var/spool/asterisk/recording` и доступны на хосте в `recordings/`. После правки `.env` перегенерируйте конфиги и выполните `docker compose restart asterisk`, когда линия свободна.

`check:gateway` создаёт только Local/Echo, проверяет возврат тестового PCM внутри АТС и очистку канала. Он не проверяет OpenAI, исходящий Caller ID и доступность городского номера.

## Проверки и остановка

```powershell
docker compose logs --tail 100 asterisk
docker compose exec asterisk asterisk -rx "pjsip show registrations"
docker compose exec asterisk asterisk -rx "core show channels"
docker compose stop asterisk
```

При повторных отказах регистрации остановите контейнер и уточните у оператора причину и требуемую паузу. Генератор содержит `auth_rejection_permanent=no` и `forbidden_retry_interval=5`; во время блокировки нельзя оставлять повторные регистрации работающими.

## Удалённая АТС

При отдельной установке используйте Asterisk 23 с перечисленными модулями и защитите доступ к ARI. Предпочтителен SSH-туннель, например:

```text
ssh -N -L 8088:127.0.0.1:8088 operator@asterisk.example
```

На удалённой АТС HTTP должен слушать `127.0.0.1`, а Node.js подключается к локальному концу туннеля. Сгенерированный HTTP-конфиг рассчитан на HTTP и не настраивает TLS. Публиковать незащищённый ARI в интернет не следует.

Автоматическая доставка конфигов, туннель и перенос записей с удалённого сервера в приложение не реализованы. Штатная схема этого репозитория — локальный Docker, где `recordings/` смонтирован напрямую.
