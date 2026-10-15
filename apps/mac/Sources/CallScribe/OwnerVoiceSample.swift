import Foundation

/// Temporary, bounded PCM; no recording is written to disk during voice enrollment.
final class OwnerVoiceSample: @unchecked Sendable {
    private let lock = NSLock()
    private var data = Data()
    private var rate: Double?
    private var issue: String?
    func append(_ packet: Data, rate incoming: Double) {
        lock.lock(); defer { lock.unlock() }
        guard issue == nil else { return }
        guard incoming.isFinite, incoming.rounded() == incoming, (8000...96000).contains(incoming),
              packet.count % 4 == 0, rate == nil || rate == incoming else {
            issue = "Формат микрофона изменился. Запишите образец заново."; return
        }
        rate = incoming
        let remaining = max(0, Int(incoming) * 12 * 4 - data.count)
        data.append(packet.prefix(remaining))
    }
    func fail(_ message: String) { lock.lock(); issue = message; lock.unlock() }
    func snapshot() throws -> (Data, Double) {
        lock.lock(); defer { lock.unlock() }
        guard issue == nil, let rate, data.count >= Int(rate) * 4 * 4 else {
            throw NSError(domain: "LocalSpeech.OwnerVoice", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: issue ?? "Не хватило записи. Произнесите текст в течение 12 секунд."])
        }
        return (data, rate)
    }
}
