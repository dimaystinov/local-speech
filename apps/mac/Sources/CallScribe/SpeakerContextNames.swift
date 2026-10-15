import Foundation

enum SpeakerContextNames {
    private static let introduction = try! NSRegularExpression(
        pattern: #"^\s*(?:(?:Здравствуйте|Привет|Hello|Hi)[,.!]?\s+)?(?:Меня зовут|Мо[её] имя|My name is)\s+([\p{L}][\p{L}'’-]{1,39})(?=\s|[,.!?:;]|$)"#,
        options: .caseInsensitive)
    static func selfIntroduction(_ text: String) -> String? {
        let prefix = String(text.prefix(300))
        guard let match = introduction.firstMatch(in: prefix, range: NSRange(prefix.startIndex..., in: prefix)),
              let range = Range(match.range(at: 1), in: prefix) else { return nil }
        let name = String(prefix[range])
        guard let first = name.first, first.isUppercase else { return nil }
        return name
    }
}
