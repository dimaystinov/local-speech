# Roki schedule reminders

Roki can display local reminders for personal tasks and read the macOS Calendar after the user presses **Подключить календарь macOS…** and grants the system permission. Calendar integration is disabled initially. The app never creates, changes, or deletes calendar events. EventKit requires the full-access calendar permission to read events; the implementation only queries event identifier, title, dates, all-day flag, and cancellation status. It does not query descriptions, locations, attendees, or attachments.

Personal tasks are entered with an explicit title and date/time in **График и поручения Роки**. A reminder banner offers **Выполнено / Понятно** and **Через 10 минут**. Voice reminders are separately opt-in. The current banner remains visible until acknowledged; subsequent reminders wait in due-time order. Ordinary reminders do not interrupt active capture or speech when the host's `canDeliver` adapter disallows delivery. Delivery state is not advanced while busy.

## Local behavior and limits

- Requires the application to remain running. Closing the app, sleep, or a busy capture delays reminders; this is not a system background notification service. The scheduler checks approximately every ten seconds while running.
- Calendar query covers the next 24 hours plus ongoing events that started within the past day. Timed events become due five minutes before their start. All-day, cancelled, and ended events are excluded. The source is refreshed before each delivery, so cancelled or rescheduled occurrences are removed from waiting reminders. Revoked permission removes calendar reminders and leaves personal tasks usable.
- Occurrences use the calendar event identifier plus start timestamp as their deduplication key. A moved occurrence is a new reminder. Personal tasks use a generated UUID.
- `schedule.json` lives in the app's Application Support `LocalSpeech/RokiSchedule` folder. It contains local task titles, times, completion state, reminder IDs, current banner and preferences. It is written by private temporary file and atomic rename, with directory permissions 0700 and file permissions 0600. Symlink paths are refused. No network or cloud API is used by the scheduler; Calendar itself may contain accounts already synchronized by macOS.
- The current banner is restored after restart without speaking again. Delivered history is bounded to 2,048 keys; active task delivery markers survive normal history expiry. A malformed or unsupported storage file is preserved, and reminders pause with an explanatory error instead of replacing it.
- Up to 500 active / 1,000 stored personal tasks, 240 characters per task title; dates within the next five years. Completed tasks and older calendar history are pruned after 30 days. Snoozes are local, and never move the underlying calendar event.
- No automatic natural-language task extraction, recurrence editor, calendar account management, or universal background scheduling is implemented. The caring tone is a conversational style, not authority to act on the user's calendar.

## Integration API

`RokiSchedule` is main-actor isolated and observable. Set `canDeliver: () -> Bool` to enforce capture/voice exclusion; `onReminder: (RokiReminder, Bool) -> Void` receives the reminder and the current voice preference only after state is saved. `onClear: () -> Void` tells the host to stop speech belonging to a cleared reminder. Call `start()` / `stop()` for timer lifecycle. `RokiSchedulePanel(model:)` contains settings, task entry, banner and task completion controls.

The host must include `NSCalendarsFullAccessUsageDescription` in its bundle's Info.plist. No permission is requested by initialization or `start()`. Only `requestCalendarAccess()` requests it, from the explicit calendar button.

## Verification

Synthetic tests in `RokiScheduleTests` cover the five-minute boundary, cancelled/all-day/ended events, recurring occurrences, snooze/cancellation, sequential banners, persisted deduplication, file permissions, symlink/corruption rejection, busy delivery, completion, and input validation. They do not request calendar permission or read the user's calendar. Actual Calendar authorization and account-specific event changes require an opt-in integration check on a signed application. Voice/UI delivery is tested separately by the host integration.
