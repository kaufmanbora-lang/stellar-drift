# Как загрузить новую версию Stellar Drift

## Что загружать в GitHub

Загружай файлы из папки `stellar-drift`, не zip-архив:

- `index.html`
- `server.js`
- `package.json`
- `render.yaml`
- `README.md`
- `UPDATE_GUIDE.md`
- `.gitignore`

`leaderboard.json` не загружай. Это локальные аккаунты и тестовый рейтинг с твоего ПК.

## Обновление через сайт GitHub

1. Открой репозиторий `kaufmanbora-lang/stellar-drift`.
2. Нажми `Add file`.
3. Нажми `Upload files`.
4. Перетащи новые файлы из папки `stellar-drift`.
5. Если GitHub спросит про замену файлов, соглашайся.
6. Внизу страницы в поле описания можно написать:

```text
Update Stellar Drift
```

7. Нажми зелёную кнопку `Commit changes`.

## Обновление Render

Обычно Render сам увидит новый commit и начнёт деплой.

Если деплой не начался:

1. Открой Render.
2. Зайди в сервис `stellar-drift`.
3. Нажми `Manual Deploy`.
4. Выбери `Deploy latest commit`.
5. Подожди, пока статус станет `Live`.

## Как понять, что всё получилось

Открой ссылку Render вида:

```text
https://stellar-drift-....onrender.com
```

Если игра открылась, версия обновилась. Если появилась красная ошибка `Failed`, открой вкладку `Logs` в Render и пришли скрин ошибки.
