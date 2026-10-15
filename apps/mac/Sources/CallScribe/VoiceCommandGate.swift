import Foundation

/// Joins asynchronous ASR and diarization by segment. Unverified text never reaches actions.
struct VoiceCommandGate {
    enum Rejection: String {
        case timeout, queueFull, overlap, otherSpeaker, unverified, invalidCoverage, tooShort
        var message: String {
            switch self {
            case .timeout: return "Проверка голоса не успела завершиться. Повторите команду."
            case .queueFull: return "Очередь проверки голоса переполнена. Повторите команду после паузы."
            case .overlap: return "Голоса перекрываются. Повторите команду, когда собеседник закончит."
            case .otherSpeaker: return "Реплика другого человека пропущена."
            case .unverified: return "Не удалось уверенно узнать ваш голос. Повторите команду ближе к микрофону."
            case .invalidCoverage: return "Не удалось проверить всю реплику. Повторите команду."
            case .tooShort: return "Слишком короткая реплика для узнавания голоса. Скажите «Роки» вместе с командой."
            }
        }
    }
    private(set) var lastRejection: Rejection?
    private(set) var rejectionCounts: [Rejection: Int] = [:]
    private mutating func reject(_ reason: Rejection) {
        rejected += 1; lastRejection = reason; rejectionCounts[reason, default: 0] += 1
    }
    private struct Entry {
        var text: [String: Any]?
        var voice: [String: Any]?
        let created: TimeInterval
    }
    let ownerID: String
    private var entries: [String: Entry] = [:]
    private var arrival: [String] = []
    private var order: [String] = []
    private var finished = Set<String>()
    private var history: [String] = []
    private(set) var rejected = 0
    var pendingCount: Int { entries.count }
    private var closed = false
    init(ownerID: String) { self.ownerID = ownerID }

    private func key(_ event: [String: Any]) -> String? {
        guard let session = event["sessionId"] as? String, !session.isEmpty, session.count <= 100,
              let segment = event["segmentId"] as? Int, segment >= 0 else { return nil }
        return "\(session):\(segment)"
    }
    mutating func submit(_ event: [String: Any], voice: Bool = false, now: TimeInterval) -> [[String: Any]] {
        guard !closed, now.isFinite, let id = key(event), !finished.contains(id) else { return [] }
        if voice {
            guard event["type"] as? String == "speaker", event["channel"] as? String == "microphone",
                  event["kind"] as? String != "pending" else { return [] }
        } else {
            guard event["type"] as? String == "final", let text = event["rawText"] as? String,
                  !text.isEmpty, text.count <= 20000 else { return [] }
        }
        if entries[id] == nil {
            if arrival.count >= 8, let oldest = arrival.first { remove(oldest); reject(.queueFull) }
            entries[id] = Entry(created: now); arrival.append(id)
        }
        if voice {
            if entries[id]?.voice == nil { entries[id]?.voice = event }
        } else if entries[id]?.text == nil {
            entries[id]?.text = event; order.append(id)
        }
        return drain(now: now)
    }
    mutating func drain(now: TimeInterval) -> [[String: Any]] {
        guard !closed else { return [] }
        var accepted: [[String: Any]] = []
        for id in arrival where now - (entries[id]?.created ?? now) >= 8 {
            remove(id); reject(.timeout)
        }
        while let id = order.first, let entry = entries[id], let text = entry.text, let voice = entry.voice {
            if let reason = rejection(text, voice) { reject(reason) } else { accepted.append(text) }
            remove(id)
        }
        return accepted
    }
    private func rejection(_ text: [String: Any], _ voice: [String: Any]) -> Rejection? {
        if voice["kind"] as? String == "overlap" { return .overlap }
        guard voice["kind"] as? String == "known" else { return .unverified }
        guard voice["speakerId"] as? String == ownerID else { return .otherSpeaker }
        guard
              let start = text["startMs"] as? Double, let end = text["endMs"] as? Double,
              start.isFinite, end.isFinite, start >= 0, end > start, end-start <= 15000,
              let rows = voice["intervals"] as? [[String: Any]], !rows.isEmpty, rows.count <= 2000 else { return .invalidCoverage }
        var cursor = 0.0, ownerSpeech = 0.0
        for row in rows {
            guard let a = row["startMs"] as? Double, let b = row["endMs"] as? Double,
                  a.isFinite, b.isFinite, abs(a-cursor) <= 1, b > a, b <= end-start+1 else { return .invalidCoverage }
            if row["kind"] as? String != "silence" {
                if row["kind"] as? String == "overlap" { return .overlap }
                guard row["kind"] as? String == "known" else { return .unverified }
                guard row["speakerId"] as? String == ownerID else { return .otherSpeaker }
                ownerSpeech += b-a
            }
            cursor = b
        }
        guard abs(cursor-(end-start)) <= 1 else { return .invalidCoverage }
        return ownerSpeech >= 2000 ? nil : .tooShort
    }
    private mutating func remove(_ id: String) {
        entries.removeValue(forKey: id); arrival.removeAll { $0 == id }; order.removeAll { $0 == id }
        finished.insert(id); history.append(id)
        if history.count > 2048 { finished.remove(history.removeFirst()) }
    }
    mutating func close() { closed = true; entries.removeAll(); arrival.removeAll(); order.removeAll() }
}
