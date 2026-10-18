# Встраивание LocalSpeech: Web, Tauri, озвучка и обновления

SDK 0.3.0 — кандидат для интеграционного тестирования. Браузерное распознавание
работает через локальный WASM/системный движок. GigaAM/Qwen из исследовательских
скриптов не включены в этот runtime. Нельзя переносить их WER на браузерный SDK.

## 1. Установка в существующее приложение

Node.js 22+ нужен только для сборки/установки, Python 3.10+ — для скачивания моделей.
До публикации тега используйте проверенный commit SHA. После выпуска:

```sh
npm install --save-exact github:dimaystinov/local-speech#v0.3.0
```

Git prepare собирает runtime без весов. Это не пакет из npm registry. Закрепите
package-lock.json. ESM + TypeScript:

```js
import { create, version } from 'local-speech-sdk';
import { createVoice } from 'local-speech-sdk/voice';
const speech = create({
  assetBaseURL: new URL('/speech/0.3.0/', location.href).href,
  language: 'mixed', maxSegmentSeconds: 6,
  terms: ['Docker', 'Kubernetes']
});
speech.on('partial', ({text}) => { preview.textContent = text; });
speech.on('final', ({rawText}) => { transcript.value += rawText + '\n'; });
speech.on('error', ({message}) => { status.textContent = message; });
// В обработчиках кнопок:
await speech.start();
// await speech.stop();
// При размонтировании: await speech.dispose();
```

`preview`, `transcript`, `status` — DOM-элементы вашего приложения. Не вставляйте
распознанный текст через innerHTML. Для React/Vue создавайте один экземпляр на
компонент и освобождайте его при размонтировании; не создавайте SDK при каждом
рендере. Сохраняйте final по sessionId + segmentId; partial не является финальным
текстом. Пауза не означает завершение диалога.

Полностью скопируйте `node_modules/local-speech-sdk/dist/local-speech/` в
`public/speech/0.3.0/`: worker, WASM, worklet и manifest должны оставаться рядом.
Один импорт JS не разворачивает ресурсы автоматически.

```sh
cd node_modules/local-speech-sdk
python3 tools/download-models.py --models small whisper_tiny whisper
```

Затем скопируйте скачанный каталог `models/` внутрь `/speech/0.3.0/` на сервере.
Не направляйте assetBaseURL на GitHub. Для RU минимальный small весит около 29 MB;
смешанная RU/EN требует multilingual tiny/base (~104/161 MB). HTTPS обязателен,
кроме localhost. Нужен доступ к микрофону; отказ показывайте пользователю.

## 2. Готовое приложение Web / Tauri 2

Из checkout репозитория:

```sh
npm ci
python3 tools/download-models.py --models small whisper_tiny whisper
npm run build
cd examples/tauri
npm ci
npm run assets
npm run dev
# Открыть http://127.0.0.1:1420 — тот же интерфейс в браузере.
# В другом терминале, из examples/tauri:
npm run tauri -- dev
# Для macOS .app:
npm run tauri -- build --bundles app
```

Tauri требует Rust 1.90+ и платформенные build prerequisites. Проверьте `rustc --version`: старый Homebrew Rust может перекрывать rustup в PATH. `npm run assets` копирует
сборку в версионный каталог и отказывается перезаписывать существующий. При
локальном повторном тесте удаляйте только созданный примером каталог
`examples/tauri/public/speech/0.3.0/`, затем копируйте заново. Эти ресурсы игнорируются
Git. Не используйте runtime-only сборку без последующего добавления моделей:
локальное распознавание тогда завершится явной ошибкой загрузки.

Пример использует тот же браузерный WASM SDK внутри WebView, без shell-плагина,
удалённого сервера и доступа к файлам пользователя. Он не захватывает системный
звук Zoom/Telegram: для этого нужен native capture adapter. Передавайте его
моно Float32 PCM через `start({input:'pcm'})` и `await write(samples, sampleRate)`.
Пакеты <=1 секунды, фиксированная частота за сессию, ограниченная очередь на
стороне захвата. Не отправляйте крупные массивы без backpressure через Tauri IPC.

Для macOS включён NSMicrophoneUsageDescription. Микрофон, AudioWorklet, WASM,
кэш и установленный TTS нужно проверить в **собранном .app**, поскольку dev
localhost и packaged WebView имеют разные origins и разрешения. Windows/Linux
не сертифицированы этим примером. Нет обещания одинаковой скорости на телефонах.

Настройка CSP не отключена: разрешены локальные скрипты, WASM, workers и Tauri IPC.
При смене порта или добавлении провайдера обновляйте точечные разрешения. Смотрите
[конфигурацию Tauri](https://v2.tauri.app/reference/config/) и
[macOS Info.plist](https://v2.tauri.app/distribute/macos-application-bundle/).

## 3. Говорилка

```js
import { createVoice } from 'local-speech-sdk/voice';
const voice = createVoice({language:'ru-RU', rate:1, pitch:1});
console.log(voice.voices()); // Только localService === true
await voice.speak('Здравствуйте. Чем я могу помочь?'); // Завершение воспроизведения
voice.cancel();
voice.dispose();
```

Вызывайте speak из пользовательского действия. Список системных голосов может
загрузиться позже: повторно запросите voices после `speechSynthesis.voiceschanged`.
Если локального голоса нет, SDK возвращает ошибку, не выбирает сетевой голос.
Это доверие флагу браузера localService, а не независимый аудит ОС.
`speak` принимает до 4000 символов, не ставит неограниченную очередь: второй вызов
во время речи отклоняется. Для длинного текста последовательно await каждую фразу.
Отмена/таймаут отклоняет Promise с AbortError; dispose запрещает новые вызовы.
Web Speech cancel глобален для страницы — выделите один контроллер озвучки.

### Локальный Qwen или другая модель

SDK не скачивает Qwen TTS автоматически. Подключите локальный движок как provider:

```js
const voice = createVoice({provider:{
  async speak(text, {signal}) {
    // Ваш локальный движок: синтез + playback.
    // Promise завершается после звука, не после принятия задания.
    await localQwen.play(text, {signal});
  },
  cancel() { return localQwen.stop(); }
}});
```

`localQwen` — ваш адаптер, не экспорт SDK. Существующая Roki/Qwen реализация и
сохранённый голос остаются в `apps/mac/Assets/RokiVoice` и нативном Mac-приложении;
этот пакет не меняет их настройки. Полностью переносимого Qwen runtime внутри
браузера/Tauri этот выпуск не содержит.

Для Tauri экспортирован `createTauriVoiceProvider(invoke)`: он вызывает ваши
Rust-команды `local_speech_speak` и `local_speech_cancel`. Speak получает
`text, language, voiceUri, rate, pitch` и должен вернуть успех только после
воспроизведения. Cancel должен остановить текущую задачу. Реализуйте и
зарегистрируйте команды в host-приложении, привяжите их к локальной модели,
ограничьте очередь/размер текста и права окна. В демонстрационном Rust host эти команды реализованы для macOS через локальный
`/usr/bin/say`: без shell, с ограничением одного задания, отменой и ожиданием
окончания звука. Pitch поддерживается только 1, rate 0.5–2; голос выбирается по
RU/EN. В Tauri применяется этот адаптер, в обычном браузере — Web Speech. Для
Windows/Linux и Qwen замените реализацию команд своим локальным провайдером.
Не передавайте текст в shell; это данные. Приложение отвечает за локальность
кастомного провайдера, прекращение playback и согласование ASR/TTS: демо не
озвучивает, пока включён микрофон, чтобы не распознавать собственную речь.

## 4. Кэш, версии, обновление и откат

Весам проверяются размер/SHA256; браузер хранит их в локальном кэше. Хранилище
может быть очищено ОС. `cacheOnly` запрещает новые загрузки весов, но не делает
shell/workers автоматически offline. Для офлайна веб-приложение должно отдельно
кэшировать весь runtime. Tauri может включать веса прямо в приложение.

Версия SDK берётся из package.json и доступна через `version`/diagnostics().
Ставьте новый тег или commit, собирайте в новом `/speech/VERSION/`, прогоняйте
микрофон/PCM/озвучку/отмену, переключайте URL между сессиями. Старый каталог
сохраняйте для отката. Не заменяйте WASM/worker во время разговора. Обновления
моделей требуют совместимого manifest и повторной проверки качества, а не
подмены файла под прежним именем.

[Процесс релиза](releases.md) публикует npm-архив в GitHub Releases с SHA256.
SDK не загружает исполняемые обновления сам. Для отдельного Tauri-приложения
можно добавить [подписанный Tauri updater](https://v2.tauri.app/plugin/updater/)
в host: ключи подписи и endpoint принадлежат издателю приложения. Здесь updater
не включён и ключи не создаются; выпуск библиотеки не обновляет установленный .app.

## 5. Приёмка интеграции

- Разрешение/отказ микрофона, start/stop/start, dispose, завершение хвоста речи.
- RU, EN и смешанная речь с терминами; текст можно выделить/копировать полностью.
- Чистая установка, повторный запуск, cacheOnly, недостающие и повреждённые модели.
- Озвучка до конца, отмена, отсутствие локального голоса, отказ провайдера.
- Длительная сессия, ограничение очереди, CPU/RAM и задержка на целевом устройстве.
- Обновление на новую версию и возврат на старую без потери сохранённого текста.

Автотесты не заменяют проверку микрофона и динамиков на каждом целевом WebView.
Качество без эталонной расшифровки не является измеренной точностью.
