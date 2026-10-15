import SwiftUI

struct RokiSchedulePanel: View {
    @ObservedObject var model: RokiSchedule
    @State private var title = ""
    @State private var due = Date().addingTimeInterval(600)
    var body: some View {
        DisclosureGroup("График и поручения Роки") {
            VStack(alignment: .leading, spacing: 9) {
                Text("Роки напоминает мягко и по делу. Напоминания работают, пока приложение открыто. Во время распознавания ждут свободного момента.").font(.caption).foregroundStyle(.secondary)
                Text(model.calendarStatus).font(.caption)
                if model.calendarEnabled {
                    Button("Отключить календарь") { model.disableCalendar() }
                } else {
                    Button("Подключить календарь macOS…") { model.requestCalendarAccess() }.disabled(model.requestingAccess)
                }
                Text("Календарь используется только для чтения; события не изменяются. macOS запрашивает полный доступ — отдельного разрешения только на чтение нет.").font(.caption2).foregroundStyle(.secondary)
                Toggle("Озвучивать напоминания", isOn: $model.voiceEnabled)
                if let reminder = model.currentReminder {
                    VStack(alignment: .leading, spacing: 6) {
                        Label(reminder.title, systemImage: "bell.fill").font(.headline)
                        Text(reminder.due, style: .time).font(.caption)
                        HStack {
                            Button(reminder.source == .task ? "Выполнено" : "Понятно") { model.completeCurrent() }
                            Button("Через 10 минут") { model.snoozeCurrent() }
                        }
                    }.padding(10).background(.yellow.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
                }
                TextField("Ваше поручение", text: $title)
                DatePicker("Когда", selection: $due, displayedComponents: [.date, .hourAndMinute])
                Button("Добавить поручение") {
                    model.addTask(title: title, due: due)
                    if model.error == nil { title = "" }
                }.disabled(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                ForEach(model.tasks.filter { !$0.completed }.sorted { $0.due < $1.due }.prefix(12)) { task in
                    HStack(alignment: .top) {
                        VStack(alignment: .leading) {
                            Text(task.title).font(.caption)
                            Text(task.due, format: .dateTime.day().month().hour().minute()).font(.caption2).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button("Готово") { model.completeTask(task.id) }.font(.caption2)
                    }
                }
                if let error = model.error { Text(error).foregroundStyle(.red).font(.caption) }
            }.padding(.top, 8)
        }.font(.callout)
    }
}
