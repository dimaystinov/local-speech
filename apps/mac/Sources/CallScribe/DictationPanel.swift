import SwiftUI

struct DictationPanel: View {
    @ObservedObject var model: DictationModel
    var available: Bool
    var body: some View {
        DisclosureGroup("Диктовка в поле · ⌘⇧D") {
            VStack(alignment: .leading, spacing: 9) {
                Toggle("Переформулировать локально", isOn: $model.rewriteEnabled).disabled(model.active)
                Toggle("Активация: Роки / Роки два", isOn: $model.activationEnabled).disabled(model.active)
                Toggle("Принимать только мой голос", isOn: $model.ownerOnly).disabled(model.active || model.activationEnabled)
                Text("Для голосовой активации проверка владельца обязательна. Произнесите «Роки» вместе с командой: короткого слова может не хватить для узнавания. При сомнении текст не вставляется.").font(.caption2).foregroundStyle(.secondary)
                Toggle("Открыть черновик агенту · MCP", isOn: $model.shareWithAgent)
                Text(model.status).font(.caption)
                if !model.targetName.isEmpty { Text("Поле: \(model.targetName)").font(.caption).foregroundStyle(.secondary) }
                if model.active {
                    ProgressView(value: min(1, Double(model.level) * 8))
                    Button("Остановить диктовку") { Task { await model.stop() } }.disabled(model.state == "stopping")
                } else {
                    Button("Диктовать через 3 секунды") { model.toggle(delayed: true) }.disabled(!available)
                    Button("Проверить аудиофайл") { model.chooseTestFile() }.disabled(!available)
                }
                Text("Выберите поле в другом приложении. Готовые фразы вставляются по мере распознавания. Локальный редактор учитывает текст рядом с курсором. При ошибке или задержке сохраняется исходная фраза.").font(.caption2).foregroundStyle(.secondary)
                if !model.rewriteStatus.isEmpty { Text(model.rewriteStatus).font(.caption2).foregroundStyle(.secondary) }
                if let error = model.error { Text(error).font(.caption).foregroundStyle(.red).textSelection(.enabled) }
                Button("Настройки универсального доступа") { model.openAccessibilitySettings() }.font(.caption)
                if !model.draft.isEmpty || !model.partial.isEmpty {
                    if !model.revisedDraft.isEmpty && model.revisedDraft != model.draft { Text("После правки: " + model.revisedDraft).font(.caption).lineLimit(8).textSelection(.enabled) }
                    Text(model.draft + (model.partial.isEmpty ? "" : "\n… " + model.partial)).font(.caption).lineLimit(8).textSelection(.enabled)
                    HStack {
                        Button("Копировать текст") { model.copyDraft() }.disabled(model.draft.isEmpty)
                        Button("Исходник") { model.copyDraft(original: true) }.disabled(model.draft.isEmpty)
                        Button("Отменить через 3 с") { model.undo() }.disabled(model.active || !available)
                    }.font(.caption2)
                    Button("Отправить через 3 секунды") { model.submit() }.disabled(model.active || !available || !model.hasInsertedText)
                }
                Text("«Роки» включает диктовку, но не отправляет сообщение. Отправка — отдельной кнопкой, только в поддерживаемом поле. При включённом MCP черновик доступен подключённому агенту.").font(.caption2).foregroundStyle(.secondary)
            }.padding(.top, 8)
        }.font(.callout)
    }
}
